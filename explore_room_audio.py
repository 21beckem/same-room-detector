#!/usr/bin/env python3
"""
Exploration script: do paired room recordings look measurably "closer"?

No model is trained here. For every pair of recordings it computes a handful of
similarity features, then shows (console tables, CSV, plots) whether those
features separate your categories:

    close  (<= 3 ft)               within-group pairs  -> should look very similar
    apart  (15-20 ft)              within-group pairs  -> the interesting middle case
    gone   (different environment) within-group pairs  -> should look unrelated
    cross  recordings from two DIFFERENT groups        -> assumed unrelated (negatives)

Expected folder layout:
    ROOT/{close,apart,gone}/group-N/<timestamp>_A.wav and <timestamp>_B.wav

Usage:
    python3 explore_room_audio.py room-audio-recordings
    python3 explore_room_audio.py room-audio-recordings --out results --max-lag 1.0

Requires: numpy, scipy, matplotlib   (soundfile is used for loading if installed)

Features (computed per pair; "z" = how far the peak sits above what you get by
sliding the clips against each other by amounts that cannot be the true offset):
    gcc_*    GCC-PHAT cross-correlation of the raw waveforms (100-4000 Hz).
             Strong for shared broadband sounds (speech, claps, door slams).
    mel_*    Correlation of the log-mel spectrogram over time, averaged across bands.
             Catches shared energy changes even when waveforms are not phase-aligned.
    flux_*   Correlation of onset strength (spectral flux). Shared "events".
    spec_corr_resid  Similarity of the long-term spectrum shape, after subtracting
             the average spectrum of ALL your recordings (so only the distinctive
             part of each room's sound counts).
    spec_rmse_db     Average dB gap between the two long-term spectra (lower = closer).
    tonal_corr       Correlation of narrow spectral peaks (hum, HVAC tones) after
             removing the smooth spectral trend.

Lag convention: positive lag = events appear later in A than in B.
"""
import argparse
import csv
import math
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
from scipy.ndimage import maximum_filter1d, median_filter, uniform_filter1d
from scipy.stats import rankdata

try:
    import soundfile as sf
except ImportError:  # falls back to scipy
    sf = None

SR = 16_000                 # all audio is resampled to this
N_FFT = 1024                # 64 ms analysis frames
HOP = 320                   # 20 ms hop -> 50 frames per second
FRAME_RATE = SR / HOP
N_MELS = 40
FMIN, FMAX = 50.0, 7500.0
CATEGORIES = ("close", "apart", "gone")
ORDER = {c: i for i, c in enumerate(CATEGORIES)}
COLORS = {"cross": "0.55", "gone": "tab:red", "apart": "tab:orange", "close": "tab:green"}

# (column, higher_means_more_similar)
FEATURES = [
    ("gcc_z", True), ("gcc_peak", True),
    ("mel_z", True), ("mel_peak", True),
    ("flux_z", True), ("flux_peak", True),
    ("spec_corr_resid", True), ("tonal_corr", True),
    ("spec_rmse_db", False),
]


# --------------------------------------------------------------------------- #
# Loading and per-recording features
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
    return fb, edges[1:-1]


FB, MEL_HZ = mel_filterbank()


def load_audio(path):
    """Mono float signal at SR with DC removed, plus the file's original sample rate."""
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
    return x - x.mean(), int(file_sr)


def log_mel(x):
    _, _, Z = signal.stft(x, fs=SR, window="hann", nperseg=N_FFT,
                          noverlap=N_FFT - HOP, boundary=None, padded=False)
    return 10.0 * np.log10(FB @ (np.abs(Z) ** 2) + 1e-12)       # (bands, frames) in dB


def zscore(v, axis=None):
    v = v - v.mean(axis=axis, keepdims=axis is not None)
    sd = v.std(axis=axis, keepdims=axis is not None)
    return v / np.maximum(sd, 1e-6)


def onset_flux(mel_db):
    d = np.diff(mel_db, axis=1, prepend=mel_db[:, :1])
    return uniform_filter1d(np.maximum(d, 0).sum(axis=0), 3)


def tonal_residual(x):
    """Narrow spectral peaks: Welch PSD in dB minus its ~100 Hz running median."""
    f, p = signal.welch(x, SR, nperseg=8192)
    db = 10.0 * np.log10(p + 1e-20)
    resid = db - median_filter(db, size=51, mode="nearest")
    return resid[(f >= 40) & (f <= 3000)]


@dataclass
class Rec:
    label: str
    category: str
    group: int
    device: str
    file_sr: int
    x: np.ndarray
    mel_db: np.ndarray
    mel_z: np.ndarray
    flux: np.ndarray
    prof: np.ndarray
    tonal: np.ndarray
    rms_dbfs: float
    dyn_db: float


def build_rec(path, category, group, device):
    x, file_sr = load_audio(path)
    mel_db = log_mel(x)
    prof = mel_db.mean(axis=1)
    return Rec(
        label=f"{category}/g{group}/{device}", category=category, group=group, device=device,
        file_sr=file_sr, x=x, mel_db=mel_db, mel_z=zscore(mel_db, axis=1),
        flux=zscore(onset_flux(mel_db)), prof=prof - prof.mean(), tonal=tonal_residual(x),
        rms_dbfs=float(20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-12)),
        dyn_db=float(mel_db.mean(axis=0).std()),
    )


def discover(root):
    found = []
    for cat in CATEGORIES:
        gdirs = sorted((root / cat).glob("group-*"), key=lambda p: int(p.name.split("-")[-1]))
        for gdir in gdirs:
            gid = int(gdir.name.split("-")[-1])
            files = {dev: sorted(gdir.glob(f"*_{dev}.wav")) for dev in ("A", "B")}
            if any(len(v) != 1 for v in files.values()):
                print(f"WARNING: skipping {gdir} (expected exactly one *_A.wav and one *_B.wav)")
                continue
            found += [(cat, gid, dev, files[dev][0]) for dev in ("A", "B")]
    return found


# --------------------------------------------------------------------------- #
# Pair features
# --------------------------------------------------------------------------- #
def gcc_phat(xa, xb, fmin=100.0, fmax=4000.0):
    """Band-limited GCC-PHAT. Returns lags (s) and a curve whose max possible value is 1."""
    n = min(len(xa), len(xb))
    nfft = next_fast_len(2 * n - 1)
    r = rfft(xa[:n], nfft) * np.conj(rfft(xb[:n], nfft))
    r /= np.abs(r) + 1e-12
    band = (rfftfreq(nfft, 1.0 / SR) >= fmin) & (rfftfreq(nfft, 1.0 / SR) <= fmax)
    r[~band] = 0
    cc = irfft(r, nfft) / (2.0 * band.sum() / nfft)
    cc = np.concatenate([cc[nfft - (n - 1):], cc[:n]])
    return np.arange(-(n - 1), n) / SR, cc


def xcorr_unbiased(a, b):
    """a, b: (bands, T) unit-variance rows. Mean-over-bands correlation estimate per lag."""
    a, b = np.atleast_2d(a), np.atleast_2d(b)
    t = a.shape[1]
    nfft = next_fast_len(2 * t - 1)
    cc = irfft(rfft(a, nfft, axis=1) * np.conj(rfft(b, nfft, axis=1)), nfft, axis=1).mean(axis=0)
    cc = np.concatenate([cc[nfft - (t - 1):], cc[:t]])
    lags = np.arange(-(t - 1), t)
    return lags / FRAME_RATE, cc / (t - np.abs(lags))


def lag_stats(lags, cc, max_lag, null_max, margin=0.5):
    """
    Peak of cc inside |lag| <= max_lag, and a z-score against a null built from
    windows of the same width placed at lags that cannot be the true offset
    (from max_lag+margin out to null_max seconds, both sides). Using window
    MAXIMA as the null means the z-score already accounts for "best of many lags".
    """
    idx = np.flatnonzero(np.abs(lags) <= max_lag + 1e-9)
    k = idx[np.argmax(cc[idx])]
    width = idx.size
    maxima = []
    for side in (-1, 1):
        sel = np.flatnonzero((side * lags >= max_lag + margin) & (np.abs(lags) <= null_max))
        if sel.size >= width:
            mf = maximum_filter1d(cc[sel], size=width, mode="nearest")
            maxima.append(mf[width // 2: sel.size - width // 2])
    if not maxima:
        return float(cc[k]), float(lags[k]), float("nan")
    m = np.concatenate(maxima)
    return float(cc[k]), float(lags[k]), float((cc[k] - m.mean()) / (m.std() + 1e-12))


def pearson(u, v):
    u, v = u - u.mean(), v - v.mean()
    d = np.linalg.norm(u) * np.linalg.norm(v)
    return float(u @ v / d) if d > 1e-12 else 0.0


def pair_features(a, b, args, ref_prof, keep_curves):
    n = min(len(a.x), len(b.x))
    t = min(a.mel_db.shape[1], b.mel_db.shape[1])
    null_max = 0.5 * n / SR
    feats, curves = {}, {}

    inputs = {
        "gcc": gcc_phat(a.x, b.x),
        "mel": xcorr_unbiased(a.mel_z[:, :t], b.mel_z[:, :t]),
        "flux": xcorr_unbiased(a.flux[:t], b.flux[:t]),
    }
    for name, (lags, cc) in inputs.items():
        peak, lag, z = lag_stats(lags, cc, args.max_lag, null_max)
        feats.update({f"{name}_peak": peak, f"{name}_lag": lag, f"{name}_z": z})
        if keep_curves:
            sel = np.abs(lags) <= args.plot_range
            curves[name] = (lags[sel], cc[sel])

    feats["spec_corr_resid"] = pearson(a.prof - ref_prof, b.prof - ref_prof)
    feats["spec_rmse_db"] = float(np.sqrt(np.mean((a.prof - b.prof) ** 2)))
    feats["tonal_corr"] = pearson(a.tonal, b.tonal)
    feats["min_rms_dbfs"] = min(a.rms_dbfs, b.rms_dbfs)
    feats["min_dyn_db"] = min(a.dyn_db, b.dyn_db)
    return feats, curves


# --------------------------------------------------------------------------- #
# Reporting
# --------------------------------------------------------------------------- #
def auc(pos, neg):
    pos, neg = pos[np.isfinite(pos)], neg[np.isfinite(neg)]
    if len(pos) == 0 or len(neg) == 0:
        return float("nan")
    r = rankdata(np.concatenate([pos, neg]))
    return float((r[:len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def pct_below(value, cross_vals, higher):
    """% of cross pairs that look LESS similar than this value."""
    cross_vals = cross_vals[np.isfinite(cross_vals)]
    if not np.isfinite(value) or len(cross_vals) == 0:
        return float("nan")
    return 100.0 * float(np.mean(cross_vals < value if higher else cross_vals > value))


def print_reports(recs, rows):
    print("\n=== Recordings ===")
    print(f"{'recording':<14}{'file_sr':>8}{'dur(s)':>8}{'rms(dBFS)':>11}{'dyn(dB)':>9}")
    for r in recs:
        print(f"{r.label:<14}{r.file_sr:>8}{len(r.x) / SR:>8.1f}{r.rms_dbfs:>11.1f}{r.dyn_db:>9.2f}")

    cross = [r for r in rows if r["pair_type"] == "cross"]
    within = sorted((r for r in rows if r["pair_type"] != "cross"),
                    key=lambda r: (ORDER[r["pair_type"]], r["group_a"]))
    close = [r for r in within if r["pair_type"] == "close"]

    print(f"\n=== Feature separation: {len(close)} close pairs vs {len(cross)} cross-group pairs ===")
    print("AUC 1.0 = every close pair beats every cross pair; 0.5 = no separation.")
    print("(cross pairs share recordings, so treat these numbers as descriptive, not rigorous.)")
    print(f"{'feature':<17}{'AUC':>6}{'close median':>14}{'cross median':>14}{'cross 95th*':>13}   apart / gone values")
    for feat, higher in FEATURES:
        cv = np.array([r[feat] for r in cross], dtype=float)
        pv = np.array([r[feat] for r in close], dtype=float)
        a = auc(pv, cv) if higher else auc(-pv, -cv)
        edge = np.nanpercentile(cv, 95 if higher else 5)
        extra = "  ".join(f"{r['pair_type']} g{r['group_a']}={r[feat]:.2f}"
                          for r in within if r["pair_type"] != "close")
        print(f"{feat:<17}{a:>6.2f}{np.nanmedian(pv):>14.2f}{np.nanmedian(cv):>14.2f}"
              f"{edge:>13.2f}   {extra}")
    print("* 'cross 95th' = value that only 5% of cross pairs exceed (5th pct if lower = more similar).")

    show = ["gcc_z", "mel_z", "flux_z", "spec_corr_resid", "tonal_corr"]
    print("\n=== Within-group pairs: value (percentile = % of cross pairs that look less similar) ===")
    print(f"{'pair':<12}" + "".join(f"{f:>22}" for f in show))
    for r in within:
        cells = []
        for f in show:
            cv = np.array([c[f] for c in cross], dtype=float)
            cells.append(f"{r[f]:.2f} ({pct_below(r[f], cv, True):.0f}%)")
        print(f"{r['pair_type'] + ' g' + str(r['group_a']):<12}" + "".join(f"{c:>22}" for c in cells))

    print("\n=== Within-group lags (s) and signal quality ===")
    print("If gcc/mel/flux agree on the lag, the match is probably real. Lag should be < ~1 s.")
    print(f"{'pair':<12}{'gcc_lag':>9}{'mel_lag':>9}{'flux_lag':>10}{'min_rms':>9}{'min_dyn':>9}")
    for r in within:
        print(f"{r['pair_type'] + ' g' + str(r['group_a']):<12}{r['gcc_lag']:>9.3f}{r['mel_lag']:>9.3f}"
              f"{r['flux_lag']:>10.3f}{r['min_rms_dbfs']:>9.1f}{r['min_dyn_db']:>9.2f}")

    print("\n=== Highest-scoring CROSS pairs (look for suspicious ones: same room, same hallway?) ===")
    for feat in ("gcc_z", "mel_z", "flux_z"):
        top = sorted(cross, key=lambda r: -np.nan_to_num(r[feat], nan=-1e9))[:3]
        print(f"{feat}: " + "; ".join(f"{r['a']} vs {r['b']} = {r[feat]:.1f}" for r in top))


def plot_features(rows, path):
    order = ["cross", "gone", "apart", "close"]
    rng = np.random.default_rng(0)
    fig, axes = plt.subplots(3, 3, figsize=(15, 11))
    for ax, (feat, higher) in zip(axes.ravel(), FEATURES):
        for xi, cat in enumerate(order):
            sel = [r for r in rows if r["pair_type"] == cat and np.isfinite(r[feat])]
            xs = xi + rng.uniform(-0.18, 0.18, len(sel))
            ys = [r[feat] for r in sel]
            is_cross = cat == "cross"
            ax.scatter(xs, ys, s=14 if is_cross else 46, alpha=0.5 if is_cross else 0.95,
                       color=COLORS[cat], edgecolor="none" if is_cross else "k", linewidths=0.5)
            if not is_cross:
                for x_, r in zip(xs, sel):
                    ax.annotate(f"g{r['group_a']}", (x_, r[feat]), fontsize=7,
                                xytext=(4, 2), textcoords="offset points")
        if feat.endswith("_z"):
            ax.set_yscale("symlog", linthresh=5)
        counts = {c: sum(r["pair_type"] == c for r in rows) for c in order}
        ax.set_xticks(range(4))
        ax.set_xticklabels([f"{c}\n(n={counts[c]})" for c in order])
        ax.set_title(feat + ("" if higher else "  (lower = more similar)"), fontsize=10)
        ax.grid(alpha=0.25)
    fig.suptitle("Pair features by category", fontsize=13)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def plot_lag_grid(name, label, within, args, path, block=None):
    ncols = 3
    nrows = math.ceil(len(within) / ncols)
    fig, axes = plt.subplots(nrows, ncols, figsize=(15, 3.2 * nrows), squeeze=False)
    for ax, r in zip(axes.ravel(), within):
        lags, cc = r["_curves"][name]
        if block:
            m = len(cc) // block
            lags = lags[:m * block].reshape(m, block).mean(axis=1)
            cc = cc[:m * block].reshape(m, block).max(axis=1)
        ax.plot(lags, cc, lw=0.8, color=COLORS[r["pair_type"]])
        ax.axvspan(-args.max_lag, args.max_lag, color="tab:blue", alpha=0.08)
        ax.set_title(f"{r['pair_type']} g{r['group_a']}  z={r[name + '_z']:.1f}  "
                     f"peak={r[name + '_peak']:.2f}  lag={r[name + '_lag']:+.2f}s", fontsize=9)
        ax.set_xlabel("lag (s)")
        ax.grid(alpha=0.25)
    for ax in axes.ravel()[len(within):]:
        ax.axis("off")
    fig.suptitle(f"{label} vs lag (shaded = search window)", fontsize=13)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def plot_spectra(recs, path):
    groups = sorted({(r.category, r.group) for r in recs}, key=lambda g: (ORDER[g[0]], g[1]))
    ncols = 3
    nrows = math.ceil(len(groups) / ncols)
    fig, axes = plt.subplots(nrows, ncols, figsize=(15, 3.2 * nrows), squeeze=False)
    for ax, (cat, gid) in zip(axes.ravel(), groups):
        for r in (r for r in recs if (r.category, r.group) == (cat, gid)):
            ax.semilogx(MEL_HZ, r.prof, label=r.device, lw=1.5)
        ax.set_title(f"{cat} g{gid}", fontsize=10, color=COLORS[cat])
        ax.set_xlabel("Hz")
        ax.set_ylabel("dB (centered)")
        ax.legend(fontsize=8)
        ax.grid(alpha=0.25, which="both")
    for ax in axes.ravel()[len(groups):]:
        ax.axis("off")
    fig.suptitle("Long-term spectrum of A vs B (gain removed)", fontsize=13)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("root", nargs="?", default="room-audio-recordings")
    ap.add_argument("--out", default="exploration_output")
    ap.add_argument("--max-lag", type=float, default=1.5,
                    help="search window in seconds for the A/B start offset (default 1.5)")
    ap.add_argument("--plot-range", type=float, default=5.0,
                    help="lag range in seconds shown in the lag plots (default 5)")
    args = ap.parse_args()

    root, out = Path(args.root), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    found = discover(root)
    if not found:
        raise SystemExit(f"No recordings found under {root}")
    print(f"Loading {len(found)} recordings ...")
    recs = [build_rec(p, cat, gid, dev) for cat, gid, dev, p in found]

    min_dur = 6 * args.max_lag + 1.0
    short = [r.label for r in recs if len(r.x) / SR < min_dur]
    if short:
        print(f"WARNING: clips shorter than {min_dur:.0f} s leave no room for the null estimate "
              f"(z will be NaN): {', '.join(short)}")

    ref_prof = np.mean([r.prof for r in recs], axis=0)      # average spectrum of everything

    rows, n_pairs = [], len(recs) * (len(recs) - 1) // 2
    print(f"Scoring {n_pairs} pairs ...")
    for a, b in combinations(recs, 2):
        same = (a.category, a.group) == (b.category, b.group)
        feats, curves = pair_features(a, b, args, ref_prof, keep_curves=same)
        rows.append({
            "pair_type": a.category if same else "cross", "a": a.label, "b": b.label,
            "group_a": a.group, "group_b": b.group, "devs": a.device + "-" + b.device,
            **feats, "_curves": curves,
        })

    csv_rows = [{k: (round(v, 5) if isinstance(v, float) else v) for k, v in r.items() if not k.startswith("_")}
                for r in rows]
    with open(out / "pairs.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(csv_rows[0].keys()))
        w.writeheader()
        w.writerows(csv_rows)

    print_reports(recs, rows)

    within = sorted((r for r in rows if r["pair_type"] != "cross"),
                    key=lambda r: (ORDER[r["pair_type"]], r["group_a"]))
    plot_features(rows, out / "features_by_category.png")
    plot_lag_grid("gcc", "GCC-PHAT correlation (10 ms max-pooled)", within, args,
                  out / "lag_gcc_phat.png", block=SR // 100)
    plot_lag_grid("mel", "Log-mel envelope correlation", within, args, out / "lag_mel_env.png")
    plot_lag_grid("flux", "Onset-flux correlation", within, args, out / "lag_onset_flux.png")
    plot_spectra(recs, out / "mean_spectra.png")
    print(f"\nWrote pairs.csv and 5 PNG plots to {out.resolve()}")


if __name__ == "__main__":
    main()