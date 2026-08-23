# The Orb

A rig for finding out what rotation should feel like in the hand.

Hardware, wiring, and measured sensor characteristics: [HARDWARE.md](HARDWARE.md).
Original behaviour spec: [module-01-rotation-to-haptic.md](module-01-rotation-to-haptic.md).

Actuator is an **Adafruit 1201 ERM coin motor** on a DRV2605L, driven from 3V3
(its rated band is 2.5–3.8 V).

---

## Running it

Two processes. The bridge owns the serial port; Vite serves the pages. Keeping
them apart means the UI can hot-reload all day without dropping the device, and
reflashing only needs the bridge stopped.

```bash
tools/.venv/bin/python tools/bridge.py
```

```bash
cd app && npm run dev
```

Then open **http://localhost:5173**.

Reflashing — **stop the bridge first**, or the held port makes uploads fail with
errors that look like a dead board:

```bash
arduino-cli compile --upload -p /dev/cu.usbmodemXXXX -b esp32:esp32:XIAO_ESP32S3:PSRAM=opi orb
```

Setup, once. Node 22.12+ is required by Vite 8; `app/.nvmrc` pins it.

```bash
python3 -m venv tools/.venv && tools/.venv/bin/pip install pyserial matplotlib websockets
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
| `link no orb` | bridge is fine, nothing plugged in (or it was unplugged) |
| `link up` | frames are flowing |

The bridge **reconnects on its own**: it can be started before the orb is
plugged in, survives unplugging and reflashing, and re-detects the port — which
changes between replugs. On every connection it re-sends `c 1`, because the orb
boots with CSV streaming off; an open-but-silent port is otherwise
indistinguishable from a dead one.

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

Re-levelling would normally make the picture jump, since surface features are
fixed to the body and the body has just been redefined. `motion.state.field`
counter-rotates by exactly the amount the body moved — look every object-space
field up through it (`uField.mul(dir)`) and the image is identical across the
change, which is what makes it safe to do silently. Anything derived in body
space and used against those lookups, such as a ripple axis, has to be carried
into the same space or it drifts off.

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
| [telemetry.cpp](orb/telemetry.cpp) | CSV out + loop rate |
| [console.cpp](orb/console.cpp) | terse command protocol |

Host side: [transport.py](tools/transport.py) (swap serial for WiFi here, and
nothing above it changes), [bridge.py](tools/bridge.py) (serial ↔ WebSocket),
and [record.py](tools/record.py) / [plot.py](tools/plot.py) for offline capture.

The firmware speaks compact CSV and one-letter commands; the bridge does all
the JSON and naming, so the ESP32 never spends cycles on presentation.

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
