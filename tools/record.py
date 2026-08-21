#!/usr/bin/env python3
"""Stream the orb's serial CSV to a timestamped file.

    tools/.venv/bin/python tools/record.py [--port /dev/cu.usbmodemXXXX]

Nothing else may hold the port while this runs -- a host process keeping
/dev/cu.usbmodem* open is also what makes uploads fail with errors that look
like a dead board.
"""

import argparse
import datetime as dt
import glob
import pathlib
import sys

try:
    import serial
except ImportError:
    sys.exit("pyserial missing. tools/.venv/bin/pip install pyserial matplotlib")

BAUD = 921600


def find_port() -> str:
    ports = sorted(glob.glob("/dev/cu.usbmodem*"))
    if not ports:
        sys.exit("no /dev/cu.usbmodem* found -- is the orb plugged in?")
    if len(ports) > 1:
        sys.exit(f"several ports found, pass --port: {ports}")
    return ports[0]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port")
    ap.add_argument("--out-dir", default="logs")
    args = ap.parse_args()

    port = args.port or find_port()
    out_dir = pathlib.Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    path = out_dir / f"{stamp}.csv"

    print(f"recording {port} -> {path}   (ctrl-C to stop)", file=sys.stderr)

    rows = 0
    # The '#' config lines are kept in the file on purpose: a log that doesn't
    # record the settings it was captured under is hard to compare later.
    with serial.Serial(port, BAUD, timeout=1) as ser, path.open("w") as fh:
        # Streaming is off unless asked for, so that an unattended orb can't
        # stall on a USB buffer nobody is draining. Asking re-emits the
        # settings and the header.
        ser.write(b"c 1\n")
        ser.flush()
        try:
            while True:
                raw = ser.readline()
                if not raw:
                    continue
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                fh.write(line + "\n")
                if not line.startswith("#"):
                    rows += 1
                    if rows % 200 == 0:
                        fh.flush()
                        print(f"\r{rows} rows", end="", file=sys.stderr)
        except KeyboardInterrupt:
            pass
        finally:
            # Leave the orb quiet again for untethered use.
            try:
                ser.write(b"c 0\n")
                ser.flush()
            except serial.SerialException:
                pass

    print(f"\n{rows} rows -> {path}", file=sys.stderr)


if __name__ == "__main__":
    main()
