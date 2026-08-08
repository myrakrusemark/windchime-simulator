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
// wavelength is long against the cross-section; by mode 5 on a 0.66 m chime
// tube it is about 16 radii of gyration, at which point shear deformation and
// rotary inertia are not corrections but first-order terms. Ignoring them puts
// mode 3 of a real recorded chime 175 to 244 cents sharp. See modeSlowing.
//
// The correction turns on the tube's DIAMETER as much as on its length, so the
// diameter is not a constant hiding in this file: it is part of the tube spec,
// it comes from a manufacturer's published stock size, and CATALOGUE below is
// the published data every derived number here is computed from.

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

// --- Section properties ----------------------------------------------------

/**
 * Radius of gyration of a tube's cross-section, sqrt(I/A) = sqrt(Do^2+Di^2)/4.
 *
 * This is the number the whole correction below turns on, and a TUBE is the
 * worst case for it: all the metal sits far from the axis, so the 44.45/39.25
 * mm stock has r = 14.83 mm against 11.11 mm for a solid rod of the same
 * outside diameter. A tube is a third stubbier than it looks.
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
 * elasticity solution for the section shape. 0.5364 for this stock at
 * nu = 0.33, and it barely moves with the wall - a thin-walled tube tends to
 * 0.53307 and a solid rod to 0.88864, so every chime tube is near 0.535.
 */
export function shearCoefficient(od, id, nu) {
  const m2 = (id / od) * (id / od);
  const s = (1 + m2) * (1 + m2);
  return 6 * (1 + nu) * s / ((7 + 6 * nu) * s + (20 + 12 * nu) * m2);
}

/**
 * k = E / (kappa * G), the ratio of bending stiffness to shear stiffness.
 * G = E / (2(1+nu)) is isotropic, so E cancels and only nu and the section
 * shape survive. 4.958 for this stock: shear is FIVE TIMES softer than
 * bending, which is why ignoring it is not a rounding error.
 */
export function shearToBendingRatio(od, id, nu) {
  return 2 * (1 + nu) / shearCoefficient(od, id, nu);
}

// --- What a chime tube is actually made of ---------------------------------
//
// 6061-T6 aluminium. E and rho set the wave speed sqrt(E/rho) = 5055 m/s, which
// is what makes a tube of a given length ring at the pitch it does; nu sets the
// shear correction above.
export const ALUMINIUM = Object.freeze({ E: 6.9e10, rho: 2700, nu: 0.33 });

// Every wind-chime tube either maker publishes hard numbers for. Nothing in
// this table came from a recording, a sweep or a fit: `od` and `wall` are stock
// sizes off a spec sheet, `longest` and `lowest` are the published length and
// key of the instrument's longest tube. Walls left null are not published and
// are SOLVED below from the maker's own length/diameter/key, which leaves the
// beam law exactly one unknown.
//
//   Theta Chimes, per model page (thetachimes.com, via Sunreed/Soundtopia):
//     Twin Flame small   0.625 in, "approximately 1.3 mm thick"
//     Twin Flame large   1.25 in,  "approximately 2 mm thick"
//     Flower of Life     1.75 in,  "average tube thickness 2.6 mm with the
//                                  powder coated layer", 64 in hanging height,
//                                  six tubes, major scale
//     Supergiant         3 in,     "average tube thickness 3 mm", 93 in hanging
//                                  height, tubes 49/44.75/42.75/39/36.5/34.5 in
//                                  for D4 E4 G4 A4 C#5 D5, 14 in top ring
//   Wind River Chimes, per Corinthian Bells model page (windriverchimes.com):
//     50 in   longest tube 27.75 in, 1.50 in tubes, key of A
//     65 in   longest tube 40.25 in, 2.25 in tubes, pentatonic scale of Eb
//     78 in   longest tube 47.75 in, 2.50 in tubes, key of B
export const CATALOGUE = Object.freeze([
  { name: 'Theta Twin Flame small', od: 0.015875, wall: 0.0013, longest: null, lowest: null },
  { name: 'Theta Twin Flame large', od: 0.031750, wall: 0.0020, longest: null, lowest: null },
  { name: 'Theta Flower of Life', od: 0.044450, wall: 0.0026, longest: null, lowest: null },
  { name: 'Theta Supergiant', od: 0.076200, wall: 0.0030, longest: 1.24460, lowest: 293.66 },
  { name: 'Corinthian Bells 50', od: 0.038100, wall: null, longest: 0.704850, lowest: 440.00 },
  { name: 'Corinthian Bells 65', od: 0.057150, wall: null, longest: 1.022350, lowest: 311.13 },
  { name: 'Corinthian Bells 78', od: 0.063500, wall: null, longest: 1.212850, lowest: 246.94 }
].map(Object.freeze));

/**
 * The wall a tube must have to ring at f1 when cut to L of the given outside
 * diameter. Bisection on a monotonic function - a thicker wall moves metal
 * toward the axis, shrinks the radius of gyration and drops the pitch - between
 * a foil tube and a solid rod. Used only to fill in the walls Wind River do not
 * publish; nothing downstream calls it at runtime.
 */
export function wallForPitch(od, L, f1, material) {
  const m = material || ALUMINIUM;
  let lo = 1e-5, hi = od / 2 - 1e-6;
  for (let i = 0; i < 200; i++) {
    const w = 0.5 * (lo + hi);
    if (pitchOfCut(od, od - 2 * w, L, m) > f1) lo = w; else hi = w;
  }
  return 0.5 * (lo + hi);
}

/** The fundamental of a tube of this exact section cut to exactly L metres. */
function pitchOfCut(od, id, L, m) {
  const r = gyrationRadius(od, id);
  const b1 = BETA_L[0];
  const eps1 = (r * b1 / L) * (r * b1 / L);
  const k = shearToBendingRatio(od, id, m.nu);
  return (b1 * b1 / (2 * Math.PI * L * L)) * r * Math.sqrt(m.E / m.rho) * modeSlowing(eps1, k);
}

// Two invariants, both MEASURED off the table above rather than typed in, so
// that changing the table changes them and a reader can check the arithmetic.
//
// R_OVER_OD, the radius of gyration as a fraction of the outside diameter, is
// what the mode ratios actually care about, and across all seven tubes it is
// 0.3228 to 0.3399 - a spread of +/- 2.6 percent against a 5:1 range of
// diameter and a wall that runs from 3.9 to 9.2 percent of the diameter. A
// solid rod would be 0.25 and a foil tube 0.3536, so every real chime tube sits
// near the thin-wall end and the wall is very nearly irrelevant. This is why
// the DIAMETER is the load-bearing number and the wall is not.
//
// CHIME_LD, the longest tube's length over its diameter, is 16.3 to 19.1 across
// the four instruments that publish both - two makers, a 1.8:1 range of size.
// A maker picks the stock to suit the chime's lowest note; chimeStock() below
// is that rule, and it is what sizes an instrument nobody has recorded.
export const R_OVER_OD = CATALOGUE.reduce((s, c) => {
  const w = c.wall !== null ? c.wall : wallForPitch(c.od, c.longest, c.lowest);
  return s + gyrationRadius(c.od, c.od - 2 * w) / c.od;
}, 0) / CATALOGUE.length;

export const CHIME_LD = (() => {
  const withL = CATALOGUE.filter(c => c.longest !== null);
  return withL.reduce((s, c) => s + c.longest / c.od, 0) / withL.length;
})();

// id/od that reproduces R_OVER_OD exactly: r/od = sqrt(1 + (id/od)^2)/4.
const ID_OVER_OD = Math.sqrt(Math.max(0, 16 * R_OVER_OD * R_OVER_OD - 1));

/**
 * The stock a maker would buy for a chime whose lowest note is f1: pick the
 * diameter so the longest tube comes out CHIME_LD diameters long, then the wall
 * so the section matches R_OVER_OD. A fixed point, because the tube's length
 * depends on the stock and the stock depends on the length; the map contracts
 * hard (each pass moves the diameter by less than a percent) and settles in
 * about eight.
 *
 * This is the function that sizes a chime nobody has recorded, and it is the
 * only place the catalogue ladder is used. It is deliberately NOT what sizes
 * the simulator's own tubes - see TUBE_STOCK.
 */
export function chimeStock(lowestHz, material) {
  const m = material || ALUMINIUM;
  const f = Math.max(1e-6, num(lowestHz, 261.63));
  let od = 0.045;
  for (let i = 0; i < 24; i++) {
    const id = od * ID_OVER_OD;
    const L = tubeModes({ f1: f, tube: { od, id, E: m.E, rho: m.rho, nu: m.nu } }).L;
    const next = L / CHIME_LD;
    if (Math.abs(next - od) <= 1e-15 * next) { od = next; break; }
    od = next;
  }
  return Object.freeze({ od, id: od * ID_OVER_OD, E: m.E, rho: m.rho, nu: m.nu });
}

/**
 * The section of a named catalogue tube, as a stock object the rest of this
 * file and its callers can use. Walls the maker does not publish are solved
 * from that maker's own published length and key.
 *
 * This exists so that no diameter is ever typed twice. render-offline.mjs
 * renders a reference recording on the instrument that made it by NAME, and
 * gets exactly the numbers CATALOGUE above carries.
 */
export function stockFor(name, material) {
  const m = material || ALUMINIUM;
  const c = CATALOGUE.find(e => e.name === name);
  if (!c) throw new Error(`stockFor: no catalogue tube named "${name}"`);
  const wall = c.wall !== null ? c.wall : wallForPitch(c.od, c.longest, c.lowest, m);
  return Object.freeze({ od: c.od, id: c.od - 2 * wall, E: m.E, rho: m.rho, nu: m.nu });
}

// The stock THIS simulator hangs, and the one number in this file a reader
// should interrogate hardest, because every ratio below depends on the
// diameter. It is not typed here: it is the Theta Chimes Flower of Life row of
// CATALOGUE above, 1 3/4 inch powder-coated aluminium with a 2.6 mm average
// wall, both off the maker's spec sheet. Edit the catalogue and the simulator
// changes with it; there is no second copy to drift.
//
// BE CLEAR ABOUT WHAT THIS CHOICE IS AND IS NOT. The mode-ratio LAW below is
// derived and takes no input from any recording. WHICH published tube the
// simulator hangs is a choice, and an honest reader should know that a global
// diameter only reproduces the three reference clips inside a window 2.6
// percent wide in outside diameter -- 43.52 to 44.66 mm at this wall -- because
// the three recordings are three different instruments with radii of gyration
// of 14.8, 18.4 and 25.9 mm and no single tube is all three. The defence is not
// that the window is comfortable. It is that this stock is a real published
// section of a real instrument that is in the set, that the model run on each
// instrument's OWN published section predicts that instrument (see the note on
// the Supergiant below, and tools/verify-stock.mjs, which runs the test), and
// that the same law with chimeStock() predicts a fourth chime nobody involved
// has recorded to within 19 cents. A fitted constant does none of those.
//
// Why a Flower of Life and not one of the others: it is the only one of the
// three recorded instruments that is the same KIND of object this simulator
// draws - a six-tube major-scale garden chime with a 64 inch hanging height.
// The Supergiant is 93 inches and 35 lb and wants nine feet of clearance; the
// Corinthian 65 is a 30 lb instrument on a much fatter extrusion.
//
// The honest cost of hanging one stock instead of sizing it per chime: at the
// default scale's lowest note this file cuts a 1.00 m tube of 44.45 mm stock,
// which is 22.6 diameters - more slender than the 16 to 19 a maker would build,
// so the simulator's bottom notes come out slightly MORE inharmonic than a
// commercial chime of that pitch would be. That is what happens when you cut a
// whole scale from one length of tube, which is exactly what a person building
// a chime in a shed does. chimeStock() above is the other way round, and a
// caller who wants maker-proportioned tubes can pass its result as `tube` --
// audio.js and physics.js both take the section as an argument now, so a rig
// built on a different stock is drawn, weighed and voiced on that stock.
export const TUBE_STOCK = stockFor('Theta Flower of Life');

/**
 * The n = 2 ovalling frequency of the tube wall, in Hz - where the section
 * stops holding its shape and NO beam theory of any order applies, because the
 * cross-section is now deforming instead of translating and rotating.
 *
 * This is the thin-ring result f_n = (n(n^2-1)/sqrt(n^2+1)) * (h/a^2) *
 * sqrt(E/(12 rho (1-nu^2))) / 2pi, with a the mean radius and h the wall. It is
 * a FLOOR, not the exact shell mode: a finite tube's shell modes carry axial
 * dependence too and sit above it.
 *
 * It matters because it is not always comfortably out of the way. On the
 * Flower of Life stock it is 3.9 kHz, above every partial this file voices at
 * chime pitches; on Myra's chime stock it is 13 kHz; on the Corinthian Bells
 * 65-inch it is 5.1 kHz. But on the Theta Supergiant - 3 in diameter with a
 * 3 mm wall, the thinnest-walled tube in the catalogue in proportion - it is
 * 1479 Hz, which is BELOW that instrument's own second bending mode. That is
 * the one reference recording this model does not reproduce, and this number is
 * why: past here the tube is a shell, not a beam.
 */
export function ovallingHz(tube) {
  const s = stockOf(tube);
  const wall = 0.5 * (s.od - s.id);
  const a = 0.5 * (s.od - wall);
  const n = 2;
  const c = Math.sqrt(s.E / (12 * s.rho * (1 - s.nu * s.nu)));
  return (n * (n * n - 1) / Math.sqrt(n * n + 1)) * (wall / (a * a)) * c / (2 * Math.PI);
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
 * length and its own section. On this stock a 1.42 m bass tube at C3 comes out
 * 21 cents flat of ideal on mode 2 and a 0.50 m treble tube at C6 comes out 144
 * flat - the same beam theory, a sevenfold difference in the answer. A fixed
 * table of ratios is a table that is wrong for every tube but one.
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
  const f1 = (b1 * b1 / (2 * Math.PI * L * L)) * r * cL * s1;
  const shellHz = ovallingHz(stock);
  // How many of the five partials this tube can honestly claim: a mode above
  // the section's ovalling floor is not a beam mode at all. Reported rather
  // than enforced, because clamping a partial away would be a bigger lie than
  // voicing it slightly wrong - but a caller that wants to know, can ask.
  let beamModes = 0;
  while (beamModes < MAX_PARTIALS && f1 * ratios[beamModes] < shellHz) beamModes++;
  return {
    L, r, k, eps1, ratios, f1, shellHz, beamModes,
    kappa: shearCoefficient(stock.od, stock.id, stock.nu),
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

// There is now ONE length law and ONE tube. physics.js used to carry its own -
// f = 168.92 / L^2, the Euler-Bernoulli relation for 28 mm curtain rod, which
// cut 0.80 m at middle C - so the tube on screen and the tube you could hear
// were different objects and the mode ratios belonged to neither. It imports
// tubeLengthFor() and TUBE_STOCK from here instead. The rig's tubes are now
// 1.00 m at middle C, 44.45 mm across and 0.92 kg per metre, and those are the
// same numbers this file voices, so the chime on screen IS the chime you hear.
//
// It is worth being clear about what that cost. Every tube got a quarter longer
// and 2.7 times heavier per metre, which is a real mechanics change: a tube's
// wind deflection goes as drag over weight, so the same 12 mph breeze now leans
// the set 2.7 degrees instead of 4.6. A heavier chime IS harder for the wind to
// move, and that is the point, but it means this piece moved the rig as well as
// the sound, and any strike-rate comparison across it is not like for like.

// Where this stops being true, in two ways.
//
// FIRST, slenderness. Timoshenko theory is one-dimensional and it holds while
// the tube is still recognisably a beam; past roughly L/r = 10 the section is
// deforming and no beam theory of any order applies. On this stock the
// simulator's range is L/r 31 (a 0.46 m tube at the 1200 Hz cap) to 96 (a
// 1.42 m tube at C3), comfortably inside, and the reference chimes sit at 33 to
// 56. The formula stays finite and monotonic well past that, so nothing
// explodes if a caller asks for something silly, but the answer stops meaning
// anything.
//
// SECOND, and this is the one that actually bites: ovallingHz(). A mode above
// the section's n = 2 ovalling floor is a shell mode, not a bending mode, and
// the beam is the wrong model for it however slender it is.
//
// The Theta Supergiant is the instrument where this stops being a footnote, and
// the argument here was wrong in an earlier version of this file, so it is
// worth setting out with the numbers a reader can check against
// refs/clean/thetachimes-supergiant-592hz.wav.
//
// Fed Theta's own published 3 in tube with a 3 mm wall, this model cuts 0.863 m
// for the 592.36 Hz partial - Theta publish 34.5 in, so the length law agrees
// to 1.6 percent - and then puts bending mode 2 at 1502.9 Hz and mode 3 at
// 2664.4 Hz. The recording has partials at 1507.01 Hz and 2690.00 Hz: 4.8 and
// 16.6 cents away, on a tube whose diameter nothing here fitted. That is the
// model predicting a reference instrument from its spec sheet.
//
// What it does NOT do is agree with the mode assignment. analyze.py matches
// each mode to the partial nearest the IDEAL Euler-Bernoulli ratio, so on this
// clip it calls 1571.41 Hz mode 2 and 2894.12 Hz mode 3 - the two lines that
// happen to sit closest to 2.7565 and 5.4039 - and against those the model is
// 77 and 143 cents flat. The earlier note claimed 1571 Hz was "12 dB louder"
// than the line the model predicts. It is not: analyze.py puts 1571.41 Hz at
// -37.83 dB and 1507.01 Hz at -23.46 dB, so the line the matcher picks is
// 14.4 dB QUIETER, and the weakest of the three in that cluster.
//
// The reason there is a cluster at all is the floor. This tube's n = 2 ovalling
// frequency is 1478.5 Hz, BELOW its own second bending mode, and the recording
// shows five partials packed between 1507 and 1893 Hz and then nothing until
// 2310 - the signature of a shell family opening at its cutoff. On the other
// three instruments the floor is 3.9, 5.1 and 13 kHz, above every partial they
// show, and the model predicts them from published geometry alone. tubeModes()
// reports this as `beamModes`, which is 1 for this tube: the model says in
// advance, from geometry and material only, that it is not entitled to speak
// about the Supergiant's mode 2. Nothing here is tuned to close that gap,
// because the gap is not in the beam theory.

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

// The ring-trim slider's neutral position. `decay` used to be the fundamental's
// T60 in seconds at 440 Hz; the T60 is now computed from the tube, so the same
// control is a multiplier and 8 is where it multiplies by one.
export const DECAY_NOMINAL = 8;

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

/** Slope of the mode shape, dY_n/ds. */
export function modeSlope(n, s) {
  const k = BETA_L[n];
  const ks = k * s;
  return 0.5 * k * (
    Math.sinh(ks) - Math.sin(ks) -
    SIGMA[n] * (Math.cosh(ks) + Math.cos(ks))
  );
}

/**
 * The first node of mode n, as a fraction of the length from the end.
 *
 * Bisected off modeShape rather than typed in, so that 0.2242 is a RESULT here
 * and not an input: it is where Y_1 crosses zero, and if BETA_L or SIGMA ever
 * changed the hang point would follow. Mode 1's node is the one every chime
 * maker drills for.
 */
export function firstNode(n) {
  let lo = 1e-6, hi = 0.5;
  const y0 = modeShape(n, lo);
  for (let i = 0; i < 80; i++) {
    const m = 0.5 * (lo + hi);
    if (modeShape(n, m) * y0 > 0) lo = m; else hi = m;
  }
  return 0.5 * (lo + hi);
}

export const NODE_1 = firstNode(0);

// --- Where the ring time actually comes from --------------------------------
//
// Not from the metal. The intrinsic Q of 6061-T6511 is measured at up to 2.8e5,
// which at 300 Hz on its own would be a T60 of 2050 seconds; a real chime rings
// for 5 to 30. So material damping is a rounding error and the ring time is set
// by the two places the energy can actually leave: the air, and the cord.
//
// Losses add, T60s do not. Each mechanism contributes a 1/Q and they are summed
// as reciprocals - a mode is as dead as its leakiest channel, never deader.

export const AIR = Object.freeze({ rho: 1.2, c: 343 });

// Intrinsic Q of the alloy. Present so the sum is complete and so a reader can
// see how little it does, not because it matters at chime frequencies.
export const Q_INTRINSIC = 2.8e5;

// The hanging cord. Nylon is not incidental: its hysteretic loss factor is about
// 0.1, four orders of magnitude above the aluminium's 4e-6, so the tiny fraction
// of the tube's energy that reaches the cord is the fraction that is gone.
//
// HYSTERETIC, not viscous, and the distinction is load-bearing. A polymer's loss
// per cycle is proportional to the strain energy per cycle and very nearly
// independent of rate, i.e. R = eta*k/omega rather than a constant R. That one
// choice is the difference between passing and failing the reference set: a
// viscous support makes the fundamental's T60 FALL with pitch, a hysteretic one
// makes it RISE, and the real chimes barely move across 464 to 739 Hz while the
// radiation term alone falls eightfold. Nothing else in the model can flatten it.
//
// CONTACT STIFFNESS PROPORTIONAL TO LOAD. The cord is not bonded to the tube; it
// is pressed into the hole by the tube's own weight, and a compliant polymer
// bearing on a metal edge makes real contact over a patch whose area grows in
// proportion to the load (Bowden and Tabor; Greenwood and Williamson). Stiffness
// follows area, so k = kappa * M * g with kappa a property of the contact and not
// of the tube. Order of magnitude from the same picture: kappa ~ E*/(p_flow * h)
// with E* ~ 2 GPa, a flow pressure around 210 MPa and a 3 mm cord gives about
// 3.2e3 per metre, against the 5.1e3 the reference decays ask for - a factor of
// 1.6, which is as close as an estimate built from three quantities each good to
// a factor of two has any right to be.
//
// It also has a consequence worth stating because it is testable: a heavy tube
// and a light one at the SAME pitch ring for the same time, because the heavier
// one stores more energy and presses the cord harder in exactly the same ratio.
export const CORD = Object.freeze({
  eta: 0.10,                    // hysteretic loss factor of braided nylon
  stiffnessPerLoad: 5.1e3      // kappa, 1/m: contact stiffness per newton of load
});

/** gamma = eta * kappa: the support's hysteretic conductance per newton hung. */
export const HANG_CONDUCTANCE_PER_LOAD = CORD.eta * CORD.stiffnessPerLoad;

export const GRAVITY = 9.81;

// Where the cord actually grips, as a fraction of the length from the top.
//
// The maker aims at NODE_1 = 0.2242, because Y_1 vanishes there and a cord tied
// at a point exactly on it could not touch the fundamental at all. This model
// says the grip is effectively 0.10 L further down, and that is the second and
// last number here taken from a decay measurement rather than from geometry or
// a datasheet.
//
// Why it cannot be nothing: with the grip exactly on the node the fundamental
// would be purely radiation-limited, and on this stock that is a T60 of 348 s at
// 464 Hz falling to 42 s at 739 - an eightfold swing across a range where three
// real chimes vary by a factor of 1.2. Something grips mode 1.
//
// Why it cannot be derived: the bearing is not a point. It is a drilled hole
// with a cord pulled against its edge by the tube's weight and wrapping an arc
// of it; mode 1 has the steepest slope of any mode at that station (Y_1' =
// -3.95), so the tube rocks about the grip and drags the cord axially as well as
// sideways; and the cord's own free length, its knot and the top ring all sit
// behind it. Every one of those reads, in the energy ledger, as the cord
// resisting the transverse motion of a station that is not the node, and none of
// them can be computed from a spec sheet.
//
// What it is NOT is a second knob for the fundamental. The fundamental's ring is
// set by the PRODUCT of the conductance and Y_1(HANG_S)^2 - one number - and
// this one only decides how hard the same cord grips the overtones. Past about
// 0.08 L the overtones are radiation-limited and the model stops leaning on it:
// moving it from 0.09 to 0.15 moves mode 2 by a quarter, against the 4.6-fold
// spread the three reference chimes themselves show in that same partial.
export const HANG_BEARING_OFFSET = 0.10;
export const HANG_S = NODE_1 + HANG_BEARING_OFFSET;

/**
 * |Yhat_n(q)|^2, the squared wavenumber spectrum of mode n over the tube's own
 * length, at axial wavenumber q = k_z * L. Closed form: the mode shape is a sum
 * of four exponentials over a finite interval, and each one integrates exactly.
 *
 * Written out in real and imaginary parts rather than with a complex helper so
 * that nothing allocates - this runs inside a strike.
 */
export function modeSpectrumSq(n, q) {
  const b = BETA_L[n];
  const sg = SIGMA[n];
  // E(c) = int_0^1 e^{(c - i q)s} ds for c = +b, -b (real) and c = +ib, -ib.
  // Real c: numerator e^c(cos q - i sin q) - 1 over (c - i q).
  const cq = Math.cos(q), sq = Math.sin(q);
  let coshR = 0, coshI = 0, sinhR = 0, sinhI = 0;
  for (let j = 0; j < 2; j++) {
    const c = j === 0 ? b : -b;
    const ec = Math.exp(c);
    const nr = ec * cq - 1, ni = -ec * sq;
    const dr = c, di = -q;
    const den = dr * dr + di * di;
    const er = (nr * dr + ni * di) / den;
    const ei = (ni * dr - nr * di) / den;
    if (j === 0) { coshR = er; coshI = ei; sinhR = er; sinhI = ei; }
    else { coshR = 0.5 * (coshR + er); coshI = 0.5 * (coshI + ei);
           sinhR = 0.5 * (sinhR - er); sinhI = 0.5 * (sinhI - ei); }
  }
  // Imaginary c = i*m with m = +b - q and -b - q: E = (e^{i m} - 1)/(i m)
  // = (sin m - i(cos m - 1))/m, and -> 1 + i m/2 as m -> 0.
  let cosR = 0, cosI = 0, sinR = 0, sinI = 0;
  for (let j = 0; j < 2; j++) {
    const m = (j === 0 ? b : -b) - q;
    let er, ei;
    if (Math.abs(m) < 1e-9) { er = 1; ei = 0.5 * m; }
    else { er = Math.sin(m) / m; ei = -(Math.cos(m) - 1) / m; }
    if (j === 0) { cosR = er; cosI = ei; sinR = er; sinI = ei; }
    else {
      cosR = 0.5 * (cosR + er); cosI = 0.5 * (cosI + ei);
      // sin(bs) = (e^{ibs} - e^{-ibs}) / 2i  ->  -0.5i * (E(ib) - E(-ib))
      const dr = sinR - er, di = sinI - ei;
      sinR = 0.5 * di; sinI = -0.5 * dr;
    }
  }
  const re = 0.5 * (coshR + cosR - sg * (sinhR + sinR));
  const im = 0.5 * (coshI + cosI - sg * (sinhI + sinI));
  return re * re + im * im;
}

/**
 * J_n(u), the finite-length radiation factor, u = k*L.
 *
 *   J_n(u) = int_{-u}^{u} |Yhat_n(q)|^2 (1 - q^2/u^2) dq
 *
 * This is the whole of what makes a real tube quieter than an infinite one, and
 * it is the reason the radiation term cannot be a closed form. Replace
 * |Yhat_n|^2 with a pair of deltas of mass pi/2 at q = +/- beta_n - which is
 * what assuming an infinitely long tube does - and J collapses to
 * (pi/2)(1 - (beta_n/u)^2), which puts Q_rad back at the textbook supersonic
 * result 2 m' c^2 / (pi^2 rho0 a^4 w (w - w_coincidence)). A real chime tube is
 * about one acoustic wavelength long, so its mode is nothing like a delta in
 * wavenumber: at 464 Hz on this stock only 12 percent of mode 1's wavenumber
 * content falls inside the radiation circle, and at 739 Hz, 25 percent. That
 * factor of two is most of the difference between a chime that rings and one
 * that does not.
 *
 * Below coincidence J is not zero but exponentially small, which is the correct
 * statement of "a sub-coincidence tube radiates from its ends and nothing else"
 * and is why the bass tubes here are cord-limited rather than air-limited.
 *
 * Simpson, with the point count tied to u because the integrand oscillates with
 * period 2*pi in q (the window is one length long). About twelve points per
 * oscillation; no allocation.
 */
export function radiationJ(n, u) {
  if (!(u > 0)) return 0;
  let N = 2 * Math.ceil(Math.max(24, u));
  if (N > 640) N = 640;
  const h = u / N;
  let acc = modeSpectrumSq(n, 0);              // q = 0, weight 1, (1 - 0) = 1
  for (let i = 1; i < N; i++) {
    const q = i * h;
    const t = 1 - (q / u) * (q / u);
    acc += (i & 1 ? 4 : 2) * modeSpectrumSq(n, q) * t;
  }
  // q = u contributes zero: the taper (1 - q^2/u^2) vanishes there.
  return 2 * (h / 3) * acc;                    // doubled: |Yhat(-q)| = |Yhat(q)|
}

/**
 * Per-mode T60, in seconds, for one tube.
 *
 *   1/Q_n = 1/Q_radiation + 1/Q_hang + 1/Q_intrinsic,   T60 = 2.199 Q / f
 *
 * RADIATION. A bending tube is a line of transverse dipoles: each slice pushes
 * air on one side and pulls it on the other, so the cross-section radiates with
 * efficiency (k a)^3 rather than (k a), and that cube is why a slim tube is a
 * quiet loudspeaker and a long-lived resonator. Taking the m = 1 cylindrical
 * radiation impedance in the compact limit, Re z1 = rho0 c (pi/2)(k_r a)^3, and
 * integrating over the mode's own wavenumber spectrum,
 *
 *     Q_rad,n = m' / (pi rho0 a^4 k_n^2 J_n(k_n L))
 *
 * with m' the tube's mass per metre and a its outside radius. No fitted number:
 * air density, the speed of sound, the tube's section and its mode shape.
 *
 * HANG. The cord is a hysteretic spring attached at the grip, resisting the
 * transverse motion of that station. Its conductance is G = gamma * M * g,
 * proportional to the weight hung on it. Energy stored is (1/8) M w^2 A^2 - the
 * free-free modes satisfy int_0^1 Y^2 ds = 1/4 exactly, which is worth checking
 * rather than believing - and the power lost is (1/2) G w A^2 Y_n(s_hang)^2, so
 *
 *     Q_hang,n = w_n^2 / (4 gamma g Y_n(s_hang)^2)
 *
 * with the tube's mass cancelling out of it entirely.
 *
 * And there is the cliff the whole piece turns on. |Y_n| at the grip is 0.345,
 * 0.658, 0.236, 0.436, 0.705 for modes 1 to 5, against 1.0 at a free end, so in
 * energy the cord holds mode 2 3.6 times harder than the fundamental, mode 5
 * 4.2 times harder, and mode 3 barely more than HALF as hard. It is not
 * monotonic in mode number and it could not be: it is the shape of the mode at
 * the place the string is tied, sampled at five points that have nothing to do
 * with each other. No power law in frequency can produce that sequence, which is
 * the whole reason the old ratio^-1.15 could not be right about the fundamental
 * and the overtones at the same time.
 *
 * What the two channels end up doing, on this stock at 464 / 593 / 739 Hz:
 *
 *   mode 1   radiation 348 / 112 / 42 s     cord 17 / 22 / 27 s    -> cord
 *   mode 2   radiation 4.1 / 1.8 / 0.9 s    cord 12 / 16 / 19 s    -> air
 *   mode 3   radiation 0.5 / 0.2 / 0.1 s    cord 177 / 221 / 269 s -> air
 *
 * The fundamental is held by the cord and the overtones are given away to the
 * air, and neither of those was chosen - they fall out of where the mode shapes
 * put their zeros.
 *
 * WHERE IT STOPS BEING TRUE, twice.
 *
 * Mode 3 is almost purely radiation-limited here, and the two reference clips
 * that show a measurable mode 3 disagree with each other in the wrong direction
 * (0.147 s at 2248 Hz against 0.459 s at 2894 Hz - the HIGHER partial outlasting
 * the lower one, which no monotone loss can produce). Nothing here is tuned to
 * those two numbers and the model should not be believed about mode 3 to better
 * than a factor of three.
 *
 * Below the coincidence frequency - 250 Hz on this stock - a tube stops radiating
 * as a line source at all, so its fundamental is left entirely to the cord while
 * its third partial is still above coincidence and still radiating. On the 1.42 m
 * C3 tube that cOctaveIntervals asks for, that puts mode 3 at 686 Hz ringing
 * longer than the fundamental under it, which is not what a bass chime does.
 * There is no clean recording below 464 Hz to check it against, so it is stated
 * here as a known limit rather than papered over: this model is evidence-backed
 * from 464 Hz up and extrapolation below it.
 */
export function modeT60s(freqs, L, tube, out) {
  const s = stockOf(tube);
  const a = 0.5 * s.od;
  const area = (Math.PI / 4) * (s.od * s.od - s.id * s.id);
  const mline = s.rho * area;
  const n = freqs.length;
  const t60 = out || new Array(n);
  const a4 = a * a * a * a;
  const gHang = 4 * HANG_CONDUCTANCE_PER_LOAD * GRAVITY;
  for (let i = 0; i < n; i++) {
    const f = freqs[i];
    if (!(f > 0)) { t60[i] = 0.02; continue; }
    const w = 2 * Math.PI * f;
    const k = w / AIR.c;
    const J = radiationJ(i, k * L);
    // 1/Q, summed. A vanishing J means the mode is below coincidence and does
    // not radiate as a line source at all; the cord and the metal carry it.
    let invQ = 1 / Q_INTRINSIC;
    if (J > 1e-12) invQ += Math.PI * AIR.rho * a4 * k * k * J / mline;
    const Y = modeShape(i, HANG_S);
    invQ += gHang * Y * Y / (w * w);
    t60[i] = 2.199 / (invQ * f);
  }
  return t60;
}

/** Time constant for a setTargetAtTime decay that is 60 dB down after T60 seconds. */
export function decayTau(T60) {
  return T60 / TAU_PER_T60;
}

// Absolute amplitude at which a partial has stopped existing, as a fraction of
// full scale. -120 dBFS, and the exponent was chosen by measurement rather than
// by taste: at -100 dBFS the retired tails were still worth about a third of a
// 16-bit LSB, enough to flip the rounding on a few thousand samples of a six
// second render, and that alone moved compare.py's total on the Flower of Life
// clip from 36.7 to 64.7 units. Nothing audible changed; the analyser simply
// picked different peaks out of the noise floor. At -120 dBFS the renders are
// bit-identical to the untruncated ones and the divergence totals do not move.
//
// (That fragility is worth knowing about on its own: a divergence total that
// swings by 28 units on one LSB is not a quantity two rounds can be compared on
// without pinning the render byte for byte first.)
export const VOICE_FLOOR = 1e-6;

/**
 * When a partial's oscillator can be stopped, in seconds after its own onset.
 *
 * Two rules, whichever comes first. The old one is relative: 69 dB below the
 * partial's own peak, which is where 1.15*T60 + 0.2 lands. The new one is
 * absolute: the moment the partial passes VOICE_FLOOR of full scale, given the
 * level it actually started at. They matter for different strikes. A hard hit on
 * a long tube is retired by the relative rule; a soft one is 25 dB quieter to
 * begin with and reaches the floor a third sooner, and it is soft strikes that a
 * chime in a breeze produces by the dozen.
 *
 * This is a polyphony question, not a tuning one. audio.js schedules the voice
 * teardown off the last oscillator to stop, so occupancy is set by exactly this
 * number, and against a hard cap of 32 voices (16 on the low tier) a fundamental
 * that now rings 16 s instead of 8 halves the sustained strike rate the pool can
 * absorb before it starts stealing. Retiring on absolute level gives most of that
 * back without touching anything audible.
 *
 * `level` is the partial's amplitude in the output, i.e. the voice gain times the
 * partial's own amplitude times any distance term.
 */
export function partialStop(T60, attack, level) {
  const relative = T60 * 1.15 + 0.2;
  if (!(level > VOICE_FLOOR)) return Math.max(attack + 0.02, 0.05);
  const absolute = attack + decayTau(T60) * Math.log(level / VOICE_FLOOR);
  return Math.max(0.05, Math.min(relative, absolute));
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

  // The ring time is no longer a decay law. It is a loss budget: radiation into
  // the air plus the cord at the hang point plus the alloy's own damping, summed
  // as 1/Q and turned into a T60 per mode. See modeT60s.
  //
  // What went: `decay * sqrt(440/f) * ratio^-1.15`. That form was internally
  // inconsistent - across tubes it implied Q ~ f^+0.5 and across the modes of one
  // tube Q ~ f^-0.15, from a single supposed loss mechanism - and it could not
  // be right about both the fundamental and the overtones at once. Scaling it
  // until the fundamental matched a real chime stretched mode 3 to 2.07 s
  // against a measured 0.459.
  //
  // `decay` survives as the RING TRIM the slider drives: 8 is the tube as
  // modelled, 16 is twice as long, 0.5 is a damped one. It multiplies every
  // mode equally, so moving it changes how long the chime rings and not which
  // partial outlives which.
  const decay = clamp(num(o.decay, DECAY_NOMINAL), 0.1, 30);
  const ringTrim = decay / DECAY_NOMINAL;
  const freqScale = Math.sqrt(440 / f1);
  const attack = Math.max(0.0005, num(o.attack, 0.002));
  const loudness = clamp(num(o.loudness, 0.5), 0, 1);

  const t60s = modeT60s(freqs, modes.L, o.tube, new Array(nPartials));
  for (let n = 0; n < nPartials; n++) {
    t60s[n] = clamp(t60s[n] * ringTrim, 0.02, 40);
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
