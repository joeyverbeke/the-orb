# The Orb

A rig for finding out what rotation should feel like in the hand.

Hardware, wiring, and measured sensor characteristics: [HARDWARE.md](HARDWARE.md).
Original behaviour spec: [module-01-rotation-to-haptic.md](module-01-rotation-to-haptic.md).

Actuator is an **Adafruit 1201 ERM coin motor** on a DRV2605L, driven from 3V3
(its rated band is 2.5–3.8 V).

---

## Running it

Two processes. The bridge owns the device link; Vite serves the pages. Keeping
them apart means the UI can hot-reload all day without dropping the device.

```bash
tools/.venv/bin/python tools/bridge.py
```

That reaches the orb **over WiFi**, at `orb.local`. `--host <ip>` if the name
does not resolve, `--serial` for the USB path — see [Wireless](#wireless).

```bash
cd app && npm run dev
```

Then open **http://localhost:5173**.

Reflashing. On the WiFi path the bridge holds no serial port, so it can be left
running — it reconnects when the orb comes back. On `--serial`, **stop it
first**, or the held port makes uploads fail with errors that look like a dead
board:

```bash
arduino-cli compile --upload -p /dev/cu.usbmodemXXXX -b esp32:esp32:XIAO_ESP32S3:PSRAM=opi orb
```

Setup, once. Node 22.12+ is required by Vite 8; `app/.nvmrc` pins it.

```bash
python3 -m venv tools/.venv && tools/.venv/bin/pip install pyserial matplotlib websockets
```

The firmware needs network credentials, which are not in the repo:

```bash
cp orb/secrets_example.h orb/secrets.h
```

```bash
cd app && npm install
```

## When the page stops responding

The topbar reports three states, not two, because a healthy bridge with no orb
plugged into it is the confusing case:

| shown | meaning |
|---|---|
| `link down` | `bridge.py` is not running |
| `link no orb` | bridge is fine, the orb is not answering (off, or off the network) |
| `link up` | frames are flowing |

The bridge **reconnects on its own**: it can be started before the orb is, and
it survives the orb rebooting, being reflashed, or wandering off the network.
On every connection it re-sends `c 1`, because the orb boots with CSV streaming
off; an open-but-silent link is otherwise indistinguishable from a dead one.

## Wireless

The orb is a station on an ordinary 2.4 GHz network and **listens** on TCP 3333;
the bridge dials in. That way round because the laptop's address changes with
every network it joins and the orb's name does not — `MDNS` publishes it as
`orb.local`. It also prints its IP over USB at boot, which is the answer when
mDNS is being unhelpful:

```bash
tools/.venv/bin/python tools/bridge.py --host 192.168.1.42
```

Credentials live in `orb/secrets.h`, which is not tracked. Changing networks
means editing it and reflashing — there is no OTA slot, it was spent on voice
clips.

**The line protocol is byte-identical to the serial one.** Same CSV, same
one-letter commands, and `bridge.py --serial` still works, which is what makes
USB a real fallback at a show rather than a second thing to maintain.

Three things make it stable rather than merely working:

- **Modem sleep is off.** An ESP32 station parks its radio between beacons by
  default, which adds up to ~100 ms to anything arriving from the host. At
  100 Hz that is the difference between a link you can feel through and one you
  cannot.
- **Writes never block.** `NetworkClient::write` retries around a one-second
  `select()`, ten times — so a host that stops reading can park `loop()` for ten
  seconds and the orb goes dead in the hand. `net_write` does the `send` itself
  with `MSG_DONTWAIT`. **Dropping a frame is always cheaper than dropping the
  loop**, and the interpolator in `motion.js` is built to absorb exactly that.
- **But not every line may be dropped**, which is the part that bit. The first
  thing a host does on connecting is ask for the settings block — ~1.4 kB of
  small lines into a socket whose window has not opened yet. Sending those
  non-blocking loses most of them: measured, **20 of 56 arrived, and the CSV
  header was among the missing**, so the bridge sat there discarding every row
  that followed. They go through a 4 kB outbound queue in `net.cpp` instead,
  drained as the link allows. Telemetry only joins that queue when it is nearly
  empty — the queue is for bursts, not for buffering the stream, and a row that
  would arrive stale is better skipped.
- **A row is one packet.** A CSV row is ~24 separate `print` calls, which with
  Nagle disabled would be 24 packets at 100 Hz. `io()` buffers to the newline.
  The USB path gets the same fix for free — it was 24 separately-locked writes
  into a stream with a 100 ms tx timeout.

**What it costs.** Measured on an iPhone hotspot, orb on the desk, against the
same six seconds over USB:

| | serial | WiFi |
|---|---|---|
| device `loop_hz` | 100.0 (min 99.9) | 97.9 (min 93.8) |
| rows delivered | 100.0 /s | 94.5 /s of device clock |
| inter-frame gap | — | median 10 ms, p95 13 ms, **max 91 ms** |

So about 2% off the loop rate and about 5% of rows skipped, split roughly evenly
between the slower loop and the queue guard. The device's own sampling is still
rock steady at 10 ms; everything above is introduced by the radio.

That 91 ms worst case is the number that matters for how it looks. It is the
biggest hole the interpolator has to bridge, so if motion goes steppy raise
**Motion delay** past it and watch `buffered (ms)` — that is what the control is
for, and it needs more headroom here than it did on USB.

mDNS is started on a **retry**, not once when the network comes up: `mdns_init`
fails if the interface is not quite ready, and it did — first flash came up
reachable only by DHCP address. Whether `orb.local` resolves is worth checking
directly, since a DHCP-registered hostname can answer for it and hide the
failure: `dns-sd -B _orb._tcp` should list an instance named `orb`.

A dropped socket **silences the orb**: streaming stops and any host-driven hold
is released. The serial path gets `c 0` from the bridge on its way out; a socket
that dies has no such chance, so the device has to enforce it. Only one host at
a time, and a newcomer evicts the incumbent — a laptop that slept leaves a
half-open socket that looks perfectly alive from the orb's end.

## The app

Vanilla JS + Vite + three.js `WebGPURenderer` + TSL. Multi-page rather than a
router: each experiment is its own document, so one blowing up the GPU or
failing to compile cannot take the others with it.

```
app/
  index.html              the index — cards, auto-discovered
  src/orb/link.js         the WebSocket link: frames, config, commands
  src/orb/frame.js        sensor frame -> three.js frame
  src/orb/motion.js       timestamped buffer + render-rate interpolation
  src/lib/stage.js        renderer + scene + camera + resize + loop
  src/lib/hud.js          shared topbar, fatal-error panel
  src/lib/panel.js        space-to-open tuning panel
  experiments/<name>/     index.html · main.js · meta.js
```

**Adding an experiment**: make a folder under `app/experiments/` with those
three files. `vite.config.js` finds the page and the index finds the `meta.js` —
there is no registry to keep in sync.

**Forking one**: copy the folder and pass `inheritFrom: '<other-key>'` to
`createPanel`. The fork starts from wherever the original was tuned to, then
keeps its own settings once anything in it is touched — so a fork does not begin
by re-deciding questions that were already settled. Experiments are copied
rather than sharing a base module: they are meant to diverge, and sharing would
mean a change to one silently altering the others.

`stage.js` measures the *container*, never the canvas: `setSize` writes the
canvas's width/height attributes, which are also its intrinsic size, so a canvas
laid out from its own content grows on every resize until it is many times the
window. Wrap the canvas in a positioned `.stage` element, as the existing
experiment does.

**Point clouds**. WebGPU has no sized point primitive — its `PointList`
topology draws one pixel, with no size, softness or falloff — and `Points` is
not exported from `three/webgpu` for that reason. A cloud that needs to glow has
to be billboarded quads: four vertices per point offset in *view* space, with
`material.vertexNode` returning clip space directly. See
[data-body/cloud.js](app/experiments/data-body/cloud.js).

Its lattice is **shuffled at build time**. A Fibonacci lattice walks pole to
pole, so drawing the first N of it in lattice order gives a polar cap rather
than a sphere; shuffling makes any prefix an even sample, which is what lets a
point-count control work by just moving the draw range.

**Smooth motion**. Reading `orb.latest` each render gives a signal that steps
whenever a batch happens to arrive, which looks like stutter at any frame rate.
`createMotion()` buffers frames against their *device* timestamps and runs the
render clock a little behind live, so every rendered frame is interpolated
between two real samples. `Motion delay` on the panel trades latency against
tolerance for late frames; the `buffered (ms)` readout shows the headroom the
interpolator actually has — if it sits at 0 the delay is too low and it is
clamping to the newest sample instead of interpolating.

Note that the device's own sampling is rock steady at 10 ms; jitter is entirely
introduced between the serial port and the browser. The serial reader takes
whatever is buffered rather than waiting for a fixed-size chunk — asking for
4096 bytes meant waiting ~250 ms for them to accumulate, and everything
downstream stuttered.

Both **angular velocity and linear acceleration** are interpolated, so an
experiment can react to being turned, to being carried, or to both. They are
kept separate deliberately: deg/s and m/s² have no honest conversion, and fusing
them into one number needs an arbitrary radius to relate them.

**Motion response is global.** `createResponse()` turns turn rate into a 0..1
intensity, and every experiment uses it rather than rolling its own — that is a
property of the orb and the hand holding it, not of any one visual. It is tuned
in the **Motion response** tool and stored once, under `panel:orb-motion`.

**It re-levels itself.** People set the orb down in whatever orientation suits
them, and the sensor's own zero has nothing to do with how it sits in a hand, so
the pose it is left in becomes the new neutral and attitude is reported relative
to that. This is why an experiment looks upright when picked up while the raw
sensor attitude does not.

**And for a sphere it is the wrong idea.** Re-levelling was justified by the
sensor's own zero being arbitrary — but the pose a *ball* is set down in is
equally arbitrary, and unlike the sensor's zero it changes every time. It trades
a fixed arbitrary frame for a moving one, and throws away the only honest
reference there is. Attitude changes by `home⁻¹ · R · home`, so a room-frame
gesture is conjugated by whatever pose was last levelled in. Set the orb down
turned around and the horizontal axes invert — the same wrist movement, the
opposite direction on screen:

```
                          fixed gravity frame      re-levelled frame
same wrist tilt, held...
  level                        [ 1, 0, 0 ]           [  1,     0,     0    ]
  yaw 180                      [ 1, 0, 0 ]           [ -1,     0,     0    ]
  rolled 90                    [ 1, 0, 0 ]           [  0,    -1,     0    ]
  arbitrary                    [ 1, 0, 0 ]           [ -0.34, -0.92, -0.19 ]
```

Pass `relevel: false` and none of it happens: the BNO085's frame is already
gravity-referenced, so up stays up and the mapping is identical from every pose.
Setting the orb down changes nothing. Counterpull runs this way, which is also
why it needs no `field` compensation — with `L = A⁻¹` a feature turns by exactly
the wrist rotation, the same as anything placed as `attitude * bodyVector`, so
the conjugation problem below cannot arise at all.

The one thing left over is which horizontal direction is "toward the
participant". No IMU can know that — it is a fact about the room, not the
device; even a working magnetometer gives magnetic north and still needs to be
told where the screen is. `motion.tareHeading()` declares it: yaw only, tilt
left to gravity, at a moment that carries intent. Never infer it from how the
ball came to rest — that is the bug above.

Re-levelling would normally make the picture jump, since surface features are
fixed to the body and the body has just been redefined. `motion.state.field`
counter-rotates by exactly the amount the body moved — look every object-space
field up through it (`uField.mul(dir)`) and the image is identical across the
change, which is what makes it safe to do silently. Anything derived in body
space and used against those lookups, such as a ripple axis, has to be carried
into the same space or it drifts off.

That lookup is a *conjugation*, and it is worth knowing what that costs. A
feature painted at field coordinate `p` lands on screen at `F⁻¹ A p`, so a turn
of the wrist `d` moves it by `F⁻¹ d F` — the same angle about a different axis,
and once `F` has absorbed a few re-levels that axis is tens of degrees out. On
its own this is invisible: noise rotating about a re-mapped axis is still noise.
Put something the participant can *aim* on the same sphere, though — placed the
honest way, as `attitude * bodyVector` — and the disagreement shows plainly: the
marker crawls across the cloud as the orb is turned, which reads as the marker
being broken when it is the only part that is right.

The fix is which side the compensation multiplies on. With `L = C⁻¹ A⁻¹` a
feature lands at `A C p` and moves by exactly `d`, the same as the marker, so the
two are welded together — and re-levelling stays invisible, because

```
C_new = A_new⁻¹ · A_old · C_old
```

is the unique `C` that leaves `L` unchanged across the switch. Counterpull
carries its own `C` for this reason; `motion.js` still hands out `field` for the
experiments built on it.

**Turning only.** Linear acceleration is still measured and interpolated, and an
experiment can read `motion.state.accel` directly, but nothing reacts to being
carried any more.

**Haptics come from the same curve.** With *Link to turning* on, the motor level
is the same shaped intensity the visuals use, scaled by *Strength at full turn*
— so a small turn is felt as little as it is seen. Off, each experiment falls
back to its own mapping (the data and stirred bodies use the ripple slosh, which
lingers after the gesture that caused it).

Its most important control is the **curve**. A linear mapping gives a small
knock a proportionate share of the range; an exponent above 1 keeps the bottom
quiet and saves the range for movement that was meant. At the default 1.8, the
gap between a 20 deg/s nudge and a 110 deg/s gesture widens from 7× to 37×.

The tool passes its own panel controls into `createResponse()` so the curve
reacts as sliders drag; experiments pass nothing and read the stored values.
Same maths either way, so what gets tuned is exactly what ships.

**Tuning panel**. `createPanel()` gives an experiment a panel that opens and
closes on **space**. `panel.slider()` returns a **TSL uniform**, so one value
feeds a shader *and* reads as `.value` from CPU code — there is no per-frame
plumbing to keep in sync and no way for the panel and the shader to disagree.
Values persist per experiment in `localStorage`, because tuning happens across
reloads. **copy settings** / **paste settings** move a whole tuning in and out
as JSON — for pasting into source once a setting has won, for moving between
machines, and as the only route back from a session that went wrong. **reset**
is two-step, because one stray click should not be able to discard an evening's
tuning.

**Renaming a control loses its tuning unless you say otherwise.** A control's
storage key defaults to a slug of its *label*, so re-wording a label orphans the
saved value and the control silently reverts to the code default. Two things
guard against it:

- Pass an explicit **`key`** so a control's identity does not depend on what it
  is called, and **`from: '<old-key>'`** to adopt a value it used to be stored
  under. Any control whose label might change should have a `key`.
- Saving **merges into** what is already stored rather than replacing it, so a
  value belonging to a control that is not currently mounted is preserved rather
  than dropped on the next save — which is what makes `from` able to recover it
  later.

Storage is per-origin: `localhost:5173` and `127.0.0.1:5173` keep separate
tunings, so stick to one of them.

Anything that shapes how something *feels* belongs on the panel rather than in a
constant — none of it is decidable except by turning the orb in your hand.

**Haptics from an experiment**: `orb.setHaptic(0..1)` takes the motor over from
the firmware's mode pipeline; `orb.releaseHaptic()` hands it back. It sends `v`,
not `H` — same effect, but `H` echoes the whole settings block and would flood
the serial link at frame rate.

A host-driven hold **times out on the device** after 500 ms of silence
(`HOLD_TIMEOUT_MS` in [console.cpp](orb/console.cpp)); the JS keepalive refreshes
it every 200 ms. This is not belt-and-braces — the browser's `pagehide` release
was measured *not* to reach the wire, because the socket is torn down first.
Without the device-side timeout, closing a tab mid-drive leaves the orb pinned
at whatever it was last told, with its own modes bypassed. A hold set by hand
with `H` is deliberately sticky and is never timed out.

**Only the visible page drives the motor.** Several experiment tabs left open
otherwise all write the motor at once and the last to speak wins, which reads as
the haptics being broken rather than as a tab fighting you from behind another
window. A page that goes hidden releases its hold. Two windows visible side by
side will still contend; `ORB_DEBUG=1 tools/.venv/bin/python tools/bridge.py`
logs every command written to the device, which is how to spot it.

**The voice follows the same rule**, and it is much easier to misread: a
backgrounded tab is silent, and silence from a speaker looks exactly like a
speaker that does not work. The tuning panel's **voice gate** readout says
which of the six gates is holding a line back, and names this one in capitals.
Put the counterpull tab in the foreground of its window — being in another
*application* is fine, being behind another *tab* is not.


---

## The pipeline

Deliberately staged, because *which stage is wrong* is the question the rig
exists to answer.

```
imu   ->   modes   ->   texture   ->   haptic
what       how          what           the
moved      much         character      motor
```

| file | does |
|---|---|
| [orb.ino](orb/orb.ino) | orchestration only, nothing blocking |
| [config.h](orb/config.h) | every tunable in one struct |
| [imu.cpp](orb/imu.cpp) | BNO085, bus recovery, reset handling, frames |
| [mapping.cpp](orb/mapping.cpp) | shared curve + smoothing primitives |
| [modes.cpp](orb/modes.cpp) | quantity × source |
| [presence.cpp](orb/presence.cpp) | is it in a hand? silences the motor when not |
| [texture.cpp](orb/texture.cpp) | pulse + grain, applied to every mode |
| [haptic.cpp](orb/haptic.cpp) | DRV2605L realtime, ERM floor, sweep |
| [voice.cpp](orb/voice.cpp) | MAX98357A over I2S, clips off LittleFS, on its own core |
| [telemetry.cpp](orb/telemetry.cpp) | CSV out + loop rate |
| [console.cpp](orb/console.cpp) | terse command protocol |
| [net.cpp](orb/net.cpp) | WiFi station, TCP server, non-blocking writes |
| [io.cpp](orb/io.cpp) | which link the words go to, one write per line |

Host side: [transport.py](tools/transport.py) (serial and WiFi, both in whole
text lines — nothing above it can tell which is in use),
[bridge.py](tools/bridge.py) (device ↔ WebSocket), and
[record.py](tools/record.py) / [plot.py](tools/plot.py) for offline capture over
USB.

The firmware speaks compact CSV and one-letter commands; the bridge does all
the JSON and naming, so the ESP32 never spends cycles on presentation.

The one thing that is not on the main loop is the voice. `loop()` already
blocks — USB CDC has a 100 ms tx timeout and a CSV row is ~24 separate writes —
and the I2S buffer is only 90 ms deep at 16 kHz, so audio fed from `loop()`
stutters whenever the host hiccups. `voice.cpp` runs a task pinned to core 0
instead; `loop()` only hands it a clip number and prints when one starts and
ends. Measured cost to the loop rate: none, 100.1 Hz with a clip sounding.

## The voice

`voice/phrases.tsv` is the whole vocabulary — one row per clip, with an
explicit `id` that is both the number the firmware plays (`A <id>`) and the
file it opens (`/v/NN.raw`). **Ids are never renumbered**: append, never
insert, or a flashed orb and a fresh app disagree about what every line means.

```bash
python3 tools/voice_build.py all                     # tts -> raws -> image
python3 tools/voice_build.py flash --port /dev/cu.usbmodemXXXX
```

`build` is the only required step: point `voice/wav/{slug}.wav` at whatever TTS
engine you like and skip `tts`, which exists so the chain is testable with the
macOS `say` voice before the real one is recorded. It writes
`app/src/orb/clips.json`, which the experiment imports, so the app and the
device are generated from one file and cannot drift apart in naming — only in
*version*, which is what `manifest.txt` inside the image is for.

Which way it tells you to turn is derived, not tabulated by hand, and the
derivation is written out in [voice.js](app/experiments/counterpull/voice.js).
The short summary: the rule is symmetric — *the limb nearest the target comes
toward you* — but the English is not, because the vertical has a natural verb
framed on the top ("tip it toward you") and the horizontal borrows front-face
framing, which inverts. Hence target-on-the-right → "rotate it left". The panel
carries flip toggles and a second, unambiguous phrasing set because which way a
listener *hears* "left" is a question about people, not geometry.

## Modes

Two independent choices, any combination of the nine.

**Quantity** — what about the rotation is read:

| | |
|---|---|
| **speed** | how fast it is turning right now; stop and it stops |
| **wind** | turning accumulates and bleeds away when you stop — rewards sustained winding |
| **dial** | how far it sits from a reference orientation — position, not effort |

**Source** — which axes it is read from:

| | |
|---|---|
| **1-axis** | the selected axis alone |
| **3-axis** | Y → strength, X → pulse rate, Z → grain |
| **any-direction** | magnitude across all three; direction doesn't matter |

Selecting **3-axis** switches the quantity away from speed (to wind) if it was
on speed. Three parameters driven by speed are untestable: all three are
transient and come from the same gesture, so you can never hold one while
varying another. Wind accumulates *per axis independently* — turning about X
adds to X alone — which is what makes the combination explorable. Dial can't
offer that; its axes are coupled through rotation composition. Picking speed
explicitly after selecting 3-axis is still honoured.

**Texture** applies to all of them. `pulse` at 1.0 is continuous; lower pulses
slower, as a raised cosine (the ERM can't produce a sharp edge anyway). `grain`
is sample-and-held amplitude noise at 14 Hz — fresh noise every frame would land
above what the mass can follow and just read as a weaker buzz.

**Hold** pins strength to a constant, bypassing the mode. Judging grain while
also having to rotate means judging two things at once; hold removes one.

## Presence — why not the gyro median

HARDWARE.md §4 separates hand from table by gyro median (0.78 vs 0.05 deg/s,
about fifteen times apart) and calls it the most useful measurement in that
project. It does not survive contact with a motor.

**Measured on this build:** a running ERM lifts the resting gyro median to
**0.42–0.60 deg/s**, straight through the 0.50 "held" threshold. Presence read
that way latches on the instant the motor starts and never clears — the motor
keeps itself alive. That is the feedback loop, and it is why dial mode buzzed
on the table forever.

So presence reads **net orientation displacement** over a 1.28 s window
instead. Motor vibration is jitter about a fixed attitude and averages to
nothing; a hand cannot hold an object without drifting it. Verified with the
motor at full on a resting surface: drift stays at **0.15–0.50°** against a
1.2° threshold, and the state stays *set down* at every motor level.

The risk runs the other way now — HARDWARE.md §5 records someone holding very
still reading as a putdown. `set-down °` and `set-down wait` are sliders for
exactly that. If it dies in the hand, lower the first or raise the second.

## Watch items

- **Brownout under haptics.** The 1201 pulls ~60 mA at 3 V plus inrush. Resets
  correlated with strong vibration rather than with code mean 100 µF across the
  DRV's VIN/GND.
- **The gyro reads *exactly* 0.000 at rest** — the BNO085 zeroes it, so a still
  orb produces no strength at all and there is nothing for texture to modulate.
  Use hold to test texture on the bench.
- **`drv_ready`** in the header: a silent motor is otherwise ambiguous, since an
  absent driver looks exactly like an intensity of zero.
- **CSV streaming boots off.** 100 rows/s into a USB CDC nobody drains can block
  `Serial.write` and stall the loop. The bridge turns it on and off again.

## Settled by hand

- `floor_rtp = 10` — 35 was far too high and was eating the bottom third of the
  range for nothing.
- `gamma = 1.0` — with the ERM floor already lifting the low end, an expansive
  curve on top of it made everything read as on-or-strong.

## Open

- Z as **grain** is a first guess. Pulse *sharpness* is the obvious alternative,
  but it goes inert whenever X sits at continuous, which grain does not.
- Whether presence correctly holds *on* while the orb is held very still. Only
  a hand can answer that.
