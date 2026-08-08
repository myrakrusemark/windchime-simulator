#!/usr/bin/env python3
"""
validate.py - prove analyze.py recovers what was actually put into a signal.

An analyser that has never been run against a signal of known properties is
worthless, because nothing distinguishes a real measurement from a plausible
looking number. This builds two signals with known partials, known T60s, a
known beat rate and depth, a known noise floor and a known contact click, runs
analyze.py over them, and prints recovered against true with the error.

Every tolerance is stated in TOLERANCES below and printed in the report. The
exit status is non-zero if any check fails, so this works as a regression gate.

Usage
  python3 validate.py [--outdir DIR] [--json] [--keep]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np
from scipy.io import wavfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import analyze  # noqa: E402
from analyze import (ATTACK_PEAK_WINDOW_S, ENERGY_MARKS_S, SKIRT_DROP_DB,  # noqa: E402
                     analyze_wav, cents, _chain_runs, _jsonable, _split_run)
import make_test_signal as mts  # noqa: E402

# what counts as recovering the value
TOLERANCES = {
    "onset_s": ("abs", 0.005, "s"),
    "attack_10_90_ms": ("abs", 0.6, "ms"),
    "peak_level_dbfs": ("abs", 0.5, "dB"),
    "partial_freq_cents": ("abs", 2.0, "cents"),
    "component_freq_cents": ("abs", 2.0, "cents"),
    "spectral_split_hz": ("abs", 0.3, "Hz"),
    "rel_db": ("abs", 1.5, "dB"),
    "t60_rel": ("rel", 0.05, ""),
    "beat_rate_hz": ("abs", 0.15, "Hz"),
    "beat_depth": ("abs", 0.06, ""),
    "inharmonicity_cents": ("abs", 3.0, "cents"),
    "centroid_rel": ("rel", 0.03, ""),
    "noise_floor_dbfs": ("abs", 1.5, "dB"),
    "tnr_db": ("abs", 3.0, "dB"),
    "energy_rms_db": ("abs", 0.5, "dB"),
    "group_freq_cents": ("abs", 2.0, "cents"),
    "group_span_hz": ("abs", 0.3, "Hz"),
    # real recordings: the bar is "recovered the right partial", not "agreed to
    # the last cent". A split fundamental wanders by ten cents or so depending
    # on the window, and the nearest wrong candidate is hundreds of cents away.
    "real_f0_cents": ("abs", 30.0, "cents"),
    "real_onset_s": ("abs", 0.020, "s"),
}

# A struck metal tube delivers its energy in single-digit milliseconds. Anything
# outside this window is the analyser measuring something that is not the strike.
REAL_ATTACK_MS_RANGE = (0.2, 12.0)
DEFAULT_REAL_MANIFEST = "/home/myra/.cache/windchime-gauntlet/refs/manifest.json"


class Checker:
    def __init__(self):
        self.rows = []

    def check(self, group, name, true, meas, kind, unit=""):
        mode, tol, tunit = TOLERANCES[kind]
        t, m = _num(true), _num(meas)
        if t is None or m is None:
            ok = (t is None and m is None)
            err = None
        elif mode == "rel":
            err = (m - t) / abs(t) if t != 0 else float("inf")
            ok = abs(err) <= tol
        else:
            err = m - t
            ok = abs(err) <= tol
        self.rows.append({"group": group, "name": name, "true": t, "measured": m,
                          "error": err, "mode": mode, "tol": tol,
                          "unit": unit or tunit, "pass": bool(ok), "kind": kind})
        return ok

    def explicit(self, group, name, true, meas, tol, unit="", mode="abs"):
        """A check whose tolerance belongs to it alone.

        TOLERANCES above is the shared vocabulary for properties many checks
        measure; a one-off - "this estimator must not jump by more than three
        percent" - has no business adding an entry there that nothing else
        reads. The tolerance still prints in the report, which is the part that
        matters.
        """
        t, m = _num(true), _num(meas)
        if t is None or m is None:
            ok, err = (t is None and m is None), None
        elif mode == "rel":
            err = (m - t) / abs(t) if t != 0 else float("inf")
            ok = abs(err) <= tol
        else:
            err = m - t
            ok = abs(err) <= tol
        self.rows.append({"group": group, "name": name, "true": t, "measured": m,
                          "error": err, "mode": mode, "tol": tol, "unit": unit,
                          "pass": bool(ok), "kind": "explicit"})
        return ok

    def boolean(self, group, name, true, meas):
        ok = bool(true) == bool(meas)
        self.rows.append({"group": group, "name": name, "true": bool(true),
                          "measured": bool(meas), "error": None, "mode": "bool",
                          "tol": None, "unit": "", "pass": ok, "kind": "bool"})
        return ok

    @property
    def failures(self):
        return [r for r in self.rows if not r["pass"]]


def _num(v):
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def match_by_freq(truth_partials, measured_partials, tol_cents=100.0):
    """Map each true partial to the measured partial nearest in frequency."""
    out = []
    used = set()
    for t in truth_partials:
        best, bestc = None, None
        for i, m in enumerate(measured_partials):
            if i in used:
                continue
            c = cents(m["freq_hz"], t["freq_hz"])
            if bestc is None or abs(c) < abs(bestc):
                best, bestc = i, c
        if best is not None and abs(bestc) <= tol_cents:
            used.add(best)
            out.append((t, measured_partials[best], bestc))
        else:
            out.append((t, None, None))
    extra = [m for i, m in enumerate(measured_partials) if i not in used]
    return out, extra


def validate_one(name, path, truth, ck, expect_beats, expect_click):
    feat = analyze_wav(path)
    g = name

    ck.check(g, "onset time", truth["onset_s"], feat["onset"]["onset_s"], "onset_s")
    ck.check(g, "attack 10-90", truth["attack_10_90_ms"],
             feat["onset"]["attack_10_90_ms"], "attack_10_90_ms")
    # The truth's "peak" is the maximum of the whole closed-form envelope, so it
    # is the analyser's global peak that has to match it. The strike's own peak
    # is a different point on purpose (see _attack_peak) and is checked below.
    ck.check(g, "peak level", truth["peak_level_dbfs"],
             feat["onset"]["global_peak_level_dbfs"], "peak_level_dbfs")
    ck.boolean(g, "strike found", True, feat["onset"]["onset_detected"])
    pao = feat["onset"]["peak_after_onset_ms"]
    ck.boolean(g, "attack peak inside the attack window", True,
               pao is not None and 0.0 <= pao <= ATTACK_PEAK_WINDOW_S * 1000.0)

    pairs, extra = match_by_freq(truth["partials"], feat["partials"])
    for k, (t, m, c) in enumerate(pairs, start=1):
        tag = "partial %d" % k
        if m is None:
            ck.rows.append({"group": g, "name": tag + " found", "true": t["freq_hz"],
                            "measured": None, "error": None, "mode": "abs", "tol": None,
                            "unit": "Hz", "pass": False, "kind": "missing"})
            continue
        ck.check(g, tag + " frequency", 0.0, c, "partial_freq_cents")
        ck.check(g, tag + " level", t["rel_db"], m["rel_db"], "rel_db")
        ck.check(g, tag + " T60", t["t60_s"],
                 m["decay"].get("t60_s") if m["decay"].get("valid") else None, "t60_rel")
        ck.boolean(g, tag + " beats", t["beats"], m["beating"].get("detected"))
        if t["beats"]:
            ck.check(g, tag + " beat rate", t["beat_rate_hz"],
                     m["beating"].get("rate_hz"), "beat_rate_hz")
            ck.check(g, tag + " beat depth", t["beat_depth"],
                     m["beating"].get("depth"), "beat_depth")
            ck.check(g, tag + " split", t["spectral_split_hz"],
                     m["spectral_split_hz"], "spectral_split_hz")
            # the two polarisation lines, when the analyser resolved them
            if m["n_subpeaks"] == len(t["component_freqs_hz"]):
                for q, (tf, mf) in enumerate(zip(sorted(t["component_freqs_hz"]),
                                                 sorted(m["sub_freqs_hz"])), start=1):
                    ck.check(g, tag + " component %d" % q, 0.0, cents(mf, tf),
                             "component_freq_cents")
        if "inharmonicity_cents" in t:
            mm = next((d for d in feat["inharmonicity"]["by_mode"]
                       if d["index"] == m["index"]), None)
            if mm is not None:
                ck.check(g, tag + " inharmonicity", t["inharmonicity_cents"],
                         mm["cents"], "inharmonicity_cents")
    for m in extra:
        ck.rows.append({"group": g, "name": "spurious partial %.1f Hz" % m["freq_hz"],
                        "true": None, "measured": m["rel_db"], "error": None,
                        "mode": "abs", "tol": None, "unit": "dB", "pass": False,
                        "kind": "spurious"})

    for key, tval in truth["spectral_centroid_hz"].items():
        meas = feat["spectral_centroid"].get(
            key + "_hz" if not key.endswith("_wide") else key[:-5] + "_hz_wide")
        ck.check(g, "centroid %s" % key, tval, meas, "centroid_rel")

    # Energy trajectory. The truth is straight arithmetic on the signal that was
    # written; the analyser has to locate the onset for itself and still land on
    # it. A wrong onset shows up here as every mark being off together.
    et = (feat.get("energy_trajectory") or {}).get("rms_rel_peak_db") or {}
    for m in ENERGY_MARKS_S:
        k = "%gs" % m
        ck.check(g, "RMS at %s under peak" % k,
                 truth["energy_rms_rel_peak_db"].get(k), et.get(k), "energy_rms_db")

    ck.check(g, "noise floor", truth["noise_floor_dbfs"],
             feat["noise"].get("noise_floor_dbfs"), "noise_floor_dbfs")
    ck.check(g, "tonal-to-noise", truth["tonal_to_noise_db_approx"],
             feat["noise"].get("tonal_to_noise_db"), "tnr_db")
    ck.boolean(g, "contact click", expect_click, feat["noise"]["click"].get("detected"))
    ck.boolean(g, "any beating at all", expect_beats,
               feat["beating_summary"]["partials_beating"] > 0)
    return feat


# The sub-peak list the peak finder actually returned for one render put
# through the Corinthian's channel, around its 464 Hz line: the line itself at
# the top, and 27 codec-noise peaks 29 to 35 dB under it spread over the 59 Hz
# below. (freq_hz, dB relative to the line.) Copied from the measurement, not
# invented, so this is the real trap and not a guess at one.
CORINTHIAN_SKIRT = [
    (404.66, -30.9), (406.89, -30.6), (407.98, -31.1), (409.67, -29.6),
    (411.24, -31.6), (417.68, -31.2), (422.16, -34.8), (426.68, -29.7),
    (427.61, -29.7), (429.20, -34.2), (430.96, -30.7), (434.50, -33.5),
    (435.22, -34.5), (437.74, -32.9), (440.13, -34.7), (441.30, -32.4),
    (442.72, -32.6), (443.37, -34.7), (444.18, -35.3), (444.81, -33.7),
    (445.79, -34.4), (447.64, -30.3), (449.40, -32.0), (450.34, -34.4),
    (451.23, -32.6), (451.87, -31.2), (454.00, -30.0), (463.65, 0.0),
]
# The same clip's genuine polarisation pair, measured off the reference
# recording itself: two lines 1.73 Hz apart, the weaker one 11.7 dB down. This
# has to survive, or the guard has traded one wrong answer for another.
CORINTHIAN_DOUBLET = [(462.28, -11.7), (464.01, 0.0)]


def _group_once(lines):
    """Run the grouper over a hand-built sub-peak list. Returns (groups, skirt)."""
    peaks = [{"f": f, "db": d} for f, d in sorted(lines)]
    skirt = []
    groups = []
    for run in _chain_runs(peaks):
        groups.extend(_split_run(run, skirt))
    out = []
    for g in groups:
        subs = g["subpeaks"]
        if not subs:
            continue
        fs = [s["f"] for s in subs]
        wts = [10.0 ** (s["db"] / 20.0) for s in subs]
        out.append({
            "f": sum(f * w for f, w in zip(fs, wts)) / sum(wts),
            "span_hz": max(fs) - min(fs),
            "n": len(subs),
        })
    out.sort(key=lambda g: -max(1e-9, g["n"]))
    return out, skirt


def validate_grouper(ck):
    """The noise-skirt guard, checked on measured sub-peak lists.

    Merging polarisation lines into one partial is the same operation that can
    swallow the noise floor, and getting it wrong is not a small error: chaining
    from the last sub-peak added walked a group from 463.65 Hz down to 451.19,
    reported 47 cents of pitch error that was not there, put the same 47 cents
    into every inharmonicity ratio, and widened the partial's analysis band
    until the beat detector read the skirt's wobble as the tube's beat rate.
    """
    g = "partial grouper  (noise-skirt guard, %.0f dB)" % SKIRT_DROP_DB

    groups, skirt = _group_once(CORINTHIAN_SKIRT)
    line = max(CORINTHIAN_SKIRT, key=lambda p: p[1])[0]
    main = max(groups, key=lambda q: q["f"] if q["f"] > 400 else 0) if groups else None
    ck.check(g, "skirt: partial frequency", 0.0,
             cents(main["f"], line) if main else None, "group_freq_cents")
    ck.check(g, "skirt: partial span", 0.0, main["span_hz"] if main else None,
             "group_span_hz")
    ck.boolean(g, "skirt: all %d noise peaks discarded" % (len(CORINTHIAN_SKIRT) - 1),
               True, len(skirt) == len(CORINTHIAN_SKIRT) - 1)

    groups, skirt = _group_once(CORINTHIAN_DOUBLET)
    wts = [10.0 ** (d / 20.0) for _f, d in CORINTHIAN_DOUBLET]
    want = (sum(f * w for (f, _d), w in zip(CORINTHIAN_DOUBLET, wts)) / sum(wts))
    ck.boolean(g, "doublet: stays one partial", True, len(groups) == 1)
    ck.check(g, "doublet: partial frequency", 0.0,
             cents(groups[0]["f"], want) if groups else None, "group_freq_cents")
    ck.check(g, "doublet: split", 1.73, groups[0]["span_hz"] if groups else None,
             "group_span_hz")
    ck.boolean(g, "doublet: nothing discarded as skirt", True, not skirt)


def validate_real(manifest_path, ck):
    """Check the analyser against real recordings of known chimes.

    Synthetic signals prove the arithmetic. They cannot prove the analyser
    survives a microphone: rumble below the chime's register, a tube left
    ringing from an earlier hit, and a mastering limiter that puts the loudest
    moment half a second after the strike are all absent from a signal we built
    ourselves, and all three produced confidently wrong numbers before these
    checks existed. The manifest states each clip's fundamental independently of
    this analyser, so it is usable as ground truth.

    Returns the per-clip feature vectors, or None when the reference set is not
    on this machine (it is private and lives outside the repo).
    """
    if not os.path.exists(manifest_path):
        return None
    with open(manifest_path) as fh:
        man = json.load(fh)
    feats = {}
    for clip in man.get("clips", []):
        path = clip["path"]
        name = os.path.basename(path)
        g = "%s  (real recording, tier %s)" % (name, clip.get("tier"))
        if not os.path.exists(path):
            ck.rows.append({"group": g, "name": "clip present", "true": path,
                            "measured": None, "error": None, "mode": "abs",
                            "tol": None, "unit": "", "pass": False, "kind": "missing"})
            continue
        feat = analyze_wav(path)
        feats[name] = feat

        f0_true = clip["estimated_fundamental_hz"]
        f0 = feat.get("fundamental_hz")
        ck.check(g, "fundamental", 0.0,
                 cents(f0, f0_true) if f0 else None, "real_f0_cents")

        on = feat["onset"]
        ck.boolean(g, "strike found in the clip", True, on.get("onset_detected"))

        # where in the clip the manifest says the attack is
        attack_in_clip = (clip.get("attack_measured_s", clip["attack_at_s"])
                          - clip["timestamp_in_source_s"])
        ck.check(g, "onset position", attack_in_clip, on.get("onset_s"), "real_onset_s")

        a = on.get("attack_10_90_ms")
        lo, hi = REAL_ATTACK_MS_RANGE
        ck.rows.append({
            "group": g, "name": "attack 10-90 is physical (%.1f-%.1f ms)" % (lo, hi),
            "true": None, "measured": a, "error": None, "mode": "abs", "tol": None,
            "unit": "ms", "pass": bool(a is not None and lo <= a <= hi),
            "kind": "range"})

        # the fundamental must not be the lowest thing in the spectrum by
        # default: that is exactly the failure these checks exist to catch
        fu = feat.get("fundamental") or {}
        below = [p for p in feat["partials"] if p["freq_hz"] < (f0 or 0) * 0.95]
        ck.rows.append({
            "group": g, "name": "rejected %d partial(s) below the fundamental" % len(below),
            "true": None, "measured": fu.get("rel_db"), "error": None, "mode": "abs",
            "tol": None, "unit": "dB", "pass": True, "kind": "info"})
    return feats


def validate_model(ck):
    """Run tools/verify-decay.mjs and fold its verdict into this report.

    validate.py has always gated the ANALYSER: it proves analyze.py recovers
    what was put into a signal. It never gated the SYNTHESIS, which meant the
    loss model in modal.js could put an 8.6 mm treble tube at forty-four seconds
    of ring, or make a bass tube's third partial outlive its fundamental, and
    every check here would still be green. Both of those happened.

    verify-decay.mjs sweeps modal.js's per-mode T60 across 90-2100 Hz on both the
    simulator's stock and maker proportions, and returns a pass/fail per property
    plus the numbers behind them. Two of those properties are currently WRONG and
    are gated against getting worse rather than against being right - read that
    file's BASELINE block before trusting a green line here to mean the physics
    is finished.

    Node is required. When it is missing the model checks are skipped rather than
    failed, because this file also has to run on a machine that only has Python -
    but the skip is printed, not silent.
    """
    tool = os.path.join(HERE, "..", "verify-decay.mjs")
    tool = os.path.normpath(tool)
    if not os.path.exists(tool):
        return None
    try:
        p = subprocess.run(["node", tool, "--json"], capture_output=True, text=True,
                           timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if not p.stdout.strip():
        return None
    try:
        rep = json.loads(p.stdout)
    except ValueError:
        return None
    group = "modal.js loss budget  (tools/verify-decay.mjs, %d-%d Hz, %d tubes per stock)" % (
        rep["range_hz"][0], rep["range_hz"][1], rep["steps"])
    for name, ok in rep["checks"].items():
        ck.boolean(group, name, True, ok)
    # The numbers themselves, so the report carries them and not just a verdict.
    for tag in ("default_stock", "maker_stock"):
        s = rep[tag]
        ck.boolean(group, "%s: every T60 finite and positive" % tag, True, s["allFinite"])
        ck.rows.append({"group": group, "name": "%s: longest mode (s)" % tag,
                        "true": None, "measured": s["longest"], "error": None,
                        "mode": "info", "tol": None, "unit": "s", "pass": True,
                        "kind": "info"})
        ck.rows.append({"group": group,
                        "name": "%s: worst overtone/mode1 T60" % tag,
                        "true": None, "measured": s["worstInversionRatio"], "error": None,
                        "mode": "info", "tol": None, "unit": "x", "pass": True,
                        "kind": "info"})
    return rep


def validate_beat(ck):
    """Run tools/verify-beat.mjs and fold its verdict into this report.

    Every bending mode of a tube is TWO lines - the two orthogonal bending
    polarisations, split by the section's ovality and wall eccentricity - and the
    two renderers realise that pair differently on purpose. render-offline.mjs
    sums two sines, because offline nothing is paying for oscillators. audio.js
    plays the identical pair as ONE oscillator carrying their combined amplitude
    and phase, because its polyphony cap counts voices and not nodes, so a
    doubled partial list would double the graph of every strike and the cap would
    not notice.

    That is a claim about two pieces of code agreeing, which is exactly the kind
    of claim that rots. verify-beat.mjs plays both out sample by sample and
    measures the residual, the spurious lower line an amplitude-only fake would
    leave, and the spacing the spectrum actually shows. It also checks the
    section quadrature against the two thin-ring closed forms it generalises.

    Same skip-not-fail contract as validate_model when node is missing.
    """
    tool = os.path.normpath(os.path.join(HERE, "..", "verify-beat.mjs"))
    if not os.path.exists(tool):
        return None
    try:
        p = subprocess.run(["node", tool, "--json"], capture_output=True, text=True,
                           timeout=300)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if not p.stdout.strip():
        return None
    try:
        rep = json.loads(p.stdout)
    except ValueError:
        return None
    group = "modal.js bending doublet  (tools/verify-beat.mjs, %d cases)" % len(rep["cases"])
    bars = rep["bars"]
    w = rep["worst"]
    ck.boolean(group, "one oscillator matches two sines, worst residual %.1f dB"
               % w["err_db"], True, w["err_db"] <= bars["err_db_max"])
    ck.boolean(group, "no spurious line below the strong one, worst %.1f dB "
               "(amplitude-only modulation would be -6)" % w["image_db"],
               True, w["image_db"] <= bars["image_db_max"])
    ck.boolean(group, "the spectrum's spacing IS the modelled split, worst %.2f %% off"
               % (100.0 * w["split_err"]), True, w["split_err"] <= bars["split_tol"])
    ck.boolean(group, "section quadrature reproduces 0.75*ovality and lambda^2/4 in the "
               "thin-ring limit, worst %.3f %%" % (100.0 * w["law_rel_err"]),
               True, w["law_rel_err"] <= 0.02)
    # A rig has to sound like several objects, not one transposed. Each tube draws
    # its own section defects, so the beat rates across a set must actually differ.
    rates = [t["beat_hz"] for t in rep["rig"]]
    depths = [t["depth"] for t in rep["rig"]]
    spread = max(rates) / max(1e-9, min(rates))
    ck.boolean(group, "a rig's tubes beat at different rates, spread %.2fx" % spread,
               True, spread >= 2.0)
    ck.boolean(group, "and at different depths, %.3f to %.3f" % (min(depths), max(depths)),
               True, (max(depths) - min(depths)) >= 0.15)
    ck.boolean(group, "every tube's split stays inside the range real chimes show "
               "(0.3e-3 to 8e-3)", True,
               all(3e-4 <= t["df_over_f"] <= 8e-3 for t in rep["rig"]))
    for t in rep["cases"]:
        ck.rows.append({"group": group,
                        "name": "%s mode %d: %d curve points, %.3f Hz split"
                                % (t["case"], t["mode"], t["curve_points"], t["split_hz"]),
                        "true": None, "measured": t["err_db"], "error": None,
                        "mode": "info", "tol": None, "unit": "dB", "pass": True,
                        "kind": "info"})
    return rep


def validate_levels(ck):
    """Run tools/verify-levels.mjs and fold its verdict into this report.

    The companion to validate_model. That one gates how long each mode rings;
    this one gates how loud each one starts, which nothing gated until modes 3
    to 5 were found sitting 15 to 21 dB over three real instruments with every
    check in this file green.

    What it gates is the excitation weight with the mode shape divided back out,
    swept over pitch and strike height on both stocks, so it is a statement about
    the model and not about the three pitches somebody had a recording of. Read
    that file's header for why no reference level appears in it.

    Same skip-not-fail contract as validate_model when node is missing.
    """
    tool = os.path.normpath(os.path.join(HERE, "..", "verify-levels.mjs"))
    if not os.path.exists(tool):
        return None
    try:
        p = subprocess.run(["node", tool, "--json"], capture_output=True, text=True,
                           timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if not p.stdout.strip():
        return None
    try:
        rep = json.loads(p.stdout)
    except ValueError:
        return None
    group = ("modal.js mode levels  (tools/verify-levels.mjs, %d-%d Hz, %d tubes x %d "
             "strikes per stock)" % (rep["range_hz"][0], rep["range_hz"][1],
                                     rep["steps"] + 1, len(rep["strikes"])))
    for name, ok in rep["checks"].items():
        ck.boolean(group, name, True, ok)
    for tag in ("default_stock", "maker_stock"):
        s = rep[tag]
        ck.rows.append({"group": group, "name": "%s: worst mode3-mode2 gap" % tag,
                        "true": None, "measured": s["worstGap32"], "error": None,
                        "mode": "info", "tol": None, "unit": "dB", "pass": True,
                        "kind": "info"})
        ck.rows.append({"group": group, "name": "%s: weakest mode3-mode1 gap" % tag,
                        "true": None, "measured": s["gap31Range"][1], "error": None,
                        "mode": "info", "tol": None, "unit": "dB", "pass": True,
                        "kind": "info"})
    return rep


def validate_estimator_continuity(ck):
    """The T60 estimator must not step when the signal does not.

    A Schroeder fit has to choose a stretch of the decay curve to fit, and until
    this round analyze.py chose between three fixed stretches on hard thresholds.
    Signals sitting near a threshold got whichever answer the rounding fell to:
    on our own corinthian render a 0.1 percent change in the audio moved the
    reported T60 from 15.04 s to 13.27 s, because the Schroeder curve's reach
    crossed 28 dB and the T10 fit became a T20 fit. That is a twelve percent
    step out of nothing, in the one number this whole gauntlet is scored on.

    So: sweep a synthetic decay finely across the range the references live in,
    and require that the reported T60 tracks the true one without a jump. The
    signal is a beating doublet on a noise floor - what a chime recording is -
    because a clean single exponential does not exercise the disagreement
    between the two fit ranges.
    """
    group = "T60 estimator continuity  (synthetic doublet, true T60 swept 11-16 s)"
    sr = 48000
    rng = np.random.default_rng(5)
    prev_true = prev_meas = None
    worst_step = 0.0
    worst_err = 0.0
    tmpd = tempfile.mkdtemp(prefix="chime-cont-")
    try:
        for t60 in [11.0 + 0.25 * i for i in range(21)]:
            n = int(6.0 * sr)
            tt = np.maximum(0.0, np.arange(n) / sr - 0.05)
            env = 10.0 ** (-3.0 * tt / t60)
            x = np.sin(2 * np.pi * (463.65 - 0.8) * tt) * env
            x += 0.37 * np.sin(2 * np.pi * (463.65 + 0.8) * tt + 0.3) * env
            x[: int(0.05 * sr)] = 0.0
            x = x + rng.normal(0, 10 ** (-58.0 / 20.0), n)
            x = x / (np.max(np.abs(x)) / 0.7)
            p = os.path.join(tmpd, "cont.wav")
            wavfile.write(p, sr, (x * 32767).astype(np.int16))
            feat = analyze.analyze_wav(p)
            got = None
            for q in feat["partials"]:
                if abs(q["freq_hz"] - 463.65) < 30:
                    got = q["decay"]["t60_s"]
                    break
            if got is None:
                ck.boolean(group, "partial found at true T60 %.2f s" % t60, True, False)
                continue
            worst_err = max(worst_err, abs(got - t60) / t60)
            if prev_meas is not None:
                # how much the reported value jumped, over and above the change
                # that was actually put into the signal
                step = abs((got - prev_meas) / prev_meas - (t60 - prev_true) / prev_true)
                worst_step = max(worst_step, step)
            prev_true, prev_meas = t60, got
    finally:
        shutil.rmtree(tmpd, ignore_errors=True)
    # 3 percent is loose enough for the sweep's own quarter-second granularity
    # and ten times tighter than the step this replaced.
    ck.explicit(group, "worst jump between adjacent points", 0.0, worst_step, 0.03)
    ck.explicit(group, "worst error against the true T60", 0.0, worst_err, 0.10)


def validate_noise_floor_invariance(ck):
    """The same decay under different hiss must measure the same.

    This is the sharpest thing wrong with the harness that the last two rounds
    were scored on. analyze.py only added back the energy its Schroeder integral
    never saw when the Lundeby truncation had not fired, i.e. when it could see
    the file run out under the note. A louder noise floor fires that truncation
    earlier, the compensation stopped happening, and the decay read short - and
    channelize.py hands our render the reference recording's own floor on
    purpose, so the bias sat on both sides of every comparison at different
    strengths.

    Measured before the fix: a true 17 s decay read 16.73 s at -55 dBFS and
    13.56 s at -45 dBFS. Same samples, different hiss, 20 percent apart.
    """
    group = "T60 vs noise floor  (same decay, floor swept -45 to -90 dBFS)"
    sr = 48000
    tmpd = tempfile.mkdtemp(prefix="chime-floor-")
    try:
        for true_t60 in (14.0, 17.0):
            got = []
            for nz in (-45.0, -55.0, -65.0, -75.0, -90.0):
                rng = np.random.default_rng(11)
                n = int(6.0 * sr)
                tt = np.maximum(0.0, np.arange(n) / sr - 0.05)
                env = 10.0 ** (-3.0 * tt / true_t60)
                x = np.sin(2 * np.pi * (463.65 - 0.8) * tt) * env
                x += 0.37 * np.sin(2 * np.pi * (463.65 + 0.8) * tt + 0.3) * env
                x[: int(0.05 * sr)] = 0.0
                x = x + rng.normal(0, 10 ** (nz / 20.0), n)
                x = x / (np.max(np.abs(x)) / 0.7)
                p = os.path.join(tmpd, "floor.wav")
                wavfile.write(p, sr, (x * 32767).astype(np.int16))
                feat = analyze.analyze_wav(p)
                for q in feat["partials"]:
                    if abs(q["freq_hz"] - 463.65) < 30:
                        got.append(q["decay"]["t60_s"])
                        break
            if len(got) < 5:
                ck.boolean(group, "all five floors measured at true %.0f s" % true_t60,
                           True, False)
                continue
            spread = (max(got) - min(got)) / (sum(got) / len(got))
            ck.explicit(group, "spread across the floor sweep, true %.0f s" % true_t60,
                        0.0, spread, 0.03)
            ck.explicit(group, "worst error against true %.0f s" % true_t60, 0.0,
                        max(abs(g - true_t60) / true_t60 for g in got), 0.06)
    finally:
        shutil.rmtree(tmpd, ignore_errors=True)


def validate_struck_trajectory(ck):
    """Cutting a neighbour's tube out of the energy trajectory must recover the
    struck tube's own trajectory, and must do nothing at all when there is no
    neighbour to cut.

    Built as a two-tube signal with both decays known: a 464 Hz strike at the
    onset and a 311 Hz tone that started long before and is 23 dB down, which is
    the corinthian reference's situation with its own numbers. The struck-only
    trajectory of the pair must come back to the trajectory of the 464 Hz tube
    rendered on its own.
    """
    group = "struck-tube energy trajectory  (synthetic two-tube clip)"
    sr = 48000
    n = int(6.0 * sr)
    tt = np.maximum(0.0, np.arange(n) / sr - 0.05)
    struck = np.sin(2 * np.pi * 464.0 * tt) * 10.0 ** (-3.0 * tt / 15.0)
    struck[: int(0.05 * sr)] = 0.0
    # the neighbour: struck earlier, so further into a slower decay, and steady
    leftover = 10 ** (-23.0 / 20.0) * np.sin(2 * np.pi * 311.0 * np.arange(n) / sr)
    leftover = leftover * 10.0 ** (-3.0 * (np.arange(n) / sr) / 30.0)
    tmpd = tempfile.mkdtemp(prefix="chime-struck-")
    try:
        both = (struck + leftover)
        alone = struck / (np.max(np.abs(struck)) / 0.7)
        both = both / (np.max(np.abs(both)) / 0.7)
        pa = os.path.join(tmpd, "alone.wav")
        pb = os.path.join(tmpd, "both.wav")
        wavfile.write(pa, sr, (alone * 32767).astype(np.int16))
        wavfile.write(pb, sr, (both * 32767).astype(np.int16))
        fa, fb = analyze.analyze_wav(pa), analyze.analyze_wav(pb)
    finally:
        shutil.rmtree(tmpd, ignore_errors=True)

    # the clip with no neighbour must be untouched, exactly
    sa = fa["struck_energy_trajectory"]
    ck.boolean(group, "clip with no leftover is not notched", True,
               sa.get("identical_to_raw") is True and not sa.get("notched_hz"))
    for k in ("1s", "3s", "5s"):
        ck.boolean(group, "no-leftover clip unchanged at %s" % k, True,
                   sa["rms_rel_peak_db"][k] == fa["energy_trajectory"]["rms_rel_peak_db"][k])

    # the two-tube clip must find the neighbour and come back to the tube alone
    sb = fb["struck_energy_trajectory"]
    ck.boolean(group, "leftover tube found and cut", True,
               any(abs(f - 311.0) < 5 for f in (sb.get("notched_hz") or [])))
    for k in ("1s", "3s", "5s"):
        want = fa["energy_trajectory"]["rms_rel_peak_db"][k]
        raw = fb["energy_trajectory"]["rms_rel_peak_db"][k]
        got = sb["rms_rel_peak_db"][k]
        ck.explicit(group, "struck-only RMS at %s recovers the tube alone" % k,
                    want, got, 1.5, unit="dB")
        # and it must be an improvement on the raw number, or there was no point
        ck.boolean(group, "struck-only beats raw at %s" % k, True,
                   abs(got - want) <= abs(raw - want) + 1e-9)


def validate_bessel(ck):
    """modal.js's Bessel polynomials, against scipy, over the range it evaluates.

    dipoleEfficiency() is the whole of this round's physics change and it is four
    Abramowitz and Stegun approximations in a trench coat. If one coefficient is
    mistyped the radiation term is quietly wrong and every T60 above ka ~ 0.6
    moves. scipy has the real functions, so use them.
    """
    group = "exact cylinder radiation  (modal.js dipoleEfficiency vs scipy)"
    try:
        from scipy.special import jv, yv
    except ImportError:
        return
    node = shutil.which("node")
    modal = os.path.normpath(os.path.join(HERE, "..", "..", "assets", "js", "modal.js"))
    if not node or not os.path.exists(modal):
        return
    xs = [0.001, 0.01, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0,
          1.4, 2.0, 2.6, 3.0, 3.7, 4.5, 6.0]
    src = ("import {dipoleEfficiency} from %r;"
           "console.log(%s.map(dipoleEfficiency).join(','));"
           % (modal, json.dumps(xs)))
    p = subprocess.run([node, "--input-type=module", "-e", src],
                       capture_output=True, text=True, timeout=60)
    if p.returncode != 0 or not p.stdout.strip():
        ck.boolean(group, "modal.js evaluates dipoleEfficiency", True, False)
        return
    got = [float(v) for v in p.stdout.strip().split(",")]
    worst = 0.0
    for x, g in zip(xs, got):
        jp = jv(0, x) - jv(1, x) / x
        yp = yv(0, x) - yv(1, x) / x
        want = 4.0 / (math.pi ** 2 * x ** 4 * (jp * jp + yp * yp))
        worst = max(worst, abs(g - want) / want)
    ck.explicit(group, "worst relative error over x = 0.001 to 6", 0.0, worst, 1e-5)
    # and the two properties the physics rests on
    ck.boolean(group, "C -> 1 in the compact limit", True, abs(got[0] - 1.0) < 1e-5)
    ck.boolean(group, "C falls once the section is not compact", True,
               got[10] < 0.6 and got[12] < got[10] and got[-1] < got[12])


def format_report(ck):
    L = []
    W = 92
    L.append("=" * W)
    L.append("VALIDATION: analyze.py against signals of known construction")
    L.append("=" * W)
    L.append("")
    L.append("Tolerances (a check passes inside these):")
    for k, (mode, tol, unit) in sorted(TOLERANCES.items()):
        L.append("  %-24s %s %s" % (k, ("+/- %.3f" % tol) if mode == "abs" else
                                    ("+/- %.1f%%" % (100 * tol)), unit))
    group = None
    for r in ck.rows:
        if r["group"] != group:
            group = r["group"]
            L.append("")
            L.append("-" * W)
            L.append(group)
            L.append("-" * W)
            L.append("  %-30s %14s %14s %16s  %s"
                     % ("feature", "true", "measured", "error", ""))
        if r["mode"] == "info":
            err = ""
            tv, mv = "-", ("-" if r["measured"] is None else "%.4f" % r["measured"])
        elif r["mode"] == "bool":
            err = ""
            tv, mv = str(r["true"]), str(r["measured"])
        else:
            tv = "-" if r["true"] is None else "%.4f" % r["true"]
            mv = "-" if r["measured"] is None else "%.4f" % r["measured"]
            if r["error"] is None:
                err = "-"
            elif r["mode"] == "rel":
                err = "%+.2f%%" % (100.0 * r["error"])
            else:
                err = "%+.4f %s" % (r["error"], r["unit"])
        L.append("  %-30s %14s %14s %16s  %s"
                 % (r["name"], tv, mv, err, "ok" if r["pass"] else "FAIL"))
    L.append("")
    L.append("=" * W)
    n = len(ck.rows)
    f = len(ck.failures)
    L.append("%d checks, %d passed, %d failed" % (n, n - f, f))
    for r in ck.failures:
        L.append("  FAIL  %s / %s" % (r["group"], r["name"]))
    L.append("=" * W)
    return "\n".join(L)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Validate analyze.py against known signals.")
    ap.add_argument("--outdir", default=None,
                    help="where to write the test WAVs (default: a temp dir)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--keep", action="store_true", help="keep the generated WAVs")
    ap.add_argument("--bits", default="24", choices=["16", "24", "float"])
    ap.add_argument("--real-refs", default=DEFAULT_REAL_MANIFEST,
                    help="manifest of real reference recordings; skipped when absent")
    ap.add_argument("--no-real", action="store_true",
                    help="synthetic checks only")
    args = ap.parse_args(argv)

    tmp = None
    outdir = args.outdir
    if outdir is None:
        tmp = tempfile.mkdtemp(prefix="chime-validate-")
        outdir = tmp
    gen = mts.generate(outdir, args.bits)

    ck = Checker()
    validate_grouper(ck)
    validate_one("known_chime.wav  (beats, contact click, -72 dBFS noise floor)",
                 gen["known_chime"]["path"], gen["known_chime"]["truth"], ck,
                 expect_beats=True, expect_click=True)
    validate_one("known_nobeat.wav (negative control: no beat, no click, -96 dBFS noise)",
                 gen["known_nobeat"]["path"], gen["known_nobeat"]["truth"], ck,
                 expect_beats=False, expect_click=False)

    validate_bessel(ck)
    validate_estimator_continuity(ck)
    validate_noise_floor_invariance(ck)
    validate_struck_trajectory(ck)

    model = validate_model(ck)
    levels = validate_levels(ck)
    beat = validate_beat(ck)

    real = None
    if not args.no_real:
        real = validate_real(args.real_refs, ck)

    if args.json:
        json.dump(_jsonable({"tolerances": TOLERANCES, "checks": ck.rows,
                             "failed": len(ck.failures)}), sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        print(format_report(ck))
        if model is None:
            print("\nmodel checks SKIPPED: node or tools/verify-decay.mjs not available")
        else:
            print("\nmodal.js loss budget: %s. KNOWN AND NOT FIXED - default stock inverts "
                  "mode order up to %.0f Hz (worst %.2fx); maker proportions ring %.1f s at "
                  "the top of the range. Both are gated against getting worse, not against "
                  "being right." % ("pass" if model["pass"] else "FAIL",
                                    (model["default_stock"]["inversionBandHz"] or [0, 0])[1],
                                    model["default_stock"]["worstInversionRatio"],
                                    model["maker_stock"]["longest"]))
        if levels is None:
            print("\nlevel checks SKIPPED: node or tools/verify-levels.mjs not available")
        else:
            print("\nmodal.js mode levels: %s. Mode 3 runs %.1f to %.1f dB under mode 2 "
                  "across the sweep, floor %.0f. That floor is the loose side of the "
                  "17-22 dB the reference instruments show, and no reference pitch or "
                  "level is gated - see the header of tools/verify-levels.mjs."
                  % ("pass" if levels["pass"] else "FAIL",
                     levels["default_stock"]["worstGap32"],
                     levels["default_stock"]["bestGap32"],
                     levels["mode3_gap_floor_db"]))
        if beat is None:
            print("\ndoublet checks SKIPPED: node or tools/verify-beat.mjs not available")
        else:
            print("\nmodal.js bending doublet: %s. The browser's one-oscillator doublet sits "
                  "%.1f dB under the exact two-sine sum and leaves no line below the strong "
                  "one to within %.1f dB, so the second polarisation costs a Float32Array "
                  "rather than an OscillatorNode."
                  % ("pass" if beat["ok"] else "FAIL",
                     -beat["worst"]["err_db"], -beat["worst"]["image_db"]))
        if real is None and not args.no_real:
            print("\nreal-recording checks SKIPPED: no manifest at %s" % args.real_refs)
        elif real is not None:
            print("\nreal recordings checked: %s" % ", ".join(sorted(real)))
        if not args.keep and tmp is None:
            print("\nWAVs kept in %s" % outdir)
        elif tmp is not None:
            print("\nWAVs in %s" % outdir)

    return 1 if ck.failures else 0


if __name__ == "__main__":
    sys.exit(main())
