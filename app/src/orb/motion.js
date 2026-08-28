import { Quaternion, Vector3 } from 'three/webgpu';
import { sensorQuaternion, angularVelocity, linearAccel } from './frame.js';

// Smooth motion from a bursty link.
//
// The device samples every 10 ms on its own clock, but frames reach the browser
// in clumps -- batched by the bridge, then whenever the socket feels like it.
// Reading "the newest frame" each render therefore gives a signal that steps
// several times a second rather than a hundred, which looks like stutter no
// matter how high the frame rate is.
//
// So: buffer frames against their *device* timestamps, run a render clock a
// little way behind real time, and interpolate. Every rendered frame lands
// between two real samples. The cost is a fixed delay, which is what `delayMs`
// buys -- enough to cover arrival jitter, and no more.
//
// It also re-levels itself. People put the orb down in whatever orientation
// suits them, and the sensor's own zero has nothing to do with how it sits in
// a hand, so the pose it is left in becomes the new neutral. Attitude is
// reported *relative* to that, which is what makes it right when it is next
// picked up.
//
// Re-levelling must be invisible, and the only way to guarantee that is for
// nothing on screen to be a function of the attitude directly. So no object
// rotates. Instead everything is looked up through
//
//     L = attitude^-1 * field
//
// and `field` is updated at each re-level so that L comes out identical. If
// every visible quantity is a function of L alone, nothing can move -- which
// is not true if the object itself is rotated as well. A point cloud makes
// that painfully obvious: rotating it snaps every point to a new position on
// screen no matter how carefully the noise is compensated.

const CAPACITY = 180;          // ~1.8 s at 100 Hz

// `relevel: false` opts out of all of that, and is the better answer for a
// sphere. Re-levelling was justified by the sensor's zero being arbitrary --
// but the pose a *ball* is set down in is equally arbitrary, and it changes
// every time. So it trades a fixed arbitrary frame for a moving one, and
// throws away the one honest reference there is: gravity. Attitude changes by
// `home^-1 R home`, so a room-frame gesture is conjugated by whatever pose was
// last levelled in -- set the orb down turned around and the horizontal axes
// invert. Left alone, the BNO085's gravity-referenced frame keeps up as up and
// the mapping identical from every pose. What it cannot know is which way the
// participant is sitting; that is `tareHeading()`, and it is theirs to declare.
export function createMotion(orb, { delayMs = 70, relevel = true } = {}) {
  const times = new Float64Array(CAPACITY);
  const quats = Array.from({ length: CAPACITY }, () => new Quaternion());
  const omegas = Array.from({ length: CAPACITY }, () => new Vector3());
  const accels = Array.from({ length: CAPACITY }, () => new Vector3());
  let head = 0;
  let count = 0;

  // Neutral pose, and the compensation that keeps features still across a
  // change of neutral.
  const home = new Quaternion();
  const homeInv = new Quaternion();
  const field = new Quaternion();
  const scratch = new Quaternion();
  const here = new Quaternion();
  let levelled = false;
  let wasHeld = false;
  let epoch = 0;

  // Device-to-local clock offset. The smallest observed difference is the
  // sample that suffered least transport delay, so it is the best estimate;
  // it is allowed to creep up slowly so genuine clock drift is followed.
  let offset = null;

  const at = (k) => (head - count + k + CAPACITY) % CAPACITY;

  orb.onFrame((f) => {
    // A device reboot restarts its clock; carrying old samples across would
    // put the render clock centuries ahead of the buffer.
    if (count && f.t_ms < times[at(count - 1)] - 500) {
      count = 0;
      offset = null;
    }

    const i = head;
    times[i] = f.t_ms;
    sensorQuaternion(f, quats[i]);
    angularVelocity(f, omegas[i]);
    linearAccel(f, accels[i]);

    head = (head + 1) % CAPACITY;
    if (count < CAPACITY) count++;

    const isHeld = f.held > 0.5;
    if (relevel) {
      // Re-level the moment it is set down: the first frame of stillness, not
      // the last of handling.
      if (!levelled || (wasHeld && !isHeld)) doRelevel(quats[i]);
    } else if (!levelled) {
      // Zero the heading once, so the frame is at least repeatable -- the game
      // rotation vector's yaw origin is whatever the sensor woke up at. Once,
      // at startup, and never on set-down: doing it there is the bug.
      takeHeading(quats[i]);
      levelled = true;
    }
    wasHeld = isHeld;

    const observed = performance.now() - f.t_ms;
    if (offset === null || observed < offset) offset = observed;
    else offset += (observed - offset) * 0.001;
  });

  // attitude = home^-1 * raw.
  //
  // The side matters and is not a matter of taste. Post-multiplying instead
  // (raw * home^-1) expresses the attitude in the world frame rather than the
  // neutral one, which differs by a conjugation -- a turn about the body's X
  // axis then renders as a smear across all three, looking as though the axes
  // are wired together. The debug page has always done it this way.
  // Keep only the rotation about three's up axis (swing-twist). Dropping the
  // swing is what leaves tilt alone, so gravity still decides which way is up.
  function takeHeading(raw) {
    const len = Math.hypot(raw.y, raw.w);
    if (len < 1e-6) return false;          // straight over: no heading to read
    home.set(0, raw.y / len, 0, raw.w / len);
    homeInv.copy(home).invert();
    return true;
  }

  // The reference is one angle about the vertical, so it can also just be
  // *stated* rather than read off a pose. That is the only honest way to aim a
  // featureless sphere: there is no front to point at the screen, so a heading
  // taken from how the ball is being held is a guess, and a different guess
  // every time. Dialled by hand against what the ball is visibly doing, it
  // converges instead -- a search rather than a draw.
  //
  // Marks itself levelled, so a heading restored before the first frame is not
  // overwritten by the connect-time capture below.
  function setHeading(rad) {
    home.set(0, Math.sin(rad / 2), 0, Math.cos(rad / 2));
    homeInv.copy(home).invert();
    levelled = true;
    epoch++;
  }

  const headingOf = () => 2 * Math.atan2(home.y, home.w);

  function doRelevel(raw) {
    if (levelled) {
      // What the body is showing right now becomes what the field has to undo,
      // so the image is unchanged across the switch.
      // L = A^-1 * F must not change, so F picks up the old attitude:
      //   F <- A_old^-1 * F
      scratch.copy(raw).premultiply(homeInv);        // attitude, before
      field.premultiply(scratch.invert());
    }
    home.copy(raw);
    homeInv.copy(home).invert();
    epoch++;
    levelled = true;
  }


  const state = {
    quaternion: new Quaternion(),
    omega: new Vector3(),
    accel: new Vector3(),
    /** Combine as `attitude^-1 * field` to get the rotation every field lookup
     *  should go through. Nothing should be rotated by the attitude directly. */
    field,
    /** Bumped on every re-levelling. Anything easing towards the attitude must
     *  snap on the frame this changes: the field compensation is instantaneous,
     *  so a follower that eases instead would drag the body across a picture
     *  that has already moved -- which is the visible stutter this avoids. */
    epoch: 0,
    valid: false,
    /** Seconds of real motion currently buffered ahead of the render clock. */
    lead: 0,
  };

  return {
    state,
    get delayMs() { return delayMs; },
    set delayMs(v) { delayMs = v; },

    /**
     * Declare the heading the orb is at right now to be the reference. Yaw
     * only -- tilt is left to gravity, which is already right.
     *
     * This is the one thing no IMU can work out for itself: where the
     * participant is sitting is a fact about the room, not about the device.
     * Even a working magnetometer only gives magnetic north, and something
     * still has to say where the screen is relative to it. So it is declared,
     * at a moment that carries intent -- never inferred from how the ball
     * happened to come to rest.
     *
     * Levels against the pose at the *render clock*, not the newest sample:
     * those are `delayMs` apart, and what has to become the reference is the
     * pose being held and looked at. `state.quaternion` is `home^-1 * raw`, so
     * `home * state.quaternion` recovers that raw pose.
     *
     * Bumps `epoch`; the picture does turn about the vertical when the
     * reference moves, and that is the point of it.
     *
     * @returns false if there is nothing to read a heading from yet.
     */
    tareHeading() {
      if (!state.valid) return false;
      if (!takeHeading(here.copy(home).multiply(state.quaternion))) return false;
      epoch++;
      return true;
    },

    /** The heading reference, radians about the vertical. Reading it gives
     *  something worth storing; setting it restores one, which is what makes a
     *  reload stop throwing the reference away. */
    get heading() { return headingOf(); },
    set heading(rad) { setHeading(rad); },

    /** Turn the reference by `rad` and report where it landed. The whole
     *  picture turns about the vertical with it -- which is the point: it is
     *  what lets the aim be seen while it is being corrected. */
    nudgeHeading(rad) {
      setHeading(headingOf() + rad);
      return headingOf();
    },

    sample() {
      if (count === 0 || offset === null) {
        state.valid = false;
        return state;
      }

      const target = performance.now() - offset - delayMs;
      const newest = times[at(count - 1)];
      const oldest = times[at(0)];
      state.lead = (newest - target) / 1000;

      // Outside the buffer, hold the nearest sample rather than extrapolating:
      // a wrong guess about where the orb went reads far worse than a pause.
      if (count === 1 || target >= newest) {
        const i = at(count - 1);
        state.quaternion.copy(quats[i]).premultiply(homeInv);
        state.omega.copy(omegas[i]);
        state.accel.copy(accels[i]);
        state.epoch = epoch;
        state.valid = true;
        return state;
      }
      if (target <= oldest) {
        const i = at(0);
        state.quaternion.copy(quats[i]).premultiply(homeInv);
        state.omega.copy(omegas[i]);
        state.accel.copy(accels[i]);
        state.epoch = epoch;
        state.valid = true;
        return state;
      }

      // Newest-first: the render clock is almost always near the end.
      let k = count - 1;
      while (k > 0 && times[at(k - 1)] > target) k--;

      const a = at(k - 1);
      const b = at(k);
      const span = times[b] - times[a];
      const t = span > 0 ? (target - times[a]) / span : 0;

      state.quaternion.copy(quats[a]).slerp(quats[b], t).premultiply(homeInv);
      state.omega.copy(omegas[a]).lerp(omegas[b], t);
      state.accel.copy(accels[a]).lerp(accels[b], t);
      state.epoch = epoch;
      state.valid = true;
      return state;
    },
  };
}
