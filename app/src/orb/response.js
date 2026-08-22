// How turning becomes a 0..1 "how much is happening" figure, and what the hand
// feels as a result.
//
// Shared by every experiment and tuned in one place (the Motion tool), because
// this is a property of the orb and the hand holding it, not of any one visual.
//
// Turning only. Linear acceleration is still carried by src/orb/motion.js and
// an experiment can read it directly, but nothing here reacts to being carried.

export const MOTION_STORE = 'orb-motion';           // createPanel storageKey
const KEY = `panel:${MOTION_STORE}`;

export const MOTION_DEFAULTS = {
  'turn-deadzone': 6,      // deg/s below which a turn is treated as stillness
  'turn-full': 150,        // deg/s that counts as fully moving
  'turn-curve': 1.8,       // >1 = small turns matter less, large ones more
  'attack-s': 0.08,        // how fast it rises
  'release-s': 1.1,        // how slowly it falls back

  'haptic-link': true,     // drive the motor from the same curve
  'haptic-strength': 0.9,  // what a full turn feels like
  'haptic-idle': 0,        // what it sits at when still
};

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}

/**
 * @param live optional map of param name -> object with `.value`. The tuning
 *   tool passes its own panel controls so the curve reacts as it drags; an
 *   experiment passes nothing and gets the stored values. Same maths either
 *   way, so what is tuned is exactly what ships.
 */
export function createResponse(live = null) {
  let stored = { ...MOTION_DEFAULTS, ...load() };

  // Another tab tuning the tool updates this one. Same-tab writes do not fire
  // this, which is why the tool passes `live`.
  addEventListener('storage', (e) => {
    if (e.key === KEY) stored = { ...MOTION_DEFAULTS, ...load() };
  });

  const get = (k) => (live && live[k] ? live[k].value : stored[k]);

  let level = 0;

  return {
    /** Shaped 0..1 for a rotation rate in deg/s, before smoothing. */
    shape(dps) {
      const dead = get('turn-deadzone');
      const span = Math.max(get('turn-full') - dead, 1e-6);
      const x = Math.min(Math.max((dps - dead) / span, 0), 1);
      return Math.pow(x, get('turn-curve'));
    },

    get level() { return level; },

    /** Call once per frame with the current turn rate in deg/s. */
    update(dps, dt) {
      const raw = this.shape(dps);
      const tau = Math.max(raw > level ? get('attack-s') : get('release-s'), 0.01);
      level += (raw - level) * (1 - Math.exp(-dt / tau));
      return level;
    },

    /** What the motor should be at for a given intensity, or null if the
     *  experiment should decide for itself. */
    hapticFor(intensity) {
      if (!get('haptic-link')) return null;
      const idle = get('haptic-idle');
      const strength = get('haptic-strength');
      return Math.min(1, Math.max(0, idle + (strength - idle) * intensity));
    },

    /** The motor level implied by the current turning, or null when unlinked. */
    get haptic() { return this.hapticFor(level); },
  };
}
