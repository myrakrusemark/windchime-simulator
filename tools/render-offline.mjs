#!/usr/bin/env node
/**
 * Headless renderer for one wind chime strike.
 *
 * Imports the same assets/js/modal.js the browser does and synthesises the same
 * voice additively, sample by sample, with no Web Audio and no browser anywhere.
 * The point is measurement: a spectrum you can only obtain by recording a tab is
 * a spectrum nobody will check, and this makes every partial, every T60 and the
 * contact click reproducible from the command line.
 *
 * What is reproduced, exactly as the browser schedules it:
 *   - per partial, gain 0 at t0, a linear ramp to its amplitude at t0+attack,
 *     then setTargetAtTime(0, t0+attack, T60/6.908), which is
 *     amp * exp(-(t - t0 - attack) / tau) with tau = T60/6.908
 *   - the oscillator stop at t0 + 1.15*T60 + 0.2, where the partial is ~69 dB
 *     down; it is a real truncation in the browser, so it is a real one here
 *   - the contact click: white noise resampled at 0.85..1.20, through a
 *     2nd-order bandpass at fc with Q 0.9 built from the same Audio EQ Cookbook
 *     coefficients the Web Audio BiquadFilter uses, into a gain that ramps to
 *     0.1*A0^1.3 over 0.8 ms and then decays with tau = 0.025/6.908
 *   - the sum scaled by the voice gain
 *
 * What is deliberately NOT reproduced: the stereo panner, the shared 90 ms delay
 * send and the bus compressor. This is a dry mono single strike, which is what a
 * spectral comparison against an isolated recording wants.
 *
 * Usage:
 *   node tools/render-offline.mjs --f1 261.63 --s 0.45 --vn 0.4 --out out.wav
 *
 * Options:
 *   --f1 <hz>        tube fundamental                          (261.63)
 *   --od <mm>        tube outside diameter                     (44.45)
 *   --wall <mm>      tube wall thickness                       (2.6)
 *   --length <m>     cut length, if you know it; otherwise implied by --f1
 *   --E <GPa>        Young's modulus                           (69, aluminium)
 *   --rho <kg/m3>    density                                   (2700)
 *   --nu             Poisson's ratio                           (0.33)
 *   --s <0..1>       strike height down the tube from the top  (0.45)
 *   --vn <m/s>       hammer normal speed at contact            (0.4)
 *   --out <path>     WAV to write                              (required)
 *   --dur <sec>      render length                             (6)
 *   --lead <sec>     silence before the strike, as the refs are cut (0.050)
 *   --decay <sec>    T60 of the fundamental at 440 Hz          (8)
 *   --attack <sec>   per-partial ramp                          (0.002)
 *   --loudness <0..1>                                          (0.5)
 *   --mu <kg>        reduced mass at contact                   (0.030)
 *   --kind <s>       'tube' for a tube-on-tube clack           (clapper)
 *   --partials <n>   modes to voice, 1..5                      (5)
 *   --sr <hz>        sample rate                               (48000)
 *   --bits <16|32>   16-bit PCM or 32-bit float                (16)
 *   --seed <n>       PRNG seed for the click noise             (1)
 *   --no-click       omit the contact click
 *   --norm <dBFS>    peak-normalise to this level              (off)
 *   --json           print the voice description as JSON
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, normalize } from 'node:path';

const HERE = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const modal = await import(join(HERE, 'assets', 'js', 'modal.js'));
const { strikeVoice, decayTau, clamp, CLICK_ATTACK, CLICK_T60, CLICK_Q, CLICK_STOP } = modal;

// --- CLI -------------------------------------------------------------------

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const v = process.argv[i + 1];
  return v.startsWith('--') ? fallback : v;
}
const flag = (name) => process.argv.includes(`--${name}`);
const numArg = (name, fallback) => {
  const v = arg(name, null);
  if (v === null) return fallback;
  const n = Number(v);
  if (!isFinite(n)) {
    console.error(`--${name} must be a number, got "${v}"`);
    process.exit(2);
  }
  return n;
};

const OUT = arg('out', null);
if (!OUT) {
  console.error('render-offline: --out <path.wav> is required. --help for the rest.');
  process.exit(2);
}
if (flag('help')) { console.error('see the header of this file'); process.exit(0); }

const SR = numArg('sr', 48000);
const DUR = numArg('dur', 6);
const LEAD = Math.max(0, numArg('lead', 0.050));
const BITS = numArg('bits', 16);
const SEED = numArg('seed', 1);
const WITH_CLICK = !flag('no-click');
const NORM = arg('norm', null) === null ? null : numArg('norm', -3);

// The tube being rendered. Mode ratios depend on the stock as well as on the
// pitch - a fat tube and a thin one cut to the same note do NOT have the same
// overtones - so a comparison against a recording of a particular instrument
// has to be able to say which tube it is asking for, exactly as it already says
// which note.
const OD = numArg('od', modal.TUBE_STOCK.od * 1000) / 1000;
const WALL = numArg('wall', (modal.TUBE_STOCK.od - modal.TUBE_STOCK.id) * 500) / 1000;
const tube = {
  od: OD,
  id: OD - 2 * WALL,
  E: numArg('E', modal.TUBE_STOCK.E / 1e9) * 1e9,
  rho: numArg('rho', modal.TUBE_STOCK.rho),
  nu: numArg('nu', modal.TUBE_STOCK.nu)
};
if (!(tube.id > 0) || !(tube.id < tube.od)) {
  console.error(`--wall ${WALL * 1000} mm does not fit inside --od ${OD * 1000} mm`);
  process.exit(2);
}

const voice = strikeVoice({
  f1: numArg('f1', 261.63),
  tube,
  L: arg('length', null) === null ? undefined : numArg('length', undefined),
  s: numArg('s', 0.45),
  vn: numArg('vn', 0.4),
  mu: arg('mu', null) === null ? undefined : numArg('mu', undefined),
  kind: arg('kind', 'clapper'),
  partials: numArg('partials', modal.MAX_PARTIALS),
  decay: numArg('decay', 8),
  attack: numArg('attack', 0.002),
  loudness: numArg('loudness', 0.5)
});

// --- Deterministic noise ---------------------------------------------------
//
// The browser uses Math.random, which is fine for a chime nobody measures and
// useless for a render two agents have to compare. Same seed, same click.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);

// --- Envelope pieces, matching AudioParam automation -----------------------

/**
 * The exact envelope the browser schedules for one partial:
 *   setValueAtTime(0, 0) -> linearRampToValueAtTime(amp, attack)
 *   -> setTargetAtTime(0, attack, tau)
 * t is seconds since t0.
 */
function partialEnv(t, amp, attack, tau) {
  if (t <= 0) return 0;
  if (t < attack) return amp * (t / attack);
  return amp * Math.exp(-(t - attack) / tau);
}

/**
 * Web Audio BiquadFilterNode, type 'bandpass', constant 0 dB peak gain.
 * The coefficients are the Audio EQ Cookbook BPF the spec prescribes, so the
 * click here has the same shape and the same phase as the click in the tab.
 */
function bandpass(f0, Q, sr) {
  const w0 = 2 * Math.PI * (f0 / sr);
  const alpha = Math.sin(w0) / (2 * Q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const b1 = 0;
  const b2 = -alpha / a0;
  const a1 = (-2 * Math.cos(w0)) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x;
    y2 = y1; y1 = y;
    return y;
  };
}

// --- Render ----------------------------------------------------------------

const N = Math.max(1, Math.round(DUR * SR));
const out = new Float64Array(N);

// The strike starts LEAD seconds in, not at sample zero. A render that opens on
// the hit has no attack to measure and no room to measure a noise floor: the
// analyser cannot see a rise it has nothing to compare against, and reports the
// attack as unmeasurable. The reference recordings are cut 50 ms before their
// attack for exactly this reason, so matching that puts both sides of a
// comparison on the same footing. The browser's own 12 ms scheduling latency is
// still a scheduling artefact and is still not modelled here.
const LEAD_I = Math.min(N - 1, Math.max(0, Math.round(LEAD * SR)));
const { amps, freqs, t60s, attack, nPartials } = voice;

for (let n = 0; n < nPartials; n++) {
  const amp = amps[n];
  if (!(amp > 0)) continue;
  const tau = decayTau(t60s[n]);
  const w = 2 * Math.PI * freqs[n] / SR;
  // The browser stops this oscillator here; past it the partial is silent.
  const stopAt = Math.min(N - LEAD_I, Math.round((t60s[n] * 1.15 + 0.2) * SR));
  for (let i = 0; i < stopAt; i++) {
    out[LEAD_I + i] += Math.sin(w * i) * partialEnv(i / SR, amp, attack, tau);
  }
}

if (WITH_CLICK && voice.clickPeak > 0) {
  // The shared 60 ms noise buffer, its random playback rate and its random start
  // offset, all as the browser builds them.
  const bufLen = Math.max(1, Math.floor(SR * 0.06));
  const buf = new Float64Array(bufLen);
  for (let i = 0; i < bufLen; i++) buf[i] = rng() * 2 - 1;
  const rate = 0.85 + rng() * 0.35;
  const offset = rng() * 0.02;

  const bp = bandpass(clamp(voice.clickFreq, 60, SR * 0.45), CLICK_Q, SR);
  const tau = decayTau(CLICK_T60);
  const stopAt = Math.min(N - LEAD_I, Math.round(CLICK_STOP * SR));

  for (let i = 0; i < stopAt; i++) {
    // AudioBufferSourceNode resampling: linear interpolation, silence past the
    // end of the buffer.
    const pos = offset * SR + i * rate;
    const j = Math.floor(pos);
    let x = 0;
    if (j >= 0 && j < bufLen) {
      const frac = pos - j;
      const a = buf[j];
      const b = j + 1 < bufLen ? buf[j + 1] : 0;
      x = a + (b - a) * frac;
    }
    out[LEAD_I + i] += bp(x) * partialEnv(i / SR, voice.clickPeak, CLICK_ATTACK, tau);
  }
}

// The voice gain. distGain is 1 for a dry render, and the bus gain, the delay
// send and the compressor are all outside the voice.
for (let i = 0; i < N; i++) out[i] *= voice.gain;

let peak = 0;
for (let i = 0; i < N; i++) { const a = Math.abs(out[i]); if (a > peak) peak = a; }
const rawPeak = peak;

if (NORM !== null && peak > 0) {
  const target = Math.pow(10, NORM / 20);
  const g = target / peak;
  for (let i = 0; i < N; i++) out[i] *= g;
  peak = target;
}

// --- WAV -------------------------------------------------------------------

function writeWav(path, samples, sr, bits) {
  const float = bits === 32;
  const bytesPerSample = float ? 4 : 2;
  const dataBytes = samples.length * bytesPerSample;
  // A non-PCM WAV needs a 'fact' chunk to be spec-legal, and some readers do
  // enforce it. Note that Python's stdlib `wave` refuses format 3 either way -
  // read a float render with scipy.io.wavfile or soundfile, or stay at 16-bit.
  const factBytes = float ? 12 : 0;
  const headerBytes = 44 + factBytes;
  const buf = Buffer.alloc(headerBytes + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(headerBytes - 8 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(float ? 3 : 1, 20);      // 3 = IEEE float, 1 = PCM
  buf.writeUInt16LE(1, 22);                  // mono
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * bytesPerSample, 28);
  buf.writeUInt16LE(bytesPerSample, 32);
  buf.writeUInt16LE(bits, 34);
  let o = 36;
  if (float) {
    buf.write('fact', o, 'ascii');
    buf.writeUInt32LE(4, o + 4);
    buf.writeUInt32LE(samples.length, o + 8);
    o += 12;
  }
  buf.write('data', o, 'ascii');
  buf.writeUInt32LE(dataBytes, o + 4);
  o += 8;
  for (let i = 0; i < samples.length; i++) {
    if (float) {
      buf.writeFloatLE(samples[i], o + i * 4);
    } else {
      // Clip rather than wrap. A wrapped sample is a bang, and a bang in a
      // measurement file is a bug report waiting to happen.
      const v = Math.max(-1, Math.min(1, samples[i]));
      buf.writeInt16LE(Math.round(v * 32767), o + i * 2);
    }
  }
  writeFileSync(path, buf);
}

writeWav(OUT, out, SR, BITS === 32 ? 32 : 16);

// --- Report ----------------------------------------------------------------

if (flag('json')) {
  console.log(JSON.stringify({
    out: OUT, sampleRate: SR, seconds: DUR, leadIn: LEAD, bits: BITS,
    peak: rawPeak, voice
  }, null, 2));
} else {
  const dbfs = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(2) : '-inf');
  console.log(`${OUT}  ${SR} Hz  ${DUR}s  mono  ${BITS === 32 ? 'float32' : '16-bit PCM'}`);
  console.log(`f1 ${voice.f1} Hz   s ${voice.s}   vn ${voice.vn} m/s   mu ${voice.mu} kg   ${voice.isTube ? 'tube-on-tube' : 'clapper'}`);
  console.log(`A0 ${voice.A0.toFixed(6)}   tauC ${(voice.tauC * 1e6).toFixed(1)} us   fc ${voice.fc.toFixed(1)} Hz   voice gain ${voice.gain.toFixed(6)}`);
  const t = voice.tube;
  console.log(`tube ${(tube.od * 1000).toFixed(1)}/${(tube.id * 1000).toFixed(1)} mm   L ${t.L.toFixed(4)} m   ` +
              `r ${(t.r * 1000).toFixed(3)} mm   L/r ${t.slenderness.toFixed(1)}   kappa ${t.kappa.toFixed(4)}   ` +
              `k ${t.k.toFixed(4)}   eps1 ${t.eps1.toExponential(4)}`);
  console.log(`peak ${rawPeak.toFixed(6)} (${dbfs(rawPeak)} dBFS)${NORM !== null ? `  -> normalised to ${NORM} dBFS` : ''}`);
  console.log('');
  console.log('  n      ideal      ratio        freq Hz     cents      amp        T60 s     tau s');
  for (let n = 0; n < voice.nPartials; n++) {
    const c = 1200 * Math.log2(voice.ratios[n] / modal.IDEAL_RATIOS[n]);
    console.log(
      `  ${n + 1}   ${modal.IDEAL_RATIOS[n].toFixed(4).padStart(8)}  ${voice.ratios[n].toFixed(4).padStart(9)}  ` +
      `${voice.freqs[n].toFixed(3).padStart(11)}  ${c.toFixed(1).padStart(8)}  ` +
      `${voice.amps[n].toFixed(6).padStart(9)}  ${voice.t60s[n].toFixed(4).padStart(9)}  ${decayTau(voice.t60s[n]).toFixed(5).padStart(8)}`
    );
  }
}
