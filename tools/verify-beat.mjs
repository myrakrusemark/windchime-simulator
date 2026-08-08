#!/usr/bin/env node
/**
 * Does the browser's one-oscillator doublet actually equal the two sines it
 * claims to be?
 *
 * A bending mode of a tube is two lines, not one - see "The bending doublet" in
 * modal.js. render-offline.mjs sums them directly, because offline nothing is
 * paying for oscillators. audio.js cannot afford that: it builds one
 * OscillatorNode per entry in voice.freqs and its polyphony cap counts voices
 * rather than nodes, so a doubled partial list doubles the graph of every strike
 * and the cap does not notice. It plays the pair as ONE oscillator instead,
 * whose gain and frequency each follow a setValueCurveAtTime built by modal.js's
 * beatCurves().
 *
 * That rewrite is exact on paper. What is not exact is the sampling: Web Audio
 * interpolates a value curve LINEARLY between the points it is given, so the
 * beat and the decay are both piecewise linear, and the oscillator's phase is
 * the running integral of a piecewise-linear frequency. This file plays both
 * realisations out sample by sample and measures the difference, so the claim
 * "the same sound for no extra nodes" is a measurement rather than an argument.
 *
 * Three things are reported per case:
 *
 *   err_db     the residual, curve realisation minus exact sum, as RMS relative
 *              to the exact signal's own RMS over the same window
 *   image_db   the level of the spurious line at f - split relative to the real
 *              partner at f + split. A doublet has no line below its strong one.
 *              An amplitude-only fake - modulating the gain and leaving the
 *              frequency alone - puts one there at -6 dB, which is why the
 *              frequency curve exists and why this number is measured
 *   split_hz   the spacing the spectrum actually shows, which has to be the
 *              split the model asked for and not twice it
 *
 * It also checks the section arithmetic against the two thin-ring closed forms
 * it is a generalisation of: df/f = 0.75 * ovality for a cos-2theta outside
 * radius, and df/f = lambda^2 / 4 for a cos-theta wall.
 *
 * Usage:  node tools/verify-beat.mjs [--json]
 * Exit 0 if every case is inside the bars below, 1 otherwise.
 */

import { fileURLToPath } from 'node:url';
import { join, normalize } from 'node:path';

const HERE = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const modal = await import(join(HERE, 'assets', 'js', 'modal.js'));
const {
  strikeVoice, stockFor, principalGyration, beatCurves, decayTau, tubeImperfection
} = modal;

const JSON_OUT = process.argv.includes('--json');
const SR = 48000;

// Bars. err_db is the one that matters and 0.35 percent (-49 dB) is what the
// grid in modal.js is sized for; 3 dB of headroom over that is the bar.
const ERR_DB_MAX = -50.0;
const IMAGE_DB_MAX = -40.0;   // an amplitude-only fake sits at -6
const SPLIT_TOL = 0.06;       // fraction of the split itself

/** Linear interpolation of a setValueCurveAtTime curve, as the spec defines it. */
function curveAt(curve, start, span, t) {
  if (t <= start) return curve[0];
  if (t >= start + span) return curve[curve.length - 1];
  const x = ((t - start) / span) * (curve.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = curve[i];
  const b = i + 1 < curve.length ? curve[i + 1] : curve[curve.length - 1];
  return a + (b - a) * f;
}

/**
 * One mode of one strike, rendered both ways over the same window.
 * Returns the two signals plus the exact partner frequency.
 */
function renderPair(voice, n, seconds, t60Override) {
  const amp = voice.amps[n];
  const r = voice.partner;
  const split = voice.splitHz[n];
  const t60 = t60Override || voice.t60s[n];
  const attack = voice.attack;
  const f = voice.freqs[n];
  const tau = decayTau(t60);
  const until = seconds;
  const bc = beatCurves(amp, r, split, t60, attack, until, f);

  const N = Math.round(seconds * SR);
  const exact = new Float64Array(N);
  const curved = new Float64Array(N);
  const a1 = amp / Math.sqrt(1 + r * r);
  const a2 = amp * r / Math.sqrt(1 + r * r);
  const w1 = 2 * Math.PI * f / SR;
  const w2 = 2 * Math.PI * (f + split) / SR;

  let phase = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const env = t < attack ? t / attack : Math.exp(-(t - attack) / tau);
    exact[i] = env * (a1 * Math.sin(w1 * i) + a2 * Math.sin(w2 * i));
    // The browser: one oscillator, phase integrated from the frequency curve,
    // amplitude read off the gain curve. Before the curve starts the param
    // holds - the frequency at beatCurves' freq0, the gain at the ramp's end.
    const fi = t < bc.start ? bc.freq0 : curveAt(bc.freq, bc.start, bc.span, t);
    let g;
    if (t < attack) g = (t / attack) * bc.gain[0];
    else if (t < bc.start) g = bc.gain[0];
    else g = curveAt(bc.gain, bc.start, bc.span, t);
    curved[i] = g * Math.sin(phase);
    phase += 2 * Math.PI * fi / SR;
  }
  return { exact, curved, f, split, N };
}

/** Amplitude of a signal at exactly this frequency, by direct DTFT. */
function dtft(x, f, from, to) {
  let re = 0, im = 0;
  const w = 2 * Math.PI * f / SR;
  let wsum = 0;
  for (let i = from; i < to; i++) {
    // Hann, so the neighbouring line a few Hz away does not leak into this one
    const win = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i - from) / (to - from));
    re += x[i] * win * Math.cos(w * i);
    im -= x[i] * win * Math.sin(w * i);
    wsum += win;
  }
  return 2 * Math.hypot(re, im) / Math.max(wsum, 1e-12);
}

const CASES = [
  { name: 'Corinthian Bells 65 / 465.8 Hz', stock: 'Corinthian Bells 65', f1: 465.82 },
  { name: 'Theta Supergiant / 591.8 Hz', stock: 'Theta Supergiant', f1: 591.80 },
  { name: 'Theta Flower of Life / 741.2 Hz', stock: 'Theta Flower of Life', f1: 741.21 },
  { name: 'default stock / 261.6 Hz', stock: null, f1: 261.63 },
  { name: 'default stock / 1046.5 Hz', stock: null, f1: 1046.50 }
];

const rows = [];
let worstErr = -Infinity, worstImage = -Infinity, worstSplit = 0;

for (const c of CASES) {
  const tube = c.stock ? stockFor(c.stock) : undefined;
  const voice = strikeVoice({ f1: c.f1, tube });
  // Modes 1 and 2: the two the analyser can see on a real recording. Mode 1
  // exercises the longest curve, mode 2 the fastest beat against the shortest
  // ring, which is where linear interpolation is worst.
  for (const n of [0, 1]) {
    const seconds = Math.min(4.0, Math.max(0.4, voice.t60s[n] * 0.6));
    const { exact, curved, f, split, N } = renderPair(voice, n, seconds);
    let se = 0, sx = 0;
    for (let i = 0; i < N; i++) { const d = curved[i] - exact[i]; se += d * d; sx += exact[i] * exact[i]; }
    const errDb = 10 * Math.log10(Math.max(se, 1e-300) / Math.max(sx, 1e-300));

    // The spectrum is a separate rendering, and it has to be. A partial's own
    // ring is far too short to RESOLVE its own doublet - the Supergiant's mode 2
    // is 30 dB down inside half a second and its split is 2.9 Hz, so any window
    // that fits inside the decay smears the two lines into one and every level
    // read off it is leakage. The question here is about the realisation, not
    // about the decay, so the same beat is rendered undamped over sixteen beat
    // cycles, which resolves it with room to spare.
    const specSecs = 16 / Math.abs(split);
    const spec = renderPair(voice, n, specSecs, 1e6);
    const from = Math.round(voice.attack * SR);
    const to = spec.N;
    const up = dtft(spec.curved, f + split, from, to);
    const down = dtft(spec.curved, f - split, from, to);
    const imageDb = 20 * Math.log10(Math.max(down, 1e-30) / Math.max(up, 1e-30));

    // And where the partner really lands: scan a half-split-wide window around
    // where it is meant to be, which cannot reach the strong line.
    let best = 0, bestF = f + split;
    const step = Math.abs(split) / 120;
    for (let k = -30; k <= 30; k++) {
      const ff = f + split + k * step;
      const a = dtft(spec.curved, ff, from, to);
      if (a > best) { best = a; bestF = ff; }
    }
    const splitErr = Math.abs((bestF - f) - split) / Math.abs(split);

    rows.push({
      case: c.name, mode: n + 1, freq_hz: f, split_hz: split,
      partner: voice.partner, window_s: seconds,
      curve_points: beatCurves(voice.amps[n], voice.partner, split, voice.t60s[n],
                               voice.attack, seconds, f).points,
      err_db: errDb, image_db: imageDb, split_err: splitErr
    });
    if (errDb > worstErr) worstErr = errDb;
    if (imageDb > worstImage) worstImage = imageDb;
    if (splitErr > worstSplit) worstSplit = splitErr;
  }
}

// --- the section arithmetic against its own thin-ring limits -----------------
//
// principalGyration integrates the real annulus. In the thin-wall limit it has
// to reproduce the two closed forms the physics is usually quoted as.
const thin = { od: 0.04445, id: 0.04445 - 2 * 0.00002, E: 6.9e10, rho: 2700, nu: 0.33 };
function fracFor(tube, ov, ec, ax) {
  const p = principalGyration(tube, ov, ec, ax);
  return 2 * (p.rHi - p.rLo) / (p.rHi + p.rLo);
}
const ovalityLaw = [];
for (const ov of [0.0005, 0.001, 0.002, 0.004]) {
  ovalityLaw.push({ ovality: ov, got: fracFor(thin, ov, 0, 0), want: 0.75 * ov });
}
const eccLaw = [];
for (const la of [0.05, 0.10, 0.15, 0.20]) {
  eccLaw.push({ ecc: la, got: fracFor(thin, 0, la, 0), want: la * la / 4 });
}
const lawErr = Math.max(
  ...ovalityLaw.map(o => Math.abs(o.got - o.want) / o.want),
  ...eccLaw.map(o => Math.abs(o.got - o.want) / o.want)
);

// --- what a rig of tubes comes out sounding like -----------------------------
const rig = [];
for (let i = 0; i < 8; i++) {
  const fl = tubeImperfection(i);
  const v = strikeVoice({ f1: 261.63 * Math.pow(2, i / 12), ...fl });
  rig.push({ tube: i, df_over_f: v.splitFrac, beat_hz: Math.abs(v.splitHz[0]), depth: v.partner });
}
const rates = rig.map(r => r.beat_hz);
const spread = Math.max(...rates) / Math.max(1e-9, Math.min(...rates));

const ok = worstErr <= ERR_DB_MAX && worstImage <= IMAGE_DB_MAX &&
           worstSplit <= SPLIT_TOL && lawErr <= 0.02;

if (JSON_OUT) {
  console.log(JSON.stringify({
    ok, sampleRate: SR,
    bars: { err_db_max: ERR_DB_MAX, image_db_max: IMAGE_DB_MAX, split_tol: SPLIT_TOL },
    worst: { err_db: worstErr, image_db: worstImage, split_err: worstSplit, law_rel_err: lawErr },
    cases: rows, ovality_law: ovalityLaw, ecc_law: eccLaw, rig
  }, null, 2));
} else {
  console.log('one oscillator vs two sines - modal.js beatCurves() against the exact doublet');
  console.log('');
  console.log('  case                                mode   split Hz   pts    err dB   image dB   split err');
  for (const r of rows) {
    console.log('  ' + r.case.padEnd(34) + String(r.mode).padStart(3) +
      r.split_hz.toFixed(3).padStart(11) + String(r.curve_points).padStart(6) +
      r.err_db.toFixed(2).padStart(10) + r.image_db.toFixed(2).padStart(11) +
      (r.split_err * 100).toFixed(2).padStart(11) + ' %');
  }
  console.log('');
  console.log(`  worst residual   ${worstErr.toFixed(2)} dB   (bar ${ERR_DB_MAX})`);
  console.log(`  worst image      ${worstImage.toFixed(2)} dB   (bar ${IMAGE_DB_MAX}; amplitude-only would be -6)`);
  console.log(`  worst split err  ${(worstSplit * 100).toFixed(2)} %   (bar ${SPLIT_TOL * 100} %)`);
  console.log('');
  console.log('  thin-ring limits: df/f = 0.75*ovality and lambda^2/4, worst relative error ' +
              (lawErr * 100).toFixed(3) + ' %');
  console.log('');
  console.log('  a rig of 8 tubes, each with its own draw:');
  for (const r of rig) {
    console.log(`    tube ${r.tube}  df/f ${(r.df_over_f * 1e3).toFixed(3)}e-3   ` +
                `beat ${r.beat_hz.toFixed(3)} Hz   depth ${r.depth.toFixed(3)}`);
  }
  console.log(`    beat rates spread ${spread.toFixed(2)}x across the set`);
  console.log('');
  console.log(ok ? 'PASS' : 'FAIL');
}

process.exit(ok ? 0 : 1);
