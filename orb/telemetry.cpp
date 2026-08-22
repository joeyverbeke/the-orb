#include "telemetry.h"
#include "config.h"
#include "haptic.h"
#include "presence.h"
#include "texture.h"

#include <Arduino.h>

static uint32_t win_start_ms = 0;
static uint32_t win_frames   = 0;
static float    hz           = 0.0f;

// Off by default. Printing 100 rows/s into a USB CDC that nobody is draining
// can block Serial.write and stall the loop -- which, held in the hand with no
// monitor open, would look like the orb simply dying. The bridge turns it on.
static bool     streaming    = false;

// mx/my/mz are the active quantity read per axis -- deg/s for speed, degrees
// for wind and dial. They are what the three axes each contribute in 3-axis.
// qw/qx/qy/qz are the attitude quaternion, which drives the on-screen orb.
static const char CSV_HEADER[] =
  "t_ms,gx,gy,gz,ax,ay,az,mx,my,mz,qw,qx,qy,qz,raw,strength,pulse,grain,env,"
  "out,rtp,held,disp,loop_hz";

float telemetry_hz() { return hz; }
bool  telemetry_streaming() { return streaming; }

void telemetry_set_streaming(bool on) {
  // Re-announce on every request to stream, not just on an off->on edge.
  // A host learns the column set from this header alone, so a bridge that
  // restarts while the device is already streaming would otherwise never see
  // one -- and would silently discard every row it read.
  if (on) {
    telemetry_print_config();
    Serial.println(CSV_HEADER);
  }
  streaming = on;
}

void telemetry_begin() {
  telemetry_print_config();
  Serial.println(F("# CSV is off. 'c 1' to stream, or run tools/bridge.py."));
  win_start_ms = millis();
  win_frames   = 0;
}

void telemetry_print_config() {
  Serial.print(F("# quantity="));      Serial.println(cfg.quantity);
  Serial.print(F("# quantity_name=")); Serial.println(quantity_name(cfg.quantity));
  Serial.print(F("# source="));        Serial.println(cfg.source);
  Serial.print(F("# source_name="));   Serial.println(source_name(cfg.source));
  Serial.print(F("# use_axis="));      Serial.println(cfg.use_axis);
  Serial.print(F("# deadzone_dps=")); Serial.println(cfg.deadzone_dps, 3);
  Serial.print(F("# saturate_dps=")); Serial.println(cfg.saturate_dps, 3);
  Serial.print(F("# gamma="));        Serial.println(cfg.gamma, 3);
  Serial.print(F("# tau_ms="));       Serial.println(cfg.tau_ms, 3);
  Serial.print(F("# floor_rtp="));    Serial.println(cfg.floor_rtp);
  Serial.print(F("# pulse="));        Serial.println(cfg.pulse, 3);
  Serial.print(F("# grain="));        Serial.println(cfg.grain, 3);
  Serial.print(F("# wind_full_deg=")); Serial.println(cfg.wind_full_deg, 1);
  Serial.print(F("# wind_decay_ms=")); Serial.println(cfg.wind_decay_ms, 1);
  Serial.print(F("# dial_full_deg=")); Serial.println(cfg.dial_full_deg, 1);
  Serial.print(F("# hold="));         Serial.println(cfg.hold, 3);
  Serial.print(F("# presence_gate=")); Serial.println(cfg.presence_gate ? 1 : 0);
  Serial.print(F("# presence_still_deg="));  Serial.println(cfg.presence_still_deg, 2);
  Serial.print(F("# presence_putdown_ms=")); Serial.println(cfg.presence_putdown_ms, 0);
  Serial.print(F("# haptics_on="));   Serial.println(cfg.haptics_on ? 1 : 0);
  Serial.print(F("# drv_ready="));    Serial.println(haptic_ready() ? 1 : 0);
  Serial.print(F("# imu_resets="));   Serial.println(imu_reset_count());
  Serial.print(F("# loop_hz="));      Serial.println(hz, 1);
}

void telemetry_frame(const ImuFrame &f, const Drive &d, float out) {
  // Rolling one-second average, so the loop rate is never a mystery.
  win_frames++;
  uint32_t now = millis();
  if (now - win_start_ms >= 1000) {
    hz = win_frames * 1000.0f / (float)(now - win_start_ms);
    win_start_ms = now;
    win_frames   = 0;
  }

  if (!streaming) return;

  // Hand-rolled rather than printf: the core's default printf has no float
  // support, and this runs 100x/s.
  Serial.print(f.t_ms);           Serial.print(',');
  Serial.print(f.gx, 4);          Serial.print(',');
  Serial.print(f.gy, 4);          Serial.print(',');
  Serial.print(f.gz, 4);          Serial.print(',');
  // Linear acceleration, gravity already removed: motion through space, as
  // opposed to rotation. Needed by anything reacting to being moved rather
  // than turned.
  Serial.print(f.ax, 3);          Serial.print(',');
  Serial.print(f.ay, 3);          Serial.print(',');
  Serial.print(f.az, 3);          Serial.print(',');
  Serial.print(d.axis[0], 2);     Serial.print(',');
  Serial.print(d.axis[1], 2);     Serial.print(',');
  Serial.print(d.axis[2], 2);     Serial.print(',');
  Serial.print(f.qr, 4);          Serial.print(',');
  Serial.print(f.qi, 4);          Serial.print(',');
  Serial.print(f.qj, 4);          Serial.print(',');
  Serial.print(f.qk, 4);          Serial.print(',');
  Serial.print(d.raw, 2);         Serial.print(',');
  Serial.print(d.strength, 4);    Serial.print(',');
  Serial.print(d.pulse, 3);       Serial.print(',');
  Serial.print(d.grain, 3);       Serial.print(',');
  Serial.print(texture_envelope(), 3); Serial.print(',');
  Serial.print(out, 4);           Serial.print(',');
  Serial.print(haptic_rtp());     Serial.print(',');
  Serial.print(presence_held() ? 1 : 0); Serial.print(',');
  Serial.print(presence_displacement_deg(), 2); Serial.print(',');
  Serial.println(hz, 1);
}
