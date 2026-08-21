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

    def __init__(self, port: str | None = None):
        import serial  # imported here so the WiFi path won't need pyserial

        self._serial_mod = serial
        self.port = port or self.autodetect()
        self._q: queue.Queue = queue.Queue()
        self._ser = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    @staticmethod
    def autodetect() -> str:
        ports = sorted(glob.glob("/dev/cu.usbmodem*"))
        if not ports:
            raise SystemExit("no /dev/cu.usbmodem* found -- is the orb plugged in?")
        if len(ports) > 1:
            raise SystemExit(f"several ports found, pass --port: {ports}")
        return ports[0]

    def lines(self) -> queue.Queue:
        return self._q

    def start(self) -> None:
        self._ser = self._serial_mod.Serial(self.port, self.BAUD, timeout=0.2)
        self._thread = threading.Thread(target=self._read_loop, daemon=True)
        self._thread.start()

    def _read_loop(self) -> None:
        buf = b""
        while not self._stop.is_set():
            try:
                # Block for one byte, then take everything already buffered.
                # read(4096) instead waits for 4096 bytes *or* the timeout --
                # at this data rate that is ~250 ms, so frames arrived in
                # 200 ms clumps and anything rendering from them stuttered.
                chunk = self._ser.read(max(1, self._ser.in_waiting))
            except Exception:
                break
            if not chunk:
                continue
            buf += chunk
            *complete, buf = buf.split(b"\n")
            for raw in complete:
                line = raw.decode("utf-8", "replace").strip()
                if line:
                    self._q.put(line)

    def send(self, line: str) -> None:
        if self._ser is None:
            return
        if not line.endswith("\n"):
            line += "\n"
        try:
            self._ser.write(line.encode())
            self._ser.flush()
            if DEBUG:
                print(f"TX {line.rstrip()!r}", file=sys.stderr, flush=True)
        except Exception:
            pass

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
