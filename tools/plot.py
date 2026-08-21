#!/usr/bin/env python3
"""Plot a recorded session: rotation speed against what the motor did.

    tools/.venv/bin/python tools/plot.py logs/20260814-140000.csv

Columns are looked up by name from the CSV header, so adding a channel to the
firmware doesn't break this.
"""

import argparse
import csv
import pathlib
import sys

import matplotlib.pyplot as plt


def load(path: pathlib.Path):
    with path.open() as fh:
        # '#' lines are the config the session was captured under -- worth
        # printing, since the whole point of a log is comparing tunings.
        lines = [ln for ln in fh if not ln.lstrip().startswith("#")]
        fh.seek(0)
        notes = [ln.strip() for ln in fh if ln.lstrip().startswith("#")]

    reader = csv.DictReader(lines)
    names = list(reader.fieldnames or [])
    cols: dict[str, list[float]] = {name: [] for name in names}
    for row in reader:
        # All-or-nothing per row. A session that ends mid-line -- which is the
        # normal way recording stops -- must not leave the columns ragged.
        try:
            parsed = [float(row[name]) for name in names]
        except (TypeError, ValueError):
            continue
        for name, value in zip(names, parsed):
            cols[name].append(value)
    return cols, notes


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", type=pathlib.Path)
    ap.add_argument("--save", type=pathlib.Path)
    args = ap.parse_args()

    cols, notes = load(args.csv)
    if not cols.get("t_ms"):
        sys.exit(f"no data rows in {args.csv}")

    for n in notes:
        print(n)

    t0 = cols["t_ms"][0]
    t = [(v - t0) / 1000.0 for v in cols["t_ms"]]

    fig, (ax_top, ax_mid, ax_bot) = plt.subplots(
        3, 1, sharex=True, figsize=(12, 8), height_ratios=[2, 2, 1]
    )

    ax_top.plot(t, cols["omega_dps"], lw=0.8, color="#1f77b4")
    ax_top.set_ylabel("rotation\ndeg/s")
    ax_top.grid(alpha=0.3)

    # The lag between these two is the thing to look at: part of it is tau_ms,
    # and ~40-60 ms of it is the ERM's mechanical spin-up, which no amount of
    # tuning removes.
    ax_mid.plot(t, cols["shaped"], lw=0.7, color="#bbbbbb", label="shaped (pre-smoothing)")
    ax_mid.plot(t, cols["intensity"], lw=1.2, color="#d62728", label="intensity")
    ax_mid.set_ylabel("intensity\n0..1")
    ax_mid.set_ylim(-0.05, 1.05)
    ax_mid.legend(loc="upper right", fontsize=8)
    ax_mid.grid(alpha=0.3)

    ax_bot.plot(t, cols["rtp"], lw=0.8, color="#2ca02c")
    ax_bot.set_ylabel("motor\nrtp")
    ax_bot.set_xlabel("seconds")
    ax_bot.grid(alpha=0.3)

    hz = cols.get("loop_hz") or [0.0]
    fig.suptitle(f"{args.csv.name}   loop {min(hz):.0f}-{max(hz):.0f} Hz", fontsize=10)
    fig.tight_layout()

    if args.save:
        fig.savefig(args.save, dpi=130)
        print(f"saved {args.save}")
    else:
        plt.show()


if __name__ == "__main__":
    main()
