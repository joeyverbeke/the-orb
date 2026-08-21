#pragma once

#include "modes.h"

// Pulse and grain sit downstream of every mode, so a mode only has to decide
// "how much" and the character of the vibration stays a separate question.
//
// Applied to Drive.strength, returns the final 0..1 for the motor.
float texture_apply(const Drive &d, float dt_ms);

// Current pulse envelope, 0..1, for the frontend. Lets you see the rhythm
// even when the strength is zero and nothing is being felt.
float texture_envelope();

void texture_reset();
