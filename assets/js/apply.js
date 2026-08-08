/**
 * apply.js - the one place a design becomes a running chime.
 *
 * Everything else reads the design. This file is the only thing that writes
 * into `params`, and it MUTATES IT IN PLACE, always. Four subsystems captured
 * that object by reference when they were constructed - wind.js:164,
 * scene.js:474, windviz.js:119, audio.js:40 - and audio.js dereferences
 * params.decay/attack/loudness inside every single strike. Reassigning params
 * orphans all four at once, and the failure is silent: the DOM and the snapshot
 * both show the new values while the picture and the sound never move. That is
 * hazard H1 and it is the reason this file exists as a file.
 *
 * The other three hazards that shape the body below:
 *
 *   H8  applyParts() in main.js is debounced 80 ms. applyDesign is specified to
 *       be synchronous - a caller reads snapshot() on the very next line - so it
 *       calls rebuildChime() directly and never applyParts().
 *   H10 audio.setTubes() resets every per-tube contact tracker and does not stop
 *       voices that are already ringing. Push once, at the END of an apply.
 *       Pushing per changed field silently breaks contact damping.
 *   H11 A rig rebuilt without pushTubesToAudio() leaves audio's per-tube arrays
 *       shorter than the tube count, and damping stops on every index past the
 *       old one. rebuildChime() ends in that push, which is why the rebuild path
 *       must not push again.
 *
 * apply.js is imported by main.js and by nothing else. The other five pieces
 * reach it through window.__wcs.
 */

import { clampDesign, mergeDesign, DESIGN_DEFAULTS } from './design.js';

// ---------------------------------------------------------------------------
// The live design.
//
// The design is the state; params is a projection of it. Deriving the design
// back out of params would be lossy - place, hang, wind.source and every
// "null means the place decides" field have no params equivalent - so the
// object itself is held here and params is written from it, one direction only.
// ---------------------------------------------------------------------------

let live = clampDesign( DESIGN_DEFAULTS );

export function currentDesign() {

	return live;

}

/**
 * Boot only: seat the decoded design without touching a subsystem, because at
 * WCS:DESIGN-BOOT time none of them exist yet. Returns the clamped design.
 */
export function setBaseDesign( design ) {

	live = clampDesign( design );
	return live;

}

// ---------------------------------------------------------------------------
// Subscribers.
//
// Two lists, mark-and-sweep so an unsubscribe during a callback cannot make the
// loop skip its neighbour, and so the steady-state emit allocates nothing. The
// frame list is walked once per rendered frame; a splice per unsubscribe would
// be fine, but compacting lazily keeps the hot path a plain indexed for-loop.
// ---------------------------------------------------------------------------

function makeHub() {

	return { list: [], holes: 0 };

}

const designHub = makeHub();
const frameHub = makeHub();

function subscribe( hub, fn ) {

	if ( typeof fn !== 'function' ) return () => {};
	hub.list.push( fn );
	let done = false;
	return function unsubscribe() {

		if ( done ) return;
		done = true;
		const i = hub.list.indexOf( fn );
		if ( i !== - 1 ) {

			hub.list[ i ] = null;
			hub.holes ++;

		}

	};

}

function compact( hub ) {

	if ( hub.holes === 0 ) return;
	const kept = [];
	for ( let i = 0; i < hub.list.length; i ++ ) if ( hub.list[ i ] ) kept.push( hub.list[ i ] );
	hub.list = kept;
	hub.holes = 0;

}

function emit( hub, arg, tag, note ) {

	compact( hub );
	const list = hub.list;
	for ( let i = 0; i < list.length; i ++ ) {

		const fn = list[ i ];
		if ( ! fn ) continue;
		try {

			fn( arg );

		} catch ( err ) {

			// A UI piece that throws loses its callback and nothing else. The loop
			// and the chime are not negotiable.
			if ( typeof note === 'function' ) note( tag, err );

		}

	}

}

/** (design) => void, called after every apply. Returns an unsubscribe. */
export function onDesign( fn ) {

	return subscribe( designHub, fn );

}

/** (dtSec) => void, called from WCS:FRAME-HOOK. Returns an unsubscribe. */
export function onFrame( fn ) {

	return subscribe( frameHub, fn );

}

export function emitDesign( design, note ) {

	emit( designHub, design, 'design-subscriber-failed', note );

}

export function emitFrame( dtSec, note ) {

	emit( frameHub, dtSec, 'frame-subscriber-failed', note );

}

// ---------------------------------------------------------------------------
// design -> params
// ---------------------------------------------------------------------------

/**
 * Copy every design field that has a params equivalent, IN PLACE. No subsystem
 * is touched, nothing is rebuilt, nothing is pushed. Safe to call at
 * WCS:DESIGN-BOOT, before wind, the rig, the stage, the viz and audio exist -
 * which is the whole point: they are then constructed FROM the shared design
 * rather than rebuilt into it afterwards.
 *
 * A null on sun, mph, dirDeg or turbulence means "the place decides", so those
 * fields are left exactly as they were rather than being written as zero.
 *
 * @param {object} design any partial; clamped here, so this is total.
 * @param {object} params main.js's params object. MUTATED, never replaced.
 * @returns {object} the clamped design that was written.
 */
export function foldIntoParams( design, params ) {

	const d = clampDesign( design );
	if ( params === null || typeof params !== 'object' ) return d;

	params.scaleName = d.tubes.scale;
	params.noteCount = d.tubes.notes;
	params.stockName = d.tubes.stock;

	params.clapperWidth = d.clapper.width;
	params.clapperMass = d.clapper.mass;
	params.clapperDrop = d.clapper.drop;
	params.sailMass = d.sail.mass;
	params.sailHeight = d.sail.height;

	params.attack = d.voice.attack;
	params.decay = d.voice.decay;
	params.loudness = d.voice.loudness;

	params.quality = d.view.quality;

	if ( d.view.sun !== null ) params.sunElevDeg = d.view.sun;
	if ( d.wind.mph !== null ) params.windSpeedMph = d.wind.mph;
	if ( d.wind.dirDeg !== null ) params.dirDeg = d.wind.dirDeg;
	if ( d.wind.turbulence !== null ) params.turbulence = d.wind.turbulence;

	return d;

}

// The fields whose change means the rig has to be built again. Scale and note
// count change the tube list; every part changes a particle mass, a cord rest
// length or the collision radius. Stock is NOT here: it reaches audio only
// (H9), so it is a push and not a rebuild.
function needsRebuild( a, b ) {

	return a.tubes.scale !== b.tubes.scale ||
		a.tubes.notes !== b.tubes.notes ||
		a.clapper.width !== b.clapper.width ||
		a.clapper.mass !== b.clapper.mass ||
		a.clapper.drop !== b.clapper.drop ||
		a.sail.mass !== b.sail.mass ||
		a.sail.height !== b.sail.height;

}

function call( ctx, name, note, a, b, c ) {

	const fn = ctx[ name ];
	if ( typeof fn !== 'function' ) return undefined;
	try {

		return fn( a, b, c );

	} catch ( err ) {

		if ( typeof note === 'function' ) note( 'design-' + name.toLowerCase() + '-failed', err );
		return undefined;

	}

}

/**
 * Fold a partial design into the live one and push the result all the way
 * through to the picture and the sound. Synchronous: when this returns, the rig
 * has been rebuilt, audio has the new tubes, and snapshot() is already telling
 * the truth.
 *
 * @param {object} partial the fields to change; everything else is kept.
 * @param {object} ctx the seams main.js owns. Every member is optional, so a
 *                     half-built page degrades instead of throwing:
 *                     params, noteError, setParts, rebuildChime,
 *                     pushTubesToAudio, syncControlValues, applyTier, tierFor,
 *                     sunRange, setWeather, setPlace, setFraming.
 * @returns {object} the full clamped design now in force.
 */
export function applyDesign( partial, ctx ) {

	const c = ( ctx !== null && typeof ctx === 'object' ) ? ctx : {};
	const note = typeof c.noteError === 'function' ? c.noteError : null;
	const before = live;
	const d = clampDesign( mergeDesign( before, partial ) );
	const params = ( c.params !== null && typeof c.params === 'object' ) ? c.params : null;

	const rebuild = needsRebuild( d, before );
	const stockChanged = d.tubes.stock !== before.tubes.stock;

	// 1. Place first. A place owns the sun range, the hang ranges and the
	//    authored wind, so everything below has to read a settled place. The
	//    hook is P4's, through the stage; until places.js lands it is absent and
	//    this is a no-op.
	if ( d.place !== before.place ) call( c, 'setPlace', note, d.place );

	// 2. Every field with a params equivalent, in place (H1).
	if ( params ) foldIntoParams( d, params );

	// 3. The sun's legal range is place-dependent - 2..20 with a sky, 26..74
	//    without - so a shared elevation has to be re-clamped against the place
	//    that is actually up (H12). A null hands it back to the place.
	if ( params ) {

		if ( d.view.sun === null ) {

			const fallback = call( c, 'defaultSun', note );
			if ( Number.isFinite( fallback ) ) params.sunElevDeg = fallback;

		} else {

			const range = call( c, 'sunRange', note );
			if ( Array.isArray( range ) && range.length === 2 ) {

				params.sunElevDeg = Math.min( Math.max( d.view.sun, range[ 0 ] ), range[ 1 ] );

			}

		}

	}

	// 4. Parts, before the rebuild: masses, cord rest lengths and the collision
	//    radius are all read while the rig is assembled. physics.js clamps and
	//    hands back what is actually in force, and that echo is merged back so a
	//    value the rig refused never lingers in params or in the UI.
	if ( rebuild && params ) {

		const echo = call( c, 'setParts', note, params );
		if ( echo !== null && typeof echo === 'object' ) Object.assign( params, echo );

	}

	// 5. The rig, the picture and the tubes audio voices - one ordered call.
	//    rebuildChime() is the DIRECT path on purpose: applyParts() is debounced
	//    80 ms (H8) and would leave a caller reading a chime one apply behind.
	//    rebuildChime ends in pushTubesToAudio (H11), so the rebuild branch must
	//    not push a second time - setTubes() resets every contact tracker (H10).
	if ( rebuild ) call( c, 'rebuildChime', note );
	else if ( stockChanged ) call( c, 'pushTubesToAudio', note );

	// 6. Quality. Never by re-detecting: a second probe context is one more than
	//    a capped page can spare, and the one it drops is the real renderer's
	//    (H35). tierFor() resolves 'auto' from the probe run once at boot.
	if ( d.view.quality !== before.view.quality ) {

		const next = call( c, 'tierFor', note, d.view.quality );
		if ( next ) call( c, 'applyTier', note, next );

	}

	// 7. Hanging is plate framing and nothing else. The chime never moves: the
	//    rig hangs at physics.js HOOK_X/Y/Z forever and scene.js's chime Group
	//    stays at identity (Rule A, CONTRACTS section 5.3). P5 supplies the hook
	//    through the stage.
	if ( d.hang.u !== before.hang.u || d.hang.v !== before.hang.v || d.hang.scale !== before.hang.scale ) {

		call( c, 'setFraming', note, d.hang.u, d.hang.v, d.hang.scale );

	}

	// 8. Wind. An explicit speed or bearing goes through wind.js's 8 second ramp
	//    rather than being written straight into params, so the chime eases into
	//    a shared breeze instead of being kicked by it. Turbulence has no ramp;
	//    foldIntoParams already wrote it.
	if ( d.wind.mph !== before.wind.mph || d.wind.dirDeg !== before.wind.dirDeg ) {

		if ( d.wind.mph !== null || d.wind.dirDeg !== null ) {

			call( c, 'setWeather', note,
				d.wind.mph === null ? ( params ? params.windSpeedMph : 0 ) : d.wind.mph,
				d.wind.dirDeg === null ? ( params ? params.dirDeg : 270 ) : d.wind.dirDeg );

		}

	}

	// 9. The controls last, so every readout reflects what is actually in force
	//    including anything physics.js clamped on the way through.
	call( c, 'syncControlValues', note );

	live = d;

	// 10. And only now the subscribers, reading a settled page.
	emitDesign( d, note );

	return d;

}
