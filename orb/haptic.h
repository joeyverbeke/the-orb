#pragma once

#include <stdint.h>

// Brings up the DRV2605L on Wire1 in realtime mode, motor silent.
bool haptic_begin();

// Intensity 0..1 -> motor. Applies cfg.floor_rtp and rate-limits the I2C
// write. Safe to call every frame. Ignored while a sweep is running.
void haptic_set(float v);

// Immediate stop. Realtime mode holds its last value and does not decay, so
// this has to be explicit.
void haptic_stop();

// Call every loop. Steps a running sweep, and zeroes the motor if nothing has
// driven it recently -- so a stalled sensor leaves a silent orb, not a buzzing
// one.
void haptic_tick();

// Last realtime value actually written (0..127), for telemetry.
uint8_t haptic_rtp();

// Whether the DRV2605L answered at init. A silent motor is ambiguous otherwise
// -- an absent driver looks exactly like an intensity of zero.
bool haptic_ready();

// Non-blocking sweep of the full realtime range, to find the ERM's start-up
// floor by hand.
void haptic_sweep_start();
bool haptic_sweeping();
