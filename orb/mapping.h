#pragma once

// Shared signal primitives. Every mode is built from these, so changing the
// feel of the curve changes it everywhere at once.

// Rotation speed -> 0..1 through deadzone, saturation, and the curve exponent.
// Pure -- no state, no I2C, no Serial.
float curve_dps(float omega_dps);

// Generic 0..1 -> 0..1 through the curve, for quantities already normalised
// (accumulated angle, displacement) that still want the same shaping.
float curve_norm(float x);

// One-pole low-pass against real elapsed time, so the feel does not change
// when the loop rate drifts.
struct Smoother {
  float value = 0.0f;

  void reset(float v = 0.0f) { value = v; }

  // dt_ms <= 0 snaps rather than filters -- used on a timing discontinuity.
  float update(float target, float dt_ms, float tau_ms);
};
