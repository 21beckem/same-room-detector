#!/usr/bin/env python3
"""Create a detailed Python reference output for the browser parity harness.

Run from the repository root:

    venv\\Scripts\\python.exe web-calibration\\parity_python.py

The output is intentionally machine-readable JSON. It exercises the functions
used by pick_and_score.py and records intermediate clip and pair results so a
JavaScript implementation can be compared without hiding numerical drift.
"""

import argparse
import hashlib
import json
import math
import sys
import time
from itertools import combinations
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DATASET = ROOT / "data-exploration" / "room-audio-recordings"
MODEL_PATH = ROOT / "model_output" / "model.json"
sys.path.insert(0, str(ROOT / "data-exploration"))
import colocation as co  # noqa: E402


def sha256_f64(array):
    """Hash a C-order little-endian float64 representation."""
    values = np.asarray(array, dtype="<f8", order="C")
    return hashlib.sha256(values.tobytes()).hexdigest()


def scalar(value):
    if value is None:
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def array_summary(array, include_values=False):
    values = np.asarray(array)
    flat = values.reshape(-1)
    result = {
        "shape": list(values.shape),
        "dtype": str(values.dtype),
        "length": int(flat.size),
        "sha256_f64": sha256_f64(values),
        "min": scalar(np.min(flat)) if flat.size else None,
        "max": scalar(np.max(flat)) if flat.size else None,
        "mean": scalar(np.mean(flat)) if flat.size else None,
        "std": scalar(np.std(flat)) if flat.size else None,
        "first": [scalar(v) for v in flat[:8]],
        "last": [scalar(v) for v in flat[-8:]],
    }
    if include_values:
        result["values"] = [scalar(v) for v in flat]
    return result


def feature_output(features):
    return {key: scalar(value) for key, value in features.items()}


def item_from_path(path):
    relative = path.relative_to(DATASET)
    category, group_name, filename = relative.parts
    group = int(group_name.removeprefix("group-"))
    device = filename.rsplit("_", 1)[1].removesuffix(".wav")
    return {
        "cat": category,
        "gid": group,
        "dev": device,
        "path": relative.as_posix(),
        "label": f"{category}/g{group}/{device}",
    }


def pair_windows(a_clip, b_clip, model):
    cfg = model["config"]
    n = min(len(a_clip.x), len(b_clip.x))
    windows = []
    for start, length in co.window_plan(n, cfg):
        features = co.window_features(
            co.segment(a_clip, start, length),
            co.segment(b_clip, start, length),
            cfg["max_lag"],
        )
        vector = co.feature_vector(features)
        logit = co.model_logits(model, [vector])[0]
        windows.append({
            "start": int(start),
            "length": int(length),
            "features": feature_output(features),
            "feature_vector": [scalar(v) for v in vector],
            "logit": scalar(logit),
            "score": scalar(co.expit(logit)),
        })
    return windows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "web-calibration" / "python-output.json")
    parser.add_argument("--all-pairs", action="store_true", help="score every pair")
    parser.add_argument("--pair-limit", type=int, default=4,
                        help="maximum representative pairs to score (use --all-pairs for every pair)")
    parser.add_argument("--timings-output", type=Path,
                        help="also write per-stage timing data as JSON")
    args = parser.parse_args()

    with MODEL_PATH.open() as fh:
        model = json.load(fh)
    targets = model["targets"]
    paths = sorted(DATASET.rglob("*.wav"))
    items = [item_from_path(path) for path in paths]
    started = time.perf_counter()
    load_audio_ms = []
    make_clip_ms = []
    clips = {}
    for item in items:
        t0 = time.perf_counter()
        audio = co.load_audio(DATASET / item["path"])
        load_audio_ms.append((time.perf_counter() - t0) * 1000)
        t0 = time.perf_counter()
        clips[item["path"]] = co.make_clip(audio)
        make_clip_ms.append((time.perf_counter() - t0) * 1000)

    clip_outputs = []
    for item in items:
        clip = clips[item["path"]]
        clip_outputs.append({
            **item,
            "audio": array_summary(clip.x),
            "mel_db": array_summary(clip.mel_db),
            "flux": array_summary(clip.flux),
            "rms_dbfs": scalar(clip.rms_dbfs),
            "activity_db": scalar(clip.activity_db),
        })

    all_pairs = list(combinations(items, 2))
    if args.all_pairs:
        selected_pairs = all_pairs
    else:
        within = [pair for pair in all_pairs if pair[0]["cat"] == pair[1]["cat"] and pair[0]["gid"] == pair[1]["gid"]]
        cross = [pair for pair in all_pairs if not (pair[0]["cat"] == pair[1]["cat"] and pair[0]["gid"] == pair[1]["gid"])]
        # Include deterministic cross pairs from the beginning, middle, and end
        # of the sorted list while keeping the default run practical in JS.
        cross_sample = cross[:5] + cross[len(cross) // 2:len(cross) // 2 + 5] + cross[-5:]
        selected_pairs = (within + cross_sample)[:args.pair_limit]

    cv = co.load_cv_scores(MODEL_PATH)
    pair_outputs = []
    pair_windows_ms = []
    score_clips_ms = []
    for item_a, item_b in selected_pairs:
        clip_a, clip_b = clips[item_a["path"]], clips[item_b["path"]]
        t0 = time.perf_counter()
        windows = pair_windows(clip_a, clip_b, model)
        pair_windows_ms.append((time.perf_counter() - t0) * 1000)
        t0 = time.perf_counter()
        result = co.score_clips(model, clip_a, clip_b)
        score_clips_ms.append((time.perf_counter() - t0) * 1000)
        target, why = co.pair_truth(item_a["cat"], item_a["gid"], item_b["cat"], item_b["gid"], targets)
        pair_outputs.append({
            "a": item_a["label"],
            "b": item_b["label"],
            "path_a": item_a["path"],
            "path_b": item_b["path"],
            "truth": {"target": scalar(target), "description": why},
            "held_out": scalar(co.lookup_cv(cv, item_a["label"], item_b["label"])),
            "windows": windows,
            "result": result,
        })

    helper_checks = {
        "band_labels": {str(value): co.band_label(value) for value in [-0.1, 0.0, 0.249999, 0.25, 0.749999, 0.75, 1.0]},
        "window_plans": {
            str(n): [[int(start), int(length)] for start, length in co.window_plan(n, model["config"])]
            for n in [8 * co.SR, 12 * co.SR, 20 * co.SR, 320000]
        },
    }

    output = {
        "format": "same-room-parity-v1",
        "implementation": "python-colocation-reference",
        "model_path": MODEL_PATH.relative_to(ROOT).as_posix(),
        "model": model,
        "constants": {
            "SR": co.SR,
            "N_FFT": co.N_FFT,
            "HOP": co.HOP,
            "FRAME_RATE": scalar(co.FRAME_RATE),
            "N_MELS": co.N_MELS,
            "FMIN": co.FMIN,
            "FMAX": co.FMAX,
            "MAX_SEC": co.MAX_SEC,
        },
        "files": clip_outputs,
        "pairs": pair_outputs,
        "pair_count_available": len(all_pairs),
        "pair_count_scored": len(selected_pairs),
        "helpers": helper_checks,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", newline="\n") as fh:
        json.dump(output, fh, indent=2, sort_keys=True, allow_nan=False)
        fh.write("\n")
    timing_output = {
        "implementation": "python-colocation-reference",
        "files": len(items),
        "pairs": len(selected_pairs),
        "load_audio_ms": load_audio_ms,
        "make_clip_ms": make_clip_ms,
        "pair_windows_ms": pair_windows_ms,
        "score_clips_ms": score_clips_ms,
        "total_ms": (time.perf_counter() - started) * 1000,
    }
    if args.timings_output:
        args.timings_output.parent.mkdir(parents=True, exist_ok=True)
        with args.timings_output.open("w", newline="\n") as fh:
            json.dump(timing_output, fh, indent=2)
            fh.write("\n")
    print("Timing (ms): " + json.dumps(timing_output, separators=(",", ":")))
    print(f"Wrote {args.output} ({len(items)} files, {len(selected_pairs)} pairs)")


if __name__ == "__main__":
    main()
