"""Descriptive stats for A4 mobile AR docking trials.

Reads data.csv (the reduced pilot log or the app's full CSV) and writes
figures/a4_results.png plus figures/a4_trials.png.

Usage, from this folder:

    python analyze_a4.py
"""

from __future__ import annotations

import csv
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parent
DATA_PATH = ROOT / "data.csv"
FIG_DIR = ROOT / "figures"

ALIASES = {
    "completion_time_s": ("completion_time_s", "time_s"),
    "pos_error_cm": ("pos_error_cm", "dpos_cm"),
    "yaw_error_deg": ("yaw_error_deg", "drot_deg"),
    "wrong_selections": ("wrong_selections",),
    "touch_count": ("touch_count",),
    "tracking_lost": ("tracking_lost",),
    "trial": ("trial", "trial_number"),
}

METRICS = (
    ("completion_time_s", "Completion time (s)", "s"),
    ("pos_error_cm", "Position error (cm)", "cm"),
    ("yaw_error_deg", "Yaw error (deg)", "deg"),
)

OPTIONAL = ("wrong_selections", "touch_count", "tracking_lost")
COLORS = {"touch": "#4C78A8", "carry": "#F58518"}
LABELS = {"touch": "Touch", "carry": "Carry"}


def _cell(row: dict, *names: str) -> str | None:
    lookup = {key.strip(): value for key, value in row.items()}
    for name in names:
        if name in lookup and str(lookup[name]).strip() != "":
            return str(lookup[name]).strip()
    return None


def _float(row: dict, *names: str) -> float | None:
    raw = _cell(row, *names)
    if raw is None:
        return None
    return float(raw)


def load_rows(path: Path = DATA_PATH) -> list[dict]:
    rows: list[dict] = []
    with path.open(newline="", encoding="utf-8-sig") as fh:
        for raw in csv.DictReader(fh):
            technique = _cell(raw, "technique")
            if technique is None:
                continue
            row = {
                "participant_id": _cell(raw, "participant_id") or "UNKNOWN",
                "technique": technique.lower(),
            }
            for key, names in ALIASES.items():
                if key == "trial":
                    value = _cell(raw, *names)
                    row[key] = int(float(value)) if value is not None else None
                elif key == "completion_time_s" or key.endswith("_cm") or key.endswith("_deg"):
                    row[key] = _float(raw, *names)
                else:
                    value = _cell(raw, *names)
                    row[key] = int(float(value)) if value is not None else None
            rows.append(row)

    counts: dict[tuple[str, str], int] = {}
    for row in rows:
        if row["trial"] is None:
            key = (row["participant_id"], row["technique"])
            counts[key] = counts.get(key, 0) + 1
            row["trial"] = counts[key]
    return rows


def summarize(values: list[float]) -> dict[str, float]:
    arr = np.asarray(values, dtype=float)
    return {
        "n": int(arr.size),
        "mean": float(arr.mean()) if arr.size else float("nan"),
        "sd": float(arr.std(ddof=1)) if arr.size > 1 else float("nan"),
        "min": float(arr.min()) if arr.size else float("nan"),
        "max": float(arr.max()) if arr.size else float("nan"),
        "median": float(np.median(arr)) if arr.size else float("nan"),
    }


def techniques_in_order(rows: list[dict]) -> list[str]:
    seen: list[str] = []
    for row in rows:
        if row["technique"] not in seen:
            seen.append(row["technique"])
    return seen


def values(rows: list[dict], technique: str, key: str) -> list[float]:
    return [row[key] for row in rows if row["technique"] == technique and row[key] is not None]


def print_summary(rows: list[dict]) -> None:
    techs = techniques_in_order(rows)
    people = sorted({row["participant_id"] for row in rows})
    print(f"file: {DATA_PATH.name}")
    print(f"rows: {len(rows)}")
    print(f"participants: {people}")
    print(f"techniques: {techs}")
    print()

    header = f"{'technique':<10} {'metric':<22} {'n':>3} {'mean':>8} {'sd':>8} {'median':>8} {'min':>8} {'max':>8}"
    print(header)
    print("-" * len(header))
    for technique in techs:
        for key, label, _unit in METRICS:
            stats = summarize(values(rows, technique, key))
            print(
                f"{technique:<10} {label:<22} {stats['n']:3d} "
                f"{stats['mean']:8.3f} {stats['sd']:8.3f} {stats['median']:8.3f} "
                f"{stats['min']:8.3f} {stats['max']:8.3f}"
            )
        for key in OPTIONAL:
            nums = values(rows, technique, key)
            if not nums:
                print(f"{technique:<10} {key:<22}   — not in this CSV")
                continue
            stats = summarize(nums)
            print(
                f"{technique:<10} {key:<22} {stats['n']:3d} "
                f"{stats['mean']:8.3f} {stats['sd']:8.3f} {stats['median']:8.3f} "
                f"{stats['min']:8.3f} {stats['max']:8.3f}"
            )
        print()

    print("Per participant (mean of 3 trials)")
    people = sorted({row["participant_id"] for row in rows})
    for participant in people:
        for technique in techs:
            subset = [
                row
                for row in rows
                if row["participant_id"] == participant and row["technique"] == technique
            ]
            time = summarize([row["completion_time_s"] for row in subset])
            pos = summarize([row["pos_error_cm"] for row in subset])
            yaw = summarize([row["yaw_error_deg"] for row in subset])
            print(
                f"  {participant} {technique:<6} "
                f"time {time['mean']:.3f} s   pos {pos['mean']:.3f} cm   "
                f"yaw {yaw['mean']:.3f} deg   n={time['n']}"
            )

    print()
    print("Per trial")
    for row in rows:
        print(
            f"  {row['participant_id']}  {row['technique']:<6}  trial {row['trial']}  "
            f"time {row['completion_time_s']:.3f} s  "
            f"pos {row['pos_error_cm']:.2f} cm  "
            f"yaw {row['yaw_error_deg']:.2f} deg"
        )


def plot(rows: list[dict]) -> None:
    FIG_DIR.mkdir(exist_ok=True)
    techs = techniques_in_order(rows)
    x = np.arange(len(techs))
    labels = [LABELS.get(name, name) for name in techs]
    colors = [COLORS.get(name, "#666666") for name in techs]

    fig, axes = plt.subplots(1, 3, figsize=(9.6, 3.5))
    for ax, (key, ylabel, _unit) in zip(axes, METRICS):
        means = []
        sds = []
        for technique in techs:
            stats = summarize(values(rows, technique, key))
            means.append(stats["mean"])
            sds.append(0.0 if np.isnan(stats["sd"]) else stats["sd"])
        ax.bar(x, means, yerr=sds, color=colors, width=0.62, capsize=4, error_kw={"elinewidth": 1})
        for i, technique in enumerate(techs):
            ys = values(rows, technique, key)
            jitter = (np.linspace(-0.08, 0.08, len(ys)) if len(ys) > 1 else [0.0])
            ax.scatter(np.full(len(ys), x[i]) + jitter, ys, color="white", edgecolors="#222", zorder=3, s=28)
        ax.set_xticks(x, labels)
        ax.set_ylabel(ylabel)
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
    people = sorted({row["participant_id"] for row in rows})
    n_per = min(len(values(rows, name, "completion_time_s")) for name in techs) if techs else 0
    fig.suptitle(
        f"A4 mobile AR docking — {len(people)} participants, mean ± sd, n = {n_per} per technique",
        fontsize=11,
    )
    fig.tight_layout()
    out = FIG_DIR / "a4_results.png"
    fig.savefig(out, dpi=160)
    plt.close(fig)
    print(f"\nwrote {out}")

    fig, ax = plt.subplots(figsize=(6.8, 3.8))
    styles = {"P001": "-", "P002": "--"}
    markers = {"P001": "o", "P002": "s"}
    for participant in people:
        for technique in techs:
            subset = sorted(
                [
                    row
                    for row in rows
                    if row["participant_id"] == participant and row["technique"] == technique
                ],
                key=lambda row: row["trial"],
            )
            ax.plot(
                [row["trial"] for row in subset],
                [row["completion_time_s"] for row in subset],
                marker=markers.get(participant, "o"),
                linestyle=styles.get(participant, "-"),
                color=COLORS.get(technique, "#666"),
                label=f"{participant} {LABELS.get(technique, technique)}",
            )
    ax.set_xticks([1, 2, 3])
    ax.set_xlabel("Trial")
    ax.set_ylabel("Completion time (s)")
    ax.set_title("Completion time by trial")
    ax.legend(frameon=False, fontsize=8)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    fig.tight_layout()
    out = FIG_DIR / "a4_trials.png"
    fig.savefig(out, dpi=160)
    plt.close(fig)
    print(f"wrote {out}")


def main() -> None:
    rows = load_rows()
    if not rows:
        raise SystemExit(f"No rows in {DATA_PATH}")
    print_summary(rows)
    plot(rows)


if __name__ == "__main__":
    main()
