#!/usr/bin/env python3
"""Build the orb's voice: phrases.tsv -> TTS wavs -> raw clips -> LittleFS image.

The vocabulary lives in voice/phrases.tsv. Every clip's `id` there is the number
the firmware plays ("A <id>") and the file it opens (/v/NN.raw), so ids are
explicit in that file and must never be renumbered -- append, never insert.

    tts    render any missing wavs with the macOS `say` voice
    build  normalise wavs -> voice/fs/v/NN.raw, manifest, app clips.json
    image  pack voice/fs into a LittleFS image
    flash  write the image to the orb (stop bridge.py first)
    all    tts + build + image

Only `build` is required: point voice/wav/{slug}.wav at whatever TTS engine you
like and skip `tts` entirely. `say` is there so the whole chain is testable
before the real voice exists.
"""

import argparse
import array
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PHRASES = os.path.join(ROOT, "voice", "phrases.tsv")
WAV_DIR = os.path.join(ROOT, "voice", "wav")
FS_DIR = os.path.join(ROOT, "voice", "fs")
RAW_DIR = os.path.join(FS_DIR, "v")
IMAGE = os.path.join(ROOT, "voice", "littlefs.bin")
CLIPS_JSON = os.path.join(ROOT, "app", "src", "orb", "clips.json")

# Must match orb/config.h VOICE_SAMPLE_RATE and orb/partitions.csv.
RATE = 16000
FS_OFFSET = "0x340000"
FS_SIZE = 4915200

# -b is the flash sector, -p is CONFIG_LITTLEFS_PAGE_SIZE from the device's own
# sdkconfig. Neither is folklore; both come off the build we flash.
BLOCK, PAGE = 4096, 256

TOOLS = os.path.expanduser("~/Library/Arduino15/packages/esp32/tools")
MKLITTLEFS = os.path.join(TOOLS, "mklittlefs", "4.0.2-db0513a", "mklittlefs")
ESPTOOL = os.path.join(TOOLS, "esptool_py", "5.1.0", "esptool")

FADE = int(RATE * 0.005)      # 5 ms, per HARDWARE.md -- the amp clicks on a step
PEAK = 0.89                   # leaves headroom; the amp is already at +12 dB
TRIM_FLOOR = 0.02             # TTS pads both ends with near-silence


def read_phrases():
    rows = []
    with open(PHRASES) as f:
        for line in f:
            line = line.rstrip("\n")
            if not line or line.startswith("#") or line.startswith("id\t"):
                continue
            cid, slug, bank, key, text = line.split("\t")
            rows.append(dict(id=int(cid), slug=slug, bank=bank, key=key, text=text))
    ids = [r["id"] for r in rows]
    if len(set(ids)) != len(ids):
        sys.exit("phrases.tsv: duplicate id")
    slugs = [r["slug"] for r in rows]
    if len(set(slugs)) != len(slugs):
        sys.exit("phrases.tsv: duplicate slug")
    if max(ids) > 99:
        sys.exit("phrases.tsv: ids must stay under 100 (/v/NN.raw is fixed width)")
    return rows


def need(tool, hint):
    if not (os.path.exists(tool) or shutil.which(tool)):
        sys.exit(f"missing {tool}\n  {hint}")


def cmd_tts(rows, args):
    need("ffmpeg", "brew install ffmpeg")
    os.makedirs(WAV_DIR, exist_ok=True)
    made = 0
    for r in rows:
        out = os.path.join(WAV_DIR, r["slug"] + ".wav")
        if os.path.exists(out) and not args.force:
            continue
        aiff = out + ".aiff"
        subprocess.run(["say", "-v", args.voice, "-r", str(args.words_per_min),
                        "-o", aiff, r["text"]], check=True)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", aiff,
                        "-ar", str(RATE), "-ac", "1", "-c:a", "pcm_s16le", out],
                       check=True)
        os.remove(aiff)
        made += 1
    print(f"tts:   {made} rendered, {len(rows) - made} already present"
          f"  (voice={args.voice})")


def load_samples(path):
    """Any wav -> mono 16 kHz int16, via ffmpeg so the input format is free."""
    raw = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", path, "-ar", str(RATE),
         "-ac", "1", "-c:a", "pcm_s16le", "-f", "s16le", "-"],
        check=True, stdout=subprocess.PIPE).stdout
    a = array.array("h")
    a.frombytes(raw)
    if sys.byteorder == "big":
        a.byteswap()
    return a


def process(a):
    """DC-remove, trim, peak-normalise, 5 ms fades. Done here rather than in the
    firmware because it is free at build time and exact."""
    n = len(a)
    if n == 0:
        return a

    dc = sum(a) / n
    a = array.array("h", (max(-32768, min(32767, int(s - dc))) for s in a))

    peak = max((abs(s) for s in a), default=0)
    if peak == 0:
        return array.array("h")

    # Trim the near-silence TTS pads onto both ends, but keep a little room so
    # a plosive onset is not clipped off.
    thr = peak * TRIM_FLOOR
    first, last = 0, len(a) - 1
    while first < last and abs(a[first]) < thr:
        first += 1
    while last > first and abs(a[last]) < thr:
        last -= 1
    pad = int(RATE * 0.01)
    first = max(0, first - pad)
    last = min(len(a) - 1, last + pad)
    a = a[first:last + 1]
    if not a:
        return array.array("h")

    g = (PEAK * 32767.0) / peak
    a = array.array("h", (max(-32768, min(32767, int(s * g))) for s in a))

    f = min(FADE, len(a) // 2)
    for i in range(f):
        k = i / f
        a[i] = int(a[i] * k)
        a[len(a) - 1 - i] = int(a[len(a) - 1 - i] * k)
    return a


def cmd_build(rows, args):
    need("ffmpeg", "brew install ffmpeg")
    os.makedirs(RAW_DIR, exist_ok=True)
    for stale in os.listdir(RAW_DIR):
        os.remove(os.path.join(RAW_DIR, stale))

    clips, manifest, missing, total = {}, [], [], 0
    for r in rows:
        wav = os.path.join(WAV_DIR, r["slug"] + ".wav")
        if not os.path.exists(wav):
            missing.append(r["slug"])
            continue
        a = process(load_samples(wav))
        if not a:
            missing.append(r["slug"] + " (silent)")
            continue

        data = a.tobytes()
        with open(os.path.join(RAW_DIR, "%02d.raw" % r["id"]), "wb") as f:
            f.write(data)
        total += len(data)

        ms = int(round(1000 * len(a) / RATE))
        clips[r["slug"]] = dict(id=r["id"], ms=ms, bank=r["bank"], key=r["key"],
                                text=r["text"])
        manifest.append(f"{r['id']:02d}\t{r['slug']}\t{len(a)}\t{ms}ms\t{r['text']}")

    # Goes inside the image: when the app and the firmware disagree about what
    # clip 07 is, you read it off the device instead of guessing.
    with open(os.path.join(FS_DIR, "manifest.txt"), "w") as f:
        f.write("\n".join(manifest) + "\n")

    # JSON, not .js -- Vite imports it natively, and a generated module under
    # src/ is indistinguishable from hand-written code six weeks from now.
    os.makedirs(os.path.dirname(CLIPS_JSON), exist_ok=True)
    with open(CLIPS_JSON, "w") as f:
        json.dump(dict(rate=RATE, clips=clips), f, indent=2, sort_keys=True)
        f.write("\n")

    secs = total / (2.0 * RATE)
    print(f"build: {len(clips)} clips, {total/1024:.0f} KB, {secs:.1f}s audio")
    print(f"       {100.0*total/FS_SIZE:.1f}% of the {FS_SIZE/1048576:.2f} MB partition")
    print(f"       -> {os.path.relpath(CLIPS_JSON, ROOT)}")
    if missing:
        print(f"       {len(missing)} MISSING: {', '.join(missing[:6])}"
              + (" ..." if len(missing) > 6 else ""))
    if total > FS_SIZE * 0.9:
        print("       WARNING: near the partition ceiling")


def cmd_image(rows, args):
    need(MKLITTLEFS, "ships with esp32 core 3.3.1")
    subprocess.run([MKLITTLEFS, "-c", FS_DIR, "-b", str(BLOCK), "-p", str(PAGE),
                    "-s", str(FS_SIZE), IMAGE], check=True)
    listing = subprocess.run([MKLITTLEFS, "-l", IMAGE], check=True,
                             stdout=subprocess.PIPE).stdout.decode()
    n = len([l for l in listing.splitlines() if ".raw" in l])
    print(f"image: {os.path.relpath(IMAGE, ROOT)}  {os.path.getsize(IMAGE)} bytes, "
          f"{n} clips verified")


def cmd_flash(rows, args):
    if not args.port:
        sys.exit("flash needs --port (see: arduino-cli board list)")
    need(ESPTOOL, "ships with esp32 core 3.3.1")
    # --port is a GLOBAL option and must precede the subcommand: at the
    # subcommand level esptool 5 reads -p as --no-progress.
    subprocess.run([ESPTOOL, "--chip", "esp32s3", "--port", args.port,
                    "--baud", "921600", "--before", "default-reset",
                    "--after", "hard-reset", "write-flash", FS_OFFSET, IMAGE],
                   check=True)
    print("flash: done -- clips survive a normal `arduino-cli compile --upload`")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", choices=["tts", "build", "image", "flash", "all"])
    ap.add_argument("--port", help="serial port, for flash")
    ap.add_argument("--voice", default="Samantha", help="macOS `say` voice")
    ap.add_argument("--words-per-min", type=int, default=175)
    ap.add_argument("--force", action="store_true", help="re-render existing wavs")
    args = ap.parse_args()

    rows = read_phrases()
    steps = ["tts", "build", "image"] if args.step == "all" else [args.step]
    for s in steps:
        dict(tts=cmd_tts, build=cmd_build, image=cmd_image, flash=cmd_flash)[s](rows, args)


if __name__ == "__main__":
    main()
