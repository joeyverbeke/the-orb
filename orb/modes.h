#pragma once

#include "imu.h"

// What the mode stage produces. Only SRC_TRIAX drives pulse and grain from the
// sensor; the other sources inherit the slider values. Keeping all three in
// one struct means the texture stage doesn't care where they came from.
struct Drive {
  float strength;     // 0..1
  float pulse;        // 0..1, 1 = continuous
  float grain;        // 0..1

  // The active quantity, in its own units, for the frontend -- deg/s for
  // speed, degrees for wind and dial.
  float raw;

  // Per-axis quantity before normalisation, so the frontend can show what the
  // three axes are each contributing in SRC_TRIAX.
  float axis[3];
};

// Runs the active quantity/source pair. Call once per IMU frame.
Drive modes_update(const ImuFrame &f);

// Drop all accumulated state -- wind accumulators, dial reference, smoothing.
// Called on a timing discontinuity and whenever the quantity or source
// changes, so one configuration's history can't leak into the next.
void modes_reset();

const char *quantity_name(uint8_t q);
const char *source_name(uint8_t s);
