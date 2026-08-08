#!/usr/bin/env python3
"""
analyze.py - spectral feature extraction for a single struck-chime strike.

Takes a WAV of one strike (real microphone recording or synthesised render) and
extracts a feature vector that can be compared blind between the two.

Everything reported here is measured from the samples. Nothing is assumed from
synthesis parameters, and every estimate that can fail reports a quality number
alongside it so a bad measurement is visible as a bad measurement.

Features
  1. Onset time, peak time, 10%-90% attack time.
  2. Partial frequencies (absolute Hz and ratios to the lowest strong partial),
     found with a long trailing-tapered window, zero-padded FFT, parabolic peak
     interpolation, then exact-DTFT golden-section refinement.
  3. Per-partial T60 from Schroeder backward integration of the bandpassed
     energy, with the linear fit's R^2 and the usable decay range reported.
  4. Per-partial amplitude modulation (beating): rate in Hz and depth, plus the
     spectral split between sub-peaks inside the same partial group. A real tube
     beats because its two bending polarisations differ slightly; an ideal
     single synthesised partial does not beat at all.
  5. Power-weighted spectral centroid at onset, 100 ms, 500 ms and 2 s.
  6. Inharmonicity in cents against the ideal free-free flexural ratios
     1 : 2.7565 : 5.4039 : 8.933 : 13.3443.
  7. Noise floor, tonal-to-noise ratio, and broadband (contact click) content in
     the first 30 ms.

Usage
  python3 analyze.py <wav> [--json]

Requires numpy and scipy only.
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
from scipy.fft import next_fast_len, rfft, rfftfreq
from scipy.ndimage import uniform_filter1d

SCHEMA_VERSION = 3

# Ideal transverse (free-free) flexural mode ratios of a uniform tube.
IDEAL_FREE_FREE = (1.0, 2.7565, 5.4039, 8.933, 13.3443)

EPS = 1e-20

# contact-click decision thresholds (see noise_and_click)
CLICK_EXCESS_DB = 12.0
CLICK_FLOOR_DB = -55.0

# --- onset and attack ------------------------------------------------------
# The strike is found with a spectral-flux detection function rather than the
# envelope's global maximum. On a real recording the loudest moment is often
# not the strike: a limiter on the source release, or two polarisation modes
# beating back into phase, both put the envelope peak hundreds of milliseconds
# late, and anchoring the attack there turns a 3 ms strike into a 200 ms swell.
ODF_FMIN_HZ = 80.0          # ignore rumble, handling noise and HVAC below this
ODF_WIN = 512               # 10.7 ms at 48 kHz
ODF_HOP = 64                # 1.3 ms at 48 kHz
ODF_LAG = 2                 # frames; compare against 2.7 ms ago, not 1.3 ms
# The envelope peak that belongs to the strike is inside this window after it.
# A struck bar reaches full amplitude in single-digit milliseconds; 60 ms is
# generous enough for a slow low mode and far short of any swell.
ATTACK_PEAK_WINDOW_S = 0.060
# Where the attack stops and something else takes over. The strike's own rise
# runs several dB per millisecond. What follows it - a mastering limiter letting
# go, two partials beating back into phase - climbs at well under a tenth of
# that. The gate below sits between the two by more than an order of magnitude
# in either direction, so it is not tuned to either case: the attack ends at the
# first moment the running maximum gains less than ATTACK_SETTLE_DB over the
# next ATTACK_SETTLE_LOOKAHEAD_S.
ATTACK_SETTLE_LOOKAHEAD_S = 0.005
ATTACK_SETTLE_DB = 1.0
# ...but not before the envelope has got most of the way up, so a shoulder
# partway through a genuine rise cannot end the attack early.
ATTACK_SETTLE_MIN_FRAC = 0.25
# Level the strike must add over what was already ringing for the attack to be
# a measurement rather than a guess.
MIN_ONSET_RISE_DB = 6.0
# Pre-strike window used to measure what was already ringing.
BASELINE_WIN_S = 0.030
BASELINE_GUARD_S = 0.003

# --- fundamental selection -------------------------------------------------
# A candidate must carry real energy: the struck mode of a chime tube is the
# one the maker tuned and it is never 40 dB under an upper partial.
FUND_STRONG_DB = -12.0
# Widened floor used only for the "is this candidate itself an overtone of
# something lower?" test.
FUND_ROOT_TEST_DB = -30.0
# How close a lower partial must sit to f/ratio to be believed as the root.
FUND_ROOT_TOL_CENTS = 120.0
# Tolerance used when scoring how well a candidate's descendants line up with
# the free-free series. Real tubes are not ideal: wall thickness, end effects
# and the maker's tuning move the upper modes by well over a semitone.
FUND_SERIES_TOL_CENTS = 150.0


# ----------------------------------------------------------------------------
# WAV loading
# ----------------------------------------------------------------------------

def _read_wav_manual(path):
    """Minimal RIFF/WAVE reader, used when scipy refuses a file.

    Handles PCM 8/16/24/32-bit, IEEE float 32/64, and WAVE_FORMAT_EXTENSIBLE.
    """
    with open(path, "rb") as fh:
        raw = fh.read()
    if raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise ValueError("not a RIFF/WAVE file: %s" % path)
    pos = 12
    fmt = None
    data = None
    while pos + 8 <= len(raw):
        cid = raw[pos:pos + 4]
        csize = struct.unpack("<I", raw[pos + 4:pos + 8])[0]
        body = raw[pos + 8:pos + 8 + csize]
        if cid == b"fmt ":
            fmt = body
        elif cid == b"data":
            data = body
        pos += 8 + csize + (csize & 1)
    if fmt is None or data is None:
        raise ValueError("missing fmt or data chunk: %s" % path)

    tag, channels, sr, _byte_rate, _align, bits = struct.unpack("<HHIIHH", fmt[:16])
    if tag == 0xFFFE and len(fmt) >= 40:
        tag = struct.unpack("<H", fmt[24:26])[0]

    if tag == 1:
        if bits == 8:
            a = np.frombuffer(data, dtype=np.uint8).astype(np.float64)
            a = (a - 128.0) / 128.0
        elif bits == 16:
            a = np.frombuffer(data, dtype="<i2").astype(np.float64) / 32768.0
        elif bits == 24:
            n = len(data) // 3
            b = np.frombuffer(data[:n * 3], dtype=np.uint8).reshape(n, 3).astype(np.int32)
            v = (b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)).astype(np.int32)
            v = np.where(v >= (1 << 23), v - (1 << 24), v)
            a = v.astype(np.float64) / float(1 << 23)
        elif bits == 32:
            a = np.frombuffer(data, dtype="<i4").astype(np.float64) / float(1 << 31)
        else:
            raise ValueError("unsupported PCM bit depth %d" % bits)
    elif tag == 3:
        dt = "<f4" if bits == 32 else "<f8"
        a = np.frombuffer(data, dtype=dt).astype(np.float64)
    else:
        raise ValueError("unsupported WAV format tag 0x%04x" % tag)

    if channels > 1:
        usable = (len(a) // channels) * channels
        a = a[:usable].reshape(-1, channels)
    return sr, a, channels, bits


def _fmt_chunk_bits(path):
    """Bit depth straight from the fmt chunk.

    scipy hands 24-bit PCM back as int32, so trusting the returned dtype claims
    every 24-bit file is 32-bit. The header knows.
    """
    try:
        with open(path, "rb") as fh:
            raw = fh.read(4096)
        if raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
            return None
        pos = 12
        while pos + 8 <= len(raw):
            cid = raw[pos:pos + 4]
            csize = struct.unpack("<I", raw[pos + 4:pos + 8])[0]
            if cid == b"fmt " and csize >= 16:
                return int(struct.unpack("<H", raw[pos + 22:pos + 24])[0])
            pos += 8 + csize + (csize & 1)
    except (OSError, struct.error, IndexError):
        return None
    return None


def load_wav(path):
    """Return (mono float64 signal in [-1, 1], sample rate, metadata dict)."""
    channels = None
    bits = None
    try:
        from scipy.io import wavfile
        sr, data = wavfile.read(path)
        if data.dtype == np.uint8:
            x = (data.astype(np.float64) - 128.0) / 128.0
            bits = 8
        elif data.dtype == np.int16:
            x = data.astype(np.float64) / 32768.0
            bits = 16
        elif data.dtype == np.int32:
            x = data.astype(np.float64) / float(1 << 31)
            bits = 32
        elif data.dtype in (np.float32, np.float64):
            x = data.astype(np.float64)
            bits = 32 if data.dtype == np.float32 else 64
        else:
            raise ValueError("unhandled dtype %s" % data.dtype)
        channels = 1 if x.ndim == 1 else x.shape[1]
    except Exception:
        sr, x, channels, bits = _read_wav_manual(path)

    x = np.asarray(x, dtype=np.float64)
    if x.ndim > 1:
        mono = x.mean(axis=1)
    else:
        mono = x
    mono = mono - float(np.mean(mono))  # kill DC; mic preamps drift
    hdr_bits = _fmt_chunk_bits(path)
    meta = {
        "path": os.path.abspath(path),
        "sample_rate": int(sr),
        "channels": int(channels or 1),
        "bit_depth": hdr_bits if hdr_bits else bits,
        "n_samples": int(mono.size),
        "duration_s": float(mono.size) / float(sr),
    }
    return mono, int(sr), meta


# ----------------------------------------------------------------------------
# small helpers
# ----------------------------------------------------------------------------

def db(x, floor=-300.0):
    x = np.asarray(x, dtype=np.float64)
    out = 20.0 * np.log10(np.maximum(np.abs(x), 1e-15))
    return np.maximum(out, floor)


def analytic_envelope(x, sr, smooth_ms=1.0):
    """|hilbert(x)| smoothed with a moving average."""
    n = x.size
    nfft = next_fast_len(n)
    env = np.abs(sig.hilbert(x, N=nfft)[:n])
    w = max(1, int(round(smooth_ms * 1e-3 * sr)))
    if w > 1:
        env = uniform_filter1d(env, size=w, mode="nearest")
    return env


def linfit(t, y):
    """Least-squares line fit. Returns (slope, intercept, r2)."""
    t = np.asarray(t, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    if t.size < 3:
        return float("nan"), float("nan"), 0.0
    A = np.vstack([t, np.ones_like(t)]).T
    coef, *_ = np.linalg.lstsq(A, y, rcond=None)
    slope, icpt = float(coef[0]), float(coef[1])
    pred = slope * t + icpt
    ss_res = float(np.sum((y - pred) ** 2))
    ss_tot = float(np.sum((y - np.mean(y)) ** 2))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
    return slope, icpt, r2


def cents(ratio_measured, ratio_ideal):
    if ratio_measured <= 0 or ratio_ideal <= 0:
        return float("nan")
    return 1200.0 * math.log2(ratio_measured / ratio_ideal)


def trailing_taper_window(n, taper=0.5):
    """Rectangular leading edge, half-Blackman-Harris trailing edge.

    A struck note starts at the onset, so the signal is already zero before the
    window: a rectangular leading edge introduces no discontinuity in the
    windowed signal. Tapering only the tail keeps fast-decaying partials at full
    weight (a symmetric Blackman-Harris puts near-zero weight exactly where they
    are loud) while still suppressing trailing-edge leakage. The taper is the
    falling half of a Blackman-Harris window, which meets the flat section with
    matched value and near-zero slope, so the sidelobes fall away quickly.
    """
    w = np.ones(n, dtype=np.float64)
    k = int(round(taper * n))
    if k > 1:
        bh = sig.windows.blackmanharris(2 * k, sym=True)[k:]
        w[n - k:] = bh / bh[0]
    return w


def dtft_mag(xw, sr, f):
    """|DTFT| of an already-windowed segment at an arbitrary frequency."""
    n = np.arange(xw.size, dtype=np.float64)
    return float(np.abs(np.dot(xw, np.exp(-2j * np.pi * f * n / sr))))


def golden_max(fn, lo, hi, tol=1e-4, iters=60):
    """Golden-section maximisation of a unimodal fn on [lo, hi]."""
    invphi = (math.sqrt(5.0) - 1.0) / 2.0
    a, b = lo, hi
    c = b - invphi * (b - a)
    d = a + invphi * (b - a)
    fc, fd = fn(c), fn(d)
    for _ in range(iters):
        if (b - a) < tol:
            break
        if fc > fd:
            b, d, fd = d, c, fc
            c = b - invphi * (b - a)
            fc = fn(c)
        else:
            a, c, fc = c, d, fd
            d = a + invphi * (b - a)
            fd = fn(d)
    return 0.5 * (a + b)


# ----------------------------------------------------------------------------
# 1. onset and attack
# ----------------------------------------------------------------------------

def onset_detection_function(x, sr, fmin_hz=ODF_FMIN_HZ, win=ODF_WIN,
                             hop=ODF_HOP, lag=ODF_LAG):
    """Half-wave-rectified spectral flux: one value per hop, plus the frame times.

    Flux answers "how much spectral content appeared that was not there a
    moment ago", which is what a strike is. A swell answers no, because it
    spreads the same rise over hundreds of frames. Bins below `fmin_hz` are
    dropped so rumble, footsteps and HVAC cannot vote.
    """
    if x.size < win + hop:
        return np.zeros(1), np.zeros(1)
    nfrm = 1 + (x.size - win) // hop
    idx = np.arange(win)[None, :] + hop * np.arange(nfrm)[:, None]
    frames = x[idx] * np.hanning(win)[None, :]
    mag = np.abs(rfft(frames, axis=1))
    freqs = rfftfreq(win, 1.0 / sr)
    lo = int(np.searchsorted(freqs, fmin_hz))
    mag = mag[:, lo:]
    if mag.shape[0] <= lag or mag.shape[1] < 2:
        return np.zeros(1), np.zeros(1)
    d = mag[lag:] - mag[:-lag]
    flux = np.sum(np.maximum(d, 0.0), axis=1)
    times = (np.arange(lag, nfrm) * hop + win * 0.5) / sr
    return flux, times


def find_strike(x, sr, fmin_hz=ODF_FMIN_HZ):
    """Coarse sample index of the strongest transient, with its prominence.

    Returns (index, info). `info["flux_prominence_db"]` is how far the winning
    flux peak stands above the typical flux of the rest of the file; a clip that
    contains no strike scores low here and the caller can say so.
    """
    flux, times = onset_detection_function(x, sr, fmin_hz=fmin_hz)
    if flux.size < 4 or float(np.max(flux)) <= 0:
        return None, {"flux_prominence_db": None, "note": "no usable flux"}
    k = int(np.argmax(flux))
    med = float(np.median(flux))
    prom_db = float(10.0 * np.log10(max(float(flux[k]), EPS) / max(med, EPS)))
    return int(round(times[k] * sr)), {
        "flux_prominence_db": prom_db,
        "flux_peak_s": float(times[k]),
        "flux_fmin_hz": float(fmin_hz),
    }


def _attack_peak(excess, sr, lo, hi):
    """Index where the strike stops rising, and how far the envelope creeps past it.

    Taking the plain maximum over the window is what turns a 3 ms strike into a
    24 ms one: on a real recording the envelope keeps inching up for tens of
    milliseconds after the strike, because partials beat back into phase and a
    mastering limiter lets go, and referencing 90% to a top reached 50 ms late
    drags the crossing with it. The running maximum's growth rate separates the
    two cleanly - the strike climbs orders of magnitude faster than the creep.
    """
    seg = excess[lo:hi]
    if seg.size < 4:
        return lo + int(np.argmax(seg)) if seg.size else lo, 0.0
    runmax = np.maximum.accumulate(seg)
    top = float(runmax[-1])
    if top <= 0:
        return lo + int(np.argmax(seg)), 0.0
    L = max(1, int(round(ATTACK_SETTLE_LOOKAHEAD_S * sr)))
    future = np.concatenate([runmax[L:], np.full(min(L, runmax.size), top)])[:runmax.size]
    gain_db = 20.0 * np.log10(np.maximum(future, EPS) / np.maximum(runmax, EPS))
    ok = (runmax >= ATTACK_SETTLE_MIN_FRAC * top) & (gain_db < ATTACK_SETTLE_DB)
    hit = np.nonzero(ok)[0]
    k = int(hit[0]) if hit.size else int(np.argmax(seg))
    peak_i = lo + int(np.argmax(seg[:k + 1]))
    creep_db = float(db(top) - db(excess[peak_i])) if excess[peak_i] > 0 else 0.0
    return peak_i, creep_db


def measure_onset(x, sr):
    """Onset, attack and peak of the strike.

    Two things separate this from "find the biggest sample". The anchor is the
    spectral-flux transient, so a later swell cannot claim to be the attack. And
    the crossings are taken on an envelope with the pre-strike level subtracted
    in power, so a tube left ringing from an earlier hit does not sit above the
    10% line before the strike has happened.
    """
    env = analytic_envelope(x, sr, smooth_ms=1.0)
    global_peak_i = int(np.argmax(env))
    global_peak = float(env[global_peak_i])
    if global_peak <= 0:
        raise ValueError("signal is silent")

    coarse_i, flux_info = find_strike(x, sr)
    if coarse_i is None:
        coarse_i = global_peak_i
    coarse_i = int(np.clip(coarse_i, 0, x.size - 1))

    # What was already ringing just before the strike. The window has to sit
    # before the ONSET, not before the flux frame: the flux frame is centred, so
    # on a file that opens with the strike (any offline render does) a window
    # measured back from it lands inside the attack, reads the strike as the
    # room tone, and the strike then appears to add nothing. So take a
    # provisional onset first, with no baseline, and measure back from that.
    w_lo0 = max(0, coarse_i - int(round(0.010 * sr)))
    w_hi0 = min(x.size, coarse_i + int(round(ATTACK_PEAK_WINDOW_S * sr)))
    prov_peak = float(np.max(env[w_lo0:w_hi0])) if w_hi0 > w_lo0 else float(env[coarse_i])
    prov_lo = max(0, coarse_i - int(round(0.040 * sr)))
    below0 = np.nonzero(env[prov_lo:coarse_i + 1] < 0.02 * prov_peak)[0]
    if below0.size:
        prov_onset = prov_lo + int(below0[-1])
    else:
        # Nothing here ever got quiet - another tube is still ringing. Fall back
        # to the earliest instant the flux peak could be reporting: it compares a
        # frame against one ODF_LAG hops earlier, so the strike cannot be more
        # than half a window plus that lag ahead of the frame centre.
        prov_onset = max(prov_lo, coarse_i - (ODF_WIN // 2 + ODF_LAG * ODF_HOP))

    guard = int(round(BASELINE_GUARD_S * sr))
    b_hi = max(0, prov_onset - guard)
    b_lo = max(0, b_hi - int(round(BASELINE_WIN_S * sr)))
    if b_hi - b_lo >= int(0.004 * sr):
        baseline = float(np.sqrt(np.mean(env[b_lo:b_hi] ** 2)))
        baseline_s = (b_lo / sr, b_hi / sr)
    else:
        # No room before the strike to measure anything. A render that opens on
        # the hit is the normal case here, and its true pre-strike level is
        # silence, so subtract nothing rather than subtracting the strike.
        baseline = 0.0
        baseline_s = None

    # Envelope of what the strike added, on top of what was already there.
    # Energies add, amplitudes do not, so the subtraction is in power.
    excess = np.sqrt(np.maximum(env ** 2 - baseline ** 2, 0.0))

    # The strike's own peak lives in a bounded window after it. Search from a
    # little before the coarse index, because the flux frame is centred and can
    # land a few milliseconds late on a very fast attack.
    w_lo = max(0, coarse_i - int(round(0.010 * sr)))
    w_hi = min(x.size, coarse_i + int(round(ATTACK_PEAK_WINDOW_S * sr)))
    if w_hi <= w_lo + 1:
        w_lo, w_hi = 0, x.size
    peak_i, creep_db = _attack_peak(excess, sr, w_lo, w_hi)
    peak = float(excess[peak_i])
    peak_abs = float(env[peak_i])

    def back_cross(start_i, level, limit_i):
        """Last index in [limit_i, start_i] where excess < level."""
        seg = excess[limit_i:start_i + 1]
        below = np.nonzero(seg < level)[0]
        return int(limit_i + below[-1]) if below.size else None

    def fwd_cross(start_i, level, stop_i):
        seg = excess[start_i:stop_i + 1]
        above = np.nonzero(seg >= level)[0]
        return int(start_i + above[0]) if above.size else None

    # Walk back from the strike's peak to the last moment it had not started.
    # The search is bounded: nothing earlier than 40 ms before the flux peak can
    # be this strike's onset, which stops a quiet passage far earlier in the
    # file from being adopted as the onset.
    search_lo = max(0, coarse_i - int(round(0.040 * sr)))
    # Subtracting a constant baseline from a tone that wobbles leaves a
    # residual, and on a clip with another tube still ringing that residual sits
    # well above 2% of the strike. Requiring the crossing to clear it too is what
    # stops "the envelope never got quiet enough" from being reported as "there
    # is no strike here".
    resid = 0.0
    if baseline_s is not None and b_hi > b_lo:
        r = float(np.sqrt(np.mean(excess[b_lo:b_hi] ** 2)))
        resid = r if np.isfinite(r) else 0.0
    onset = None
    if peak > 0:
        onset = back_cross(peak_i, max(0.02 * peak, 4.0 * resid), search_lo)
    truncated = onset is None
    onset_i = onset if onset is not None else search_lo

    rise_db = float(db(peak_abs) - db(baseline)) if baseline > 0 else None
    detected = bool(
        peak > 0
        and not truncated
        and (rise_db is None or rise_db >= MIN_ONSET_RISE_DB)
    )

    attack_ms = None
    i10 = i90 = None
    if detected:
        i10 = fwd_cross(onset_i, 0.1 * peak, peak_i)
        i90 = fwd_cross(i10 if i10 is not None else onset_i, 0.9 * peak, peak_i)
        if i10 is not None and i90 is not None and i90 >= i10:
            attack_ms = (i90 - i10) / sr * 1000.0

    if onset_i > int(0.005 * sr):
        noise_rms = float(np.sqrt(np.mean(x[:onset_i] ** 2)))
    else:
        noise_rms = 0.0

    note = ""
    if truncated:
        note = ("no onset in the file: the envelope never falls below the strike "
                "level before it, so the clip starts after the attack")
    elif rise_db is not None and rise_db < MIN_ONSET_RISE_DB:
        note = ("the loudest transient adds only %.1f dB over what was already "
                "ringing; too little to call an attack" % rise_db)
    elif baseline <= 0:
        note = ("no room before the strike to measure what was already ringing; "
                "the attack is measured against silence")

    return {
        "onset_s": onset_i / sr,
        "onset_index": onset_i,
        "onset_detected": detected,
        "peak_s": peak_i / sr,
        "peak_after_onset_ms": ((peak_i - onset_i) / sr * 1000.0) if detected else None,
        "peak_level_dbfs": float(db(peak_abs)),
        "attack_peak_creep_db": float(creep_db),
        "attack_10_90_ms": attack_ms,
        "t10_s": (i10 / sr) if i10 is not None else None,
        "t90_s": (i90 / sr) if i90 is not None else None,
        "onset_truncated": bool(truncated),
        "onset_rise_db": rise_db,
        "pre_strike_level_dbfs": float(db(baseline)) if baseline > 0 else None,
        "pre_strike_window_s": list(baseline_s) if baseline_s else None,
        "global_peak_s": global_peak_i / sr,
        "global_peak_level_dbfs": float(db(global_peak)),
        "global_peak_after_onset_ms": (global_peak_i - onset_i) / sr * 1000.0,
        "peak_is_global": bool(abs(global_peak_i - peak_i) <= int(0.005 * sr)),
        "flux": flux_info,
        "pre_onset_noise_rms_dbfs": float(db(noise_rms)) if noise_rms > 0 else None,
        "note": note,
        "_env": env,
        "_peak_i": peak_i,
    }


# ----------------------------------------------------------------------------
# 2. partial detection
# ----------------------------------------------------------------------------

def _spectrum(x, sr, start_i, dur_s, taper, pad=8):
    n = min(int(round(dur_s * sr)), x.size - start_i)
    if n < 64:
        return None
    seg = x[start_i:start_i + n]
    w = trailing_taper_window(n, taper=taper)
    xw = seg * w
    nfft = next_fast_len(min(n * pad, 1 << 23))
    X = rfft(xw, n=nfft)
    freqs = rfftfreq(nfft, 1.0 / sr)
    return {
        "seg": seg, "win": w, "xw": xw, "n": n, "sr": sr,
        "X": X, "mag": np.abs(X), "freqs": freqs, "nfft": nfft,
        "df": sr / nfft, "pad": nfft / n, "start_i": start_i,
    }


def _local_floor_db(m_db, lo, hi, df, block_hz=200.0):
    """Blockwise median of the log magnitude: a cheap local noise floor.

    A full median filter over a heavily zero-padded spectrum is far too slow, so
    take the median of each block and interpolate between block centres.
    """
    n = hi - lo
    nb = max(4, int(round(n * df / block_hz)))
    edges = np.linspace(lo, hi, nb + 1).astype(int)
    ctr, val = [], []
    for a, b in zip(edges[:-1], edges[1:]):
        if b - a >= 4:
            ctr.append(0.5 * (a + b))
            val.append(float(np.median(m_db[a:b])))
    if not ctr:
        return np.full(n, -200.0)
    return np.interp(np.arange(lo, hi, dtype=np.float64), ctr, val)


def _peaks_from(spec, floor_db, fmin, fmax, min_snr_db=15.0):
    mag = spec["mag"]
    freqs = spec["freqs"]
    m_db = db(mag, floor=-200.0)
    lo = np.searchsorted(freqs, fmin)
    hi = np.searchsorted(freqs, fmax)
    if hi - lo < 8:
        return []
    band = m_db[lo:hi]
    top = float(np.max(band))
    nfloor = _local_floor_db(m_db, lo, hi, spec["df"])
    # main-lobe half width of the trailing-taper window ~2 unpadded bins
    dist = max(2, int(round(2.0 * spec["pad"])))
    idx, props = sig.find_peaks(band, height=top - floor_db, distance=dist,
                                prominence=4.0)
    out = []
    for k, p in zip(idx, props["prominences"]):
        if band[k] - nfloor[k] < min_snr_db:
            continue          # not above the local noise floor: not a partial
        i = k + lo
        if i <= 0 or i >= m_db.size - 1:
            continue
        # parabolic interpolation on the log magnitude
        y0, y1, y2 = m_db[i - 1], m_db[i], m_db[i + 1]
        denom = (y0 - 2.0 * y1 + y2)
        delta = 0.0 if abs(denom) < 1e-12 else 0.5 * (y0 - y2) / denom
        delta = float(np.clip(delta, -1.0, 1.0))
        f = float(freqs[i] + delta * spec["df"])
        out.append({"f": f, "db": float(y1), "prominence_db": float(p)})
    return out


def _refine_dtft(spec, f0):
    """Golden-section maximisation of the true DTFT magnitude near f0."""
    span = 1.5 * spec["sr"] / spec["n"]  # +/- ~1.5 unpadded bins
    lo = max(1.0, f0 - span)
    hi = min(spec["sr"] * 0.499, f0 + span)
    xw = spec["xw"]
    sr = spec["sr"]
    return float(golden_max(lambda f: dtft_mag(xw, sr, f), lo, hi, tol=1e-4))


def _band_amplitude(spec, f, half_hz):
    """RMS amplitude of the spectral energy within +/- half_hz of f.

    Parseval on the windowed segment, corrected for the window's power gain.
    Robust to a partial that is split into two unresolved sub-peaks.
    """
    freqs = spec["freqs"]
    mag = spec["mag"]
    lo = np.searchsorted(freqs, f - half_hz)
    hi = np.searchsorted(freqs, f + half_hz)
    if hi <= lo:
        return 0.0
    # energy of a real signal: both halves of the spectrum
    e = 2.0 * float(np.sum(mag[lo:hi] ** 2)) / (spec["nfft"] ** 2)
    wpow = float(np.mean(spec["win"] ** 2))
    if wpow <= 0:
        return 0.0
    # e is mean-square contribution over the padded frame; rescale to the segment
    e *= (spec["nfft"] / spec["n"])
    return float(math.sqrt(max(e / wpow, 0.0)) * math.sqrt(2.0))


# --- sub-peak grouping ------------------------------------------------------
#
# A struck tube's mode is two lines, not one: the tube is never perfectly round,
# so the two orthogonal bending polarisations sit a few Hz apart and beat. Those
# two lines have to be merged into one partial or every measurement downstream
# reads a split as two partials. Merging them, though, is exactly the operation
# that can swallow the noise floor.
#
# On a coded or mastered source the noise under a loud tone is shaped like the
# tone: a dense skirt of small peaks reaching tens of Hz either side. The skirt
# peaks sit close enough together that a merge rule which chains from the last
# sub-peak added walks straight through them and joins the real line at the far
# end. Measured on a render put through the Corinthian's channel: one "partial"
# of 28 sub-peaks spanning 59 Hz, its amplitude-weighted centre dragged to
# 451.19 Hz when the line is at 463.65, an error of 47 cents. That error then
# propagated into every inharmonicity ratio and widened the partial's analysis
# band to 46 Hz, inside which the beat detector read the skirt's 37 Hz wobble as
# the tube's beat rate.
#
# Two rules stop it, and both are anchored on the strongest sub-peak in the run
# rather than chained:
#   - frequency: a member must lie within SPLIT_MERGE_* of the anchor, so a
#     group's span is bounded instead of accumulating;
#   - level: a member must be within SKIRT_DROP_DB of the anchor.
#
# SKIRT_DROP_DB = 18 comes from the reference set. The weaker line of a real
# polarisation pair measures 0.1 to 15.1 dB below the stronger one across the
# three clean clips and the five clips of the owner's own chime (largest
# observed: 15.1 dB, Flower of Life at 551 Hz). Skirt members in the same clips
# start at 19.2 dB down and run past 35 dB. 18 dB sits in that gap.
SPLIT_MERGE_FRAC = 0.006
SPLIT_MERGE_MIN_HZ = 10.0
SPLIT_MERGE_MAX_HZ = 50.0
SKIRT_DROP_DB = 18.0


def _merge_bw(f):
    return min(max(SPLIT_MERGE_MIN_HZ, SPLIT_MERGE_FRAC * f), SPLIT_MERGE_MAX_HZ)


def _chain_runs(peaks):
    """Contiguous runs of sub-peaks, each within a merge bandwidth of the last.

    This is only a cheap way to find candidate neighbourhoods. A run is not a
    partial: _split_run decides what inside it is one.
    """
    runs = []
    for p in peaks:            # requires peaks sorted by frequency
        if runs and p["f"] - runs[-1][-1]["f"] <= _merge_bw(runs[-1][-1]["f"]):
            runs[-1].append(p)
        else:
            runs.append([p])
    return runs


def _split_run(run, skirt, depth=0):
    """Resolve one run into groups, anchored on its strongest sub-peak.

    Sub-peaks near the anchor in both frequency and level are its polarisation
    partners. Anything far enough below it is the anchor's own noise skirt and
    is discarded (recorded in `skirt`). Anything comparable in level but outside
    the merge bandwidth is a genuinely separate line that happened to chain in,
    and is re-run as its own neighbourhood. Each pass consumes at least the
    anchor, so the recursion terminates.
    """
    if not run:
        return []
    anchor = max(run, key=lambda p: p["db"])
    bw = _merge_bw(anchor["f"])
    members, rest = [], []
    for p in run:
        drop = anchor["db"] - p["db"]
        if drop > SKIRT_DROP_DB:
            skirt.append({"freq_hz": float(p["f"]), "peak_db": float(p["db"]),
                          "anchor_hz": float(anchor["f"]),
                          "delta_db": float(drop)})
        elif abs(p["f"] - anchor["f"]) <= bw:
            members.append(p)
        else:
            rest.append(p)
    out = [{"subpeaks": members}]
    if rest and depth < 32:
        for sub in _chain_runs(rest):
            out.extend(_split_run(sub, skirt, depth + 1))
    return out


def detect_partials(x, sr, onset_i, max_partials=10, min_partials=6,
                    floor_db=45.0, fmin=40.0, fmax=None, refine=True,
                    min_snr_db=15.0):
    if fmax is None:
        fmax = min(0.45 * sr, 20000.0)

    start = max(0, onset_i - int(0.002 * sr))
    long_spec = _spectrum(x, sr, start, 3.0, taper=0.5, pad=8)
    short_spec = _spectrum(x, sr, start, 0.25, taper=0.5, pad=16)
    if long_spec is None:
        long_spec = short_spec
    if long_spec is None:
        return [], None, None

    peaks = _peaks_from(long_spec, floor_db + 10.0, fmin, fmax, min_snr_db)
    if short_spec is not None:
        for p in _peaks_from(short_spec, floor_db + 10.0, fmin, fmax, min_snr_db):
            tol = max(10.0, 0.004 * p["f"])
            if not any(abs(p["f"] - q["f"]) < tol for q in peaks):
                p["_from_short"] = True
                peaks.append(p)
    if not peaks:
        return [], long_spec, short_spec

    # A noisy recording throws off hundreds of small peaks and each refinement
    # costs a run of DTFT evaluations, so keep only the strongest candidates.
    # The cap is generous: several times more than can survive selection.
    cap = 6 * max_partials + 20
    if len(peaks) > cap:
        peaks.sort(key=lambda p: -p["db"])
        peaks = peaks[:cap]

    # refine each peak against the true DTFT of the long window
    for p in peaks:
        sp = long_spec if not p.get("_from_short") else (short_spec or long_spec)
        p["f_coarse"] = p["f"]
        p["f"] = _refine_dtft(sp, p["f"]) if refine else p["f"]

    peaks.sort(key=lambda p: p["f"])

    # group sub-peaks that belong to the same physical partial (polarisation
    # splits show up as two lines a few Hz apart), then strip the noise skirt
    skirt = []
    groups = []
    for run in _chain_runs(peaks):
        groups.extend(_split_run(run, skirt))
    groups.sort(key=lambda g: min(s["f"] for s in g["subpeaks"]))

    for g in groups:
        subs = g["subpeaks"]
        fs = np.array([s["f"] for s in subs])
        wts = np.array([10.0 ** (s["db"] / 20.0) for s in subs])
        g["f"] = float(np.sum(fs * wts) / np.sum(wts))  # amplitude-weighted centre
        g["peak_db"] = float(max(s["db"] for s in subs))
        g["split_hz"] = float(fs.max() - fs.min()) if len(subs) > 1 else 0.0
        g["n_subpeaks"] = len(subs)
        g["sub_freqs"] = [float(s["f"]) for s in subs]
        g["_fmin"] = float(fs.min())
        g["_fmax"] = float(fs.max())

    # Leakage rejection. A window sidelobe shows up as a much weaker peak a
    # short distance from a strong one. Anything more than LEAK_DB below a
    # neighbour within LEAK_FRAC of its frequency is treated as leakage. Real
    # polarisation splits survive this because they were merged into the same
    # group above, before this test runs.
    LEAK_DB, LEAK_FRAC, LEAK_MIN_HZ = 22.0, 0.025, 30.0
    live, rejected = [], []
    for g in groups:
        masker = None
        for h in groups:
            if h is g:
                continue
            span = max(LEAK_MIN_HZ, LEAK_FRAC * h["f"])
            if h["peak_db"] - g["peak_db"] > LEAK_DB and abs(h["f"] - g["f"]) < span:
                masker = h
                break
        if masker is None:
            live.append(g)
        else:
            rejected.append({"freq_hz": g["f"], "peak_db": g["peak_db"],
                             "masked_by_hz": masker["f"],
                             "delta_db": masker["peak_db"] - g["peak_db"]})
    groups = live if live else groups

    # amplitude from band energy in the short window, with the band clipped so
    # neighbouring partials cannot lend it energy
    amp_spec = short_spec or long_spec
    for i, g in enumerate(groups):
        gap = min([abs(h["f"] - g["f"]) for h in groups if h is not g] or [1e9])
        half = min(max(12.0, 0.008 * g["f"]), 60.0)
        half = max(half, 0.6 * (g["_fmax"] - g["_fmin"]) + 6.0)
        half = min(half, 0.45 * gap) if gap < 1e8 else half
        half = max(half, 4.0)
        g["_band_half_hz"] = float(half)
        g["amp"] = _band_amplitude(amp_spec, g["f"], half)

    groups.sort(key=lambda g: g["amp"], reverse=True)
    if not groups or groups[0]["amp"] <= 0:
        return [], long_spec, short_spec
    top_amp = groups[0]["amp"]
    keep = [g for g in groups if db(g["amp"]) - db(top_amp) >= -floor_db]
    if len(keep) < min_partials:
        keep = [g for g in groups if db(g["amp"]) - db(top_amp) >= -60.0]
    keep = keep[:max_partials]
    keep.sort(key=lambda g: g["f"])
    for i, g in enumerate(keep):
        g["index"] = i + 1
        g["rel_db"] = float(db(g["amp"]) - db(top_amp))
        g["amp_dbfs"] = float(db(g["amp"]))
    if keep:
        keep[0]["_rejected"] = rejected
        keep[0]["_skirt"] = sorted(skirt, key=lambda s: -s["peak_db"])[:24]
    return keep, long_spec, short_spec


# ----------------------------------------------------------------------------
# 3 & 4. per-partial decay and beating
# ----------------------------------------------------------------------------

def _bandpass_lohi(x, sr, lo, hi, order=4, zero_phase=True):
    """Returns (filtered, sos) or (None, None)."""
    lo = max(1.0, lo)
    hi = min(0.995 * 0.5 * sr, hi)
    if hi <= lo * 1.0001:
        return None, None
    sos = sig.butter(order, [lo / (0.5 * sr), hi / (0.5 * sr)], btype="band", output="sos")
    try:
        y = sig.sosfiltfilt(sos, x) if zero_phase else sig.sosfilt(sos, x)
    except ValueError:
        return None, None
    return y, sos


def _bandpass(x, sr, f, bw):
    return _bandpass_lohi(x, sr, f - bw, f + bw)


def band_noise_power(sos, sr, wideband_power, zero_phase=True):
    """Power that a white noise floor of `wideband_power` leaves inside a band.

    The pre-onset silence cannot be measured through the filter directly:
    sosfiltfilt is non-causal and smears the strike backwards over the whole
    impulse response, which for a 15 Hz-wide band is tens of milliseconds. So
    measure the noise wideband and scale it by the filter's noise bandwidth.
    """
    if wideband_power is None or not np.isfinite(wideband_power):
        return None
    w, h = sig.sosfreqz(sos, worN=4096, fs=sr)
    gain = np.abs(h) ** (4 if zero_phase else 2)   # filtfilt applies |H| twice
    frac = float(np.trapezoid(gain, w) / (0.5 * sr))
    return float(wideband_power * frac)


# Block length and span for the direct decay below. One second is long enough to
# average out a 1-2 Hz doublet beat, which is what the reference fundamentals
# do, and five blocks is what a six second clip has room for.
DIRECT_BLOCK_S = 1.0
DIRECT_BLOCKS = 6


def measure_t60_direct(band, sr, onset_i, noise_power=None):
    """Decay rate with nothing extrapolated: least squares through the band's
    own energy, in one-second blocks, from the onset to the end of the clip.

    WHY A SECOND ESTIMATOR. measure_t60() below is the right tool and stays the
    primary number, but it is a Schroeder fit and a Schroeder curve on a clip
    that ends before the sound does bends downward at its end, so the answer
    depends on which stretch of the curve gets fitted. On the corinthian
    reference that dependence is not subtle: fitting -5..-15 dB gives 15.9 s,
    -5..-25 gives 11.6, -10..-30 gives 8.3 and -15..-35 gives 4.6, a factor of
    3.4 across four defensible choices, and the method the code picks flips with
    how much decay it thinks it has. Both critics of the last round named that
    step as the thing that makes small T60 changes unreadable.

    This estimator has no fit range to choose, no truncation compensation and no
    tail model. It is just "how many dB did this band lose per second", which is
    a weaker question but one with a single answer.

    MEASURED, on the three references and on our own renders of them. On our
    renders - clean single exponentials - the two agree to 7 percent. On the
    recordings they part company: 20.2 / 12.7 / 21.1 s direct against 14.5 /
    14.3 / 17.5 s Schroeder. That gap is not noise and it is not the model; it
    is what a truncated Schroeder fit does to a decay longer than its clip. It
    is reported rather than resolved, because resolving it needs recordings
    longer than six seconds, which is a question for the reference set and not
    for the estimator.
    """
    seg = band[onset_i:]
    n = int(round(DIRECT_BLOCK_S * sr))
    if seg.size < 3 * n:
        return None
    noise = float(noise_power) if (noise_power and np.isfinite(noise_power)) else 0.0
    ts, vs = [], []
    for k in range(DIRECT_BLOCKS):
        i0, i1 = k * n, (k + 1) * n
        if i1 > seg.size:
            break
        p = float(np.mean(seg[i0:i1] ** 2)) - noise
        if p <= 0:                      # into the floor: stop, do not fit noise
            break
        ts.append(k * DIRECT_BLOCK_S + 0.5 * DIRECT_BLOCK_S)
        vs.append(10.0 * math.log10(p))
    if len(ts) < 3:
        return None
    slope, _icpt, r2 = linfit(np.array(ts), np.array(vs))
    if not np.isfinite(slope) or slope >= 0:
        return None
    return {"t60_s": float(-60.0 / slope), "blocks": len(ts),
            "span_s": float(ts[-1] - ts[0]), "fit_r2": float(r2),
            "drop_db": float(vs[0] - vs[-1])}


def measure_t60(band, sr, onset_i, band_noise_power=None):
    """Schroeder backward integration, T20 fit (T10 fallback).

    Two standard corrections are applied: the noise power is subtracted from the
    energy before integrating (Chu), and the energy the recording cut off is
    estimated from the first fit and added back, so a decay that outlasts the
    file is not reported as shorter than it is.

    See measure_t60_direct() above for the unextrapolated second opinion, and
    for why it is worth having one.
    """
    seg = band[onset_i:]
    if seg.size < int(0.05 * sr):
        return {"valid": False, "note": "segment too short"}

    e = seg ** 2
    wlen = max(1, int(0.02 * sr))
    sm = uniform_filter1d(e, size=wlen, mode="nearest")
    peak_e = float(np.max(sm))
    if peak_e <= 0:
        return {"valid": False, "note": "band is silent"}

    # Noise power in this band: pre-onset silence if there is any, otherwise the
    # quietest stretch of the tail (which over-estimates when the note is still
    # ringing at the end of the file, so prefer the silence).
    noise_src = "pre-onset"
    if band_noise_power is None or not np.isfinite(band_noise_power):
        tail_start = int(0.5 * sm.size)
        noise = float(np.percentile(sm[tail_start:], 5)) if sm.size - tail_start > 10 else 0.0
        noise_src = "file tail"
    else:
        noise = float(band_noise_power)

    # Lundeby-style truncation: stop integrating 5 dB above the noise floor
    trunc = sm.size
    if 0 < noise < peak_e:
        thr = noise * (10 ** 0.5)
        pk = int(np.argmax(sm))
        below = np.nonzero(sm[pk:] < thr)[0]
        if below.size:
            trunc = int(pk + below[0])
    trunc = max(trunc, int(0.05 * sr))
    trunc = min(trunc, sm.size)

    ecut = e[:trunc] - noise
    base_energy = float(np.sum(ecut))
    if base_energy <= 0:
        return {"valid": False, "note": "no energy above the noise floor"}

    def build_edc(tail_energy):
        edc = np.cumsum(ecut[::-1])[::-1] + max(tail_energy, 0.0)
        if edc[0] <= 0:
            return None, None
        d = 10.0 * np.log10(np.maximum(edc / edc[0], 1e-30))
        keep = int(0.95 * d.size)  # the very end of a Schroeder curve plunges
        return d[:keep], np.arange(keep) / sr

    def fit_between(edc_db, t, d_hi, d_lo):
        i0 = np.nonzero(edc_db <= d_hi)[0]
        i1 = np.nonzero(edc_db <= d_lo)[0]
        if i0.size == 0 or i1.size == 0:
            return None
        a, b = int(i0[0]), int(i1[0])
        if b - a < 10:
            return None
        slope, icpt, r2 = linfit(t[a:b], edc_db[a:b])
        if not np.isfinite(slope) or slope >= 0:
            return None
        return {"slope": slope, "r2": r2, "a": a, "b": b,
                "range_db": (d_hi, d_lo), "n": b - a}

    def best_fit(edc_db, t):
        # A Schroeder curve always bends downward as it runs out of decay to
        # integrate, so keep a 3 dB margin between the bottom of the fit and the
        # lowest value the curve reached. Fitting into that bend is what makes a
        # 6 s decay read as 3.5 s in a file that was cut short.
        #
        # THE FIT RANGE SLIDES; IT DOES NOT SNAP. This used to be three discrete
        # regimes - T20 below a reach of -28 dB, T10 below -18, a short partial
        # fit above that - and the regimes disagreed with each other, so a signal
        # sitting on a boundary got a different answer for a rounding error's
        # worth of reason. It was not hypothetical: adding the exact cylindrical
        # radiation resistance to modal.js moved our corinthian render's reach
        # from 27.8 dB to 28.0, flipped T10 to T20, and moved the reported T60
        # from 15.04 s to 13.27 s - a 12 percent step out of a signal whose
        # actual decay had changed by 0.1 percent, and enough on its own to take
        # a render from inside the bar's 14-18 s window to outside it. Both
        # critics of the previous round named this step as the thing that made
        # small T60 changes unreadable; this is the repair.
        #
        # The bottom of the fit now follows the reach continuously, capped at
        # -25 dB so a long clean decay still gets the standard T20. At reach
        # -28 it gives exactly the old T20 range and at -18 exactly the old T10
        # range, so the two old regimes are endpoints of the new rule rather
        # than rivals, and everything between them is interpolated instead of
        # rounded to one or the other.
        reach = float(edc_db[-1])
        lo = max(-25.0, reach + 3.0)
        if lo <= -15.0:
            f = fit_between(edc_db, t, -5.0, lo)
            if f:
                # Named for the span it actually used, so the number is not a
                # regime label that hides which decade got fitted.
                return f, "schroeder_T%d" % int(round(-5.0 - lo)), reach
        lo = max(reach + 3.0, -8.0)
        if lo <= -2.0:
            f = fit_between(edc_db, t, -1.0, lo)
            if f:
                return f, "schroeder_partial", reach
        return None, None, reach

    edc_db, t = build_edc(0.0)
    if edc_db is None or edc_db.size < 20:
        return {"valid": False, "note": "too few points"}
    fit, method, reach = best_fit(edc_db, t)

    # Tail compensation. Energy the integral never saw is estimated from the
    # fitted slope and added back. The estimate depends on the slope and the
    # slope depends on the estimate, so iterate to a fixed point; one pass badly
    # under-corrects a decay that outlasts the file several times over.
    #
    # IT RUNS WHENEVER THE INTEGRAL IS SHORT OF ENERGY, not only when the file
    # ran out. This used to be gated on `trunc >= sm.size - 1` - "the Lundeby
    # truncation did not cut anything, so the note must outlast the clip" - which
    # silently made the answer depend on the NOISE FLOOR. A loud floor moves the
    # truncation point earlier, the gate stops firing, the energy past that point
    # is neither integrated nor added back, and the Schroeder curve bends down.
    #
    # MEASURED on synthetic decays where the answer is known, identical signal,
    # only the floor moved: a true 17.0 s decay reads 16.73 s at a -55 dBFS floor
    # or quieter and 13.56 s at -45 dBFS, a 20 percent error out of nothing but
    # hiss. A true 14.0 s reads 13.90 or 12.59 the same way. That is not a corner
    # case here - channelize.py deliberately gives our render the reference
    # recording's own noise floor, so this bias lands on both sides of every
    # comparison and by different amounts, and it is a large part of why a
    # 6 s clip of a 16 s chime has been so hard to measure.
    #
    # The formula below never assumed the truncation was at the end of the file;
    # it integrates the remaining exponential from wherever `trunc` is. Only the
    # gate was wrong. The guards inside the loop already handle the case where
    # there is nothing left to add: `last` goes non-positive when the truncation
    # landed in the noise, and the te > 20*base_energy break catches a runaway.
    tail_energy = 0.0
    tail_iters = 0
    if fit is not None:
        # Average the closing energy over at least a third of a second: sampling
        # the last few milliseconds lands in a beat null often enough to throw
        # the estimate off by 20 dB. The averaging window is then un-averaged
        # analytically using the decay rate of the current iterate.
        wtail = int(min(max(0.15 * trunc, 0.35 * sr), 0.5 * trunc))
        last = float(np.mean(e[max(0, trunc - wtail):trunc])) - noise
        prev_t60 = -60.0 / fit["slope"]
        for _ in range(12):
            tau_amp = prev_t60 / 6.907755
            tau_e_samples = 0.5 * tau_amp * sr
            if not (last > 0 and np.isfinite(tau_e_samples) and tau_e_samples > 0):
                break
            k = wtail / tau_e_samples
            corr = k / math.expm1(k) if k > 1e-6 else 1.0
            te = last * corr * tau_e_samples
            if te > 20.0 * base_energy:    # the file caught almost nothing
                break
            edc2, t2 = build_edc(te)
            if edc2 is None or edc2.size < 20:
                break
            f2, m2, reach2 = best_fit(edc2, t2)
            if f2 is None:
                break
            new_t60 = -60.0 / f2["slope"]
            edc_db, t, fit, method, reach = edc2, t2, f2, m2, reach2
            tail_energy, tail_iters = te, tail_iters + 1
            if abs(new_t60 - prev_t60) <= 0.01 * prev_t60:
                prev_t60 = new_t60
                break
            prev_t60 = new_t60

    direct = measure_t60_direct(band, sr, onset_i, noise)

    if fit is None:
        return {"valid": False, "note": "no usable decay (only %.1f dB)" % abs(reach),
                "usable_decay_db": abs(reach), "direct": direct,
                "t60_direct_s": (direct or {}).get("t60_s")}

    t60 = -60.0 / fit["slope"]
    note = ""
    valid = True
    span = abs(fit["range_db"][1] - fit["range_db"][0])
    if method.startswith("schroeder_T") and span < 20.0:
        note = ("only %.0f dB of decay available; T60 extrapolated from a T%d fit"
                % (abs(reach), round(span)))
    elif method == "schroeder_partial":
        note = "only %.0f dB of decay available; T60 heavily extrapolated" % abs(reach)
        valid = False
    if fit["r2"] < 0.95:
        note = (note + "; " if note else "") + "poor linear fit (R2=%.3f), decay is not exponential" % fit["r2"]
        if fit["r2"] < 0.85:
            valid = False

    if direct and t60 > 0:
        rel = abs(direct["t60_s"] - t60) / t60
        if rel > 0.20:
            note = ((note + "; " if note else "") +
                    "direct block fit says %.2f s, %.0f%% from the Schroeder value"
                    % (direct["t60_s"], 100 * rel))

    return {
        "valid": bool(valid),
        "t60_s": float(t60),
        "t60_direct_s": (direct or {}).get("t60_s"),
        "direct": direct,
        "method": method,
        "fit_r2": float(fit["r2"]),
        "fit_range_db": list(fit["range_db"]),
        "fit_points": int(fit["n"]),
        "usable_decay_db": float(abs(reach)),
        "truncation_s": float(trunc / sr),
        "tail_compensated": bool(tail_energy > 0),
        "tail_iterations": int(tail_iters),
        "band_noise_dbfs": float(db(math.sqrt(noise))) if noise > 0 else None,
        "band_noise_source": noise_src,
        "note": note,
    }


def measure_beating(band, sr, onset_i, t60_hint=None):
    """Amplitude modulation of one partial's envelope."""
    start = onset_i + int(0.02 * sr)
    env = analytic_envelope(band, sr, smooth_ms=4.0)
    if start >= env.size - int(0.2 * sr):
        return {"detected": False, "note": "not enough signal after onset"}

    # Start at the band envelope's own peak, not at the onset: a 15 Hz-wide
    # bandpass takes tens of milliseconds to rise, and measuring from before
    # that puts the filter's own transient into the modulation analysis.
    e0 = env[start:]
    if e0.size == 0:
        return {"detected": False, "note": "band is silent"}
    pk_off = int(np.argmax(e0))
    start += pk_off
    e = env[start:]
    pk = float(np.max(e))
    if pk <= 0:
        return {"detected": False, "note": "band is silent"}
    # analyse while the partial is within 30 dB of its own peak, cap at 4 s
    below = np.nonzero(e < pk * (10 ** (-30.0 / 20.0)))[0]
    end = int(below[0]) if below.size else e.size
    end = min(end, int(4.0 * sr), e.size)
    if end < int(0.25 * sr):
        return {"detected": False, "note": "usable region shorter than 250 ms"}
    e = e[:end]
    dur = e.size / sr

    t = np.arange(e.size) / sr
    logs = np.log(np.maximum(e, pk * 1e-6))
    slope, icpt, _ = linfit(t, logs)
    trend = np.exp(slope * t + icpt)
    resid = e / np.maximum(trend, 1e-12) - 1.0

    fmin = max(0.5, 3.0 / dur)
    fmax_mod = 40.0
    w = np.hanning(resid.size)
    R = rfft((resid - resid.mean()) * w, n=next_fast_len(resid.size * 4))
    mf = rfftfreq(R.size * 2 - 2, 1.0 / sr)[:R.size]
    lo = np.searchsorted(mf, fmin)
    hi = np.searchsorted(mf, fmax_mod)
    if hi - lo < 4:
        return {"detected": False, "note": "modulation band too narrow"}
    P = np.abs(R[lo:hi]) ** 2
    k = int(np.argmax(P))
    rate = float(mf[lo + k])
    med = float(np.median(P)) if P.size else 0.0
    conf_db = float(10.0 * np.log10(max(P[k], EPS) / max(med, EPS)))
    mod_index = float(2.0 * np.abs(R[lo + k]) / max(np.sum(w), EPS))

    # refine the depth with a local detrend over one beat period, which is
    # robust to a non-exponential decay
    depth = float("nan")
    cycles = dur * rate
    if rate > 0 and cycles >= 2.0:
        wlen = max(3, int(round(sr / rate)))
        if wlen < e.size:
            local = uniform_filter1d(e, size=wlen, mode="nearest")
            trim = wlen // 2
            n = e[trim:e.size - trim] / np.maximum(local[trim:e.size - trim], 1e-12)
            if n.size > 20:
                p95 = float(np.percentile(n, 95))
                p05 = float(np.percentile(n, 5))
                if (p95 + p05) > 0:
                    depth = (p95 - p05) / (p95 + p05)
    if not np.isfinite(depth):
        depth = mod_index

    detected = bool(conf_db >= 10.0 and depth >= 0.04 and cycles >= 2.0)
    return {
        "detected": detected,
        "rate_hz": float(rate) if detected else float(rate),
        "depth": float(depth),
        "mod_index": float(mod_index),
        "confidence_db": conf_db,
        "region_s": float(dur),
        "cycles_observed": float(cycles),
        "min_detectable_rate_hz": float(fmin),
        "note": "" if detected else "no significant modulation above the noise",
    }


def analyse_partials(x, sr, onset_i, groups):
    freqs = [g["f"] for g in groups]
    wide_noise = None
    if onset_i > int(0.020 * sr):
        wide_noise = float(np.mean(x[:onset_i] ** 2))
    out = []
    for i, g in enumerate(groups):
        f = g["f"]
        others = [freqs[j] for j in range(len(freqs)) if j != i]
        nearest = min((abs(o - f) for o in others), default=1e9)
        bw = max(0.02 * f, 15.0)
        bw = min(bw, 0.45 * nearest)
        bw = max(bw, max(8.0, 0.7 * g["split_hz"] + 5.0))
        bw = min(bw, 0.48 * nearest) if nearest < 1e8 else bw
        bw = max(bw, 6.0)
        band, sos = _bandpass(x, sr, f, bw)
        rec = {
            "index": g["index"],
            "freq_hz": float(f),
            "amp_dbfs": g["amp_dbfs"],
            "rel_db": g["rel_db"],
            "n_subpeaks": g["n_subpeaks"],
            "sub_freqs_hz": g["sub_freqs"],
            "spectral_split_hz": g["split_hz"],
            "band_bw_hz": float(bw),
        }
        if band is None:
            rec["decay"] = {"valid": False, "note": "bandpass failed"}
            rec["beating"] = {"detected": False, "note": "bandpass failed"}
        else:
            bn = band_noise_power(sos, sr, wide_noise)
            rec["decay"] = measure_t60(band, sr, onset_i, band_noise_power=bn)
            rec["beating"] = measure_beating(band, sr, onset_i)
        out.append(rec)
    return out


# ----------------------------------------------------------------------------
# 5. spectral centroid over time
# ----------------------------------------------------------------------------

def centroid_at(x, sr, onset_i, offset_s, win_s=0.050, fmin=40.0):
    n = int(round(win_s * sr))
    if offset_s <= 0:
        start = onset_i
    else:
        start = onset_i + int(round(offset_s * sr)) - n // 2
    if start < 0 or start + n > x.size:
        return None
    seg = x[start:start + n] * np.hanning(n)
    X = np.abs(rfft(seg, n=next_fast_len(n * 2)))
    f = rfftfreq(next_fast_len(n * 2), 1.0 / sr)
    lo = np.searchsorted(f, fmin)
    P = X[lo:] ** 2
    fs = f[lo:]
    tot = float(np.sum(P))
    if tot <= 0:
        return None
    return float(np.sum(fs * P) / tot)


CENTROID_POINTS = (("onset", 0.0), ("100ms", 0.100), ("500ms", 0.500), ("2s", 2.000))
CENTROID_WIN_S = 0.050
CENTROID_WIDE_WIN_S = 0.250


def spectral_centroids(x, sr, onset_i):
    out = {}
    for k, off in CENTROID_POINTS:
        out[k + "_hz"] = centroid_at(x, sr, onset_i, off, win_s=CENTROID_WIN_S)
        # a 50 ms window cannot average out a slow beat, so also report a
        # 250 ms window: the wide numbers are the ones to compare across takes
        out[k + "_hz_wide"] = centroid_at(x, sr, onset_i, off, win_s=CENTROID_WIDE_WIN_S)
    a, b = out.get("onset_hz_wide"), out.get("2s_hz_wide")
    out["darkening_ratio_onset_to_2s"] = (a / b) if (a and b) else None
    out["window_ms"] = CENTROID_WIN_S * 1000.0
    out["wide_window_ms"] = CENTROID_WIDE_WIN_S * 1000.0
    return out


# ----------------------------------------------------------------------------
# 5b. energy trajectory
# ----------------------------------------------------------------------------

# Where the sound has got to, seconds after the strike. Everything else in this
# file measures the spectrum: which lines are present, where they sit, how each
# one decays. None of that answers the plainest question anyone asks of a chime
# recording, which is whether it is still ringing. A per-partial T60 does not
# answer it either, because T60 is an extrapolated fit and a partial can carry a
# long T60 while contributing nothing audible.
#
# So measure the thing directly: the RMS of a half-second window, relative to
# the strike's own peak, at one, three and five seconds after the onset. One
# number per mark, in dB, no fitting.
ENERGY_MARKS_S = (1.0, 3.0, 5.0)
ENERGY_WIN_S = 0.500


def energy_trajectory(x, sr, onset_i, marks=ENERGY_MARKS_S, win_s=ENERGY_WIN_S):
    n = int(round(win_s * sr))
    peak = float(np.max(np.abs(x[onset_i:]))) if onset_i < x.size else 0.0
    out = {"marks_s": list(marks), "window_ms": win_s * 1000.0,
           "reference": "peak absolute sample from the onset onwards",
           "peak_ref_dbfs": float(db(peak)) if peak > 0 else None,
           "rms_rel_peak_db": {}, "truncated": {}}
    for m in marks:
        key = "%gs" % m
        i0 = onset_i + int(round(m * sr))
        i1 = min(i0 + n, x.size)
        # a clip that ends before the mark cannot be scored there: say so
        # rather than reporting the RMS of a shorter, quieter window
        if peak <= 0 or i0 >= x.size or (i1 - i0) < 0.5 * n:
            out["rms_rel_peak_db"][key] = None
            out["truncated"][key] = True
            continue
        r = float(np.sqrt(np.mean(x[i0:i1] ** 2)))
        out["rms_rel_peak_db"][key] = float(db(r) - db(peak))
        out["truncated"][key] = bool(i1 - i0 < n)
    return out


# ----------------------------------------------------------------------------
# 6. inharmonicity
# ----------------------------------------------------------------------------

def _series_support(partials, f0):
    """How well the detected partials line up with a free-free series on f0.

    Returns (score, matches). The score is an amplitude-weighted sum of
    Gaussian match quality over modes 2..5, so a candidate that explains three
    loud upper partials beats one that explains a single quiet one. It is a
    tiebreak and a reported diagnostic, never a gate: real tubes wander far
    enough from the ideal ratios that gating on them would throw away good
    fundamentals.
    """
    score = 0.0
    matches = []
    for k, ideal in enumerate(IDEAL_FREE_FREE[1:], start=2):
        target = f0 * ideal
        best, best_c = None, None
        for p in partials:
            c = cents(p["freq_hz"] / f0, ideal)
            if best_c is None or abs(c) < abs(best_c):
                best, best_c = p, c
        if best is None:
            continue
        q = math.exp(-(best_c / FUND_SERIES_TOL_CENTS) ** 2)
        w = 10.0 ** (best.get("rel_db", 0.0) / 20.0)
        score += q * w
        matches.append({"mode": k, "ideal_ratio": ideal, "target_hz": float(target),
                        "freq_hz": float(best["freq_hz"]), "cents": float(best_c),
                        "quality": float(q)})
    return float(score), matches


def select_fundamental(partials):
    """Pick the struck mode, not merely the lowest thing the FFT found.

    Sorting partials by frequency and taking the first one hands the answer to
    whatever rumble, mains hum or leftover tone happens to sit lowest, and every
    ratio and inharmonicity number downstream is then computed off that. Three
    tests, in order:

      1. A candidate must be within FUND_STRONG_DB of the loudest partial. The
         mode a chime maker tuned carries the energy; a 40 dB whisper does not.
      2. Nothing louder than it may sit below it. If something does, the
         candidate is an overtone of that instead.
      3. A candidate is rejected if a partial sits where its own root would be,
         i.e. near f / r for one of the free-free ratios and above a looser
         floor. That catches the case where mode 1 is genuinely quieter than
         mode 2 and rule 1 would otherwise skip past it.

    The lowest survivor wins; the free-free series fit breaks ties and is
    reported either way so a bad pick is visible as a bad pick.
    """
    if not partials:
        return None, {}
    ranked = sorted(partials, key=lambda p: p.get("rel_db", 0.0), reverse=True)
    strongest = ranked[0]

    def root_of(p):
        """A partial that p could be an overtone of, or None."""
        for ideal in IDEAL_FREE_FREE[1:]:
            want = p["freq_hz"] / ideal
            best, best_c = None, None
            for q in partials:
                if q is p or q.get("rel_db", 0.0) < FUND_ROOT_TEST_DB:
                    continue
                c = cents(q["freq_hz"], want)
                if abs(c) <= FUND_ROOT_TOL_CENTS and (best_c is None or abs(c) < abs(best_c)):
                    best, best_c = q, c
            if best is not None:
                return best, ideal, best_c
        return None

    # Walk down from the partial that carries the energy. Each step asks "is
    # there a partial sitting where this one's root would be?", which is the
    # tube-series test applied to the one candidate that matters. The strongest
    # partial is a safe place to start because the mode a chime maker tuned is
    # the one the strike drives hardest, but it is not always mode 1 - a bright
    # tube can put more energy into mode 2, and this finds mode 1 underneath it.
    chain = []
    cur = strongest
    seen = {round(cur["freq_hz"], 3)}
    for _ in range(len(partials)):
        got = root_of(cur)
        if got is None:
            break
        root, ideal, c = got
        key = round(root["freq_hz"], 3)
        if key in seen:
            break
        seen.add(key)
        chain.append({"from_hz": float(cur["freq_hz"]), "to_hz": float(root["freq_hz"]),
                      "ratio": ideal, "cents": float(c),
                      "to_rel_db": float(root.get("rel_db", 0.0))})
        cur = root
    chosen = cur

    if chain:
        why = ("descended from the strongest partial at %.1f Hz through %d free-free "
               "root(s)" % (strongest["freq_hz"], len(chain)))
    elif chosen is strongest:
        why = ("the strongest partial, with no partial sitting where a free-free "
               "root beneath it would be")
    else:
        why = "root of the strongest partial's free-free series"

    # Diagnostics: everything the selection passed over, and why. These are
    # reported rather than acted on, so a questionable pick is visible.
    rejected = []
    for p in partials:
        if p is chosen:
            continue
        rel = p.get("rel_db", 0.0)
        if p["freq_hz"] < chosen["freq_hz"] * 0.95:
            if rel < FUND_ROOT_TEST_DB:
                why_p = ("below the fundamental and %.0f dB down: rumble, hum or a "
                         "leftover tone, not the struck mode" % abs(rel))
            else:
                why_p = ("below the fundamental but not at a free-free root of it: "
                         "another tube left ringing, not this strike")
        elif rel < FUND_STRONG_DB:
            why_p = "an overtone %.0f dB under the strongest partial" % abs(rel)
        else:
            why_p = "an overtone of the chosen fundamental"
        rejected.append({"freq_hz": p["freq_hz"], "rel_db": rel, "why": why_p})

    support, matches = _series_support(partials, chosen["freq_hz"])
    below = [p for p in partials if p["freq_hz"] < chosen["freq_hz"] * 0.95]
    info = {
        "freq_hz": float(chosen["freq_hz"]),
        "partial_index": chosen.get("index"),
        "rel_db": float(chosen.get("rel_db", 0.0)),
        "is_strongest": bool(chosen is strongest),
        "is_lowest_detected": bool(chosen["freq_hz"]
                                   <= min(p["freq_hz"] for p in partials) * 1.0001),
        "selection_rule": why,
        "descent": chain,
        "strongest_partial_hz": float(strongest["freq_hz"]),
        "partials_below_hz": [float(p["freq_hz"]) for p in below],
        "loudest_below_rel_db": (float(max(p.get("rel_db", 0.0) for p in below))
                                 if below else None),
        "series_support": float(support),
        "series_matches": matches,
        "rejected": rejected,
        "thresholds": {"strong_db": FUND_STRONG_DB, "root_test_db": FUND_ROOT_TEST_DB,
                       "root_tol_cents": FUND_ROOT_TOL_CENTS,
                       "series_tol_cents": FUND_SERIES_TOL_CENTS},
    }
    return chosen, info


def inharmonicity(partials, f0=None):
    if not partials:
        return {}
    if f0 is None:
        f0 = partials[0]["freq_hz"]
    # Match each ideal mode to the detected partial closest to it in ratio,
    # rather than assuming detected partial N is mode N: a real chime often
    # shows an extra line (a torsional mode, a room resonance) between them.
    by_index = []
    for i, ideal in enumerate(IDEAL_FREE_FREE):
        best = min(partials, key=lambda p: abs(cents(p["freq_hz"] / f0, ideal)))
        r = best["freq_hz"] / f0
        c = cents(r, ideal)
        by_index.append({
            "mode": i + 1, "index": best["index"] if abs(c) <= 400.0 else None,
            "freq_hz": best["freq_hz"] if abs(c) <= 400.0 else None,
            "ratio": float(r) if abs(c) <= 400.0 else None,
            "ideal_ratio": ideal,
            "cents": float(c) if abs(c) <= 400.0 else None,
            "matched": bool(abs(c) <= 400.0),
        })
    nearest = []
    for p in partials:
        r = p["freq_hz"] / f0
        j = int(np.argmin([abs(cents(r, iv)) for iv in IDEAL_FREE_FREE]))
        nearest.append({
            "index": p["index"], "freq_hz": p["freq_hz"], "ratio": float(r),
            "nearest_ideal_index": j + 1, "ideal_ratio": IDEAL_FREE_FREE[j],
            "cents": float(cents(r, IDEAL_FREE_FREE[j])),
        })
    devs = [abs(d["cents"]) for d in by_index if d["matched"]]
    return {
        "reference_f0_hz": float(f0),
        "ideal_ratios": list(IDEAL_FREE_FREE),
        "by_mode": by_index,
        "modes_matched": len(devs),
        "nearest_match": nearest,
        "mean_abs_cents": float(np.mean(devs)) if devs else None,
        "max_abs_cents": float(np.max(devs)) if devs else None,
    }


# ----------------------------------------------------------------------------
# 7. noise floor, tonal-to-noise, contact click
# ----------------------------------------------------------------------------

def _spectral_noise_rms(x, sr, partials, win_s=1.0):
    """Broadband noise RMS from the bins no detected partial occupies.

    Periodogram bins of Gaussian noise are exponentially distributed, so the
    median is ln2 times the mean; dividing it out turns a robust statistic back
    into a power. Used when the file has no silent lead-in to measure.
    """
    n = min(int(round(win_s * sr)), x.size)
    if n < int(0.1 * sr):
        return None
    seg = x[x.size - n:]
    wnd = np.hanning(n)
    nfft = next_fast_len(n)
    P = np.abs(rfft(seg * wnd, n=nfft)) ** 2
    f = rfftfreq(nfft, 1.0 / sr)
    mask = np.ones(P.size, dtype=bool)
    for p in partials:
        halfw = max(40.0, 0.02 * p["freq_hz"])
        mask[np.searchsorted(f, p["freq_hz"] - halfw):
             np.searchsorted(f, p["freq_hz"] + halfw)] = False
    mask[:np.searchsorted(f, 20.0)] = False
    free = P[mask]
    if free.size < 64:
        return None
    mean_bin = float(np.median(free)) / 0.6931
    power = mean_bin / (n * float(np.mean(wnd ** 2)))
    return float(math.sqrt(max(power, 0.0))) if power > 0 else None


def noise_and_click(x, sr, onset_i, partials, peak_dbfs=None):
    res = {}

    # --- noise floor -------------------------------------------------------
    pre_n = onset_i
    noise_rms = None
    if pre_n >= int(0.030 * sr):
        noise_rms = float(np.sqrt(np.mean(x[:pre_n] ** 2)))
        res["noise_floor_dbfs"] = float(db(noise_rms))
        res["noise_floor_source"] = "pre-onset (%d ms)" % int(pre_n / sr * 1000)
        res["noise_floor_reliable"] = True
        silent_ref = True
    else:
        # The tail of a chime clip is not silence. A tuned tube runs T60 = 15-30
        # s, so six seconds in it is still ringing 25 dB down and calling that
        # the noise floor overstates it by forty decibels. Estimate the floor
        # spectrally instead: the median power in the bins no partial occupies.
        noise_rms = _spectral_noise_rms(x, sr, partials)
        res["noise_floor_dbfs"] = float(db(noise_rms)) if noise_rms else None
        res["noise_floor_source"] = ("spectral median between partials, last 1 s "
                                     "(no pre-onset silence)")
        res["noise_floor_reliable"] = False
        tail = x[int(0.95 * x.size):]
        if tail.size:
            res["tail_rms_dbfs"] = float(db(np.sqrt(np.mean(tail ** 2))))
        silent_ref = False

    # --- tonal to noise ratio ---------------------------------------------
    # Measured over 1 s from the onset. With a silent lead-in the noise power is
    # known directly; otherwise fall back to the median power spectral density
    # of the bins that no detected partial occupies.
    seg_n = min(int(1.0 * sr), x.size - onset_i)
    if seg_n > int(0.05 * sr):
        seg = x[onset_i:onset_i + seg_n]
        total_p = float(np.mean(seg ** 2))
        if silent_ref and noise_rms and noise_rms > 0:
            noise_p = noise_rms ** 2
            method = "silence-referenced"
        else:
            nfft = next_fast_len(seg_n)
            wnd = trailing_taper_window(seg_n, 0.5)
            P = np.abs(rfft(seg * wnd, n=nfft)) ** 2
            f = rfftfreq(nfft, 1.0 / sr)
            mask = np.ones(P.size, dtype=bool)
            for p in partials:
                halfw = max(30.0, 0.01 * p["freq_hz"])
                mask[np.searchsorted(f, p["freq_hz"] - halfw):
                     np.searchsorted(f, p["freq_hz"] + halfw)] = False
            free = P[mask]
            if free.size > 50:
                # periodogram bins are exponentially distributed: mean = median/ln2.
                # Parseval then gives the time-domain noise power directly.
                mean_bin = float(np.median(free)) / 0.6931
                noise_p = mean_bin / (seg_n * float(np.mean(wnd ** 2)))
                noise_p = min(noise_p, 0.99 * total_p)
            else:
                noise_p = None
            method = "spectral-median"
        if noise_p and noise_p > 0:
            tonal_p = max(total_p - noise_p, EPS)
            res["tonal_to_noise_db"] = float(10.0 * np.log10(tonal_p / noise_p))
            res["tonal_to_noise_method"] = method

    # --- contact click ------------------------------------------------------
    # Broadband energy in the first 30 ms, measured in a band above every
    # detected partial (so nothing tonal lives there) and compared against the
    # same band 200 ms later and against the room noise.
    n30 = int(round(0.030 * sr))
    if onset_i + n30 <= x.size:
        if partials:
            hf_lo = min(1.5 * partials[-1]["freq_hz"], 0.40 * sr)
        else:
            hf_lo = 0.25 * sr
        hf_hi = min(0.47 * sr, 18000.0)
        if hf_hi - hf_lo < 500.0:
            hf_lo, hf_hi = min(8000.0, 0.30 * sr), min(18000.0, 0.47 * sr)

        # Order 8, and causal: a zero-phase filter would smear the click
        # backwards past the onset and pollute the pre-onset reference. Order 4
        # is not steep enough to keep the top partial out of the guard band.
        hf, _hsos = _bandpass_lohi(x, sr, hf_lo, hf_hi, order=8, zero_phase=False)
        click = {"window_ms": 30.0, "hf_band_hz": [float(hf_lo), float(hf_hi)]}
        if hf is not None:
            def rms_db(a):
                return float(db(np.sqrt(np.mean(a ** 2)))) if a.size else None
            early = rms_db(hf[onset_i:onset_i + n30])
            later_i = onset_i + int(0.200 * sr)
            late = rms_db(hf[later_i:later_i + n30]) if later_i + n30 <= x.size else None
            pre = rms_db(hf[:onset_i]) if onset_i >= int(0.030 * sr) else None
            click["hf_level_first_30ms_dbfs"] = early
            click["hf_level_at_200ms_dbfs"] = late
            click["hf_level_pre_onset_dbfs"] = pre
            refs = [v for v in (late, pre) if v is not None]
            click["hf_excess_db"] = float(early - max(refs)) if refs and early else None
            if early is not None and peak_dbfs is not None:
                click["hf_rel_to_peak_db"] = float(early - peak_dbfs)

        # what fraction of the first 30 ms is not accounted for by the partials
        w = trailing_taper_window(n30, taper=0.5)
        nfft = next_fast_len(n30 * 4)
        P = np.abs(rfft(x[onset_i:onset_i + n30] * w, n=nfft)) ** 2
        f = rfftfreq(nfft, 1.0 / sr)
        tot = float(np.sum(P)) + EPS
        mask = np.ones(P.size, dtype=bool)
        halfw = max(4.0 * sr / n30, 25.0)
        for p in partials:
            mask[np.searchsorted(f, p["freq_hz"] - halfw):
                 np.searchsorted(f, p["freq_hz"] + halfw)] = False
        click["nontonal_fraction"] = float(np.sum(P[mask]) / tot)

        def flat_db(a):
            if a.size < 4:
                return None
            gm = float(np.mean(np.log(np.maximum(a, EPS))))
            am = float(np.log(max(np.mean(a), EPS)))
            return float(10.0 / math.log(10.0) * (gm - am))
        click["spectral_flatness_db"] = flat_db(P)
        click["hf_flatness_db"] = flat_db(P[np.searchsorted(f, hf_lo):
                                            np.searchsorted(f, hf_hi)])

        # Every attack radiates something broadband, so a threshold is needed to
        # say where a contact click starts. Two conventions, both stated: the
        # onset must put at least CLICK_EXCESS_DB more energy into the guard band
        # than that band carries later or before, and that energy must not be
        # more than CLICK_FLOOR_DB below the strike's own peak. The dB numbers
        # above are the actual feature; this boolean is a convenience.
        ex = click.get("hf_excess_db")
        rel = click.get("hf_rel_to_peak_db")
        click["detected"] = bool(ex is not None and ex > CLICK_EXCESS_DB
                                 and (rel is None or rel > CLICK_FLOOR_DB))
        click["thresholds"] = {"hf_excess_db": CLICK_EXCESS_DB,
                               "hf_rel_to_peak_db": CLICK_FLOOR_DB}
        res["click"] = click
    return res


# ----------------------------------------------------------------------------
# top level
# ----------------------------------------------------------------------------

def analyze_wav(path, max_partials=10, min_partials=6, floor_db=45.0,
                fmin=40.0, refine=True, min_snr_db=15.0):
    x, sr, meta = load_wav(path)
    on = measure_onset(x, sr)
    onset_i = on["onset_index"]
    for k in ("_env", "_peak_i"):
        on.pop(k, None)

    groups, long_spec, _short = detect_partials(
        x, sr, onset_i, max_partials=max_partials, min_partials=min_partials,
        floor_db=floor_db, fmin=fmin, refine=refine,
        min_snr_db=min_snr_db)
    partials = analyse_partials(x, sr, onset_i, groups)

    rejected, skirt = [], []
    fund, fund_info = select_fundamental(partials)
    if partials:
        f0 = fund["freq_hz"]
        for p in partials:
            p["ratio_to_f0"] = float(p["freq_hz"] / f0)
            p["is_fundamental"] = bool(p is fund)
    if groups:
        rejected = groups[0].pop("_rejected", [])
        skirt = groups[0].pop("_skirt", [])

    feat = {
        "schema_version": SCHEMA_VERSION,
        "file": meta,
        "onset": on,
        "partials": partials,
        "n_partials": len(partials),
        "fundamental_hz": float(fund["freq_hz"]) if fund else None,
        "fundamental": fund_info,
        "rejected_as_leakage": rejected,
        "rejected_as_noise_skirt": skirt,
        "detection": {"floor_db": float(floor_db), "min_snr_db": float(min_snr_db),
                      "max_partials": int(max_partials), "fmin_hz": float(fmin)},
        "spectral_centroid": spectral_centroids(x, sr, onset_i),
        "energy_trajectory": energy_trajectory(x, sr, onset_i),
        "inharmonicity": inharmonicity(partials, f0=fund["freq_hz"] if fund else None),
        "noise": noise_and_click(x, sr, onset_i, partials,
                                 peak_dbfs=on.get("peak_level_dbfs")),
    }
    beats = [p["beating"] for p in partials if p["beating"].get("detected")]
    feat["beating_summary"] = {
        "partials_beating": len(beats),
        "partials_total": len(partials),
        "mean_rate_hz": float(np.mean([b["rate_hz"] for b in beats])) if beats else None,
        "mean_depth": float(np.mean([b["depth"] for b in beats])) if beats else None,
    }
    t60s = [p["decay"]["t60_s"] for p in partials
            if p["decay"].get("valid") and np.isfinite(p["decay"].get("t60_s", float("nan")))]
    feat["decay_summary"] = {
        "t60_valid_count": len(t60s),
        "t60_longest_s": float(max(t60s)) if t60s else None,
        "t60_shortest_s": float(min(t60s)) if t60s else None,
    }
    return feat


# ----------------------------------------------------------------------------
# reporting
# ----------------------------------------------------------------------------

def _f(v, fmt="%.3f", na="-"):
    if v is None:
        return na
    try:
        if isinstance(v, float) and not np.isfinite(v):
            return na
        return fmt % v
    except (TypeError, ValueError):
        return str(v)


def format_report(feat):
    L = []
    m = feat["file"]
    L.append("=" * 78)
    L.append("FILE      %s" % m["path"])
    L.append("FORMAT    %d Hz, %d ch, %s-bit, %.3f s (%d samples)"
             % (m["sample_rate"], m["channels"], m["bit_depth"], m["duration_s"], m["n_samples"]))
    L.append("=" * 78)

    o = feat["onset"]
    L.append("")
    L.append("ONSET AND ATTACK")
    L.append("  onset time              %s s   (%s)"
             % (_f(o["onset_s"], "%.4f"),
                "strike found" if o.get("onset_detected") else "NO STRIKE IN THIS FILE"))
    L.append("  peak time               %s s  (%s ms after onset)"
             % (_f(o["peak_s"], "%.4f"), _f(o["peak_after_onset_ms"], "%.2f")))
    L.append("  peak level              %s dBFS  (file's loudest: %s dBFS)"
             % (_f(o["peak_level_dbfs"], "%.2f"), _f(o.get("global_peak_level_dbfs"), "%.2f")))
    L.append("  attack 10%% -> 90%%       %s ms" % _f(o["attack_10_90_ms"], "%.3f"))
    L.append("  creep past attack peak   %s dB over the next %d ms"
             % (_f(o.get("attack_peak_creep_db"), "%.1f"), int(ATTACK_PEAK_WINDOW_S * 1000)))
    L.append("  strike rise over ring    %s dB   (already ringing: %s dBFS)"
             % (_f(o.get("onset_rise_db"), "%.1f"), _f(o.get("pre_strike_level_dbfs"), "%.1f")))
    fx = o.get("flux") or {}
    L.append("  spectral-flux prominence %s dB at %s s"
             % (_f(fx.get("flux_prominence_db"), "%.1f"), _f(fx.get("flux_peak_s"), "%.4f")))
    # Only worth saying when the gap is big enough to have moved a measurement.
    # A decibel of settling straight after the strike is normal; several
    # decibels arriving tens of milliseconds late is a limiter or a beat.
    if (not o.get("peak_is_global")
            and (o.get("attack_peak_creep_db") or 0.0) >= 2.0
            and (o.get("global_peak_after_onset_ms") or 0.0)
            - (o.get("peak_after_onset_ms") or 0.0) >= 30.0):
        L.append("  ! the file's loudest moment is %s s (%s ms after onset), %s dB"
                 " above the strike's own peak: a swell, not the attack"
                 % (_f(o.get("global_peak_s"), "%.4f"),
                    _f(o.get("global_peak_after_onset_ms"), "%.1f"),
                    _f((o.get("global_peak_level_dbfs") or 0) - (o.get("peak_level_dbfs") or 0), "%.1f")))
    if o["onset_truncated"]:
        L.append("  ! no onset in this file; attack time is not measurable")
    if o.get("note"):
        L.append("  ! %s" % o["note"])
    if o["pre_onset_noise_rms_dbfs"] is not None:
        L.append("  pre-onset noise         %s dBFS RMS" % _f(o["pre_onset_noise_rms_dbfs"], "%.1f"))

    ps = feat["partials"]
    fu = feat.get("fundamental") or {}
    L.append("")
    det = feat.get("detection", {})
    L.append("PARTIALS  (%d found; fundamental %s Hz; kept within %s dB of the strongest"
             " and %s dB above the local noise floor)"
             % (len(ps), _f(feat["fundamental_hz"], "%.2f"),
                _f(det.get("floor_db"), "%.0f"), _f(det.get("min_snr_db"), "%.0f")))
    if fu:
        L.append("  fundamental chosen: %s Hz at %s dB - %s"
                 % (_f(fu.get("freq_hz"), "%.2f"), _f(fu.get("rel_db"), "%.1f"),
                    fu.get("selection_rule", "-")))
        for r in fu.get("rejected", []):
            L.append("    not %8.2f Hz (%+5.1f dB): %s" % (r["freq_hz"], r["rel_db"], r["why"]))
    L.append("   #      freq Hz    ratio   rel dB  sub  split Hz     T60 s   fit R2  method")
    L.append("  " + "-" * 74)
    for p in ps:
        d = p["decay"]
        L.append("  %2d  %11.3f  %7.4f  %7.1f  %3d  %8.2f  %8s  %7s  %s"
                 % (p["index"], p["freq_hz"], p.get("ratio_to_f0", float("nan")),
                    p["rel_db"], p["n_subpeaks"], p["spectral_split_hz"],
                    _f(d.get("t60_s"), "%.3f"), _f(d.get("fit_r2"), "%.3f"),
                    (d.get("method") or "-") + ("" if d.get("valid") else " [!]")))
    for p in ps:
        note = p["decay"].get("note")
        if note:
            L.append("      partial %d decay: %s" % (p["index"], note))

    L.append("")
    L.append("BEATING   (amplitude modulation inside each partial's band)")
    L.append("   #      freq Hz   rate Hz    depth   mod idx   conf dB   cycles  detected")
    L.append("  " + "-" * 74)
    for p in ps:
        b = p["beating"]
        L.append("  %2d  %11.3f  %8s  %7s  %8s  %8s  %7s  %s"
                 % (p["index"], p["freq_hz"], _f(b.get("rate_hz"), "%.3f"),
                    _f(b.get("depth"), "%.3f"), _f(b.get("mod_index"), "%.3f"),
                    _f(b.get("confidence_db"), "%.1f"), _f(b.get("cycles_observed"), "%.1f"),
                    "yes" if b.get("detected") else "no"))
    bs = feat["beating_summary"]
    L.append("  summary: %d of %d partials beat; mean rate %s Hz, mean depth %s"
             % (bs["partials_beating"], bs["partials_total"],
                _f(bs["mean_rate_hz"], "%.2f"), _f(bs["mean_depth"], "%.3f")))

    for r in feat.get("rejected_as_leakage", []):
        L.append("  rejected %.2f Hz as leakage (%.0f dB under %.2f Hz)"
                 % (r["freq_hz"], r["delta_db"], r["masked_by_hz"]))

    c = feat["spectral_centroid"]
    L.append("")
    L.append("SPECTRAL CENTROID  (power-weighted; 50 ms window, 250 ms window)")
    for k, _off in CENTROID_POINTS:
        L.append("  at %-20s %9s Hz   %9s Hz"
                 % (k, _f(c.get(k + "_hz"), "%.1f"), _f(c.get(k + "_hz_wide"), "%.1f")))
    L.append("  darkening onset -> 2 s  %sx (250 ms windows)"
             % _f(c.get("darkening_ratio_onset_to_2s"), "%.2f"))

    et = feat.get("energy_trajectory") or {}
    L.append("")
    L.append("ENERGY TRAJECTORY  (RMS of a %.0f ms window, relative to the strike peak)"
             % et.get("window_ms", ENERGY_WIN_S * 1000.0))
    for m in et.get("marks_s", ENERGY_MARKS_S):
        k = "%gs" % m
        v = (et.get("rms_rel_peak_db") or {}).get(k)
        note = "  (clip ends inside the window)" if (et.get("truncated") or {}).get(k) else ""
        L.append("  at %-20s %9s dB%s" % (k, _f(v, "%.1f"), note))

    ih = feat["inharmonicity"]
    L.append("")
    L.append("INHARMONICITY  (cents from the ideal free-free ratios)")
    if ih:
        L.append("  mode   ideal    partial     freq Hz    ratio     cents")
        L.append("  " + "-" * 54)
        for d in ih["by_mode"]:
            if d["matched"]:
                L.append("   %2d   %7.4f      #%-2d   %10.3f  %7.4f  %+8.1f"
                         % (d["mode"], d["ideal_ratio"], d["index"], d["freq_hz"],
                            d["ratio"], d["cents"]))
            else:
                L.append("   %2d   %7.4f       -            -        -         -   (no partial within 400 cents)"
                         % (d["mode"], d["ideal_ratio"]))
        L.append("  mean |cents| %s   max |cents| %s   (%d of %d modes matched)"
                 % (_f(ih.get("mean_abs_cents"), "%.1f"), _f(ih.get("max_abs_cents"), "%.1f"),
                    ih.get("modes_matched", 0), len(IDEAL_FREE_FREE)))
        used = {d["index"] for d in ih["by_mode"] if d["matched"]}
        for d in ih["nearest_match"]:
            if d["index"] not in used:
                L.append("  extra partial #%d at %.3f Hz (ratio %.4f) is %+.1f cents from ideal mode %d"
                         % (d["index"], d["freq_hz"], d["ratio"], d["cents"],
                            d["nearest_ideal_index"]))

    n = feat["noise"]
    L.append("")
    L.append("NOISE AND CONTACT CLICK")
    L.append("  noise floor             %s dBFS  (%s)%s"
             % (_f(n.get("noise_floor_dbfs"), "%.1f"), n.get("noise_floor_source", "-"),
                "" if n.get("noise_floor_reliable", True) else "  [estimate]"))
    L.append("  tonal-to-noise ratio    %s dB  (%s)"
             % (_f(n.get("tonal_to_noise_db"), "%.1f"), n.get("tonal_to_noise_method", "-")))
    ck = n.get("click", {})
    if ck:
        L.append("  first 30 ms non-tonal   %s of frame energy" % _f(ck.get("nontonal_fraction"), "%.4f"))
        L.append("  HF band (above all partials)  %s - %s Hz"
                 % (_f(ck.get("hf_band_hz", [None, None])[0], "%.0f"),
                    _f(ck.get("hf_band_hz", [None, None])[1], "%.0f")))
        L.append("  HF level 0-30 ms        %s dBFS   at 200 ms %s   pre-onset %s"
                 % (_f(ck.get("hf_level_first_30ms_dbfs"), "%.1f"),
                    _f(ck.get("hf_level_at_200ms_dbfs"), "%.1f"),
                    _f(ck.get("hf_level_pre_onset_dbfs"), "%.1f")))
        L.append("  HF excess at onset      %s dB   (vs strike peak: %s dB)"
                 % (_f(ck.get("hf_excess_db"), "%.1f"), _f(ck.get("hf_rel_to_peak_db"), "%.1f")))
        L.append("  spectral flatness       %s dB full band, %s dB in the HF band"
                 % (_f(ck.get("spectral_flatness_db"), "%.1f"),
                    _f(ck.get("hf_flatness_db"), "%.1f")))
        L.append("  contact click           %s" % ("detected" if ck.get("detected") else "not detected"))
    L.append("")
    return "\n".join(L)


def _jsonable(o):
    if isinstance(o, dict):
        return {k: _jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_jsonable(v) for v in o]
    if isinstance(o, (np.floating, float)):
        v = float(o)
        return v if math.isfinite(v) else None
    if isinstance(o, (np.integer, int)):
        return int(o)
    if isinstance(o, (np.bool_, bool)):
        return bool(o)
    if isinstance(o, np.ndarray):
        return _jsonable(o.tolist())
    return o


def main(argv=None):
    ap = argparse.ArgumentParser(description="Spectral feature extraction for one chime strike.")
    ap.add_argument("wav")
    ap.add_argument("--json", action="store_true", help="emit the feature vector as JSON")
    ap.add_argument("--max-partials", type=int, default=10)
    ap.add_argument("--min-partials", type=int, default=6)
    ap.add_argument("--floor-db", type=float, default=45.0,
                    help="keep partials within this many dB of the strongest")
    ap.add_argument("--fmin", type=float, default=40.0)
    ap.add_argument("--min-snr-db", type=float, default=15.0,
                    help="a peak must clear the local noise floor by this much")
    ap.add_argument("--no-refine", action="store_true",
                    help="skip exact-DTFT refinement (faster, less accurate)")
    args = ap.parse_args(argv)

    feat = analyze_wav(args.wav, max_partials=args.max_partials,
                       min_partials=args.min_partials, floor_db=args.floor_db,
                       fmin=args.fmin, refine=not args.no_refine,
                       min_snr_db=args.min_snr_db)
    if args.json:
        json.dump(_jsonable(feat), sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        print(format_report(feat))
    return 0


if __name__ == "__main__":
    sys.exit(main())
