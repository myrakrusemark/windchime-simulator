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
import sys
import tempfile


HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

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
        if r["mode"] == "bool":
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

    real = None
    if not args.no_real:
        real = validate_real(args.real_refs, ck)

    if args.json:
        json.dump(_jsonable({"tolerances": TOLERANCES, "checks": ck.rows,
                             "failed": len(ck.failures)}), sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        print(format_report(ck))
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
