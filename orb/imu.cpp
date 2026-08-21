#include "imu.h"
#include "config.h"

#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_BNO08x.h>

static Adafruit_BNO08x   bno08x(-1);      // no reset pin wired
static sh2_SensorValue_t sensorValue;

static ImuFrame  latched;                 // non-gyro reports accumulate here
static uint32_t  last_emit_us = 0;
static uint32_t  reset_count  = 0;
static bool      have_prev    = false;

// A reset landing mid-transaction leaves the BNO085 holding SDA low, and the
// bus stays wedged until it is clocked out. Cheap to recover from, baffling if
// you don't know about it.
static void i2cRecover() {
  pinMode(PIN_SCL, OUTPUT);
  pinMode(PIN_SDA, INPUT_PULLUP);
  for (int i = 0; i < 9 && digitalRead(PIN_SDA) == LOW; i++) {
    digitalWrite(PIN_SCL, LOW);  delayMicroseconds(5);
    digitalWrite(PIN_SCL, HIGH); delayMicroseconds(5);
  }
  pinMode(PIN_SDA, OUTPUT);                       // manual STOP
  digitalWrite(PIN_SDA, LOW);  delayMicroseconds(5);
  digitalWrite(PIN_SCL, HIGH); delayMicroseconds(5);
  digitalWrite(PIN_SDA, HIGH); delayMicroseconds(5);
}

// Module 01 needs only the gyro. The other three are enabled now because four
// streams at 100 Hz is about a third of a 400 kHz bus -- known to fit -- and
// later modules want them without re-measuring bus headroom.
static bool enableReports() {
  bool ok  = bno08x.enableReport(SH2_GAME_ROTATION_VECTOR, 10000);   // 100 Hz
  ok &= bno08x.enableReport(SH2_GYROSCOPE_CALIBRATED,   10000);
  ok &= bno08x.enableReport(SH2_LINEAR_ACCELERATION,    10000);
  ok &= bno08x.enableReport(SH2_ACCELEROMETER,          10000);
  return ok;
}

bool imu_begin() {
  latched   = ImuFrame{};
  have_prev = false;
  for (int attempt = 1; attempt <= 5; attempt++) {
    i2cRecover();
    Wire.begin(PIN_SDA, PIN_SCL);
    Wire.setClock(I2C_HZ);
    if (bno08x.begin_I2C(ADDR_BNO085, &Wire) && enableReports()) return true;
    delay(250);                     // setup only -- the main loop never blocks
  }
  return false;
}

uint32_t imu_reset_count() { return reset_count; }

bool imu_poll(ImuFrame &out) {
  // The BNO085 resets itself spontaneously. Without this the stream stops and
  // nothing tells you why.
  if (bno08x.wasReset()) {
    reset_count++;
    enableReports();
    have_prev = false;              // the clock relationship is broken
  }

  bool got_gyro = false;

  // Drain the whole queue every call so a burst never backs up. Reports arrive
  // interleaved; only the gyro closes a frame.
  while (bno08x.getSensorEvent(&sensorValue)) {
    switch (sensorValue.sensorId) {
      case SH2_GAME_ROTATION_VECTOR:
        latched.qr = sensorValue.un.gameRotationVector.real;
        latched.qi = sensorValue.un.gameRotationVector.i;
        latched.qj = sensorValue.un.gameRotationVector.j;
        latched.qk = sensorValue.un.gameRotationVector.k;
        break;

      case SH2_LINEAR_ACCELERATION:
        latched.ax = sensorValue.un.linearAcceleration.x;
        latched.ay = sensorValue.un.linearAcceleration.y;
        latched.az = sensorValue.un.linearAcceleration.z;
        break;

      case SH2_ACCELEROMETER:
        latched.rax = sensorValue.un.accelerometer.x;
        latched.ray = sensorValue.un.accelerometer.y;
        latched.raz = sensorValue.un.accelerometer.z;
        break;

      case SH2_GYROSCOPE_CALIBRATED:
        latched.gx = sensorValue.un.gyroscope.x;
        latched.gy = sensorValue.un.gyroscope.y;
        latched.gz = sensorValue.un.gyroscope.z;
        got_gyro   = true;
        break;

      default:
        break;
    }
  }

  if (!got_gyro) return false;

  // If several gyro reports landed in one drain, the newest wins and dt spans
  // the whole gap -- measured against the frame actually emitted last, so the
  // filter downstream sees real elapsed time rather than a nominal 10 ms.
  //
  // Device clock, never host arrival time: USB jitter must not be able to move
  // a boundary. micros() because dt is ~10 ms and millis() would quantise it to
  // 10% error. Unsigned subtraction makes the ~71 min micros wrap harmless.
  uint32_t now_us = micros();
  float dt = have_prev ? (now_us - last_emit_us) / 1000.0f : 0.0f;
  bool  bad = !have_prev || dt <= 0.0f || dt > 2000.0f;

  latched.t_ms          = millis();
  latched.dt_ms         = bad ? 0.0f : dt;
  latched.discontinuity = bad;

  last_emit_us = now_us;
  have_prev    = true;

  out = latched;
  return true;
}
