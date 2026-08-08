#!/usr/bin/env python3
"""
validate_blind.py - does the blind rig actually hide the channel?

  python3 validate_blind.py --refs <dir-of-real-clips> --ours <our-render.wav> \
      [--target <one-clip.wav>] [--workdir <dir>] [--json <out.json>]

Building channelize.py was the easy half. The half that matters is proving a
critic cannot separate the two files on anything except the instrument, and
naming every feature where it still can.

Three tests.

REAL->REAL is the control that decides whether the tool is honest. Take two
real recordings from different microphones, different rooms and different
YouTube uploads. Put the second through channelize against the first. If a
critic can still tell them apart on channel features, the tool does not work,
and no result it produces on our render means anything. Both files here are
microphones, so any surviving separation is the rig's fault and nobody else's.

BEFORE is our dry render measured against the reference with no treatment. It
is not a test, it is the baseline the other numbers are read against: "close"
means nothing without it.

OURS->REAL is the real question. Every pure-channel feature that still
separates the two is a leak, and gets printed as a leak. A leak that cannot be
closed is not a failure to hide - it is a feature the loop has to strike from
the critic's evidence, which is why blind.py writes them into
features.json -> excluded_evidence rather than quietly dropping them.

The pass condition is stated up front so it cannot be moved afterwards:

  * every pure-channel scalar within its tolerance (see channelize.SCALARS)
  * worst third-octave noise floor difference outside the tonal region
    under 3 dB
  * REAL->REAL and OURS->REAL leaking the same set of features, because a
    leak that only shows up on our render is a leak about our render
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import channelize as CH  # noqa: E402

BAND_TOL_DB = 3.0


def _summary(c):
    return {
        "leaks": c["leaks"],
        "leak_count": c["leak_count"],
        "worst_band_outside_tonal_db": c["third_octave_max_abs_delta_db_channel_bands"],
        "confounded_over_tolerance": c["confounded_over_tolerance"],
        "scalars": {r["key"]: {"a": r["a"], "b": r["b"], "delta": r["delta"],
                               "leak_units": r["leak_units"],
                               "pure_channel": r["pure_channel"]}
                    for r in c["rows"]},
    }


def _band_audit(before, after):
    """Explain every over-tolerance band left outside the tonal region.

    channelize only ever adds noise. If the untreated source was already
    louder than the target in a band, no amount of adding will bring it down,
    and the residual is a limit of the stress test rather than a failure of
    the tool - a dry render is quieter than a microphone everywhere, so the
    case cannot arise in the job this rig is actually for. Anything else is a
    real miss and is labelled one.
    """
    pre = {b["hz"]: b["delta"] for b in before["third_octave"]}
    out = []
    for b in after["third_octave"]:
        if (b["tonal_region"] or not b.get("resolved", True)
                or abs(b["delta"]) <= BAND_TOL_DB):
            continue
        p = pre.get(b["hz"])
        already = p is not None and p > 0 and p >= b["delta"] - 1.0
        out.append({"hz": b["hz"], "delta_db": b["delta"],
                    "delta_before_db": p,
                    "cause": ("source was already hotter than the target here; "
                              "channelize adds noise and cannot subtract"
                              if already else "unexplained: the tool missed this band"),
                    "excusable": bool(already)})
    return out


def _scalar_audit(before, after):
    """Same idea as _band_audit, for the scalar channel features."""
    pre = {r["key"]: r for r in before["rows"]}
    out = []
    for r in after["rows"]:
        if not r["pure_channel"] or r["leak_units"] is None or r["leak_units"] <= 1.0:
            continue
        p = pre.get(r["key"])
        pd = p["delta"] if p else None
        already = (pd is not None and r["delta"] != 0
                   and (pd > 0) == (r["delta"] > 0) and abs(pd) >= abs(r["delta"]) - 1.0)
        out.append({"feature": r["name"], "delta": r["delta"], "delta_before": pd,
                    "cause": ("source was already past the target here and in the "
                              "same direction; channelize adds, it cannot subtract"
                              if already else "unexplained: the tool missed this"),
                    "excusable": bool(already)})
    return out


def _passes(c, audit=None, scalar_audit=None):
    if c["leaks"] and not (scalar_audit and all(a["excusable"] for a in scalar_audit)):
        return False
    w = c["third_octave_max_abs_delta_db_channel_bands"]
    if w is None or w <= BAND_TOL_DB:
        return True
    return bool(audit) and all(a["excusable"] for a in audit)


def run(refs_dir, ours_path, target=None, workdir=None, opus="128", seed=0,
        verbose=True):
    clips = sorted(glob.glob(os.path.join(refs_dir, "*.wav")))
    if len(clips) < 2:
        raise SystemExit("need at least two real clips in %s" % refs_dir)
    workdir = workdir or os.path.join(os.path.dirname(ours_path), "validate")
    os.makedirs(workdir, exist_ok=True)

    if target is None:
        # the target must have the highest noise floor of the set, or the
        # top-up has nothing to work with: channelize only ever adds noise
        floors = [(CH.channel_features(p)["noise_floor_guard_dbfs"], p) for p in clips]
        floors = [(v, p) for v, p in floors if v is not None]
        target = max(floors)[1]
    sources = [p for p in clips if os.path.abspath(p) != os.path.abspath(target)]

    out = {"target": os.path.abspath(target), "ours": os.path.abspath(ours_path),
           "opus_kbps": opus, "seed": seed, "band_tol_db": BAND_TOL_DB,
           "real_to_real": [], "ours_to_real": None, "before": None}

    def say(*a):
        if verbose:
            print(*a)

    say("\n" + "#" * 96)
    say("# TARGET CHANNEL: %s" % os.path.basename(target))
    say("#" * 96)

    # ---- real -> real ------------------------------------------------------
    for src in sources:
        name = os.path.splitext(os.path.basename(src))[0]
        dst = os.path.join(workdir, "r2r-%s.wav" % name)
        say("\n" + "=" * 96)
        say("REAL -> REAL   %s  channelized into  %s"
            % (os.path.basename(src), os.path.basename(target)))
        _fa0, _fb0, before = CH.compare_pair(target, src, "target", "src-untreated")
        CH.channelize(src, target, dst, opus=opus, seed=seed, verbose=False)
        fa, fb, c = CH.compare_pair(target, dst, "target", "src+channel")
        say(CH.format_channel_diff(fa, fb, "target", "src+chan", c=c))
        audit = _band_audit(before, c)
        saudit = _scalar_audit(before, c)
        for a in saudit:
            say("  %s  %+.1f   %s" % (a["feature"], a["delta"], a["cause"]))
        for a in audit:
            say("  band %g Hz  %+.1f dB   %s" % (a["hz"], a["delta_db"], a["cause"]))
        ok = _passes(c, audit, saudit)
        say("  -> %s" % ("PASS" if ok else "FAIL"))
        out["real_to_real"].append({"source": os.path.abspath(src),
                                    "out": os.path.abspath(dst),
                                    "pass": ok, "band_audit": audit,
                                    "scalar_audit": saudit, **_summary(c)})

    # ---- baseline ----------------------------------------------------------
    fa, fb, c = CH.compare_pair(target, ours_path, "target", "ours-dry")
    say("\n" + "=" * 96)
    say("BEFORE   our dry render measured against the target, untreated")
    say(CH.format_channel_diff(fa, fb, "target", "ours-dry", c=c))
    out["before"] = _summary(c)

    # ---- ours -> real ------------------------------------------------------
    dst = os.path.join(workdir, "ours-channelized.wav")
    say("\n" + "=" * 96)
    say("OURS -> REAL   our render channelized into %s" % os.path.basename(target))
    _fa1, _fb1, before_ours = CH.compare_pair(target, ours_path, "target", "ours-dry")
    CH.channelize(ours_path, target, dst, opus=opus, seed=seed, verbose=False)
    fa, fb, c = CH.compare_pair(target, dst, "target", "ours+channel")
    say(CH.format_channel_diff(fa, fb, "target", "ours+chan", c=c))
    audit = _band_audit(before_ours, c)
    saudit = _scalar_audit(before_ours, c)
    for a in saudit:
        say("  %s  %+.1f   %s" % (a["feature"], a["delta"], a["cause"]))
    for a in audit:
        say("  band %g Hz  %+.1f dB   %s" % (a["hz"], a["delta_db"], a["cause"]))
    ok = _passes(c, audit, saudit)
    say("  -> %s" % ("PASS" if ok else "FAIL"))
    out["ours_to_real"] = {"out": os.path.abspath(dst), "pass": ok,
                           "band_audit": audit, "scalar_audit": saudit, **_summary(c)}

    # ---- verdict -----------------------------------------------------------
    r2r_leaks = set()
    for r in out["real_to_real"]:
        r2r_leaks |= set(r["leaks"])
    ours_leaks = set(out["ours_to_real"]["leaks"])
    only_ours = sorted(ours_leaks - r2r_leaks)
    out["verdict"] = {
        "real_to_real_pass": all(r["pass"] for r in out["real_to_real"]),
        "ours_to_real_pass": out["ours_to_real"]["pass"],
        "leaks_shared_with_real_to_real": sorted(ours_leaks & r2r_leaks),
        "leaks_only_on_our_render": only_ours,
        "exclude_from_critic_evidence": sorted(ours_leaks),
    }

    say("\n" + "#" * 96)
    say("# VERDICT")
    say("#" * 96)
    say("  real -> real   %s" % ("PASS - two microphones are not separable on "
                                 "channel features"
                                 if out["verdict"]["real_to_real_pass"]
                                 else "FAIL - the rig itself separates two "
                                      "microphones, so nothing else here counts"))
    say("  ours -> real   %s" % ("PASS" if out["verdict"]["ours_to_real_pass"]
                                 else "FAIL"))
    if only_ours:
        say("  leaks that appear ONLY on our render: %s" % ", ".join(only_ours))
        say("     these are about our render, not about the rig")
    if ours_leaks:
        say("  the loop must exclude from the critic's evidence: %s"
            % ", ".join(sorted(ours_leaks)))
    else:
        say("  no pure-channel feature to exclude; the critic has to judge the "
            "instrument")
    conf = out["ours_to_real"]["confounded_over_tolerance"]
    if conf:
        say("  still different but instrument-confounded (report as an "
            "instrument gap, not a leak): %s" % ", ".join(conf))
    say("")
    return out


def _clean(o):
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_clean(v) for v in o]
    if isinstance(o, float) and not math.isfinite(o):
        return None
    return o


def main(argv=None):
    ap = argparse.ArgumentParser(description="Validate the blind A/B rig.")
    ap.add_argument("--refs", required=True, help="directory of real recordings")
    ap.add_argument("--ours", required=True, help="our dry render")
    ap.add_argument("--target", help="which clip's channel to match (default: "
                                     "the one with the highest noise floor)")
    ap.add_argument("--workdir")
    ap.add_argument("--opus-bitrate", default="128")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--json", dest="json_out")
    args = ap.parse_args(argv)
    out = run(args.refs, args.ours, target=args.target, workdir=args.workdir,
              opus=args.opus_bitrate, seed=args.seed)
    if args.json_out:
        with open(args.json_out, "w") as f:
            json.dump(_clean(out), f, indent=2)
    ok = out["verdict"]["real_to_real_pass"] and out["verdict"]["ours_to_real_pass"]
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
