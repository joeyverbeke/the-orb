#include "telemetry.h"
#include "voice.h"
#include "config.h"
#include "haptic.h"
#include "io.h"
#include "presence.h"
#include "texture.h"

#include <Arduino.h>

static uint32_t win_start_ms = 0;
static uint32_t win_frames   = 0;
static float    hz           = 0.0f;

// Off by default. Printing 100 rows/s into a USB CDC that nobody is draining
// can block io().write and stall the loop -- which, held in the hand with no
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
    io().println(CSV_HEADER);
  }
  streaming = on;
}

void telemetry_begin() {
  telemetry_print_config();
  io().println(F("# CSV is off. 'c 1' to stream, or run tools/bridge.py."));
  win_start_ms = millis();
  win_frames   = 0;
}

void telemetry_print_config() {
  io().print(F("# quantity="));      io().println(cfg.quantity);
  io().print(F("# quantity_name=")); io().println(quantity_name(cfg.quantity));
  io().print(F("# source="));        io().println(cfg.source);
  io().print(F("# source_name="));   io().println(source_name(cfg.source));
  io().print(F("# use_axis="));      io().println(cfg.use_axis);
  io().print(F("# deadzone_dps=")); io().println(cfg.deadzone_dps, 3);
  io().print(F("# saturate_dps=")); io().println(cfg.saturate_dps, 3);
  io().print(F("# gamma="));        io().println(cfg.gamma, 3);
  io().print(F("# tau_ms="));       io().println(cfg.tau_ms, 3);
  io().print(F("# floor_rtp="));    io().println(cfg.floor_rtp);
  io().print(F("# pulse="));        io().println(cfg.pulse, 3);
  io().print(F("# grain="));        io().println(cfg.grain, 3);
  io().print(F("# wind_full_deg=")); io().println(cfg.wind_full_deg, 1);
  io().print(F("# wind_decay_ms=")); io().println(cfg.wind_decay_ms, 1);
  io().print(F("# dial_full_deg=")); io().println(cfg.dial_full_deg, 1);
  io().print(F("# hold="));         io().println(cfg.hold, 3);
  io().print(F("# presence_gate=")); io().println(cfg.presence_gate ? 1 : 0);
  io().print(F("# presence_still_deg="));  io().println(cfg.presence_still_deg, 2);
  io().print(F("# presence_putdown_ms=")); io().println(cfg.presence_putdown_ms, 0);
  io().print(F("# haptics_on="));   io().println(cfg.haptics_on ? 1 : 0);
  io().print(F("# drv_ready="));    io().println(haptic_ready() ? 1 : 0);
  io().print(F("# voice_ready=")); io().println(voice_ready() ? 1 : 0);
  io().print(F("# voice_fs="));    io().println(voice_fs() ? 1 : 0);
  io().print(F("# voice_gain="));  io().println(voice_gain(), 3);
  io().print(F("# voice_clip="));  io().println(voice_clip());
  io().print(F("# imu_resets="));   io().println(imu_reset_count());
  io().print(F("# loop_hz="));      io().println(hz, 1);
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

  // A backed-up link must never stall the loop -- over TCP a blocking write can
  // sit in select() for seconds, and the orb goes dead in the hand while it
  // does. Dropping the row instead is nearly invisible: the app interpolates
  // between the frames that do arrive.
  if (!io_can_write()) return;

  // Hand-rolled rather than printf: the core's default printf has no float
  // support, and this runs 100x/s.
  io().print(f.t_ms);           io().print(',');
  io().print(f.gx, 4);          io().print(',');
  io().print(f.gy, 4);          io().print(',');
  io().print(f.gz, 4);          io().print(',');
  // Linear acceleration, gravity already removed: motion through space, as
  // opposed to rotation. Needed by anything reacting to being moved rather
  // than turned.
  io().print(f.ax, 3);          io().print(',');
  io().print(f.ay, 3);          io().print(',');
  io().print(f.az, 3);          io().print(',');
  io().print(d.axis[0], 2);     io().print(',');
  io().print(d.axis[1], 2);     io().print(',');
  io().print(d.axis[2], 2);     io().print(',');
  io().print(f.qr, 4);          io().print(',');
  io().print(f.qi, 4);          io().print(',');
  io().print(f.qj, 4);          io().print(',');
  io().print(f.qk, 4);          io().print(',');
  io().print(d.raw, 2);         io().print(',');
  io().print(d.strength, 4);    io().print(',');
  io().print(d.pulse, 3);       io().print(',');
  io().print(d.grain, 3);       io().print(',');
  io().print(texture_envelope(), 3); io().print(',');
  io().print(out, 4);           io().print(',');
  io().print(haptic_rtp());     io().print(',');
  io().print(presence_held() ? 1 : 0); io().print(',');
  io().print(presence_displacement_deg(), 2); io().print(',');
  io().println(hz, 1);
}
