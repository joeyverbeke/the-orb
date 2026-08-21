#include "mapping.h"
#include "config.h"

#include <math.h>

float curve_norm(float x) {
  if (x <= 0.0f) return 0.0f;
  if (x >= 1.0f) x = 1.0f;
  return (cfg.gamma == 1.0f) ? x : powf(x, cfg.gamma);
}

float curve_dps(float omega_dps) {
  float span = cfg.saturate_dps - cfg.deadzone_dps;
  if (span < 1e-3f) span = 1e-3f;              // guard a bad slider value
  return curve_norm((omega_dps - cfg.deadzone_dps) / span);
}

float Smoother::update(float target, float dt_ms, float tau_ms) {
  if (dt_ms <= 0.0f || tau_ms <= 0.0f) {
    value = target;
    return value;
  }
  float alpha = dt_ms / (tau_ms + dt_ms);
  if (alpha > 1.0f) alpha = 1.0f;
  value += alpha * (target - value);
  return value;
}
