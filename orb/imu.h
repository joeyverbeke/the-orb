#pragma once

#include <stdint.h>

// A frame is one *gyroscope* report. The other three reports run at the same
// 100 Hz but arrive interleaved, so treating every sensor event as a frame
// would quadruple the apparent rate and silently mis-scale anything windowed.
// Their values are latched here and ride along with the next gyro frame.
struct ImuFrame {
  uint32_t t_ms;                  // device clock at the gyro report

  float gx, gy, gz;               // calibrated gyro, rad/s
  float ax, ay, az;               // linear accel, m/s^2, gravity removed
  float rax, ray, raz;            // raw accel, m/s^2, gravity included
  float qr, qi, qj, qk;           // game rotation vector (no magnetometer)

  float dt_ms;                    // since the previous gyro frame
  bool  discontinuity;            // dt was implausible -- drop windowed state
};

// Brings up the BNO085 on Wire. Retries with bus recovery; false means it
// never answered.
bool imu_begin();

// Call every loop. Drains the event queue and returns true when a new gyro
// frame completed, filling `out`. Handles the BNO085's spontaneous resets.
bool imu_poll(ImuFrame &out);

// Count of spontaneous sensor resets recovered from since boot.
uint32_t imu_reset_count();
