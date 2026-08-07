// windviz.js - everything that makes the wind visible.
//
// Four redundant channels, all fed by the SAME wind field the sail is fed by:
//
//   grass    a bend wave that travels across the meadow, driven by wind.js's
//            flow texture in the vertex shader (GPU side of the field)
//   streaks  airborne motes advected by wind.sample() on the CPU, stretched
//            along their own velocity, and INVISIBLE below a speed threshold
//   leaves   heavier matter with real lighting, injected in bursts when a gust
//            front arrives, tumbling about the wind axis
//   ribbon   a verlet telltale tied under the top plate - the single clearest
//            direction cue, and the only saturated colour in the frame
//
// Nothing here re-derives the wind. Every motion traces back to opts.wind, so a
// gust physically crosses the scene and hits the far streaks, then the grass,
// then the shrubs, then the ribbon, then the sail, in that order, for free.

import * as THREE from 'three';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;
// Half-width of a streamer ribbon, metres. At the storybook frame height this is
// about five pixels: a drawn line, not a solid shape.
const TRAIL_WIDTH = 0.009;
// Streamers live in a much tighter box than the motes did. The old field could
// spawn anywhere in 16 x 16 m because there were hundreds of them and only the
// ones near the camera mattered; with two or three, a trail that spawns six
// metres off to the side is simply never seen. This box is a little wider than
// the frame so they still enter from off-screen rather than popping in.
// Wide enough that a streamer is well off screen before it recycles. The
// visible ground patch is roughly 3.7 m across and 6 m deep, so this leaves
// about two metres of margin on every side for it to fade out in unseen. Too
// tight and a trail visibly blinks out mid-frame, which is worse than not
// having one at all.
const TRAIL_HX = 5.0;
const TRAIL_HZ = 5.0;
const TRAIL_Y1 = 3.2;

// The airborne domain: a 16 x 6 x 16 m box centred on (0, 1.5, 0). Motes are
// spawned on its upwind face and recycled when they leave, so the direction of
// travel is written into the geometry of the system rather than into a shader.
const DOM_HX = 8.0;
const DOM_HZ = 8.0;
const DOM_Y0 = 0.04;   // the box floor is under ground; clamp to just above the grass roots
const DOM_Y1 = 4.5;

// Sun azimuth is fixed by the locked spec (scene.js owns the light; we only
// need the same direction for the analytic grass shading and the rim term).

// Grass field extent and the drip line under the chime where nothing grows.
// The storybook style is a mown lawn, not a hay meadow: at 0.22 m and a camera
// looking down 30 degrees the sward closes over and the ground colour never
// shows, which is most of what that idiom is made of.

// The chime's bounding disc, used for the analytic grass shadow. One disc is a
// coarse stand-in for a 1 m tall assembly, but at an 11 degree sun the shadow
// lands 8 m downsun as a soft smear, which is all the eye reads anyway.

const noise = new ImprovedNoise();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Deterministic RNG so the meadow, the shrubs and the mote mix are identical on
// every load. A scene that reshuffles itself between reloads is impossible to
// judge by eye and impossible to verify by screenshot.
function mulberry32(seed) {
	let a = seed >>> 0;
	return function () {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function clamp(v, lo, hi) {
	return v < lo ? lo : (v > hi ? hi : v);
}

function smoothstep(edge0, edge1, x) {
	const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
	return t * t * (3 - 2 * t);
}

// Module-scope scratch. viz.update() must not allocate.
const _w = new THREE.Vector3();
const _w2 = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _e3 = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _side = new THREE.Vector3();
const _ref = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _ndc = new THREE.Vector3();
const _sunDir = new THREE.Vector3();

// ---------------------------------------------------------------------------
// createWindViz
// ---------------------------------------------------------------------------

export function createWindViz(opts) {

	const scene = opts.scene;
	const camera = opts.camera;
	const wind = opts.wind;
	const params = opts.params;
	let tier = opts.tier;

	// The art direction, handed down from scene.js so the grass, shrubs, motes
	// and ribbon are painted from the same table as the chime and the ground
	// rather than carrying a second, quietly diverging palette.
	const PAL = opts.palette || {};
	const pcol = (key, fallback) => new THREE.Color(PAL[key] !== undefined ? PAL[key] : fallback);


	const counts = { trails: 0, leaves: 0, looping: 0 };


	// STREAMERS
	// =======================================================================
	//
	// Airborne dust and seed fluff, drawn as a few LONG trails instead of a
	// field of short dashes. Three hundred lozenges is a snowstorm: the eye
	// reads a uniform stipple as something falling, not as air moving. Two or
	// three lines that visibly follow the flow read as wind, and each one
	// carries far more information -- a dash shows the direction at a point, a
	// trail shows the whole path the air took to get there.
	//
	// Each streamer is a head advected through wind.sample(), leaving a ribbon
	// of its recent positions. Nodes are laid down at a fixed DISTANCE rather
	// than at a fixed time, so the drawn length does not change with the frame
	// rate, and the spacing scales with speed so faster air draws a longer line.
	// The head is advanced in substeps small enough to lay a node each time,
	// which is what keeps the curve smooth at 10 fps as well as at 144.
	//
	// The wandering is not decoration. Superimposed on the drift is a slow
	// rotation in the plane ACROSS the flow, which makes the path a helix. Below
	// about one times the mean speed the downwind motion wins and it draws a
	// long S; above it the transverse motion wins and the path closes into a
	// loop -- the curl you see once in a while. Same mechanism, one number
	// apart, so a streamer that is snaking and one that is curling are the same
	// object and behave consistently when a gust hits them.

	const TRAIL_NODES = 44;
	const TRAIL_SUBSTEP_CAP = 44;
	// Mean seconds between loop attempts, per streamer. Lower it for more loops.
	const LOOP_MEAN_S = 6;
	// How hard a LOOPING streamer is still pulled toward the air. Low on purpose:
	// at the ordinary coupling the wind straightens the circle before it closes.
	const LOOP_WIND_K = 0.45;
	// Radius of the drawn loop, m. Sized against the frame -- 2.6 m tall in the
	// storybook style -- and against the 2.9 m of trail, which has to hold the
	// whole circumference plus a lead-in.
	const LOOP_RADIUS_MIN = 0.40;
	const LOOP_RADIUS_VAR = 0.22;
	const LOOP_MIN_SPEED = 1.4;
	// While looping, nodes are laid further apart so the TRAIL covers more
	// ground. It has to: a 0.5 m loop is 3.1 m round, and the trail only holds
	// 44 nodes at the ordinary 0.065 m spacing, which is 2.9 m. The head of the
	// loop was being shifted out of the buffer before the tail of it arrived, so
	// the circle could never appear closed however well it was flying.
	const LOOP_SEG_STRETCH = 1.9;
	// Cap the turn per substep independently of node spacing, so stretching the
	// spacing cannot also make the circle a coarse polygon.
	const LOOP_MAX_STEP_RAD = 0.16;

	let streakGeo = null;
	let streakMat = null;
	let streakMesh = null;
	// Head state, then the node history, newest first (index 0 is the head).
	let tPos = null, tVel = null, tNodes = null, tFilled = null;
	let tPhase = null, tOmega = null, tAmp = null, tAge = null, tLife = null;
	// Loop state, separate from the snake above: radians of the current
	// revolution still to turn, and the amplitude and rate to turn them at.
	let tLoopLeft = null, tLoopOmega = null;
	let tPosAttr = null, tColAttr = null;

	const trailRnd = mulberry32(0x1357);

	// Respawn on the upwind boundary. The x-faces and z-faces are chosen in
	// proportion to the flux through each, which is exact for a horizontal flow
	// through an axis-aligned box and keeps the inflow even on a diagonal wind.
	function respawnTrail(i, fx, fz) {
		const ax = Math.abs(fx), az = Math.abs(fz);
		const sum = ax + az;
		let x, z;
		if (sum < 1e-5) {
			x = (trailRnd() * 2 - 1) * TRAIL_HX;
			z = (trailRnd() * 2 - 1) * TRAIL_HZ;
		} else if (trailRnd() * sum < ax) {
			x = -Math.sign(fx) * TRAIL_HX * 0.995;
			z = (trailRnd() * 2 - 1) * TRAIL_HZ;
		} else {
			x = (trailRnd() * 2 - 1) * TRAIL_HX;
			z = -Math.sign(fz) * TRAIL_HZ * 0.995;
		}
		// Bias low: most of what the air carries is picked up off the ground.
		// Kept under the chime's own height so a streamer crosses the frame near
		// the subject rather than sailing over the top of it.
		const y = DOM_Y0 + (TRAIL_Y1 - DOM_Y0) * Math.pow(trailRnd(), 1.4);

		const i3 = i * 3;
		tPos[i3] = x; tPos[i3 + 1] = y; tPos[i3 + 2] = z;
		wind.sample(_w, x, y, z);
		tVel[i3] = _w.x; tVel[i3 + 1] = _w.y; tVel[i3 + 2] = _w.z;
		tAge[i] = 0;
		tLife[i] = 25 + trailRnd() * 20;
		tFilled[i] = 0;

		// Roughly one streamer in five gets a transverse component strong enough
		// to beat the drift and close the path into a loop. The rest snake.
		tPhase[i] = trailRnd() * TAU;
		// Every streamer snakes. Looping is a separate, rare event -- see the
		// loop block in updateStreaks.
		tAmp[i] = 0.16 + trailRnd() * 0.30;
		tOmega[i] = 0.65 + trailRnd() * 0.85;
		tLoopLeft[i] = 0;

		// Collapse the whole ribbon onto the spawn point so the previous life's
		// trail does not snap across the frame on the frame it is reused.
		const base = i * TRAIL_NODES * 3;
		for (let j = 0; j < TRAIL_NODES; j++) {
			tNodes[base + j * 3] = x;
			tNodes[base + j * 3 + 1] = y;
			tNodes[base + j * 3 + 2] = z;
		}
	}

	function buildStreaks() {
		const n = tier.trails;
		const verts = n * TRAIL_NODES * 2;

		streakGeo = new THREE.BufferGeometry();
		tPosAttr = new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage);
		// Four components: three.js takes the fourth as alpha when the material
		// is transparent, which is how each node fades independently.
		tColAttr = new THREE.BufferAttribute(new Float32Array(verts * 4), 4).setUsage(THREE.DynamicDrawUsage);
		streakGeo.setAttribute('position', tPosAttr);
		streakGeo.setAttribute('color', tColAttr);

		const idx = [];
		for (let i = 0; i < n; i++) {
			const o = i * TRAIL_NODES * 2;
			for (let j = 0; j < TRAIL_NODES - 1; j++) {
				const a = o + j * 2, b = a + 1, c = a + 2, d = a + 3;
				idx.push(a, b, c, b, d, c);
			}
		}
		streakGeo.setIndex(idx);

		const c = pcol('streak', 0xffe9c9);
		streakMat = new THREE.MeshBasicMaterial({
			color: 0xffffff,
			vertexColors: true,
			transparent: true,
			depthWrite: false,
			// Normal blending, not additive: additive over a bright sky is white mush.
			blending: THREE.NormalBlending,
			side: THREE.DoubleSide,
			toneMapped: true
		});

		streakMesh = new THREE.Mesh(streakGeo, streakMat);
		streakMesh.frustumCulled = false;
		streakMesh.castShadow = false;
		streakMesh.receiveShadow = false;
		streakMesh.renderOrder = 3;
		streakMesh.name = 'wcs-streamers';
		scene.add(streakMesh);

		tPos = new Float32Array(n * 3);
		tVel = new Float32Array(n * 3);
		tNodes = new Float32Array(n * TRAIL_NODES * 3);
		tFilled = new Int32Array(n);
		tPhase = new Float32Array(n);
		tOmega = new Float32Array(n);
		tAmp = new Float32Array(n);
		tAge = new Float32Array(n);
		tLife = new Float32Array(n);
		tLoopLeft = new Float32Array(n);
		tLoopOmega = new Float32Array(n);

		const dirRad = wind.state.dirDeg * Math.PI / 180;
		for (let i = 0; i < n; i++) {
			respawnTrail(i, -Math.sin(dirRad), Math.cos(dirRad));
			// Stagger the first lives so they do not all recycle on the same
			// frame for the rest of the session.
			tAge[i] = trailRnd() * tLife[i] * 0.6;
		}

		trailColor = c;
		counts.trails = n;
	}

	let trailColor = null;

	function updateStreaks(dt) {
		const n = tier.trails;
		const dirRad = wind.state.dirDeg * Math.PI / 180;
		const fx = -Math.sin(dirRad);
		const fz = Math.cos(dirRad);
		// Two swirl planes, and which one is in use is the whole difference
		// between the two behaviours.
		//
		// The SNAKE turns in the plane ACROSS the flow: horizontal-perpendicular
		// and up. Superimposed on the drift that draws a long lateral S, and if
		// you held it on it would draw a helix -- a corkscrew, which never
		// reverses and never crosses itself.
		//
		// The LOOP turns in the vertical plane ALONG the flow: the flow direction
		// itself and up. A quarter of the way round the added velocity points
		// straight up; halfway round it points straight BACKWARDS, and because it
		// is more than twice the drift the streamer genuinely reverses, goes over
		// the top and crosses its own path. That doubling back is what makes it a
		// loop rather than a roll.
		const snakeX = -fz, snakeZ = fx;

		const mean = wind.state.speedMph * 0.44704 * wind.state.gust;
		// Node spacing, and therefore the drawn length, scales with speed: a
		// streamer in a gust is a longer stroke as well as a faster one.
		const seg = clamp(mean * 0.014, 0.015, 0.065);
		const pos = tPosAttr.array;
		const col = tColAttr.array;

		camera.getWorldDirection(_camDir);
		let loopingNow = 0;

		const cr = trailColor ? trailColor.r : 1;
		const cg = trailColor ? trailColor.g : 1;
		const cb = trailColor ? trailColor.b : 1;

		for (let i = 0; i < n; i++) {
			const i3 = i * 3;
			const base = i * TRAIL_NODES * 3;

			tAge[i] += dt;

			// A loop is an EVENT, not a property of the streamer. Holding the
			// transverse rotation on for a streamer's whole life drew a helix --
			// loop after loop after loop, a corkscrew -- which is not what a
			// gust does. This fires rarely, turns exactly ONE revolution, and
			// hands the streamer back to its gentle snake. LOOP_MEAN_S is the
			// mean time between attempts per streamer; with the pool cycling,
			// one shows up in frame every few seconds.
			// Needs to be actually moving: a nearly stationary head turns a loop
			// too small to see and takes an age about it.
			const sp = Math.hypot(tVel[i3], tVel[i3 + 1], tVel[i3 + 2]);
			if (tLoopLeft[i] <= 0 && mean > 1.2 && sp > LOOP_MIN_SPEED &&
				trailRnd() < 1 - Math.exp(-dt / LOOP_MEAN_S)) {
				tLoopLeft[i] = TAU;
				// Turning the velocity makes the radius speed/omega, so a FIXED
				// omega gives a loop whose size depends on how fast that streamer
				// happened to be going -- and they vary a lot, because the log wind
				// profile is slower near the ground and the low spawn bias puts
				// plenty of them there. Measured, that drew circles anywhere from
				// 0.32 to 1.57 m, and the small ones were too tight to close.
				//
				// Deriving omega from the head's own speed fixes the RADIUS
				// instead, which is the thing that has to read on screen. A slower
				// streamer then takes longer over the same size of loop, which is
				// what it should do.
				tLoopOmega[i] = sp / (LOOP_RADIUS_MIN + trailRnd() * LOOP_RADIUS_VAR);
			}

			// -- advance the head, laying nodes at a fixed distance -----------
			let left = dt;
			let guard = 0;
			while (left > 1e-6 && guard < TRAIL_SUBSTEP_CAP) {
				guard++;
				const loopNow = tLoopLeft[i] > 0;
				const segI = loopNow ? seg * LOOP_SEG_STRETCH : seg;
				const sp = Math.max(0.05, Math.hypot(tVel[i3], tVel[i3 + 1], tVel[i3 + 2]));
				let h = Math.min(left, segI / sp);
				if (loopNow) h = Math.min(h, LOOP_MAX_STEP_RAD / Math.max(tLoopOmega[i], 1e-3));
				left -= h;

				let x = tPos[i3], y = tPos[i3 + 1], z = tPos[i3 + 2];
				wind.sample(_w, x, y, z);

				const looping = tLoopLeft[i] > 0;

				if (looping) {
					// A loop TURNS the velocity the streamer already has. It does
					// not chase a bigger one.
					//
					// The first version added the loop to the velocity TARGET, so
					// the head spent the whole revolution sprinting after something
					// two and a half times the wind -- a peak of 14.4 m/s against a
					// 5.4 m/s breeze, the whole loop over in a fifth of a second.
					// That is why it looked fired from something. A streamer has a
					// velocity, not a target to keep; it is allowed to fall behind
					// the air.
					//
					// Rotating the vector leaves its LENGTH alone, so the head keeps
					// travelling at wind speed and traces a circle of radius
					// speed/omega. Same loop, none of the sprint: peak speed stays
					// 5.4 and a revolution takes 0.7 s.
					//
					// The turn is about the horizontal axis ACROSS the flow, which
					// stands the circle in the vertical plane ALONG it -- over the
					// top and back on itself, the part that makes it a loop rather
					// than a roll. Rodrigues, with the axis already unit length
					// because (fx, fz) is.
					const ang = tLoopOmega[i] * h;
					tLoopLeft[i] -= ang;
					const ax = -fz, az = fx;
					const c = Math.cos(ang), sn = Math.sin(ang);
					const vx = tVel[i3], vy = tVel[i3 + 1], vz = tVel[i3 + 2];
					const dot = ax * vx + az * vz;
					tVel[i3] = vx * c + (-az * vy) * sn + ax * dot * (1 - c);
					tVel[i3 + 1] = vy * c + (az * vx - ax * vz) * sn;
					tVel[i3 + 2] = vz * c + (ax * vy) * sn + az * dot * (1 - c);

					// Barely coupled to the air while it turns: at the ordinary rate
					// the wind straightens the circle out before it can close. What
					// is left still lets the loop drift downwind as it is drawn,
					// which is what stops it looking stamped on.
					const f = 1 - Math.exp(-LOOP_WIND_K * h);
					tVel[i3] += (_w.x - tVel[i3]) * f;
					tVel[i3 + 1] += (_w.y - tVel[i3 + 1]) * f;
					tVel[i3 + 2] += (_w.z - tVel[i3 + 2]) * f;
				} else {
					// Snaking is still a target, because it is meant to be a
					// perturbation OF the wind rather than a departure from it: a
					// gentle rotation across the flow, small enough that the drift
					// always wins and the path only ever draws a long S. The phase
					// advances per substep, not per frame -- a growing clock times a
					// changing rate jumps.
					tPhase[i] += tOmega[i] * h;
					if (tPhase[i] > TAU) tPhase[i] -= TAU;
					const a = tAmp[i] * mean;
					const ph = tPhase[i];
					const swx = a * Math.cos(ph) * snakeX;
					const swy = a * Math.sin(ph);
					const swz = a * Math.cos(ph) * snakeZ;
					const f = 1 - Math.exp(-12.0 * h);
					tVel[i3] += (_w.x + swx - tVel[i3]) * f;
					tVel[i3 + 1] += (_w.y + swy - tVel[i3 + 1]) * f;
					tVel[i3 + 2] += (_w.z + swz - tVel[i3 + 2]) * f;
				}

				x += tVel[i3] * h; y += tVel[i3 + 1] * h; z += tVel[i3 + 2] * h;
				tPos[i3] = x; tPos[i3 + 1] = y; tPos[i3 + 2] = z;

				const dx = x - tNodes[base], dy = y - tNodes[base + 1], dz = z - tNodes[base + 2];
				if (dx * dx + dy * dy + dz * dz >= segI * segI) {
					// Shift the history back one and put the head at the front.
					tNodes.copyWithin(base + 3, base, base + (TRAIL_NODES - 1) * 3);
					tNodes[base] = x; tNodes[base + 1] = y; tNodes[base + 2] = z;
					if (tFilled[i] < TRAIL_NODES) tFilled[i]++;
				}
			}

			const hx = tPos[i3], hy = tPos[i3 + 1], hz = tPos[i3 + 2];
			if (hx < -TRAIL_HX || hx > TRAIL_HX || hz < -TRAIL_HZ || hz > TRAIL_HZ ||
				hy < DOM_Y0 || hy > TRAIL_Y1 || tAge[i] > tLife[i]) {
				respawnTrail(i, fx, fz);
			}

			// -- write the ribbon --------------------------------------------
			if (tLoopLeft[i] > 0) loopingNow++;
			const filled = tFilled[i];
			// Fade in as the trail is laid, out at the end of its life, and away
			// from anything between the camera and the subject: a streamer half a
			// metre from the lens is a smear across the whole shot.
			const dcx = hx - camera.position.x;
			const dcy = hy - camera.position.y;
			const dcz = hz - camera.position.z;
			const near = smoothstep(0.6, 2.2, Math.sqrt(dcx * dcx + dcy * dcy + dcz * dcz));
			// The speed gate IS the gust: slow air is literally invisible, so a
			// lull empties the frame and a gust front materialises out of nothing.
			const gate = smoothstep(0.9, 3.2, mean);
			// Fade out approaching the boundary, not on a timer: a streamer must
			// dissolve out in the margin beyond the frame, never blink out while
			// it is still being looked at. Age only gates the fade IN and acts as
			// a backstop for one that is becalmed and never reaches an edge.
			const edge = Math.min(
				(TRAIL_HX - Math.abs(hx)) / 0.9,
				(TRAIL_HZ - Math.abs(hz)) / 0.9,
				(tLife[i] - tAge[i]) / 2.0,
				1
			);
			const life = clamp(Math.min(tAge[i] / 0.5, edge), 0, 1);
			const alpha = gate * near * life * 0.9;

			for (let j = 0; j < TRAIL_NODES; j++) {
				const v = (i * TRAIL_NODES + j) * 2;
				const nj = base + j * 3;
				const x = tNodes[nj], y = tNodes[nj + 1], z = tNodes[nj + 2];

				// Tangent by central difference where there is one, so the ribbon
				// does not kink at a node.
				const ja = Math.max(0, j - 1), jb = Math.min(TRAIL_NODES - 1, j + 1);
				_e1.set(
					tNodes[base + ja * 3] - tNodes[base + jb * 3],
					tNodes[base + ja * 3 + 1] - tNodes[base + jb * 3 + 1],
					tNodes[base + ja * 3 + 2] - tNodes[base + jb * 3 + 2]
				);
				if (_e1.lengthSq() < 1e-10) _e1.set(0, 1, 0); else _e1.normalize();

				_e2.crossVectors(_e1, _camDir);
				const e2len = _e2.length();
				if (e2len < 1e-4) {
					_e2.set(-_e1.y, _e1.x, 0);
					if (_e2.lengthSq() < 1e-8) _e2.set(1, 0, 0);
					_e2.normalize();
				} else {
					_e2.multiplyScalar(1 / e2len);
				}

				// Blunt at the head, tapering to nothing at the tail: a brush
				// stroke, which is what a mote smeared by its own motion is.
				const u = j / (TRAIL_NODES - 1);
				const w = TRAIL_WIDTH * Math.pow(1 - u, 0.6);
				const aNode = alpha * Math.pow(1 - u, 0.85) * (j < filled ? 1 : 0);

				const ox = _e2.x * w, oy = _e2.y * w, oz = _e2.z * w;
				const o0 = v * 3, o1 = o0 + 3;
				pos[o0] = x + ox; pos[o0 + 1] = y + oy; pos[o0 + 2] = z + oz;
				pos[o1] = x - ox; pos[o1 + 1] = y - oy; pos[o1 + 2] = z - oz;

				const c0 = v * 4, c1 = c0 + 4;
				col[c0] = cr; col[c0 + 1] = cg; col[c0 + 2] = cb; col[c0 + 3] = aNode;
				col[c1] = cr; col[c1 + 1] = cg; col[c1 + 2] = cb; col[c1 + 3] = aNode;
			}
		}

		counts.looping = loopingNow;
		tPosAttr.needsUpdate = true;
		tColAttr.needsUpdate = true;
	}

	// =======================================================================
	// LEAVES
	// =======================================================================
	//
	// Heavier, lit, and rare. A leaf catching the low sun and then turning
	// edge-on is the flicker that makes the air feel occupied rather than
	// merely moving. Almost none are airborne below about 5 mph, because a calm
	// has to look calm.

	let leafGeo = null;
	let leafMat = null;
	let leafMesh = null;
	let lPos = null, lVel = null, lSpin = null, lPhase = null, lSize = null, lActive = null, lGround = null;
	let leafActiveCount = 0;

	function makeLeafGeometry() {
		// A cupped lozenge: five rows along the length, the middle three three
		// vertices wide, pinched to a point at both ends. Eleven vertices, twelve
		// triangles, cupped in local Z so it catches light on one face and goes
		// dark as it rolls.
		const rows = [-0.5, -0.25, 0.0, 0.25, 0.5];
		const halfW = [0.0, 0.20, 0.28, 0.19, 0.0];
		const pos = [];
		const idx = [];
		const vid = [];
		for (let r = 0; r < rows.length; r++) {
			const y = rows[r];
			const hw = halfW[r];
			if (hw === 0) {
				vid.push([pos.length / 3]);
				pos.push(0, y, 0);
			} else {
				const row = [];
				for (let c = -1; c <= 1; c++) {
					row.push(pos.length / 3);
					// Cup: the midrib sits proud of the two edges, so one face
					// catches the sun and the other stays in shadow as it rolls.
					pos.push(c * hw, y, c === 0 ? -0.09 : 0.0);
				}
				vid.push(row);
			}
		}
		function quadStrip(a, b) {
			// a and b are rows of 1 or 3 vertices; emit the non-degenerate
			// triangles between them. Twelve in total across the leaf.
			const A = a.length === 1 ? [a[0], a[0], a[0]] : a;
			const B = b.length === 1 ? [b[0], b[0], b[0]] : b;
			for (let c = 0; c < 2; c++) {
				if (B[c] !== B[c + 1]) idx.push(A[c], B[c], B[c + 1]);
				if (A[c] !== A[c + 1]) idx.push(A[c], B[c + 1], A[c + 1]);
			}
		}
		for (let r = 0; r < rows.length - 1; r++) quadStrip(vid[r], vid[r + 1]);

		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
		g.setIndex(idx);
		g.computeVertexNormals();
		const uv = [];
		for (let i = 0; i < pos.length / 3; i++) uv.push(pos[i * 3] + 0.5, pos[i * 3 + 1] + 0.5);
		g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
		return g;
	}

	function buildLeaves() {
		const n = tier.leaves;
		leafGeo = makeLeafGeometry();
		leafMat = new THREE.MeshStandardMaterial({
			roughness: 0.72,
			metalness: 0.0,
			side: THREE.DoubleSide
		});
		leafMesh = new THREE.InstancedMesh(leafGeo, leafMat, n);
		leafMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		leafMesh.frustumCulled = false;
		leafMesh.castShadow = false;
		leafMesh.receiveShadow = false;
		leafMesh.name = 'wcs-leaves';
		scene.add(leafMesh);

		lPos = new Float32Array(n * 3);
		lVel = new Float32Array(n * 3);
		lSpin = new Float32Array(n);
		lPhase = new Float32Array(n);
		lSize = new Float32Array(n);
		lActive = new Uint8Array(n);
		lGround = new Float32Array(n);

		const rnd = mulberry32(0x4E21);
		const lp = PAL.leafPalette || [0xc46a2a, 0xd99a3c, 0x8d5a22];
		const palette = lp.map((c) => new THREE.Color(c));
		for (let i = 0; i < n; i++) {
			lSize[i] = 0.045 + rnd() * 0.040;   // 7 to 14 cm along the long axis
			lPhase[i] = rnd() * TAU;
			lSpin[i] = rnd() * TAU;
			leafMesh.setColorAt(i, palette[(rnd() * 3) | 0]);
			_mat.makeScale(0, 0, 0);
			leafMesh.setMatrixAt(i, _mat);
		}
		if (leafMesh.instanceColor) leafMesh.instanceColor.needsUpdate = true;
		leafMesh.instanceMatrix.needsUpdate = true;
		leafActiveCount = 0;
		counts.leaves = 0;
	}

	const leafRnd = mulberry32(0x8BD1);

	function spawnLeaf(fx, fz, atEdge) {
		const n = tier.leaves;
		for (let k = 0; k < n; k++) {
			const i = (leafCursor + k) % n;
			if (lActive[i]) continue;
			leafCursor = (i + 1) % n;
			const ax = Math.abs(fx), az = Math.abs(fz);
			let x, z;
			if (atEdge && (ax + az) > 1e-5) {
				if (leafRnd() * (ax + az) < ax) {
					x = -Math.sign(fx) * DOM_HX * 0.98;
					z = (leafRnd() * 2 - 1) * DOM_HZ * 0.8;
				} else {
					x = (leafRnd() * 2 - 1) * DOM_HX * 0.8;
					z = -Math.sign(fz) * DOM_HZ * 0.98;
				}
			} else {
				x = (leafRnd() * 2 - 1) * DOM_HX * 0.7;
				z = (leafRnd() * 2 - 1) * DOM_HZ * 0.7;
			}
			const y = 0.15 + leafRnd() * 2.6;
			lPos[i * 3] = x; lPos[i * 3 + 1] = y; lPos[i * 3 + 2] = z;
			wind.sample(_w, x, y, z);
			lVel[i * 3] = _w.x * 0.7; lVel[i * 3 + 1] = _w.y * 0.5 + 0.4; lVel[i * 3 + 2] = _w.z * 0.7;
			lSpin[i] = leafRnd() * TAU;
			lPhase[i] = leafRnd() * TAU;
			lGround[i] = 0;
			lActive[i] = 1;
			leafActiveCount++;
			return true;
		}
		return false;
	}

	let leafCursor = 0;
	let spawnDebt = 0;
	let prevGust = 1;
	let vizTime = 0;

	// Is this point outside what the camera can see? The margin is generous: a
	// leaf is a centimetres-wide thing whose projected position is its centre,
	// and the point is to be sure it is gone, not to cull tightly.
	function offScreen(x, y, z) {
		_ndc.set(x, y, z).project(camera);
		return Math.abs(_ndc.x) > 1.18 || Math.abs(_ndc.y) > 1.18 || Math.abs(_ndc.z) > 1;
	}

	function updateLeaves(dt, tSec) {
		const n = tier.leaves;
		const dirRad = wind.state.dirDeg * Math.PI / 180;
		const fx = -Math.sin(dirRad);
		const fz = Math.cos(dirRad);
		_axis.set(fx, 0, fz);
		if (_axis.lengthSq() < 1e-8) _axis.set(1, 0, 0);
		_axis.normalize();

		// A gust front announces itself with a burst of leaves at the upwind edge,
		// so you see the leading edge arrive before anything on the chime reacts.
		// Gated on the actual wind, not just the gust multiplier: gust is a ratio,
		// so it still swings above 1.35 when the mean is zero, and a burst of
		// eighteen leaves was arriving out of dead calm.
		const g = wind.state.gust;
		if (wind.state.speedMph > 4 && prevGust < 1.35 && g >= 1.35) {
			for (let k = 0; k < 18; k++) if (!spawnLeaf(fx, fz, true)) break;
		}
		prevGust = g;

		// Steady-state population, gated hard below about 5 mph.
		// For the first second and a half the population is seeded through the
		// whole volume so the air is already occupied when the page opens; after
		// that leaves only ever enter from upwind, so nothing pops into view.
		const atEdge = vizTime > 1.5;
		const mph = wind.state.speedMph;
		const target = Math.round(n * smoothstep(4.5, 16.0, mph));
		if (leafActiveCount < target) {
			spawnDebt += dt * (2 + 0.6 * (target - leafActiveCount));
			while (spawnDebt >= 1 && leafActiveCount < target) {
				spawnDebt -= 1;
				if (!spawnLeaf(fx, fz, atEdge)) break;
			}
		} else {
			spawnDebt = 0;
		}

		for (let i = 0; i < n; i++) {
			if (!lActive[i]) continue;
			const i3 = i * 3;
			let x = lPos[i3], y = lPos[i3 + 1], z = lPos[i3 + 2];

			wind.sample(_w, x, y, z);
			const wmag = _w.length();

			// A leaf is a broad, light body: strong coupling to the air, and a
			// terminal fall speed of well under a metre a second.
			const f = 1 - Math.exp(-2.6 * dt);
			lVel[i3] += (_w.x - lVel[i3]) * f;
			lVel[i3 + 1] += (_w.y - 0.55 - lVel[i3 + 1]) * f;
			lVel[i3 + 2] += (_w.z - lVel[i3 + 2]) * f;

			// Tumble about the wind axis, with a flutter about the leaf's own long
			// axis. The zigzag fall comes out of the flutter, not out of noise.
			// The old rate carried a constant 1.2 rad/s, so a leaf lying in dead
			// calm span forever on the spot. Nothing turns a leaf but the air.
			lSpin[i] += wmag * 1.12 * dt;
			// lPhase starts as a per-leaf random offset and is then integrated,
			// for the same reason as the grass: tSec * (a + b * wmag) jumps.
			lPhase[i] += wmag * 1.18 * dt;
			const flutter = Math.sin(lPhase[i]);
			lVel[i3 + 1] += Math.cos(flutter) * wmag * 0.11 * dt;

			x += lVel[i3] * dt;
			y += lVel[i3 + 1] * dt;
			z += lVel[i3 + 2] * dt;

			if (y <= 0.03) {
				// Landed. It skitters along the grass and only lifts again if the
				// wind at ground level is doing real work.
				y = 0.03;
				lVel[i3 + 1] = 0;
				lVel[i3] *= 0.55;
				lVel[i3 + 2] *= 0.55;
				lGround[i] += dt;
				if (wmag > 3.2 && leafRnd() < dt * 1.5) {
					lVel[i3 + 1] = 0.8 + wmag * 0.10;
					lGround[i] = 0;
				}
			}

			// Leaving the domain is safely out of shot -- it is eight metres out,
			// and the frame covers about four. Lying on the grass is not: a
			// grounded leaf used to be recycled five seconds later wherever it
			// happened to be, which for one on the lawn in front of you meant
			// blinking out of existence in full view. It now stays until it is
			// off screen, and a rising wind lifts it again long before that.
			// The pool cannot starve as a result: the same wind that would want
			// new leaves is the wind that picks these ones back up.
			const out = x < -DOM_HX || x > DOM_HX || z < -DOM_HZ || z > DOM_HZ || y > DOM_Y1;
			if (out || (lGround[i] > 5.0 && offScreen(x, y, z))) {
				lActive[i] = 0;
				leafActiveCount--;
				_mat.makeScale(0, 0, 0);
				leafMesh.setMatrixAt(i, _mat);
				continue;
			}

			lPos[i3] = x; lPos[i3 + 1] = y; lPos[i3 + 2] = z;

			_q1.setFromAxisAngle(_axis, lSpin[i]);
			_q2.setFromAxisAngle(_e1.set(0, 1, 0), flutter * 1.1);
			_q1.multiply(_q2);
			// Now that a leaf can lie on the lawn indefinitely, it has to lie
			// down: the tumble leaves it at whatever angle it landed at, and one
			// standing on its edge in the grass for a minute reads as a bug. The
			// blade is modelled in its local XY plane, so face-up is a quarter
			// turn about X, then a yaw about world up to keep its heading.
			if (lGround[i] > 0) {
				_q2.setFromAxisAngle(_e1.set(1, 0, 0), -Math.PI * 0.5);
				_q3.setFromAxisAngle(_e2.set(0, 1, 0), lSpin[i]);
				_q2.premultiply(_q3);
				_q1.slerp(_q2, clamp(lGround[i] / 0.7, 0, 1));
			}
			_pos.set(x, y, z);
			_scl.set(lSize[i], lSize[i] * 1.6, lSize[i]);
			_mat.compose(_pos, _q1, _scl);
			leafMesh.setMatrixAt(i, _mat);
		}

		leafMesh.instanceMatrix.needsUpdate = true;
		counts.leaves = leafActiveCount;
	}

	// =======================================================================
	// TELLTALE RIBBON
	// =======================================================================
	//
	// A strip of faded muslin tied under the top plate. Dead calm: it hangs
	// straight down. Twelve miles an hour: it streams and ripples. A gust: it
	// snaps and cracks. It is the fastest read of direction in the frame,
	// because it sits on the subject and it is the only saturated colour in an
	// amber-and-olive scene.
	//
	// Verlet, because it is unconditionally stable under the yanking a gust
	// produces. The wind term is a DRAG on the RELATIVE velocity, and quadratic
	// in it, which is the same v-squared law that makes the sail lurch. That is
	// what gives the telltale its range: at 1.7 m/s it hangs about 48 degrees off
	// vertical, at 3.5 m/s about 78, and in a hard gust it cracks straight out.
	// A drag linear in wind speed pins it near horizontal at every speed and the
	// telltale stops telling you anything.
	//
	// Applied as v += rel * (1 - exp(-kQ*|rel|*h)): for small h that is exactly
	// kQ*|rel|*rel*h, and the relaxation factor can never exceed 1, so a 100 ms
	// frame after a tab switch cannot blow the strip up.

	const RIBBON_LEN = 0.34;
	const RIBBON_DRAG_Q = 3.85;   // per metre; muslin has a high area-to-mass ratio

	let ribGeo = null;
	let ribMat = null;
	let ribMesh = null;
	let rPos = null, rPrev = null, rHalfW = null;
	let ribbonNodes = 0;
	let ribbonSeg = 0;
	let ribbonSeeded = false;

	function buildRibbon() {
		ribbonNodes = Math.max(3, tier.ribbonSegs);
		ribbonSeg = RIBBON_LEN / (ribbonNodes - 1);

		rPos = new Float32Array(ribbonNodes * 3);
		rPrev = new Float32Array(ribbonNodes * 3);
		rHalfW = new Float32Array(ribbonNodes);
		for (let i = 0; i < ribbonNodes; i++) {
			const t = i / (ribbonNodes - 1);
			// Cloth cut on a taper and frayed at the free end. The old near-linear
			// profile plus a flat opaque fill made it read as a plastic strip; the
			// stronger taper here, the alpha ramp in the material below and the
			// twist applied per node in updateRibbon are what turn it back into a
			// worn scrap of muslin.
			rHalfW[i] = 0.019 * (1 - t * t * 0.86) * (1 - 0.42 * t);
		}
		ribbonSeeded = false;

		ribGeo = new THREE.BufferGeometry();
		ribGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ribbonNodes * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
		ribGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(ribbonNodes * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
		const uv = new Float32Array(ribbonNodes * 2 * 2);
		const idx = [];
		for (let i = 0; i < ribbonNodes; i++) {
			const t = i / (ribbonNodes - 1);
			uv[i * 4] = 0; uv[i * 4 + 1] = t;
			uv[i * 4 + 2] = 1; uv[i * 4 + 3] = t;
			if (i < ribbonNodes - 1) {
				const a = i * 2;
				idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
			}
		}
		ribGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
		ribGeo.setIndex(idx);
		ribGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.9, 0), 1.2);

		ribMat = new THREE.MeshStandardMaterial({
			color: pcol('ribbon', 0xc9425a),
			roughness: 0.92,
			metalness: 0.0,
			side: THREE.DoubleSide,
			transparent: true,
			depthWrite: true
		});
		// Faded muslin: thin, so it goes a little translucent toward its frayed
		// end and lets the sky through, and slightly bleached along the way. The
		// uv.y running 0 at the anchor to 1 at the tip is already in the geometry.
		ribMat.onBeforeCompile = (shader) => {
			shader.vertexShader = 'varying float vRibT;\n' + shader.vertexShader
				.replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvRibT = uv.y;');
			shader.fragmentShader = 'varying float vRibT;\n' + shader.fragmentShader
				.replace(
					'#include <dithering_fragment>',
					'#include <dithering_fragment>\n'
					+ '\tgl_FragColor.a *= mix(0.97, 0.42, vRibT * vRibT);\n'
					+ '\tgl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * vec3(1.10, 0.94, 0.90), vRibT);'
				);
		};
		ribMesh = new THREE.Mesh(ribGeo, ribMat);
		ribMesh.frustumCulled = false;
		ribMesh.castShadow = false;
		ribMesh.receiveShadow = false;
		ribMesh.name = 'wcs-telltale';
		scene.add(ribMesh);
	}

	function seedRibbon(anchor) {
		for (let i = 0; i < ribbonNodes; i++) {
			const y = anchor[1] - i * ribbonSeg;
			rPos[i * 3] = anchor[0];
			rPos[i * 3 + 1] = y;
			rPos[i * 3 + 2] = anchor[2];
			rPrev[i * 3] = anchor[0];
			rPrev[i * 3 + 1] = y;
			rPrev[i * 3 + 2] = anchor[2];
		}
		ribbonSeeded = true;
	}

	let ribPhase = 0;

	function updateRibbon(dt, tSec, anchor) {
		if (!anchor) return;
		if (!ribbonSeeded) seedRibbon(anchor);

		if (dt > 0) {
			// Fixed 1/120 s substeps: the drag coefficient is stiff enough that a
			// 100 ms tab-switch frame would otherwise overshoot.
			const steps = clamp(Math.ceil(dt / (1 / 120)), 1, 8);
			const h = dt / steps;

			for (let s = 0; s < steps; s++) {
				for (let i = 1; i < ribbonNodes; i++) {
					const i3 = i * 3;
					const px = rPos[i3], py = rPos[i3 + 1], pz = rPos[i3 + 2];
					let vx = (px - rPrev[i3]) / h;
					let vy = (py - rPrev[i3 + 1]) / h;
					let vz = (pz - rPrev[i3 + 2]) / h;

					wind.sample(_w, px, py, pz);
					const rx = _w.x - vx, ry = _w.y - vy, rz = _w.z - vz;
					const rel = Math.sqrt(rx * rx + ry * ry + rz * rz);
					const dragF = 1 - Math.exp(-RIBBON_DRAG_Q * rel * h);
					vx += rx * dragF;
					vy += ry * dragF;
					vz += rz * dragF;
					vy -= 9.81 * h;
					// A whisper of extra damping so the cloth does not sing.
					vx *= 0.985; vy *= 0.985; vz *= 0.985;

					rPrev[i3] = px; rPrev[i3 + 1] = py; rPrev[i3 + 2] = pz;
					rPos[i3] = px + vx * h;
					rPos[i3 + 1] = py + vy * h;
					rPos[i3 + 2] = pz + vz * h;
				}

				// Three Gauss-Seidel passes: node 0 is pinned to the plate, every
				// segment is inextensible.
				for (let pass = 0; pass < 3; pass++) {
					rPos[0] = anchor[0]; rPos[1] = anchor[1]; rPos[2] = anchor[2];
					for (let i = 0; i < ribbonNodes - 1; i++) {
						const a = i * 3, b = (i + 1) * 3;
						let dx = rPos[b] - rPos[a];
						let dy = rPos[b + 1] - rPos[a + 1];
						let dz = rPos[b + 2] - rPos[a + 2];
						let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
						if (d < 1e-6) { dx = 0; dy = -1; dz = 0; d = 1; }
						const corr = (d - ribbonSeg) / d;
						// Node 0 is immovable; every other pair splits the correction.
						const wA = i === 0 ? 0 : 0.5;
						const wB = i === 0 ? 1 : 0.5;
						rPos[a] += dx * corr * wA;
						rPos[a + 1] += dy * corr * wA;
						rPos[a + 2] += dz * corr * wA;
						rPos[b] -= dx * corr * wB;
						rPos[b + 1] -= dy * corr * wB;
						rPos[b + 2] -= dz * corr * wB;
					}
				}
			}
		} else {
			rPos[0] = anchor[0]; rPos[1] = anchor[1]; rPos[2] = anchor[2];
		}

		// Build the strip. The side vector is parallel-transported down the ribbon
		// so it never flips, then twisted by a wind-driven sine so the cloth shows
		// its face and then its edge as it ripples.
		const attr = ribGeo.getAttribute('position');
		const arr = attr.array;
		_ref.set(0, 0, 1);
		wind.sample(_w2, rPos[0], rPos[1], rPos[2]);
		const wsp = _w2.length();
		const twistAmp = 0.72 * clamp(wsp / 5, 0, 1);
		// Integrated, not tSec * (3 + 0.8 * wsp): the ribbon is the one cue a
		// viewer watches to read direction, so a phase jump in it is the most
		// visible of the four. In still air it stops twisting and just hangs.
		ribPhase += wsp * 1.35 * dt;
		if (ribPhase > TAU * 1024) ribPhase -= TAU * 1024;

		for (let i = 0; i < ribbonNodes; i++) {
			const i3 = i * 3;
			const j3 = i < ribbonNodes - 1 ? (i + 1) * 3 : (i - 1) * 3;
			_seg.set(rPos[j3] - rPos[i3], rPos[j3 + 1] - rPos[i3 + 1], rPos[j3 + 2] - rPos[i3 + 2]);
			if (i === ribbonNodes - 1) _seg.negate();
			if (_seg.lengthSq() < 1e-10) _seg.set(0, -1, 0);
			_seg.normalize();

			_side.crossVectors(_seg, _ref);
			if (_side.lengthSq() < 1e-8) {
				_side.crossVectors(_seg, _e1.set(1, 0, 0));
				if (_side.lengthSq() < 1e-8) _side.set(0, 0, 1);
			}
			_side.normalize();
			_ref.crossVectors(_side, _seg).normalize();   // parallel transport

			_e2.copy(_side).applyAxisAngle(_seg, Math.sin(ribPhase + i * 0.9) * twistAmp);
			const hw = rHalfW[i];
			const o = i * 6;
			arr[o] = rPos[i3] + _e2.x * hw;
			arr[o + 1] = rPos[i3 + 1] + _e2.y * hw;
			arr[o + 2] = rPos[i3 + 2] + _e2.z * hw;
			arr[o + 3] = rPos[i3] - _e2.x * hw;
			arr[o + 4] = rPos[i3 + 1] - _e2.y * hw;
			arr[o + 5] = rPos[i3 + 2] - _e2.z * hw;
		}
		attr.needsUpdate = true;
		ribGeo.computeVertexNormals();
	}

	// =======================================================================
	// Assembly
	// =======================================================================

	buildStreaks();
	buildLeaves();
	buildRibbon();

	function disposeMesh(mesh, geo, mat) {
		if (mesh) {
			scene.remove(mesh);
			// InstancedMesh also owns its matrix and colour buffers.
			if (typeof mesh.dispose === 'function') mesh.dispose();
		}
		if (geo) geo.dispose();
		if (mat) mat.dispose();
	}

	const viz = {

		counts,

		// Kept as a no-op: the meadow used to fill nine thousand blade transforms
		// here, which cost about 15 ms and was the whole reason it was deferred
		// past first paint. The static ground cover lives in scene.js now and is
		// cheap enough to build outright, but main.js still calls this.
		buildDeferred() {},

		update(dt, tSec, anchor, plateCentre) {
			const step = clamp(dt, 0, 0.100);
			vizTime += step;
			updateStreaks(step);
			updateLeaves(step, tSec);
			updateRibbon(step, tSec, anchor);
		},

		setTier(next) {
			tier = next;
			disposeMesh(streakMesh, streakGeo, streakMat);
			disposeMesh(leafMesh, leafGeo, leafMat);
			disposeMesh(ribMesh, ribGeo, ribMat);

			buildStreaks();
			buildLeaves();
			buildRibbon();
		},

		dispose() {
			disposeMesh(streakMesh, streakGeo, streakMat);
			disposeMesh(leafMesh, leafGeo, leafMat);
			disposeMesh(ribMesh, ribGeo, ribMat);
			streakMesh = leafMesh = ribMesh = null;
			streakGeo = leafGeo = ribGeo = null;
			streakMat = leafMat = ribMat = null;
		}
	};

	return viz;
}
