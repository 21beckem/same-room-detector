# AGENTS.md

## Project purpose

Same-Room Detection Mesh compares two audio recordings and estimates whether they were captured in the same physical room. The current implementation is local Python code operating on WAV files. The longer-term product is expected to compare live audio from two browser devices connected through PeerJS/WebRTC.

## Repository layout

- `data-exploration/colocation.py` is the main implementation. It extracts synchronization features, trains a small NumPy logistic-regression model, performs leave-one-group-out validation, and scores two files.
- `data-exploration/explore_room_audio.py` is for exploratory feature analysis and plots.
- `data-exploration/evaluate_all_pairs.py` scores all discovered recordings with a trained model and writes a matrix/report.
- `data-exploration/pick_and_score.py` provides an interactive terminal picker for scoring recordings.
- `data-exploration/room-audio-recordings/` contains labelled WAV data.
- `model_output/`, `eval_output/`, and `exploration_output/` contain generated models, CSV reports, and plots. Treat these as reproducible outputs, not hand-edited source.

## Development environment

Use the existing local virtual environment when available. From the repository root on Windows PowerShell:

```powershell
.\venv\Scripts\Activate.ps1
python -m pip install numpy scipy matplotlib soundfile
```

`soundfile` is optional at runtime because the code falls back to `scipy.io.wavfile`, but it is useful for broad WAV support. There is currently no lockfile or requirements file; if dependencies are formalized, keep the commands in this document and the README in sync.

## Data conventions

Training and exploratory scripts expect this layout:

```text
room-audio-recordings/
  <category>/
    group-<number>/
      <name>_A.wav
      <name>_B.wav
```

The default categories are `close` (target 1.0), `apart` (0.5), and `gone` (0.0). A group represents one recording session/pair and is the unit used for validation. Do not put generated output inside a dataset category or change the `_A.wav`/`_B.wav` naming convention without updating discovery code.

## Common commands

Run commands from `data-exploration/` so the default relative paths resolve correctly:

```powershell
cd data-exploration

# Explore features and create plots
python explore_room_audio.py room-audio-recordings --out exploration_output

# Train and validate a model
python colocation.py train room-audio-recordings --out ../model_output

# Score two WAV files
python colocation.py score ../model_output/model.json path\to\a.wav path\to\b.wav --json

# Evaluate every available pair
python evaluate_all_pairs.py --root room-audio-recordings --model ../model_output/model.json --out eval_output

# Use the interactive terminal scorer
python pick_and_score.py --root room-audio-recordings --model ../model_output/model.json
```

The main pipeline resamples audio to 16 kHz, converts it to mono, uses overlapping windows, and compares GCC-PHAT, log-mel energy-envelope, and onset-flux synchronization features. Scores are estimates, not proof of co-location; inspect quality notes and validation output, especially for quiet or highly stationary recordings.

## Implementation guidance

- Keep feature extraction deterministic and make changes compatible with both training and scoring.
- Preserve group-aware validation. Do not randomly split windows from the same recording across train and validation, since that leaks recording/session information.
- When adding a feature, update training, inference, model serialization, reports, and any plots together. Prefer explicit model/config fields over hidden constants.
- Avoid committing large generated datasets or regenerated plots unless the change specifically requires them. Do not commit virtual environments, caches, or secrets.
- Add small, deterministic tests for numerical behavior when changing signal processing. At minimum, check audio loading/resampling, lag sign conventions, feature vector shape, and score output structure.
- Use `pathlib.Path` and cross-platform Python commands. Keep terminal UI code separate from reusable signal-processing/model code.

## Browser/WebRTC direction

The browser version should reuse the conceptual pipeline while separating transport from analysis:

1. Capture microphone streams in each browser.
2. Exchange live audio through PeerJS/WebRTC.
3. Buffer short, timestamped windows and account for clock/start-offset differences.
4. Run compatible feature extraction locally in the browser or behind a clearly defined service boundary.
5. Return a score, label, quality flags, and useful lag/feature diagnostics.

Do not assume that file-based alignment, Python-only libraries, or synchronized device clocks will carry over unchanged. Keep the scoring contract and feature definitions documented so a future JavaScript/WebAudio implementation can be compared against Python fixtures. Treat microphone audio as sensitive: minimize retention, avoid transmitting raw audio unless required, and document permissions and failure states.

## Verification before handoff

For code changes, run the affected command against the included dataset when practical and confirm that expected files are produced. For model or signal-processing changes, compare validation metrics and representative scores before and after the change. Report any unrun checks, missing data, or environment limitations rather than presenting generated output as verified.
