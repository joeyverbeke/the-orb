#include "modes.h"
#include "config.h"
#include "mapping.h"

#include <math.h>

static Smoother s_strength, s_pulse, s_grain;

// Q_WIND accumulators. Per-axis ones accumulate independently, which is what
// makes three separate parameters controllable at once -- turning about X adds
// to X alone. (Q_DIAL's axes are coupled through rotation composition, so it
// cannot offer that.)
static float wind_axis[3] = {0, 0, 0};
static float wind_mag     = 0.0f;

// Q_DIAL reference orientation.
static float ref_qr = 1.0f, ref_qi = 0.0f, ref_qj = 0.0f, ref_qk = 0.0f;
static bool  have_ref = false;

void modes_reset() {
  s_strength.reset();
  s_pulse.reset(1.0f);
  s_grain.reset();
  wind_axis[0] = wind_axis[1] = wind_axis[2] = 0.0f;
  wind_mag = 0.0f;
  have_ref = false;              // re-captured on the next frame
}

const char *quantity_name(uint8_t q) {
  switch (q) {
    case Q_SPEED: return "speed";
    case Q_WIND:  return "wind";
    case Q_DIAL:  return "dial";
    default:      return "?";
  }
}

const char *source_name(uint8_t s) {
  switch (s) {
    case SRC_AXIS:  return "1-axis";
    case SRC_TRIAX: return "3-axis";
    case SRC_ANY:   return "any-direction";
    default:        return "?";
  }
}

// Each quantity carries its own units, so each has its own full-scale.
static float normalize(float v) {
  switch (cfg.quantity) {
    case Q_WIND: {
      float full = (cfg.wind_full_deg > 1.0f) ? cfg.wind_full_deg : 1.0f;
      return curve_norm(v / full);
    }
    case Q_DIAL: {
      float full = (cfg.dial_full_deg > 1.0f) ? cfg.dial_full_deg : 1.0f;
      return curve_norm(v / full);
    }
    case Q_SPEED:
    default:
      return curve_dps(v);
  }
}

// Fills per-axis values and a magnitude, both in the quantity's own units.
static void measure(const ImuFrame &f, float axis_out[3], float &mag_out) {
  float wx = fabsf(f.gx) * RAD2DEG;
  float wy = fabsf(f.gy) * RAD2DEG;
  float wz = fabsf(f.gz) * RAD2DEG;
  float wm = sqrtf(f.gx*f.gx + f.gy*f.gy + f.gz*f.gz) * RAD2DEG;

  switch (cfg.quantity) {
    case Q_SPEED:
      axis_out[0] = wx; axis_out[1] = wy; axis_out[2] = wz;
      mag_out = wm;
      break;

    case Q_WIND: {
      float dt_s  = (f.dt_ms > 0.0f) ? f.dt_ms / 1000.0f : 0.0f;
      float decay = (cfg.wind_decay_ms > 0.0f && f.dt_ms > 0.0f)
                      ? expf(-f.dt_ms / cfg.wind_decay_ms) : 1.0f;
      float full  = (cfg.wind_full_deg > 1.0f) ? cfg.wind_full_deg : 1.0f;

      const float w[3] = {wx, wy, wz};
      for (int i = 0; i < 3; i++) {
        wind_axis[i] = wind_axis[i] * decay + w[i] * dt_s;
        if (wind_axis[i] > full) wind_axis[i] = full;   // don't bank unusable charge
        axis_out[i] = wind_axis[i];
      }
      wind_mag = wind_mag * decay + wm * dt_s;
      if (wind_mag > full) wind_mag = full;
      mag_out = wind_mag;
      break;
    }

    case Q_DIAL: {
      if (!have_ref) {
        ref_qr = f.qr; ref_qi = f.qi; ref_qj = f.qj; ref_qk = f.qk;
        have_ref = true;
      }
      // Rotation from the reference to now: conj(ref) x q.
      float aw = ref_qr, ax = -ref_qi, ay = -ref_qj, az = -ref_qk;
      float rw = aw*f.qr - ax*f.qi - ay*f.qj - az*f.qk;
      float rx = aw*f.qi + ax*f.qr + ay*f.qk - az*f.qj;
      float ry = aw*f.qj - ax*f.qk + ay*f.qr + az*f.qi;
      float rz = aw*f.qk + ax*f.qj - ay*f.qi + az*f.qr;

      // q and -q are the same orientation; pick the short way round or the
      // angle jumps to 360 at the wrap.
      if (rw < 0.0f) { rw = -rw; rx = -rx; ry = -ry; rz = -rz; }
      if (rw > 1.0f) rw = 1.0f;

      mag_out = 2.0f * acosf(rw) * RAD2DEG;

      // The vector part is axis*sin(angle/2), so each component read alone
      // gives that axis's share. Exact for a rotation about one axis, and a
      // well-behaved monotonic decomposition for anything mixed -- which is
      // all the per-axis mapping needs.
      const float v[3] = {rx, ry, rz};
      for (int i = 0; i < 3; i++) {
        float c = fabsf(v[i]);
        if (c > 1.0f) c = 1.0f;
        axis_out[i] = 2.0f * asinf(c) * RAD2DEG;
      }
      break;
    }
  }
}

Drive modes_update(const ImuFrame &f) {
  Drive d;
  d.strength = 0.0f;
  d.pulse    = cfg.pulse;
  d.grain    = cfg.grain;

  float mag = 0.0f;
  measure(f, d.axis, mag);

  float target = 0.0f;

  switch (cfg.source) {
    case SRC_AXIS: {
      int ax = (cfg.use_axis >= 0 && cfg.use_axis <= 2) ? cfg.use_axis : 1;
      d.raw  = d.axis[ax];
      target = normalize(d.raw);
      break;
    }

    case SRC_TRIAX: {
      d.raw   = d.axis[1];
      target  = normalize(d.axis[1]);                       // Y -> strength
      // Rest means continuous; turning about X is what slows the pulsing.
      d.pulse = s_pulse.update(1.0f - normalize(d.axis[0]), f.dt_ms, cfg.tau_ms);
      d.grain = s_grain.update(normalize(d.axis[2]),        f.dt_ms, cfg.tau_ms);
      break;
    }

    case SRC_ANY:
    default:
      d.raw  = mag;
      target = normalize(mag);
      break;
  }

  // Hold overrides everything upstream, so pulse and grain can be judged
  // against a steady vibration instead of a moving target.
  if (cfg.hold >= 0.0f) {
    d.strength = cfg.hold;
    s_strength.reset(cfg.hold);
    return d;
  }

  d.strength = s_strength.update(target, f.dt_ms, cfg.tau_ms);

  // An exponential decay approaches zero without arriving, and any strength
  // above zero puts the ERM at its start-up floor -- an orb humming faintly
  // forever once it has been moved. Snap to real silence.
  if (target <= 0.0f && d.strength < 0.002f) {
    d.strength = 0.0f;
    s_strength.reset();
  }

  return d;
}
