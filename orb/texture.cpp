#include "texture.h"
#include "config.h"

#include <math.h>

// Below this the pulses are too slow to read as rhythm; above it the ERM's
// own 40-60 ms spin-up smooths them into a continuous buzz regardless. 18 Hz
// was past that ceiling, so the top half of the control range all felt the
// same -- most of the travel bought nothing.
static const float PULSE_MIN_HZ = 0.7f;
static const float PULSE_MAX_HZ = 10.0f;

// pulse at or above this counts as continuous -- no modulation at all.
static const float CONTINUOUS_ABOVE = 0.97f;

// Grain is sample-and-hold rather than per-frame noise: at 100 Hz, fresh noise
// every frame lands above what the motor can follow and just reads as a slightly
// weaker buzz. Held steps land in the range where the mass can actually respond,
// which is what makes it feel granular rather than merely noisy.
static const float GRAIN_HZ = 14.0f;

static float pulse_phase = 0.0f;
static float grain_phase = 0.0f;
static float grain_value = 0.0f;
static float envelope    = 1.0f;

static uint32_t rng_state = 0x2545F491u;

static float rnd01() {
  rng_state ^= rng_state << 13;
  rng_state ^= rng_state >> 17;
  rng_state ^= rng_state << 5;
  return (rng_state >> 8) / 16777216.0f;      // 24 bits -> 0..1
}

float texture_envelope() { return envelope; }

void texture_reset() {
  pulse_phase = 0.0f;
  grain_phase = 0.0f;
  grain_value = 0.0f;
  envelope    = 1.0f;
}

float texture_apply(const Drive &d, float dt_ms) {
  float out = d.strength;
  float dt_s = (dt_ms > 0.0f) ? dt_ms / 1000.0f : 0.0f;

  // --- pulse ---
  if (d.pulse >= CONTINUOUS_ABOVE) {
    envelope    = 1.0f;
    pulse_phase = 0.0f;
  } else {
    float p = (d.pulse < 0.0f) ? 0.0f : d.pulse / CONTINUOUS_ABOVE;
    if (p > 1.0f) p = 1.0f;

    // Geometric, not linear. Rate is heard as ratio -- 1 to 2 Hz is an obvious
    // change, 9 to 10 Hz is not -- so a linear map crowds every distinguishable
    // rate into the bottom of the control and wastes the rest.
    float hz = PULSE_MIN_HZ * powf(PULSE_MAX_HZ / PULSE_MIN_HZ, p);

    pulse_phase += hz * dt_s;
    if (pulse_phase >= 1.0f) pulse_phase -= floorf(pulse_phase);

    // Raised cosine rather than a square: the ERM cannot produce a sharp edge
    // anyway, and asking for one just wastes the top of the range on a
    // transient the mass never reaches.
    envelope = 0.5f * (1.0f - cosf(2.0f * PI_F * pulse_phase));
    out *= envelope;
  }

  // --- grain ---
  if (d.grain > 0.0f) {
    grain_phase += GRAIN_HZ * dt_s;
    if (grain_phase >= 1.0f) {
      grain_phase -= floorf(grain_phase);
      grain_value  = rnd01();
    }
    float g = (d.grain > 1.0f) ? 1.0f : d.grain;
    out *= (1.0f - g * grain_value);
  }

  if (out < 0.0f) out = 0.0f;
  if (out > 1.0f) out = 1.0f;
  return out;
}
