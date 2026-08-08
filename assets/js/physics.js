// physics.js - the rig.
//
// An XPBD (extended position-based dynamics) particle assembly of a top plate,
// N tuned tubes, a clapper and a wind sail, with unilateral cord constraints
// that genuinely go slack, quasi-steady aerodynamic forces sampled from the
// shared wind field, clapper-vs-tube collision, and strike extraction.
//
// The causal chain is the simulation: the wind pushes the SAIL, the sail cord
// drags the CLAPPER, the clapper hits a TUBE, the tube rings. Nothing here
// rings a tube from a wind number. If the sail stops working the chime goes
// quiet, which is exactly what a real one does.
//
// Everything is metres, kilograms, seconds, newtons. Y up, +X east, +Z south.
//
// TIMESTEP. This file exposes exactly one substep, step(h). main.js chooses
// n = clamp(ceil(dt / (1/240)), 1, 24) and h = dt/n, so the substep is never
// longer than 1/240 s. Every damping term in here is written as exp(-k*h)
// rather than as a per-step multiplier, so the rig settles to the same motion
// at 20 fps as at 144 fps.

import { Vector3, Quaternion, MathUtils } from 'three';
import { TUBE_STOCK, tubeLengthFor, f1ForLength } from './modal.js';

// ---------------------------------------------------------------------------
// Musical scales, and the one piece of physics that turns a note into a shape.
// ---------------------------------------------------------------------------

export const SCALES = {
  cMajorPentatonic: [261.63, 293.66, 329.63, 392.00, 440.00, 523.25],
  cMinorPentatonic: [261.63, 293.66, 311.13, 349.23, 392.00, 466.16],
  cMajorDiatonic: [261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 493.88, 523.25],
  cNaturalMinor: [261.63, 293.66, 311.13, 349.23, 392.00, 415.30, 466.16, 493.88],
  cLydian: [261.63, 293.66, 329.63, 369.99, 392.00, 440.00, 493.88, 523.25],
  cMixolydian: [261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 466.16, 523.25],
  cWholeTone: [261.63, 293.66, 329.63, 369.99, 415.30, 466.16, 523.25],
  cOctaveIntervals: [130.81, 261.63, 523.25, 1046.50]
};

// Above this the floor in lengthForFreq starts clamping, and two notes that
// both clamp come out as two tubes of identical length and identical pitch.
const MAX_TUBE_HZ = 1200;

// How long a tube this rig will hang. Both ends are guards against an absurd
// request, not working limits: the whole supported range, 130.81 Hz at the
// bottom of cOctaveIntervals to the 1200 Hz cap, cuts 1.423 m down to 0.457 m,
// so neither end binds on any built-in scale. That matters more than it used
// to. lengthForFreq and modal.js are now the same law, and the moment the
// clamp bites they stop being - the rig would draw one tube and voice another,
// which is the exact defect this file's own length constant used to cause.
const TUBE_L_MIN = 0.30;
const TUBE_L_MAX = 1.50;

export function freqsFor(scaleName, count) {
  const list = SCALES[scaleName] || SCALES.cMajorPentatonic;
  const asked = Number.isFinite(count) ? Math.round(count) : 6;
  const want = Math.max(3, Math.min(8, asked));

  // Most of the tables hold one octave, and several of them are SHORTER than
  // the tube-count slider's maximum of eight. Stopping at the end of the table
  // would leave the top of that slider doing nothing at all on the default
  // pentatonic, so instead the scale keeps climbing into the next octave, which
  // is what a chime maker does when they want more tubes than the scale has
  // notes.
  //
  // Several tables END on the octave of their own first note (C D E G A C'), and
  // that note is exactly what the wrap would generate next, so the wrap skips it.
  const n = list.length;
  const steps = (n > 1 && Math.abs(list[n - 1] / list[0] - 2) < 0.01) ? n - 1 : n;

  const out = [];
  for (let i = 0; i < want; i++) {
    const f = i < n
      ? list[i]
      : list[i % steps] * Math.pow(2, Math.floor(i / steps));
    // A table that is not really a scale (cOctaveIntervals is a stack of
    // octaves) can wrap onto a pitch it already has. Stop there rather than
    // hanging two identical tubes; main.js reports the real count back to the
    // slider label, so the control never claims more than it delivered.
    if (f > MAX_TUBE_HZ) break;
    let dup = false;
    for (let k = 0; k < out.length; k++) if (Math.abs(out[k] / f - 1) < 0.01) dup = true;
    if (dup) break;
    out.push(f);
  }

  while (out.length < 3) out.push(out[out.length - 1] * 2);
  return out;
}

// Length IS the note, and the relation between the two is modal.js's: the same
// Timoshenko law, on the same stock, that decides where the tube's overtones
// land. This file used to carry its own Euler-Bernoulli constant for 28 mm
// curtain rod, so the tube it drew and the tube audio.js voiced were different
// objects. There is one tube now.
export function lengthForFreq(f1Hz) {
  const f = Number.isFinite(f1Hz) && f1Hz > 0 ? f1Hz : 261.63;
  return MathUtils.clamp(tubeLengthFor(f, TUBE_STOCK), TUBE_L_MIN, TUBE_L_MAX);
}

export function freqForLength(Lm) {
  const L = Number.isFinite(Lm) && Lm > 0 ? Lm : 1.0027;
  return f1ForLength(MathUtils.clamp(L, TUBE_L_MIN, TUBE_L_MAX), TUBE_STOCK);
}

// ---------------------------------------------------------------------------
// Locked geometry and material constants.
// ---------------------------------------------------------------------------

const RHO = 1.225;                 // air density, kg/m^3
const GRAV = -9.81;                // m/s^2 on Y

const HOOK_X = 0.0, HOOK_Y = 2.60, HOOK_Z = 0.0;
const HOOK_CORD = 0.550;           // assembly pendulum period 1.49 s: a calm sway

// Circumradius of the 3-particle plate, and the radius of the visible disk. The
// whole head of the rig scales with R_RING below, which scales with the tube:
// both of these are 26.5 percent larger than they were for a 28 mm tube, which
// is exactly how much wider the ring had to get to hang a real 44.45 mm one.
const PLATE_A = 0.06956;
// Mirrored in scene.js as R_PLATE, the same way R_TUBE and HOOK_Y are --
// scene.js does not import from here. It has to exceed R_RING below, which is
// where the tube cords hang: at 0.070 against a ring of 0.082 the cords left
// the disk 12 mm short of its own edge and read as tied to thin air. The same
// 1.195 overhang is kept here.
const PLATE_R = 0.12395;
const PLATE_MASS = 0.150;
const PLATE_EDGE = PLATE_A * Math.sqrt(3);
const PLATE_Y = 2.05;
const PLATE_THETA = [Math.PI * 0.5, Math.PI * 7 / 6, Math.PI * 11 / 6];
// Edge-on only; the face is horizontal. Diameter times thickness, so it tracks
// the rendered disk.
const PLATE_DRAG_AREA = PLATE_R * 2 * 0.012;
const CD_PLATE = 1.1;

// THE PLATE HANGS ON A THREE-CORD BRIDLE, not on one cord to its middle, and
// that is load-bearing rather than decorative. A disk suspended by a single
// cord at its own centre of mass has EXACTLY ZERO rotational stiffness: the
// cord tension and the weight both act through the centroid, so neither can
// produce a righting torque. Meanwhile the tubes hang from ring points at
// radius R_RING and their weights are not equal (mass goes as length), so
// sum(m_i * r_i) is not zero and the plate feels a small constant overturning
// torque with nothing to resist it. Integrated over a couple of seconds that
// torque stands the plate on its edge and the tube tops fan out over 160 mm
// instead of hanging level 60 mm below the plate - which is exactly what this
// rig used to do.
//
// Three short cords from the hook to the plate rim fix it the way a real chime
// does: hook plus triangle is a rigid tetrahedron, so the plate keeps its
// attitude and the assembly swings as one body, while rotation about the
// vertical is still free (all three cords keep their length under yaw) so the
// chime can still turn slowly in the wind.
const BRIDLE_CORD = Math.sqrt(HOOK_CORD * HOOK_CORD + PLATE_A * PLATE_A);  // 0.55274

// Radius of the ring the tube cords hang from. Sized off the tube, not typed
// in: Theta publish a 14 inch top ring on the Supergiant's 3 inch tubes, which
// is a ring radius of 2.333 diameters, and that ratio is what keeps six to
// eight tubes clear of one another and of the clapper. It used to be 0.082
// against a 28 mm tube - 2.93 diameters, looser than a real chime. Leaving it
// there while the tube grew to its real 44.45 mm cut the gap between
// neighbours from 36 mm to 20 mm and had the rig clacking tube on tube four
// times a second in a 12 mph breeze; scaling it restores the 37 mm.
const RING_OVER_OD = 2.3333;
const R_RING = RING_OVER_OD * TUBE_STOCK.od;   // 0.10372 m
const R_OVER_A = R_RING / PLATE_A; // 1.4909 - the ring sits OUTSIDE the triangle

// Tube particles sit at the radius of gyration, not at the ends. Two point
// masses at t = 0.2113 and 0.7887 reproduce a uniform rod's I = mL^2/12.
// Putting them at the ends would give mL^2/4, three times too much, and every
// tube would swing in visible slow motion.
const T_A = 0.2113;
const T_B = 0.7887;
const T_SPAN = T_B - T_A;          // 0.5774
const NODE_T = 0.2242;             // the free-free fundamental node: where the cord goes
const TUBE_CORD_BASE = 0.060;      // every tube's TOP hangs this far below the plate
// The tube's section, straight off modal.js's stock rather than re-typed here.
// 44.45 mm OD, 2.6 mm wall: 0.9229 kg/m and a 22.2 mm outer radius, against the
// 0.3372 kg/m and 14 mm this file used to assume for 28 mm curtain rod. A real
// chime tube is heavy, and it shows in the wind - see the note in modal.js on
// what unifying the two cost.
const TUBE_OD = TUBE_STOCK.od;
const TUBE_R = TUBE_OD * 0.5;
const TUBE_LINDENS = Math.PI * 0.25 *
  (TUBE_STOCK.od * TUBE_STOCK.od - TUBE_STOCK.id * TUBE_STOCK.id) * TUBE_STOCK.rho;
const CD_TUBE = 1.15;              // cylinder in crossflow

// Axial twist of a tube on its cord. See the torsion block in the aero pass.
const TWO_PI = Math.PI * 2;
// Effective offset of a tube's centre of pressure from its axis: the seam, the
// hang holes and the cut ends, lumped. 0.47 mm puts the twist mode near 0.3 Hz
// at 12 mph -- slow enough to read as a lazy wind-up, not a vibration.
const TWIST_ARM = 4.7e-4;
// Cord torsion, N.m/rad, and its damping. The cord is weak in torsion; the
// damping is the light one a fibre cord actually has, so a tube hunts around
// its heading for several cycles instead of snapping to it.
const TWIST_K = 2.6e-4;
const TWIST_C = 3.0e-5;

// Tubes must not be able to render through one another. At the 2.7 degree
// steady lean they never would - adjacent ring points sit 81 mm apart at eight
// tubes against a 44 mm tube diameter - but a gust, a grab or a scale change
// can swing two
// together, and a tube passing through its neighbour is the most obviously
// fake thing this picture can do. Solved as capsule-vs-capsule over all pairs;
// N is at most 8, so that is 28 segment tests per substep.
const TUBE_PAIR_SEP = 2 * TUBE_R;

// Extrapolation coefficients for the physical ends of the tube, t = 0 and t = 1.
const CA_TOP = 1 - (0 - T_A) / T_SPAN;      //  1.36595
const CB_TOP = (0 - T_A) / T_SPAN;          // -0.36595
const CA_BOT = 1 - (1 - T_A) / T_SPAN;      // -0.36595
const CB_BOT = (1 - T_A) / T_SPAN;          //  1.36595

// ---------------------------------------------------------------------------
// Adjustable parts.
//
// These five are exposed to the user, so they are `let` and everything derived
// from them is recomputed in setParts() rather than being folded into a
// constant at module load. The defaults below are the values the whole rig was
// tuned around; PART_LIMITS is the authority on their ranges and main.js reads
// it rather than repeating the numbers in the HTML.
//
// Changing any of them alters particle masses, cord rest lengths or the
// collision radius, so the caller has to rebuild the rig afterwards.
// ---------------------------------------------------------------------------

export const PART_DEFAULTS = {
  clapperWidth: 0.068,   // disk DIAMETER; the gap to the tubes is set from it
  clapperMass: 0.035,
  clapperDrop: 0.400,    // below the top plate; period 1.27 s at the default
  sailMass: 0.032,
  sailHeight: 0.15,
};

export const PART_LIMITS = {
  // The upper bound is where the disk closes the gap to the tubes entirely:
  // R_RING - TUBE_R is 0.0815 m of radius now the ring and the tube have both
  // grown, so a diameter past about 0.163 leaves the clapper permanently in
  // contact and it buzzes instead of ringing. The margin at the 0.100 limit is
  // 31.5 mm, up from 18 mm on the old 28 mm tube and small ring.
  clapperWidth: [0.030, 0.100],
  clapperMass: [0.008, 0.090],
  // Down to where the disk sits level with the shortest tube's bottom, up to
  // where it barely clears the top plate.
  clapperDrop: [0.250, 0.620],
  sailMass: [0.008, 0.090],
  sailHeight: [0.070, 0.300],
};

/**
 * Apply a partial set of part values and recompute everything derived from
 * them. Values are clamped to PART_LIMITS, so a caller cannot put the rig into
 * a state it cannot integrate. The rig must be rebuilt afterwards: masses, cord
 * rest lengths and the collision radius all move.
 *
 * Returns the values actually in force, so a UI can reflect the clamping.
 */
export function setParts(next) {
  const p = next || {};
  const take = (key, fallback) => {
    const v = Number(p[key]);
    if (!Number.isFinite(v)) return fallback;
    const [lo, hi] = PART_LIMITS[key];
    return v < lo ? lo : (v > hi ? hi : v);
  };

  const width = take('clapperWidth', CLAPPER_R * 2);
  CLAPPER_R = width * 0.5;
  CLAPPER_HIT_R = CLAPPER_R;
  // Edge-on frontal area of the disk. Its thickness is not exposed, so it stays
  // at the 14 mm the geometry in scene.js draws.
  CLAPPER_AREA = width * 0.014;
  GAP = R_RING - TUBE_R - CLAPPER_R;

  CLAPPER_MASS = take('clapperMass', CLAPPER_MASS);
  CLAPPER_CORD = take('clapperDrop', CLAPPER_CORD);

  SAIL_MASS = take('sailMass', SAIL_MASS);
  SAIL_H = take('sailHeight', SAIL_H);
  SAIL_AREA = SAIL_W * SAIL_H;
  // Both of these are quoted about the sail's spine, which runs vertically, so
  // they scale with the WIDTH and the area -- not with the height directly.
  SAIL_I = SAIL_MASS * SAIL_W * SAIL_W / 12;
  SAIL_YAW_K = 0.5 * RHO * SAIL_AREA * SAIL_W * 0.06;

  return {
    clapperWidth: width,
    clapperMass: CLAPPER_MASS,
    clapperDrop: CLAPPER_CORD,
    sailMass: SAIL_MASS,
    sailHeight: SAIL_H,
  };
}

let CLAPPER_R = PART_DEFAULTS.clapperWidth * 0.5;
let CLAPPER_MASS = PART_DEFAULTS.clapperMass;
let CLAPPER_CORD = PART_DEFAULTS.clapperDrop;
let CLAPPER_AREA = PART_DEFAULTS.clapperWidth * 0.014;
const CD_CLAPPER = 1.1;

// Clapper-to-tube gap = R_RING - TUBE_R - CLAPPER_R, 0.0475 m at the default
// width, up from 0.034: the ring grew faster than the tube did. Comfortably
// clear of the 0.025 where a hard gust pins the clapper against a tube and it
// buzzes instead of ringing. A wide clapper
// narrows this on purpose -- that is what the width control is FOR -- but the
// upper limit stops it closing altogether.
let GAP = R_RING - TUBE_R - CLAPPER_R;

const SAIL_W = 0.11;
let SAIL_H = PART_DEFAULTS.sailHeight;   // spine length, and the spacing of its two particles
let SAIL_AREA = SAIL_W * SAIL_H;
let SAIL_MASS = PART_DEFAULTS.sailMass;
const SAIL_CORD = 0.550;           // hangs from the CLAPPER, not the plate
const CD_SAIL_N = 1.28;            // flat plate normal to the flow
const CD_SAIL_T = 0.02;            // skin friction along the plate
let SAIL_I = SAIL_MASS * SAIL_W * SAIL_W / 12;   // 3.227e-5 kg.m^2 about the spine
let SAIL_YAW_K = 0.5 * RHO * SAIL_AREA * SAIL_W * 0.06;  // dished-sail weathervane
const SAIL_YAW_DAMP = 3.0e-4;
const SAIL_YAW_NOISE_SIGMA = 1.5e-4;
const SAIL_YAW_NOISE_TAU = 1.2;
// Reference dynamic pressure the buffeting sigma is quoted at: 12 mph, the
// default wind, so scaling it leaves the design point untouched.
const SAIL_YAW_NOISE_U2 = 5.36 * 5.36;

// THE PORCH IS SOLID OVERHEAD. Above about 30 mph the aerodynamics are
// emphatically correct and emphatically alarming: a 28 mm tube at 20 m/s
// carries 5.3 N of drag against 2.3 N of weight, so tan(lean) = 2.3 and a real
// chime in a gale genuinely lies over near-horizontal and thrashes. None of
// that is a bug and none of it is damped away here - damping the sail would
// break the causal chain the whole project is built on. What WAS a bug is that
// the thrashing rig swung up THROUGH the beam it hangs from and out through the
// roof, ending with the wind sail above the plate it hangs from, which reads as
// broken geometry rather than as weather.
//
// The heights below are the beam underside and the roof underside from
// scene.js. Keep them in step by hand: physics.js deliberately knows nothing
// about the scene graph.
const PLATE_HIT_R = PLATE_R;       // the rendered disk radius
let CLAPPER_HIT_R = CLAPPER_R;
const SAIL_HIT_R = 0.060;
const TUBE_HIT_R = TUBE_R;

const CORD_ALPHA = 1e-7;           // XPBD compliance: near-inextensible, not brittle
const CORD_AXIAL_DAMP = 12.0;      // 1/s, kills longitudinal cord ringing only
const GLOBAL_DAMP = 0.05;          // 1/s. Real damping comes from the drag forces.
const MAX_SPEED = 20.0;            // m/s hard clamp, a stability backstop

const RESTITUTION = 0.45;
const MU_K = 0.35;
const CLEAR_HYSTERESIS = 0.040;    // s a tube must be free before a new strike counts
const REFRACTORY = 0.090;          // s between strikes on one tube: 11 Hz reads as a buzz
const MIN_STRIKE_VN = 0.045;       // m/s below which a touch is not a strike
// Tube against tube. The threshold is higher than the clapper's because tubes
// graze each other constantly in any real wind and only a genuine clack should
// speak; the refractory is shorter because a run of clacks IS the sound, where
// a rattling clapper is a buzz. Restitution is higher too: aluminium on
// aluminium is a far more elastic contact than the wooden clapper on a tube.
const MIN_TUBE_VN = 0.075;
const TUBE_REFRACTORY = 0.055;
const TUBE_RESTITUTION = 0.72;
// Token bucket on tube-pair strikes, pairs per second and burst depth. Not a
// musical limit -- the per-pair refractory is that -- but a bound on how fast
// voices can be created. Eight tubes in a 60 mph gale reach about 98 pairs a
// second, and every pair is TWO voices; the voice pool caps how many can sound
// at once but not how many can be built per second. Ordinary weather never
// touches this: six tubes at 60 mph run about 22 pairs a second, and at 25 mph
// under 2. Anything dropped here is one clack among dozens already ringing.
const TUBE_RATE = 55;
const TUBE_BURST = 18;

const GRAB_K = 55.0;               // grab spring, 1/s^2 per unit of position error
// The grab damping is specified as v *= 0.82 per substep. Expressed as a rate
// so it is identical at any frame rate: 0.82 at h = 1/240 s.
const GRAB_DAMP_K = -Math.log(0.82) * 240;
const GRAB_REACH = 0.6;            // m from the body's own cord anchor

// Deliberately NOT modelled: Karman vortex shedding. For a 28 mm tube at 5 m/s
// the Strouhal frequency is about 38 Hz - far above the 0.9 Hz pendulum modes
// and far below the 330 Hz acoustic modes, so it is resonant with nothing. It
// would cost most of a 240 Hz solver's Nyquist headroom for pure theatre. The
// flutter you see comes from the wind field's turbulence octaves instead.

// ---------------------------------------------------------------------------
// Module-scope scratch. Nothing in the hot path allocates.
// ---------------------------------------------------------------------------

const _wind = new Vector3();
const _q = new Quaternion();
const _qRoll = new Quaternion();
const _up = new Vector3(0, 1, 0);
const _axis = new Vector3();
const _pa = [0, 0, 0];
const _pb = [0, 0, 0];

// Shared empty array for the common case of a frame with no strikes, so the
// loop does not allocate sixty throwaway arrays a second. Callers must not
// push into what drainStrikes returns.
const EMPTY = [];

let _gaussSpare = null;
function gauss() {
  if (_gaussSpare !== null) {
    const g = _gaussSpare;
    _gaussSpare = null;
    return g;
  }
  let u = 0, v = 0, s = 0;
  do {
    u = Math.random() * 2 - 1;
    v = Math.random() * 2 - 1;
    s = u * u + v * v;
  } while (s === 0 || s >= 1);
  const f = Math.sqrt(-2 * Math.log(s) / s);
  _gaussSpare = v * f;
  return u * f;
}

function wrapPi(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// Rotation matrix (given as three orthonormal column vectors) to quaternion.
// Written out rather than routed through Matrix4 so this file stays clear of
// the scene graph entirely.
function quatFromBasis(xx, xy, xz, yx, yy, yz, zx, zy, zz, out) {
  // Columns are x, y, z; m[row][col].
  const m00 = xx, m01 = yx, m02 = zx;
  const m10 = xy, m11 = yy, m12 = zy;
  const m20 = xz, m21 = yz, m22 = zz;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    out[3] = 0.25 / s;
    out[0] = (m21 - m12) * s;
    out[1] = (m02 - m20) * s;
    out[2] = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
    out[3] = (m21 - m12) / s;
    out[0] = 0.25 * s;
    out[1] = (m01 + m10) / s;
    out[2] = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
    out[3] = (m02 - m20) / s;
    out[0] = (m01 + m10) / s;
    out[1] = 0.25 * s;
    out[2] = (m12 + m21) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
    out[3] = (m10 - m01) / s;
    out[0] = (m02 + m20) / s;
    out[1] = (m12 + m21) / s;
    out[2] = 0.25 * s;
  }
  return out;
}

// ---------------------------------------------------------------------------
// createRig
// ---------------------------------------------------------------------------

export function createRig(freqs) {
  // --- particle storage -----------------------------------------------------
  let N = 0;                 // tube count
  let P = 0;                 // particle count = 3 plate + 2N tube + 1 clapper + 2 sail
  let TUBE0 = 3;
  let CLAPPER = 0;
  let SAIL_T = 0;            // sail top particle (the one the cord holds)
  let SAIL_B = 0;            // sail bottom particle

  let pos = new Float64Array(0);
  let prev = new Float64Array(0);
  let vel = new Float64Array(0);
  let vpre = new Float64Array(0);
  let fext = new Float64Array(0);
  let invMass = new Float64Array(0);
  let restPos = new Float64Array(0);

  let links = [];            // solved in a fixed order, every substep
  // The N+5 cords in RigState order: three hook-bridle strands, one per tube,
  // the clapper cord, the sail cord.
  let cordLinks = [];
  let contacts = [];         // one reusable record per tube

  let inContact = null;      // Uint8Array
  let lastClear = null;      // Float64Array, sim time the tube last went free
  let lastStrike = null;     // Float64Array

  let psi = 0;               // sail yaw about its spine, radians
  let psiDot = 0;
  let yawNoise = 0;          // OU torque state

  let pending = [];          // strike queue

  let sailRestX = 0, sailRestY = 1.025, sailRestZ = 0;

  // Sail frame, recomputed by applyAero and read by syncState. Initialised to
  // the rest pose so a paused rig still reports a sane orientation.
  let sailNx = 1, sailNy = 0, sailNz = 0;   // face normal
  let sailSx = 0, sailSy = 1, sailSz = 0;   // spine, bottom to top

  // Grab scratch, allocated once at rig creation. grabParts* are rebuilt in
  // build() because the particle indices move when the tube count changes.
  const _grabAnchor = new Float64Array(3);
  let grabPartsClapper = new Int32Array(1);
  let grabPartsSail = new Int32Array(2);

  const rig = {
    tubes: [],
    state: null,
    contactMask: new Uint8Array(0),
    errors: [],
    simTime: 0,
    strikeCount: 0,
    tubeStrikeCount: 0,
    substepIndex: 0,
    grabbed: null
  };

  const grabTarget = [0, 0, 0];

  function pushError(tag) {
    if (rig.errors.length >= 8) return;
    rig.errors.push(tag);
  }

  // --- constraint helpers ---------------------------------------------------

  function link(ia, ca, ib, cb, rest, alpha, unilateral, staticA) {
    return {
      ia: Int32Array.from(ia), ca: Float64Array.from(ca), na: ia.length,
      ib: Int32Array.from(ib), cb: Float64Array.from(cb), nb: ib.length,
      rest, alpha,
      unilateral: !!unilateral,
      staticA: staticA ? Float64Array.from(staticA) : null,
      taut: false, nx: 0, ny: 0, nz: 0, dist: rest
    };
  }

  function anchorPos(idx, coef, n, out) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < n; k++) {
      const p = idx[k] * 3, c = coef[k];
      x += c * pos[p]; y += c * pos[p + 1]; z += c * pos[p + 2];
    }
    out[0] = x; out[1] = y; out[2] = z;
    return out;
  }

  function anchorInvMass(idx, coef, n) {
    let w = 0;
    for (let k = 0; k < n; k++) {
      const c = coef[k];
      w += c * c * invMass[idx[k]];
    }
    return w;
  }

  // Barycentric weights for a point at ring radius R and plate-local angle
  // theta, on the equilateral triangle of circumradius a. They sum to exactly
  // one; individual weights go above 1 and below 0 for R > a, which is correct
  // - the ring sits outside the triangle and levers it.
  function ringWeights(theta, out) {
    for (let i = 0; i < 3; i++) {
      out[i] = 1 / 3 + (2 / 3) * R_OVER_A * Math.cos(theta - PLATE_THETA[i]);
    }
    return out;
  }

  // Coefficients of the two tube particles for a point at fraction t from the top.
  function tubeCoefs(t, out) {
    const cB = (t - T_A) / T_SPAN;
    out[0] = 1 - cB;
    out[1] = cB;
    return out;
  }

  // --- build ----------------------------------------------------------------

  function build(freqList) {
    let list = Array.isArray(freqList) && freqList.length ? freqList.slice() : SCALES.cMajorPentatonic.slice();
    if (list.length > 8) list = list.slice(0, 8);
    while (list.length < 3) list.push(list[list.length - 1] * 2);

    N = list.length;
    P = 3 + 2 * N + 1 + 2;
    TUBE0 = 3;
    CLAPPER = 3 + 2 * N;
    SAIL_T = CLAPPER + 1;
    SAIL_B = CLAPPER + 2;

    pos = new Float64Array(P * 3);
    prev = new Float64Array(P * 3);
    vel = new Float64Array(P * 3);
    vpre = new Float64Array(P * 3);
    fext = new Float64Array(P * 3);
    invMass = new Float64Array(P);
    restPos = new Float64Array(P * 3);

    grabPartsClapper = Int32Array.of(CLAPPER);
    grabPartsSail = Int32Array.of(SAIL_T, SAIL_B);

    inContact = new Uint8Array(N);
    lastClear = new Float64Array(N).fill(-10);
    lastStrike = new Float64Array(N).fill(-10);
    rig.contactMask = new Uint8Array(N);

    // Ring slot order: evens first, then odds, so ascending pitch is scattered
    // around the circle. The clapper then meets a jagged skyline of lengths
    // rather than sweeping a monotonic ramp, and the melody stops sounding
    // like a scale run.
    const order = [];
    for (let i = 0; i < N; i += 2) order.push(i);
    for (let i = 1; i < N; i += 2) order.push(i);

    rig.tubes.length = 0;
    for (let i = 0; i < N; i++) {
      const f = list[i];
      const L = lengthForFreq(f);
      rig.tubes.push({
        index: i,
        L,
        f1: freqForLength(L),
        ringAngle: Math.PI * 2 * order.indexOf(i) / N,
        radius: TUBE_R,
        mass: TUBE_LINDENS * L,
        // Axial twist DOF.
        roll: 0,
        rollVel: 0,
        // Where this tube's aerodynamic asymmetry points at build time. Spread
        // by the golden angle so no two tubes start aligned: real ones are
        // never in phase, and without it the whole ring twists as one piece.
        markOffset: (i * 2.39996) % TWO_PI
      });
    }

    // Inverse masses.
    const platePer = PLATE_MASS / 3;
    invMass[0] = invMass[1] = invMass[2] = 1 / platePer;
    for (let i = 0; i < N; i++) {
      const half = rig.tubes[i].mass * 0.5;
      invMass[TUBE0 + 2 * i] = 1 / half;
      invMass[TUBE0 + 2 * i + 1] = 1 / half;
    }
    invMass[CLAPPER] = 1 / CLAPPER_MASS;
    invMass[SAIL_T] = invMass[SAIL_B] = 1 / (SAIL_MASS * 0.5);

    // Canonical rest pose: everything plumb.
    for (let i = 0; i < 3; i++) {
      restPos[i * 3] = PLATE_A * Math.cos(PLATE_THETA[i]);
      restPos[i * 3 + 1] = PLATE_Y;
      restPos[i * 3 + 2] = PLATE_A * Math.sin(PLATE_THETA[i]);
    }
    for (let i = 0; i < N; i++) {
      const t = rig.tubes[i];
      const rx = R_RING * Math.cos(t.ringAngle);
      const rz = R_RING * Math.sin(t.ringAngle);
      const topY = PLATE_Y - TUBE_CORD_BASE;
      const a = (TUBE0 + 2 * i) * 3, b = a + 3;
      restPos[a] = rx; restPos[a + 1] = topY - T_A * t.L; restPos[a + 2] = rz;
      restPos[b] = rx; restPos[b + 1] = topY - T_B * t.L; restPos[b + 2] = rz;
    }
    restPos[CLAPPER * 3] = 0;
    restPos[CLAPPER * 3 + 1] = PLATE_Y - CLAPPER_CORD;
    restPos[CLAPPER * 3 + 2] = 0;
    const sailTopY = PLATE_Y - CLAPPER_CORD - SAIL_CORD;
    restPos[SAIL_T * 3] = 0; restPos[SAIL_T * 3 + 1] = sailTopY; restPos[SAIL_T * 3 + 2] = 0;
    restPos[SAIL_B * 3] = 0; restPos[SAIL_B * 3 + 1] = sailTopY - SAIL_H; restPos[SAIL_B * 3 + 2] = 0;
    sailRestX = 0;
    sailRestY = sailTopY - SAIL_H * 0.5;
    sailRestZ = 0;

    buildLinks();
    buildContacts();
    buildState();
  }

  function buildLinks() {
    links = [];
    cordLinks = [];
    const third = [1 / 3, 1 / 3, 1 / 3];
    const plate = [0, 1, 2];
    const w = [0, 0, 0];
    const tc = [0, 0];

    // 1. plate triangle - three rigid edges, keeps the disk a disk.
    links.push(link([0], [1], [1], [1], PLATE_EDGE, 0, false, null));
    links.push(link([1], [1], [2], [1], PLATE_EDGE, 0, false, null));
    links.push(link([2], [1], [0], [1], PLATE_EDGE, 0, false, null));

    // 2. hook bridle - three cords from the static hook to the plate rim. Not
    //    one cord to the centroid: see BRIDLE_CORD. Hook plus rigid triangle is
    //    a tetrahedron, so the plate keeps its attitude and the whole assembly
    //    swings as one, which is what a chime on a bridle actually does.
    for (let i = 0; i < 3; i++) {
      const b = link([i], [1], [i], [1], BRIDLE_CORD, CORD_ALPHA, true, [HOOK_X, HOOK_Y, HOOK_Z]);
      links.push(b);
      cordLinks[i] = b;
    }

    // 3. tube rigid segments.
    for (let i = 0; i < N; i++) {
      links.push(link([TUBE0 + 2 * i], [1], [TUBE0 + 2 * i + 1], [1], T_SPAN * rig.tubes[i].L, 0, false, null));
    }

    // 4. tube cords: plate ring point to the tube's node at 22.42 percent.
    for (let i = 0; i < N; i++) {
      const t = rig.tubes[i];
      ringWeights(t.ringAngle, w);
      tubeCoefs(NODE_T, tc);
      const c = link(
        plate, w,
        [TUBE0 + 2 * i, TUBE0 + 2 * i + 1], tc,
        TUBE_CORD_BASE + NODE_T * t.L, CORD_ALPHA, true, null
      );
      links.push(c);
      cordLinks[3 + i] = c;
    }

    // 5. clapper cord: plate centroid straight down the middle.
    const cc = link(plate, third, [CLAPPER], [1], CLAPPER_CORD, CORD_ALPHA, true, null);
    links.push(cc);
    cordLinks[N + 3] = cc;

    // 6. sail cord: hangs from the CLAPPER, not the plate. That is what makes
    //    the pair a double pendulum, and the out-of-phase mode is why the
    //    chime rings irregularly instead of metronomically. No randomness is
    //    added anywhere to fake that; it falls out of this one attachment.
    const sc = link([CLAPPER], [1], [SAIL_T], [1], SAIL_CORD, CORD_ALPHA, true, null);
    links.push(sc);
    cordLinks[N + 4] = sc;

    // 7. sail spine - rigid.
    links.push(link([SAIL_T], [1], [SAIL_B], [1], SAIL_H, 0, false, null));
  }

  function buildContacts() {
    contacts = [];
    for (let i = 0; i < N; i++) {
      contacts.push({
        hit: false, s: 0, nx: 0, ny: 1, nz: 0,
        vnPre: 0, cA: 0, cB: 0, wT: 0,
        qx: 0, qy: 0, qz: 0
      });
    }
  }

  function buildState() {
    const tubes = [];
    for (let i = 0; i < N; i++) {
      tubes.push({ top: [0, 0, 0], bottom: [0, 0, 0], quat: [0, 0, 0, 1], roll: 0, ring: 0 });
    }
    // N + 5 cords, in the order cordLinks was filled: three bridle strands, N
    // tube cords, the clapper cord, the sail cord. scene.js sizes its line
    // buffer from this array, so the count travels with the state.
    const cords = [];
    for (let i = 0; i < cordLinks.length; i++) {
      cords.push({ a: [0, 0, 0], b: [0, 0, 0], rest: cordLinks[i].rest, slack: 0 });
    }
    rig.state = {
      plate: { pos: [0, 0, 0], quat: [0, 0, 0, 1] },
      tubes,
      clapper: { pos: [0, 0, 0] },
      sail: { pos: [0, 0, 0], quat: [0, 0, 0, 1], leanDeg: 0, offset: [0, 0, 0] },
      cords,
      anchorBelowPlate: [0, 0, 0]
    };
  }

  // --- pose helpers ---------------------------------------------------------

  // Hang every tube plumb below its ring attachment on the CURRENT plate. Used
  // by rebuild so a scale change does not teleport the plate.
  function layoutTubes() {
    const w = [0, 0, 0];
    for (let i = 0; i < N; i++) {
      const t = rig.tubes[i];
      ringWeights(t.ringAngle, w);
      let rx = 0, ry = 0, rz = 0;
      for (let k = 0; k < 3; k++) {
        const p = k * 3;
        rx += w[k] * pos[p]; ry += w[k] * pos[p + 1]; rz += w[k] * pos[p + 2];
      }
      const topY = ry - TUBE_CORD_BASE;
      const a = (TUBE0 + 2 * i) * 3, b = a + 3;
      pos[a] = rx; pos[a + 1] = topY - T_A * t.L; pos[a + 2] = rz;
      pos[b] = rx; pos[b + 1] = topY - T_B * t.L; pos[b + 2] = rz;
      prev[a] = pos[a]; prev[a + 1] = pos[a + 1]; prev[a + 2] = pos[a + 2];
      prev[b] = pos[b]; prev[b + 1] = pos[b + 1]; prev[b + 2] = pos[b + 2];
      vel[a] = vel[a + 1] = vel[a + 2] = 0;
      vel[b] = vel[b + 1] = vel[b + 2] = 0;
    }
  }

  function resetBody(which, index) {
    const put = (p) => {
      const i3 = p * 3;
      pos[i3] = restPos[i3]; pos[i3 + 1] = restPos[i3 + 1]; pos[i3 + 2] = restPos[i3 + 2];
      prev[i3] = pos[i3]; prev[i3 + 1] = pos[i3 + 1]; prev[i3 + 2] = pos[i3 + 2];
      vel[i3] = vel[i3 + 1] = vel[i3 + 2] = 0;
    };
    if (which === 'plate') { put(0); put(1); put(2); }
    else if (which === 'tube') { put(TUBE0 + 2 * index); put(TUBE0 + 2 * index + 1); }
    else if (which === 'clapper') put(CLAPPER);
    else if (which === 'sail') { put(SAIL_T); put(SAIL_B); psi = 0; psiDot = 0; yawNoise = 0; }
  }

  // The rig starts loaded, not plumb: the sail sits 25 degrees downwind of
  // vertical with a little lateral speed, and the clapper is already leaning
  // most of the way across its 34 mm gap. First strike lands inside about a
  // second instead of after a silent settle. Downwind for the default state is
  // +X (dirDeg 270, wind from the west).
  function preload() {
    const sailLean = MathUtils.degToRad(25);
    const clapLean = MathUtils.degToRad(4);   // 0.028 m of the 0.034 m gap, so it does not start touching

    const pcx = (pos[0] + pos[3] + pos[6]) / 3;
    const pcy = (pos[1] + pos[4] + pos[7]) / 3;
    const pcz = (pos[2] + pos[5] + pos[8]) / 3;

    // Swing the clapper cord downwind about the plate centroid.
    pos[CLAPPER * 3] = pcx + CLAPPER_CORD * Math.sin(clapLean);
    pos[CLAPPER * 3 + 1] = pcy - CLAPPER_CORD * Math.cos(clapLean);
    pos[CLAPPER * 3 + 2] = pcz;

    // Then swing the sail about the clapper, keeping the cord exactly taut.
    const kx = pos[CLAPPER * 3], ky = pos[CLAPPER * 3 + 1], kz = pos[CLAPPER * 3 + 2];
    const tx = kx + SAIL_CORD * Math.sin(sailLean);
    const ty = ky - SAIL_CORD * Math.cos(sailLean);
    pos[SAIL_T * 3] = tx; pos[SAIL_T * 3 + 1] = ty; pos[SAIL_T * 3 + 2] = kz;
    pos[SAIL_B * 3] = tx; pos[SAIL_B * 3 + 1] = ty - SAIL_H; pos[SAIL_B * 3 + 2] = kz;

    for (const p of [CLAPPER, SAIL_T, SAIL_B]) {
      const i3 = p * 3;
      prev[i3] = pos[i3]; prev[i3 + 1] = pos[i3 + 1]; prev[i3 + 2] = pos[i3 + 2];
      vel[i3] = 0.15; vel[i3 + 1] = 0; vel[i3 + 2] = 0;
    }
    psi = 0;      // normal already facing +X, so the sail catches the default wind at once
    psiDot = 0;
  }

  // --- forces ---------------------------------------------------------------

  function addForce(p, fx, fy, fz) {
    const i3 = p * 3;
    fext[i3] += fx; fext[i3 + 1] += fy; fext[i3 + 2] += fz;
  }

  function applyAero(h, windFn) {
    fext.fill(0);

    // --- SAIL -------------------------------------------------------------
    // The only part the wind meaningfully pushes. Drag goes as u^2, so
    // doubling the wind quadruples the force: that is why a gust LURCHES the
    // sail rather than nudging it, and it is the single most important number
    // in the whole design. At 12 mph the sail leans about 12 degrees; in a 2x
    // gust it lurches to about 41.
    const st = SAIL_T * 3, sb = SAIL_B * 3;
    const cx = (pos[st] + pos[sb]) * 0.5;
    const cy = (pos[st + 1] + pos[sb + 1]) * 0.5;
    const cz = (pos[st + 2] + pos[sb + 2]) * 0.5;
    const vcx = (vel[st] + vel[sb]) * 0.5;
    const vcy = (vel[st + 1] + vel[sb + 1]) * 0.5;
    const vcz = (vel[st + 2] + vel[sb + 2]) * 0.5;

    // Spine axis, bottom to top.
    let sx = pos[st] - pos[sb], sy = pos[st + 1] - pos[sb + 1], sz = pos[st + 2] - pos[sb + 2];
    let sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (sl < 1e-9) { sx = 0; sy = 1; sz = 0; sl = 1; }
    sx /= sl; sy /= sl; sz /= sl;

    // Sail normal: the yaw direction, projected perpendicular to the spine.
    let nx = Math.cos(psi), ny = 0, nz = Math.sin(psi);
    let dn = nx * sx + ny * sy + nz * sz;
    nx -= sx * dn; ny -= sy * dn; nz -= sz * dn;
    let nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nl < 1e-6) {
      // Spine lying along the yaw direction (the sail is nearly horizontal).
      // Cross with whichever world axis it is least aligned with; any
      // perpendicular will do for one substep.
      const ax = Math.abs(sx), ay = Math.abs(sy), az = Math.abs(sz);
      let rx = 0, ry = 0, rz = 1;
      if (ax <= ay && ax <= az) { rx = 1; ry = 0; rz = 0; }
      else if (ay <= az) { rx = 0; ry = 1; rz = 0; }
      nx = sy * rz - sz * ry;
      ny = sz * rx - sx * rz;
      nz = sx * ry - sy * rx;
      nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    }
    nx /= nl; ny /= nl; nz /= nl;
    sailNx = nx; sailNy = ny; sailNz = nz;
    sailSx = sx; sailSy = sy; sailSz = sz;

    windFn(_wind, cx, cy, cz);
    const ux = _wind.x - vcx, uy = _wind.y - vcy, uz = _wind.z - vcz;
    const un = ux * nx + uy * ny + uz * nz;
    const kN = 0.5 * RHO * SAIL_AREA * CD_SAIL_N * un * Math.abs(un);
    let fx = kN * nx, fy = kN * ny, fz = kN * nz;
    const tx = ux - un * nx, ty = uy - un * ny, tz = uz - un * nz;
    const tm = Math.sqrt(tx * tx + ty * ty + tz * tz);
    const kT = 0.5 * RHO * SAIL_AREA * CD_SAIL_T * tm;
    fx += kT * tx; fy += kT * ty; fz += kT * tz;
    addForce(SAIL_T, fx * 0.5, fy * 0.5, fz * 0.5);
    addForce(SAIL_B, fx * 0.5, fy * 0.5, fz * 0.5);

    // --- SAIL YAW ---------------------------------------------------------
    // A slightly dished sail weathervanes: it is stable with its face to the
    // wind and metastable edge-on. The edge-on state is why the chime
    // sometimes goes quiet for a few seconds in perfectly good wind. That is
    // real, and it is charming; do not damp it out.
    const uh2 = ux * ux + uz * uz;
    if (uh2 > 1e-8) {
      const psiWind = Math.atan2(uz, ux);
      const rel = wrapPi(psi - psiWind);
      const u2 = ux * ux + uy * uy + uz * uz;
      const tRestore = -SAIL_YAW_K * u2 * Math.sin(2 * rel);
      const tDamp = -SAIL_YAW_DAMP * psiDot;
      // Buffeting is an aerodynamic torque, so it scales with dynamic pressure
      // exactly like the restoring torque above. Held at constant variance it
      // was the ONLY term left in dead air -- the restoring torque goes as u^2
      // and had already vanished -- so the calmer it got, the more the noise
      // dominated, and the sail hunted back and forth in perfectly still
      // conditions. Normalised at the default 12 mph so nothing changes there.
      const a = Math.exp(-h / SAIL_YAW_NOISE_TAU);
      const buffet = SAIL_YAW_NOISE_SIGMA * Math.min(u2 / SAIL_YAW_NOISE_U2, 4);
      yawNoise = yawNoise * a + buffet * Math.sqrt(1 - a * a) * gauss();
      psiDot += ((tRestore + tDamp + yawNoise) / SAIL_I) * h;
      psiDot = MathUtils.clamp(psiDot, -40, 40);
      psi = wrapPi(psi + psiDot * h);
    }

    // --- TUBES ------------------------------------------------------------
    // Cylinder crossflow, sampled independently at each of the two particles
    // with half the tube's projected area. Because the two samples sit at
    // different heights they see different wind through the log profile, and
    // the tube gets a real overturning torque with no extra code. Lean at
    // 12 mph is 2.7 degrees for EVERY tube: drag and weight both scale with L,
    // so lean is length-independent. It was 4.6 on the old 28 mm tube - lean
    // goes as diameter over mass per metre, and real chime stock is 59 percent
    // fatter but 2.7 times heavier, so the wind moves it markedly less.
    for (let i = 0; i < N; i++) {
      const L = rig.tubes[i].L;
      const a3 = (TUBE0 + 2 * i) * 3, b3 = a3 + 3;
      let crossflow = 0, cfX = 0, cfZ = 0;
      let axx = pos[b3] - pos[a3], axy = pos[b3 + 1] - pos[a3 + 1], axz = pos[b3 + 2] - pos[a3 + 2];
      const al = Math.sqrt(axx * axx + axy * axy + axz * axz);
      if (al < 1e-9) continue;
      axx /= al; axy /= al; axz /= al;
      const kArea = 0.5 * RHO * CD_TUBE * (TUBE_OD * L * 0.5);
      for (let e = 0; e < 2; e++) {
        const p3 = e === 0 ? a3 : b3;
        windFn(_wind, pos[p3], pos[p3 + 1], pos[p3 + 2]);
        const rx = _wind.x - vel[p3], ry = _wind.y - vel[p3 + 1], rz = _wind.z - vel[p3 + 2];
        const along = rx * axx + ry * axy + rz * axz;
        const px = rx - along * axx, py = ry - along * axy, pz = rz - along * axz;
        const pm = Math.sqrt(px * px + py * py + pz * pz);
        const k = kArea * pm;
        const t3 = e === 0 ? (TUBE0 + 2 * i) : (TUBE0 + 2 * i + 1);
        addForce(t3, k * px, k * py, k * pz);
        if (e === 1) { crossflow = pm; cfX = px; cfZ = pz; }
      }

      // Axial twist. The two particles that carry a tube sit on its centre line,
      // so the solver has no representation of spin and setFromUnitVectors
      // returns a roll-free minimum-arc frame -- left alone, a tube can swing
      // but never turns, which is wrong: a real chime's tubes visibly wind and
      // unwind on their cords, and the brushed highlight running down an
      // extruded tube makes even a slow turn easy to see.
      //
      // What does NOT drive this is vortex shedding. At 12 mph a 28 mm tube
      // sheds at St*U/D, about 38 Hz, and the torsion mode on a cord sits near
      // a third of a hertz -- a hundred times below the forcing, so the response
      // is a fraction of a degree. Modelled that way it is invisible, which is
      // the physically correct answer to the wrong question.
      //
      // What actually turns a tube is that it is not perfectly axisymmetric --
      // the seam, the drilled hang holes, the cut ends -- so its centre of
      // pressure sits a fraction of a millimetre off the axis. That offset makes
      // the crossflow force weathervane the tube until the offset points
      // downwind, and the tube then hunts around that heading as the wind
      // direction wanders. TWIST_ARM is that effective offset, not a hole
      // position: it is what sets the mode frequency, and it is small because
      // the tube is nearly round.
      //
      // Integrated as a scalar DOF, not a rotational body: it reads the solver
      // and feeds nothing back, so it cannot destabilise the rig.
      const t = rig.tubes[i];
      const Izz = t.mass * TUBE_R * TUBE_R;   // thin-walled cylinder about its own axis
      // Crossflow heading in the horizontal plane, and the tube's own reference
      // mark. Both measured the same way, so their difference is the angle of
      // attack the asymmetry sees.
      const cfAngle = Math.atan2(cfZ, cfX);
      const mark = t.roll + t.markOffset;
      const force = 0.5 * RHO * CD_TUBE * (TUBE_OD * L) * crossflow * crossflow;
      const align = -force * TWIST_ARM * Math.sin(mark - cfAngle);
      // Cord torsion is genuinely weak but nonzero, and it is what returns a
      // tube to rest in dead air instead of leaving it parked at a random angle.
      const alpha = (align - TWIST_K * t.roll - TWIST_C * t.rollVel) / Math.max(Izz, 1e-9);
      t.rollVel += alpha * h;
      t.roll += t.rollVel * h;
      if (!Number.isFinite(t.roll) || !Number.isFinite(t.rollVel)) { t.roll = 0; t.rollVel = 0; }
    }

    // --- CLAPPER ----------------------------------------------------------
    // About 0.007 N at 12 mph: five percent of the sail's force. That ratio IS
    // the causal chain. The clapper does not blow into the tubes; it is towed.
    const c3 = CLAPPER * 3;
    windFn(_wind, pos[c3], pos[c3 + 1], pos[c3 + 2]);
    {
      const rx = _wind.x - vel[c3], ry = _wind.y - vel[c3 + 1], rz = _wind.z - vel[c3 + 2];
      const rm = Math.sqrt(rx * rx + ry * ry + rz * rz);
      const k = 0.5 * RHO * CD_CLAPPER * CLAPPER_AREA * rm;
      addForce(CLAPPER, k * rx, k * ry, k * rz);
    }

    // --- TOP PLATE --------------------------------------------------------
    // Edge-on only, and negligible, but it belongs in the model.
    const ppx = (pos[0] + pos[3] + pos[6]) / 3;
    const ppy = (pos[1] + pos[4] + pos[7]) / 3;
    const ppz = (pos[2] + pos[5] + pos[8]) / 3;
    const pvx = (vel[0] + vel[3] + vel[6]) / 3;
    const pvy = (vel[1] + vel[4] + vel[7]) / 3;
    const pvz = (vel[2] + vel[5] + vel[8]) / 3;
    windFn(_wind, ppx, ppy, ppz);
    {
      const rx = _wind.x - pvx, ry = _wind.y - pvy, rz = _wind.z - pvz;
      const rm = Math.sqrt(rx * rx + ry * ry + rz * rz);
      const k = 0.5 * RHO * CD_PLATE * PLATE_DRAG_AREA * rm / 3;
      addForce(0, k * rx, k * ry, k * rz);
      addForce(1, k * rx, k * ry, k * rz);
      addForce(2, k * rx, k * ry, k * rz);
    }
  }

  // --- grab -----------------------------------------------------------------

  function applyGrab(h) {
    if (!rig.grabbed) return;
    // Hoisted: applyGrab runs once per SUBSTEP, up to 24 times a frame, and a
    // drag is the one moment the frame budget is already tightest. Building an
    // anchor array and a body-index array in here churned roughly 2900 short
    // lived arrays a second, plus their for-of iterators, in the middle of the
    // hot path this file's header promises never allocates.
    const anchor = _grabAnchor;
    if (rig.grabbed === 'clapper') {
      anchor[0] = (pos[0] + pos[3] + pos[6]) / 3;
      anchor[1] = (pos[1] + pos[4] + pos[7]) / 3;
      anchor[2] = (pos[2] + pos[5] + pos[8]) / 3;
    } else {
      anchor[0] = pos[CLAPPER * 3];
      anchor[1] = pos[CLAPPER * 3 + 1];
      anchor[2] = pos[CLAPPER * 3 + 2];
    }
    // Clamp the drag target so a wild flick cannot stretch the chime across
    // the screen. Springing rather than teleporting keeps cords, collisions
    // and ringing live while you drag, which is the fun part, and it cannot
    // tunnel the clapper through a tube.
    let dx = grabTarget[0] - anchor[0], dy = grabTarget[1] - anchor[1], dz = grabTarget[2] - anchor[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > GRAB_REACH) {
      const s = GRAB_REACH / d;
      dx *= s; dy *= s; dz *= s;
    }
    const tx = anchor[0] + dx, ty = anchor[1] + dy, tz = anchor[2] + dz;

    const parts = rig.grabbed === 'clapper' ? grabPartsClapper : grabPartsSail;
    const np = parts.length;
    let px = 0, py = 0, pz = 0;
    for (let k = 0; k < np; k++) {
      const p3 = parts[k] * 3;
      px += pos[p3]; py += pos[p3 + 1]; pz += pos[p3 + 2];
    }
    px /= np; py /= np; pz /= np;

    const damp = Math.exp(-GRAB_DAMP_K * h);
    for (let k = 0; k < np; k++) {
      const i3 = parts[k] * 3;
      vel[i3] = (vel[i3] + (tx - px) * GRAB_K * h) * damp;
      vel[i3 + 1] = (vel[i3 + 1] + (ty - py) * GRAB_K * h) * damp;
      vel[i3 + 2] = (vel[i3 + 2] + (tz - pz) * GRAB_K * h) * damp;
    }
  }

  // --- solver ---------------------------------------------------------------

  function solveLink(L, h) {
    L.taut = false;
    if (L.staticA) {
      _pa[0] = L.staticA[0]; _pa[1] = L.staticA[1]; _pa[2] = L.staticA[2];
    } else {
      anchorPos(L.ia, L.ca, L.na, _pa);
    }
    anchorPos(L.ib, L.cb, L.nb, _pb);
    const dx = _pb[0] - _pa[0], dy = _pb[1] - _pa[1], dz = _pb[2] - _pa[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    L.dist = d;
    if (d < 1e-9) return;
    const C = d - L.rest;
    // Unilateral: a cord shorter than its rest length carries no load at all.
    // Skipping it outright is the entire reason cords visibly belly out and
    // then snap taut, which is a wind cue in its own right.
    if (L.unilateral && C <= 0) return;
    L.taut = true;

    const wA = L.staticA ? 0 : anchorInvMass(L.ia, L.ca, L.na);
    const wB = anchorInvMass(L.ib, L.cb, L.nb);
    const wSum = wA + wB;
    if (wSum <= 0) return;

    // XPBD, small-steps style: one Gauss-Seidel iteration per substep with
    // lambda restarted at zero, so dLambda = -C / (sum w + alpha/h^2).
    const at = L.alpha > 0 ? L.alpha / (h * h) : 0;
    const dl = -C / (wSum + at);
    const nx = dx / d, ny = dy / d, nz = dz / d;
    L.nx = nx; L.ny = ny; L.nz = nz;

    if (!L.staticA) {
      for (let k = 0; k < L.na; k++) {
        const p = L.ia[k];
        const s = -L.ca[k] * invMass[p] * dl;
        const i3 = p * 3;
        pos[i3] += s * nx; pos[i3 + 1] += s * ny; pos[i3 + 2] += s * nz;
      }
    }
    for (let k = 0; k < L.nb; k++) {
      const p = L.ib[k];
      const s = L.cb[k] * invMass[p] * dl;
      const i3 = p * 3;
      pos[i3] += s * nx; pos[i3 + 1] += s * ny; pos[i3 + 2] += s * nz;
    }
  }

  // Sphere (clapper) against capsule (tube, spanning t = 0 to t = 1 by
  // extrapolation from the two gyration particles, so the visible tube and the
  // physical tube are literally the same object).
  function solveContacts() {
    const c3 = CLAPPER * 3;
    const wC = invMass[CLAPPER];
    const sumR = CLAPPER_R + TUBE_R;

    for (let i = 0; i < N; i++) {
      const rec = contacts[i];
      rec.hit = false;

      const a3 = (TUBE0 + 2 * i) * 3, b3 = a3 + 3;
      const topx = CA_TOP * pos[a3] + CB_TOP * pos[b3];
      const topy = CA_TOP * pos[a3 + 1] + CB_TOP * pos[b3 + 1];
      const topz = CA_TOP * pos[a3 + 2] + CB_TOP * pos[b3 + 2];
      const botx = CA_BOT * pos[a3] + CB_BOT * pos[b3];
      const boty = CA_BOT * pos[a3 + 1] + CB_BOT * pos[b3 + 1];
      const botz = CA_BOT * pos[a3 + 2] + CB_BOT * pos[b3 + 2];

      const ax = botx - topx, ay = boty - topy, az = botz - topz;
      const len2 = ax * ax + ay * ay + az * az;
      if (len2 < 1e-12) continue;

      // Re-read the clapper each tube: Gauss-Seidel, it moves as we go.
      const cx = pos[c3], cy = pos[c3 + 1], cz = pos[c3 + 2];

      let s = ((cx - topx) * ax + (cy - topy) * ay + (cz - topz) * az) / len2;
      if (s < 0) s = 0; else if (s > 1) s = 1;
      const qx = topx + ax * s, qy = topy + ay * s, qz = topz + az * s;

      let dx = cx - qx, dy = cy - qy, dz = cz - qz;
      let dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist >= sumR) continue;

      let nx, ny, nz;
      if (dist < 1e-6) {
        // Degenerate: clapper centre exactly on the tube axis. Use the radial
        // direction from the axis to the clapper's PREVIOUS position.
        const px = prev[c3] - qx, py = prev[c3 + 1] - qy, pz = prev[c3 + 2] - qz;
        const along = (px * ax + py * ay + pz * az) / len2;
        let rx = px - ax * along, ry = py - ay * along, rz = pz - az * along;
        let rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (rl < 1e-9) { rx = 1; ry = 0; rz = 0; rl = 1; }
        nx = rx / rl; ny = ry / rl; nz = rz / rl;
        dist = 1e-6;
      } else {
        nx = dx / dist; ny = dy / dist; nz = dz / dist;
      }

      const cB = (s - T_A) / T_SPAN;
      const cA = 1 - cB;
      const wA = invMass[TUBE0 + 2 * i], wB = invMass[TUBE0 + 2 * i + 1];
      const wT = cA * cA * wA + cB * cB * wB;
      const wSum = wC + wT;
      if (wSum <= 0) continue;

      // Approach speed measured against the velocities the substep started
      // with. audio.js gets this number as ev.vn and turns it into brightness,
      // so it has to be the real contact speed, not a post-solve residual.
      const vqx = cA * vpre[a3] + cB * vpre[b3];
      const vqy = cA * vpre[a3 + 1] + cB * vpre[b3 + 1];
      const vqz = cA * vpre[a3 + 2] + cB * vpre[b3 + 2];
      const vnPre = (vpre[c3] - vqx) * nx + (vpre[c3 + 1] - vqy) * ny + (vpre[c3 + 2] - vqz) * nz;

      // Position solve, alpha = 0: contacts are hard.
      const C = dist - sumR;                 // negative, penetrating
      const dl = -C / wSum;
      pos[c3] += nx * wC * dl;
      pos[c3 + 1] += ny * wC * dl;
      pos[c3 + 2] += nz * wC * dl;
      const sa = -cA * wA * dl, sb = -cB * wB * dl;
      pos[a3] += nx * sa; pos[a3 + 1] += ny * sa; pos[a3 + 2] += nz * sa;
      pos[b3] += nx * sb; pos[b3 + 1] += ny * sb; pos[b3 + 2] += nz * sb;

      rec.hit = true;
      rec.s = s; rec.nx = nx; rec.ny = ny; rec.nz = nz;
      rec.vnPre = vnPre; rec.cA = cA; rec.cB = cB; rec.wT = wT;
      rec.qx = qx; rec.qy = qy; rec.qz = qz;
    }
  }

  // Closest points between two segments, both parameterised 0..1, written into
  // the module-scope _segS / _segT. Standard clamped-parametric solution; the
  // parallel case falls out as den === 0 and is handled by pinning s = 0 and
  // solving for t.
  let _segS = 0, _segT = 0;
  function closestSegSeg(p1x, p1y, p1z, q1x, q1y, q1z, p2x, p2y, p2z, q2x, q2y, q2z) {
    const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
    const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
    const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
    const a = d1x * d1x + d1y * d1y + d1z * d1z;
    const e = d2x * d2x + d2y * d2y + d2z * d2z;
    const f = d2x * rx + d2y * ry + d2z * rz;
    if (a < 1e-12 || e < 1e-12) { _segS = 0; _segT = 0; return; }
    const b = d1x * d2x + d1y * d2y + d1z * d2z;
    const c = d1x * rx + d1y * ry + d1z * rz;
    const den = a * e - b * b;
    let s = den > 1e-12 ? MathUtils.clamp((b * f - c * e) / den, 0, 1) : 0;
    let t = (b * s + f) / e;
    if (t < 0) { t = 0; s = MathUtils.clamp(-c / a, 0, 1); }
    else if (t > 1) { t = 1; s = MathUtils.clamp((b - c) / a, 0, 1); }
    _segS = s; _segT = t;
  }

  // Tube against tube. Both are capsules spanning the visible tube exactly
  // (t = 0 to t = 1 by extrapolation from the gyration particles), so what is
  // separated is the object you can see rather than an invisible proxy.
  // Tube-vs-tube contact records, one per unordered pair, indexed
  // i * MAX_TUBES + j with i < j. Eight tubes is the slider's maximum, so this
  // is 64 slots of which 28 are ever used -- small enough that indexing
  // arithmetic beats searching a list.
  const MAX_TUBES = 8;
  const pairHit = new Uint8Array(MAX_TUBES * MAX_TUBES);
  const pairIn = new Uint8Array(MAX_TUBES * MAX_TUBES);
  const pairVn = new Float64Array(MAX_TUBES * MAX_TUBES);
  const pairMu = new Float64Array(MAX_TUBES * MAX_TUBES);
  const pairS = new Float64Array(MAX_TUBES * MAX_TUBES);
  const pairT = new Float64Array(MAX_TUBES * MAX_TUBES);
  const pairLast = new Float64Array(MAX_TUBES * MAX_TUBES).fill(-1e9);
  const pairPos = new Float64Array(MAX_TUBES * MAX_TUBES * 3);
  let tubeTokens = TUBE_BURST;

  function solveTubeSeparation(detect) {
    if (detect) pairHit.fill(0);
    for (let i = 0; i < N; i++) {
      const ai = (TUBE0 + 2 * i) * 3, bi = ai + 3;
      const t1x = CA_TOP * pos[ai] + CB_TOP * pos[bi];
      const t1y = CA_TOP * pos[ai + 1] + CB_TOP * pos[bi + 1];
      const t1z = CA_TOP * pos[ai + 2] + CB_TOP * pos[bi + 2];
      const b1x = CA_BOT * pos[ai] + CB_BOT * pos[bi];
      const b1y = CA_BOT * pos[ai + 1] + CB_BOT * pos[bi + 1];
      const b1z = CA_BOT * pos[ai + 2] + CB_BOT * pos[bi + 2];

      for (let j = i + 1; j < N; j++) {
        const aj = (TUBE0 + 2 * j) * 3, bj = aj + 3;
        const t2x = CA_TOP * pos[aj] + CB_TOP * pos[bj];
        const t2y = CA_TOP * pos[aj + 1] + CB_TOP * pos[bj + 1];
        const t2z = CA_TOP * pos[aj + 2] + CB_TOP * pos[bj + 2];
        const b2x = CA_BOT * pos[aj] + CB_BOT * pos[bj];
        const b2y = CA_BOT * pos[aj + 1] + CB_BOT * pos[bj + 1];
        const b2z = CA_BOT * pos[aj + 2] + CB_BOT * pos[bj + 2];

        closestSegSeg(t1x, t1y, t1z, b1x, b1y, b1z, t2x, t2y, t2z, b2x, b2y, b2z);
        const s = _segS, t = _segT;

        const c1x = t1x + (b1x - t1x) * s, c1y = t1y + (b1y - t1y) * s, c1z = t1z + (b1z - t1z) * s;
        const c2x = t2x + (b2x - t2x) * t, c2y = t2y + (b2y - t2y) * t, c2z = t2z + (b2z - t2z) * t;
        let dx = c1x - c2x, dy = c1y - c2y, dz = c1z - c2z;
        let dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist >= TUBE_PAIR_SEP) continue;

        if (dist < 1e-6) {
          // Two axes exactly coincident. Push apart along the horizontal
          // direction between the tubes' own suspension points, which always
          // exists because two tubes never share a ring slot.
          dx = pos[ai] - pos[aj]; dy = 0; dz = pos[ai + 2] - pos[aj + 2];
          dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < 1e-9) { dx = 1; dz = 0; dist = 1; }
          dy = 0;
        }
        const nx = dx / dist, ny = dy / dist, nz = dz / dist;

        const cB1 = (s - T_A) / T_SPAN, cA1 = 1 - cB1;
        const cB2 = (t - T_A) / T_SPAN, cA2 = 1 - cB2;
        const wA1 = invMass[TUBE0 + 2 * i], wB1 = invMass[TUBE0 + 2 * i + 1];
        const wA2 = invMass[TUBE0 + 2 * j], wB2 = invMass[TUBE0 + 2 * j + 1];
        const w1 = cA1 * cA1 * wA1 + cB1 * cB1 * wB1;
        const w2 = cA2 * cA2 * wA2 + cB2 * cB2 * wB2;
        const wSum = w1 + w2;
        if (wSum <= 0) continue;

        if (detect && i < MAX_TUBES && j < MAX_TUBES) {
          // Closing speed along the contact normal, taken from the velocity the
          // substep STARTED with, exactly as the clapper contact does. Reading
          // it after the position solve would measure the solver's own
          // correction rather than the collision.
          const vA1x = cA1 * vpre[ai] + cB1 * vpre[bi];
          const vA1y = cA1 * vpre[ai + 1] + cB1 * vpre[bi + 1];
          const vA1z = cA1 * vpre[ai + 2] + cB1 * vpre[bi + 2];
          const vA2x = cA2 * vpre[aj] + cB2 * vpre[bj];
          const vA2y = cA2 * vpre[aj + 1] + cB2 * vpre[bj + 1];
          const vA2z = cA2 * vpre[aj + 2] + cB2 * vpre[bj + 2];
          const k = i * MAX_TUBES + j;
          pairHit[k] = 1;
          pairVn[k] = (vA1x - vA2x) * nx + (vA1y - vA2y) * ny + (vA1z - vA2z) * nz;
          pairMu[k] = 1 / wSum;
          pairS[k] = s;
          pairT[k] = t;
          pairPos[k * 3] = (c1x + c2x) * 0.5;
          pairPos[k * 3 + 1] = (c1y + c2y) * 0.5;
          pairPos[k * 3 + 2] = (c1z + c2z) * 0.5;
        }

        const dl = (TUBE_PAIR_SEP - dist) / wSum;
        const s1a = cA1 * wA1 * dl, s1b = cB1 * wB1 * dl;
        pos[ai] += nx * s1a; pos[ai + 1] += ny * s1a; pos[ai + 2] += nz * s1a;
        pos[bi] += nx * s1b; pos[bi + 1] += ny * s1b; pos[bi + 2] += nz * s1b;
        const s2a = -cA2 * wA2 * dl, s2b = -cB2 * wB2 * dl;
        pos[aj] += nx * s2a; pos[aj + 1] += ny * s2a; pos[aj + 2] += nz * s2a;
        pos[bj] += nx * s2b; pos[bj + 1] += ny * s2b; pos[bj + 2] += nz * s2b;
      }
    }
  }

  // --- porch collision -------------------------------------------------------

  // Ceiling height above a point, or +Infinity in open air. Written as a
  // downward-only limit rather than as full box collision on purpose: a body
  // that gets ABOVE a thin slab and is then pushed out by the nearest face
  // stays above it, and at 60 mph that is precisely what happened - the top
  // plate flipped over the beam and hung there inverted for the rest of the
  // run. A ceiling has no such state. Nothing here can lift the rig, only stop
  // it, so the aerodynamics are untouched.
  function porchCeiling(px, pz) {
    if (Math.abs(px) <= 1.35 && Math.abs(pz) <= 0.075) return 2.58;   // under the beam
    if (Math.abs(px) <= 1.55 && Math.abs(pz) <= 0.73) return 2.73;    // under the roof slab
    return Infinity;
  }

  // Apply a ceiling correction to a point defined by up to two particles and
  // their coefficients, exactly the way the cord and contact solvers do, so a
  // tube end that fetches up against the beam rotates the tube rather than
  // translating it bodily.
  function porchPoint(px, py, pz, r, ia, ca, ib, cb) {
    const lim = porchCeiling(px, pz) - r;
    if (py <= lim) return;
    const wA = invMass[ia] * ca * ca;
    const wB = ib >= 0 ? invMass[ib] * cb * cb : 0;
    const wSum = wA + wB;
    if (wSum <= 0) return;
    const dy = lim - py;                       // negative: push down
    const kA = ca * invMass[ia] / wSum;
    pos[ia * 3 + 1] += dy * kA;
    if (ib >= 0) pos[ib * 3 + 1] += dy * (cb * invMass[ib] / wSum);
  }

  function solvePorch() {
    for (let i = 0; i < 3; i++) {
      const i3 = i * 3;
      porchPoint(pos[i3], pos[i3 + 1], pos[i3 + 2], PLATE_HIT_R, i, 1, -1, 0);
    }
    for (let i = 0; i < N; i++) {
      const a = TUBE0 + 2 * i, b = a + 1;
      const a3 = a * 3, b3 = b * 3;
      // Both visible ends, extrapolated from the gyration particles.
      porchPoint(
        CA_TOP * pos[a3] + CB_TOP * pos[b3],
        CA_TOP * pos[a3 + 1] + CB_TOP * pos[b3 + 1],
        CA_TOP * pos[a3 + 2] + CB_TOP * pos[b3 + 2],
        TUBE_HIT_R, a, CA_TOP, b, CB_TOP
      );
      porchPoint(
        CA_BOT * pos[a3] + CB_BOT * pos[b3],
        CA_BOT * pos[a3 + 1] + CB_BOT * pos[b3 + 1],
        CA_BOT * pos[a3 + 2] + CB_BOT * pos[b3 + 2],
        TUBE_HIT_R, a, CA_BOT, b, CB_BOT
      );
    }
    const c3 = CLAPPER * 3;
    porchPoint(pos[c3], pos[c3 + 1], pos[c3 + 2], CLAPPER_HIT_R, CLAPPER, 1, -1, 0);
    const s3 = SAIL_T * 3, sb3 = SAIL_B * 3;
    porchPoint(pos[s3], pos[s3 + 1], pos[s3 + 2], SAIL_HIT_R, SAIL_T, 1, -1, 0);
    porchPoint(pos[sb3], pos[sb3 + 1], pos[sb3 + 2], SAIL_HIT_R, SAIL_B, 1, -1, 0);
  }

  function solveConstraints(h) {
    for (let i = 0; i < links.length; i++) solveLink(links[i], h);
    solveTubeSeparation(true);
    solvePorch();
    solveContacts();
    // Separation runs a second time, last. One Gauss-Seidel pass is enough at
    // any sane wind, but in a 60 mph gale the cord solve at the top of the next
    // sweep partly undoes it and the worst-case overlap crept from 0 to 13 mm
    // on a 28 mm tube. Ending the substep on separation costs 28 segment tests
    // and leaves nothing visibly interpenetrating.
    solveTubeSeparation(false);
  }

  // --- velocity pass --------------------------------------------------------

  function velocityPass(h) {
    const c3 = CLAPPER * 3;
    const wC = invMass[CLAPPER];

    // Contacts: restitution then Coulomb friction. Without friction the
    // clapper slides frictionlessly around the ring and never bites.
    for (let i = 0; i < N; i++) {
      const rec = contacts[i];
      if (!rec.hit) continue;
      const a3 = (TUBE0 + 2 * i) * 3, b3 = a3 + 3;
      const wA = invMass[TUBE0 + 2 * i], wB = invMass[TUBE0 + 2 * i + 1];
      const wSum = wC + rec.wT;
      if (wSum <= 0) continue;
      const nx = rec.nx, ny = rec.ny, nz = rec.nz;
      const cA = rec.cA, cB = rec.cB;

      let vqx = cA * vel[a3] + cB * vel[b3];
      let vqy = cA * vel[a3 + 1] + cB * vel[b3 + 1];
      let vqz = cA * vel[a3 + 2] + cB * vel[b3 + 2];
      let rx = vel[c3] - vqx, ry = vel[c3 + 1] - vqy, rz = vel[c3 + 2] - vqz;
      const vnPost = rx * nx + ry * ny + rz * nz;

      // A clapper resting on a tube in steady wind approaches at less than the
      // gravity increment of one substep. Bouncing that at e = 0.45 makes it
      // buzz at the substep rate. The cutoff is not optional.
      const e = Math.abs(rec.vnPre) < 2 * 9.81 * h ? 0 : RESTITUTION;
      const target = Math.max(-e * rec.vnPre, 0);
      const dvn = -vnPost + target;
      let jn = 0;
      if (dvn > 0) {
        jn = dvn / wSum;
        vel[c3] += nx * jn * wC; vel[c3 + 1] += ny * jn * wC; vel[c3 + 2] += nz * jn * wC;
        const ja = -cA * wA * jn, jb = -cB * wB * jn;
        vel[a3] += nx * ja; vel[a3 + 1] += ny * ja; vel[a3 + 2] += nz * ja;
        vel[b3] += nx * jb; vel[b3 + 1] += ny * jb; vel[b3 + 2] += nz * jb;
      }

      if (jn > 0) {
        vqx = cA * vel[a3] + cB * vel[b3];
        vqy = cA * vel[a3 + 1] + cB * vel[b3 + 1];
        vqz = cA * vel[a3 + 2] + cB * vel[b3 + 2];
        rx = vel[c3] - vqx; ry = vel[c3 + 1] - vqy; rz = vel[c3 + 2] - vqz;
        const vn2 = rx * nx + ry * ny + rz * nz;
        let tx = rx - nx * vn2, ty = ry - ny * vn2, tz = rz - nz * vn2;
        const tm = Math.sqrt(tx * tx + ty * ty + tz * tz);
        if (tm > 1e-6) {
          tx /= tm; ty /= tm; tz /= tm;
          const jt = Math.min(tm / wSum, MU_K * jn);
          vel[c3] -= tx * jt * wC; vel[c3 + 1] -= ty * jt * wC; vel[c3 + 2] -= tz * jt * wC;
          const ja = cA * wA * jt, jb = cB * wB * jt;
          vel[a3] += tx * ja; vel[a3 + 1] += ty * ja; vel[a3 + 2] += tz * ja;
          vel[b3] += tx * jb; vel[b3 + 1] += ty * jb; vel[b3 + 2] += tz * jb;
        }
      }
    }

    // Cord axial damping. Only along the cord, so the pendulum swing (which is
    // transverse) is untouched; this just stops taut cords ringing like springs.
    const cordDamp = 1 - Math.exp(-CORD_AXIAL_DAMP * h);
    for (let c = 0; c < cordLinks.length; c++) {
      const L = cordLinks[c];
      if (!L.taut) continue;
      const nx = L.nx, ny = L.ny, nz = L.nz;
      let vax = 0, vay = 0, vaz = 0, wA = 0;
      if (!L.staticA) {
        for (let k = 0; k < L.na; k++) {
          const p = L.ia[k] * 3, co = L.ca[k];
          vax += co * vel[p]; vay += co * vel[p + 1]; vaz += co * vel[p + 2];
        }
        wA = anchorInvMass(L.ia, L.ca, L.na);
      }
      let vbx = 0, vby = 0, vbz = 0;
      for (let k = 0; k < L.nb; k++) {
        const p = L.ib[k] * 3, co = L.cb[k];
        vbx += co * vel[p]; vby += co * vel[p + 1]; vbz += co * vel[p + 2];
      }
      const wB = anchorInvMass(L.ib, L.cb, L.nb);
      const wSum = wA + wB;
      if (wSum <= 0) continue;
      const vn = (vbx - vax) * nx + (vby - vay) * ny + (vbz - vaz) * nz;
      const j = (-vn * cordDamp) / wSum;
      if (!L.staticA) {
        for (let k = 0; k < L.na; k++) {
          const p = L.ia[k], i3 = p * 3, s = -L.ca[k] * invMass[p] * j;
          vel[i3] += nx * s; vel[i3 + 1] += ny * s; vel[i3 + 2] += nz * s;
        }
      }
      for (let k = 0; k < L.nb; k++) {
        const p = L.ib[k], i3 = p * 3, s = L.cb[k] * invMass[p] * j;
        vel[i3] += nx * s; vel[i3 + 1] += ny * s; vel[i3 + 2] += nz * s;
      }
    }

    // Speed clamp, a backstop only. Anything hitting this is already wrong.
    for (let p = 0; p < P; p++) {
      const i3 = p * 3;
      const vx = vel[i3], vy = vel[i3 + 1], vz = vel[i3 + 2];
      const sp2 = vx * vx + vy * vy + vz * vz;
      if (sp2 > MAX_SPEED * MAX_SPEED) {
        const k = MAX_SPEED / Math.sqrt(sp2);
        vel[i3] = vx * k; vel[i3 + 1] = vy * k; vel[i3 + 2] = vz * k;
      }
    }
  }

  // --- strikes --------------------------------------------------------------

  // Tube against tube. In a stiff wind this is most of what a real chime is
  // doing: the clapper starts it, and then the tubes clatter against each other
  // and against nothing else. Both tubes ring, so one contact emits two events.
  function extractTubeStrikes(h) {
    tubeTokens = Math.min(TUBE_BURST, tubeTokens + TUBE_RATE * h);
    for (let i = 0; i < N && i < MAX_TUBES; i++) {
      for (let j = i + 1; j < N && j < MAX_TUBES; j++) {
        const k = i * MAX_TUBES + j;
        const on = pairHit[k];
        if (!on) { pairIn[k] = 0; continue; }
        if (pairIn[k]) continue;         // still the same contact
        pairIn[k] = 1;

        // Closing only, and hard enough to be a clack rather than a graze.
        const vn = -pairVn[k];
        if (vn < MIN_TUBE_VN) continue;
        if (rig.simTime - pairLast[k] < TUBE_REFRACTORY) continue;
        if (tubeTokens < 1) continue;
        tubeTokens -= 1;
        pairLast[k] = rig.simTime;

        const J = (1 + TUBE_RESTITUTION) * vn * pairMu[k];
        const px = pairPos[k * 3], py = pairPos[k * 3 + 1], pz = pairPos[k * 3 + 2];
        const both = [[i, pairS[k]], [j, pairT[k]]];
        for (let e = 0; e < 2; e++) {
          const idx = both[e][0];
          const t = rig.tubes[idx];
          pending.push({
            tube: idx,
            freq: t.f1,
            L: t.L,
            s: MathUtils.clamp(both[e][1], 0.02, 0.98),
            J,
            vn,
            mu: pairMu[k],
            // Metal on metal, not wood on metal. audio.js reads this to stiffen
            // the contact, which is what makes it a clack rather than a bong.
            kind: 'tube',
            substep: rig.substepIndex | 0,
            t: rig.simTime,
            pos: [px, py, pz]
          });
        }
        rig.strikeCount++;
        rig.tubeStrikeCount++;
      }
    }
  }

  function extractStrikes() {
    for (let i = 0; i < N; i++) {
      const rec = contacts[i];
      if (rec.hit) {
        if (!inContact[i]) {
          // Rising edge. Four independent gates, all of them earning their keep:
          // the 40 ms clear-hysteresis kills contacts that flicker by a tenth
          // of a millimetre; the 90 ms refractory is musical, because a tube
          // rattled faster than about 11 Hz is heard as one buzzing note.
          const vn = Math.abs(rec.vnPre);
          if (rig.simTime - lastClear[i] >= CLEAR_HYSTERESIS &&
              rig.simTime - lastStrike[i] >= REFRACTORY &&
              vn >= MIN_STRIKE_VN) {
            // Reduced mass of the clapper against the tube at the struck
            // point, and the standard impulse for a collision with
            // restitution: J = (1 + e) * |v_rel| * mu. mu comes out at about
            // 0.030 kg across the set.
            const mu = 1 / (invMass[CLAPPER] + rec.wT);
            const J = (1 + RESTITUTION) * vn * mu;
            const t = rig.tubes[i];
            pending.push({
              tube: i,
              freq: t.f1,
              L: t.L,
              s: MathUtils.clamp(rec.s, 0.02, 0.98),
              J,
              vn,
              // The reduced mass at contact. Audio needs it separately from J
              // because the hammer's weight is now user-adjustable: J alone
              // cannot tell a hard strike from a heavy hammer, and normalising
              // loudness against a fixed impulse made a heavy hammer clip.
              mu,
              substep: rig.substepIndex | 0,
              t: rig.simTime,
              pos: [
                rec.qx + rec.nx * TUBE_R,
                rec.qy + rec.ny * TUBE_R,
                rec.qz + rec.nz * TUBE_R
              ]
            });
            lastStrike[i] = rig.simTime;
            rig.strikeCount++;
          }
          inContact[i] = 1;
        }
      } else if (inContact[i]) {
        inContact[i] = 0;
        lastClear[i] = rig.simTime;
      }
      rig.contactMask[i] = inContact[i];
    }
  }

  // --- NaN guard ------------------------------------------------------------

  function finite3(i3) {
    return Number.isFinite(pos[i3]) && Number.isFinite(pos[i3 + 1]) && Number.isFinite(pos[i3 + 2]) &&
           Number.isFinite(vel[i3]) && Number.isFinite(vel[i3 + 1]) && Number.isFinite(vel[i3 + 2]);
  }

  // Repair per body rather than nuking the whole rig: a single tube going bad
  // should not silently restart the chime. Only a bad plate (which everything
  // hangs from) or widespread damage triggers a full reset.
  function nanGuard() {
    let bad = 0;
    let plateBad = false;
    for (let k = 0; k < 3; k++) if (!finite3(k * 3)) plateBad = true;
    if (plateBad) {
      reset();
      pushError('reset-nonfinite');
      return;
    }
    for (let i = 0; i < N; i++) {
      if (!finite3((TUBE0 + 2 * i) * 3) || !finite3((TUBE0 + 2 * i + 1) * 3)) {
        resetBody('tube', i);
        inContact[i] = 0;
        lastClear[i] = rig.simTime;
        bad++;
      }
    }
    if (!finite3(CLAPPER * 3)) { resetBody('clapper', 0); bad++; }
    if (!finite3(SAIL_T * 3) || !finite3(SAIL_B * 3) || !Number.isFinite(psi) || !Number.isFinite(psiDot)) {
      resetBody('sail', 0);
      bad++;
    }
    if (bad === 0) return;
    pushError('reset-nonfinite');
    if (bad > 2) reset();
  }

  // --- one substep ----------------------------------------------------------

  function step(h, windFn, params) {
    if (!Number.isFinite(h) || h <= 0) return;
    void params;   // reserved: the rig needs nothing from params today
    rig.simTime += h;

    applyAero(h, windFn);
    applyGrab(h);

    // 1. integrate
    const gd = Math.exp(-GLOBAL_DAMP * h);
    for (let p = 0; p < P; p++) {
      const w = invMass[p];
      const i3 = p * 3;
      if (w === 0) {
        prev[i3] = pos[i3]; prev[i3 + 1] = pos[i3 + 1]; prev[i3 + 2] = pos[i3 + 2];
        continue;
      }
      vel[i3] = (vel[i3] + fext[i3] * w * h) * gd;
      vel[i3 + 1] = (vel[i3 + 1] + (GRAV + fext[i3 + 1] * w) * h) * gd;
      vel[i3 + 2] = (vel[i3 + 2] + fext[i3 + 2] * w * h) * gd;
      vpre[i3] = vel[i3]; vpre[i3 + 1] = vel[i3 + 1]; vpre[i3 + 2] = vel[i3 + 2];
      prev[i3] = pos[i3]; prev[i3 + 1] = pos[i3 + 1]; prev[i3 + 2] = pos[i3 + 2];
      pos[i3] += vel[i3] * h;
      pos[i3 + 1] += vel[i3 + 1] * h;
      pos[i3 + 2] += vel[i3 + 2] * h;
    }

    // 2. one Gauss-Seidel sweep, fixed order, contacts last so penetration is
    //    fully resolved by the end of the substep.
    solveConstraints(h);

    // 3. velocities from the corrected positions
    const inv = 1 / h;
    for (let p = 0; p < P; p++) {
      if (invMass[p] === 0) continue;
      const i3 = p * 3;
      vel[i3] = (pos[i3] - prev[i3]) * inv;
      vel[i3 + 1] = (pos[i3 + 1] - prev[i3 + 1]) * inv;
      vel[i3 + 2] = (pos[i3 + 2] - prev[i3 + 2]) * inv;
    }

    // 4. restitution, friction, cord axial damping
    velocityPass(h);

    extractStrikes();
    extractTubeStrikes(h);
    nanGuard();
  }

  // --- state sync -----------------------------------------------------------

  const _qtmp = [0, 0, 0, 1];

  function syncState() {
    const st = rig.state;

    // Plate: centroid plus an orthonormal frame built from the triangle.
    const pcx = (pos[0] + pos[3] + pos[6]) / 3;
    const pcy = (pos[1] + pos[4] + pos[7]) / 3;
    const pcz = (pos[2] + pos[5] + pos[8]) / 3;
    st.plate.pos[0] = pcx; st.plate.pos[1] = pcy; st.plate.pos[2] = pcz;

    // Face normal. cross(p2 - p0, p1 - p0) points +Y at the rest pose.
    const e1x = pos[6] - pos[0], e1y = pos[7] - pos[1], e1z = pos[8] - pos[2];
    const e2x = pos[3] - pos[0], e2y = pos[4] - pos[1], e2z = pos[5] - pos[2];
    let ny = e1z * e2x - e1x * e2z;
    let nx = e1y * e2z - e1z * e2y;
    let nz = e1x * e2y - e1y * e2x;
    let nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nl < 1e-9) { nx = 0; ny = 1; nz = 0; nl = 1; }
    nx /= nl; ny /= nl; nz /= nl;
    // Reference direction: toward plate particle 0, which sits on +Z at rest.
    let zx = pos[0] - pcx, zy = pos[1] - pcy, zz = pos[2] - pcz;
    const dz = zx * nx + zy * ny + zz * nz;
    zx -= nx * dz; zy -= ny * dz; zz -= nz * dz;
    let zl = Math.sqrt(zx * zx + zy * zy + zz * zz);
    if (zl < 1e-9) { zx = 0; zy = 0; zz = 1; zl = 1; }
    zx /= zl; zy /= zl; zz /= zl;
    const xx = ny * zz - nz * zy;
    const xy = nz * zx - nx * zz;
    const xz = nx * zy - ny * zx;
    quatFromBasis(xx, xy, xz, nx, ny, nz, zx, zy, zz, _qtmp);
    st.plate.quat[0] = _qtmp[0]; st.plate.quat[1] = _qtmp[1];
    st.plate.quat[2] = _qtmp[2]; st.plate.quat[3] = _qtmp[3];

    // The telltale ribbon ties here, 35 mm under the plate and swinging with it.
    st.anchorBelowPlate[0] = pcx - nx * 0.035;
    st.anchorBelowPlate[1] = pcy - ny * 0.035;
    st.anchorBelowPlate[2] = pcz - nz * 0.035;

    // Tubes. NOTE: state.tubes[i].ring is owned by scene.js (flashTube sets it,
    // its syncRig decays it). Do not write it here or every flash is erased on
    // the frame it is set.
    for (let i = 0; i < N; i++) {
      const a3 = (TUBE0 + 2 * i) * 3, b3 = a3 + 3;
      const e = st.tubes[i];
      const tx = CA_TOP * pos[a3] + CB_TOP * pos[b3];
      const ty = CA_TOP * pos[a3 + 1] + CB_TOP * pos[b3 + 1];
      const tz = CA_TOP * pos[a3 + 2] + CB_TOP * pos[b3 + 2];
      const bx = CA_BOT * pos[a3] + CB_BOT * pos[b3];
      const by = CA_BOT * pos[a3 + 1] + CB_BOT * pos[b3 + 1];
      const bz = CA_BOT * pos[a3 + 2] + CB_BOT * pos[b3 + 2];
      e.top[0] = tx; e.top[1] = ty; e.top[2] = tz;
      e.bottom[0] = bx; e.bottom[1] = by; e.bottom[2] = bz;
      _axis.set(tx - bx, ty - by, tz - bz);
      if (_axis.lengthSq() < 1e-12) _axis.set(0, 1, 0); else _axis.normalize();
      _q.setFromUnitVectors(_up, _axis);
      // setFromUnitVectors is the minimum-arc rotation and so carries no roll.
      // Post-multiply the tube's own twist about its axis, which in the tube's
      // local frame is +Y. Post- and not pre-multiply: the twist happens in the
      // tube's frame, after it has been swung into place.
      _qRoll.setFromAxisAngle(_up, rig.tubes[i].roll);
      _q.multiply(_qRoll);
      e.roll = rig.tubes[i].roll;
      e.quat[0] = _q.x; e.quat[1] = _q.y; e.quat[2] = _q.z; e.quat[3] = _q.w;
    }

    // Clapper.
    const c3 = CLAPPER * 3;
    st.clapper.pos[0] = pos[c3]; st.clapper.pos[1] = pos[c3 + 1]; st.clapper.pos[2] = pos[c3 + 2];

    // Sail: centroid, orientation, lean of its cord, offset from still-air rest.
    const s3 = SAIL_T * 3, sb3 = SAIL_B * 3;
    const scx = (pos[s3] + pos[sb3]) * 0.5;
    const scy = (pos[s3 + 1] + pos[sb3 + 1]) * 0.5;
    const scz = (pos[s3 + 2] + pos[sb3 + 2]) * 0.5;
    st.sail.pos[0] = scx; st.sail.pos[1] = scy; st.sail.pos[2] = scz;
    st.sail.offset[0] = scx - sailRestX;
    st.sail.offset[1] = scy - sailRestY;
    st.sail.offset[2] = scz - sailRestZ;
    // Local Y along the spine, local Z along the sail normal, local X = width.
    const bx2 = sailSy * sailNz - sailSz * sailNy;
    const by2 = sailSz * sailNx - sailSx * sailNz;
    const bz2 = sailSx * sailNy - sailSy * sailNx;
    quatFromBasis(bx2, by2, bz2, sailSx, sailSy, sailSz, sailNx, sailNy, sailNz, _qtmp);
    st.sail.quat[0] = _qtmp[0]; st.sail.quat[1] = _qtmp[1];
    st.sail.quat[2] = _qtmp[2]; st.sail.quat[3] = _qtmp[3];
    // leanDeg is the CLAPPER->SAIL cord's angle from vertical, per the shared
    // type. Note which pendulum that is: this cord carries the sail alone
    // (0.314 N), so at 12 mph a 0.144 N sail force tips it about 23 degrees.
    // The often-quoted "the sail leans about 12 degrees at 12 mph" is the
    // PLATE->CLAPPER cord, which carries clapper plus sail (0.657 N) and does
    // read about 12 here. Both angles are correct and they are different
    // members of the same double pendulum; do not retune the aerodynamics to
    // make this one read 12, because the sail force itself already matches
    // (0.1439 N measured against 0.145 N predicted).
    {
      const dx = pos[s3] - pos[c3], dy = pos[s3 + 1] - pos[c3 + 1], dz2 = pos[s3 + 2] - pos[c3 + 2];
      const dl = Math.sqrt(dx * dx + dy * dy + dz2 * dz2);
      st.sail.leanDeg = dl < 1e-9 ? 0 : MathUtils.radToDeg(Math.acos(MathUtils.clamp(-dy / dl, -1, 1)));
    }

    // Cords, in the fixed RigState order. slack drives the sag scene.js draws.
    for (let c = 0; c < cordLinks.length; c++) {
      const L = cordLinks[c];
      const e = st.cords[c];
      if (L.staticA) {
        e.a[0] = L.staticA[0]; e.a[1] = L.staticA[1]; e.a[2] = L.staticA[2];
      } else {
        anchorPos(L.ia, L.ca, L.na, _pa);
        e.a[0] = _pa[0]; e.a[1] = _pa[1]; e.a[2] = _pa[2];
      }
      anchorPos(L.ib, L.cb, L.nb, _pb);
      e.b[0] = _pb[0]; e.b[1] = _pb[1]; e.b[2] = _pb[2];
      const dx = _pb[0] - e.a[0], dy = _pb[1] - e.a[1], dz2 = _pb[2] - e.a[2];
      const d = Math.sqrt(dx * dx + dy * dy + dz2 * dz2);
      e.rest = L.rest;
      e.slack = MathUtils.clamp(1 - d / L.rest, 0, 1);
    }
  }

  // --- public surface -------------------------------------------------------

  function reset() {
    pos.set(restPos);
    prev.set(restPos);
    vel.fill(0);
    vpre.fill(0);
    fext.fill(0);
    psi = 0; psiDot = 0; yawNoise = 0;
    for (let i = 0; i < N; i++) {
      inContact[i] = 0;
      rig.contactMask[i] = 0;
      lastClear[i] = rig.simTime;
      lastStrike[i] = rig.simTime - REFRACTORY;
      contacts[i].hit = false;
    }
    pending.length = 0;
    rig.grabbed = null;
    syncState();
  }

  function rebuild(newFreqs) {
    // Keep the plate, clapper and sail exactly where they are so a scale
    // change does not teleport the chime; the tubes are the only thing that
    // changes length, and they re-hang plumb under the current plate.
    const keep = [];
    for (const p of [0, 1, 2, CLAPPER, SAIL_T, SAIL_B]) {
      const i3 = p * 3;
      keep.push([pos[i3], pos[i3 + 1], pos[i3 + 2], vel[i3], vel[i3 + 1], vel[i3 + 2]]);
    }
    const keptPsi = psi, keptPsiDot = psiDot;

    build(newFreqs);

    const slots = [0, 1, 2, CLAPPER, SAIL_T, SAIL_B];
    for (let k = 0; k < slots.length; k++) {
      const i3 = slots[k] * 3, s = keep[k];
      pos[i3] = s[0]; pos[i3 + 1] = s[1]; pos[i3 + 2] = s[2];
      prev[i3] = s[0]; prev[i3 + 1] = s[1]; prev[i3 + 2] = s[2];
      vel[i3] = s[3]; vel[i3 + 1] = s[4]; vel[i3 + 2] = s[5];
    }
    psi = keptPsi; psiDot = keptPsiDot;

    layoutTubes();
    for (let i = 0; i < N; i++) {
      inContact[i] = 0;
      rig.contactMask[i] = 0;
      lastClear[i] = rig.simTime;
      lastStrike[i] = rig.simTime - REFRACTORY;
    }
    pending.length = 0;
    syncState();
  }

  function drainStrikes() {
    if (pending.length === 0) return EMPTY;
    const out = pending;
    pending = [];
    return out;
  }

  function grab(name, x, y, z) {
    if (name !== 'sail' && name !== 'clapper') return;
    rig.grabbed = name;
    grabTarget[0] = x; grabTarget[1] = y; grabTarget[2] = z;
  }

  function moveGrab(x, y, z) {
    if (!rig.grabbed) return;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    grabTarget[0] = x; grabTarget[1] = y; grabTarget[2] = z;
  }

  function release() {
    rig.grabbed = null;
  }

  build(freqs);
  reset();
  preload();
  syncState();

  rig.step = step;
  rig.syncState = syncState;
  rig.drainStrikes = drainStrikes;
  rig.rebuild = rebuild;
  rig.reset = reset;
  rig.grab = grab;
  rig.moveGrab = moveGrab;
  rig.release = release;

  return rig;
}

