#pragma once

#include "imu.h"

// Is the orb in a hand?
//
// HARDWARE.md section 4 separates hand from table by gyro median (0.78 vs 0.05
// deg/s), and that is the right measurement -- but only with the motor off.
// Measured on this build, a running ERM lifts the resting median to 0.42-0.60
// deg/s, straight through the 0.50 "held" threshold. Presence read that way
// latches on the moment the motor starts and never clears: the motor keeps
// itself alive.
//
// So this reads net orientation *displacement* over a window instead. Motor
// vibration is jitter about a fixed attitude and averages to nothing over a
// second; a hand cannot hold an object without drifting it. The quantity that
// separates them is therefore immune to the thing that broke the other one.

void presence_begin();

// Call once per IMU frame. Returns the current state.
bool presence_update(const ImuFrame &f);

bool presence_held();

// Degrees of orientation change across the window -- the raw evidence, for the
// frontend and for tuning the thresholds against a real hand.
float presence_displacement_deg();

void presence_reset();
