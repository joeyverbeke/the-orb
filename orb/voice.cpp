#include "voice.h"
#include "config.h"
#include "io.h"

#include <Arduino.h>
#include <ESP_I2S.h>
#include <LittleFS.h>

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

static I2SClass i2s;

static bool ready = false;
static bool fs_ok = false;

// Set by the console (core 1), read by the task (core 0). A single word, so
// the read is atomic; the sequence number is what actually carries the edge.
static volatile int      want_clip = -1;
static volatile uint32_t want_seq  = 0;
static volatile int      now_clip  = -1;   // what the task is actually sounding

// Gain as Q15. A bare float multiply into int16 wraps above 1.0, and a wrap is
// a full-scale click.
static volatile int32_t gain_q15 = (int32_t)(0.6f * 32768.0f);

// Reported by voice_tick on the loop side. The task never prints.
static volatile int last_reported = -2;

static const uint32_t SAMPLE_RATE = VOICE_SAMPLE_RATE;
static const size_t   CHUNK       = 512;          // samples, 32 ms at 16 kHz
static const size_t   FADE        = 80;           // samples, 5 ms

// Static, not stack-resident -- the task's stack is sized for LittleFS's read
// path, not for a kilobyte of audio.
static int16_t buf[CHUNK];
static int16_t silence[CHUNK];

static inline int16_t apply_gain(int16_t s) {
  int32_t v = ((int32_t)s * gain_q15) >> 15;
  if (v >  32767) v =  32767;
  if (v < -32768) v = -32768;
  return (int16_t)v;
}

// A clip cut by voice_stop can land anywhere in a waveform, so the tail has to
// be ramped here. The clips' own edges are faded at build time.
static void fade_out(int16_t *p, size_t n) {
  size_t f = n < FADE ? n : FADE;
  size_t start = n - f;
  for (size_t i = 0; i < f; i++) {
    p[start + i] = (int16_t)((int32_t)p[start + i] * (int32_t)(f - i) / (int32_t)f);
  }
}

static void voice_task(void *) {
  File f;
  uint32_t seen_seq = 0;
  bool playing = false;

  for (;;) {
    // A new request preempts whatever is sounding.
    uint32_t seq = want_seq;
    if (seq != seen_seq) {
      seen_seq = seq;
      int n = want_clip;

      if (playing) {
        // Ramp the DAC down before the cut, or the step clicks through the amp.
        memset(buf, 0, sizeof(buf));
        i2s.write((uint8_t *)buf, FADE * sizeof(int16_t));
        f.close();
        playing = false;
      }

      if (n >= 0 && fs_ok) {
        char path[24];
        snprintf(path, sizeof(path), "/v/%02d.raw", n);
        f = LittleFS.open(path, "r");
        if (f) {
          playing  = true;
          now_clip = n;
        } else {
          now_clip = -1;
        }
      } else {
        now_clip = -1;
      }
    }

    if (playing) {
      size_t got = f.read((uint8_t *)buf, sizeof(buf));
      if (got == 0) {
        f.close();
        playing  = false;
        now_clip = -1;
      } else {
        size_t n = got / sizeof(int16_t);
        for (size_t i = 0; i < n; i++) buf[i] = apply_gain(buf[i]);
        // A short final read is the end of the clip; ramp it rather than
        // trusting the file to end on a zero crossing.
        if (got < sizeof(buf)) fade_out(buf, n);
        i2s.write((uint8_t *)buf, n * sizeof(int16_t));
      }
    } else {
      // Blocks on DMA, which is exactly the pacing we want -- this is the
      // task's idle delay, not what keeps the amp from popping.
      i2s.write((uint8_t *)silence, sizeof(silence));
    }
  }
}

bool voice_begin() {
  memset(silence, 0, sizeof(silence));

  fs_ok = LittleFS.begin(false);

  i2s.setPins(PIN_I2S_BCLK, PIN_I2S_LRCLK, PIN_I2S_DIN);
  // slot_mask left at -1 on purpose: the Philips mono default is
  // I2S_STD_SLOT_LEFT, and the MAX98357A with SD tied to 3V3 selects Left.
  // These already agree; an explicit mask is where silence comes from.
  if (!i2s.begin(I2S_MODE_STD, SAMPLE_RATE, I2S_DATA_BIT_WIDTH_16BIT,
                 I2S_SLOT_MODE_MONO)) {
    return false;
  }
  ready = true;

  // Core 0 -- loopTask is pinned to core 1 (CONFIG_ARDUINO_RUNNING_CORE=1), so
  // a CDC stall there cannot underrun this. Priority above loopTask's 1, well
  // clear of the timer and IPC tasks. Stack is bytes, not words, on ESP-IDF.
  xTaskCreatePinnedToCore(voice_task, "voice", 6144, nullptr, 3, nullptr, 0);
  return true;
}

void voice_play(int n) {
  want_clip = n;
  want_seq  = want_seq + 1;
}

void voice_stop() { voice_play(-1); }

void voice_set_gain(float g) {
  if (g < 0.0f) g = 0.0f;
  if (g > 1.0f) g = 1.0f;
  gain_q15 = (int32_t)(g * 32768.0f);
}

float voice_gain() { return (float)gain_q15 / 32768.0f; }

void voice_tick() {
  int c = now_clip;
  if (c != last_reported) {
    last_reported = c;
    io().print(F("# voice_clip=")); io().println(c);
  }
}

bool voice_ready() { return ready; }
bool voice_fs()    { return fs_ok; }
int  voice_clip()  { return now_clip; }
