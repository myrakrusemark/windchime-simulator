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
const SUN_AZ_DEG = 205;

// Grass field extent and the drip line under the chime where nothing grows.
const GRASS_R = 14.0;
const GRASS_R_BARE = 0.35;
const BLADE_LEN = 0.22;
// The storybook style is a mown lawn, not a hay meadow: at 0.22 m and a camera
// looking down 30 degrees the sward closes over and the ground colour never
// shows, which is most of what that idiom is made of.
const BLADE_LEN_FLAT = 0.10;

// The chime's bounding disc, used for the analytic grass shadow. One disc is a
// coarse stand-in for a 1 m tall assembly, but at an 11 degree sun the shadow
// lands 8 m downsun as a soft smear, which is all the eye reads anyway.
const CHIME_DISC_Y = 1.55;
const CHIME_DISC_R = 0.13;

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
const _sunDir = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Shader fragments shared by grass and shrubs
// ---------------------------------------------------------------------------

// Both read the flow texture wind.js bakes at grass height and decode it the
// same way. flowInfo carries the constants so neither shader hardcodes them.
const FLOW_DECODE = /* glsl */`
	vec2 sampleFlow(vec2 worldXZ) {
		vec2 fuv = (worldXZ + uFlowExtent * 0.5) / uFlowExtent;
		return (texture2D(uFlow, fuv).rg * 2.0 - 1.0) * uFlowScale;
	}
`;

// Fragment tail matched to three's built-in materials so these custom shaders
// tone-map and fog exactly like the ground plane next to them. The renderer
// disables TONE_MAPPING automatically when drawing into the composer's HDR
// target, so the same code is correct on both the high and the low tier.
const FRAG_TAIL = /* glsl */`
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
`;

// ANALYTIC SUN OCCLUSION, and the single biggest thing standing between this
// picture and a golden hour.
//
// The grass carries its own lighting, so it was never in the shadow pass at
// all -- and grass is exactly what the shadow needs to land on, because a
// blade is VERTICAL and an 11 degree sun hits it head on. The sun is the
// dominant light on every blade in the meadow, which makes a shadow across it
// the strongest tonal event available, and there was not one.
//
// A shadow map would work, but the caster set here is four boxes and a disc, so
// marching the sun ray against them directly is cheaper, needs no bias, never
// aliases, and costs one ray-slab test per blade in the vertex shader. It also
// stays correct out to the fog line, where a 2048 map would already be mush.
//
// sunOcclusion returns 1 in full sun and dips toward SHADE_FLOOR in shadow.
const SUN_OCCLUSION = /* glsl */`
	uniform vec3 uSunDir;
	uniform vec3 uChimeCentre;
	uniform float uChimeRadius;
	uniform float uRoof;   // 0 when the style hangs the chime from a bare beam

	// Fraction of the ray from p toward the sun that passes through an
	// axis-aligned box, as a soft 0..1 hit. Soft because a slab test with a hard
	// edge crawls with vertex density on 12 mm blades.
	float boxShade(vec3 p, vec3 d, vec3 lo, vec3 hi) {
		vec3 inv = 1.0 / d;
		vec3 t0 = (lo - p) * inv;
		vec3 t1 = (hi - p) * inv;
		vec3 tn = min(t0, t1);
		vec3 tf = max(t0, t1);
		float tNear = max(max(tn.x, tn.y), tn.z);
		float tFar  = min(min(tf.x, tf.y), tf.z);
		// Overlap in metres along the ray, saturating over one box thickness.
		float pass = min(tFar, 1.0e4) - max(tNear, 0.0);
		return smoothstep(0.0, 0.05, pass);
	}

	float sunOcclusion(vec3 p) {
		// A ray that is not going up cannot reach the sun at all.
		vec3 d = uSunDir;
		if (d.y < 0.01) return 1.0;

		float s = 0.0;
		// Porch roof slab, cedar beam, post. Kept in step with scene.js by hand.
		s = max(s, uRoof * 0.82 * boxShade(p, d, vec3(-1.5, 2.75, -0.7), vec3(1.5, 2.81, 0.7)));
		s = max(s, 0.70 * boxShade(p, d, vec3(-1.3, 2.60, -0.045), vec3(1.3, 2.72, 0.045)));
		s = max(s, 0.78 * boxShade(p, d, vec3(-1.30, 0.0, -0.05), vec3(-1.20, 2.60, 0.05)));

		// The chime itself, as the disc that bounds the tube bundle. Walk to its
		// height and see whether we land inside it.
		float tHit = (uChimeCentre.y - p.y) / max(d.y, 0.05);
		if (tHit > 0.0) {
			vec2 hit = p.xz + d.xz * tHit;
			float r = distance(hit, uChimeCentre.xz);
			s = max(s, 0.52 * (1.0 - smoothstep(uChimeRadius * 0.45, uChimeRadius * 1.7, r)));
		}
		return 1.0 - s;
	}
`;

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
	// Linear-space RGB triples for the shaders, which do their own lighting.
	const bladeLen = PAL.flatten ? BLADE_LEN_FLAT : BLADE_LEN;
	const plin = (key, fallback) => {
		const c = pcol(key, fallback).clone().convertSRGBToLinear();
		return new THREE.Vector3(c.r, c.g, c.b);
	};

	const flowInfo = (wind && wind.flowInfo) || { size: 64, extent: 32, height: 0.30, scale: 12 };

	// A neutral stand-in so that, if the flow texture is not up yet on the very
	// first frames, the grass stands still rather than lying flat at the
	// sampler's default white (which decodes to a 17 m/s gale).
	const neutralFlow = new THREE.DataTexture(
		new Uint8Array([128, 128, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType
	);
	neutralFlow.needsUpdate = true;

	const counts = { grass: 0, trails: 0, leaves: 0, shrubCards: 0 };

	// Shared uniforms. The same objects are handed to the grass and the shrub
	// material so a single write updates both.
	const uniforms = {
		uFlow: { value: wind && wind.flowTexture ? wind.flowTexture : neutralFlow },
		uFlowExtent: { value: flowInfo.extent },
		uFlowScale: { value: flowInfo.scale },
		uTime: { value: 0 },
		uSunDir: { value: new THREE.Vector3(-0.415, 0.191, 0.890) },
		uSunColor: { value: new THREE.Color(0xffc07a) },
		uGrassRoot: { value: plin('grassRoot', 0x444620) },
		// 0 keeps the golden hour lighting model; 1 flattens to near-albedo with
		// a soft lambert wash and no backlit rim, which is what the storybook
		// style needs -- a rim term is a photograph of grass, not a drawing of it.
		uFlatten: { value: PAL.flatten ? 1.0 : 0.0 },
		uRoof: { value: PAL.porchRoof === false ? 0.0 : 1.0 },
		uGrassTip: { value: plin('grassTip', 0xb0a04d) },
		uChimeCentre: { value: new THREE.Vector3(0, CHIME_DISC_Y, 0) },
		uChimeRadius: { value: CHIME_DISC_R }
	};

	let lastSunElev = -999;

	function refreshSun() {
		const el = clamp(Number(params.sunElevDeg) || 11, 2, 20);
		if (Math.abs(el - lastSunElev) < 0.25) return;
		lastSunElev = el;
		const a = SUN_AZ_DEG * Math.PI / 180;
		const e = el * Math.PI / 180;
		uniforms.uSunDir.value.set(
			Math.sin(a) * Math.cos(e),
			Math.sin(e),
			-Math.cos(a) * Math.cos(e)
		).normalize();
		// Warmer and dimmer the lower it sits, matching scene.js's light colour.
		const k = smoothstep(4, 16, el);
		uniforms.uSunColor.value.setRGB(1.0, 0.62 + 0.26 * k, 0.30 + 0.42 * k, THREE.SRGBColorSpace);
	}
	refreshSun();

	// =======================================================================
	// GRASS
	// =======================================================================
	//
	// One draw call. Positions and per-blade randomness live in instance
	// attributes; the bend comes from the flow texture in the vertex shader, so
	// nine thousand blades cost nothing on the CPU.
	//
	// The blades are at 0.22 m, where the log wind profile gives about 41
	// percent of the reference wind, against 61 percent at the sail. The grass
	// is therefore SUPPOSED to move less than the chime. Do not scale this up.

	let grassGeo = null;
	let grassMat = null;
	let grassMesh = null;
	// Reach of the meadow. Pulled in on the low tier so the reduced blade count
	// lands where it can be seen instead of being spread to the fog line; the
	// far field is carried by the ground map and the fog either way.
	let grassRadius = tier.name === 'low' ? 8.5 : GRASS_R;

	const GRASS_VERT = /* glsl */`
		attribute vec3 iPos;
		attribute float iRot;
		attribute float iScale;
		attribute float iPhase;
		attribute float iTint;

		uniform sampler2D uFlow;
		uniform float uFlowExtent;
		uniform float uFlowScale;
		uniform float uTime;
		uniform vec3 uSunColor;
		uniform vec3 uGrassRoot;
		uniform vec3 uGrassTip;
		uniform float uFlatten;

		varying vec3 vLit;

		#include <common>
		#include <fog_pars_vertex>
		${FLOW_DECODE}
		${SUN_OCCLUSION}

		void main() {
			float h = uv.y;                       // 0 at the root, 1 at the tip
			vec3 p = position;
			p.x *= mix(1.0, 0.16, h);             // taper the blade to a point
			p *= iScale;
			float len = ${bladeLen.toFixed(3)} * iScale;

			float c = cos(iRot), s = sin(iRot);
			mat2 rot = mat2(c, -s, s, c);
			p.xz = rot * p.xz;
			vec3 n = vec3(0.0, 0.0, 1.0);
			n.xz = rot * n.xz;

			vec2 w = sampleFlow(iPos.xz);
			float ws = length(w);
			vec2 wd = ws > 1e-3 ? w / ws : vec2(1.0, 0.0);

			// Cubic-ish bend profile: the root barely moves, the tip does the work.
			float bend = h * h * (0.5 + 0.5 * h) * clamp(ws * 0.09, 0.0, 1.15);
			p.xz += wd * bend * len;
			// A bent blade is SHORTER. Without this term the field reads as a
			// wobbling flag instead of grass laid over by wind.
			p.y -= bend * bend * 0.45 * len;

			// Cross-wind flutter, per blade, faster in stronger wind.
			vec2 perp = vec2(-wd.y, wd.x);
			p.xz += perp * sin(uTime * (5.0 + ws * 0.55) + iPhase) * 0.012 * ws * h;

			// Tip the normal over with the bend so the sheen travels with the wave.
			n = normalize(n + vec3(wd.x, 0.0, wd.y) * bend * 1.6);

			vec3 world = iPos + p;
			vec4 mvPosition = modelViewMatrix * vec4(world, 1.0);
			gl_Position = projectionMatrix * mvPosition;

			// Half lambert: a blade is thin enough that light wraps right around it.
			float lam = 0.5 + 0.5 * dot(n, uSunDir);
			lam *= lam;
			// Backlit rim - at eleven degrees the whole meadow lights from behind.
			vec3 vdir = normalize(world - cameraPosition);
			float rim = pow(clamp(dot(vdir, uSunDir), 0.0, 1.0), 4.0) * (0.30 + 0.70 * h);

			// Sun occlusion from the porch and the chime, evaluated once per blade
			// at its root: a 0.22 m blade is far shorter than the softness of the
			// edges it sits under, so per-vertex would only cost more.
			float shade = sunOcclusion(iPos + vec3(0.0, 0.06, 0.0));

			// Warm meadow rather than cool olive. At golden hour dry grass runs
			// amber at the tips and stays green only down in the sward, and that
			// warm-over-green split is most of what says "low sun" here.
			vec3 albedo = mix(uGrassRoot, uGrassTip, h) * (1.0 + (iTint - 0.5) * 0.16);

			// The rim term is direct sun through a thin blade, so it takes the
			// shadow at full strength; the half-lambert term is mostly skylight
			// and keeps a floor.
			vec3 litGolden = albedo * (0.55 + 1.90 * lam * mix(0.34, 1.0, shade))
			              + uSunColor * rim * 0.9 * shade;
			// Flat: the blade keeps its own colour, shading only enough to tell a
			// lit face from a shaded one, and the porch's shadow still lands.
			vec3 litFlat = albedo * (0.92 + 0.22 * lam) * mix(0.66, 1.0, shade);
			vLit = mix(litGolden, litFlat, uFlatten);

			#include <fog_vertex>
		}
	`;

	const GRASS_FRAG = /* glsl */`
		varying vec3 vLit;
		#include <common>
		#include <fog_pars_fragment>
		void main() {
			gl_FragColor = vec4(vLit, 1.0);
			${FRAG_TAIL}
		}
	`;

	function buildGrass() {
		const n = tier.grass;

		// A third of the blades has to cover the same near field, so on the low
		// tier each one is wider and the field is pulled in (see grassRadius).
		// Matching the count instead would put phones and the software rasteriser
		// - which is most of who sees the low tier - in front of stubble on a
		// painted plane, which is not what the high tier is showing.
		const src = new THREE.PlaneGeometry(tier.name === 'low' ? 0.019 : 0.012, bladeLen, 1, 3);
		src.translate(0, bladeLen * 0.5, 0);   // root the blade at y = 0

		grassGeo = new THREE.InstancedBufferGeometry();
		grassGeo.index = src.index;
		grassGeo.setAttribute('position', src.getAttribute('position'));
		grassGeo.setAttribute('normal', src.getAttribute('normal'));
		grassGeo.setAttribute('uv', src.getAttribute('uv'));

		grassGeo.setAttribute('iPos', new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3));
		grassGeo.setAttribute('iRot', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
		grassGeo.setAttribute('iScale', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
		grassGeo.setAttribute('iPhase', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
		grassGeo.setAttribute('iTint', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
		grassGeo.instanceCount = 0;   // nothing drawn until buildDeferred fills it
		grassGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), grassRadius + 1);

		grassMat = new THREE.ShaderMaterial({
			uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]),
			vertexShader: GRASS_VERT,
			fragmentShader: GRASS_FRAG,
			fog: true,
			side: THREE.DoubleSide
		});
		// merge() deep-clones, so re-point the shared uniforms by hand.
		for (const k in uniforms) grassMat.uniforms[k] = uniforms[k];

		grassMesh = new THREE.Mesh(grassGeo, grassMat);
		grassMesh.frustumCulled = false;   // instances live far outside the base geometry
		grassMesh.castShadow = false;
		grassMesh.receiveShadow = false;
		grassMesh.renderOrder = 0;
		grassMesh.name = 'wcs-grass';
		scene.add(grassMesh);
	}

	function fillGrass() {
		const n = tier.grass;
		const rnd = mulberry32(0x9E37);
		const aPos = grassGeo.getAttribute('iPos');
		const aRot = grassGeo.getAttribute('iRot');
		const aScale = grassGeo.getAttribute('iScale');
		const aPhase = grassGeo.getAttribute('iPhase');
		const aTint = grassGeo.getAttribute('iTint');

		let written = 0;
		let guard = 0;
		while (written < n && guard < n * 64) {
			guard++;
			// Uniform over the disc, then rejected against the density falloff so
			// blades crowd near the chime where the camera actually looks.
			const r = grassRadius * Math.sqrt(rnd());
			if (r < GRASS_R_BARE) continue;              // the drip line under the chime
			const density = 1 / (1 + (r * r) / 9);
			if (rnd() > density) continue;

			const a = rnd() * TAU;
			const x = Math.cos(a) * r;
			const z = Math.sin(a) * r;

			aPos.setXYZ(written, x, 0, z);
			aRot.setX(written, rnd() * TAU);
			// Height varies in patches, not per blade - real turf grows in clumps.
			const patch = noise.noise(x * 0.35, 0.0, z * 0.35);
			aScale.setX(written, 0.62 + 0.55 * rnd() + 0.35 * patch);
			aPhase.setX(written, rnd() * TAU);
			aTint.setX(written, clamp(0.5 + 0.9 * noise.noise(x * 0.22, 3.7, z * 0.22) + 0.25 * (rnd() - 0.5), 0, 1));
			written++;
		}

		aPos.needsUpdate = true;
		aRot.needsUpdate = true;
		aScale.needsUpdate = true;
		aPhase.needsUpdate = true;
		aTint.needsUpdate = true;
		grassGeo.instanceCount = written;
		counts.grass = written;
	}

	// =======================================================================
	// SHRUBS
	// =======================================================================
	//
	// Alpha-tested leaf cards clustered into three masses behind the chime.
	// They read the same flow texture as the grass but respond slower and
	// wider, the way a mass with real branch stiffness does.

	let shrubGeo = null;
	let shrubMat = null;
	let shrubMesh = null;
	let shrubTex = null;

	// Placed OFF the default camera's sight line. The spec wants the tube
	// bottoms read against dark foliage and the tops against bright sky, which
	// is right, but a mass sitting square behind the chime swallowed the sail and
	// the lower half of the bundle. These flank it instead.
	// Kept clear of the default camera's sight line by at least 8 degrees, which
	// is the chime's own angular half-width plus a margin. The first cluster used
	// to sit 6.3 degrees off axis with a 6.2 degree angular radius, so its edge
	// grazed the tube bottoms and the sail and read as foliage growing through
	// the chime.
	const SHRUB_CLUSTERS = PAL.shrubClusters || [
		{ x: -3.00, y: 0.60, z: 5.60, r: 1.05 },
		{ x: -6.80, y: 0.70, z: -1.60, r: 1.15 },
		{ x: -2.40, y: 0.45, z: 7.40, r: 0.90 }
	];

	// A leaf-cluster mask built as raw bytes. No canvas, so this module never
	// touches the DOM.
	function makeLeafClusterTexture() {
		const sc = pcol('shrub', 0x5f6b3a);
		const shrubR = sc.r, shrubG = sc.g, shrubB = sc.b;
		const S = 64;
		const data = new Uint8Array(S * S * 4);
		const rnd = mulberry32(0x51F0);
		// Many small lobes rather than a few big ones: a card has to survive being
		// scaled up until the cards knit into a mass, and one fat blob at that size
		// reads as a balloon.
		const lobes = [];
		for (let i = 0; i < 16; i++) {
			lobes.push({
				cx: 0.5 + (rnd() - 0.5) * 0.66,
				cy: 0.5 + (rnd() - 0.5) * 0.66,
				rx: 0.055 + rnd() * 0.085,
				ry: 0.045 + rnd() * 0.070,
				rot: rnd() * TAU
			});
		}
		for (let j = 0; j < S; j++) {
			for (let i = 0; i < S; i++) {
				const u = (i + 0.5) / S;
				const v = (j + 0.5) / S;
				let cover = 0;
				for (let k = 0; k < lobes.length; k++) {
					const L = lobes[k];
					const dx = u - L.cx, dy = v - L.cy;
					const c = Math.cos(L.rot), s = Math.sin(L.rot);
					const px = (dx * c + dy * s) / L.rx;
					const py = (-dx * s + dy * c) / L.ry;
					const d = px * px + py * py;
					if (d < 1) cover = Math.max(cover, 1 - d);
				}
				// Erode the edges with noise so no two cards silhouette alike.
				const e = 0.5 + 0.5 * noise.noise(u * 14, v * 14, 4.2);
				const alpha = cover > 0 ? clamp((cover * 3.4) * (0.55 + 0.75 * e), 0, 1) : 0;
				const shade = 0.62 + 0.38 * e;
				const o = (j * S + i) * 4;
				// Keyed off the palette's shrub colour rather than a nursery green,
				// or the bushes read as plastic against the meadow.
				data[o] = Math.round(255 * shrubR * shade);
				data[o + 1] = Math.round(255 * shrubG * shade);
				data[o + 2] = Math.round(255 * shrubB * shade);
				data[o + 3] = Math.round(255 * alpha);
			}
		}
		const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
		tex.minFilter = THREE.LinearMipmapLinearFilter;
		tex.magFilter = THREE.LinearFilter;
		tex.generateMipmaps = true;
		tex.needsUpdate = true;
		return tex;
	}

	const SHRUB_VERT = /* glsl */`
		uniform float uFlatten;
		attribute vec3 iPos;
		attribute float iRot;
		attribute float iScale;
		attribute float iPhase;
		attribute float iSway;

		uniform sampler2D uFlow;
		uniform float uFlowExtent;
		uniform float uFlowScale;
		uniform float uTime;
		uniform vec3 uSunColor;

		varying vec2 vUv;
		varying vec3 vLit;

		#include <common>
		#include <fog_pars_vertex>
		${FLOW_DECODE}
		${SUN_OCCLUSION}

		void main() {
			vUv = uv;

			// Cheap per-card pitch from the phase; saves an attribute.
			float pitch = fract(sin(iPhase * 12.9898) * 43758.5453) * 1.2 - 0.6;

			vec3 p = position * iScale;
			float cp = cos(pitch), sp = sin(pitch);
			p.yz = mat2(cp, -sp, sp, cp) * p.yz;
			float c = cos(iRot), s = sin(iRot);
			p.xz = mat2(c, -s, s, c) * p.xz;

			vec3 nrm = vec3(0.0, 0.0, 1.0);
			nrm.yz = mat2(cp, -sp, sp, cp) * nrm.yz;
			nrm.xz = mat2(c, -s, s, c) * nrm.xz;

			vec2 w = sampleFlow(iPos.xz);
			float ws = length(w);
			vec2 wd = ws > 1e-3 ? w / ws : vec2(1.0, 0.0);

			// A branch leans further than a grass blade and lags behind it.
			float bend = ws * 0.06 * iSway;
			vec3 world = iPos + p;
			world.xz += wd * bend;
			world.y -= bend * bend * 0.30;
			world.xz += vec2(-wd.y, wd.x) * sin(uTime * (2.2 + ws * 0.30) + iPhase) * 0.028 * min(ws, 8.0) * 0.12 * iSway;

			vec4 mvPosition = modelViewMatrix * vec4(world, 1.0);
			gl_Position = projectionMatrix * mvPosition;

			float lam = 0.5 + 0.5 * dot(nrm, uSunDir);
			lam *= lam;
			vec3 vdir = normalize(world - cameraPosition);
			float rim = pow(clamp(dot(vdir, uSunDir), 0.0, 1.0), 3.0);
			float shade = sunOcclusion(world);
			// Foliage is deep: the interior of the mass is in its own shade, so key
			// the ambient off how far the card sits up the bush.
			vec3 litGolden = vec3(0.42 + 0.30 * iSway + 1.45 * lam * mix(0.34, 1.0, shade))
			               + uSunColor * rim * 0.70 * shade;
			// Flat: the leaf texture carries the colour, so this only has to say
			// which side of the bush the light is on.
			vec3 litFlat = vec3((0.84 + 0.26 * lam) * mix(0.76, 1.0, shade));
			vLit = mix(litGolden, litFlat, uFlatten);

			#include <fog_vertex>
		}
	`;

	const SHRUB_FRAG = /* glsl */`
		uniform sampler2D uLeafTex;
		varying vec2 vUv;
		varying vec3 vLit;
		#include <common>
		#include <fog_pars_fragment>
		void main() {
			vec4 t = texture2D(uLeafTex, vUv);
			// Alpha test rather than blending: no sorting cost, no depth sorting bugs.
			if (t.a < 0.5) discard;
			gl_FragColor = vec4(t.rgb * vLit, 1.0);
			${FRAG_TAIL}
		}
	`;

	function buildShrubs() {
		const n = tier.shrubCards;
		shrubTex = makeLeafClusterTexture();

		const src = new THREE.PlaneGeometry(1, 1, 1, 1);
		shrubGeo = new THREE.InstancedBufferGeometry();
		shrubGeo.index = src.index;
		shrubGeo.setAttribute('position', src.getAttribute('position'));
		shrubGeo.setAttribute('normal', src.getAttribute('normal'));
		shrubGeo.setAttribute('uv', src.getAttribute('uv'));
		shrubGeo.setAttribute('iPos', new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3));
		shrubGeo.setAttribute('iRot', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
		shrubGeo.setAttribute('iScale', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
		shrubGeo.setAttribute('iPhase', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
		shrubGeo.setAttribute('iSway', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
		shrubGeo.instanceCount = 0;
		shrubGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, -3), 8);

		shrubMat = new THREE.ShaderMaterial({
			uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]),
			vertexShader: SHRUB_VERT,
			fragmentShader: SHRUB_FRAG,
			fog: true,
			side: THREE.DoubleSide
		});
		for (const k in uniforms) shrubMat.uniforms[k] = uniforms[k];
		shrubMat.uniforms.uLeafTex = { value: shrubTex };

		shrubMesh = new THREE.Mesh(shrubGeo, shrubMat);
		shrubMesh.frustumCulled = false;
		shrubMesh.name = 'wcs-shrubs';
		scene.add(shrubMesh);
	}

	function fillShrubs() {
		const n = tier.shrubCards;
		const rnd = mulberry32(0x2C1B);
		const aPos = shrubGeo.getAttribute('iPos');
		const aRot = shrubGeo.getAttribute('iRot');
		const aScale = shrubGeo.getAttribute('iScale');
		const aPhase = shrubGeo.getAttribute('iPhase');
		const aSway = shrubGeo.getAttribute('iSway');

		// Share the cards out by cluster volume so the big bush is the dense one.
		let total = 0;
		for (const c of SHRUB_CLUSTERS) total += c.r * c.r * c.r;

		let written = 0;
		for (let ci = 0; ci < SHRUB_CLUSTERS.length && written < n; ci++) {
			const c = SHRUB_CLUSTERS[ci];
			const share = ci === SHRUB_CLUSTERS.length - 1
				? n - written
				: Math.round(n * (c.r * c.r * c.r) / total);
			for (let k = 0; k < share && written < n; k++) {
				// Bias outward: a bush is mostly a shell, and interior cards are
				// invisible geometry you still pay for.
				const rho = c.r * Math.pow(rnd(), 0.35);
				const th = rnd() * TAU;
				const ph = Math.acos(2 * rnd() - 1);
				const x = c.x + rho * Math.sin(ph) * Math.cos(th);
				const y = c.y + rho * Math.cos(ph) * 0.85;
				const z = c.z + rho * Math.sin(ph) * Math.sin(th);
				if (y < 0.05) continue;   // nothing below the soil

				aPos.setXYZ(written, x, y, z);
				aRot.setX(written, rnd() * TAU);
				// Sized so neighbouring cards overlap even at the low tier's card
				// count; separated cards read as floating balls, not as a bush.
				aScale.setX(written, (0.44 + 0.30 * rnd()) * (0.7 + 0.4 * c.r));
				aPhase.setX(written, rnd() * TAU);
				// Cards near the top of the mass sway most; the base is anchored.
				aSway.setX(written, clamp((y - c.y + c.r) / (2 * c.r), 0, 1));
				written++;
			}
		}

		aPos.needsUpdate = true;
		aRot.needsUpdate = true;
		aScale.needsUpdate = true;
		aPhase.needsUpdate = true;
		aSway.needsUpdate = true;
		shrubGeo.instanceCount = written;
		counts.shrubCards = written;
	}

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
	const TRAIL_SUBSTEP_CAP = 28;

	let streakGeo = null;
	let streakMat = null;
	let streakMesh = null;
	// Head state, then the node history, newest first (index 0 is the head).
	let tPos = null, tVel = null, tNodes = null, tFilled = null;
	let tPhase = null, tOmega = null, tAmp = null, tAge = null, tLife = null;
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
		// The loop's radius is amp * meanSpeed / omega, and for a curl to CLOSE
		// rather than draw a long arc that radius has to be small enough that the
		// circumference fits inside the drawn length -- about 2.9 m here. The
		// first cut used omega near 2.5, which gives a 2.6 m radius: a loop wider
		// than the frame, so it read as a lazy bend and never as a curl.
		if (trailRnd() < 0.22) {
			tAmp[i] = 1.20 + trailRnd() * 0.70;
			tOmega[i] = 22 + trailRnd() * 12;
		} else {
			tAmp[i] = 0.16 + trailRnd() * 0.30;
			tOmega[i] = 0.65 + trailRnd() * 0.85;
		}

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
		// The swirl plane: one axis horizontal and across the flow, the other up.
		const p1x = -fz, p1z = fx;

		const mean = wind.state.speedMph * 0.44704 * wind.state.gust;
		// Node spacing, and therefore the drawn length, scales with speed: a
		// streamer in a gust is a longer stroke as well as a faster one.
		const seg = clamp(mean * 0.014, 0.015, 0.065);
		const pos = tPosAttr.array;
		const col = tColAttr.array;

		camera.getWorldDirection(_camDir);

		const cr = trailColor ? trailColor.r : 1;
		const cg = trailColor ? trailColor.g : 1;
		const cb = trailColor ? trailColor.b : 1;

		for (let i = 0; i < n; i++) {
			const i3 = i * 3;
			const base = i * TRAIL_NODES * 3;

			tAge[i] += dt;

			// -- advance the head, laying nodes at a fixed distance -----------
			let left = dt;
			let guard = 0;
			while (left > 1e-6 && guard < TRAIL_SUBSTEP_CAP) {
				guard++;
				const sp = Math.max(0.05, Math.hypot(tVel[i3], tVel[i3 + 1], tVel[i3 + 2]));
				const h = Math.min(left, seg / sp);
				left -= h;

				let x = tPos[i3], y = tPos[i3 + 1], z = tPos[i3 + 2];
				wind.sample(_w, x, y, z);

				// The transverse rotation that makes the path snake or curl. The
				// phase MUST advance per substep, not per frame: a curl runs near
				// 28 rad/s, which is 2.8 radians of jump per frame at 10 fps, and
				// the loop aliased into a sawtooth.
				tPhase[i] += tOmega[i] * h;
				if (tPhase[i] > TAU) tPhase[i] -= TAU;
				const a = tAmp[i] * mean;
				const ph = tPhase[i];
				const swx = a * Math.cos(ph) * p1x;
				const swy = a * Math.sin(ph);
				const swz = a * Math.cos(ph) * p1z;

				// Relax toward the air plus the swirl, exponentially, so the step
				// is stable at any frame time.
				const f = 1 - Math.exp(-12.0 * h);
				tVel[i3] += (_w.x + swx - tVel[i3]) * f;
				tVel[i3 + 1] += (_w.y + swy - tVel[i3 + 1]) * f;
				tVel[i3 + 2] += (_w.z + swz - tVel[i3 + 2]) * f;

				x += tVel[i3] * h; y += tVel[i3 + 1] * h; z += tVel[i3 + 2] * h;
				tPos[i3] = x; tPos[i3 + 1] = y; tPos[i3 + 2] = z;

				const dx = x - tNodes[base], dy = y - tNodes[base + 1], dz = z - tNodes[base + 2];
				if (dx * dx + dy * dy + dz * dz >= seg * seg) {
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
		const g = wind.state.gust;
		if (prevGust < 1.35 && g >= 1.35) {
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
			lSpin[i] += (wmag * 0.9 + 1.2) * dt;
			const flutter = Math.sin(tSec * (4 + wmag * 0.6) + lPhase[i]);
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

			const out = x < -DOM_HX || x > DOM_HX || z < -DOM_HZ || z > DOM_HZ || y > DOM_Y1;
			if (out || lGround[i] > 5.0) {
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

			_e2.copy(_side).applyAxisAngle(_seg, Math.sin(tSec * (3 + wsp * 0.8) + i * 0.9) * twistAmp);
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

	buildGrass();
	buildShrubs();
	buildStreaks();
	buildLeaves();
	buildRibbon();

	let deferredDone = false;

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

		// Filling nine thousand blade transforms costs about 15 ms. Deferring it
		// to frame 2 is the whole reason first paint is instant.
		buildDeferred() {
			if (deferredDone) return;
			deferredDone = true;
			fillGrass();
			fillShrubs();
		},

		update(dt, tSec, anchor, plateCentre) {
			// The flow texture is re-baked in place by wind.js; re-point the uniform
			// in case it only exists after the first bake.
			if (wind.flowTexture && uniforms.uFlow.value !== wind.flowTexture) {
				uniforms.uFlow.value = wind.flowTexture;
			}
			// Track the chime's shadow disc to where the chime actually is. The
			// whole assembly swings on its bridle, so the plate centroid is the
			// bundle's horizontal position; the disc height stays fixed because it
			// stands for the middle of the tubes, which hang the same distance
			// below the plate however far the rig leans.
			if (plateCentre && Number.isFinite(plateCentre[0])) {
				const c = uniforms.uChimeCentre.value;
				c.x = plateCentre[0];
				c.z = plateCentre[2];
			}
			uniforms.uTime.value = tSec;
			refreshSun();
			// A ShaderMaterial only re-uploads its uniform block when the renderer
			// happens to rebind it or when this flag is set. Setting it is a boolean
			// write and it removes any dependence on scene draw order.
			if (grassMat) grassMat.uniformsNeedUpdate = true;
			if (shrubMat) shrubMat.uniformsNeedUpdate = true;

			const step = clamp(dt, 0, 0.100);
			vizTime += step;
			updateStreaks(step);
			updateLeaves(step, tSec);
			updateRibbon(step, tSec, anchor);
		},

		setTier(next) {
			tier = next;
			grassRadius = tier.name === 'low' ? 8.5 : GRASS_R;
			disposeMesh(grassMesh, grassGeo, grassMat);
			disposeMesh(shrubMesh, shrubGeo, shrubMat);
			disposeMesh(streakMesh, streakGeo, streakMat);
			disposeMesh(leafMesh, leafGeo, leafMat);
			disposeMesh(ribMesh, ribGeo, ribMat);
			if (shrubTex) { shrubTex.dispose(); shrubTex = null; }

			buildGrass();
			buildShrubs();
			buildStreaks();
			buildLeaves();
			buildRibbon();

			// A tier change happens mid-session, so fill immediately rather than
			// leaving the ground bare for a frame.
			fillGrass();
			fillShrubs();
			deferredDone = true;
		},

		dispose() {
			disposeMesh(grassMesh, grassGeo, grassMat);
			disposeMesh(shrubMesh, shrubGeo, shrubMat);
			disposeMesh(streakMesh, streakGeo, streakMat);
			disposeMesh(leafMesh, leafGeo, leafMat);
			disposeMesh(ribMesh, ribGeo, ribMat);
			if (shrubTex) { shrubTex.dispose(); shrubTex = null; }
			neutralFlow.dispose();
			grassMesh = shrubMesh = streakMesh = leafMesh = ribMesh = null;
			grassGeo = shrubGeo = streakGeo = leafGeo = ribGeo = null;
			grassMat = shrubMat = streakMat = leafMat = ribMat = null;
		}
	};

	return viz;
}
