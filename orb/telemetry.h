#pragma once

#include "imu.h"
#include "modes.h"

// Prints the boot settings. Comment lines start with '#' so the log stays
// machine-readable with notes in it. CSV streaming starts off.
void telemetry_begin();

// One CSV row per frame. Also folds the frame into the rolling loop-rate
// estimate.
void telemetry_frame(const ImuFrame &f, const Drive &d, float out);

// Current rolling frame rate, Hz.
float telemetry_hz();

// Dumps every setting as '#' key=value lines. This is also what the frontend
// parses to sync its controls, so it is the single source of truth for state.
void telemetry_print_config();

// CSV rows on/off. Turning it on re-prints the settings and the header, so
// each recording stands on its own.
void telemetry_set_streaming(bool on);
bool telemetry_streaming();
