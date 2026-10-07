#!/usr/bin/env python3
"""
pick_and_score.py - terminal UI: pick two recordings, see the co-location score.

    python3 pick_and_score.py
    python3 pick_and_score.py --root room-audio-recordings --model model_output/model.json

Keys:  Up/Down (or k/j) move    PgUp/PgDn/Home/End jump
       Enter or Space  select (pick two; the second pick scores the pair)
       c  clear picks          q  quit

Needs colocation.py in the same folder and a trained model (colocation.py train ...).
Besides the model's score, it shows the held-out score (from leave-one-group-out
validation) when available. That one is the honest number: the model never saw that
pair's group when producing it. The plain score comes from a model that trained on
these recordings, so it is optimistic.
"""
import argparse
import curses
import json
import sys
import textwrap
from pathlib import Path

import colocation as co

GREEN, RED, YELLOW, CYAN = 1, 2, 3, 4


def load_items(root, targets):
    found = co.discover(root, targets)
    found.sort(key=lambda f: (-targets[f[0]], f[0], f[1], f[2]))
    return [dict(cat=c, gid=g, dev=d, path=p, label=f"{c}/g{g}/{d}") for c, g, d, p in found]


def describe(item_a, item_b, res, targets, held_out):
    """Result panel as a list of (text, colour) lines. Pure function (no curses)."""
    target, why = co.pair_truth(item_a["cat"], item_a["gid"], item_b["cat"], item_b["gid"], targets)
    expected, got = co.band_label(target), res["label"]
    ok = expected == got
    f, lag, q = res["features"], res["lags"], res["quality"]
    lines = [
        (f"A: {item_a['label']}   ({item_a['path'].name})", 0),
        (f"B: {item_b['label']}   ({item_b['path'].name})", 0),
        (f"Truth: {why}  ->  expect '{expected}'", 0),
        (f"SCORE {res['score']:.3f}  =>  {got}   {'[CORRECT]' if ok else '[WRONG]'}",
         GREEN if ok else RED),
    ]
    if held_out is None:
        lines.append(("Held-out score: n/a (run `train` to create cv_pairs.csv)", YELLOW))
    else:
        h_ok = co.band_label(held_out) == expected
        lines.append((f"Held-out score {held_out:.3f}  =>  {co.band_label(held_out)}   "
                      f"(model never saw this pair's group)", GREEN if h_ok else RED))
    lines += [
        ("Windows: " + "  ".join(f"{s:.2f}" for s in res["window_scores"]) + f"   ({res['seconds']:.1f} s)", 0),
        (f"Features: gcc_peak {f['gcc_peak']:.3f}   mel_peak {f['mel_peak']:.2f}   flux_peak {f['flux_peak']:.2f}", 0),
        (f"Peak lags (s): gcc {lag['gcc']:+.2f}   mel {lag['mel']:+.2f}   flux {lag['flux']:+.2f}", 0),
        ("Quality: " + ("ok" if q["ok"] else "LOW - " + "; ".join(q["notes"])) +
         f"   (level {q['level_dbfs']:.0f} dBFS, activity {q['activity_db']:.1f} dB)",
         0 if q["ok"] else YELLOW),
    ]
    return lines


def put(win, y, x, text, attr=0):
    h, w = win.getmaxyx()
    if 0 <= y < h and x < w:
        try:
            win.addstr(y, x, text[: max(0, w - x - 1)], attr)
        except curses.error:
            pass


def run(stdscr, items, model, cv, targets):
    curses.curs_set(0)
    curses.use_default_colors()
    if curses.has_colors():
        curses.start_color()
        for n, c in ((GREEN, curses.COLOR_GREEN), (RED, curses.COLOR_RED),
                     (YELLOW, curses.COLOR_YELLOW), (CYAN, curses.COLOR_CYAN)):
            curses.init_pair(n, c, -1)

    clips = {}

    def clip(path):
        if path not in clips:
            clips[path] = co.make_clip(co.load_audio(path))
        return clips[path]

    cursor, top, picks, panel, status = 0, 0, [], [], "Pick recording 1"
    PANEL_H = 11

    while True:
        stdscr.erase()
        h, w = stdscr.getmaxyx()
        if h < PANEL_H + 8 or w < 64:
            put(stdscr, 0, 0, f"Terminal too small ({w}x{h}); need at least 64x{PANEL_H + 8}. q quits.")
            key = stdscr.getch()
            if key in (ord("q"), 27):
                return
            continue

        list_h = h - PANEL_H - 4
        top = max(0, min(top, cursor), cursor - list_h + 1)
        put(stdscr, 0, 0, "Room audio co-location tester", curses.A_BOLD)
        put(stdscr, 1, 0, "Up/Down move | Enter/Space select | c clear | q quit")
        for row in range(list_h):
            i = top + row
            if i >= len(items):
                break
            it = items[i]
            tag = f"[{picks.index(i) + 1}]" if i in picks else "   "
            text = f" {tag} {it['label']:<14} {it['path'].name}"
            attr = curses.A_REVERSE if i == cursor else 0
            if i in picks:
                attr |= curses.color_pair(CYAN) | curses.A_BOLD
            put(stdscr, 3 + row, 0, text.ljust(w - 1), attr)
        if len(items) > list_h:
            put(stdscr, 2, 0, f"  ({cursor + 1}/{len(items)})")

        y0 = h - PANEL_H - 1
        put(stdscr, y0, 0, "-" * (w - 1))
        row = y0 + 1
        for text, col in panel:
            for part in textwrap.wrap(text, w - 2) or [""]:
                if row < h - 1:
                    put(stdscr, row, 1, part, curses.color_pair(col) if col else 0)
                    row += 1
        put(stdscr, h - 1, 0, status.ljust(w - 1), curses.A_BOLD)
        stdscr.refresh()

        key = stdscr.getch()
        if key in (ord("q"), 27):
            return
        elif key in (curses.KEY_DOWN, ord("j")):
            cursor = min(cursor + 1, len(items) - 1)
        elif key in (curses.KEY_UP, ord("k")):
            cursor = max(cursor - 1, 0)
        elif key == curses.KEY_NPAGE:
            cursor = min(cursor + list_h, len(items) - 1)
        elif key == curses.KEY_PPAGE:
            cursor = max(cursor - list_h, 0)
        elif key == curses.KEY_HOME:
            cursor = 0
        elif key == curses.KEY_END:
            cursor = len(items) - 1
        elif key == ord("c"):
            picks, panel, status = [], [], "Cleared. Pick recording 1"
        elif key in (10, 13, curses.KEY_ENTER, ord(" ")):
            if len(picks) == 2:                       # previous result on screen: start over
                picks, panel = [], []
            if cursor in picks:
                picks.remove(cursor)
            else:
                picks.append(cursor)
            if len(picks) == 1:
                status = "Pick recording 2"
            elif len(picks) == 0:
                status = "Pick recording 1"
            else:
                status = "Scoring ..."
                stdscr.addstr(h - 1, 0, status.ljust(w - 1), curses.A_BOLD)
                stdscr.refresh()
                a, b = items[picks[0]], items[picks[1]]
                try:
                    res = co.score_clips(model, clip(a["path"]), clip(b["path"]))
                    panel = describe(a, b, res, targets, co.lookup_cv(cv, a["label"], b["label"]))
                    status = "Done. Enter starts a new pair, c clears, q quits"
                except Exception as exc:              # keep the UI alive on bad files
                    panel = [(f"Could not score: {exc}", RED)]
                    status = "Error. Enter starts a new pair"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default="room-audio-recordings")
    ap.add_argument("--model", default="model_output/model.json")
    args = ap.parse_args()

    if not Path(args.model).exists():
        sys.exit(f"Model not found: {args.model}\nTrain one first:  python3 colocation.py train {args.root}")
    with open(args.model) as fh:
        model = json.load(fh)
    targets = model["targets"]
    items = load_items(Path(args.root), targets)
    if len(items) < 2:
        sys.exit(f"Need at least two recordings under {args.root}")
    cv = co.load_cv_scores(args.model)
    curses.wrapper(run, items, model, cv, targets)


if __name__ == "__main__":
    main()