#!/usr/bin/env python3
"""
compare.py - side-by-side diff of two chime strikes.

Runs analyze.py over both files and prints every feature with A, B and the
delta. This is the tool the blind critic uses: hand it a real recording and a
render with the labels stripped and it says exactly where they differ and by
how much.

Usage
  python3 compare.py <wav_a> <wav_b> [--json] [--label-a NAME] [--label-b NAME]

Partials are matched between the two files by nearest frequency (within
MATCH_TOL_CENTS), so an extra or missing partial shows up as unmatched rather
than shifting every row below it.

The closing summary ranks differences by how many "units" of divergence each
one is, where one unit is the tolerance listed in DIVERGENCE_UNITS below. Those
numbers are a fixed, stated yardstick, not a quality score.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys


HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from analyze import (CENTROID_POINTS, IDEAL_FREE_FREE, analyze_wav, cents,  # noqa: E402
                     _jsonable)

MATCH_TOL_CENTS = 200.0

# one unit of divergence per feature family
DIVERGENCE_UNITS = {
    "partial_freq_cents": 10.0,
    "partial_rel_db": 3.0,
    "t60_rel": 0.15,
    "beat_rate_hz": 0.5,
    "beat_depth": 0.10,
    "beat_presence": 1 / 3.0,      # a presence mismatch counts as 3 units
    "attack_ms": 2.0,
    "centroid_rel": 0.10,
    "inharmonicity_cents": 10.0,
    "tnr_db": 6.0,
    "click_presence": 0.5,         # counts as 2 units
    "missing_partial": 1.0,
    "energy_rel_db": 3.0,
}

# Why 3 dB is one unit of partial-level divergence.
#
# The quantity is each partial's level relative to the loudest partial in its
# own file, so it is already normalised for how hard the tube was hit and how
# far away the microphone was. What is left is the instrument's own balance
# between its modes.
#
# Across the three clean references, mode 2 sits -15.4, -16.0 and -21.4 dB under
# mode 1: a 6 dB spread between instruments that are all unarguably real chimes.
# A tolerance has to be small enough to catch a wrong balance and large enough
# not to punish being a different chime. 3 dB is half the observed
# between-instrument spread, so a partial has to be wrong by more than any two
# real chimes differ before it scores two units.
#
# 3 dB is also the point where the difference stops being arguable by ear: it is
# a doubling of power, and on a sustained tone it is about the smallest level
# change a listener reliably names.
#
# The same 3 dB is used for the energy-trajectory row, where the quantity is
# again a level ratio in dB and the same reasoning applies.


def _num(v):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _delta(a, b):
    a, b = _num(a), _num(b)
    if a is None or b is None:
        return None
    return b - a


def _rel(a, b):
    a, b = _num(a), _num(b)
    if a is None or b is None or a == 0:
        return None
    return (b - a) / abs(a)


def match_partials(pa, pb):
    """Greedy nearest-frequency matching. Returns (pairs, only_a, only_b)."""
    cand = []
    for i, a in enumerate(pa):
        for j, b in enumerate(pb):
            c = cents(b["freq_hz"], a["freq_hz"])
            if abs(c) <= MATCH_TOL_CENTS:
                cand.append((abs(c), i, j))
    cand.sort()
    used_a, used_b, pairs = set(), set(), []
    for _c, i, j in cand:
        if i in used_a or j in used_b:
            continue
        used_a.add(i)
        used_b.add(j)
        pairs.append((i, j))
    pairs.sort()
    only_a = [i for i in range(len(pa)) if i not in used_a]
    only_b = [j for j in range(len(pb)) if j not in used_b]
    return pairs, only_a, only_b


def build_diff(fa, fb, label_a, label_b):
    d = {"a": {"file": fa["file"]["path"], "label": label_a},
         "b": {"file": fb["file"]["path"], "label": label_b},
         "rows": [], "partials": [], "divergences": []}

    def row(section, name, va, vb, fmt="%.3f", unit="", kind=None, unit_size=None):
        r = {"section": section, "name": name, "a": va, "b": vb,
             "delta": _delta(va, vb), "rel": _rel(va, vb),
             "fmt": fmt, "unit": unit}
        d["rows"].append(r)
        if kind and unit_size and r["delta"] is not None:
            mag = abs(r["rel"]) if kind == "rel" else abs(r["delta"])
            if mag is not None:
                d["divergences"].append(
                    {"what": "%s / %s" % (section, name), "units": mag / unit_size,
                     "detail": "%s %s vs %s %s" % (_fmt(va, fmt), unit, _fmt(vb, fmt), unit)})
        return r

    oa, ob = fa["onset"], fb["onset"]
    row("onset", "onset time (s)", oa["onset_s"], ob["onset_s"], "%.4f", "s")
    row("onset", "peak after onset (ms)", oa["peak_after_onset_ms"], ob["peak_after_onset_ms"],
        "%.2f", "ms")
    row("onset", "attack 10-90 (ms)", oa["attack_10_90_ms"], ob["attack_10_90_ms"],
        "%.3f", "ms", kind="abs", unit_size=DIVERGENCE_UNITS["attack_ms"])
    row("onset", "peak level (dBFS)", oa["peak_level_dbfs"], ob["peak_level_dbfs"], "%.2f", "dB")
    # How far the envelope climbs past the strike's own peak. On a mastered
    # source this is the limiter letting go, and it is the reason a naive
    # attack measurement reads hundreds of milliseconds; comparing it keeps
    # that difference visible instead of folding it into the attack time.
    row("onset", "creep past attack peak (dB)", oa.get("attack_peak_creep_db"),
        ob.get("attack_peak_creep_db"), "%.2f", "dB")
    for tag, o in (("a", oa), ("b", ob)):
        if not o.get("onset_detected"):
            d.setdefault("warnings", []).append(
                "%s has no measurable strike: %s" % (d[tag]["label"], o.get("note") or "-"))

    row("spectrum", "partial count", fa["n_partials"], fb["n_partials"], "%.0f", "")
    row("spectrum", "fundamental (Hz)", fa["fundamental_hz"], fb["fundamental_hz"], "%.3f", "Hz")

    pairs, only_a, only_b = match_partials(fa["partials"], fb["partials"])
    for i, j in pairs:
        a, b = fa["partials"][i], fb["partials"][j]
        c = cents(b["freq_hz"], a["freq_hz"])
        ta = a["decay"].get("t60_s") if a["decay"].get("valid") else None
        tb = b["decay"].get("t60_s") if b["decay"].get("valid") else None
        ba, bb = a["beating"], b["beating"]
        rec = {
            "a_index": a["index"], "b_index": b["index"],
            "freq_a": a["freq_hz"], "freq_b": b["freq_hz"], "cents": c,
            "ratio_a": a.get("ratio_to_f0"), "ratio_b": b.get("ratio_to_f0"),
            "ratio_cents": cents(b.get("ratio_to_f0") or 1.0, a.get("ratio_to_f0") or 1.0),
            "rel_db_a": a["rel_db"], "rel_db_b": b["rel_db"],
            "rel_db_delta": _delta(a["rel_db"], b["rel_db"]),
            "t60_a": ta, "t60_b": tb, "t60_rel": _rel(ta, tb),
            "t60_r2_a": a["decay"].get("fit_r2"), "t60_r2_b": b["decay"].get("fit_r2"),
            "beat_a": bool(ba.get("detected")), "beat_b": bool(bb.get("detected")),
            "beat_rate_a": ba.get("rate_hz") if ba.get("detected") else None,
            "beat_rate_b": bb.get("rate_hz") if bb.get("detected") else None,
            "beat_depth_a": ba.get("depth") if ba.get("detected") else 0.0,
            "beat_depth_b": bb.get("depth") if bb.get("detected") else 0.0,
            "split_a": a["spectral_split_hz"], "split_b": b["spectral_split_hz"],
        }
        d["partials"].append(rec)
        if c is not None:
            d["divergences"].append({
                "what": "partial %d frequency" % a["index"],
                "units": abs(c) / DIVERGENCE_UNITS["partial_freq_cents"],
                "detail": "%.3f Hz vs %.3f Hz (%+.1f cents)" % (a["freq_hz"], b["freq_hz"], c)})
        # Level. Each partial's dB under the loudest partial in its own file, so
        # this is the instrument's balance between its modes, not its loudness.
        # Scored per partial: without this row a render can put every line in
        # the right place and get every one of them at the wrong strength, and
        # the total barely moves.
        if rec["rel_db_delta"] is not None:
            d["divergences"].append({
                "what": "partial %d level" % a["index"],
                "units": abs(rec["rel_db_delta"]) / DIVERGENCE_UNITS["partial_rel_db"],
                "detail": "%.1f dB vs %.1f dB (%+.1f dB)"
                          % (a["rel_db"], b["rel_db"], rec["rel_db_delta"])})
        if rec["t60_rel"] is not None:
            d["divergences"].append({
                "what": "partial %d T60" % a["index"],
                "units": abs(rec["t60_rel"]) / DIVERGENCE_UNITS["t60_rel"],
                "detail": "%.3f s vs %.3f s (%+.0f%%)" % (ta, tb, 100 * rec["t60_rel"])})
        if rec["beat_a"] != rec["beat_b"]:
            d["divergences"].append({
                "what": "partial %d beating" % a["index"],
                "units": 1.0 / DIVERGENCE_UNITS["beat_presence"],
                "detail": "%s vs %s" % ("beats" if rec["beat_a"] else "no beat",
                                        "beats" if rec["beat_b"] else "no beat")})
        elif rec["beat_a"] and rec["beat_b"]:
            dr = abs(rec["beat_rate_b"] - rec["beat_rate_a"])
            d["divergences"].append({
                "what": "partial %d beat rate" % a["index"],
                "units": dr / DIVERGENCE_UNITS["beat_rate_hz"],
                "detail": "%.2f Hz vs %.2f Hz" % (rec["beat_rate_a"], rec["beat_rate_b"])})
            dd = abs(rec["beat_depth_b"] - rec["beat_depth_a"])
            d["divergences"].append({
                "what": "partial %d beat depth" % a["index"],
                "units": dd / DIVERGENCE_UNITS["beat_depth"],
                "detail": "%.3f vs %.3f" % (rec["beat_depth_a"], rec["beat_depth_b"])})

    d["only_a"] = [{"index": fa["partials"][i]["index"], "freq_hz": fa["partials"][i]["freq_hz"],
                    "rel_db": fa["partials"][i]["rel_db"]} for i in only_a]
    d["only_b"] = [{"index": fb["partials"][j]["index"], "freq_hz": fb["partials"][j]["freq_hz"],
                    "rel_db": fb["partials"][j]["rel_db"]} for j in only_b]
    for u in d["only_a"]:
        d["divergences"].append({"what": "partial only in A",
                                 "units": 1.0 / DIVERGENCE_UNITS["missing_partial"],
                                 "detail": "%.2f Hz at %.1f dB" % (u["freq_hz"], u["rel_db"])})
    for u in d["only_b"]:
        d["divergences"].append({"what": "partial only in B",
                                 "units": 1.0 / DIVERGENCE_UNITS["missing_partial"],
                                 "detail": "%.2f Hz at %.1f dB" % (u["freq_hz"], u["rel_db"])})

    ba, bb = fa["beating_summary"], fb["beating_summary"]
    row("beating", "partials beating", ba["partials_beating"], bb["partials_beating"], "%.0f", "")
    row("beating", "mean beat rate (Hz)", ba["mean_rate_hz"], bb["mean_rate_hz"], "%.3f", "Hz")
    row("beating", "mean beat depth", ba["mean_depth"], bb["mean_depth"], "%.3f", "")

    ca, cb = fa["spectral_centroid"], fb["spectral_centroid"]
    for k, _off in CENTROID_POINTS:
        row("centroid", "%s (Hz, 50 ms)" % k, ca.get(k + "_hz"), cb.get(k + "_hz"), "%.1f", "Hz")
    for k, _off in CENTROID_POINTS:
        row("centroid", "%s (Hz, 250 ms)" % k, ca.get(k + "_hz_wide"), cb.get(k + "_hz_wide"),
            "%.1f", "Hz", kind="rel", unit_size=DIVERGENCE_UNITS["centroid_rel"])
    row("centroid", "darkening onset->2s", ca.get("darkening_ratio_onset_to_2s"),
        cb.get("darkening_ratio_onset_to_2s"), "%.3f", "x")

    # Energy trajectory. Where the sound has got to, seconds after the strike.
    # This is the difference anyone hears first between a real chime and a
    # synthesised one - the real one is still going when ours has stopped - and
    # until now it was the one difference nothing in this file scored.
    ea = fa.get("energy_trajectory") or {}
    eb = fb.get("energy_trajectory") or {}
    marks = ea.get("marks_s") or eb.get("marks_s") or []
    for m in marks:
        k = "%gs" % m
        va = (ea.get("rms_rel_peak_db") or {}).get(k)
        vb = (eb.get("rms_rel_peak_db") or {}).get(k)
        r = row("energy", "RMS at %s (dB under peak)" % k, va, vb, "%.1f", "dB",
                kind="abs", unit_size=DIVERGENCE_UNITS["energy_rel_db"])
        if (ea.get("truncated") or {}).get(k) or (eb.get("truncated") or {}).get(k):
            r["note"] = "clip ends inside the window"
    if marks:
        # one summary number for the whole tail, so a variant can be ranked on
        # "how much of the ring is missing" without reading three rows
        gaps = [_delta((ea.get("rms_rel_peak_db") or {}).get("%gs" % m),
                       (eb.get("rms_rel_peak_db") or {}).get("%gs" % m))
                for m in marks]
        gaps = [g for g in gaps if g is not None]
        d["energy_gap_db"] = gaps
        d["energy_gap_mean_db"] = (sum(gaps) / len(gaps)) if gaps else None

    ia, ib = fa["inharmonicity"], fb["inharmonicity"]
    for k, ideal in enumerate(IDEAL_FREE_FREE):
        va = next((m["cents"] for m in ia.get("by_mode", []) if m["mode"] == k + 1), None)
        vb = next((m["cents"] for m in ib.get("by_mode", []) if m["mode"] == k + 1), None)
        row("inharmonicity", "mode %d (cents vs %.4f)" % (k + 1, ideal), va, vb, "%+.1f", "c",
            kind="abs", unit_size=DIVERGENCE_UNITS["inharmonicity_cents"])
    row("inharmonicity", "mean |cents|", ia.get("mean_abs_cents"), ib.get("mean_abs_cents"),
        "%.1f", "c")

    na, nb = fa["noise"], fb["noise"]
    row("noise", "noise floor (dBFS)", na.get("noise_floor_dbfs"), nb.get("noise_floor_dbfs"),
        "%.1f", "dB")
    row("noise", "tonal-to-noise (dB)", na.get("tonal_to_noise_db"), nb.get("tonal_to_noise_db"),
        "%.1f", "dB", kind="abs", unit_size=DIVERGENCE_UNITS["tnr_db"])
    cka, ckb = na.get("click", {}), nb.get("click", {})
    row("click", "non-tonal fraction 0-30 ms", cka.get("nontonal_fraction"),
        ckb.get("nontonal_fraction"), "%.4f", "")
    row("click", "HF excess at onset (dB)", cka.get("hf_excess_db"), ckb.get("hf_excess_db"),
        "%.1f", "dB")
    row("click", "spectral flatness (dB)", cka.get("spectral_flatness_db"),
        ckb.get("spectral_flatness_db"), "%.1f", "dB")
    d["click_a"] = bool(cka.get("detected"))
    d["click_b"] = bool(ckb.get("detected"))
    if d["click_a"] != d["click_b"]:
        d["divergences"].append({
            "what": "contact click", "units": 1.0 / DIVERGENCE_UNITS["click_presence"],
            "detail": "%s vs %s" % ("present" if d["click_a"] else "absent",
                                    "present" if d["click_b"] else "absent")})

    d["divergences"].sort(key=lambda x: -x["units"])
    return d


def _fmt(v, fmt="%.3f", na="-"):
    v = _num(v)
    if v is None:
        return na
    return fmt % v


def format_diff(d, label_a, label_b):
    L = []
    W = 96
    L.append("=" * W)
    L.append("A  %-8s %s" % ("[" + label_a + "]", d["a"]["file"]))
    L.append("B  %-8s %s" % ("[" + label_b + "]", d["b"]["file"]))
    L.append("=" * W)
    for w in d.get("warnings", []):
        L.append("!! %s" % w)

    hdr = "  %-34s %13s %13s %13s" % ("feature", label_a[:13], label_b[:13], "delta (B-A)")

    def emit_rows(section):
        L.append("")
        L.append(section.upper())
        L.append(hdr)
        L.append("  " + "-" * (W - 4))
        for r in d["rows"]:
            if r["section"] != section:
                continue
            rel = ""
            # a percentage of a dB value or a cents offset means nothing
            if (r["rel"] is not None and abs(r["rel"]) > 1e-9
                    and r["unit"] not in ("dB", "c")):
                rel = "  (%+.1f%%)" % (100.0 * r["rel"])
            L.append("  %-34s %13s %13s %13s%s"
                     % (r["name"], _fmt(r["a"], r["fmt"]), _fmt(r["b"], r["fmt"]),
                        _fmt(r["delta"], "%+" + r["fmt"][1:]), rel))

    def emit_partials():
        L.append("")
        L.append("PARTIALS  (matched by nearest frequency, within %.0f cents)" % MATCH_TOL_CENTS)
        L.append("   A#  B#      A freq      B freq    cents"
                 "    A dB    B dB    ddB    A T60    B T60   dT60%   A beat   B beat")
        L.append("  " + "-" * (W + 24))
        for p in d["partials"]:
            L.append("  %3d %3d %11.3f %11.3f %8s %7s %7s %6s %8s %8s %7s %8s %8s"
                     % (p["a_index"], p["b_index"], p["freq_a"], p["freq_b"],
                        _fmt(p["cents"], "%+.1f"),
                        _fmt(p["rel_db_a"], "%.1f"), _fmt(p["rel_db_b"], "%.1f"),
                        _fmt(p["rel_db_delta"], "%+.1f"),
                        _fmt(p["t60_a"], "%.3f"), _fmt(p["t60_b"], "%.3f"),
                        _fmt(p["t60_rel"] * 100 if p["t60_rel"] is not None else None, "%+.0f"),
                        ("%.2fHz" % p["beat_rate_a"]) if p["beat_a"] else "none",
                        ("%.2fHz" % p["beat_rate_b"]) if p["beat_b"] else "none"))
        for u in d["only_a"]:
            L.append("  only in A: partial #%d at %.3f Hz (%.1f dB)"
                     % (u["index"], u["freq_hz"], u["rel_db"]))
        for u in d["only_b"]:
            L.append("  only in B: partial #%d at %.3f Hz (%.1f dB)"
                     % (u["index"], u["freq_hz"], u["rel_db"]))

    order = []
    for r in d["rows"]:
        if r["section"] not in order:
            order.append(r["section"])
    for sec in order:
        emit_rows(sec)
        if sec == "spectrum":
            emit_partials()

    L.append("")
    L.append("CONTACT CLICK   %s: %s    %s: %s"
             % (label_a, "present" if d["click_a"] else "absent",
                label_b, "present" if d["click_b"] else "absent"))

    L.append("")
    L.append("LARGEST DIVERGENCES  (1.0 unit = the tolerance listed in compare.py)")
    L.append("  " + "-" * (W - 4))
    shown = [x for x in d["divergences"] if x["units"] >= 0.5][:10]
    if not shown:
        L.append("  nothing above half a unit; the two files agree on every measured feature")
    for x in shown:
        L.append("  %6.1f units  %-28s %s" % (x["units"], x["what"], x["detail"]))
    L.append("")
    return "\n".join(L)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Side-by-side feature diff of two chime strikes.")
    ap.add_argument("wav_a")
    ap.add_argument("wav_b")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--label-a", default="A")
    ap.add_argument("--label-b", default="B")
    args = ap.parse_args(argv)

    fa = analyze_wav(args.wav_a)
    fb = analyze_wav(args.wav_b)
    d = build_diff(fa, fb, args.label_a, args.label_b)
    if args.json:
        json.dump(_jsonable({"diff": d, "a": fa, "b": fb}), sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        print(format_diff(d, args.label_a, args.label_b))
    return 0


if __name__ == "__main__":
    sys.exit(main())
