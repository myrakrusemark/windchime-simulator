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

function sparkFor( scene, renderer ) {

	let s = renderers.get( scene );
	if ( s ) return s;
	s = new SparkRenderer( { renderer } );
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
 * HOOK_Y is 2.60, mirrored from physics.js, which is read-only here.
 */
function buildCordHanger( spec ) {

	const g = new THREE.Group();
	g.name = 'wcs-hanger';
	const geoms = [];
	const mats = [];
	const HOOK_Y = 2.60;
	const z = spec.z || 0;

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
	eye.position.set( 0, HOOK_Y + eyeR * 0.55, z );
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
	// Rising from the TOP of the ring, not from its centre.
	cord.position.set( 0, HOOK_Y + eyeR * 0.55 + eyeR + len / 2, z );
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
		mesh.position.set( POS[ 0 ] + dx, POS[ 1 ] + dy, POS[ 2 ] );
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
			const res = await fetch( back.splat );
			if ( ! res.ok ) throw new Error( `${res.status} ${res.statusText}` );
			const bytes = new Uint8Array( await res.arrayBuffer() );
			if ( disposed ) return;

			const m = new SplatMesh( { fileBytes: bytes, fileType: 'pcsogszip' } );
			await m.initialized;
			if ( disposed ) { try { m.dispose && m.dispose(); } catch ( e ) {} return; }

			sparkFor( scene, ctx.renderer );
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

	return {

		kind: 'splat',

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
				// A splat has no crop, so the reach is the authored range with no
				// margin taken out of it for a frame edge that does not exist.
				crop: [ 0.5, 0.5, 0.5, 0.5 ]
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

}
