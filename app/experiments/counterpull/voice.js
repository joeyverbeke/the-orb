// The third instruction, and the only one made of words.
//
// The screen shows you a hole and the motor pulls you somewhere else; both of
// those are gradients, and a gradient can be ignored by holding still. Speech
// cannot. It arrives whether or not you are moving, it names a direction
// outright, and it comments on what you just did -- so it competes for the
// same wrist from a third side.
//
// This file is deliberately pure: no three.js, no DOM, no `orb`. It takes
// numbers and returns which clip to play. The sign convention below is the
// part most likely to be wrong, and it should be checkable without a device
// in your hand.
//
// --- which way to turn -----------------------------------------------------
//
// The target is a point on the orb's surface that has to be brought round to
// face the camera. With the camera fixed on +Z and no controls, world axes ARE
// screen axes (see stage.js), so the required rotation axis is
//
//     n = s x viewDir = (s.y, -s.x, 0)
//
// -- two floats, and never a roll component, because rolling about the view
// axis cannot move anything toward you.
//
// The rule that follows is a single symmetric one: THE LIMB NEAREST THE TARGET
// COMES TOWARD YOU. Target on the right, the right limb swings forward; target
// on top, the top swings forward. Verified by w x r for all four cases.
//
// The *English* is not symmetric, and this is the trap. The vertical has a
// natural verb framed on the top ("tip it toward you"), so it says the limb.
// The horizontal has no such verb, so it borrows front-face framing -- and the
// front face travels the opposite way to the limb. Hence: target on the right
// -> "Rotate it left." Target on top -> "Tip it toward you." Opposite-looking,
// same rule.
//
// So the labels are a literal four-entry table, not a sign expression. Anyone
// deriving these from arithmetic writes one of them backwards.
//
// Set B ("bring the right side round toward you") says the limb on both axes
// and is unambiguous. Set A is shorter and more urgent, and is ambiguous to a
// person holding a ball. Both are recorded; `set` picks, and the flip toggles
// exist because this is settled by a participant, not by argument.

const DEG = 180 / Math.PI;

// Beyond this the sign of yaw is noise -- at the antipode both directions
// reach the target in the same 180 degrees, so there is no wrong answer and
// latching costs nothing. Below it the geometry is well conditioned.
const LATCH_ABOVE_DEG = 150;

const OVER_MARGIN_DEG = 14;   // how near counts as "you had it"
const OVER_RISE_DEG   = 10;   // and how far back out counts as losing it
// How fast "the best you have managed" is forgotten, in degrees per second. A
// true running minimum ratchets: once it has been anywhere near the target
// once, it stays near forever, and from then on every ordinary turn away reads
// as an overshoot. "You had it" has to mean the recent past or it means
// nothing.
const OVER_FORGET_DPS = 12;
const WRONG_SECS      = 1.6;  // angle climbing this long, out in the open
const FAST_SECS       = 0.7;
const STALL_SECS      = 3.0;
const IDLE_SECS       = 9.0;

// How many recent lines to refuse to repeat. Small: with 4-6 variants per
// bank, a longer memory just forces the rotation to be perfectly cyclic, which
// is its own kind of obvious.
const NO_REPEAT = 3;

/**
 * @param clips  the parsed clips.json
 * @param io     { say(id) -> bool, hush() }
 */
export function createVoice(clips, io) {
  // bank -> key -> [clip]
  const byBank = new Map();
  for (const [slug, c] of Object.entries(clips.clips ?? {})) {
    if (!byBank.has(c.bank)) byBank.set(c.bank, new Map());
    const keys = byBank.get(c.bank);
    if (!keys.has(c.key)) keys.set(c.key, []);
    keys.get(c.key).push({ ...c, slug });
  }

  // Why nothing was said on the last frame. Six gates can stop a line, they are
  // all invisible from outside, and "the voice is not working" is not a
  // debuggable report -- so the gate names itself and the panel shows it.
  let gate = 'starting';

  // Load the page with ?debug to get a running commentary on the commentary:
  // every change of gate, logged once. Off by default -- in a working session
  // the gate cycles several times per line and the console becomes useless for
  // anything else.
  const trace = typeof location !== 'undefined' && location.search.includes('debug');
  const setGate = (g) => {
    if (trace && g !== gate) console.log('[voice]', g);
    gate = g;
  };

  const recent = [];
  let busyUntil = 0;        // wall clock; see the note on dt below
  let quietUntil = 0;
  let lastSpokeMs = 0;

  let latchedLimb = null;
  let lastLimb = null;
  let sinceCommentary = 0;

  // Pending one-shots, set by the frame scan and consumed by the next
  // utterance. A bank name, or null.
  let pending = null;

  let bestAngle = 180;
  let prevAngle = 180;
  let risingFor = 0;
  let fastFor = 0;
  let stallFor = 0;
  let wasFound = false;
  let started = false;

  function pick(bank, key) {
    const keys = byBank.get(bank);
    if (!keys) return null;
    const pool = keys.get(key) ?? keys.get('any');
    if (!pool?.length) return null;
    const fresh = pool.filter((c) => !recent.includes(c.id));
    const from = fresh.length ? fresh : pool;
    return from[(Math.random() * from.length) | 0];
  }

  function speak(clip, nowMs) {
    if (!clip) return false;
    if (!io.say(clip.id)) return false;
    recent.push(clip.id);
    while (recent.length > NO_REPEAT) recent.shift();
    // Wall clock, not accumulated dt: stage.js clamps dt to 0.1 s per frame, so
    // a stuttering or backgrounded tab under-counts elapsed time and this would
    // drift away from the audio it is supposed to be tracking.
    busyUntil = nowMs + clip.ms + 90;
    lastSpokeMs = nowMs;
    return true;
  }

  // The four-entry table. `yaw` and `pitch` are the work remaining on each
  // axis, so whichever is larger is the turn worth naming.
  function limbFor(yaw, pitch, flipLR, flipTA) {
    let limb;
    if (Math.abs(yaw) >= Math.abs(pitch)) {
      limb = yaw > 0 ? 'right_limb' : 'left_limb';
      if (flipLR) limb = limb === 'right_limb' ? 'left_limb' : 'right_limb';
    } else {
      limb = pitch > 0 ? 'top_limb' : 'bottom_limb';
      if (flipTA) limb = limb === 'top_limb' ? 'bottom_limb' : 'top_limb';
    }
    return limb;
  }

  return {
    /** Every frame, whether or not the voice is allowed to speak. */
    update(s) {
      const {
        nowMs, dt, angle, yaw, pitch, liveTurn, found, held, active, opts,
      } = s;

      if (!started) { prevAngle = angle; bestAngle = angle; started = true; }

      // Set down is not a pause, it is the end of a go. Nothing is said to an
      // empty table, and nothing that happened while it sat there is left
      // waiting to be said when it is picked up again -- otherwise the first
      // thing you hear on lifting it is a stale "you've stopped" about the
      // minute it spent on the desk.
      if (!held) {
        setGate('set down');
        prevAngle = angle;
        bestAngle = angle;
        risingFor = fastFor = stallFor = 0;
        pending = null;
        wasFound = found;
        return null;
      }

      // --- watch, always. The events are edges, and an edge missed while the
      // voice happened to be mid-sentence is an edge lost for good.
      bestAngle = Math.min(180, bestAngle + OVER_FORGET_DPS * dt);
      if (angle < bestAngle) bestAngle = angle;

      if (found && !wasFound) pending = 'arrive';
      else if (!found && wasFound) pending = pending ?? 'lost';
      wasFound = found;

      if (!found && bestAngle <= opts.foundDeg + OVER_MARGIN_DEG
          && angle > bestAngle + OVER_RISE_DEG) {
        // They had it and let it go. This is the near-scale version of
        // "wrong way", and it resets the far-scale one so the two cannot
        // both fire off a single move away.
        if (pending !== 'arrive') pending = 'over';
        bestAngle = angle;
        risingFor = 0;
      }

      risingFor = angle > prevAngle + 0.15 ? risingFor + dt : 0;
      if (risingFor > WRONG_SECS && !found) {
        if (!pending) pending = 'wrong';
        risingFor = 0;
      }

      fastFor = liveTurn > opts.fastDps ? fastFor + dt : 0;
      if (fastFor > FAST_SECS) {
        if (!pending) pending = 'fast';
        fastFor = 0;
      }

      stallFor = (liveTurn < opts.stillDps && !found) ? stallFor + dt : 0;
      if (stallFor > STALL_SECS) {
        if (!pending) pending = 'stall';
        stallFor = 0;
      }

      prevAngle = angle;

      // --- speak?
      if (!active) { setGate('not idle / no orb'); return null; }

      // Arrival is the one line allowed to talk over another: "hold it there"
      // arriving two seconds after you arrived is worse than an interruption.
      const interrupt = pending === 'arrive';
      if (!interrupt) {
        // Only the clip's own known length gates this. Asking the device
        // whether it is still busy sounds better and is a trap: the firmware
        // reports voice_clip on *change*, so one dropped '-1' -- a mangled
        // serial line, a reconnect, a config broadcast that does not carry it
        // -- leaves the answer stuck at "busy" with nothing to ever clear it,
        // and the voice never speaks again. busyUntil expires on its own
        // clock and cannot wedge.
        if (nowMs < busyUntil) { setGate('clip still playing'); return null; }
        if (nowMs < quietUntil) { setGate('quiet after a win'); return null; }
        if (nowMs - lastSpokeMs < opts.gapMs) { setGate('gap between lines'); return null; }
      }

      let clip = null;

      if (pending) {
        clip = pick(pending, 'any');
        pending = null;
      } else if (angle < opts.foundDeg) {
        // Holding it. Say nothing -- the participant is being asked to keep
        // still, and a voice is the one thing here that can spoil that.
        setGate('holding it');
        return null;
      } else {
        // The limb is re-derived only when there is something to say, which is
        // its own rate limit; the latch handles the antipodal cone where the
        // sign of yaw carries no information.
        let limb;
        if (angle >= LATCH_ABOVE_DEG && latchedLimb) {
          limb = latchedLimb;
        } else {
          limb = limbFor(yaw, pitch, opts.flipLR, opts.flipTA);
          latchedLimb = angle >= LATCH_ABOVE_DEG ? limb : null;
        }

        sinceCommentary += 1;
        const every = Math.max(2, Math.round(1 / Math.max(opts.commentary, 0.01)));
        if (sinceCommentary >= every) {
          sinceCommentary = 0;
          const band = angle > 110 ? 'far' : angle > 45 ? 'mid' : 'near';
          clip = pick('dist', band);
        }
        if (!clip) {
          // Same direction as last time gets the short form. Saying the whole
          // sentence again is how a voice becomes furniture.
          clip = (limb === lastLimb && Math.random() < 0.65)
            ? pick('cont', limb)
            : pick(opts.set === 'B' ? 'dir_b' : 'dir_a', limb);
        }
        lastLimb = limb;
      }

      if (!clip) { setGate('no clip for that bank'); return null; }
      // say() refuses on a hidden tab, exactly as the haptics do, so several
      // open experiments cannot talk over each other. Worth naming precisely:
      // it is the one gate whose cause is outside this page entirely, and a
      // backgrounded tab looks identical to a broken speaker from the desk.
      if (!speak(clip, nowMs)) {
        setGate((typeof document !== 'undefined' && document.hidden)
          ? 'TAB IS IN THE BACKGROUND' : 'link busy');
        return null;
      }
      setGate('speaking');
      return clip;
    },

    /** Stop mid-line, and forget that anything was ever playing. */
    silence() {
      io.hush();
      busyUntil = 0;
      pending = null;
    },

    /** The transition fired on the voice's own errand. */
    win(nowMs) {
      pending = null;
      speak(pick('win', 'any'), nowMs);
      // Nothing over the collapse and the bloom; that stretch belongs to the
      // picture and the motor.
      quietUntil = nowMs + 2600;
    },

    /** A new errand: everything above refers to a point that has moved. */
    reset(nowMs = 0) {
      pending = null;
      latchedLimb = null;
      lastLimb = null;
      sinceCommentary = 0;
      bestAngle = 180;
      prevAngle = 180;
      risingFor = fastFor = stallFor = 0;
      wasFound = false;
      started = false;
      quietUntil = Math.max(quietUntil, nowMs + 400);
    },

    /** For the tuning readout. */
    debug() {
      return { latchedLimb, lastLimb, pending, bestAngle, gate };
    },

    IDLE_SECS,
  };
}

/** s (a unit Vector3 in screen space) -> the work remaining on each axis. */
export function decompose(s) {
  return {
    yaw: Math.atan2(s.x, s.z) * DEG,               // horizontal
    pitch: Math.atan2(s.y, Math.hypot(s.x, s.z)) * DEG,  // vertical
  };
}
