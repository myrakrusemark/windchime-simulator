#!/usr/bin/env python3
"""
make_test_signal.py - synthesise chime-like strikes with exactly known properties.

This exists so analyze.py can be validated. Every feature analyze.py claims to
measure is put into the signal at a known value here, and the ground truth is
computed in closed form (never by running the analyser), so validate.py can
report a real recovered-versus-true error.

Two signals are produced:

  known_chime.wav   five partials at known frequencies and T60s, two of them
                    carrying a known beat, plus a contact click and a known
                    noise floor. The realistic case.
  known_nobeat.wav  the same partials and T60s with no beat pair, no click and
                    a much lower noise floor. The negative control: a correct
                    analyser must report "no beating" and "no click" here.

Usage
  python3 make_test_signal.py [--outdir DIR] [--bits {16,24,float}]

Writes the two WAVs plus ground_truth.json into DIR.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import struct
import sys

import numpy as np
from scipy import signal as sig
from scipy.ndimage import uniform_filter1d

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from analyze import (ENERGY_MARKS_S, ENERGY_WIN_S, IDEAL_FREE_FREE,  # noqa: E402
                     trailing_taper_window)

F0 = 440.0
# attack time constant: for a pure 1-exp(-t/tau) rise, 10%->90% is tau*ln(9)
ATTACK_10_90_NOMINAL_MS = 3.0
ATTACK_TAU = (ATTACK_10_90_NOMINAL_MS * 1e-3) / math.log(9.0)

SPEC = {
    "sample_rate": 48000,
    "duration_s": 8.0,
    "onset_s": 0.050,
    "attack_tau_s": ATTACK_TAU,
    "peak_target": 0.70,
    "partials": [
        # frequency, initial amplitude, T60, phase, optional beat partner
        {"f": F0 * IDEAL_FREE_FREE[0], "amp": 1.00, "t60": 12.0, "phase": 0.31,
         "beat": {"df": 3.00, "ratio": 0.60, "phase": 0.00}},
        {"f": F0 * IDEAL_FREE_FREE[1], "amp": 0.50, "t60": 6.0, "phase": 1.77,
         "beat": {"df": 1.70, "ratio": 0.30, "phase": 0.40}},
        # partial 3 is deliberately detuned +25 cents from the ideal ratio
        {"f": F0 * IDEAL_FREE_FREE[2] * 2 ** (25.0 / 1200.0), "amp": 0.30,
         "t60": 3.5, "phase": 2.90, "detune_cents": 25.0},
        {"f": F0 * IDEAL_FREE_FREE[3], "amp": 0.18, "t60": 2.0, "phase": 0.90},
        {"f": F0 * IDEAL_FREE_FREE[4], "amp": 0.10, "t60": 1.2, "phase": 2.20},
    ],
    "click": {"peak": 0.15, "dur_s": 0.0015, "highpass_hz": 2000.0, "seed": 7},
    "noise_dbfs": -72.0,
    "noise_seed": 11,
}



def t60_to_tau(t60):
    """Amplitude time constant for a given T60 (20*log10(exp(-t/tau)) = -60)."""
    return t60 / (60.0 / (20.0 / math.log(10.0)))  # t60 / 6.907755


def build(spec, with_beat=True, with_click=True, noise_dbfs=None):
    sr = spec["sample_rate"]
    n = int(round(spec["duration_s"] * sr))
    onset_i = int(round(spec["onset_s"] * sr))
    t_all = np.arange(n) / sr
    tau_a = spec["attack_tau_s"]

    # local time from the onset, zero before it
    tl = np.zeros(n)
    tl[onset_i:] = np.arange(n - onset_i) / sr
    gate = np.zeros(n)
    gate[onset_i:] = 1.0
    attack = gate * (1.0 - np.exp(-tl / tau_a))

    groups = []      # per-partial-group time signals and component records
    x = np.zeros(n)
    for p in spec["partials"]:
        tau_d = t60_to_tau(p["t60"])
        decay = gate * np.exp(-tl / tau_d)
        comps = [{"f": p["f"], "amp": p["amp"], "phase": p["phase"], "t60": p["t60"]}]
        if with_beat and "beat" in p:
            b = p["beat"]
            comps.append({"f": p["f"] + b["df"], "amp": p["amp"] * b["ratio"],
                          "phase": b["phase"], "t60": p["t60"]})
        s = np.zeros(n)
        env_terms = []
        for c in comps:
            a = c["amp"] * attack * decay
            s += a * np.cos(2.0 * np.pi * c["f"] * tl + c["phase"])
            env_terms.append(a)
        x += s
        groups.append({"spec": p, "components": comps, "signal": s,
                       "envelopes": env_terms})

    # closed-form analytic envelope of the whole tonal signal:
    # z(t) = sum_i a_i(t) exp(j(2 pi f_i t + phi_i)); |z| is the exact envelope
    z = np.zeros(n, dtype=np.complex128)
    for g in groups:
        for c, a in zip(g["components"], g["envelopes"]):
            z += a * np.exp(1j * (2.0 * np.pi * c["f"] * tl + c["phase"]))
    env_true = np.abs(z)

    scale = spec["peak_target"] / max(float(np.max(np.abs(x))), 1e-12)
    x *= scale
    env_true *= scale
    for g in groups:
        g["signal"] *= scale
        g["envelopes"] = [e * scale for e in g["envelopes"]]

    click_present = False
    if with_click:
        c = spec["click"]
        cn = max(2, int(round(c["dur_s"] * sr)))
        rng = np.random.default_rng(c["seed"])
        burst = rng.standard_normal(cn)
        sos = sig.butter(4, c["highpass_hz"] / (0.5 * sr), btype="high", output="sos")
        burst = sig.sosfilt(sos, burst)
        burst *= np.hanning(cn)
        burst *= c["peak"] / max(float(np.max(np.abs(burst))), 1e-12)
        x[onset_i:onset_i + cn] += burst
        click_present = True

    nf = spec["noise_dbfs"] if noise_dbfs is None else noise_dbfs
    noise_rms = 10.0 ** (nf / 20.0)
    rng = np.random.default_rng(spec["noise_seed"])
    x = x + rng.standard_normal(n) * noise_rms

    return {
        "x": x, "sr": sr, "onset_i": onset_i, "groups": groups,
        "env_true": env_true, "scale": scale, "click": click_present,
        "noise_dbfs": nf, "with_beat": with_beat,
    }


# ----------------------------------------------------------------------------
# ground truth, computed in closed form (never by running the analyser)
# ----------------------------------------------------------------------------

def ground_truth(built, spec):
    sr = built["sr"]
    onset_i = built["onset_i"]
    env = built["env_true"]
    groups = built["groups"]

    # --- attack: 10%-90% of the closed-form analytic envelope ---------------
    # smoothed with the same 1 ms box the analyser uses, so the two are
    # measuring the same quantity by different routes
    w = max(1, int(round(1e-3 * sr)))
    env_s = uniform_filter1d(env, size=w, mode="nearest")
    pk_i = int(np.argmax(env_s))
    pk = float(env_s[pk_i])

    # Same crossing rule the analyser uses: find the onset by walking back from
    # the peak, then take the FIRST 10% and 90% crossings after it. What is
    # being validated here is the envelope itself, which the analyser estimates
    # with a Hilbert transform and this computes in closed form.
    def back_cross(start_i, level):
        below = np.nonzero(env_s[:start_i + 1] < level)[0]
        return int(below[-1]) if below.size else None

    def fwd_cross(start_i, level):
        above = np.nonzero(env_s[start_i:] >= level)[0]
        return int(start_i + above[0]) if above.size else None

    on_i = back_cross(pk_i, 0.02 * pk) or 0
    i10 = fwd_cross(on_i, 0.1 * pk)
    i90 = fwd_cross(i10, 0.9 * pk)
    attack_ms = (i90 - i10) / sr * 1000.0

    truth = {
        "onset_s": onset_i / sr,
        "peak_s": pk_i / sr,
        "peak_level_dbfs": 20.0 * math.log10(pk),
        "attack_10_90_ms": attack_ms,
        "noise_floor_dbfs": built["noise_dbfs"],
        "click_present": bool(built["click"]),
        "partials": [],
    }

    # --- per-partial-group values ------------------------------------------
    # the analyser measures amplitude with a 250 ms trailing-taper window that
    # starts 2 ms before the onset, so compute the truth over the same window
    start = max(0, onset_i - int(0.002 * sr))
    an = min(int(round(0.25 * sr)), env.size - start)
    win = trailing_taper_window(an, taper=0.35)
    w2 = win ** 2
    w2sum = float(np.sum(w2))

    amps = []
    for g in groups:
        s = g["signal"][start:start + an]
        a_eff = math.sqrt(2.0 * float(np.sum(w2 * s * s)) / w2sum)
        amps.append(a_eff)
    amax = max(amps)

    for g, a_eff in zip(groups, amps):
        comps = g["components"]
        fs = np.array([c["f"] for c in comps])
        aa = np.array([c["amp"] for c in comps])
        f_group = float(np.sum(fs * aa) / np.sum(aa))  # amplitude-weighted centre
        rec = {
            "freq_hz": f_group,
            "component_freqs_hz": [float(v) for v in fs],
            "n_components": len(comps),
            "spectral_split_hz": float(fs.max() - fs.min()),
            "t60_s": float(g["spec"]["t60"]),
            "amp_dbfs": 20.0 * math.log10(a_eff),
            "rel_db": 20.0 * math.log10(a_eff / amax),
        }
        if len(comps) > 1:
            ratio = comps[1]["amp"] / comps[0]["amp"]
            rec["beat_rate_hz"] = float(fs[1] - fs[0])
            # envelope of two sinusoids: max = a1+a2, min = |a1-a2|
            # depth defined as (max-min)/(max+min) = a2/a1
            rec["beat_depth"] = float(ratio)
            rec["beats"] = True
        else:
            rec["beat_rate_hz"] = None
            rec["beat_depth"] = 0.0
            rec["beats"] = False
        truth["partials"].append(rec)

    # --- ratios and inharmonicity, referenced to the measured-style f0 ------
    f0 = truth["partials"][0]["freq_hz"]
    for i, rec in enumerate(truth["partials"]):
        rec["ratio_to_f0"] = rec["freq_hz"] / f0
        if i < len(IDEAL_FREE_FREE):
            rec["inharmonicity_cents"] = 1200.0 * math.log2(
                rec["ratio_to_f0"] / IDEAL_FREE_FREE[i])

    # --- spectral centroid, power-weighted, over the same windows -----------
    # Parseval: the analyser's summed |rfft(seg*hann)|^2 inside a partial's band
    # is proportional to sum((hann*s)^2) for that partial's own time signal. Use
    # the signal, not the envelope: two components 3 Hz apart interfere, and
    # that cross term is exactly what a beat is.
    from analyze import CENTROID_POINTS, CENTROID_WIN_S, CENTROID_WIDE_WIN_S
    cent = {}
    for win_s, suffix in ((CENTROID_WIN_S, ""), (CENTROID_WIDE_WIN_S, "_wide")):
        wn = int(round(win_s * sr))
        hann = np.hanning(wn)
        for label, off in CENTROID_POINTS:
            s0 = onset_i if off <= 0 else onset_i + int(round(off * sr)) - wn // 2
            if s0 < 0 or s0 + wn > env.size:
                cent[label + suffix] = None
                continue
            num = 0.0
            den = 0.0
            for g, rec in zip(groups, truth["partials"]):
                p = float(np.sum((hann * g["signal"][s0:s0 + wn]) ** 2))
                num += rec["freq_hz"] * p
                den += p
            cent[label + suffix] = (num / den) if den > 0 else None
    truth["spectral_centroid_hz"] = cent

    # --- approximate tonal-to-noise over the analyser's 1 s window ----------
    seg_end = min(onset_i + sr, env.size)
    tonal_p = 0.0
    for g in groups:
        s = g["signal"][onset_i:seg_end]
        tonal_p += float(np.mean(s * s))
    noise_p = (10.0 ** (built["noise_dbfs"] / 20.0)) ** 2
    truth["tonal_to_noise_db_approx"] = 10.0 * math.log10(tonal_p / noise_p)

    # --- energy trajectory --------------------------------------------------
    # Straight arithmetic on the signal that gets written, using the same marks
    # and window the analyser uses. Nothing here is estimated: the analyser has
    # to find the onset for itself and still land on these numbers.
    xw = built["x"]
    wn = int(round(ENERGY_WIN_S * sr))
    peak = float(np.max(np.abs(xw[onset_i:])))
    et = {}
    for m in ENERGY_MARKS_S:
        i0 = onset_i + int(round(m * sr))
        i1 = min(i0 + wn, xw.size)
        if i0 >= xw.size or (i1 - i0) < 0.5 * wn or peak <= 0:
            et["%gs" % m] = None
            continue
        r = float(np.sqrt(np.mean(xw[i0:i1] ** 2)))
        et["%gs" % m] = 20.0 * math.log10(r / peak)
    truth["energy_rms_rel_peak_db"] = et
    return truth


# ----------------------------------------------------------------------------
# WAV writing
# ----------------------------------------------------------------------------

def write_wav(path, x, sr, bits="float"):
    x = np.asarray(x, dtype=np.float64)
    if bits == "float":
        data = x.astype("<f4").tobytes()
        tag, bps = 3, 32
    elif bits in (16, "16"):
        q = np.clip(np.round(x * 32767.0), -32768, 32767).astype("<i2")
        data = q.tobytes()
        tag, bps = 1, 16
    elif bits in (24, "24"):
        q = np.clip(np.round(x * 8388607.0), -8388608, 8388607).astype(np.int32)
        b = np.empty((q.size, 3), dtype=np.uint8)
        b[:, 0] = q & 0xFF
        b[:, 1] = (q >> 8) & 0xFF
        b[:, 2] = (q >> 16) & 0xFF
        data = b.tobytes()
        tag, bps = 1, 24
    else:
        raise ValueError("bits must be 16, 24 or 'float'")
    ch = 1
    byte_rate = sr * ch * bps // 8
    align = ch * bps // 8
    fmt = struct.pack("<HHIIHH", tag, ch, sr, byte_rate, align, bps)
    if len(data) & 1:
        data += b"\x00"
    riff = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt \
        + b"data" + struct.pack("<I", len(data)) + data
    with open(path, "wb") as fh:
        fh.write(b"RIFF" + struct.pack("<I", len(riff)) + riff)


def generate(outdir, bits="float"):
    os.makedirs(outdir, exist_ok=True)
    out = {}

    full = build(SPEC, with_beat=True, with_click=True)
    p1 = os.path.join(outdir, "known_chime.wav")
    write_wav(p1, full["x"], full["sr"], bits)
    out["known_chime"] = {"path": p1, "truth": ground_truth(full, SPEC)}

    plain = build(SPEC, with_beat=False, with_click=False, noise_dbfs=-96.0)
    p2 = os.path.join(outdir, "known_nobeat.wav")
    write_wav(p2, plain["x"], plain["sr"], bits)
    out["known_nobeat"] = {"path": p2, "truth": ground_truth(plain, SPEC)}

    with open(os.path.join(outdir, "ground_truth.json"), "w") as fh:
        json.dump(out, fh, indent=2)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--outdir", default=os.path.join(HERE, "test-signals"))
    ap.add_argument("--bits", default="float", choices=["16", "24", "float"])
    args = ap.parse_args(argv)
    out = generate(args.outdir, args.bits)
    for k, v in out.items():
        print("%-14s %s" % (k, v["path"]))
    print("ground truth  %s" % os.path.join(args.outdir, "ground_truth.json"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
