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
import { SplatMesh, SparkRenderer, SplatEdit, SplatEditSdf } from './vendor-spark.js';

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
function buildCordHanger( spec ) {

	const g = new THREE.Group();
	g.name = 'wcs-hanger';
	const geoms = [];
	const mats = [];
	const HOOK_X = 0.0, HOOK_Y = 2.60, HOOK_Z = 0.0;

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

	// About two feet, which is what Myra asked for and also about as far as a
	// rope reads before the eye wants to know what is holding it.
	const len = Number.isFinite( spec.cordLength ) ? spec.cordLength : 0.61;
	const cordGeo = new THREE.CylinderGeometry( 0.0035, 0.0035, len, 6 );
	geoms.push( cordGeo );
	const cordMat = new THREE.MeshStandardMaterial( {
		color: spec.cordColor === undefined ? 0xcfc3ad : spec.cordColor,
		roughness: 0.9, metalness: 0
	} );
	mats.push( cordMat );
	const cord = new THREE.Mesh( cordGeo, cordMat );
	// Rising from the TOP of the ring, not from its centre, and plumb over the
	// hook - a rope that hangs a chime does not lean.
	cord.position.set( HOOK_X, HOOK_Y + eyeR * 0.55 + eyeR + len / 2, HOOK_Z );
	cord.castShadow = true;
	g.add( cord );

	g.userData.geoms = geoms;
	g.userData.mats = mats;
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

	const hanger = place.hanger === null ? null : buildCordHanger( place.hanger || {} );
	if ( hanger ) scene.add( hanger );

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

	function applyPose() {

		if ( ! mesh ) return;
		// u/v run 0..1 with 0.5 as centred; convert to a signed offset in metres.
		const dx = ( 0.5 - u ) * 2 * reach.x;
		const dy = ( v - 0.5 ) * 2 * reach.y;
		// A picked hang point wins over the authored pose: the visitor said
		// where, and the sliders go back to being a nudge around it.
		const base = pickOffset || { x: POS[ 0 ], y: POS[ 1 ], z: POS[ 2 ] };
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
			applyPose();
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
	// The white mark is a SplatEdit carrying one spherical SDF. It recolours
	// the gaussians inside it rather than drawing anything on top, so what
	// lights up is the actual thing that was picked.
	// ------------------------------------------------------------------

	const HOOK = new THREE.Vector3( 0, 2.60, 0 );
	const raycaster = new THREE.Raycaster();
	let edit = null;
	let sdf = null;
	let pickOffset = null;   // world translation that puts the pick at the hook

	// THE MARK, AND THE ONE-WORD BUG THAT ERASED THE FOREST.
	//
	// rgbaBlendMode was 'mix', which is not a blend mode spark has. SplatEdit's
	// constructor takes the string without looking at it, and the throw comes
	// later and somewhere else: rgbaBlendModeToNumber runs inside the per-frame
	// edit encode, so `Unknown blend mode: mix` was raised on EVERY FRAME from
	// the moment the first hover built the mark - and it aborted the frame
	// update that hands spark its splat data, so the entire capture stopped
	// drawing. That is the whole of "the forest disappears". It was never the
	// pick's arithmetic, never keepTopInShot, never applyFraming: hovering one
	// gaussian erased 99,871 of them, and clicking erased them because a click
	// builds the same mark.
	//
	// Measured in the open page: 1860 console errors, all this one, and the
	// forest came back the instant the edit was removed from the mesh. The three
	// spark accepts are 'multiply', 'set_rgb' and 'add_rgba'.
	//
	// WHY add_rgba AND NOT set_rgb, WHICH IS THE ONE THAT MEANS "PAINT IT WHITE"
	//
	// Because an SDF catches a gaussian by its CENTRE, and this capture's
	// centres are metres apart while the ellipsoids drawn from them are metres
	// long. A sphere small enough to mean "that spot" contains few centres or
	// none, and set_rgb keeps each one's alpha - so recolouring two faint smears
	// changes almost nothing in the pixels they cover. Walked up against two
	// fixed hovers, one in dense canopy and one in thin understorey: set_rgb at
	// 0.16 and 0.40 was invisible in both, 0.55 read in the dense one and was
	// still invisible in the thin one, and 3.00 whited out the whole canopy -
	// which is what proved the mark had been working all along and only ever
	// been too small to find.
	//
	// add_rgba raises alpha as well as colour, so one caught gaussian is worth
	// seeing. That makes it strong enough to overdo: at full opacity and 0.45 it
	// threw a flare a third of the frame across over the dense hover. Opacity
	// 0.6 is where both hovers land - a clear glow on canopy, a faint one on
	// thin air, which is honest, because thin air is not a branch to hang from.
	//
	// softEdge is a distance in metres either side of the SDF surface over which
	// the effect ramps, so it has to sit well under the radius or the mark is
	// all ramp: at radius 0.16 the old softEdge 0.35 meant the centre of the
	// sphere never reached full strength either.
	function ensureMark() {

		if ( edit || ! mesh ) return;
		const MARK_R = 0.45;
		sdf = new SplatEditSdf( {
			type: 'sphere',
			radius: MARK_R,
			color: new THREE.Color( 1, 1, 1 ),
			opacity: 0.6
		} );
		edit = new SplatEdit( { rgbaBlendMode: 'add_rgba', softEdge: MARK_R * 0.31, sdfs: [ sdf ] } );
		// Parented to the mesh, so the mark travels with the capture when the
		// capture slides. In mesh-local space it is a fixed point on a branch.
		mesh.add( edit );
		edit.add( sdf );

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

	}

	// Hover. A splat under the pointer goes white while the Hang panel is open,
	// so it is obvious what a click would take. Throttled to one raycast every
	// other frame's worth of time - a raycast against 100k gaussians on every
	// pointermove is not free.
	let hoverAt = 0;

	function onMove( e ) {

		if ( ! mesh || ! pickArmed() ) return;
		if ( e.target !== canvas ) return;
		const now = performance.now();
		if ( now - hoverAt < 60 ) return;
		hoverAt = now;
		const cam = typeof ctx.getCamera === 'function' ? ctx.getCamera() : null;
		if ( ! cam ) return;
		const r = canvas.getBoundingClientRect();
		const ndcX = ( ( e.clientX - r.left ) / r.width ) * 2 - 1;
		const ndcY = - ( ( e.clientY - r.top ) / r.height ) * 2 + 1;
		try {

			mesh.raycastable = true;
			raycaster.setFromCamera( { x: ndcX, y: ndcY }, cam );
			const hits = [];
			mesh.raycast( raycaster, hits );
			if ( ! hits.length ) return;
			hits.sort( ( a, b ) => a.distance - b.distance );
			ensureMark();
			if ( sdf ) {

				sdf.position.copy( mesh.worldToLocal( hits[ 0 ].point.clone() ) );
				sdf.updateMatrixWorld( true );

			}

		} catch ( err ) {}

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

				mesh.raycastable = true;
				raycaster.setFromCamera( { x: ndcX, y: ndcY }, camera );
				const hits = [];
				mesh.raycast( raycaster, hits );
				if ( ! hits.length ) return null;
				hits.sort( ( a, b ) => a.distance - b.distance );
				const hit = hits[ 0 ];

				ensureMark();
				if ( sdf ) {

					// The hit is in world space; the SDF lives under the mesh.
					sdf.position.copy( mesh.worldToLocal( hit.point.clone() ) );
					sdf.updateMatrixWorld( true );

				}

				// Move the capture so the picked gaussian arrives at the hook -
				// but not further than the place says it may travel.
				//
				// The first version of this had no clamp and the first pick
				// landed on a gaussian 37 m out, which is inside the capture's
				// tree bound and nowhere near anything a person would call a
				// branch. Bringing it to the hook dragged the whole forest with
				// it and left an empty frame. A capture has outliers; a pick
				// has to survive hitting one.
				const want = HOOK.clone().sub( hit.point ).add( mesh.position );
				const home = new THREE.Vector3( POS[ 0 ], POS[ 1 ], POS[ 2 ] );
				const travel = want.clone().sub( home );
				// Every gaussian is a real point in the capture and any of them is
				// somewhere a chime could hang, so the reach is the capture's own
				// extent rather than a polite radius around the authored pose.
				// The clamp exists only to survive the outliers a reconstruction
				// leaves scattered well outside the scene it reconstructed.
				// Back down from 30. A reconstruction scatters outliers well outside
				// the scene it reconstructed, and the ray finds them: clicking
				// what looks like open canopy hit one and carried the whole
				// forest away with it, which is what "it all disappears" was.
				// Six metres is about as far as you can see a hangable spot in
				// this capture anyway.
				const maxTravel = Number.isFinite( back.pickReach ) ? back.pickReach : 6.0;
				if ( travel.length() > maxTravel ) {

					note( 'splat-pick-out-of-reach', new Error(
						`picked point is ${travel.length().toFixed( 1 )} m from the authored pose, cap is ${maxTravel}` ) );
					if ( sdf && edit && mesh ) { mesh.remove( edit ); edit = null; sdf = null; }
					return null;

				}

				// MOVING IS OFF. The mark is not.
				//
				// Four attempts at "click a splat and the chime goes there" and
				// the forest ended up off screen every time. The maths is right -
				// translate the capture by (hook - hit), translate the eye by the
				// same, geometry preserved - and something downstream keeps
				// walking the camera back afterwards. keepTopInShot was one and
				// fixing it did not fix this, so there is at least one more:
				// applyFraming on resize and OrbitControls' own clamping are both
				// still live on a non-fixed place.
				//
				// Verified after the last try: the capture ended 45 units from
				// the eye at (-29.16, -16.75, 31.34), which is not a small drift.
				//
				// So the translation is off and picking marks only. That leaves a
				// forest you can look at and a mark that shows what a click would
				// take, instead of a build that erases the scene on first click.
				// Turning it back on is one line here plus finding the writer.
				return { point: hit.point.toArray(), distance: hit.distance };

			} catch ( err ) {

				note( 'splat-pick-failed', err );
				return null;

			}

		},

		/** Forget the picked point and go back to the authored pose. */
		clearPick() {

			pickOffset = null;
			if ( edit && mesh ) { mesh.remove( edit ); edit = null; sdf = null; }
			applyPose();

		},

		picked() {

			return !! pickOffset;

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
