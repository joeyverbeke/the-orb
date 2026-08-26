#include "haptic.h"
#include "config.h"
#include "io.h"

#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_DRV2605.h>

static Adafruit_DRV2605 drv;

static uint8_t  last_rtp      = 0;
static uint32_t last_write_ms = 0;
static uint32_t last_drive_ms = 0;
static bool     ready         = false;

// Caps bursts without aliasing against the 10 ms frame period -- at 10 ms this
// would land on the wrong side of the comparison about half the time and drop
// every other update.
static const uint32_t WRITE_INTERVAL_MS = 5;

// If nothing calls haptic_set for this long, stop. Realtime mode would
// otherwise hold its last value forever.
static const uint32_t IDLE_TIMEOUT_MS = 200;

// Sweep: hold each step long enough to feel whether the mass is actually
// turning, which is the whole point of the measurement.
static const uint8_t  SWEEP_STEP    = 4;
static const uint32_t SWEEP_HOLD_MS = 700;

static bool     sweeping      = false;
static uint8_t  sweep_rtp     = 0;
static uint32_t sweep_step_ms = 0;

static void writeRtp(uint8_t rtp) {
  if (!ready) return;
  drv.setRealtimeValue(rtp);
  last_rtp      = rtp;
  last_write_ms = millis();
}

bool haptic_begin() {
  Wire1.begin(PIN_SDA1, PIN_SCL1);
  Wire1.setClock(I2C_HZ);
  if (!drv.begin(&Wire1)) return false;

  drv.selectLibrary(1);                    // 1 = ERM
  drv.useERM();                            // Adafruit 1201 is an ERM coin motor
  drv.setMode(DRV2605_MODE_REALTIME);      // set once -- never per frame

  ready = true;
  writeRtp(0);
  return true;
}

uint8_t haptic_rtp() { return last_rtp; }
bool    haptic_ready() { return ready; }
bool    haptic_sweeping() { return sweeping; }

void haptic_stop() {
  sweeping = false;
  writeRtp(0);
}

void haptic_set(float v) {
  if (sweeping) return;

  last_drive_ms = millis();

  if (v <= 0.0f) { if (last_rtp != 0) writeRtp(0); return; }
  if (v > 1.0f) v = 1.0f;

  // The important line. An ERM does not turn at all below its start-up
  // voltage, so mapping 0..1 onto the raw 0..127 would spend the bottom third
  // of the input range on silence and make slow rotation feel dead. Map onto
  // the motor's useful range instead.
  uint8_t floor_rtp = cfg.floor_rtp;
  if (floor_rtp > 126) floor_rtp = 126;
  uint8_t rtp = (uint8_t)lroundf(floor_rtp + v * (127.0f - floor_rtp));

  if (rtp == last_rtp) return;
  if (millis() - last_write_ms < WRITE_INTERVAL_MS) return;
  writeRtp(rtp);
}

void haptic_tick() {
  uint32_t now = millis();

  if (sweeping) {
    if (now - sweep_step_ms < SWEEP_HOLD_MS) return;
    sweep_step_ms = now;

    if (sweep_rtp > 127 - SWEEP_STEP) {
      sweeping = false;
      writeRtp(0);
      io().println(F("# sweep done -- set the floor with: f <value>"));
      return;
    }
    sweep_rtp += SWEEP_STEP;
    writeRtp(sweep_rtp);
    // No '=' in this line: the bridge reads "# key=value" as settings, and a
    // sweep readout is not a setting.
    io().print(F("# sweep rtp "));
    io().println(sweep_rtp);
    return;
  }

  // Nothing has driven the motor recently -- a stalled IMU should leave a
  // silent orb, not a buzzing one.
  if (last_rtp != 0 && now - last_drive_ms > IDLE_TIMEOUT_MS) writeRtp(0);
}

void haptic_sweep_start() {
  sweeping      = true;
  sweep_rtp     = 0;
  sweep_step_ms = millis();
  writeRtp(0);
  io().println(F("# sweep: rising 0..127. Note where the motor first turns,"));
  io().println(F("#        and where you can first feel it. 'z' aborts."));
}
