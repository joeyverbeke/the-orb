#!/usr/bin/env python3
"""The orb's device link: orb <-> browser, over WebSocket.

    tools/.venv/bin/python tools/bridge.py     # this, for the device
    cd app && npm run dev                      # and this, for the UI

It reaches the orb over WiFi by default and over USB serial with --serial.
Both carry the same lines, so nothing downstream of transport.py can tell the
difference.

This process owns the device link and nothing else; Vite serves the pages.
Keeping them separate means the UI can hot-reload all day without dropping the
device connection, and reflashing only requires stopping this one.

The firmware speaks compact CSV (fast to emit at 100 Hz on-device) and terse
one-letter commands. Everything human-facing -- JSON, names, units -- is done
here, so the ESP32 never spends cycles on presentation.
"""

from __future__ import annotations

import argparse
import asyncio
import functools
import json
import queue
import time

import websockets

from transport import SerialTransport, WifiTransport

WS_PORT = 8765

# Both loopback stacks, not just IPv4. On macOS "localhost" resolves to ::1
# first, so binding 127.0.0.1 alone gets the browser's first connection
# refused -- Python falls back to IPv4 and works, browsers do not reliably.
# Loopback only: this deliberately does not listen on the network.
WS_HOSTS = ["127.0.0.1", "::1"]

# The orb emits 100 frames/s. Rather than drop any -- peaks are exactly what
# you want to see -- they are batched and flushed at 50 Hz.
FLUSH_INTERVAL_S = 0.02


class Hub:
    def __init__(self, transport):
        self.transport = transport
        self.clients: set = set()
        self.columns: list[str] = []
        self.config: dict[str, str] = {}
        self.config_dirty = False
        self.pending: list[dict] = []
        self.device = None      # last device state broadcast to clients

    # --- inbound from the orb -------------------------------------------

    def ingest(self, line: str) -> None:
        if line.startswith("#"):
            body = line[1:].strip()
            if "=" in body:
                key, _, value = body.partition("=")
                self.config[key.strip()] = value.strip()
                self.config_dirty = True
            return

        fields = line.split(",")

        # The header re-appears every time streaming is re-enabled, which is
        # how the frontend learns the column set without hardcoding it.
        if fields[0] == "t_ms":
            self.columns = fields
            return

        if not self.columns or len(fields) != len(self.columns):
            return  # a row torn by a mid-line reconnect

        try:
            self.pending.append(
                {name: float(v) for name, v in zip(self.columns, fields)}
            )
        except ValueError:
            pass

    # --- outbound to browsers -------------------------------------------

    async def broadcast(self, payload: dict) -> None:
        if not self.clients:
            return
        msg = json.dumps(payload)
        dead = []
        for ws in self.clients:
            try:
                await ws.send(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    def status(self) -> dict:
        return {
            "type": "status",
            "device": self.transport.connected,
            "port": self.transport.port,
        }

    async def flush_loop(self) -> None:
        while True:
            await asyncio.sleep(FLUSH_INTERVAL_S)

            # A live socket says nothing about whether the orb is plugged in.
            # Without this the page reports a healthy link while receiving
            # nothing, which is indistinguishable from the orb sitting still.
            if self.device != self.transport.connected:
                self.device = self.transport.connected
                if not self.device:
                    self.columns = []       # a replug restarts the header
                await self.broadcast(self.status())
            if self.config_dirty:
                self.config_dirty = False
                await self.broadcast({"type": "config", "config": self.config})
            if self.pending:
                frames, self.pending = self.pending, []
                await self.broadcast({"type": "frames", "frames": frames})

    async def drain_device(self) -> None:
        """Move lines off the reader thread's queue without blocking the loop."""
        q = self.transport.lines()
        while True:
            drained = 0
            try:
                while drained < 2000:
                    self.ingest(q.get_nowait())
                    drained += 1
            except queue.Empty:
                pass
            await asyncio.sleep(0.005)


async def ws_handler(ws, hub: Hub) -> None:
    hub.clients.add(ws)
    await ws.send(json.dumps(hub.status()))
    # A browser arriving mid-session needs the current state, not the state at
    # boot -- so ask the orb to re-announce everything.
    hub.transport.send("p")
    hub.transport.send("c 1")
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("type") == "cmd" and isinstance(msg.get("cmd"), str):
                hub.transport.send(msg["cmd"])
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        hub.clients.discard(ws)



async def main_async(transport) -> None:
    hub = Hub(transport)

    # Runs every time a device appears, including after a replug. The orb boots
    # with CSV streaming off, so without this the port would be open and
    # silent -- which is exactly what a dead link looks like from the browser.
    def arm():
        transport.send("p")
        transport.send("c 1")

    transport.on_connect(arm)
    if transport.connected:
        arm()

    print("UI  -> http://localhost:5173   (cd app && npm run dev)", flush=True)
    print(f"ws  -> ws://localhost:{WS_PORT}", flush=True)

    handler = functools.partial(ws_handler, hub=hub)
    async with websockets.serve(handler, WS_HOSTS, WS_PORT):
        await asyncio.gather(hub.drain_device(), hub.flush_loop())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--serial", action="store_true",
                    help="reach the orb over USB instead of WiFi")
    ap.add_argument("--host", default="orb.local",
                    help="the orb's hostname or IP (WiFi); default orb.local")
    ap.add_argument("--port", help="serial port; autodetected if omitted")
    args = ap.parse_args()

    transport = SerialTransport(args.port) if args.serial else WifiTransport(args.host)
    transport.start()
    # The reader thread opens the port, so give it a moment before reporting an
    # absence that is really just a race with startup.
    for _ in range(20):
        if transport.connected:
            break
        time.sleep(0.05)
    if not transport.connected:
        where = "plugged in" if args.serial else f"reachable at {args.host}"
        print(f"no orb found yet — will connect when one is {where}", flush=True)

    try:
        asyncio.run(main_async(transport))
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        # Leaves the orb quiet and untethered rather than streaming into a
        # buffer nobody is draining.
        transport.stop()


if __name__ == "__main__":
    main()
