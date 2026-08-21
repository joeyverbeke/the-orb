#include "presence.h"
#include "config.h"

#include <Arduino.h>
#include <math.h>

// 128 frames = 1.28 s at 100 Hz. Long enough that vibration averages out,
// short enough that setting the orb down doesn't leave it buzzing.
static const int RING_N = 128;
static float ring[RING_N][4];
static int   ring_i = 0, ring_n = 0;

// Believe a pickup quickly, a putdown slowly (HARDWARE.md section 5). Someone
// holding very still briefly drops under the threshold, and cutting them off
// reads as the object dying in the hand.
static const uint32_t PICKUP_HOLD_MS = 300;

static bool     held = false;
static uint32_t moved_since = 0, still_since = 0;
static float    displacement = 0.0f;

void presence_reset() {
  ring_i = ring_n = 0;
  held = false;
  moved_since = still_since = 0;
  displacement = 0.0f;
}

void presence_begin() { presence_reset(); }

bool  presence_held() { return held; }
float presence_displacement_deg() { return displacement; }

bool presence_update(const ImuFrame &f) {
  // Oldest sample in the window, before this one overwrites it.
  const float *old = ring[(ring_i + RING_N - ring_n) % RING_N];

  if (ring_n >= 8) {
    // Angle between the attitude a window ago and now. |dot| because q and -q
    // are the same orientation.
    float dot = f.qr*old[0] + f.qi*old[1] + f.qj*old[2] + f.qk*old[3];
    dot = fabsf(dot);
    if (dot > 1.0f) dot = 1.0f;
    displacement = 2.0f * acosf(dot) * RAD2DEG;
  } else {
    displacement = 0.0f;
  }

  ring[ring_i][0] = f.qr; ring[ring_i][1] = f.qi;
  ring[ring_i][2] = f.qj; ring[ring_i][3] = f.qk;
  ring_i = (ring_i + 1) % RING_N;
  if (ring_n < RING_N) ring_n++;

  if (ring_n < RING_N) return held;      // no verdict until the window is full

  uint32_t now = f.t_ms;
  float still_deg = cfg.presence_still_deg;
  bool moving = held ? (displacement > still_deg)
                     : (displacement > still_deg * 2.0f);

  if (!held) {
    if (!moving) { moved_since = 0; return held; }
    if (!moved_since) { moved_since = now; return held; }
    if (now - moved_since >= PICKUP_HOLD_MS) {
      held = true;
      moved_since = 0; still_since = 0;
    }
    return held;
  }

  if (moving) { still_since = 0; return held; }
  if (!still_since) { still_since = now; return held; }
  if (now - still_since >= (uint32_t)cfg.presence_putdown_ms) {
    held = false;
    still_since = 0;
  }
  return held;
}
