#!/usr/bin/env python3
"""
channelize.py - put a dry render through the same transmission channel as a
reference recording, so that channel cues carry no information about which
file is which.

  python3 channelize.py <dry.wav> --match <reference.wav> --out <out.wav>

WHY THIS EXISTS
---------------
Our renders come out of a synthesis engine: no microphone, no room, no codec,
no gain staging. Measured in the guard band above the top partial, where the
chime cannot reach, a dry render's noise floor sits 43 dB under a real strike
mined off YouTube. The real one is also band-limited at 14.9 kHz, drops again
at 19.3 kHz, tilts about -3.3 dB per octave, and carries room rumble 74 dB
over anything our render puts below 200 Hz.

A critic asked "which of these two is a microphone" therefore never has to
listen to the instrument. It can measure the noise floor, or find the codec
cliff, or hear the room, and win every time. That would make the gauntlet a
test of how clean our renderer is, which is not a question anyone was asking.

This tool removes that shortcut by giving our render the reference's channel.


THE BOUNDARY  (this is the integrity of the whole loop, so it is spelled out)
----------------------------------------------------------------------------
CHANNEL - everything between the instrument and the listener's file. Copying
it is legitimate, because it says nothing about whether the synthesis is any
good. This tool applies:

  * pre-roll and total length     where the cut starts relative to the strike,
                                  and how long the file is
  * peak normalisation            one scalar gain, no spectral change
  * broadband noise floor         additive noise whose measured floor curve
                                  matches the reference's, per frequency, so
                                  level AND spectral tilt AND the room's
                                  low-frequency rumble all line up
  * band limiting                 a linear-phase lowpass at the reference's
                                  measured band edge. Whatever our render puts
                                  above that edge could not have survived the
                                  reference's transmission, so it does not
                                  survive ours. Refused outright if the edge
                                  is under twice the top tonal frequency,
                                  because then it would be EQ.
  * codec                         a real ffmpeg libopus encode-decode round
                                  trip at a matched bitrate. The reference
                                  came off YouTube through Opus; ours goes
                                  through Opus too. Not an approximation of
                                  the artefacts - the actual codec.
  * post-codec noise top-up       the reference's ultrasonic floor comes from
                                  a 16-bit decode step in the mining pipeline,
                                  which Opus alone will not reproduce. A
                                  second additive pass closes the residual
                                  gap across the whole band, including above
                                  the codec cutoff.
  * container format              sample rate and bit depth of the output
                                  match the reference's file exactly

INSTRUMENT - everything that is a claim about the chime itself. Touching any
of it would be flattering or flattening our own synthesis, and this tool does
none of it:

  * NO reverb, no convolution with a room impulse response. Reverb extends
    decay and blurs the attack; T60 and attack time are exactly what the
    gauntlet is judging.
  * NO EQ, shelving, tilt filter or peaking filter on the signal path.
    Partial amplitudes and spectral centroid are instrument features.
  * NO compression, limiting or envelope shaping. Attack shape and decay
    envelope are instrument features.
  * NO pitch or time modification, no de-tuning, no added beating.
  * NO added tonal content. Two of the three reference clips have a tube from
    an earlier strike still ringing 23 dB down. That is another chime sounding,
    not a property of the microphone, so it is not copied. See LEAKS below.
  * NO de-noising or restoration of the reference. The reference is never
    modified by this tool at all; it is only measured.

The one operation here that is not purely additive is the Opus round trip,
and it deserves a caveat. A lossy encoder is signal-dependent, so it does not
do literally the same thing to our render as YouTube's encoder did to the
reference. What is equalised is the channel, not the operation. The
alternative - leaving ours uncoded - is strictly worse, because then the
codec cliff alone identifies our file.

Peak normalisation is a signal operation, but it is a single scalar gain with
no frequency dependence, so it cannot move any spectral feature.


LEAKS  (channel features this tool cannot equalise; report them, don't hide)
---------------------------------------------------------------------------
`validate_blind.py` runs the checks and names every residual. Three structural
limits, all of them stated rather than papered over:

  1. This tool only ever ADDS noise. If the input is already louder than the
     reference in some band, nothing here brings it down. That cannot happen
     with a dry render, which is quieter than a microphone everywhere - it
     shows up only when one real recording is channelized into another as a
     control, and validate_blind.py labels it when it does.
  2. Two of the three reference clips have a tube from an earlier strike still
     ringing 23 dB down. That is instrument content, so it is not copied, and
     a critic that hears a second pitch has separated the files without
     judging the synthesis. Match against the tier-1 clip when that matters.
  3. Third-octave bands under about 200 Hz are one or two FFT bins wide at
     NPERSEG and their floor estimates jitter by many dB. They are printed but
     not counted; the integrated 20-200 Hz scalar covers that region instead.

Two features look like channel and are not, so they are reported and never
counted: the whole-band noise floor and the whole-file RMS both move with how
long the chime rings, which is T60, which is instrument. Read
noise_floor_guard_dbfs for the channel.


MEASUREMENT
-----------
The noise floor is not read off a silent lead-in, because two of the three
reference clips do not have one - the cut starts at the strike. It is a
minimum-statistics estimate instead: an STFT, then a low quantile per
frequency bin across time, then a median across neighbouring bins to drop any
narrowband tone that survived. That gives a noise floor curve underneath a
ringing chime.

The estimator is biased low (the 10th percentile of an exponential is 9.8 dB
under its mean), and rather than correct the bias analytically, the noise
synthesis runs closed-loop against the same estimator until the measured
curves agree. That is the target that matters: what a critic measures.

Usage
  python3 channelize.py <dry.wav> --match <ref.wav> --out <out.wav>
  python3 channelize.py --measure-only <file.wav> [--json]
  python3 channelize.py <dry.wav> --match <ref.wav> --out <o.wav> \
      --opus-bitrate 128|auto|none --seed 0 --report <report.json>

then

  python3 validate_blind.py --refs <clips-dir> --ours <dry.wav>
  python3 blind.py <channelized.wav> <ref.wav> --outdir <dir> --seed N
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile

import numpy as np
from scipy.fft import irfft, rfft, rfftfreq

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from analyze import db, load_wav, measure_onset  # noqa: E402

# ---------------------------------------------------------------------------
# fixed measurement conventions - both files always get the same ones
# ---------------------------------------------------------------------------
NPERSEG = 4096
HOP = 1024
FLOOR_QUANTILE = 0.10          # low quantile across time frames
FINE_MEDIAN_BINS = 5           # keeps the codec cliff sharp
SHAPE_MEDIAN_FRAC = 1 / 6.0    # octave fraction for the synthesis-shaping median
SHAPE_MEDIAN_MIN = 9
SHAPE_MEDIAN_MAX = 41
TONAL_OVER_FLOOR_DB = 15.0     # how far over its neighbours counts as tonal
TONAL_DYN_DB = -55.0           # ...and how far under the loudest tone still counts
GUARD_MULT = 1.5               # guard band starts this far above the top tone
GUARD_MIN_HZ = 2000.0
GUARD_MIN_WIDTH_HZ = 2000.0
EDGE_STEP_DB = 6.0             # a drop this big over one octave-ish is a band edge
MIN_BAND_BINS = 4.0            # a third-octave band narrower than this is not
                               # measurable with NPERSEG: at 48 kHz the 50 Hz
                               # band is one FFT bin wide, and a one-bin
                               # minimum-statistics estimate jitters by many dB.
                               # Those bands are printed but not counted; the
                               # integrated 20-200 Hz scalar covers the region
                               # instead, with 15 bins under it.
ONSET_FRAME_MS = 1.0           # onset search resolution
ONSET_THRESH_DB = -12.0        # relative to the file peak; see robust_onset
BUMP_CAP_DB = 6.0              # how far the shaping curve may sit over its neighbours
BUMP_CAP_MAX_HZ = 10000.0      # tonal bumps only exist below here for a chime
DEFAULT_OPUS_KBPS = 128        # YouTube opus (itag 251) sits around 128-160
AUTO_BITRATES = (64, 96, 128, 160, 192)

EPS = 1e-30


# ---------------------------------------------------------------------------
# wav writing (scipy cannot write 24-bit, and the reference clips are 24-bit)
# ---------------------------------------------------------------------------

def write_wav(path, x, sr, bits=24, rng=None):
    """Write mono float signal as PCM. bits in (16, 24, 32) or 'float32'."""
    x = np.asarray(x, dtype=np.float64)
    if bits == "float32":
        data = x.astype("<f4").tobytes()
        fmt_tag, bits_per_sample = 3, 32
    else:
        bits = int(bits)
        full = float(1 << (bits - 1))
        # TPDF dither at the LSB: below -140 dBFS for 24-bit, but it keeps the
        # quantisation error uncorrelated with the signal instead of being a
        # distortion product a critic could find.
        if rng is not None:
            d = (rng.random(x.size) + rng.random(x.size) - 1.0) / full
            x = x + d
        q = np.clip(np.rint(x * full), -full, full - 1).astype(np.int64)
        if bits == 16:
            data = q.astype("<i2").tobytes()
        elif bits == 24:
            u = (q.astype(np.int64) & 0xFFFFFF).astype(np.uint32)
            b = np.empty((q.size, 3), dtype=np.uint8)
            b[:, 0] = u & 0xFF
            b[:, 1] = (u >> 8) & 0xFF
            b[:, 2] = (u >> 16) & 0xFF
            data = b.tobytes()
        elif bits == 32:
            data = q.astype("<i4").tobytes()
        else:
            raise ValueError("unsupported bit depth %r" % bits)
        fmt_tag, bits_per_sample = 1, bits

    byte_rate = sr * bits_per_sample // 8
    block_align = bits_per_sample // 8
    fmt = struct.pack("<HHIIHH", fmt_tag, 1, sr, byte_rate, block_align, bits_per_sample)
    with open(path, "wb") as f:
        f.write(b"RIFF")
        f.write(struct.pack("<I", 4 + 8 + len(fmt) + 8 + len(data)))
        f.write(b"WAVE")
        f.write(b"fmt ")
        f.write(struct.pack("<I", len(fmt)))
        f.write(fmt)
        f.write(b"data")
        f.write(struct.pack("<I", len(data)))
        f.write(data)


def _ref_bit_depth(path):
    """What PCM format the reference file is in, so ours can match it."""
    try:
        with open(path, "rb") as f:
            head = f.read(4096)
        i = head.find(b"fmt ")
        if i < 0:
            return 24
        tag, _ch, _sr, _br, _ba, bits = struct.unpack("<HHIIHH", head[i + 8:i + 24])
        if tag == 3:
            return "float32"
        return int(bits)
    except Exception:
        return 24


# ---------------------------------------------------------------------------
# noise floor measurement
# ---------------------------------------------------------------------------

def _stft_power(x, sr, nperseg=NPERSEG, hop=HOP):
    """Per-bin power such that the sum over bins is the frame's mean square."""
    n = x.size
    if n < nperseg:
        nperseg = max(256, 1 << int(math.floor(math.log2(max(n, 256)))))
        hop = nperseg // 4
    w = np.hanning(nperseg + 1)[:nperseg]
    starts = np.arange(0, n - nperseg + 1, hop)
    if starts.size == 0:
        starts = np.array([0])
    frames = np.stack([x[s:s + nperseg] * w for s in starts])
    Y = rfft(frames, axis=1)
    c = np.full(Y.shape[1], 2.0)
    c[0] = 1.0
    if nperseg % 2 == 0:
        c[-1] = 1.0
    P = (np.abs(Y) ** 2) * c / (nperseg ** 2 * float(np.mean(w ** 2)))
    return rfftfreq(nperseg, 1.0 / sr), P.T          # (freq, time)


def _running_median(y, win):
    """Median over a fixed odd window, edge-replicated."""
    win = max(1, int(win) | 1)
    if win == 1:
        return y.copy()
    half = win // 2
    pad = np.pad(y, half, mode="edge")
    out = np.empty_like(y)
    # strided view keeps this cheap for a 2049-bin curve
    idx = np.arange(y.size)[:, None] + np.arange(win)[None, :]
    out[:] = np.median(pad[idx], axis=1)
    return out


def _adaptive_median(freqs, y, frac=SHAPE_MEDIAN_FRAC,
                     lo=SHAPE_MEDIAN_MIN, hi=SHAPE_MEDIAN_MAX):
    """Median with a window proportional to frequency, capped so the codec
    cliff is not smeared across kilohertz."""
    df = freqs[1] - freqs[0]
    out = np.empty_like(y)
    for i, f in enumerate(freqs):
        w = int(round(max(f, 1.0) * (2 ** frac - 2 ** -frac) / df))
        w = int(np.clip(w, lo, hi)) | 1
        a = max(0, i - w // 2)
        b = min(y.size, i + w // 2 + 1)
        out[i] = np.median(y[a:b])
    return out


def robust_onset(x, sr):
    """Where the strike starts, for clips that may have no silent lead-in.

    analyze.measure_onset walks back from the envelope peak to the last time
    the signal was quiet, which is the right definition when there is a quiet
    stretch to find. Two of the three reference clips are cut so the tube is
    already ringing at sample 0, and there the walk-back wanders tens of
    milliseconds into the strike. Alignment needs an estimator that returns 0
    for those, so this one goes forward instead: the first 1 ms frame that
    reaches 12 dB under the file peak, backed up to the last frame beneath it.

    12 dB rather than 20, because the tier-2 clips have a tube from an earlier
    strike still ringing about 23 dB down and a tighter threshold latches onto
    that instead of the strike.
    """
    h = max(1, int(round(ONSET_FRAME_MS * 1e-3 * sr)))
    nf = x.size // h
    if nf < 2:
        return 0
    env = np.abs(x[:nf * h].reshape(nf, h)).max(axis=1)
    peak = float(env.max())
    if peak <= 0:
        return 0
    thr = peak * 10.0 ** (ONSET_THRESH_DB / 20.0)
    above = np.nonzero(env >= thr)[0]
    if above.size == 0:
        return 0
    first = int(above[0])
    below = np.nonzero(env[:first] < thr)[0]
    frame = int(below[-1] + 1) if below.size else 0
    # refine inside the frame
    lo = frame * h
    seg = np.abs(x[lo:lo + h])
    hit = np.nonzero(seg >= thr * 0.25)[0]
    return int(lo + (hit[0] if hit.size else 0))


def _cap_tonal_bumps(freqs, shape, oct_frac=0.5, max_over_db=BUMP_CAP_DB,
                     fmax=BUMP_CAP_MAX_HZ):
    """Stop the shaping curve carrying a partial into the synthesised noise.

    A chime rings for the whole clip, so even the quietest analysis frame has
    the fundamental in it and the floor estimate bulges there. Adding noise
    with that bulge would be adding tonal content, which is instrument, not
    channel. Any bin sitting more than `max_over_db` above the median of its
    half-octave neighbourhood is pulled back down to that ceiling. Applied
    only below `fmax`: chime partials top out near 3 kHz, and above that the
    only structure in the curve is the codec cliff, which is a drop rather
    than a bump and must be left alone.
    """
    y = 10.0 * np.log10(np.maximum(shape, EPS))
    df = freqs[1] - freqs[0]
    out = y.copy()
    for i, f in enumerate(freqs):
        if f > fmax:
            break
        w = int(round(max(f, 20.0) * (2 ** oct_frac - 2 ** -oct_frac) / df))
        w = int(np.clip(w, 9, 201)) | 1
        a = max(0, i - w // 2)
        b = min(y.size, i + w // 2 + 1)
        ceil = float(np.median(y[a:b])) + max_over_db
        if y[i] > ceil:
            out[i] = ceil
    return 10.0 ** (out / 10.0)


def noise_floor_curve(x, sr):
    """Minimum-statistics noise floor.

    Returns (freqs, fine, shape) as per-STFT-bin power. `fine` keeps band
    edges sharp and is what gets reported; `shape` is smoothed across
    frequency and is what the noise synthesis is fitted to.
    """
    freqs, P = _stft_power(x, sr)
    raw = np.quantile(P, FLOOR_QUANTILE, axis=1)
    raw = np.maximum(raw, EPS)
    fine = _running_median(raw, FINE_MEDIAN_BINS)
    shape = _cap_tonal_bumps(freqs, _adaptive_median(freqs, fine))
    return freqs, np.maximum(fine, EPS), np.maximum(shape, EPS)


def _top_tonal_hz(x, sr, freqs):
    """Highest frequency carrying tonal content, i.e. the top of the
    instrument. Everything above it is a clean guard band for channel work.

    Tonal means "stands proud of its own spectral neighbourhood", not "louder
    than the quietest frame" - a decaying strike is louder than its own quiet
    frames at every frequency, which would put the guard band above Nyquist.
    """
    _f, P = _stft_power(x, sr)
    avg = np.maximum(P.mean(axis=1), EPS)
    # a full octave of neighbourhood, so a cluster of close partials cannot
    # sit on its own median and hide itself
    loc = np.maximum(_adaptive_median(freqs, avg, frac=0.5, lo=51, hi=401), EPS)
    over = 10.0 * np.log10(avg / loc)
    strong = 10.0 * np.log10(avg / max(float(avg.max()), EPS))
    tonal = (over > TONAL_OVER_FLOOR_DB) & (strong > TONAL_DYN_DB)
    hits = np.nonzero(tonal)[0]
    top = float(freqs[hits[-1]]) if hits.size else 0.0
    lo_hz = float(freqs[hits[0]]) if hits.size else 0.0
    return top, tonal, lo_hz


def _band_edges(freqs, fine_db, fmin=8000.0, fmax=23000.0, step_db=EDGE_STEP_DB):
    """Places where the floor falls off a cliff: codec cutoffs and whatever
    band limiting the source already had."""
    edges = []
    lo = np.searchsorted(freqs, fmin)
    hi = np.searchsorted(freqs, fmax)
    if hi - lo < 20:
        return edges
    win = max(4, int(round(500.0 / (freqs[1] - freqs[0]))))
    i = lo
    while i + 2 * win < hi:
        before = float(np.median(fine_db[i - win:i])) if i - win >= 0 else float(fine_db[i])
        after = float(np.median(fine_db[i + win:i + 2 * win]))
        drop = before - after
        if drop >= step_db:
            # walk to the local steepest point
            edges.append({"hz": float(freqs[i]), "drop_db": float(drop)})
            i += 2 * win
        else:
            i += max(1, win // 2)
    # merge edges that are within 1 kHz of each other, keeping the deepest
    merged = []
    for e in edges:
        if merged and e["hz"] - merged[-1]["hz"] < 1000.0:
            if e["drop_db"] > merged[-1]["drop_db"]:
                merged[-1] = e
        else:
            merged.append(e)
    return merged


def _band_power_db(freqs, curve, lo, hi):
    m = (freqs >= lo) & (freqs < hi)
    if not m.any():
        return None
    return float(10.0 * np.log10(max(float(curve[m].sum()), EPS)))


def _tilt_db_per_oct(freqs, curve_db, lo, hi):
    m = (freqs >= lo) & (freqs < hi) & (freqs > 0)
    if m.sum() < 8:
        return None
    lf = np.log2(freqs[m])
    y = curve_db[m]
    A = np.vstack([lf, np.ones_like(lf)]).T
    sol, *_ = np.linalg.lstsq(A, y, rcond=None)
    return float(sol[0])


THIRD_OCT = [31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630,
             800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000,
             10000, 12500, 16000, 20000]


def channel_features(path=None, x=None, sr=None, label=None, guard=None):
    """Everything about a file that belongs to the channel, not the chime.

    These are exactly the numbers a critic could use to spot the microphone
    without listening to the instrument, which makes them the things
    channelize has to equalise and the things validation has to check.

    `guard` pins the guard band (Hz lo, hi) instead of deriving it. Two files
    being compared MUST share a guard band or their floor numbers are not
    measurements of the same thing; use compare_pair(), which handles it.
    """
    if x is None:
        x, sr, meta = load_wav(path)
        bits = _ref_bit_depth(path)
    else:
        meta = {"path": path, "sample_rate": sr, "n_samples": int(x.size),
                "duration_s": float(x.size) / sr}
        bits = None

    freqs, fine, shape = noise_floor_curve(x, sr)
    fine_db = 10.0 * np.log10(fine)
    top_tonal, tonal_mask, lo_tonal = _top_tonal_hz(x, sr, freqs)
    edges = _band_edges(freqs, fine_db)
    cutoff = min([e["hz"] for e in edges], default=float(min(20000.0, 0.45 * sr)))
    if guard is not None:
        guard_lo, guard_hi = float(guard[0]), float(guard[1])
        guard_derived = False
    else:
        nyq = 0.45 * sr
        guard_hi = float(min(cutoff, 20000.0, nyq))
        guard_lo = max(GUARD_MULT * top_tonal, GUARD_MIN_HZ)
        if guard_hi - guard_lo < GUARD_MIN_WIDTH_HZ:
            # the instrument reaches into the band-limited region; fall back to
            # a fixed band and let the caller see that it was not derived
            guard_lo = min(guard_lo, max(GUARD_MIN_HZ, guard_hi - GUARD_MIN_WIDTH_HZ))
            guard_lo = max(guard_lo, GUARD_MIN_HZ)
            guard_hi = max(guard_hi, guard_lo + GUARD_MIN_WIDTH_HZ)
        guard_derived = True

    onset_i = robust_onset(x, sr)
    peak = float(np.max(np.abs(x)))

    feat = {
        "label": label or (os.path.basename(path) if path else "?"),
        "file": {"path": os.path.abspath(path) if path else None,
                 "sample_rate": int(sr), "bit_depth": bits,
                 "n_samples": int(x.size), "duration_s": float(x.size) / sr},
        "peak_dbfs": float(db(peak)),
        "rms_dbfs": float(db(np.sqrt(np.mean(x ** 2)))),
        "onset_index": int(onset_i),
        "pre_roll_ms": float(onset_i / sr * 1000.0),
        "onset_index_analyze_py": int(measure_onset(x, sr)["onset_index"]),
        "top_tonal_hz": float(top_tonal),
        "lowest_tonal_hz": float(lo_tonal),
        "guard_band_hz": [float(guard_lo), float(guard_hi)],
        "guard_band_derived_here": bool(guard_derived),
        "noise_floor_dbfs": _band_power_db(freqs, fine, 20.0, 0.5 * sr),
        "noise_floor_lf_dbfs": _band_power_db(freqs, fine, 20.0, 200.0),
        "noise_floor_guard_dbfs": _band_power_db(freqs, fine, guard_lo, guard_hi),
        "noise_tilt_db_per_oct": _tilt_db_per_oct(freqs, fine_db, guard_lo, guard_hi),
        "band_edges": edges,
        "cutoff_hz": float(cutoff),
        "above_cutoff_dbfs": _band_power_db(freqs, fine, min(cutoff + 500.0, 0.49 * sr),
                                            0.5 * sr),
        "third_octave_floor_db": {},
        "third_octave_tonal": {},
        "_freqs": freqs, "_fine": fine, "_shape": shape,
    }
    for fc in THIRD_OCT:
        lo, hi = fc / 2 ** (1 / 6.), fc * 2 ** (1 / 6.)
        if hi > 0.5 * sr:
            break
        v = _band_power_db(freqs, fine, lo, hi)
        if v is not None:
            feat["third_octave_floor_db"]["%g" % fc] = round(v, 2)
            m = (freqs >= lo) & (freqs < hi)
            feat.setdefault("third_octave_bins", {})["%g" % fc] = round(
                (hi - lo) / (freqs[1] - freqs[0]), 2)
            # exempt a band if it holds a tonal bin, or if it falls inside the
            # span the instrument occupies - the gaps between partials in a
            # cluster are instrument too. Bands under the lowest partial are
            # NOT exempt: room rumble down there is channel.
            inside = bool(lo_tonal > 0 and lo >= lo_tonal / 2 ** (1 / 6.)
                          and hi <= top_tonal * 2 ** (1 / 6.))
            feat["third_octave_tonal"]["%g" % fc] = bool(
                (m.any() and tonal_mask[m].any()) or inside)
    return feat


def public_features(feat):
    """channel_features without the private arrays, for JSON."""
    return {k: v for k, v in feat.items() if not k.startswith("_")}


# ---------------------------------------------------------------------------
# noise synthesis
# ---------------------------------------------------------------------------

def synth_noise(target_bin_power, freqs, sr, n, rng):
    """Stationary Gaussian noise whose PSD follows `target_bin_power`
    (per-STFT-bin power on the `freqs` grid)."""
    L = int(n)
    fk = rfftfreq(L, 1.0 / sr)
    df_stft = freqs[1] - freqs[0]
    df_full = sr / float(L)
    dens = np.interp(fk, freqs, np.maximum(target_bin_power, 0.0)) * (df_full / df_stft)
    a = rng.standard_normal(fk.size)
    b = rng.standard_normal(fk.size)
    X = L * np.sqrt(np.maximum(dens, 0.0) / 2.0) * (a + 1j * b) / math.sqrt(2.0)
    X[0] = 0.0                       # no DC; the analyser strips it anyway
    if L % 2 == 0:
        X[-1] = X[-1].real
    return irfft(X, n=L)


def add_noise_to_match(base, sr, target_freqs, target_shape, rng, iters=6,
                       max_corr_db=40.0):
    """Add broadband noise to `base` until its measured floor curve matches
    the target's.

    Closed loop against the same estimator a critic would run, because the
    estimator is what the comparison is made of. Returns (signal, report).
    """
    corr_db = np.zeros_like(target_shape)      # per-bin correction, dB
    tgt_db = 10.0 * np.log10(np.maximum(target_shape, EPS))
    best = None
    for it in range(iters):
        want = np.maximum(target_shape * 10.0 ** (corr_db / 10.0), 0.0)
        noise = synth_noise(want, target_freqs, sr, base.size, rng)
        y = base + noise
        f2, fine2, shape2 = noise_floor_curve(y, sr)
        got_db = 10.0 * np.log10(np.maximum(np.interp(target_freqs, f2, shape2), EPS))
        err = tgt_db - got_db
        rms = float(np.sqrt(np.mean(err ** 2)))
        if best is None or rms < best[0]:
            best = (rms, y, err.copy(), it)
        if rms < 0.35:
            break
        corr_db = np.clip(corr_db + np.clip(err, -12.0, 12.0), -max_corr_db, max_corr_db)
    rms, y, err, it = best
    report = {"iterations": int(it + 1), "residual_rms_db": float(rms),
              "residual_max_db": float(np.max(np.abs(err))),
              "bins_base_already_above_target": int(np.sum(err < -1.0))}
    return y, report


# ---------------------------------------------------------------------------
# opus round trip
# ---------------------------------------------------------------------------

def apply_band_limit(x, sr, cutoff_hz, top_tonal_hz, trans_frac=0.15,
                     stop_db=80.0):
    """Impose the reference channel's band edge on the signal.

    Channelize can only add noise, never take it away, so a source that is
    already brighter than the reference above the reference's band edge stays
    brighter and a critic can read the difference straight off the spectrum.
    The fix is the honest one: whatever sits above the reference's band edge
    could not have survived the reference's transmission, so it does not
    survive ours either.

    This is band limiting, not EQ, and the guard that keeps it that way is
    checked rather than asserted: the filter is refused outright unless its
    cutoff is at least twice the highest tonal frequency in the file. Below
    the cutoff the response is unity, so no partial is touched. A chime's top
    partial lands near 2-3 kHz and these band edges land near 15-20 kHz, so
    in practice the filter only ever sees hiss.

    Returns (signal, report).
    """
    nyq = 0.5 * sr
    if cutoff_hz is None or cutoff_hz >= 0.95 * nyq:
        return x, {"applied": False, "why": "reference is not band-limited"}
    if top_tonal_hz and cutoff_hz < 2.0 * top_tonal_hz:
        return x, {"applied": False, "cutoff_hz": float(cutoff_hz),
                   "top_tonal_hz": float(top_tonal_hz),
                   "why": ("refused: the band edge is under twice the top tonal "
                           "frequency, so the filter would touch partials. That "
                           "would be EQ, and EQ is instrument.")}
    from scipy.signal import firwin, kaiserord, lfilter
    width = min(trans_frac * cutoff_hz, 0.9 * (nyq - cutoff_hz))
    ntaps, beta = kaiserord(stop_db, width / nyq)
    ntaps = int(ntaps) | 1
    ntaps = min(ntaps, max(65, 2 * x.size // 3 | 1))
    h = firwin(ntaps, cutoff_hz / nyq, window=("kaiser", beta))
    pad = np.concatenate([x, np.zeros(ntaps)])
    y = lfilter(h, 1.0, pad)[(ntaps - 1) // 2:][:x.size]   # linear phase, delay removed
    return y, {"applied": True, "cutoff_hz": float(cutoff_hz),
               "transition_hz": float(width), "stopband_db": float(stop_db),
               "taps": int(ntaps), "top_tonal_hz": float(top_tonal_hz or 0.0)}


def _have_ffmpeg():
    return shutil.which("ffmpeg") is not None


def opus_round_trip(x, sr, kbps, tmpdir):
    """Encode/decode through the real codec. Not a model of Opus - Opus."""
    src = os.path.join(tmpdir, "rt_in.wav")
    enc = os.path.join(tmpdir, "rt.opus")
    dec = os.path.join(tmpdir, "rt_out.wav")
    write_wav(src, x, sr, bits="float32")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-c:a", "libopus",
                    "-b:a", "%dk" % int(kbps), "-vbr", "on",
                    "-application", "audio", enc], check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", enc, "-ar", str(sr),
                    "-ac", "1", "-c:a", "pcm_f32le", dec], check=True)
    y, ysr, _ = load_wav(dec)
    assert ysr == sr, "opus round trip changed the sample rate"
    return y


def _align_to(y, ref, max_lag=960):
    """Undo any encoder/decoder delay ffmpeg did not already compensate."""
    n = min(y.size, ref.size)
    a = ref[:n] - ref[:n].mean()
    b = y[:n] - y[:n].mean()
    L = 1 << int(math.ceil(math.log2(n + max_lag + 1)))
    A = rfft(a, L)
    B = rfft(b, L)
    cc = irfft(B * np.conj(A), L)
    lags = np.concatenate([np.arange(0, max_lag + 1), np.arange(L - max_lag, L)])
    vals = cc[lags]
    lag = int(np.arange(-max_lag, max_lag + 1)[
        np.argmax(np.concatenate([vals[max_lag + 1:], vals[:max_lag + 1]]))])
    if lag > 0:
        y = y[lag:]
    elif lag < 0:
        y = np.concatenate([np.zeros(-lag), y])
    return y, lag


def _fit_length(x, n):
    if x.size >= n:
        return x[:n]
    return np.concatenate([x, np.zeros(n - x.size)])


# ---------------------------------------------------------------------------
# the channel
# ---------------------------------------------------------------------------

def channelize(dry_path, ref_path, out_path, opus="128", seed=0,
               pre_codec_noise=True, band_limit=True, verbose=True):
    rng = np.random.default_rng(seed)
    ref_feat = channel_features(ref_path, label="reference")
    ref_x, ref_sr, _ = load_wav(ref_path)
    sr = ref_sr
    n = ref_feat["file"]["n_samples"]
    bits = ref_feat["file"]["bit_depth"] or 24

    dry, dsr, _ = load_wav(dry_path)
    if dsr != sr:
        raise SystemExit("sample rate mismatch: dry %d Hz, reference %d Hz. "
                         "Re-render at the reference's rate; resampling is a "
                         "channel operation this tool deliberately does not "
                         "guess at." % (dsr, sr))

    steps = []

    # 1. pre-roll and length ------------------------------------------------
    dry_on = robust_onset(dry, sr)
    shift = ref_feat["onset_index"] - dry_on
    if shift > 0:
        placed = np.concatenate([np.zeros(shift), dry])
    else:
        placed = dry[-shift:] if shift < 0 else dry
    placed = _fit_length(placed, n)
    steps.append({"step": "align", "dry_onset_index": int(dry_on),
                  "ref_onset_index": int(ref_feat["onset_index"]),
                  "shift_samples": int(shift),
                  "dry_samples_in": int(dry.size), "samples_out": int(n)})

    # 2. peak match ---------------------------------------------------------
    tgt_peak = 10.0 ** (ref_feat["peak_dbfs"] / 20.0)
    pk = float(np.max(np.abs(placed)))
    g = tgt_peak / pk if pk > 0 else 1.0
    placed = placed * g
    steps.append({"step": "peak_match", "gain_db": float(20 * math.log10(max(g, EPS))),
                  "target_peak_dbfs": ref_feat["peak_dbfs"]})

    # 3. the reference channel's band edge ----------------------------------
    dry_top_tonal = _top_tonal_hz(placed, sr, ref_feat["_freqs"])[0]
    if band_limit:
        placed, bl = apply_band_limit(placed, sr, ref_feat["cutoff_hz"], dry_top_tonal)
    else:
        bl = {"applied": False, "why": "disabled with --no-band-limit"}
    steps.append({"step": "band_limit", **bl})

    # 4. noise before the codec, so the encoder sees a realistic input ------
    if pre_codec_noise:
        pre_noise = synth_noise(ref_feat["_shape"], ref_feat["_freqs"], sr, n, rng)
        y = placed + pre_noise
        steps.append({"step": "noise_pre_codec",
                      "rms_dbfs": float(db(np.sqrt(np.mean(pre_noise ** 2))))})
    else:
        y = placed
        steps.append({"step": "noise_pre_codec", "skipped": True})

    pk = float(np.max(np.abs(y)))
    if pk > 0:
        y = y * (tgt_peak / pk)

    # 5. the codec ----------------------------------------------------------
    if opus in (None, "none", "off"):
        steps.append({"step": "opus", "skipped": True})
        kbps = None
    else:
        if not _have_ffmpeg():
            raise SystemExit("ffmpeg is not on PATH; the codec stage is not "
                             "optional for a YouTube-sourced reference. Pass "
                             "--opus-bitrate none only if you accept the leak.")
        with tempfile.TemporaryDirectory(prefix="channelize-") as td:
            if opus == "auto":
                kbps, sweep = _pick_bitrate(y, sr, ref_feat, td)
                steps.append({"step": "opus_auto", "picked_kbps": kbps, "sweep": sweep})
            else:
                kbps = int(opus)
            coded = opus_round_trip(y, sr, kbps, td)
        coded, lag = _align_to(coded, y)
        y = _fit_length(coded, n)
        steps.append({"step": "opus", "kbps": int(kbps), "realign_samples": int(lag)})

    # 6. top the noise up to the reference's measured curve ------------------
    y, noise_report = add_noise_to_match(y, sr, ref_feat["_freqs"], ref_feat["_shape"], rng)
    steps.append({"step": "noise_top_up", **noise_report})

    # 7. final peak match and write ------------------------------------------
    pk = float(np.max(np.abs(y)))
    if pk > 0:
        y = y * (tgt_peak / pk)
    write_wav(out_path, y, sr, bits=bits, rng=rng)
    steps.append({"step": "write", "path": os.path.abspath(out_path),
                  "sample_rate": sr, "bit_depth": bits, "n_samples": int(y.size)})

    guard = ref_feat["guard_band_hz"]
    out_feat = channel_features(out_path, label="channelized", guard=guard)
    dry_feat = channel_features(dry_path, label="dry", guard=guard)
    report = {
        "dry": os.path.abspath(dry_path),
        "reference": os.path.abspath(ref_path),
        "out": os.path.abspath(out_path),
        "seed": int(seed),
        "steps": steps,
        "features": {"reference": public_features(ref_feat),
                     "dry": public_features(dry_feat),
                     "channelized": public_features(out_feat)},
        "residual": compare_channels(ref_feat, out_feat),
        "before": compare_channels(ref_feat, dry_feat),
    }
    if verbose:
        print(format_channel_diff(ref_feat, out_feat, "reference", "channelized"))
    return report


def _pick_bitrate(y, sr, ref_feat, tmpdir):
    """Weakly discriminating: the bitrate cannot be recovered from a decoded
    WAV, so this scores each candidate on how closely the post-codec floor
    curve follows the reference between 2 kHz and the reference's cutoff.
    Stated as weak on purpose - prefer passing an explicit bitrate."""
    f0, fine0, _s0 = ref_feat["_freqs"], ref_feat["_fine"], ref_feat["_shape"]
    lo, hi = 2000.0, ref_feat["cutoff_hz"] + 2000.0
    m = (f0 >= lo) & (f0 < hi)
    tgt = 10.0 * np.log10(np.maximum(fine0[m], EPS))
    sweep = []
    best = None
    for kbps in AUTO_BITRATES:
        c = opus_round_trip(y, sr, kbps, tmpdir)
        c, _ = _align_to(c, y)
        c = _fit_length(c, y.size)
        f1, fine1, _ = noise_floor_curve(c, sr)
        got = 10.0 * np.log10(np.maximum(np.interp(f0[m], f1, fine1), EPS))
        e = float(np.sqrt(np.mean((tgt - got) ** 2)))
        sweep.append({"kbps": kbps, "rms_db": round(e, 3)})
        if best is None or e < best[1]:
            best = (kbps, e)
    return best[0], sweep


# ---------------------------------------------------------------------------
# reporting
# ---------------------------------------------------------------------------

# key, printed name, unit, tolerance (1.0 leak unit), pure-channel?
#
# "pure-channel" means the number cannot be moved by how good or bad the
# synthesis is. The two marked False are confounded by the instrument. They are
# reported, because hiding a number that separates the files would be the very
# cheat this file exists to stop, but they are never counted as channel leaks:
#
#   noise_floor_dbfs   spans the whole band, so it includes whatever frequency
#                      the chime is ringing at. A tube still audible at 6 s
#                      raises it; a render that has decayed to nothing does not.
#                      That is T60 wearing a noise-floor label. The channel
#                      number is noise_floor_guard_dbfs.
#   rms_dbfs           whole-file energy, i.e. the decay envelope.
SCALARS = [
    ("peak_dbfs", "peak level", "dB", 0.5, True),
    ("noise_floor_guard_dbfs", "noise floor in guard band", "dB", 3.0, True),
    ("noise_floor_lf_dbfs", "noise floor 20-200 Hz (rumble)", "dB", 3.0, True),
    ("noise_tilt_db_per_oct", "noise tilt in guard band", "dB/oct", 1.5, True),
    ("cutoff_hz", "band edge", "Hz", 1000.0, True),
    ("above_cutoff_dbfs", "floor above the band edge", "dB", 4.0, True),
    ("pre_roll_ms", "pre-roll before onset", "ms", 5.0, True),
    ("noise_floor_dbfs", "floor 20 Hz-Nyq (confounded)", "dB", 3.0, False),
    ("rms_dbfs", "whole-file RMS (confounded)", "dB", 3.0, False),
]


def compare_pair(path_a, path_b, label_a=None, label_b=None):
    """Measure both files over one shared guard band, then diff.

    The guard band comes from A. Deriving it separately per file would let a
    band-limited render be measured somewhere the reference is not, and the
    resulting "match" would mean nothing.
    """
    fa = channel_features(path_a, label=label_a)
    fb = channel_features(path_b, label=label_b, guard=fa["guard_band_hz"])
    return fa, fb, compare_channels(fa, fb)


def compare_channels(fa, fb, tonal_guard_hz=None):
    """Which channel features still separate the two files, and by how much
    relative to a stated tolerance. Over 1.0 leak unit is a leak."""
    rows = []
    for key, name, unit, tol, pure in SCALARS:
        a, b = fa.get(key), fb.get(key)
        base = {"key": key, "name": name, "unit": unit, "tol": tol,
                "pure_channel": pure}
        if a is None or b is None:
            rows.append(dict(base, a=a, b=b, delta=None, leak_units=None))
            continue
        d = float(b) - float(a)
        rows.append(dict(base, a=float(a), b=float(b), delta=d,
                         leak_units=abs(d) / tol))

    # A third-octave band is exempt only if a partial actually lives in it, in
    # one file or the other. Exempting everything under the top partial would
    # quietly excuse low-frequency room rumble, which is channel and is exactly
    # the sort of thing a critic would spot.
    tonal_top = tonal_guard_hz
    if tonal_top is None:
        tonal_top = max(fa.get("top_tonal_hz") or 0.0, fb.get("top_tonal_hz") or 0.0)
    ta, tb = fa["third_octave_floor_db"], fb["third_octave_floor_db"]
    fla, flb = fa.get("third_octave_tonal", {}), fb.get("third_octave_tonal", {})
    bands = []
    for k in ta:
        if k not in tb:
            continue
        hz = float(k)
        nb = fa.get("third_octave_bins", {}).get(k)
        bands.append({"hz": hz, "a": ta[k], "b": tb[k],
                      "delta": round(tb[k] - ta[k], 2),
                      "bins": nb,
                      "resolved": bool(nb is None or nb >= MIN_BAND_BINS),
                      "tonal_region": bool(fla.get(k) or flb.get(k))})
    chan_bands = [x for x in bands if not x["tonal_region"] and x["resolved"]]
    worst = max((abs(x["delta"]) for x in chan_bands), default=None)
    worst_any = max((abs(x["delta"]) for x in bands), default=None)

    leaks = [r for r in rows if r["pure_channel"]
             and r["leak_units"] is not None and r["leak_units"] > 1.0]
    confounded = [r for r in rows if not r["pure_channel"]
                  and r["leak_units"] is not None and r["leak_units"] > 1.0]
    return {"rows": rows, "third_octave": bands,
            "tonal_region_top_hz": float(tonal_top),
            "third_octave_max_abs_delta_db_channel_bands": worst,
            "third_octave_max_abs_delta_db_all_bands": worst_any,
            "leaks": [r["name"] for r in leaks],
            "leak_count": len(leaks),
            "confounded_over_tolerance": [r["name"] for r in confounded],
            "separable_on_channel": bool(leaks) or (worst is not None and worst > 6.0)}


def format_channel_diff(fa, fb, la="A", lb="B", c=None):
    if c is None:
        c = compare_channels(fa, fb)
    L = ["", "=" * 96,
         "CHANNEL FEATURES   %s  vs  %s" % (la, lb),
         "  a: %s" % (fa["file"]["path"] or fa["label"]),
         "  b: %s" % (fb["file"]["path"] or fb["label"]),
         "  guard band %.0f-%.0f Hz   tonal region up to %.0f Hz"
         % (fa["guard_band_hz"][0], fa["guard_band_hz"][1], c["tonal_region_top_hz"]),
         "=" * 96,
         "  %-32s %12s %12s %12s %8s %9s" % ("feature", la[:12], lb[:12], "delta",
                                             "tol", "leak")]
    L.append("  " + "-" * 92)
    for r in c["rows"]:
        if r["delta"] is None:
            L.append("  %-32s %12s %12s %12s %8.1f %9s"
                     % (r["name"], "-", "-", "-", r["tol"], "-"))
            continue
        if not r["pure_channel"]:
            flag = "instrument-confounded"
        else:
            flag = "LEAK" if r["leak_units"] > 1.0 else "ok"
        L.append("  %-32s %12.2f %12.2f %+12.2f %8.1f %8.1fx  %s"
                 % (r["name"], r["a"], r["b"], r["delta"], r["tol"],
                    r["leak_units"], flag))
    L.append("")
    L.append("  third-octave noise floor, %s minus %s (dB)     * = tonal region "
             "(instrument)   ~ = under 4 FFT bins wide, not measurable" % (lb, la))
    row = "  "
    for i, bnd in enumerate(c["third_octave"]):
        mark = "*" if bnd["tonal_region"] else ("~" if not bnd["resolved"] else "")
        row += " %12s" % ("%g:%+.1f%s" % (bnd["hz"], bnd["delta"], mark))
        if (i + 1) % 6 == 0:
            L.append(row)
            row = "  "
    if row.strip():
        L.append(row)
    w = c["third_octave_max_abs_delta_db_channel_bands"]
    L.append("   worst |delta| outside the tonal region = %s dB"
             % ("%.1f" % w if w is not None else "-"))
    L.append("")
    if c["leaks"]:
        L.append("  CHANNEL LEAKS: " + ", ".join(c["leaks"]))
    else:
        L.append("  no pure-channel feature separates these two files")
    if c["confounded_over_tolerance"]:
        L.append("  over tolerance but instrument-confounded, report as an "
                 "instrument gap not a channel leak: "
                 + ", ".join(c["confounded_over_tolerance"]))
    L.append("")
    return "\n".join(L)


def _jsonable(o):
    if isinstance(o, dict):
        return {k: _jsonable(v) for k, v in o.items() if not str(k).startswith("_")}
    if isinstance(o, (list, tuple)):
        return [_jsonable(v) for v in o]
    if isinstance(o, (np.floating, np.integer)):
        o = o.item()
    if isinstance(o, float) and not math.isfinite(o):
        return None
    return o


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Give a dry render the reference recording's transmission channel.")
    ap.add_argument("dry", nargs="?", help="our render (or any file, with --measure-only)")
    ap.add_argument("--match", help="reference recording to copy the channel from")
    ap.add_argument("--out", help="output wav")
    ap.add_argument("--opus-bitrate", default=str(DEFAULT_OPUS_KBPS),
                    help="kbps, 'auto', or 'none' (default %d)" % DEFAULT_OPUS_KBPS)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--no-pre-codec-noise", action="store_true",
                    help="add all the noise after the codec instead of before and after")
    ap.add_argument("--no-band-limit", action="store_true",
                    help="do not impose the reference's band edge on the signal")
    ap.add_argument("--report", help="write the full channel report as JSON here")
    ap.add_argument("--measure-only", action="store_true",
                    help="print channel features for the given file and stop")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    if args.measure_only:
        if not args.dry:
            ap.error("--measure-only needs a file")
        f = channel_features(args.dry)
        if args.json:
            json.dump(_jsonable(public_features(f)), sys.stdout, indent=2)
            sys.stdout.write("\n")
        else:
            for k, v in public_features(f).items():
                print("%-26s %s" % (k, v))
        return 0

    if not (args.dry and args.match and args.out):
        ap.error("need <dry.wav> --match <ref.wav> --out <out.wav>")

    rep = channelize(args.dry, args.match, args.out, opus=args.opus_bitrate,
                     seed=args.seed, pre_codec_noise=not args.no_pre_codec_noise,
                     band_limit=not args.no_band_limit, verbose=not args.json)
    if args.report:
        with open(args.report, "w") as fh:
            json.dump(_jsonable(rep), fh, indent=2)
    if args.json:
        json.dump(_jsonable(rep), sys.stdout, indent=2)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
