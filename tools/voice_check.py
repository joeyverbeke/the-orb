#!/usr/bin/env python3
"""Is the voice inaudible, or is the motor drowning/browning it out?

Plays one line four ways and prints what you should be hearing as it goes.
Runs through the bridge, so leave bridge.py up and the orb plugged in.

    tools/.venv/bin/python tools/voice_check.py
"""
import asyncio, json, sys
import websockets

CLIP = 4          # "Bring the right side round toward you." -- 1786 ms, the longest
LEN = 2.6


async def main():
    async with websockets.connect("ws://localhost:8765") as ws:
        clip_state = {}

        async def watch():
            async for raw in ws:
                try:
                    m = json.loads(raw)
                except Exception:
                    continue
                if m.get("type") == "config":
                    c = m.get("config", {})
                    if "voice_clip" in c:
                        clip_state["v"] = c["voice_clip"]

        task = asyncio.create_task(watch())

        async def cmd(c):
            await ws.send(json.dumps({"type": "cmd", "cmd": c}))

        async def motor(on, level=0.6):
            """The app drives the motor at frame rate; a single command times out
            after 500 ms on the device, so holding it means repeating it."""
            if not on:
                await cmd("v -1")
                return None
            async def hold():
                try:
                    while True:
                        await cmd(f"v {level:.3f}")
                        await asyncio.sleep(0.016)
                except asyncio.CancelledError:
                    await cmd("v -1")
            return asyncio.create_task(hold())

        async def trial(label, gain, motor_on):
            print(f"\n>>> {label}")
            print("    listen now...", flush=True)
            await cmd(f"U {gain:.3f}")
            h = await motor(motor_on)
            await asyncio.sleep(0.35)
            await cmd(f"A {CLIP}")
            await asyncio.sleep(LEN)
            if h:
                h.cancel()
                await asyncio.sleep(0.1)
            print(f"    device reported clip={clip_state.get('v')}")

        print("Four plays of the same line. Note which ones you can hear.")
        await asyncio.sleep(1.0)
        await trial("1. volume 0.6, motor OFF   (this is what the app uses)", 0.6, False)
        await asyncio.sleep(1.2)
        await trial("2. volume 0.6, motor ON    (this is your actual session)", 0.6, True)
        await asyncio.sleep(1.2)
        await trial("3. volume 1.0, motor OFF", 1.0, False)
        await asyncio.sleep(1.2)
        await trial("4. volume 1.0, motor ON", 1.0, True)

        await cmd("U 0.600")
        await cmd("v -1")
        task.cancel()
        print("\nWhich numbers did you hear?")


asyncio.run(main())
