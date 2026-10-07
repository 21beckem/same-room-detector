#!/usr/bin/env python3
"""
evaluate_all_pairs.py - brute-force test: score EVERY pair of recordings, report accuracy.

    python3 evaluate_all_pairs.py
    python3 evaluate_all_pairs.py --root room-audio-recordings --model model_output/model.json --out eval_output

Ground truth comes from the folders: the A/B files of one group get that category's target
(close=1, apart=0.5, gone=0 by default); any two files from different groups are 0.
Scores are turned into bands (>=0.75 close, 0.25-0.75 middle, <0.25 unrelated) and compared
with the band of the ground-truth target.

Three views are printed, because they answer different questions:
  1. Final model on all pairs. Optimistic if the model trained on these recordings.
  2. Held-out scores (leave-one-group-out, from `train`). The honest estimate for these files.
  3. Pairs involving recordings the model never saw (needs a model trained with the current
     colocation.py). Record new data, run this BEFORE retraining, and this is a true test.

Accuracy alone is misleading here: ~95% of pairs are "unrelated", so always answering
"unrelated" scores ~95%. Balanced accuracy and per-class recall are shown next to it.

Needs colocation.py in the same folder and a trained model.
"""
import argparse
import csv
import json
import sys
from itertools import combinations
from pathlib import Path

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

import colocation as co

LABELS = ["close", "middle", "unrelated"]


def summarize(rows, key, title):
    rows = [r for r in rows if r.get(key) is not None]
    print(f"\n=== {title} ===")
    if not rows:
        print("  (no pairs available)")
        return
    truth = np.array([r["truth_label"] for r in rows])
    pred = np.array([co.band_label(r[key]) for r in rows])
    n, correct = len(rows), int((truth == pred).sum())
    present = [l for l in LABELS if (truth == l).any()]
    recall = {l: float(np.mean(pred[truth == l] == l)) for l in present}
    majority = max(present, key=lambda l: int((truth == l).sum()))
    print(f"  Overall accuracy:   {correct}/{n} = {100 * correct / n:.1f}%")
    print(f"  Balanced accuracy:  {100 * np.mean(list(recall.values())):.1f}%   (mean of per-class recall)")
    print(f"  Baseline:           {100 * np.mean(truth == majority):.1f}%   (always answering '{majority}')")
    print(f"  Mean |score - target|: {np.mean([abs(r[key] - r['target']) for r in rows]):.3f}")
    pos = np.array([r[key] for r in rows if r["truth_label"] == "close"])
    neg = np.array([r[key] for r in rows if r["truth_label"] == "unrelated"])
    if len(pos) and len(neg):
        print(f"  AUC (close vs unrelated): {co.auc(pos, neg):.3f}   "
              f"(lowest close {pos.min():.3f}, highest unrelated {neg.max():.3f})")
    print(f"\n  {'truth \\ predicted':<20}" + "".join(f"{l:>11}" for l in LABELS) + f"{'recall':>9}")
    for l in present:
        counts = [int(np.sum((truth == l) & (pred == p))) for p in LABELS]
        print(f"  {l + f' (n={int((truth == l).sum())})':<20}" + "".join(f"{c:>11}" for c in counts)
              + f"{100 * recall[l]:>8.0f}%")


def plot_matrix(items, rows, path):
    n = len(items)
    index = {it["label"]: i for i, it in enumerate(items)}
    panels = [("Final model score", "score")]
    if any(r["held_out"] is not None for r in rows):
        panels.append(("Held-out score (leave-one-group-out)", "held_out"))
    fig, axes = plt.subplots(1, len(panels), figsize=(8.5 * len(panels), 8), squeeze=False)
    for ax, (title, key) in zip(axes[0], panels):
        m = np.full((n, n), np.nan)
        for r in rows:
            if r[key] is not None:
                i, j = index[r["a"]], index[r["b"]]
                m[i, j] = m[j, i] = r[key]
        im = ax.imshow(m, vmin=0, vmax=1, cmap="viridis")
        ax.set_xticks(range(n))
        ax.set_yticks(range(n))
        ax.set_xticklabels([it["label"] for it in items], rotation=90, fontsize=7)
        ax.set_yticklabels([it["label"] for it in items], fontsize=7)
        ax.set_title(title)
        fig.colorbar(im, ax=ax, fraction=0.046)
    fig.suptitle("Every pair of recordings (grey = same file / not available)")
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default="room-audio-recordings")
    ap.add_argument("--model", default="model_output/model.json")
    ap.add_argument("--out", default="eval_output")
    args = ap.parse_args()

    if not Path(args.model).exists():
        sys.exit(f"Model not found: {args.model}\nTrain one first:  python3 colocation.py train {args.root}")
    with open(args.model) as fh:
        model = json.load(fh)
    targets = model["targets"]
    trained = set(model.get("trained_recordings", []))
    cv = co.load_cv_scores(args.model)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    found = co.discover(Path(args.root), targets)
    found.sort(key=lambda f: (-targets[f[0]], f[0], f[1], f[2]))
    items = [dict(cat=c, gid=g, label=f"{c}/g{g}/{d}", path=p) for c, g, d, p in found]
    print(f"Loading {len(items)} recordings ...")
    for it in items:
        it["clip"] = co.make_clip(co.load_audio(it["path"]))

    pairs = list(combinations(items, 2))
    print(f"Scoring all {len(pairs)} pairs ...")
    rows = []
    for k, (a, b) in enumerate(pairs, 1):
        print(f"\r  {k}/{len(pairs)}", end="", flush=True)
        target, _ = co.pair_truth(a["cat"], a["gid"], b["cat"], b["gid"], targets)
        row = dict(a=a["label"], b=b["label"], same_group=(a["cat"], a["gid"]) == (b["cat"], b["gid"]),
                   target=target, truth_label=co.band_label(target),
                   new_data=bool(trained) and not (a["label"] in trained and b["label"] in trained),
                   held_out=co.lookup_cv(cv, a["label"], b["label"]), score=None, error="")
        try:
            res = co.score_clips(model, a["clip"], b["clip"])
            row.update(score=res["score"], quality_ok=res["quality"]["ok"],
                       notes="; ".join(res["quality"]["notes"]))
        except ValueError as exc:
            row.update(error=str(exc), quality_ok=False, notes="")
        rows.append(row)
    print()

    errors = [r for r in rows if r["error"]]
    if errors:
        print(f"\n{len(errors)} pairs could not be scored (e.g. {errors[0]['a']} vs {errors[0]['b']}: "
              f"{errors[0]['error']})")
    flagged = sum(1 for r in rows if r["score"] is not None and not r["quality_ok"])
    print(f"Quality flags: {flagged} of {len(rows)} pairs flagged low quality")

    summarize(rows, "score", "1. Final model, every pair (optimistic for pairs it trained on)")
    if cv:
        summarize(rows, "held_out", "2. Held-out scores, every pair (leave-one-group-out: honest estimate)")
    else:
        print("\n(no cv_pairs.csv next to the model, so held-out results are skipped)")
    new_rows = [r for r in rows if r["new_data"]]
    if trained:
        if new_rows:
            summarize(new_rows, "score", f"3. Pairs involving recordings the model never saw ({len(new_rows)} pairs)")
        else:
            print("\n3. No recordings newer than the model's training data, so there is no unseen-data test yet.")
    else:
        print("\n3. Unseen-data test unavailable: this model.json predates the trained-recordings record "
              "(re-run `colocation.py train`).")

    print("\n=== Real pairs (same group) ===")
    print(f"  {'pair':<28}{'target':>7}{'score':>8}{'held-out':>10}   result")
    for r in rows:
        if r["same_group"]:
            ok = co.band_label(r["score"]) == r["truth_label"] if r["score"] is not None else False
            ho = f"{r['held_out']:.3f}" if r["held_out"] is not None else "n/a"
            print(f"  {r['a'] + ' vs ' + r['b'].split('/')[-1]:<28}{r['target']:>7.2f}"
                  f"{(r['score'] if r['score'] is not None else float('nan')):>8.3f}{ho:>10}   "
                  f"{'ok' if ok else 'WRONG'} (expect {r['truth_label']})")

    key = "held_out" if cv else "score"
    wrong = [r for r in rows if r.get(key) is not None and co.band_label(r[key]) != r["truth_label"]]
    wrong.sort(key=lambda r: -abs(r[key] - r["target"]))
    print(f"\n=== Biggest misses ({'held-out' if cv else 'final model'} scores; {len(wrong)} wrong in total) ===")
    for r in wrong[:10]:
        print(f"  {r[key]:.3f} (target {r['target']:.2f})  {r['a']}  vs  {r['b']}")
    if not wrong:
        print("  none")

    cols = ["a", "b", "same_group", "truth_label", "target", "score", "held_out", "new_data",
            "quality_ok", "notes", "error"]
    with open(out / "all_pairs_results.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({c: (round(r[c], 5) if isinstance(r.get(c), float) else r.get(c)) for c in cols})
    plot_matrix(items, rows, out / "all_pairs_matrix.png")
    print(f"\nWrote all_pairs_results.csv and all_pairs_matrix.png to {out.resolve()}")


if __name__ == "__main__":
    main()