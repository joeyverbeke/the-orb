#pragma once

#include <stdint.h>

// The third instruction. A spoken line out of the MAX98357A, arguing with the
// screen and the motor.
//
// Clips live on LittleFS as headerless raw int16 mono 16 kHz at /v/NN.raw,
// built by tools/voice_build.py. Playback runs on its own FreeRTOS task pinned
// to core 0, and that is not decoration: I2SClass::write loops on
// i2s_channel_write with Stream::_timeout, which defaults to 1000 ms, and
// loop() already blocks -- HWCDC has a 100 ms tx timeout and telemetry_frame
// makes ~24 Serial.print calls per row. The I2S DMA cushion is 6 x 240 frames,
// 90 ms at 16 kHz. One CDC stall on core 1 would underrun it.
//
// The amp pops if the I2S clock stops, so begin() is called once and end()
// never is. That -- not writing silence -- is what keeps it quiet; the driver
// is configured with auto_clear, so an underrun emits real zeros rather than
// repeating the last descriptor.
//
// LittleFS *reads* are safe alongside the 100 Hz I2C loop. LittleFS *writes*
// are not: a flash erase suspends the cache on both cores for tens of
// milliseconds, which would underrun the audio and stall the IMU at the same
// time. Nothing here ever writes. Keep it that way.

// Mounts LittleFS, opens I2S, starts the playback task. Safe to call with no
// filesystem flashed -- voice_fs() then reports 0 and playback is a no-op.
bool voice_begin();

// Play clip n, from the top. Preempts anything already sounding (5 ms fade),
// because a firmware that silently ignored this would leave the host's idea of
// what is playing permanently wrong. n < 0 stops.
void voice_play(int n);
void voice_stop();

// 0..1, applied as Q15 with saturation.
void voice_set_gain(float g);
float voice_gain();

// Call every loop. Prints clip start/end as '# voice_clip=' so the host gets a
// real completion event instead of guessing from durations. Nothing in the
// task may print: a CSV row is 24 separate locked Serial calls and a print
// from another task would land inside one.
void voice_tick();

bool voice_ready();     // I2S up
bool voice_fs();        // LittleFS mounted
int  voice_clip();      // clip currently sounding, -1 for none
