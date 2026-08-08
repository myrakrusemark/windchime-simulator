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
//
// The partials are Timoshenko's, not Euler-Bernoulli's, and that is a per-tube
// computation rather than a table. Euler-Bernoulli assumes the bending
// wavelength is long against the cross-section; by mode 5 on a half-metre tube
// it is about 21 radii of gyration, at which point shear deformation and rotary
// inertia are not corrections but first-order terms. Ignoring them puts mode 3
// of a real recorded chime 175 to 244 cents sharp. See modeSlowing.

// --- Free-free bar modal data ---------------------------------------------
//
// The roots of cos(bL)cosh(bL) = 1, and the ratios betaL_n^2 / betaL_1^2 that
// follow from them. These are the EULER-BERNOULLI answer: they are the input to
// the mode frequencies, not the mode frequencies. A real tube's partials are
// flat of these and the gap widens with mode number - see modeRatios below.
export const BETA_L = [4.7300408, 7.8532046, 10.9956078, 14.1371655, 17.2787596];
export const IDEAL_RATIOS = [1.0, 2.7565, 5.4039, 8.933, 13.3443];

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

// --- The tube itself: geometry and material --------------------------------
//
// The stock the simulator hangs. Mirrors TUBE_OD and TUBE_LINDENS in physics.js
// (0.3372 kg/m is exactly pi/4 * (28^2 - 25^2) mm^2 * 2700 kg/m^3), which is the
// same tube seen from the mechanics side. If one of the two ever changes, both
// have to: physics.js decides what the tube weighs and how it swings, this
// decides what it sounds like, and they are one object.
//
// 6061-T6 aluminium. E and rho set the wave speed sqrt(E/rho) = 5054 m/s, which
// is what makes a tube of a given length ring at the pitch it does; nu sets the
// shear correction below.
export const TUBE_STOCK = Object.freeze({
  od: 0.028,       // outer diameter, m
  id: 0.025,       // inner diameter, m
  E: 6.9e10,       // Young's modulus, Pa
  rho: 2700,       // density, kg/m^3
  nu: 0.33         // Poisson's ratio
});

/**
 * Radius of gyration of a tube's cross-section, sqrt(I/A) = sqrt(Do^2+Di^2)/4.
 *
 * This is the number the whole correction below turns on, and a TUBE is the
 * worst case for it: all the metal sits far from the axis, so a 28/25 mm tube
 * has r = 9.38 mm against 7.00 mm for a solid rod of the same outside diameter.
 * A tube is 34 percent stubbier than it looks.
 */
export function gyrationRadius(od, id) {
  return Math.sqrt(od * od + id * id) / 4;
}

/**
 * Cowper's (1966) shear coefficient for a hollow circular section, kappa.
 *
 * Timoshenko theory replaces the true parabolic-ish shear stress over the
 * section with a uniform one, and kappa is the fiddle factor that makes the two
 * store the same energy. It is NOT a free parameter: it falls out of the
 * elasticity solution for the section shape. 0.5369 for 28/25 mm at nu = 0.33.
 */
export function shearCoefficient(od, id, nu) {
  const m2 = (id / od) * (id / od);
  const s = (1 + m2) * (1 + m2);
  return 6 * (1 + nu) * s / ((7 + 6 * nu) * s + (20 + 12 * nu) * m2);
}

/**
 * k = E / (kappa * G), the ratio of bending stiffness to shear stiffness.
 * G = E / (2(1+nu)) is isotropic, so E cancels and only nu and the section
 * shape survive. 4.954 for this stock: shear is FIVE TIMES softer than bending,
 * which is why ignoring it is not a rounding error.
 */
export function shearToBendingRatio(od, id, nu) {
  return 2 * (1 + nu) / shearCoefficient(od, id, nu);
}

/**
 * The Timoshenko slowing factor for one mode: omega_Timoshenko / omega_EB.
 *
 * eps = (r * beta_n)^2 is the squared ratio of the radius of gyration to the
 * bending wavelength - the one dimensionless number that says how much of a
 * beam this beam still is. The Timoshenko dispersion relation
 *
 *     k*eps^2 * X^2  -  (1 + eps*(1+k)) * X  +  1  =  0,    X = (w/w_EB)^2
 *
 * comes straight from substituting a travelling wave into
 * EI w'''' + rho*A w.. - rho*I(1+k) w''.. + (rho^2 I/(kappa G)) w.... = 0,
 * i.e. Euler-Bernoulli plus rotary inertia plus shear deformation. Its lower
 * root is the bending branch.
 *
 * Written as 2/(B + sqrt(D)) rather than (B - sqrt(D))/(2A) on purpose: the
 * textbook form subtracts two nearly equal numbers and loses every significant
 * digit for a slender tube, where eps is 1e-3 and A is 1e-5. This form never
 * cancels. The discriminant is expanded by hand for the same reason -
 * B^2 - 4A works out to exactly 1 + 2*eps*(1+k) + eps^2*(k-1)^2, a sum of
 * positive terms, so it can never go negative however stubby the tube gets.
 *
 * Both limits are right: eps -> 0 returns 1 (thin beam, Euler-Bernoulli), and
 * eps -> infinity gives X -> 1/(k*eps), so f_n tends to a constant times beta_n
 * rather than beta_n^2. A shear-dominated beam stops being dispersive, and its
 * partials line up in a harmonic series. That is the direction real chimes lean.
 */
export function modeSlowing(eps, k) {
  if (!(eps > 0)) return 1;
  const b = 1 + eps * (1 + k);
  const km1 = k - 1;
  return Math.sqrt(2 / (b + Math.sqrt(1 + 2 * eps * (1 + k) + eps * eps * km1 * km1)));
}

function stockOf(tube) {
  if (!tube || tube === TUBE_STOCK) return TUBE_STOCK;
  return {
    od: num(tube.od, TUBE_STOCK.od),
    id: num(tube.id, TUBE_STOCK.id),
    E: num(tube.E, TUBE_STOCK.E),
    rho: num(tube.rho, TUBE_STOCK.rho),
    nu: num(tube.nu, TUBE_STOCK.nu)
  };
}

/**
 * Everything about one tube's modes: the length, the slenderness, and the five
 * partial ratios that follow.
 *
 * Give it a length and it tells you the pitch; give it a pitch and it tells you
 * the length. The pitch case is a fixed point because f1 depends on the
 * correction and the correction depends on f1, but the map is a strong
 * contraction (the correction is a couple of percent) and it settles to machine
 * precision in about five passes. Only +, *, / and sqrt are used, so a browser
 * and Node agree bit for bit.
 *
 * WHY RATIOS CANNOT BE A CONSTANT: eps_n = (r*beta_n/L)^2 carries the tube's own
 * length and its own wall. For this stock a 1.13 m bass tube comes out 14 cents
 * flat of ideal on mode 2 and a 0.37 m treble tube 110 cents flat - the same
 * beam theory, an eightfold difference in the answer. A fixed table of ratios is
 * a table that is wrong for every tube but one.
 */
export function tubeModes(opts) {
  const o = opts || {};
  const stock = stockOf(o.tube);
  const r = gyrationRadius(stock.od, stock.id);
  const k = shearToBendingRatio(stock.od, stock.id, stock.nu);
  const cL = Math.sqrt(stock.E / stock.rho);
  const b1 = BETA_L[0];

  let L = num(o.L, 0);
  let eps1;
  if (L > 0) {
    eps1 = (r * b1 / L) * (r * b1 / L);
  } else {
    // f1 = (beta1^2 / (2 pi L^2)) * r * cL * slowing(eps1), and eps1 = (r beta1/L)^2,
    // so eps1 = 2 pi f1 r / (cL * slowing(eps1)) with L eliminated entirely.
    const f1 = Math.max(1e-6, num(o.f1, 261.63));
    const base = 2 * Math.PI * f1 * r / cL;
    eps1 = base;
    for (let i = 0; i < 8; i++) {
      const next = base / modeSlowing(eps1, k);
      if (Math.abs(next - eps1) <= 1e-15 * next) { eps1 = next; break; }
      eps1 = next;
    }
    L = b1 * r / Math.sqrt(eps1);
  }

  const s1 = modeSlowing(eps1, k);
  const ratios = new Array(MAX_PARTIALS);
  for (let n = 0; n < MAX_PARTIALS; n++) {
    ratios[n] = IDEAL_RATIOS[n] * modeSlowing(eps1 * IDEAL_RATIOS[n], k) / s1;
  }
  return {
    L, r, k, eps1, ratios,
    kappa: shearCoefficient(stock.od, stock.id, stock.nu),
    f1: (b1 * b1 / (2 * Math.PI * L * L)) * r * cL * s1,
    slenderness: L / r
  };
}

/** Just the five ratios for a tube of this fundamental. */
export function modeRatios(f1, tube) {
  return tubeModes({ f1, tube }).ratios;
}

/** The length a tube of this stock has to be cut to in order to ring at f1. */
export function tubeLengthFor(f1, tube) {
  return tubeModes({ f1, tube }).L;
}

/** The fundamental a tube of this stock rings at when cut to L metres. */
export function f1ForLength(L, tube) {
  return tubeModes({ L, tube }).f1;
}

// A note on the two length laws. physics.js cuts its tubes with
// lengthForFreq(), which is the Euler-Bernoulli f = 168.92 / L^2 for this same
// stock; tubeLengthFor() above is the same relation with the shear correction
// in it, so for a given note it asks for a tube 0.1 to 1.0 percent shorter.
// audio.js hands strikeVoice the length physics.js actually cut, so the
// overtones follow the tube on screen, and the residual disagreement moves
// mode 2 by well under a cent and mode 5 by about three. Collapsing the two
// laws into one is worth doing, but it moves every tube's mass and inertia,
// which makes it a physics change rather than an audio one.

// Where this stops being true. Timoshenko theory is a one-dimensional model
// and it holds while the tube is still recognisably a beam; past roughly
// L/r = 10 the section is deforming and no beam theory of any order applies.
// The simulator's own range is L/r 39 (a 0.37 m treble tube) to 121 (a 1.13 m
// bass tube), comfortably inside. The formula stays finite and monotonic well
// past that, so nothing explodes if a caller asks for something silly, but the
// answer stops meaning anything.

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
 *   tube      {od, id, E, rho, nu} of the stock, defaulting to TUBE_STOCK
 *   L         this tube's cut length in metres, if the caller knows it; the
 *             length implied by f1 and the stock is used when it does not
 *
 * Nothing here reads a clock, a listener or a graph, so a caller is free to
 * evaluate it whenever it likes.
 */
export function strikeVoice(opts) {
  const o = opts || {};

  // f1 is now a physical quantity - it decides how long the tube is, which
  // decides where its overtones land - so it has to be positive. It always was
  // in practice, but freqScale below is sqrt(440/f1) and a negative f1 turned
  // every T60 into NaN in silence.
  const f1 = Math.max(1e-6, num(o.f1, 261.63));
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

  // The mode ratios are this tube's, not a constant. A tube nobody has ever
  // recorded lands where its own geometry puts it.
  const modes = tubeModes({ f1, L: o.L, tube: o.tube });
  const ratios = modes.ratios;

  const nPartials = clamp(num(o.partials, MAX_PARTIALS) | 0, 1, MAX_PARTIALS);
  const freqs = new Array(nPartials);
  const amps = new Array(nPartials);
  let sumSq = 0;
  for (let n = 0; n < nPartials; n++) {
    const f = f1 * ratios[n];
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

  // ratio^-1.15 is a stand-in for damping rising with frequency, so it has to
  // read the frequency the partial ACTUALLY has. Feeding it the ideal ratio
  // after correcting the pitch would give mode 3 the decay of a partial that is
  // not there. This does make the upper partials ring longer than they used to,
  // because they are now lower in frequency: real, and measurably still too
  // long against a real chime, but that is the decay law's problem, not this
  // one's.
  const t60s = new Array(nPartials);
  for (let n = 0; n < nPartials; n++) {
    t60s[n] = clamp(decay * freqScale * Math.pow(ratios[n], -1.15), 0.02, 40);
  }

  return {
    // Echo of the resolved inputs, so a renderer never has to re-derive them.
    f1, s, vn, mu, isTube,
    // Excitation.
    A0, norm, tauC, fc,
    // The tube, as resolved: length, radius of gyration, slenderness, ratios.
    tube: modes,
    ratios,
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
