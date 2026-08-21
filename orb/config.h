#pragma once

#include <stdint.h>

// ---------------------------------------------------------------------------
// Pins. Straight from HARDWARE.md section 1 -- two independent I2C buses,
// nothing shared but power and ground.
// ---------------------------------------------------------------------------

// D4/D5 -- BNO085 on Wire
static const int PIN_SDA  = 5;
static const int PIN_SCL  = 6;

// D2/D3 -- DRV2605L on Wire1
static const int PIN_SDA1 = 3;
static const int PIN_SCL1 = 4;

static const uint8_t ADDR_BNO085  = 0x4A;   // 0x4B if the ADR jumper is bridged
static const uint32_t I2C_HZ      = 400000;

static const uint32_t SERIAL_BAUD = 921600;

static const float RAD2DEG = 57.2957795f;
static const float PI_F    = 3.14159265f;

// ---------------------------------------------------------------------------
// Two independent questions, chosen separately. Conflating them into a single
// mode list hid the fact that any quantity works with any source.
// ---------------------------------------------------------------------------

// WHAT about the rotation is being read.
enum Quantity : uint8_t {
  Q_SPEED = 0,   // how fast it is turning right now
  Q_WIND  = 1,   // how much turning has accumulated, bleeding away when you stop
  Q_DIAL  = 2,   // how far it sits from a reference orientation
  Q_COUNT = 3
};

// WHICH axes that quantity is read from.
enum Source : uint8_t {
  SRC_AXIS  = 0,  // one selected axis alone
  SRC_TRIAX = 1,  // all three, independently: Y strength, X pulse, Z grain
  SRC_ANY   = 2,  // magnitude across all three -- direction doesn't matter
  SRC_COUNT = 3
};

// ---------------------------------------------------------------------------
// Tunables. Everything the frontend can move. None of these are settled.
// ---------------------------------------------------------------------------

struct Config {
  uint8_t quantity = Q_SPEED;
  uint8_t source   = SRC_ANY;

  // --- speed curve, shared by every mode that reads rotation rate ---

  // Rotation below this does nothing. A hand merely *holding* the orb produces
  // 0.78 deg/s median / 1.58 p95 (HARDWARE.md section 4), but the act of
  // picking it up is real rotation far above that -- so a deadzone that only
  // clears hand tremor still fires on pickup. This sits high enough that only
  // deliberate turning registers.
  float deadzone_dps = 12.0f;

  // Rotation at which strength reaches full. Measured gesture peaks: arc
  // 93-100, wiggle 112-133, shake 142+.
  float saturate_dps = 120.0f;

  // Response curve exponent. < 1 is expansive -- more resolution down low.
  // Measured by hand at ~1.0: with the ERM floor doing the low-end lifting,
  // an expansive curve on top of it made everything read as on-or-strong.
  float gamma = 1.0f;

  // One-pole smoothing time constant, milliseconds.
  float tau_ms = 40.0f;

  // --- output stage ---

  // ERM start-up floor as a realtime value (0..127). Below this the eccentric
  // mass does not turn at all. Found by hand -- 35 was far too high, and was
  // eating the bottom third of the range for no reason.
  uint8_t floor_rtp = 10;

  // Pulsing. 1.0 = continuous, lower = slower pulsing. Set by slider in most
  // modes; driven by the X axis in MODE_TRIAX.
  float pulse = 1.0f;

  // Amplitude roughness. 0 = smooth, 1 = fully granular. Slider, or the Z axis
  // in MODE_TRIAX.
  float grain = 0.0f;

  // Forces strength to a constant, bypassing the active mode. Negative = off.
  // Judging grain or pulse while also having to rotate the orb means judging
  // two things at once; this holds one of them still.
  float hold = -1.0f;

  // --- per-mode ---

  int use_axis = 1;          // 0/1/2 = x/y/z, for SRC_AXIS

  // Q_WIND: how much accumulated turning reaches full, and how fast the
  // accumulation bleeds away once you stop.
  //
  // These two are not independent. Sustained turning settles at
  // (rate x decay), so full-scale is only reachable if
  // wind_full_deg <= plausible_rate x wind_decay_ms/1000. At the old
  // 720 deg / 1500 ms you needed to hold 480 deg/s to reach full -- which no
  // hand does, so every axis sat near the bottom and 3-axis could never
  // produce a strong result. 240 deg / 3000 ms means a comfortable 80 deg/s
  // reaches full, and 40 deg/s reaches half.
  float wind_full_deg  = 240.0f;
  float wind_decay_ms  = 3000.0f;

  // Q_DIAL: angular displacement from the reference that reaches full.
  float dial_full_deg = 180.0f;

  // Silence the motor when the orb is not in a hand. Without this the orb
  // buzzes on the table indefinitely in dial, where displacement from the
  // reference persists whether or not anyone is holding it.
  bool presence_gate = true;

  // Orientation drift across the window, in degrees, below which the orb is
  // considered set down. The pickup threshold is twice this (hysteresis, or
  // the state chatters at the boundary).
  //
  // Exposed because the risk here is the opposite of the bug it fixes:
  // HARDWARE.md section 5 records someone holding very still reading as a
  // putdown. If it cuts out in the hand, lower this or raise the hold below.
  float presence_still_deg = 1.2f;

  // How long stillness must persist before believing a putdown.
  float presence_putdown_ms = 700.0f;

  bool haptics_on = true;
};

extern Config cfg;
