#!/usr/bin/env python3
"""
blind.py - build a label-stripped A/B pair for the critic.

  python3 blind.py <ours.wav> <reference.wav> --outdir <dir> [--seed N]

Writes into <dir>:

  a.wav          one of the two, in an order drawn from the seed
  b.wav          the other
  features.json  compare.py's output, labelled A and B and nothing else
  report.txt     the same diff as text, for a critic that would rather read
  task.md        what the critic is being asked
  key.json       which is which. THE CRITIC MUST NOT OPEN THIS FILE.

The critic's whole job is to say which of A and B came out of a microphone,
and to name the biggest remaining gap.


WHAT THIS FILE IS GUARDING AGAINST
----------------------------------
A critic that can tell the two apart by anything other than the instrument has
not judged the instrument. So everything downstream of the synthesis is made
identical here, and anything that could not be made identical is written into
features.json under `channel_check` so the critic is told to ignore it rather
than left to find it and feel clever.

  * both files go through one writer, so sample rate, bit depth, header
    layout, chunk order and file size are the same
  * both get the same modification time, so `ls -l` says nothing
  * every absolute path is stripped out of features.json and report.txt -
    a path with the word "render" or "refs" in it gives the whole thing away
  * the A/B order comes from the seed, so a run is reproducible without being
    guessable from the filenames
  * channel features are checked with channelize.compare_pair before anything
    is written, and a leak is reported loudly instead of quietly shipped

blind.py does NOT channelize for you. Feed it a render that has already been
through channelize.py --match <the same reference>. Handing it a dry render
produces a warning and a rig a critic can beat with a noise-floor meter.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from analyze import _jsonable, analyze_wav, load_wav  # noqa: E402
from channelize import (_ref_bit_depth, channel_features,  # noqa: E402
                        compare_channels, format_channel_diff, write_wav)
from compare import build_diff, format_diff  # noqa: E402


TASK_MD = """# Blind A/B: which one is the microphone?

Two 6-second wind chime strikes, `a.wav` and `b.wav`. One is a real recording
of a real chime. One came out of a synthesis engine and was then put through
the real one's transmission channel.

## Your job

1. Say which of A and B is the microphone, and give your confidence.
2. Say what made you decide, feature by feature.
3. Name the single biggest remaining gap in the synthetic one, in a form a
   builder can act on. "Sounds fake" is not actionable. "The 1.5 kHz partial
   decays in 4 s where the real one takes 9" is.

## Rules

- Do not open `key.json`. It holds the answer.
- Do not judge on channel features. Noise floor, spectral tilt above the top
  partial, band edge, codec artefacts, file format, pre-roll and peak level
  were all deliberately equalised, and `features.json -> channel_check`
  records how closely. Anything listed under `known_leaks` there was NOT
  equalised; deciding on it is a technicality, not an answer, and if it is the
  only thing you have, say so plainly instead of dressing it up.
- `features.json` and `report.txt` hold the measured diff. Use them.

## What counts as evidence

Partial frequencies and their ratios. Inharmonicity. T60 per partial and how
T60 scales with frequency. Beating rate and depth. Attack time and shape.
Spectral centroid and how fast the tone darkens. Whether there is a contact
click and how loud it is. Any partial present in one and not the other.
"""


def _scrub(obj, tokens):
    """Remove absolute paths and any identifying substrings, recursively."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k in ("path", "file_path", "source_file", "source_url"):
                continue
            out[k] = _scrub(v, tokens)
        return out
    if isinstance(obj, list):
        return [_scrub(v, tokens) for v in obj]
    if isinstance(obj, str):
        s = obj
        for t in tokens:
            if t and t in s:
                s = s.replace(t, "<redacted>")
        if os.path.sep in s and ("/" == os.path.sep and s.startswith("/")):
            return "<redacted>"
        return s
    return obj


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def make_blind(ours_path, ref_path, outdir, seed=0, exclude=(),
               allow_channel_leak=True, verbose=True):
    os.makedirs(outdir, exist_ok=True)
    rng = np.random.default_rng(seed)

    xo, sro, _ = load_wav(ours_path)
    xr, srr, _ = load_wav(ref_path)
    problems = []
    if sro != srr:
        raise SystemExit("sample rates differ (%d vs %d); channelize first" % (sro, srr))
    if xo.size != xr.size:
        raise SystemExit("lengths differ (%d vs %d samples); channelize matches "
                         "length, so run it first" % (xo.size, xr.size))

    bo, br = _ref_bit_depth(ours_path), _ref_bit_depth(ref_path)
    if bo != br:
        problems.append("input bit depths differed (%s vs %s); both rewritten at "
                        "the deeper one so the files cannot be told apart by size"
                        % (bo, br))
    depth = 24
    for cand in (bo, br):
        if cand == "float32":
            depth = "float32"
            break
        depth = max(depth, int(cand))

    # ---- channel check, before anything is written ------------------------
    fr = channel_features(ref_path, label="reference")
    fo = channel_features(ours_path, label="ours", guard=fr["guard_band_hz"])
    chan = compare_channels(fr, fo)
    if verbose:
        print(format_channel_diff(fr, fo, "reference", "ours", c=chan))
    if chan["leaks"]:
        msg = ("channel features still separate these files: %s. Run "
               "channelize.py on the render against this same reference."
               % ", ".join(chan["leaks"]))
        if not allow_channel_leak:
            raise SystemExit("refusing to build the pair: " + msg)
        problems.append(msg)

    # ---- randomise -------------------------------------------------------
    ours_is_a = bool(rng.integers(0, 2))
    a_src, b_src = (ours_path, ref_path) if ours_is_a else (ref_path, ours_path)
    a_x, b_x = (xo, xr) if ours_is_a else (xr, xo)

    a_path = os.path.join(outdir, "a.wav")
    b_path = os.path.join(outdir, "b.wav")
    write_wav(a_path, a_x, sro, bits=depth, rng=rng)
    write_wav(b_path, b_x, sro, bits=depth, rng=rng)

    sa, sb = os.path.getsize(a_path), os.path.getsize(b_path)
    if sa != sb:
        problems.append("a.wav and b.wav differ in size (%d vs %d bytes)" % (sa, sb))
    stamp = min(os.path.getmtime(a_path), os.path.getmtime(b_path))
    os.utime(a_path, (stamp, stamp))
    os.utime(b_path, (stamp, stamp))

    # ---- features, labelled A and B and nothing else -----------------------
    fa = analyze_wav(a_path)
    fb = analyze_wav(b_path)

    # A bad onset silently corrupts every feature downstream of it, because
    # detect_partials analyses from the onset forward. If the analyser lands in
    # different places in the two files, the whole diff is measuring the
    # detector rather than the chimes, so say so before the critic reads it.
    oa, ob = fa["onset"], fb["onset"]
    cautions = []
    for lbl, o in (("A", oa), ("B", ob)):
        if o.get("onset_detected") is False:
            problems.append("analyze.py found no real attack in %s: %s"
                            % (lbl, o.get("note") or "onset_detected is false"))
        if o.get("peak_is_global") is False:
            cautions.append("in %s the attack peak is not the file's loudest "
                            "point - the level keeps climbing afterwards, which "
                            "is what beating partials do. Not a rig fault, but "
                            "attack-relative numbers in %s are measured from the "
                            "attack, not from the maximum." % (lbl, lbl))
    gap_ms = abs(oa["onset_s"] - ob["onset_s"]) * 1000.0
    if gap_ms > 30.0:
        problems.append("the analyser put the onset %.0f ms apart in A and B "
                        "(%.3f s vs %.3f s); partial detection, T60 and centroid "
                        "are then measured over different stretches of audio and "
                        "the diff is not a like-for-like comparison"
                        % (gap_ms, oa["onset_s"], ob["onset_s"]))

    diff = build_diff(fa, fb, "A", "B")
    text = format_diff(diff, "A", "B")

    tokens = sorted({os.path.abspath(ours_path), os.path.abspath(ref_path),
                     ours_path, ref_path,
                     os.path.basename(ours_path), os.path.basename(ref_path),
                     os.path.splitext(os.path.basename(ours_path))[0],
                     os.path.splitext(os.path.basename(ref_path))[0]},
                    key=len, reverse=True)
    for t in tokens:
        text = text.replace(t, "<redacted>")
    text = "\n".join(ln for ln in text.splitlines()
                     if not ln.startswith(("A  [A]", "B  [B]")))

    channel_check = {
        "note": ("These features were deliberately equalised by channelize.py "
                 "and say nothing about which file is the microphone. Deltas "
                 "are given as magnitudes only, without sign, on purpose. "
                 "Anything under known_leaks was NOT equalised."),
        "equalised": [], "known_leaks": [], "instrument_confounded": [],
    }
    for r in chan["rows"]:
        if r["delta"] is None:
            continue
        rec = {"feature": r["name"], "abs_delta": round(abs(r["delta"]), 3),
               "unit": r["unit"], "tolerance": r["tol"]}
        if not r["pure_channel"]:
            rec["why"] = ("confounded by the instrument; a real difference here "
                          "may be a real instrument difference")
            channel_check["instrument_confounded"].append(rec)
        elif r["leak_units"] > 1.0:
            channel_check["known_leaks"].append(rec)
        else:
            channel_check["equalised"].append(rec)
    w = chan["third_octave_max_abs_delta_db_channel_bands"]
    channel_check["third_octave_worst_abs_delta_db_outside_tonal_region"] = w

    excluded = list(exclude) + [r["feature"] for r in channel_check["known_leaks"]]
    features = {
        "what": "compare.py feature diff for the blind pair. A and B only.",
        "labels": {"a": "a.wav", "b": "b.wav"},
        "seed": int(seed),
        "diff": _scrub(diff, tokens),
        "a_features": _scrub(fa, tokens),
        "b_features": _scrub(fb, tokens),
        "channel_check": channel_check,
        "excluded_evidence": excluded,
        "excluded_evidence_note": ("The loop has ruled these out as evidence for "
                                   "which file is the microphone. A verdict that "
                                   "rests on them is not a verdict."),
        "rig_problems": problems,
        "analysis_cautions": cautions,
    }

    with open(os.path.join(outdir, "features.json"), "w") as f:
        json.dump(_jsonable(features), f, indent=2)
    with open(os.path.join(outdir, "report.txt"), "w") as f:
        f.write(text)
    with open(os.path.join(outdir, "task.md"), "w") as f:
        f.write(TASK_MD)

    key = {
        "WARNING": "The critic must not read this file.",
        "a.wav": "ours" if ours_is_a else "reference",
        "b.wav": "reference" if ours_is_a else "ours",
        "ours_source": os.path.abspath(ours_path),
        "reference_source": os.path.abspath(ref_path),
        "seed": int(seed),
        "sha256": {"a.wav": _sha256(a_path), "b.wav": _sha256(b_path)},
        "channel_leaks": chan["leaks"],
        "rig_problems": problems,
        "analysis_cautions": cautions,
    }
    with open(os.path.join(outdir, "key.json"), "w") as f:
        json.dump(key, f, indent=2)

    # Anything else in the directory is a hazard: a build log, a stray render,
    # a copy of the reference. The critic can read the whole directory.
    expected = {"a.wav", "b.wav", "features.json", "report.txt", "task.md",
                "key.json"}
    strays = sorted(set(os.listdir(outdir)) - expected)
    if strays:
        problems.append("the output directory also holds %s. The critic can read "
                        "the whole directory, so a build log or a stray copy of "
                        "either input hands over the answer. Move them out."
                        % ", ".join(strays))
        with open(os.path.join(outdir, "key.json"), "w") as f:
            json.dump(dict(key, rig_problems=problems), f, indent=2)

    if verbose:
        print("wrote %s" % outdir)
        for n in ("a.wav", "b.wav", "features.json", "report.txt", "task.md", "key.json"):
            p = os.path.join(outdir, n)
            print("  %-14s %8d bytes" % (n, os.path.getsize(p)))
        if problems:
            print("\nRIG PROBLEMS")
            for p in problems:
                print("  - " + p)
        if cautions:
            print("\nANALYSIS CAUTIONS")
            for p in cautions:
                print("  - " + p)
        if excluded:
            print("\nexcluded from the critic's evidence: " + ", ".join(excluded))
    return {"outdir": os.path.abspath(outdir), "ours_is_a": ours_is_a,
            "problems": problems, "cautions": cautions,
            "excluded_evidence": excluded, "channel": chan}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build a label-stripped A/B pair.")
    ap.add_argument("ours")
    ap.add_argument("reference")
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--exclude", action="append", default=[],
                    help="feature name the critic must not use as evidence; repeatable")
    ap.add_argument("--strict", action="store_true",
                    help="refuse to build the pair if any channel feature leaks")
    args = ap.parse_args(argv)
    make_blind(args.ours, args.reference, args.outdir, seed=args.seed,
               exclude=args.exclude, allow_channel_leak=not args.strict)
    return 0


if __name__ == "__main__":
    sys.exit(main())
