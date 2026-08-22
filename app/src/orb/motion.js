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

const CAPACITY = 180;          // ~1.8 s at 100 Hz

export function createMotion(orb, { delayMs = 70 } = {}) {
  const times = new Float64Array(CAPACITY);
  const quats = Array.from({ length: CAPACITY }, () => new Quaternion());
  const omegas = Array.from({ length: CAPACITY }, () => new Vector3());
  const accels = Array.from({ length: CAPACITY }, () => new Vector3());
  let head = 0;
  let count = 0;

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

    const observed = performance.now() - f.t_ms;
    if (offset === null || observed < offset) offset = observed;
    else offset += (observed - offset) * 0.001;
  });

  const state = {
    quaternion: new Quaternion(),
    omega: new Vector3(),
    accel: new Vector3(),
    valid: false,
    /** Seconds of real motion currently buffered ahead of the render clock. */
    lead: 0,
  };

  return {
    state,
    get delayMs() { return delayMs; },
    set delayMs(v) { delayMs = v; },

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
        state.quaternion.copy(quats[i]);
        state.omega.copy(omegas[i]);
        state.accel.copy(accels[i]);
        state.valid = true;
        return state;
      }
      if (target <= oldest) {
        const i = at(0);
        state.quaternion.copy(quats[i]);
        state.omega.copy(omegas[i]);
        state.accel.copy(accels[i]);
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

      state.quaternion.copy(quats[a]).slerp(quats[b], t);
      state.omega.copy(omegas[a]).lerp(omegas[b], t);
      state.accel.copy(accels[a]).lerp(accels[b], t);
      state.valid = true;
      return state;
    },
  };
}
