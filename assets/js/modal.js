// modal.js - the pure modal-synthesis core for a struck free-free tube.
//
// Everything here is arithmetic. No Web Audio, no DOM, no imports, no state:
// the same arguments always produce the same numbers, in a browser or in Node.
// audio.js wraps this in an AudioContext and tools/render-offline.mjs wraps the
// same numbers in an additive renderer, which is the whole point of the split -
// the sound can be measured without a browser being involved in making it.
//
// A wind chime tube is a free-free bar: clamped nowhere, free at both ends. Its
// transverse modes are NOT a harmonic series, and that single fact is why a
// chime sounds like a chime and not like a plucked string run through a reverb.
// Every voice is built additively from the true free-free partials, with the
// per-partial amplitudes taken from the exact mode shape evaluated at the height
// the clapper actually landed, and with a brightness that follows the modelled
// contact time.

// --- Free-free bar modal data ---------------------------------------------
//
// The roots of cos(bL)cosh(bL) = 1. Frequency goes as (beta*L)^2, so the ratios
// below are betaL_n^2 / betaL_1^2.
export const BETA_L = [4.7300408, 7.8532046, 10.9956078, 14.1371655, 17.2787596];
export const RATIOS = [1.0, 2.7565, 5.4039, 8.933, 13.3443];

// sigma_n = (cosh(bL) - cos(bL)) / (sinh(bL) - sin(bL)), the mode-shape constant.
// It converges to 1 fast; mode 1 is the only one meaningfully off.
export const SIGMA = [0.9825022, 1.0007773, 0.9999665, 1.0000014, 0.9999999];

// Higher modes radiate into the air more efficiently than the fundamental, but a
// wooden clapper is a soft exciter and unchecked they are shrill. This taper is
// the difference between "chime" and "dropped a spanner".
export const RAD = [1.0, 0.85, 0.7, 0.55, 0.45];

export const MAX_PARTIALS = BETA_L.length;

// Numerical guard, and it is a real one: mode shape Y_n(s) is a difference of
// terms of size cosh(betaL_n * s) that cancels down to O(1). At n = 5 that is
// cosh(17.28) ~ 1.6e7 cancelling to about 0.5, so double precision leaves roughly
// 1.6e-8 of relative error - harmless. At n = 6 (betaL 20.42) and n = 7 it grows
// by two decades a mode and the result becomes noise. DO NOT add partials to the
// tables above without reformulating Y_n in terms of exponentials.

// --- Excitation constants --------------------------------------------------

// Strike speed that reaches full amplitude, m/s. Set from a measured
// distribution rather than by ear: p90 at 12 mph is about 0.30 and a 45 mph
// gale reaches 3.7, so ordinary weather sits well down the curve and only a
// gust tops it out. Roughly the top decile of a gale clips, which is what a
// gale should do.
export const VN_FULL_SCALE = 1.5;

// Reduced mass at contact with the default hammer, kg.
export const MU_NOMINAL = 0.030;

// Per-tube weighting for a tube-vs-tube contact, which emits one event per
// tube. See the note where it is applied.
export const TUBE_PAIR_GAIN = 0.62;

// setTargetAtTime with tau = T60 / TAU_PER_T60 lands exactly 60 dB down at T60,
// because 60 dB is 20*log10(e^6.908).
export const TAU_PER_T60 = 6.908;

// Contact-click envelope. The click is a band-passed noise burst centred on the
// contact frequency, so hardness reads in the attack before any partial has had
// time to establish.
export const CLICK_ATTACK = 0.0008;
export const CLICK_T60 = 0.025;
export const CLICK_Q = 0.9;
export const CLICK_STOP = 0.12;

// The overall voice trim, applied on top of A0 and the loudness parameter.
// 0.22 was sized for an amplitude curve that spent most of its time near the
// ceiling. Now that a typical strike sits a third of the way up instead, the
// same headroom would just make the whole chime quiet: this keeps the ordinary
// strike about where it was and lets a hard one be genuinely twice as loud,
// which is the point of widening the range.
export const VOICE_TRIM = 0.40;

// --- Small helpers ---------------------------------------------------------

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function num(v, fallback) {
  return typeof v === 'number' && isFinite(v) ? v : fallback;
}

/**
 * Free-free bar mode shape, normalised so |Y_n| = 1 at a free end.
 * s is the strike position as a fraction of the tube length, measured from the top.
 */
export function modeShape(n, s) {
  const k = BETA_L[n];
  const ks = k * s;
  return 0.5 * (
    Math.cosh(ks) + Math.cos(ks) -
    SIGMA[n] * (Math.sinh(ks) + Math.sin(ks))
  );
}

/** Time constant for a setTargetAtTime decay that is 60 dB down after T60 seconds. */
export function decayTau(T60) {
  return T60 / TAU_PER_T60;
}

/**
 * Everything a renderer needs to know about one strike, as plain numbers.
 *
 * Inputs (all optional, each with the same default the simulator uses):
 *   f1        tube fundamental, Hz
 *   s         strike position down the tube, 0..1 from the top
 *   vn        normal speed of the hammer at contact, m/s
 *   mu        reduced mass at contact, kg
 *   kind      'tube' for a tube-on-tube clack, anything else for the clapper
 *   partials  how many modes to voice, 1..MAX_PARTIALS
 *   decay     T60 of the fundamental at 440 Hz, seconds
 *   attack    per-partial ramp-up time, seconds
 *   loudness  master 0..1
 *
 * Nothing here reads a clock, a listener or a graph, so a caller is free to
 * evaluate it whenever it likes.
 */
export function strikeVoice(opts) {
  const o = opts || {};

  const f1 = num(o.f1, 261.63);
  const s = clamp(num(o.s, 0.45), 0.02, 0.98);
  const vn = Math.max(0.01, Math.abs(num(o.vn, 0.4)));
  const isTube = o.kind === 'tube';
  const mu = Math.max(1e-4, num(o.mu, MU_NOMINAL));

  // Loudness from the strike SPEED, with the hammer's weight as a separate,
  // gentler term.
  //
  // This used to normalise the impulse against a fixed 0.014 N.s, which
  // saturated at vn = 0.32 m/s. Real strikes run from the 0.045 m/s floor to
  // about 5.7 in a gale, so the curve clipped constantly: measured over two
  // simulated minutes, 13 percent of strikes at 12 mph came out at FULL
  // amplitude, 36 percent at 25 mph and 71 percent at 45 -- and the softest
  // strike the rig can make still arrived at a third of full volume. A tap
  // and a wallop sounded the same.
  //
  // vn against the full-scale reference spans the real range with headroom, and
  // the 0.6 exponent stays for perceptual compression.
  //
  // A heavier hammer IS louder, but as a modest offset rather than as the
  // whole scale -- otherwise the weight slider eats the dynamic range.
  const massTerm = Math.pow(clamp(mu / MU_NOMINAL, 0.25, 4), 0.5);
  // A tube-tube contact rings BOTH tubes, so it arrives as two events. Left
  // at full weight a pair would be twice as loud as a clapper strike of the
  // same speed, and in a gale the clatter would bury the chime it belongs
  // to. It is also a glancing blow between two hanging bodies rather than a
  // square hit, so less of the energy goes into the bending modes anyway.
  const kindGain = isTube ? TUBE_PAIR_GAIN : 1;
  const A0 = clamp(Math.pow(clamp(vn / VN_FULL_SCALE, 0, 1), 0.6) * massTerm * kindGain, 0, 1);

  // Hertzian contact: the harder you hit, the SHORTER the contact and the
  // wider the excitation spectrum. One mechanism gives both "louder" and
  // "brighter", which is why a hard strike does not just sound like a soft
  // strike turned up.
  // Aluminium on aluminium is a far stiffer contact than the wooden clapper
  // on a tube, and a stiffer contact is a shorter one, which is what puts
  // the energy up into the high partials. Halving the contact time is the
  // whole difference between a clack and a bong -- the same mechanism that
  // already makes a hard clapper strike brighter than a soft one.
  const tauScale = isTube ? 0.5 : 1;
  const tauC = clamp(tauScale * 0.0008 * Math.pow(0.4 / vn, 0.2), 0.0002, 0.002);
  const fc = 1 / (2 * tauC);

  const nPartials = clamp(num(o.partials, MAX_PARTIALS) | 0, 1, MAX_PARTIALS);
  const freqs = new Array(nPartials);
  const amps = new Array(nPartials);
  let sumSq = 0;
  for (let n = 0; n < nPartials; n++) {
    const f = f1 * RATIOS[n];
    freqs[n] = f;
    // Mode shape at the strike height decides which modes speak at all. The
    // clapper hangs at the middle of the tube SET, so it lands near the
    // midpoint of the short tubes (a node of modes 2 and 4 - they stay
    // silent and the note rings pure) and well above the midpoint of the
    // long ones (they speak, and it clangs). Nobody scripts that; it falls
    // out of the geometry.
    const shape = Math.abs(modeShape(n, s));
    const bright = 1 / (1 + Math.pow(f / fc, 1.35));   // monotonic by construction
    const a = shape * bright * RAD[n];
    amps[n] = a;
    sumSq += a * a;
  }
  // Constant total energy however many modes speak, so moving the strike up the
  // tube changes the colour and not the level. A zero here means the strike
  // landed on a node of every mode at once; the caller drops the voice.
  const norm = sumSq > 1e-12 ? A0 / Math.sqrt(sumSq) : 0;
  for (let n = 0; n < nPartials; n++) amps[n] *= norm;

  // Long low tube, short high tube: T60 scales with 1/sqrt(f), so the big
  // one audibly outlasts the little one exactly as it does in life. The
  // ratio^-1.15 term is most of what separates a chime from a synth pad -
  // the bright clang collapses inside half a second and leaves a long hum.
  const decay = clamp(num(o.decay, 8), 0.1, 30);
  const freqScale = Math.sqrt(440 / f1);
  const attack = Math.max(0.0005, num(o.attack, 0.002));
  const loudness = clamp(num(o.loudness, 0.5), 0, 1);

  const t60s = new Array(nPartials);
  for (let n = 0; n < nPartials; n++) {
    t60s[n] = clamp(decay * freqScale * Math.pow(RATIOS[n], -1.15), 0.02, 40);
  }

  return {
    // Echo of the resolved inputs, so a renderer never has to re-derive them.
    f1, s, vn, mu, isTube,
    // Excitation.
    A0, norm, tauC, fc,
    // The modes themselves.
    nPartials, freqs, amps, t60s,
    // Envelope and level. gain is the pre-distance voice gain; audio.js scales
    // it by the listener term and an offline dry render uses it as it stands.
    attack, decay, loudness, freqScale,
    gain: A0 * loudness * VOICE_TRIM,
    // Contact click. Superlinear on purpose: hard hits tick.
    clickPeak: 0.1 * Math.pow(A0, 1.3),
    clickFreq: fc,
    clickAttack: CLICK_ATTACK,
    clickT60: CLICK_T60,
    clickQ: CLICK_Q
  };
}
