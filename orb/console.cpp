#include "console.h"
#include "config.h"
#include "haptic.h"
#include "modes.h"
#include "telemetry.h"

#include <Arduino.h>
#include <stdlib.h>
#include <string.h>

static char line[64];
static uint8_t len = 0;

// A host-driven hold ('v') must not outlive the host. If a browser tab closes
// or the bridge dies mid-drive, no release ever arrives and the orb is stuck at
// whatever it was last told -- pinned silent, or buzzing on the desk, with its
// own modes bypassed. Page-unload handlers cannot reliably flush a socket send,
// so the device times the hold out itself. A hold set by hand with 'H' is
// deliberately sticky and is never timed out.
static const uint32_t HOLD_TIMEOUT_MS = 500;
static bool     hold_live = false;
static uint32_t hold_live_ms = 0;

// Terse on purpose: the frontend speaks this, not a person. The bridge
// translates button presses and slider drags into these.
void console_help() {
  Serial.println(F("# commands:"));
  Serial.println(F("#   Q <0|1|2>  quantity: 0 speed 1 wind 2 dial"));
  Serial.println(F("#   S <0|1|2>  source:   0 1-axis 1 3-axis 2 any-direction"));
  Serial.println(F("#   R          re-capture the dial reference / reset accumulators"));
  Serial.println(F("#   a <0|1|2>  axis, for the 1-axis source"));
  Serial.println(F("#   d <dps>    deadzone       s <dps>  saturation"));
  Serial.println(F("#   g <val>    curve exponent t <ms>   smoothing"));
  Serial.println(F("#   f <0..126> ERM floor"));
  Serial.println(F("#   P <0..1>   pulse (1 = continuous)"));
  Serial.println(F("#   G <0..1>   grain"));
  Serial.println(F("#   W <deg>    wind full-scale   D <ms>  wind decay"));
  Serial.println(F("#   L <deg>    dial full-scale"));
  Serial.println(F("#   H <0..1>   hold strength constant (-1 = off)"));
  Serial.println(F("#   v <0..1>   as H, but no settings echo (host-driven)"));
  Serial.println(F("#   k <0|1>    silence the motor when set down"));
  Serial.println(F("#   h <0|1>    haptics    m  motor sweep    z  stop"));
  Serial.println(F("#   c <0|1>    CSV stream    p  print settings    ?  this"));
}

static float clampf(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

static void handle(char *s) {
  while (*s == ' ') s++;
  if (!*s) return;

  char cmd = *s++;
  while (*s == ' ') s++;
  float v = (*s != '\0') ? atof(s) : 0.0f;

  switch (cmd) {
    case 'Q': {
      int q = (int)v;
      if (q < 0 || q >= Q_COUNT) { Serial.println(F("# bad quantity")); break; }
      cfg.quantity = (uint8_t)q;
      // One configuration's accumulated history must not leak into the next --
      // a wind charge carried into dial would read as phantom displacement.
      modes_reset();
      break;
    }

    case 'S': {
      int s2 = (int)v;
      if (s2 < 0 || s2 >= SRC_COUNT) { Serial.println(F("# bad source")); break; }
      cfg.source = (uint8_t)s2;

      // Three axes driving three parameters is untestable against speed: all
      // three are transient and come from the same gesture, so you can never
      // hold one while varying another. Wind accumulates per axis and persists,
      // which is what makes the combination explorable. Only a default --
      // pick speed explicitly afterwards and it stays.
      if (cfg.source == SRC_TRIAX && cfg.quantity == Q_SPEED) {
        cfg.quantity = Q_WIND;
      }
      modes_reset();
      break;
    }

    case 'R':
      modes_reset();
      Serial.println(F("# reference reset"));
      break;

    case 'a': {
      int ax = (int)v;
      if (ax < 0 || ax > 2) { Serial.println(F("# axis must be 0..2")); break; }
      cfg.use_axis = ax;
      Serial.print(F("# use_axis=")); Serial.println(cfg.use_axis);
      break;
    }

    case 'd': cfg.deadzone_dps = clampf(v, 0.0f, 500.0f);  break;
    case 's': cfg.saturate_dps = clampf(v, 1.0f, 1000.0f); break;
    case 'g': cfg.gamma        = clampf(v, 0.05f, 5.0f);   break;
    case 't': cfg.tau_ms       = clampf(v, 0.0f, 2000.0f); break;
    case 'P': cfg.pulse        = clampf(v, 0.0f, 1.0f);    break;
    case 'G': cfg.grain        = clampf(v, 0.0f, 1.0f);    break;
    case 'W': cfg.wind_full_deg = clampf(v, 10.0f, 10000.0f); break;
    case 'D': cfg.wind_decay_ms = clampf(v, 50.0f, 60000.0f); break;
    case 'L': cfg.dial_full_deg = clampf(v, 5.0f, 360.0f);    break;
    case 'H':
      cfg.hold  = clampf(v, -1.0f, 1.0f);
      hold_live = false;            // set by hand: sticky, no timeout
      break;

    // Same as 'H', but deliberately absent from the echo list below.
    // A host experiment drives this at frame rate, and echoing the whole
    // settings block on every write would bury the link in config dumps.
    case 'v':
      cfg.hold     = clampf(v, -1.0f, 1.0f);
      hold_live    = (cfg.hold >= 0.0f);
      hold_live_ms = millis();
      break;
    case 'n': cfg.presence_still_deg  = clampf(v, 0.1f, 20.0f);      break;
    case 'o': cfg.presence_putdown_ms = clampf(v, 100.0f, 10000.0f); break;

    case 'f':
      cfg.floor_rtp = (uint8_t)clampf(v, 0.0f, 126.0f);
      break;

    case 'h':
      cfg.haptics_on = (v != 0.0f);
      if (!cfg.haptics_on) haptic_stop();
      break;

    case 'k':
      cfg.presence_gate = (v != 0.0f);
      break;

    case 'm':
      // Deliberately does NOT stop the CSV any more. It used to, which froze
      // the frontend for the length of the sweep -- the UI has no data source
      // other than that stream.
      haptic_sweep_start();
      break;

    case 'z':
      haptic_stop();
      Serial.println(F("# stopped"));
      break;

    case 'c':
      telemetry_set_streaming(v != 0.0f);
      break;

    case 'p':
      telemetry_print_config();
      break;

    case '?':
      console_help();
      break;

    default:
      Serial.print(F("# unknown command: ")); Serial.println(cmd);
      return;
  }

  // Echo the whole settings block after any change the frontend made, so its
  // sliders and the device can never silently disagree about the state.
  if (strchr("dsgtPGWDLHnofhkaQSR", cmd)) telemetry_print_config();
}

void console_tick() {
  if (hold_live && millis() - hold_live_ms > HOLD_TIMEOUT_MS) {
    hold_live = false;
    cfg.hold  = -1.0f;            // hand the motor back to the mode pipeline
  }

  // Only ever consumes what is already buffered -- no blocking reads.
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      line[len] = '\0';
      handle(line);
      len = 0;
      continue;
    }
    if (len < sizeof(line) - 1) line[len++] = c;
  }
}
