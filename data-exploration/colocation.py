#!/usr/bin/env python3
"""
colocation.py - score how likely two audio recordings were made close together.

Two commands:

  train   Build a model from your labelled recordings folder, run leave-one-group-out
          cross-validation, and write model.json + reports + plots.

              python3 colocation.py train room-audio-recordings --out model_output

  score   Score two WAV files with a trained model.

              python3 colocation.py score model_output/model.json a.wav b.wav

Score meaning:  ~1.0 = close (like your <= 3 ft recordings)
                ~0.5 = middle (like your 15-20 ft "apart" recording)
                ~0.0 = unrelated (different places)

Folder layout (same as before):  ROOT/<category>/group-N/<anything>_A.wav and _B.wav
Each category folder needs a target score. Defaults: close=1, apart=0.5, gone=0.
To add new categories or change targets:  --targets close=1,apart=0.5,near=0.8,gone=0

How it works
  1. Each pair is cut into overlapping 12 s windows (live audio: up to 20 s => up to 5 windows).
  2. Per window, three "synchronization" features are measured within +/-1.5 s of lag:
       log_gcc_peak  waveform-level coherence (GCC-PHAT)      -> "very close"
       mel_peak      log-mel energy-envelope correlation       -> "same space"
       flux_peak     onset (spectral flux) correlation         -> "shared events"
  3. A small logistic regression maps them to a score. Targets can be fractional, so the
     "apart" pairs are trained toward 0.5 instead of 0 or 1.
  4. Negatives: every pair of recordings from different groups, plus "shifted" pairs
     (a real pair with one side moved 3 s out of sync: same room, wrong time).
  5. Window scores are averaged in log-odds space. Quality flags are reported separately.

Requires: numpy, scipy, matplotlib   (soundfile is used for loading if installed)
"""
import argparse
import csv
import json
import math
import sys
from dataclasses import dataclass
from itertools import combinations
from pathlib import Path

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy import signal
from scipy.fft import irfft, next_fast_len, rfft, rfftfreq
from scipy.io import wavfile
from scipy.ndimage import uniform_filter1d
from scipy.special import expit
from scipy.stats import rankdata

try:
    import soundfile as sf
except ImportError:  # falls back to scipy
    sf = None

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #
SR = 16_000
N_FFT = 1024
HOP = 320                      # 20 ms
FRAME_RATE = SR / HOP          # 50 frames per second
N_MELS = 40
FMIN, FMAX = 50.0, 7500.0
MAX_SEC = 20.0                 # inputs are cropped to their first 20 s

DEFAULT_CONFIG = dict(window_sec=12.0, hop_sec=2.0, max_lag=1.5, shift_sec=3.0, min_sec=8.0)
DEFAULT_TARGETS = {"close": 1.0, "apart": 0.5, "gone": 0.0}
FEATURES = ("log_gcc_peak", "mel_peak", "flux_peak")
LAM_GRID = [0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1.0]
QUALITY = dict(min_level_dbfs=-60.0, min_activity_db=1.0, max_window_spread=0.5)
KIND_COLORS = {"cross": "0.6", "shifted": "tab:purple", "gone": "tab:red",
               "apart": "tab:orange", "close": "tab:green"}


# --------------------------------------------------------------------------- #
# Audio features
# --------------------------------------------------------------------------- #
def mel_filterbank():
    def hz2mel(f):
        return 2595.0 * np.log10(1.0 + f / 700.0)

    def mel2hz(m):
        return 700.0 * (10.0 ** (m / 2595.0) - 1.0)

    edges = mel2hz(np.linspace(hz2mel(FMIN), hz2mel(FMAX), N_MELS + 2))
    bins = np.fft.rfftfreq(N_FFT, 1.0 / SR)
    fb = np.zeros((N_MELS, bins.size))
    for i in range(N_MELS):
        lo, ce, hi = edges[i:i + 3]
        fb[i] = np.clip(np.minimum((bins - lo) / (ce - lo), (hi - bins) / (hi - ce)), 0, None)
        if fb[i].sum() == 0:
            fb[i, np.argmin(np.abs(bins - ce))] = 1.0
        fb[i] /= fb[i].sum()
    return fb


FB = mel_filterbank()


def load_audio(path):
    """Mono float signal at SR, DC removed, cropped to the first MAX_SEC seconds."""
    if sf is not None:
        data, file_sr = sf.read(str(path), dtype="float64", always_2d=True)
    else:
        file_sr, raw = wavfile.read(path)
        raw = raw if raw.ndim > 1 else raw[:, None]
        if raw.dtype == np.uint8:
            data = (raw.astype(np.float64) - 128.0) / 128.0
        elif np.issubdtype(raw.dtype, np.integer):
            data = raw.astype(np.float64) / float(np.iinfo(raw.dtype).max)
        else:
            data = raw.astype(np.float64)
    x = data.mean(axis=1)
    if file_sr != SR:
        g = math.gcd(int(file_sr), SR)
        x = signal.resample_poly(x, SR // g, int(file_sr) // g)
    x = x[: int(MAX_SEC * SR)]
    return x - x.mean()


def log_mel(x):
    _, _, z = signal.stft(x, fs=SR, window="hann", nperseg=N_FFT,
                          noverlap=N_FFT - HOP, boundary=None, padded=False)
    return 10.0 * np.log10(FB @ (np.abs(z) ** 2) + 1e-12)       # (bands, frames) dB


def zscore(v, axis=None):
    keep = axis is not None
    v = v - v.mean(axis=axis, keepdims=keep)
    return v / np.maximum(v.std(axis=axis, keepdims=keep), 1e-6)


def onset_flux(mel_db):
    d = np.diff(mel_db, axis=1, prepend=mel_db[:, :1])
    return uniform_filter1d(np.maximum(d, 0).sum(axis=0), 3)


@dataclass
class Clip:
    x: np.ndarray
    mel_db: np.ndarray
    flux: np.ndarray
    rms_dbfs: float
    activity_db: float


def make_clip(x):
    mel_db = log_mel(x)
    return Clip(x=x, mel_db=mel_db, flux=onset_flux(mel_db),
                rms_dbfs=float(20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-12)),
                activity_db=float(mel_db.mean(axis=0).std()))


def segment(clip, s0, n):
    """(samples, log-mel frames, flux) for the sample range [s0, s0+n)."""
    f0 = s0 // HOP
    nf = 1 + (n - N_FFT) // HOP
    return clip.x[s0:s0 + n], clip.mel_db[:, f0:f0 + nf], clip.flux[f0:f0 + nf]


def gcc_phat(xa, xb, fmin=100.0, fmax=4000.0):
    """Band-limited GCC-PHAT. Returns lags (s) and a curve whose maximum possible value is 1."""
    n = min(len(xa), len(xb))
    nfft = next_fast_len(2 * n - 1)
    r = rfft(xa[:n], nfft) * np.conj(rfft(xb[:n], nfft))
    r /= np.abs(r) + 1e-12
    f = rfftfreq(nfft, 1.0 / SR)
    band = (f >= fmin) & (f <= fmax)
    r[~band] = 0
    cc = irfft(r, nfft) / (2.0 * band.sum() / nfft)
    cc = np.concatenate([cc[nfft - (n - 1):], cc[:n]])
    return np.arange(-(n - 1), n) / SR, cc


def xcorr_unbiased(a, b):
    """a, b: (bands, T) or (T,) with unit variance. Mean-over-bands correlation per lag."""
    a, b = np.atleast_2d(a), np.atleast_2d(b)
    t = a.shape[1]
    nfft = next_fast_len(2 * t - 1)
    cc = irfft(rfft(a, nfft, axis=1) * np.conj(rfft(b, nfft, axis=1)), nfft, axis=1).mean(axis=0)
    cc = np.concatenate([cc[nfft - (t - 1):], cc[:t]])
    lags = np.arange(-(t - 1), t)
    return lags / FRAME_RATE, cc / (t - np.abs(lags))


def peak_in_window(lags, cc, max_lag):
    sel = np.flatnonzero(np.abs(lags) <= max_lag + 1e-9)
    k = sel[np.argmax(cc[sel])]
    return float(cc[k]), float(lags[k])


def window_features(sa, sb, max_lag):
    """Synchronization features for one aligned window of recording A and recording B."""
    (xa, ma, fa), (xb, mb, fb) = sa, sb
    n = min(len(xa), len(xb))
    t = min(ma.shape[1], mb.shape[1])
    gp, gl = peak_in_window(*gcc_phat(xa[:n], xb[:n]), max_lag)
    mp, ml = peak_in_window(*xcorr_unbiased(zscore(ma[:, :t], axis=1), zscore(mb[:, :t], axis=1)), max_lag)
    fp, fl = peak_in_window(*xcorr_unbiased(zscore(fa[:t]), zscore(fb[:t])), max_lag)
    return dict(gcc_peak=gp, gcc_lag=gl, mel_peak=mp, mel_lag=ml, flux_peak=fp, flux_lag=fl)


def feature_vector(f):
    return np.array([math.log10(max(f["gcc_peak"], 1e-3)), f["mel_peak"], f["flux_peak"]])


def window_plan(n, cfg):
    """(start, length) windows in samples covering n samples."""
    win = int(round(cfg["window_sec"] * FRAME_RATE)) * HOP
    hop = int(round(cfg["hop_sec"] * FRAME_RATE)) * HOP
    if n < win:
        return [(0, n)]
    last = ((n - win) // HOP) * HOP
    starts = list(range(0, last + 1, hop))
    if last - starts[-1] > hop // 2:
        starts.append(last)
    return [(s, win) for s in starts]


# --------------------------------------------------------------------------- #
# Logistic regression (soft targets, weights, L2) - numpy only
# --------------------------------------------------------------------------- #
def fit_logistic(x, t, w, lam):
    """Minimise  sum(w*CE(t, sigmoid(z)))/sum(w) + 0.5*lam*|coef|^2.  x must be standardised."""
    n, d = x.shape
    a = np.hstack([np.ones((n, 1)), x])
    w = w / w.sum()
    pen = np.r_[0.0, np.full(d, lam)]

    def loss(b):
        z = a @ b
        return float(np.sum(w * (np.logaddexp(0, z) - t * z)) + 0.5 * np.sum(pen * b * b))

    beta = np.zeros(d + 1)
    for _ in range(200):
        p = expit(a @ beta)
        grad = a.T @ (w * (p - t)) + pen * beta
        hess = (a.T * (w * p * (1 - p))) @ a + np.diag(pen) + 1e-9 * np.eye(d + 1)
        step = np.linalg.solve(hess, grad)
        s, f0 = 1.0, loss(beta)
        while s > 1e-4 and loss(beta - s * step) > f0:
            s /= 2
        beta = beta - s * step
        if np.max(np.abs(s * step)) < 1e-9:
            break
    return beta


def row_arrays(rows):
    x = np.array([feature_vector(r) for r in rows])
    t = np.array([r["target"] for r in rows], dtype=float)
    w = 1.0 / np.array([r["nwin"] for r in rows], dtype=float)   # each pair counts once
    neg = t == 0
    if (~neg).any() and neg.any():                                 # balance positives vs negatives
        w[neg] *= w[~neg].sum() / w[neg].sum()
    return x, t, w


def fit_model(rows, lam):
    x, t, w = row_arrays(rows)
    mu = np.average(x, axis=0, weights=w)
    sd = np.maximum(np.sqrt(np.average((x - mu) ** 2, axis=0, weights=w)), 1e-6)
    beta = fit_logistic((x - mu) / sd, t, w, lam)
    return dict(features=list(FEATURES), mean=mu.tolist(), std=sd.tolist(),
                intercept=float(beta[0]), coef=beta[1:].tolist(), lam=float(lam))


def model_logits(model, vectors):
    z = (np.asarray(vectors) - np.array(model["mean"])) / np.array(model["std"])
    return model["intercept"] + z @ np.array(model["coef"])


def pair_means(rows, z):
    acc = {}
    for r, v in zip(rows, z):
        acc.setdefault(r["pair_id"], []).append(v)
    return {k: float(np.mean(v)) for k, v in acc.items()}


# --------------------------------------------------------------------------- #
# Dataset
# --------------------------------------------------------------------------- #
@dataclass
class Rec:
    cat: str
    gid: int
    dev: str
    clip: Clip

    @property
    def key(self):
        return f"{self.cat}/g{self.gid}"

    @property
    def label(self):
        return f"{self.key}/{self.dev}"


def parse_targets(text):
    targets = dict(DEFAULT_TARGETS)
    if text:
        for part in text.split(","):
            k, v = part.split("=")
            targets[k.strip()] = float(v)
    return targets


def discover(root, targets):
    cats = sorted(p.name for p in root.iterdir() if p.is_dir() and any(p.glob("group-*")))
    missing = [c for c in cats if c not in targets]
    if missing:
        sys.exit(f"No target score for category folder(s) {missing}. "
                 f"Add e.g.  --targets {missing[0]}=0.7  (1 = close, 0 = unrelated).")
    found = []
    for cat in cats:
        for gdir in sorted((root / cat).glob("group-*"), key=lambda p: int(p.name.split("-")[-1])):
            gid = int(gdir.name.split("-")[-1])
            files = {d: sorted(gdir.glob(f"*_{d}.wav")) for d in ("A", "B")}
            if any(len(v) != 1 for v in files.values()):
                print(f"WARNING: skipping {gdir} (need exactly one *_A.wav and one *_B.wav)")
                continue
            found += [(cat, gid, d, files[d][0]) for d in ("A", "B")]
    return found


def build_rows(recs, targets, cfg, shift_negatives=True):
    rows = []

    def add(pair_id, kind, groups, target, windows, within=False):
        for k, (sa, sb) in enumerate(windows):
            rows.append(dict(pair_id=pair_id, kind=kind, groups=frozenset(groups), target=target,
                             within=within, win=k, nwin=len(windows),
                             **window_features(sa, sb, cfg["max_lag"])))

    by_key = {}
    for r in recs:
        by_key.setdefault(r.key, {})[r.dev] = r
    shift = int(round(cfg["shift_sec"] * FRAME_RATE)) * HOP

    for key, d in by_key.items():                                  # real pairs + shifted negatives
        a, b = d["A"], d["B"]
        n = min(len(a.clip.x), len(b.clip.x))
        add(key, a.cat, [key], targets[a.cat],
            [(segment(a.clip, s, l), segment(b.clip, s, l)) for s, l in window_plan(n, cfg)], within=True)
        if shift_negatives and targets[a.cat] > 0 and n - shift >= cfg["min_sec"] * SR:
            for sign in (+1, -1):
                wins = []
                for s, l in window_plan(n - shift, cfg):
                    sa, sb = (s, s + shift) if sign > 0 else (s + shift, s)
                    wins.append((segment(a.clip, sa, l), segment(b.clip, sb, l)))
                add(f"{key}|shift{sign:+d}", "shifted", [key], 0.0, wins)

    for a, b in combinations(recs, 2):                             # cross-group negatives
        if a.key == b.key:
            continue
        n = min(len(a.clip.x), len(b.clip.x))
        add(f"{a.label}|{b.label}", "cross", [a.key, b.key], 0.0,
            [(segment(a.clip, s, l), segment(b.clip, s, l)) for s, l in window_plan(n, cfg)])
    return rows


# --------------------------------------------------------------------------- #
# Cross-validation
# --------------------------------------------------------------------------- #
def logo_cv(rows, lam):
    """Leave-one-group-out. Returns {pair_id: held-out mean logit}."""
    keys = sorted({next(iter(r["groups"])) for r in rows if r["within"]})
    preds = {}
    for g in keys:
        train = [r for r in rows if g not in r["groups"]]
        test = [r for r in rows if g in r["groups"]]
        m = fit_model(train, lam)
        for pid, v in pair_means(test, model_logits(m, [feature_vector(r) for r in test])).items():
            preds.setdefault(pid, []).append(v)
    return {pid: float(np.mean(v)) for pid, v in preds.items()}


def cv_loss(meta, preds):
    pos, neg = [], []
    for pid, z in preds.items():
        t = meta[pid]["target"]
        ce = float(np.logaddexp(0, z) - t * z)
        (pos if meta[pid]["within"] and t > 0 else neg).append(ce)
    return 0.5 * np.mean(pos) + 0.5 * np.mean(neg)


def auc(pos, neg):
    r = rankdata(np.concatenate([pos, neg]))
    return float((r[:len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


# --------------------------------------------------------------------------- #
# Scoring
# --------------------------------------------------------------------------- #
def band_label(score):
    return "close" if score >= 0.75 else "middle" if score >= 0.25 else "unrelated"


def score_clips(model, ca, cb):
    cfg = model["config"]
    n = min(len(ca.x), len(cb.x))
    if n < cfg["min_sec"] * SR:
        raise ValueError(f"Need at least {cfg['min_sec']:.0f} s of audio from each device (got {n / SR:.1f} s).")
    feats = [window_features(segment(ca, s, l), segment(cb, s, l), cfg["max_lag"])
             for s, l in window_plan(n, cfg)]
    z = model_logits(model, [feature_vector(f) for f in feats])
    window_scores = [float(v) for v in expit(z)]
    score = float(expit(z.mean()))

    notes = []
    level, activity = min(ca.rms_dbfs, cb.rms_dbfs), min(ca.activity_db, cb.activity_db)
    if level < QUALITY["min_level_dbfs"]:
        notes.append("very quiet input")
    if activity < QUALITY["min_activity_db"]:
        notes.append("very steady sound: little happening to compare")
    if n < cfg["window_sec"] * SR:
        notes.append(f"shorter than the {cfg['window_sec']:.0f} s training window")
    if len(window_scores) > 1 and max(window_scores) - min(window_scores) > QUALITY["max_window_spread"]:
        notes.append("windows disagree with each other")
    med = lambda k: float(np.median([f[k] for f in feats]))
    return dict(score=score, label=band_label(score), window_scores=window_scores,
                features=dict(gcc_peak=med("gcc_peak"), mel_peak=med("mel_peak"), flux_peak=med("flux_peak")),
                lags=dict(gcc=med("gcc_lag"), mel=med("mel_lag"), flux=med("flux_lag")),
                quality=dict(ok=not notes, notes=notes, level_dbfs=level, activity_db=activity),
                seconds=n / SR)


def score_files(model, path_a, path_b):
    return score_clips(model, make_clip(load_audio(path_a)), make_clip(load_audio(path_b)))

# --------------------------------------------------------------------------- #
# Helpers shared by pick_and_score.py and evaluate_all_pairs.py
# --------------------------------------------------------------------------- #
def pair_truth(cat_a, gid_a, cat_b, gid_b, targets):
    """(target score, description) for two recordings, from their folder labels."""
    if (cat_a, gid_a) == (cat_b, gid_b):
        t = targets[cat_a]
        return t, f"same group ({cat_a}), target {t:.2f}"
    return 0.0, "different groups, target 0.00"

def load_cv_scores(model_path):
    """Held-out (leave-one-group-out) scores written by `train`, or {} if unavailable."""
    p = Path(model_path).parent / "cv_pairs.csv"
    if not p.exists():
        return {}
    with open(p) as fh:
        return {row["pair_id"]: float(row["held_out_score"]) for row in csv.DictReader(fh)}

def lookup_cv(cv, label_a, label_b):
    """Held-out score for a pair of recording labels like 'close/g1/A', or None."""
    ka, kb = label_a.rsplit("/", 1)[0], label_b.rsplit("/", 1)[0]
    if ka == kb:
        return cv.get(ka)
    return cv.get(f"{label_a}|{label_b}", cv.get(f"{label_b}|{label_a}"))

# --------------------------------------------------------------------------- #
# Train command: reports and plots
# --------------------------------------------------------------------------- #
def kind_order(targets):
    cats = sorted(targets, key=lambda c: targets[c])
    return ["cross", "shifted"] + cats


def kind_color(kind, order):
    if kind in KIND_COLORS:
        return KIND_COLORS[kind]
    return plt.get_cmap("tab10")(3 + order.index(kind) % 7)


def plot_cv(meta, cv_scores, targets, path):
    order = kind_order(targets)
    rng = np.random.default_rng(0)
    fig, ax = plt.subplots(figsize=(10, 6))
    for xi, kind in enumerate(order):
        pids = [p for p, m in meta.items() if m["kind"] == kind]
        ys = np.array([cv_scores[p] for p in pids])
        xs = xi + rng.uniform(-0.2, 0.2, len(ys))
        solo = kind not in ("cross", "shifted")
        ax.scatter(xs, ys, s=60 if solo else 14, alpha=0.95 if solo else 0.5,
                   color=kind_color(kind, order), edgecolor="k" if solo else "none", linewidths=0.6)
        if solo:
            for x_, y_, p in zip(xs, ys, pids):
                ax.annotate(p.split("/")[-1], (x_, y_), fontsize=8, xytext=(5, 3), textcoords="offset points")
            ax.hlines(targets[kind], xi - 0.35, xi + 0.35, color="k", lw=1.5, ls="--")
    ax.axhline(0.25, color="0.7", lw=0.8, ls=":")
    ax.axhline(0.75, color="0.7", lw=0.8, ls=":")
    ax.set_xticks(range(len(order)))
    ax.set_xticklabels([f"{k}\n(n={sum(m['kind'] == k for m in meta.values())})" for k in order])
    ax.set_ylabel("held-out score (leave-one-group-out)")
    ax.set_ylim(-0.03, 1.03)
    ax.set_title("Held-out scores per pair   (dashed = training target)")
    ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def plot_space(rows, targets, path):
    order = kind_order(targets)
    pairs = {}
    for r in rows:
        pairs.setdefault(r["pair_id"], dict(kind=r["kind"], v=[]))["v"].append(feature_vector(r))
    fig, axes = plt.subplots(1, 2, figsize=(14, 6))
    for ax, (i, j) in zip(axes, [(0, 1), (1, 2)]):
        for kind in order:
            sel = [(pid, np.mean(d["v"], axis=0)) for pid, d in pairs.items() if d["kind"] == kind]
            if not sel:
                continue
            solo = kind not in ("cross", "shifted")
            pts = np.array([v for _, v in sel])
            ax.scatter(pts[:, i], pts[:, j], s=70 if solo else 14, alpha=0.95 if solo else 0.45,
                       color=kind_color(kind, order), edgecolor="k" if solo else "none",
                       linewidths=0.6, label=kind)
            if solo:
                for (pid, _), p in zip(sel, pts):
                    ax.annotate(pid.split("/")[-1], (p[i], p[j]), fontsize=8, xytext=(5, 3),
                                textcoords="offset points")
        ax.set_xlabel(FEATURES[i])
        ax.set_ylabel(FEATURES[j])
        ax.grid(alpha=0.25)
    axes[0].legend()
    fig.suptitle("Feature space (each point = one pair, mean over windows)")
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def cmd_train(args):
    root, out = Path(args.root), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    targets = parse_targets(args.targets)
    cfg = dict(window_sec=args.window_sec, hop_sec=args.hop_sec, max_lag=args.max_lag,
               shift_sec=args.shift_sec, min_sec=args.min_sec)

    found = discover(root, targets)
    if not found:
        sys.exit(f"No recordings found under {root}")
    print(f"Loading {len(found)} recordings ...")
    recs = [Rec(c, g, d, make_clip(load_audio(p))) for c, g, d, p in found]
    print(f"Extracting window features (window {cfg['window_sec']:.0f} s, hop {cfg['hop_sec']:.0f} s) ...")
    rows = build_rows(recs, targets, cfg, shift_negatives=not args.no_shift_negatives)

    meta = {}
    for r in rows:
        meta.setdefault(r["pair_id"], dict(kind=r["kind"], target=r["target"], within=r["within"]))
    kinds = {}
    for m in meta.values():
        kinds[m["kind"]] = kinds.get(m["kind"], 0) + 1
    print(f"{len(rows)} windows from {len(meta)} pairs: " + ", ".join(f"{k}={v}" for k, v in kinds.items()))

    with open(out / "train_windows.csv", "w", newline="") as fh:
        cols = ["pair_id", "kind", "target", "win", "nwin", "gcc_peak", "gcc_lag", "mel_peak",
                "mel_lag", "flux_peak", "flux_lag"]
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow({c: (round(r[c], 5) if isinstance(r[c], float) else r[c]) for c in cols})

    print("\nChoosing regularisation by leave-one-group-out log-loss:")
    results = {}
    for lam in (LAM_GRID if args.lam is None else [args.lam]):
        preds = logo_cv(rows, lam)
        results[lam] = (cv_loss(meta, preds), preds)
        print(f"  lam={lam:<7g} CV loss={results[lam][0]:.4f}")
    best = min(results, key=lambda k: results[k][0])
    cv_z = results[best][1]
    cv_scores = {p: float(expit(z)) for p, z in cv_z.items()}
    print(f"-> using lam={best:g}")

    model = fit_model(rows, best)
    model["config"] = cfg
    model["targets"] = targets
    model["trained_recordings"] = sorted(r.label for r in recs)

    within = sorted((p for p, m in meta.items() if m["within"]),
                    key=lambda p: (targets[meta[p]["kind"]], p), reverse=True)
    full_z = pair_means(rows, model_logits(model, [feature_vector(r) for r in rows]))
    print("\n=== Real pairs: held-out score (trained without that group) vs final-model score ===")
    print(f"{'pair':<14}{'target':>8}{'held-out':>10}{'final':>8}")
    for p in within:
        print(f"{p:<14}{meta[p]['target']:>8.2f}{cv_scores[p]:>10.3f}{expit(full_z[p]):>8.3f}")

    neg = [p for p, m in meta.items() if m["target"] == 0 and not m["within"]]
    close_like = [p for p in within if meta[p]["target"] == 1.0]
    neg_all = neg + [p for p in within if meta[p]["target"] == 0]
    for kind in ("cross", "shifted"):
        v = np.array([cv_scores[p] for p, m in meta.items() if m["kind"] == kind])
        if len(v):
            print(f"{kind:<8} n={len(v):<4} held-out score: median {np.median(v):.3f}  "
                  f"95th pct {np.percentile(v, 95):.3f}  max {v.max():.3f}")
    if close_like and neg_all:
        a = auc(np.array([cv_scores[p] for p in close_like]), np.array([cv_scores[p] for p in neg_all]))
        gap = min(cv_scores[p] for p in close_like) - max(cv_scores[p] for p in neg_all)
        print(f"\nAUC (held-out, close vs every negative pair): {a:.3f}   "
              f"margin (lowest close - highest negative): {gap:+.3f}")
    print("Highest-scoring negatives (check these for shared environments):")
    for p in sorted(neg_all, key=lambda p: -cv_scores[p])[:5]:
        print(f"  {cv_scores[p]:.3f}  {p}")

    print("\n=== Final model (weights are per +1 standard deviation of each feature) ===")
    for name, c, mu, sd in zip(FEATURES, model["coef"], model["mean"], model["std"]):
        print(f"  {name:<14}{c:>+8.2f}   (mean {mu:.3f}, sd {sd:.3f})")
    print(f"  intercept     {model['intercept']:>+8.2f}")
    if any(c < 0 for c in model["coef"]):
        print("  NOTE: a negative weight is unexpected (all features should increase with closeness).")

    model["cv"] = dict(
        lam_grid={str(k): v[0] for k, v in results.items()},
        held_out_scores={p: cv_scores[p] for p in within},
        n_pairs=kinds)
    with open(out / "model.json", "w") as fh:
        json.dump(model, fh, indent=2)
    with open(out / "cv_pairs.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["pair_id", "kind", "target", "held_out_score", "final_model_score"])
        for p, m in sorted(meta.items(), key=lambda kv: -cv_scores[kv[0]]):
            w.writerow([p, m["kind"], m["target"], round(cv_scores[p], 5), round(float(expit(full_z[p])), 5)])
    plot_cv(meta, cv_scores, targets, out / "cv_scores.png")
    plot_space(rows, targets, out / "feature_space.png")
    print(f"\nWrote model.json, cv_pairs.csv, train_windows.csv, cv_scores.png, feature_space.png to {out.resolve()}")


def cmd_score(args):
    with open(args.model) as fh:
        model = json.load(fh)
    res = score_files(model, args.a, args.b)
    if args.json:
        print(json.dumps(res, indent=2))
        return
    print(f"score: {res['score']:.3f}  ({res['label']})   from {res['seconds']:.1f} s of audio")
    print("window scores: " + "  ".join(f"{s:.2f}" for s in res["window_scores"]))
    f, l = res["features"], res["lags"]
    print(f"features: gcc_peak {f['gcc_peak']:.3f}  mel_peak {f['mel_peak']:.2f}  flux_peak {f['flux_peak']:.2f}")
    print(f"peak lags (s): gcc {l['gcc']:+.2f}  mel {l['mel']:+.2f}  flux {l['flux']:+.2f}")
    q = res["quality"]
    print("quality: " + ("ok" if q["ok"] else "LOW - " + "; ".join(q["notes"])) +
          f"   (level {q['level_dbfs']:.0f} dBFS, activity {q['activity_db']:.1f} dB)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    tr = sub.add_parser("train", help="train a model from a labelled recordings folder")
    tr.add_argument("root", nargs="?", default="room-audio-recordings")
    tr.add_argument("--out", default="model_output")
    tr.add_argument("--targets", default="", help="e.g. close=1,apart=0.5,near=0.8,gone=0")
    tr.add_argument("--window-sec", type=float, default=DEFAULT_CONFIG["window_sec"])
    tr.add_argument("--hop-sec", type=float, default=DEFAULT_CONFIG["hop_sec"])
    tr.add_argument("--max-lag", type=float, default=DEFAULT_CONFIG["max_lag"])
    tr.add_argument("--shift-sec", type=float, default=DEFAULT_CONFIG["shift_sec"])
    tr.add_argument("--min-sec", type=float, default=DEFAULT_CONFIG["min_sec"])
    tr.add_argument("--lam", type=float, default=None, help="fix the regularisation instead of choosing it")
    tr.add_argument("--no-shift-negatives", action="store_true")
    tr.set_defaults(func=cmd_train)

    sc = sub.add_parser("score", help="score two WAV files with a trained model")
    sc.add_argument("model")
    sc.add_argument("a")
    sc.add_argument("b")
    sc.add_argument("--json", action="store_true")
    sc.set_defaults(func=cmd_score)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()