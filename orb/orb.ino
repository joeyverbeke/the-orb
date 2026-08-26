// The Orb -- a rig for finding out what rotation should feel like.
//
// The pipeline is deliberately in stages, because which stage is wrong is the
// question the rig exists to answer:
//
//   imu  ->  modes  ->  texture  ->  haptic
//   what      how       what           the
//   moved     much      character      motor
//
// Modes are swappable at runtime; texture (pulse, grain) applies to all of
// them. Nothing in loop() blocks.

#include <Arduino.h>

#include "config.h"
#include "console.h"
#include "haptic.h"
#include "imu.h"
#include "modes.h"
#include "net.h"
#include "presence.h"
#include "telemetry.h"
#include "texture.h"
#include "voice.h"

Config cfg;

static bool imu_ok    = false;
static bool haptic_ok = false;

void setup() {
  Serial.begin(SERIAL_BAUD);

  // Give USB CDC a moment to enumerate, but don't hang forever if nothing is
  // listening -- the orb has to run untethered.
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 1500) { }

  Serial.println(F("# --- the orb ---"));

  // First, so association runs in the background while the buses come up.
  net_begin();

  haptic_ok = haptic_begin();
  Serial.println(haptic_ok ? F("# DRV2605L ok (ERM, realtime mode)")
                           : F("# DRV2605L NOT FOUND -- check Wire1 on D2/D3"));

  imu_ok = imu_begin();
  Serial.println(imu_ok ? F("# BNO085 ok, 4 reports at 100 Hz")
                        : F("# BNO085 NOT FOUND -- check Wire on D4/D5"));

  bool voice_ok = voice_begin();
  Serial.println(voice_ok ? F("# MAX98357A ok, I2S up on D10/D9/D8")
                          : F("# I2S NOT STARTED -- voice is silent"));
  if (voice_ok && !voice_fs()) {
    Serial.println(F("# no LittleFS -- flash the clip image, see tools/voice_build.py"));
  }

  modes_reset();
  texture_reset();
  presence_begin();
  telemetry_begin();
}

void loop() {
  net_tick();             // accepts a host, watches the association
  console_tick();
  haptic_tick();          // steps a running sweep; idle-stops a stale motor
  voice_tick();           // reports clip start/end; the audio itself is on core 0

  if (!imu_ok) return;

  ImuFrame f;
  if (!imu_poll(f)) return;

  // A reboot or sensor reset must not be smoothed across, and must not leave
  // a stale dial reference behind.
  if (f.discontinuity) {
    modes_reset();
    texture_reset();
    presence_reset();
  }

  static bool was_held = false;
  bool held = presence_update(f);

  // Picking it up starts a fresh gesture: dial takes its reference from the
  // attitude it was lifted at, and no wind charge survives from last time.
  if (held && !was_held) modes_reset();
  was_held = held;

  Drive d   = modes_update(f);
  float out = texture_apply(d, f.dt_ms);

  // Set down means silent, whatever the mode still thinks. Dial in particular
  // holds a nonzero displacement forever once the orb is left off-reference.
  if (cfg.presence_gate && !held) out = 0.0f;

  if (cfg.haptics_on && haptic_ok) haptic_set(out);

  telemetry_frame(f, d, out);
}
