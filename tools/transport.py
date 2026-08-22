"""How the bridge reaches the orb.

Everything above this file works in whole text lines and does not care what
carries them. Serial is what exists today; a WiFi transport drops in here
without the bridge or the frontend noticing.
"""

from __future__ import annotations

import glob
import os
import queue
import sys
import threading
import time

# ORB_DEBUG=1 logs every command written to the device. Command corruption is
# otherwise invisible: the firmware just acts on whatever it managed to parse.
DEBUG = bool(os.environ.get("ORB_DEBUG"))


class Transport:
    """Line-oriented link to the orb."""

    def start(self) -> None: ...
    def stop(self) -> None: ...
    def send(self, line: str) -> None: ...

    def lines(self) -> queue.Queue:
        """Queue of inbound lines, already stripped."""
        raise NotImplementedError


class SerialTransport(Transport):
    BAUD = 921600
    RETRY_S = 1.0

    def __init__(self, port: str | None = None):
        import serial  # imported here so the WiFi path won't need pyserial

        self._serial_mod = serial
        self._explicit = port
        self.port = port
        self._q: queue.Queue = queue.Queue()
        self._ser = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._connected = threading.Event()
        self._on_connect = None

    @property
    def connected(self) -> bool:
        return self._connected.is_set()

    def on_connect(self, fn) -> None:
        """Called on the reader thread each time a device is (re)opened."""
        self._on_connect = fn

    def find_port(self) -> str | None:
        if self._explicit:
            return self._explicit if os.path.exists(self._explicit) else None
        ports = sorted(glob.glob("/dev/cu.usbmodem*"))
        if not ports:
            return None
        if len(ports) > 1:
            print(f"several ports found, using {ports[0]}: {ports}", file=sys.stderr)
        return ports[0]

    def lines(self) -> queue.Queue:
        return self._q

    def start(self) -> None:
        # Deliberately does not require a device to be present. The orb gets
        # unplugged, reflashed and replugged constantly; the bridge waiting
        # quietly for it is far more useful than the bridge refusing to start.
        self._thread = threading.Thread(target=self._read_loop, daemon=True)
        self._thread.start()

    # --- connection handling ------------------------------------------------

    def _open(self) -> bool:
        port = self.find_port()
        if not port:
            return False
        try:
            self._ser = self._serial_mod.Serial(port, self.BAUD, timeout=0.2)
        except Exception:
            self._ser = None
            return False

        self.port = port
        self._connected.set()
        print(f"orb connected on {port}", flush=True)
        if self._on_connect:
            # The device reboots when it is replugged, and CSV streaming is off
            # at boot -- without this the port would be open and silent.
            try:
                self._on_connect()
            except Exception:
                pass
        return True

    def _drop(self) -> None:
        if self._ser is not None:
            try:
                self._ser.close()
            except Exception:
                pass
        self._ser = None
        if self._connected.is_set():
            self._connected.clear()
            print("orb disconnected — waiting for it to come back", flush=True)

    def _read_loop(self) -> None:
        buf = b""
        while not self._stop.is_set():
            if self._ser is None:
                buf = b""
                if not self._open():
                    time.sleep(self.RETRY_S)
                continue

            try:
                # Block for one byte, then take everything already buffered.
                # read(4096) instead waits for 4096 bytes *or* the timeout --
                # at this data rate that is ~250 ms, so frames arrived in
                # 200 ms clumps and anything rendering from them stuttered.
                chunk = self._ser.read(max(1, self._ser.in_waiting))
            except Exception:
                self._drop()
                continue

            if not chunk:
                # A quiet device and an unplugged one look identical from a
                # read timeout, so check whether the node still exists.
                if not os.path.exists(self.port):
                    self._drop()
                continue

            buf += chunk
            *complete, buf = buf.split(b"\n")
            for raw in complete:
                line = raw.decode("utf-8", "replace").strip()
                if line:
                    self._q.put(line)

    # --- outbound -----------------------------------------------------------

    def send(self, line: str) -> None:
        ser = self._ser
        if ser is None:
            return
        if not line.endswith("\n"):
            line += "\n"
        try:
            ser.write(line.encode())
            ser.flush()
            if DEBUG:
                print(f"TX {line.rstrip()!r}", file=sys.stderr, flush=True)
        except Exception:
            self._drop()

    def stop(self) -> None:
        self._stop.set()
        if self._ser is not None:
            try:
                self._ser.write(b"c 0\n")   # leave the orb quiet for untethered use
                self._ser.flush()
            except Exception:
                pass
            try:
                self._ser.close()
            except Exception:
                pass
