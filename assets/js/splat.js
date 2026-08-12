/**
 * splat.js - a place that is actually there.
 *
 * plate.js paints a place as a photograph on a clip-space quad. This draws the
 * same capture as the million gaussians it was reconstructed from, in the
 * scene, in front of the same camera the chime is in. The difference is the
 * whole point: a photograph cannot be walked around, and this can. Orbit, zoom
 * and pan work on a splat place because there is somewhere to orbit to.
 *
 * WHY THIS IS NOT AN OPTIMISATION OF plate.js
 *
 * The two are different objects with the same job. A plate is one quad drawn
 * before everything else with depth test off; a splat is a sorted point cloud
 * that has to depth-test against the chime or the chime cannot be in front of a
 * near leaf and behind a far one. They share only the handle shape below, so
 * places.js can hand either to scene.js and P5's hang gizmo without caring.
 *
 * RULE A STILL HOLDS, AND IT COSTS NOTHING HERE
 *
 * CONTRACTS 5.3 Rule A says the chime never moves: hang.u/v/scale move the
 * PLATE. That was written to protect the frozen physics hook, the bridle cord
 * derived from it at module load, the grab proxies parented to the scene and
 * windviz's hard-coded world extents. None of that changed, so the rule stands
 * and this file honours it the same way - by moving the capture. A SplatMesh is
 * an Object3D, so "move the backdrop instead of the object" is a translation on
 * a transform rather than a crop on a shader, which is simpler than the plate's
 * version rather than harder.
 *
 * THE COST, STATED ONCE
 *
 * The capture is 11.4 MB and spark is 5.2 MB. That is the price of a place you
 * can move through, and it is paid on first load. Measured on the laptop this
 * was built on: first frame at about 1.3 s from localhost, 28-47 fps orbiting.
 * `ready()` reports whether the gaussians have arrived, so a caller can put a
 * chime on screen and let the forest turn up behind it.
 */

import * as THREE from 'three';
import { SplatMesh, SparkRenderer } from './vendor-spark.js';

/**
 * One SparkRenderer per scene, not per place. Spark draws every SplatMesh in
 * the scene through the renderer that is IN the scene, and adding a second one
 * on a place switch would leave the first behind with nothing to draw. Keyed on
 * the scene so a torn-down stage gets a fresh one and a live one is reused.
 * @type {WeakMap<THREE.Scene, SparkRenderer>}
 */
const renderers = new WeakMap();

/**
 * Sort planar under an orthographic camera, radial under a perspective one.
 *
 * spark defaults sortRadial to true, which is right for a perspective camera:
 * rays diverge from an eye point, so distance FROM THAT POINT is the depth
 * order. An orthographic camera has no eye point. Its rays are parallel and
 * the correct order is planar depth along the view direction.
 *
 * Sorting radially under ortho produces an order that does not match the real
 * back-to-front, and - this is the part that shows - the size of the mismatch
 * CHANGES AS THE CAMERA ORBITS. So the order churns for reasons that have
 * nothing to do with anything actually moving, and the capture swims.
 *
 * Found because Myra pointed out that superspl.at's own viewer does not do
 * this with the same capture. It does not, because it renders perspective,
 * where spark's default is correct. This scene is orthographic (the storybook
 * style), which made the default wrong here and nowhere else.
 */
function sortRadialFor( camera ) {

	return ! ( camera && camera.isOrthographicCamera );

}

function sparkFor( scene, renderer, camera ) {

	let s = renderers.get( scene );
	if ( s ) {

		s.sortRadial = sortRadialFor( camera );
		return s;

	}
	// enableLod defaults to TRUE, and it is the wrong default for a place.
	//
	// LOD swaps WHICH gaussians are drawn as the view changes. On a capture you
	// fly through at speed that is exactly right; on a fixed-ish view of a
	// forest it means splats appearing and vanishing as the camera creeps,
	// which reads as popping rather than as detail arriving. At 300k there is
	// nothing to save: the whole capture fits in one level.
	//
	// minSortIntervalMs stays 0. The sort is what keeps back-to-front blending
	// correct and throttling it trades shimmer for smear.
	s = new SparkRenderer( {
		renderer,
		enableLod: false,
		enableDriveLod: false,
		sortRadial: sortRadialFor( camera )
	} );
	scene.add( s );
	renderers.set( scene, s );
	return s;

}

/**
 * The ring and the cord above it.
 *
 * A plate place needed a whole synthetic branch, because a photograph has
 * nothing in it at hook height for a cord to end on and a cord running off the
 * top of the frame reads as a mistake. A splat place has a real canopy, so the
 * branch was scaffolding for a problem that no longer exists - and a modelled
 * limb sitting in front of a photographed one looks worse than no limb at all.
 *
 * What stays is the iron eye at HOOK_Y, because the cord has to pass through
 * something rather than stopping in mid-air, and a short cord rising out of the
 * top of it. It ends where a rope would disappear into leaves.
 *
 * HOOK is (0, 2.60, 0), mirrored from physics.js, which is read-only here.
 *
 * THE EYE IS NOT PLACEABLE, AND THAT IS THE POINT.
 *
 * The place's hanger spec used to carry `z: -0.06`, which pushed the modelled
 * LIMB six centimetres behind the chime so a branch would not grow through it.
 * The limb is gone and the offset outlived it, still being applied - to the one
 * piece of geometry that has no freedom to move. The bridle's three cords meet
 * at the hook exactly, so an eye anywhere but the hook is a ring the chime
 * hangs NEXT to. On screen that read as the whole assembly being off-centre
 * under its own ring, which is what it was. The eye takes the hook's x and z
 * and no spec may say otherwise.
 */
const HOOK_X = 0.0, HOOK_Y = 2.60, HOOK_Z = 0.0;

function buildCordHanger( spec ) {

	const g = new THREE.Group();
	g.name = 'wcs-hanger';
	const geoms = [];
	const mats = [];

	const eyeR = spec.eye && Number.isFinite( spec.eye.radius ) ? spec.eye.radius : 0.028;
	const eyeT = spec.eye && Number.isFinite( spec.eye.tube ) ? spec.eye.tube : 0.006;
	const eyeGeo = new THREE.TorusGeometry( eyeR, eyeT, 8, 20 );
	geoms.push( eyeGeo );
	const eyeMat = new THREE.MeshStandardMaterial( {
		color: spec.eye && spec.eye.color !== undefined ? spec.eye.color : 0x3b3733,
		roughness: 0.55, metalness: 0.65
	} );
	mats.push( eyeMat );
	const eye = new THREE.Mesh( eyeGeo, eyeMat );
	// Raised by a bit over half the ring's radius, so the hook lands just inside
	// the ring's lower opening rather than at its centre - which is where a cord
	// tied through an eye actually bears. Sideways it is the hook, exactly.
	eye.position.set( HOOK_X, HOOK_Y + eyeR * 0.55, HOOK_Z );
	eye.castShadow = true;
	g.add( eye );

	// NO ROPE HERE ANY MORE.
	//
	// This group used to draw the cord above the eye as well, twelve segments it
	// bent with a wind heuristic of its own. The rope is a real cord in the rig
	// now - physics.js hangs the ring from a static anchor at the branch and
	// reports the strand in RigState.cords like every other one - so scene.js's
	// cord renderer draws it, with the same material and the same slack-driven
	// sag as the bridle. Two drawers for one rope is two ropes.
	g.userData.geoms = geoms;
	g.userData.mats = mats;
	g.userData.eye = eye;
	g.userData.eyeRise = eyeR * 0.55;
	return g;

}

/**
 * @param {object} ctx    { scene, renderer, container }
 * @param {object} place  the place descriptor; place.backdrop.splat is the .sog
 * @param {function} onError (tag, err) => void
 */
export function createSplat( ctx, place, onError ) {

	const scene = ctx.scene;
	const back = place.backdrop || {};
	const note = ( tag, err ) => { try { onError && onError( tag, err ); } catch ( e ) {} };

	let u = place.hang.default.u;
	let v = place.hang.default.v;
	let scale = place.hang.default.scale;
	let disposed = false;
	let mesh = null;
	let arrived = false;
	let detail = 1;          // fraction of the capture's gaussians to draw
	let fullSplats = 0;      // how many arrived, before any thinning
	let cordLen = 0.61;      // metres of rope between the eye and the branch

	const hanger = place.hanger === null ? null : buildCordHanger( place.hanger || {} );
	if ( hanger ) scene.add( hanger );

	/**
	 * Put the iron eye where the rig says the ring is.
	 *
	 * It used to sit at a constant, HOOK_Y plus a little, and that constant was
	 * the same number physics.js welded the bridle to - one fact typed into two
	 * files, and only the physics copy could ever move. The ring is a particle
	 * now, so the eye reads its position and the two cannot disagree.
	 *
	 * The rise survives the move. A cord tied through an eye bears on the inside
	 * of the ring's LOWER opening, not at its centre, so the torus is drawn a bit
	 * over half a radius above the point the bridle converges on - which is what
	 * stops the chime looking like it hangs beside its own ring.
	 */
	function placeEye( x, y, z ) {

		if ( ! hanger ) return;
		hanger.userData.eye.position.set( x, y + hanger.userData.eyeRise, z );

	}

	// The capture's own placement, authored with the place. A SOG capture
	// arrives y-down, which is the single most common way to get a forest that
	// renders perfectly and hangs upside down over the path.
	const pose = back.pose || {};
	// A tuning override, read once. Placing a capture against an object is a
	// thing you do by eye, and an edit-render-look cycle at thirty seconds a
	// turn is the wrong instrument for it. `?pose=x,y,z,scale` lets the pose be
	// dialled in the live page and the winning numbers pasted back into the
	// place. It is additive, ignored when absent, and carries nothing into the
	// shared design - the URL the visitor copies is still just their chime.
	let OVERRIDE = null;
	try {

		const raw = new URLSearchParams( location.search ).get( 'pose' );
		if ( raw ) {

			const n = raw.split( ',' ).map( Number );
			if ( n.length >= 3 && n.every( Number.isFinite ) ) OVERRIDE = n;

		}

	} catch ( err ) {}

	const POS = OVERRIDE ? OVERRIDE.slice( 0, 3 ) : ( pose.position || [ 0, 0, 0 ] );
	const ROT = pose.quaternion || [ 1, 0, 0, 0 ];
	const SIZE = ( OVERRIDE && Number.isFinite( OVERRIDE[ 3 ] ) ) ? OVERRIDE[ 3 ]
		: ( Number.isFinite( pose.scale ) ? pose.scale : 1 );

	// hang.u/v are a fraction of the frame. On a plate they crop; here they slide
	// the capture across the chime, which is the same gesture in world units.
	// The span is authored per place so a visitor cannot push the forest off the
	// side of its own capture.
	const reach = back.reach || { x: 6, y: 3 };

	/**
	 * Draw a fraction of the capture.
	 *
	 * spark takes the count off packedSplats.numSplats and the draw is a prefix
	 * of the packed array, so thinning is one integer and no reupload - which is
	 * what makes this cheap enough to sit under a slider. Measured in the open
	 * page: 99,871 down to 34,954 and back, no rebuild, no hitch.
	 *
	 * A PREFIX, and that is the one thing to know about it. It works here because
	 * this capture's packed order is not spatially sorted - dropping the tail at
	 * 35 percent thinned the whole wood evenly rather than deleting a corner of
	 * it, checked by eye against the full render. A capture that arrived Morton
	 * ordered would lose a region instead, and the fix then is to shuffle the
	 * packed array once on load rather than to change anything here. Nothing
	 * downstream cares about the order: spark re-sorts by depth every frame and
	 * LOD is off.
	 */
	/**
	 * SHUFFLE THE CAPTURE ONCE, SO THAT THINNING IT SAMPLES THE WOOD INSTEAD OF
	 * DEMOLISHING PART OF IT.
	 *
	 * applyDetail draws a PREFIX - spark takes its count off
	 * packedSplats.numSplats and draws that many from the front, which is one
	 * integer and no reupload, and is the only reason the slider can be dragged
	 * smoothly. A prefix is a fair sample only if the file is in no particular
	 * order, and a gaussian capture is the opposite of that: reconstruction
	 * groups by region and the SOG encoder keeps the grouping, because
	 * neighbouring gaussians compress together. So dropping the tail deleted a
	 * PLACE. At the shipped tenth: the path, the ground, the stump and the whole
	 * right-hand tree gone, a band of canopy left hanging in the dark.
	 *
	 * Doing it here rather than in the asset, which was the first attempt and the
	 * obvious one. Shuffling the PLY before conversion changes nothing, because
	 * splat-transform re-orders on the way into .sog - the two builds render the
	 * identical hole. The order has to be decided after the file is parsed, which
	 * means here.
	 *
	 * ALL FOUR ARRAYS OR NONE. A gaussian is not just its packed record: the
	 * harmonics live beside it in extra.sh1/sh2/sh3 at their own strides, indexed
	 * by the same splat number. Permuting the positions and not the harmonics
	 * would leave every leaf wearing another leaf's colour response, which is a
	 * far worse bug than the one being fixed and would not look like a bug at
	 * all - just a wood that had gone subtly wrong.
	 *
	 * Seeded, so the thinning is the same picture on every load rather than a
	 * different forest each refresh.
	 */
	function spreadSplats() {

		if ( ! mesh || ! mesh.packedSplats ) return;
		const ps = mesh.packedSplats;
		const capacity = ps.maxSplats;
		const n = ps.numSplats;
		if ( ! ( n > 1 ) || ! ( capacity >= n ) ) return;

		// Every array that is indexed by splat number, with how many uint32 each
		// splat owns in it. Derived from the array's own length rather than
		// hard-coded, so a capture with fewer harmonic bands simply contributes
		// fewer entries instead of being mis-strided.
		const lanes = [];
		const add = ( arr ) => {

			if ( ! arr || ! arr.length || arr.length % capacity !== 0 ) return;
			lanes.push( { arr, stride: arr.length / capacity, tmp: new Uint32Array( arr.length / capacity ) } );

		};

		add( ps.packedArray );
		const ex = ps.extra || {};
		add( ex.sh1 ); add( ex.sh2 ); add( ex.sh3 );
		if ( ! lanes.length ) return;

		// mulberry32, the same deterministic generator tools/verify-design.mjs
		// uses. Math.random would make every reload a different wood.
		let t = 0x9E3779B9;
		const rand = () => {

			t += 0x6D2B79F5;
			let x = t;
			x = Math.imul( x ^ ( x >>> 15 ), 1 | x );
			x ^= x + Math.imul( x ^ ( x >>> 7 ), 61 | x );
			return ( ( x ^ ( x >>> 14 ) ) >>> 0 ) / 4294967296;

		};

		// Fisher-Yates over splat indices, applied to every lane at once.
		for ( let i = n - 1; i > 0; i -- ) {

			const j = Math.floor( rand() * ( i + 1 ) );
			if ( i === j ) continue;
			for ( const lane of lanes ) {

				const s = lane.stride, a = i * s, b = j * s;
				lane.tmp.set( lane.arr.subarray( a, a + s ) );
				lane.arr.copyWithin( a, b, b + s );
				lane.arr.set( lane.tmp, b );

			}

		}

		ps.needsUpdate = true;
		mesh.needsUpdate = true;
		mesh.generatorDirty = true;

	}

	function applyDetail() {

		if ( ! mesh || ! mesh.packedSplats || ! fullSplats ) return;
		// OF THE AUTHOR'S CAPTURE, NOT OF THE FILE. back.fullGaussians is what
		// tanha actually reconstructed; the .sog on disk is an export of some
		// fraction of it. Counting against the file would make the slider's
		// percentages a statement about our build rather than about the wood -
		// "100 per cent" would have meant 100 per cent of a tenth for as long as
		// the tenth was what shipped, and would silently change meaning the day
		// a denser export landed. Clamped to what the file holds, so a place that
		// authors a number bigger than its own asset asks for splats that are not
		// there and gets all of the ones that are.
		const full = Number.isFinite( back.fullGaussians ) ? back.fullGaussians : fullSplats;
		const want = Math.min( fullSplats, Math.max( 1, Math.round( full * detail ) ) );
		if ( mesh.packedSplats.numSplats === want ) return;
		mesh.packedSplats.numSplats = want;
		mesh.packedSplats.needsUpdate = true;
		mesh.needsUpdate = true;
		mesh.generatorDirty = true;

	}

	function applyPose() {

		if ( ! mesh ) return;
		// u/v run 0..1 with 0.5 as centred; convert to a signed offset in metres.
		const dx = ( 0.5 - u ) * 2 * reach.x;
		const dy = ( v - 0.5 ) * 2 * reach.y;
		// A picked hang point wins over the authored pose: the visitor said
		// where, and the sliders go back to being a nudge around it.
		const base = pickOffset || { x: POS[ 0 ], y: POS[ 1 ], z: POS[ 2 ] };
		// NO CORD TERM HERE, and that is deliberate. The rope's length is baked
		// into pickOffset at the moment of the pick and adjusted by setCord when
		// it changes, rather than added on top of the authored pose every frame.
		//
		// The difference is what a cold load looks like. Adding it here lifted
		// the capture 0.61 m on a page nobody had picked anything on, which put
		// the canopy band out of the top of a 3.2 m frame and shipped ?c=v1 as a
		// black rectangle. A rope only means something once there is a branch at
		// the other end of it: with no pick, Cord draws rope and moves nothing.
		mesh.position.set( base.x + dx, base.y + dy, base.z );
		// Scaling the capture is what makes the chime look bigger against it,
		// with the chime and therefore stage.cameraDistance() untouched - which
		// is what keeps a bigger chime from also being a louder one (H14).
		const s = SIZE / ( scale || 1 );
		mesh.scale.set( s, s, s );
		mesh.updateMatrixWorld( true );

	}

	// Load asynchronously and add on arrival. Nothing above startLoop() in
	// main.js awaits and that must stay true (H4), so this is fire-and-forget
	// with a guard: a place switched away from before its gaussians land must
	// not add them to a scene it no longer owns.
	( async () => {

		try {

			if ( ! back.splat ) return;
			// A tuning override, same bargain as ?pose=. Three captures ship at
			// different densities and which one is right is a looking question,
			// not a benchmarking one: ?splat=10 / 30 / flat swaps them live so
			// the same eyes can judge the cost and the quality together.
			let url = back.splat;
			try {

				const pick = new URLSearchParams( location.search ).get( 'splat' );
				if ( pick && /^[a-z0-9-]+$/i.test( pick ) ) {

					url = back.splat.replace( /capture(-[a-z0-9]+)?\.sog$/i, `capture-${pick}.sog` );

				}

			} catch ( err ) {}

			const res = await fetch( url );
			if ( ! res.ok ) throw new Error( `${res.status} ${res.statusText}` );
			const bytes = new Uint8Array( await res.arrayBuffer() );
			if ( disposed ) return;

			const m = new SplatMesh( { fileBytes: bytes, fileType: 'pcsogszip' } );
			await m.initialized;
			if ( disposed ) { try { m.dispose && m.dispose(); } catch ( e ) {} return; }

			sparkFor( scene, ctx.renderer, typeof ctx.getCamera === 'function' ? ctx.getCamera() : null );
			m.quaternion.set( ROT[ 0 ], ROT[ 1 ], ROT[ 2 ], ROT[ 3 ] );
			m.name = 'wcs-splat';
			// The capture is the world, so it takes no part in the chime's own
			// lighting and casts nothing. Its shadows are already in its colours.
			m.castShadow = false;
			m.receiveShadow = false;
			mesh = m;
			// Before applyDetail, and read off the mesh rather than off the
			// packed array's length: maxSplats is rounded up to a texture-tidy
			// figure (100,352 against 99,871 here) and thinning against that
			// would draw 481 splats of whatever the padding holds.
			fullSplats = m.numSplats;
			// Before applyDetail, and once. The order decides what a prefix
			// means, so it has to be settled before anything is drawn.
			spreadSplats();
			applyPose();
			applyDetail();
			scene.add( m );
			arrived = true;

		} catch ( err ) {

			note( 'place-asset-failed', err );

		}

	} )();

	// ------------------------------------------------------------------
	// Picking a gaussian to hang from.
	//
	// The two hang sliders were the plate's answer, and they are abstract in a
	// way the gesture is not: nobody thinks "I would like u = 0.38", they think
	// "there, that branch". SplatMesh implements the standard THREE.Raycaster
	// contract, so the pick is an ordinary raycast, and moving the CAPTURE so
	// the picked point arrives at the hook is Rule A again - the chime still
	// never moves.
	//
	// The mark is a DOT over the point, not a light on the gaussians. See below.
	// ------------------------------------------------------------------

	const HOOK = new THREE.Vector3( 0, 2.60, 0 );
	const raycaster = new THREE.Raycaster();
	let pickOffset = null;   // world translation that puts the pick at the hook

	// THE MARK IS A DOT AT THE POINT, NOT A LIGHT ON THE GAUSSIANS.
	//
	// It was a SplatEdit carrying one spherical SDF, recolouring whatever
	// gaussians fell inside it with add_rgba. Two things were wrong with that,
	// and only the second is a matter of taste:
	//
	//   1. An SDF catches a gaussian by its CENTRE, and this capture's centres
	//      are metres apart while the ellipsoids drawn from them are metres
	//      long. So the mark's size on screen was a property of how densely
	//      tanha's reconstruction happened to sample that bit of wood: a clear
	//      glow in dense canopy, almost nothing in thin understorey, and the
	//      radius that made the thin case visible whited out a third of the
	//      frame in the dense one. The mark could not say the same thing twice.
	//   2. A glow says "these leaves", and the question the visitor is answering
	//      is "where does it hang". A point is what they are choosing, so a
	//      point is what the mark should be (Myra, 2026-08-11).
	//
	// AND IT IS IN THE SCENE, NOT OVER IT.
	//
	// The first cut of the dot was a div positioned by projecting the hit point
	// to pixels, written that way to keep the mark away from spark after the
	// blend-mode incident this file records below. It worked and it was flat: a
	// fixed fourteen pixels whether the branch was two metres away or thirty, so
	// the one question a visitor is actually asking - how far down the path is
	// that - had no answer on screen. Myra's call, 2026-08-11: put it in real 3D
	// space.
	//
	// The old comment justified pixels by saying a world-space marker cannot
	// convey distance under an orthographic camera. That was true of this scene
	// once and is not true of it now: storybook renders PERSPECTIVE at a narrow
	// 12 degree field (STYLES.storybook.ortho is false), measured in the page as
	// camera.isOrthographicCamera === false. So a sphere of fixed world radius
	// shrinks with distance exactly as it should, and the mark finally says how
	// far away the branch is by being smaller.
	//
	// It is an ordinary Mesh with an ordinary MeshBasicMaterial, which is the
	// part that keeps the old caution intact. Nothing here is a SplatEdit and
	// nothing here reaches spark's per-frame encode - the failure that erased
	// the forest was an invalid rgbaBlendMode inside that encode, and a mesh
	// parented to the capture cannot get near it.
	//
	// PARENTED TO THE MESH, in the capture's own local space, so it travels when
	// the capture slides - which is what puts it on the top of the rope after a
	// pick rather than leaving it behind on empty air. The capture carries a
	// non-unit scale (SIZE / hang.scale, 1.33 as this ships), so the radius is
	// divided back out or the mark would change size with the Size slider.
	// Metres, and solved against the object rather than guessed. The suspension
	// plate is 248 mm across and is the thing a visitor is judging distances
	// next to, so the core is about a twelfth of it: measured in the page at the
	// shipped framing that is a 10 px dot beside a 55 px plate, which reads as a
	// point rather than as a second object. The first cut was 0.075 and came out
	// as an amber ball the size of the plate itself.
	const DOT_R = 0.022;      // metres, the solid core
	const HALO_R = 1.8;       // multiples of the core

	let dot = null;
	let dotGeo = null;
	let dotMat = null;
	let haloMat = null;
	const _local = new THREE.Vector3();
	// Where a landed pick leaves the chosen point: the top of the rope, on the
	// axis the hook is welded to. Reused rather than allocated, same rule as
	// every other scratch vector in this file.
	const _hung = new THREE.Vector3();

	function ensureDot() {

		if ( dot || ! mesh ) return;
		try {

			// One sphere, drawn twice. The core is depth-tested, so a leaf in
			// front of the chosen point covers it and the mark reads as being IN
			// the wood rather than painted on the front of it - which is the whole
			// reason for moving it into the scene. The halo is not, so a point
			// behind a near frond still shows where it is instead of disappearing
			// and reading as "there is nothing here to click". Between them the
			// mark is never lost and never lies about depth.
			// TRANSPARENT AT FULL OPACITY, WHICH IS NOT A CONTRADICTION - it is
			// what puts the mark in the pass that runs AFTER the capture. three.js
			// draws every opaque object first and every transparent one after, and
			// a SplatMesh is transparent by construction, so an opaque dot was
			// drawn and then had a hundred thousand alpha-blended gaussians laid
			// over the top of it. Measured at the dot's own centre pixel: the
			// marker asked for rgb(224,145,47) and the frame came back with
			// rgb(69,60,17), a third of its colour, sitting behind the forest it
			// was pointing at. renderOrder puts it after the splats within that
			// pass. (The cords in scene.js were moved the opposite way across this
			// same line, and for the same reason.)
			dotGeo = new THREE.SphereGeometry( 1, 16, 12 );
			dotMat = new THREE.MeshBasicMaterial( {
				color: 0xe0912f, depthWrite: false, transparent: true, opacity: 1
			} );
			haloMat = new THREE.MeshBasicMaterial( {
				color: 0xe0912f, depthWrite: false, depthTest: false,
				transparent: true, opacity: 0.25
			} );

			dot = new THREE.Mesh( dotGeo, dotMat );
			// After the capture, so the blend lands on top of the gaussians rather
			// than under whatever spark drew last.
			dot.renderOrder = 20;
			dot.castShadow = false;
			dot.receiveShadow = false;

			const halo = new THREE.Mesh( dotGeo, haloMat );
			halo.scale.setScalar( HALO_R );
			halo.renderOrder = 19;
			halo.castShadow = false;
			halo.receiveShadow = false;
			dot.add( halo );

			dot.visible = false;
			mesh.add( dot );

		} catch ( err ) {

			note( 'splat-dot-failed', err );
			dot = null;

		}

	}

	/**
	 * SHOWN MEANS CLICKABLE, AND IT HAS TO KEEP MEANING THAT.
	 *
	 * The mark this replaces was moved on a hit and left alone on a miss, so
	 * sweeping the pointer off the foliage stranded it wherever it last landed.
	 * The visitor then saw a mark sitting in open air with the pointer on it, so
	 * they clicked it, and nothing happened, because there was nothing under the
	 * pointer to pick. That is the whole of "some white clusters don't move the
	 * chime": the mark was stale, not unclickable.
	 *
	 * Hover and the pick run the same raycast against the same gaussians, so
	 * showing on a hit and HIDING on a miss makes the dot an honest promise - if
	 * it is up, a click takes it, and if nothing appears there is nothing there.
	 * Which is worth the care here, because a gaussian is drawn as a soft
	 * ellipsoid metres across while the ray tests its centre: the capture paints
	 * a good deal further than it can be picked, and the frame has real regions
	 * that look like forest and contain no reconstruction at all. Measured on
	 * one moved capture: 217 of 840 sampled points returned no hit, in a clean
	 * diagonal band that is the edge of the capture's own volume.
	 *
	 * @param {THREE.Vector3} worldPoint
	 */
	function showDot( worldPoint ) {

		ensureDot();
		if ( ! dot || ! mesh ) return;

		_local.copy( worldPoint );
		mesh.worldToLocal( _local );
		if ( ! Number.isFinite( _local.x ) || ! Number.isFinite( _local.y ) || ! Number.isFinite( _local.z ) ) {

			hideDot();
			return;

		}

		dot.position.copy( _local );
		// Out of the parent's scale, so the mark is DOT_R metres of world however
		// big the capture has been drawn.
		const s = Math.abs( mesh.scale.x ) > 1e-6 ? mesh.scale.x : 1;
		dot.scale.setScalar( DOT_R / s );
		dot.visible = true;
		dot.updateMatrixWorld( true );

	}

	function hideDot() {

		if ( dot ) dot.visible = false;

	}

	/**
	 * ONE ANSWER TO "WHAT IS UNDER THE POINTER", USED BY BOTH THE HOVER AND THE
	 * CLICK - because the moment they each work it out for themselves, the mark
	 * starts promising things the click refuses.
	 *
	 * It did. Hover raycast and stopped; the pick raycast AND applied the reach
	 * cap, so every point past the cap lit up white and then did nothing when it
	 * was clicked. Measured with the eye swung round to look DOWN the path
	 * rather than across it, which is where the far scenery is: at bearing 352
	 * that was 46 of 72 lit points, at 172 it was 33 of 85. From the shipped
	 * bearing it never happened once, which is how it was missed.
	 *
	 * THE CAP IS PER PICK, AND IT IS THE CAPTURE'S OWN SIZE.
	 *
	 * It used to measure the capture's total displacement from its authored
	 * pose, which turns an outlier guard into a leash: picks compose, so walking
	 * the chime along the path spends the allowance a metre at a time and the
	 * far end is unreachable even though every step of the way there was fine.
	 * What it is actually guarding against - a reconstruction's stray gaussian -
	 * is a single wild jump, so a single jump is what it now measures.
	 *
	 * 35 m because that is the capture. Sampled 674 rays across six bearings and
	 * two elevations, the distance from the hook to the nearest gaussian runs
	 * p50 3.8 m, p90 10.1, p99 30.1, max 31.7 - the far end of the path really
	 * is thirty metres away, and the old 6 m cap refused 193 of those 674, or
	 * 29 percent of everything a visitor can point at. There is no gap in that
	 * distribution to put a smaller number in.
	 */
	function resolve( ndcX, ndcY, camera ) {

		if ( ! mesh || ! camera ) return null;
		mesh.raycastable = true;
		raycaster.setFromCamera( { x: ndcX, y: ndcY }, camera );
		const hits = [];
		mesh.raycast( raycaster, hits );
		if ( ! hits.length ) return null;
		hits.sort( ( a, b ) => a.distance - b.distance );
		const hit = hits[ 0 ];
		// To the TOP OF THE ROPE, not to the hook. The visitor clicked the thing
		// the chime is to hang FROM, and it hangs `cordLen` below it - so the
		// picked gaussian has to arrive one rope-length above the welded hook.
		// At cordLen 0 this is the hook exactly, which is the old behaviour.
		const t = HOOK.clone().setY( HOOK.y + cordLen ).sub( hit.point );
		const reach = Number.isFinite( back.pickReach ) ? back.pickReach : 35.0;
		return { hit, t, reach, outOfReach: t.length() > reach };

	}

	// Click to pick, drag to orbit. The distinction is the whole reason this is
	// wired here rather than as a mode: a visitor who wants to look around must
	// not have to remember which one they are in. A press that travels more than
	// a few pixels, or lasts longer than a moment, is a camera move and is left
	// entirely alone.
	// The CANVAS, not the container, and in the capture phase. OrbitControls
	// binds to the renderer's own element and captures the pointer for the
	// duration of a drag; a listener on the parent in the bubble phase is at the
	// mercy of that. Capture on the same element sees every press first.
	// WINDOW, capture phase. The canvas was one step better than the container
	// and still not enough: OrbitControls captures the pointer for the duration
	// of a press, and anything between it and us can swallow a release. window
	// in capture sees every press before any element does, and the hit test
	// below decides whether it was ours - which is the correct order anyway.
	const el = ( typeof window !== 'undefined' ) ? window : null;
	const canvas = ( ctx.renderer && ctx.renderer.domElement ) || ctx.container;
	let downAt = null;
	let downT = 0;
	let downArmed = false;

	function onDown( e ) {

		if ( e.button !== undefined && e.button !== 0 ) { downAt = null; return; }
		if ( e.target !== canvas ) { downAt = null; return; }   // chrome, not the picture
		downAt = { x: e.clientX, y: e.clientY };
		downT = performance.now();
		// Armed at PRESS, not at release. P3's light dismiss closes the open
		// panel on any press outside it, and hang.js used to suppress that for
		// presses it claimed - which it no longer does, because its drag went
		// with the sliders. So by the time pointerup runs the panel is already
		// hidden and a release-time check says "not armed" for every single
		// click. Measured: picked went false the moment the sliders came out.
		downArmed = pickArmed();
		// And claim the press, so the panel is still open for the NEXT one.
		//
		// Arming at press made one pick work and left the panel shut behind it,
		// which is a gesture you get exactly one of - hover stopped marking, and
		// a second click did nothing, because pickArmed() reads the panel. The
		// same flag hang.js uses for its chime drag says "this press belongs to
		// the open panel"; slots.js's light dismiss honours it and closes
		// nothing. While Hang is open the picture IS the panel's control, so a
		// press on it is not a press outside. Done, Escape and the pill still
		// close, which is every exit a visitor reaches for.
		//
		// This listener is on window and slots.js's is on document, both in the
		// capture phase, so window sees the event first and the flag is already
		// set by the time the dismiss looks at it.
		if ( downArmed ) e.wcsKeepPanel = 'hang';

	}

	// Hover. A dot lands on the point under the pointer while the Hang panel is
	// open, so it is obvious where a click would hang the chime, and it goes out
	// the moment the pointer is over nothing - see showDot for why that second
	// half is the whole of the reported bug.
	//
	// Throttled to one raycast every other frame's worth of time - a raycast
	// against 100k gaussians is not free. Timed in the open page at 15.3 ms per
	// cast, which is a quarter of the main thread at this interval and the
	// reason there is no widening search around a miss: a ring of eight offsets
	// would cost 120 ms per sample, and it only recovered 50 of 217 dead points
	// anyway, all of them within a few pixels of foliage that was already
	// pickable.
	let hoverAt = 0;

	function onMove( e ) {

		// NOT A POINTER. slots.js pokes window with a synthetic pointermove twice
		// a second while a panel is open, to hold off the HUD's idle fade (H20),
		// and it tags them for exactly this reason. They carry no position and
		// they are dispatched AT window, so `e.target` is window rather than the
		// canvas - which put the dot out every 500 ms the moment the two `return`s
		// below started hiding it. Measured: opacity caught mid-fade at 0.18 on a
		// dot that had been correctly placed a second earlier.
		if ( e.__wcsSynthetic ) return;

		// Both of these used to be a bare `return`, which left the dot up. The
		// panel closing, or the pointer arriving on the panel itself, is exactly
		// the stranded-mark case showDot is written against: a mark over the
		// picture while nothing is listening for a click on the picture.
		if ( ! mesh || ! pickArmed() ) { hideDot(); return; }
		if ( e.target !== canvas ) { hideDot(); return; }
		const now = performance.now();
		if ( now - hoverAt < 60 ) return;
		hoverAt = now;
		const cam = typeof ctx.getCamera === 'function' ? ctx.getCamera() : null;
		if ( ! cam ) return;
		const r = canvas.getBoundingClientRect();
		const ndcX = ( ( e.clientX - r.left ) / r.width ) * 2 - 1;
		const ndcY = - ( ( e.clientY - r.top ) / r.height ) * 2 + 1;
		try {

			const r2 = resolve( ndcX, ndcY, cam );
			if ( ! r2 || r2.outOfReach ) { hideDot(); return; }
			showDot( r2.hit.point );

		} catch ( err ) { hideDot(); }

	}

	function onUp( e ) {

		if ( ! downAt || ! mesh ) { downAt = null; return; }
		const dx = e.clientX - downAt.x, dy = e.clientY - downAt.y;
		const moved = Math.sqrt( dx * dx + dy * dy );
		const held = performance.now() - downT;
		downAt = null;
		if ( moved > 5 || held > 500 ) return;      // that was a camera move
		if ( ! downArmed ) return;

		const r = canvas.getBoundingClientRect();
		const ndcX = ( ( e.clientX - r.left ) / r.width ) * 2 - 1;
		const ndcY = - ( ( e.clientY - r.top ) / r.height ) * 2 + 1;
		const cam = typeof ctx.getCamera === 'function' ? ctx.getCamera() : null;
		const hit = handle.pick( ndcX, ndcY, cam );
		if ( hit && typeof onPick === 'function' ) onPick( hit );

	}

	/**
	 * Only while the Hang panel is open. The landing frame is the one place on
	 * this page that asks nothing of the visitor, and a click there already
	 * means "start the sound" - it may not also silently move the forest.
	 */
	function pickArmed() {

		return !! document.querySelector( '.wcs-panel[data-slot="hang"]:not([hidden])' );

	}

	let onPick = null;

	if ( el ) {

		el.addEventListener( 'pointerdown', onDown, { passive: true, capture: true } );
		el.addEventListener( 'pointermove', onMove, { passive: true, capture: true } );
		el.addEventListener( 'pointerup', onUp, { passive: true, capture: true } );

	}

	const handle = {

		kind: 'splat',

		/** Called with {point, distance} whenever a pick lands. */
		onPick( fn ) { onPick = fn; },

		/**
		 * @param {number} ndcX -1..1
		 * @param {number} ndcY -1..1
		 * @param {THREE.Camera} camera
		 * @returns {{point:number[], distance:number}|null}
		 */
		pick( ndcX, ndcY, camera ) {

			if ( ! mesh || ! camera ) return null;
			try {

				const r2 = resolve( ndcX, ndcY, camera );
				if ( ! r2 ) { hideDot(); return null; }
				if ( r2.outOfReach ) {

					note( 'splat-pick-out-of-reach', new Error(
						`picked point is ${r2.t.length().toFixed( 1 )} m from the hook, cap is ${r2.reach}` ) );
					// The dot goes out, which says the same thing to the visitor:
					// the spot they are pointing at is not one they can have. The
					// hover applies the same test, so in practice nothing was up
					// here to put out.
					hideDot();
					return null;

				}

				const hit = r2.hit;

				// Move the capture so the picked gaussian arrives at the hook.
				//
				// Off the BASE, not off mesh.position. mesh.position is the base
				// plus the u/v nudge, and applyPose adds that nudge again on the
				// way out - so writing a whole live position into pickOffset
				// counted it twice, and on this place, where v defaults to 0.4,
				// that is 0.28 m of unasked-for lift per pick. Composing on the
				// base means two picks in a row land where the second one was
				// aimed rather than 0.56 m above it.
				const from = pickOffset || { x: POS[ 0 ], y: POS[ 1 ], z: POS[ 2 ] };
				const want = new THREE.Vector3( from.x + r2.t.x, from.y + r2.t.y, from.z + r2.t.z );

				// The capture moves. The camera does not, and must not.
				//
				// Four earlier attempts also shifted the eye and its target by
				// the same vector, on the reasoning that holding the forest
				// still on screen would read as the CHIME travelling. Two things
				// were wrong with that. The forest was not disappearing because
				// of the translation at all - see the blend-mode note above, the
				// hover mark was killing the whole capture - and moving the eye
				// is what put it in reach of the writers that undo it. A camera
				// left where the pick put it is a camera applyFraming re-aims on
				// the next resize and OrbitControls re-clamps on the next drag,
				// and either one leaves the eye somewhere the capture is not.
				//
				// Translating only the capture needs none of them. The picked
				// gaussian lands ON the hook, which sits at the middle of the
				// frame the camera is already looking at, so a successful pick
				// puts the thing that was clicked at the centre of the shot by
				// construction. "The forest stays visible" is not a thing to
				// maintain afterwards; it is what the operation does.
				//
				// The 45 units the last attempt measured is not drift either.
				// The eye stands 40 units back from the target because an ortho
				// eye is a direction, and the capture sits 9.15 m beyond it: 45
				// is where a correctly placed capture IS.
				pickOffset = { x: want.x, y: want.y, z: want.z };
				applyPose();

				// And follow the point the visitor chose to where it now is. The
				// pick puts the picked gaussian one rope-length above the welded
				// hook, so the dot lands on the top of the rope - the same spot
				// on the same branch, which is what makes the translation read as
				// the chime having moved to it rather than as the wood jumping.
				// After applyPose, because it is the pose that decides where the
				// hook's rope-top is on screen.
				_hung.set( 0, HOOK.y + cordLen, 0 );
				showDot( _hung );

				return { point: hit.point.toArray(), distance: hit.distance };

			} catch ( err ) {

				note( 'splat-pick-failed', err );
				return null;

			}

		},

		/** Forget the picked point and go back to the authored pose. */
		clearPick() {

			pickOffset = null;
			hideDot();
			applyPose();

		},

		picked() {

			return !! pickOffset;

		},

		/**
		 * @param {number} fraction 0..1 of the capture's gaussians to draw.
		 * Stored even when the mesh has not landed yet, because the design
		 * applies long before 11.4 MB of .sog does.
		 */
		setDetail( fraction ) {

			if ( ! Number.isFinite( fraction ) ) return;
			detail = Math.min( 1, Math.max( 0, fraction ) );
			applyDetail();

		},

		/**
		 * @param {number} metres of rope between the chime's eye and the thing
		 * it hangs from. Moves the CAPTURE, never the chime (Rule A): a longer
		 * rope lifts the wood so the branch ends up further above a hook that
		 * has not moved.
		 */
		/**
		 * Follow the ring, once per rendered frame.
		 *
		 * There is no wind heuristic left in here. The rope and the ring are both
		 * in the rig now - a static anchor at the branch, a cord down to a ring
		 * particle, the bridle hanging off that - so the wind reaches them the
		 * same way it reaches the tubes, through physics.js, and this only has to
		 * put the drawn eye where the solver left it.
		 *
		 * @param {number[]} ringPos world position of the ring particle, or null
		 *                           if the rig has not reported one yet.
		 */
		frame( dt, ringPos ) {

			if ( ! hanger || ! ringPos ) return;
			placeEye( ringPos[ 0 ], ringPos[ 1 ], ringPos[ 2 ] );

		},

		setCord( metres ) {

			if ( ! Number.isFinite( metres ) ) return;
			const next = Math.max( 0, metres );
			// Carry a live pick with the change. pickOffset holds the base that
			// puts the picked gaussian `cordLen` above the hook, so lengthening
			// the rope by d has to lift that base by d or the branch stays where
			// it was while physics.js moves its anchor a rope's length up - and
			// the chime hangs off a point in the wood with nothing drawn at it.
			// Nothing to carry when the visitor has not picked anything.
			if ( pickOffset ) pickOffset.y += next - cordLen;
			cordLen = next;
			applyPose();

		},

		setFraming( nu, nv, ns ) {

			if ( Number.isFinite( nu ) ) u = nu;
			if ( Number.isFinite( nv ) ) v = nv;
			if ( Number.isFinite( ns ) ) scale = ns;
			applyPose();

		},

		limits() {

			return {
				u: place.hang.uRange.slice(),
				v: place.hang.vRange.slice(),
				scale: place.hang.scaleRange.slice(),
				// A splat has no crop. hx/hy are the HALF-MARGIN a plate has to keep
				// so its frame stays inside the image, and hang.js subtracts them
				// from the authored range to get what is reachable. Reporting 0.5
				// - half the frame - collapsed that range to a single point, and
				// every control in the Hang panel fell through to the porch's
				// disabled state with the porch's reason printed under it.
				// A capture has no edge to fall off, so the margin is zero.
				crop: [ 0.5, 0.5, 0, 0 ]
			};

		},

		framing() {

			return { u, v, scale };

		},

		/** Nothing here depends on the viewport; the camera does the work. */
		resize() {},

		loaded() {

			return arrived;

		},

		dispose() {

			disposed = true;
			// The mark is a child of the capture, so removing the mesh below takes
			// it out of the scene - but three disposes nothing by itself, and a
			// geometry and two materials per place switch is a leak in a tab left
			// open all day.
			if ( dot ) {

				if ( dot.parent ) dot.parent.remove( dot );
				dot = null;

			}
			if ( dotGeo ) { dotGeo.dispose(); dotGeo = null; }
			if ( dotMat ) { dotMat.dispose(); dotMat = null; }
			if ( haloMat ) { haloMat.dispose(); haloMat = null; }
			if ( el ) {

				el.removeEventListener( 'pointerdown', onDown, true );
				el.removeEventListener( 'pointermove', onMove, true );
				el.removeEventListener( 'pointerup', onUp, true );

			}
			if ( mesh ) {

				scene.remove( mesh );
				try { mesh.dispose && mesh.dispose(); } catch ( err ) { note( 'splat-dispose-failed', err ); }
				mesh = null;

			}
			if ( hanger ) {

				scene.remove( hanger );
				for ( const g of hanger.userData.geoms ) g.dispose();
				for ( const m of hanger.userData.mats ) m.dispose();

			}
			// The SparkRenderer stays. It belongs to the scene, not to this place,
			// and scene.js's own dispose() takes the scene down with it.

		}

	};

	return handle;


}
