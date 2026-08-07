/**
 * main.js - the wiring.
 *
 * This is the only file that touches the DOM, the only file that owns a
 * requestAnimationFrame loop, and the only file that knows all six of the
 * others exist. Everything here is orchestration: build the shared params
 * object, pick a quality tier, create the subsystems, bind the controls, and
 * then run one tick over and over in a fixed order.
 *
 * The single most important property of this file: the loop starts during
 * module evaluation, before any await and before any fetch. The picture is
 * moving the instant the page paints. The "Start Wind Chimes" button unlocks
 * audio and asks for real local weather; it does not start the simulation.
 */

import * as THREE from 'three';

import { createWind } from './wind.js';
import { createRig, freqsFor, SCALES, setParts, PART_DEFAULTS, PART_LIMITS } from './physics.js';
import { createStage } from './scene.js';
import { createWindViz } from './windviz.js';
import { createAudio } from './audio.js';
import * as weather from './weather.js';

// ---------------------------------------------------------------------------
// Defaults and tier tables
// ---------------------------------------------------------------------------

const DEFAULTS = {
	windSpeedMph: 12,      // mean wind at the 10 m reference height
	dirDeg: 270,           // meteorological FROM-bearing: 270 = from the west, blowing +X
	turbulence: 0.30,
	scaleName: 'cMajorPentatonic',
	noteCount: 6,
	attack: 0.002,
	decay: 8.0,            // T60 of the fundamental, seconds
	loudness: 0.5,
	sunElevDeg: null,     // null means "whatever the active style calls default"
	style: 'storybook',   // 'storybook' (flat, orthographic) or 'golden' (lit, perspective)
	// The adjustable parts. physics.js owns the ranges and the clamping; these
	// are only the starting values, spread in so a later default change there
	// arrives here without editing this list.
	...PART_DEFAULTS,
	quality: 'auto',
	paused: false
};

const TIERS = {
	high: {
		name: 'high',
		// A handful of long streamers, not a particle field: see the STREAMERS
		// note in windviz.js for why three reads as wind and three hundred reads
		// as snow.
		trails: 6,
		leaves: 60,
		ribbonSegs: 14,
		shadowMapSize: 2048,
		bloom: true,
		dprCap: 2.0,
		partials: 5,
		maxVoices: 32
	},
	low: {
		name: 'low',
		trails: 4,
		leaves: 22,
		ribbonSegs: 9,
		shadowMapSize: 1024,
		bloom: false,
		dprCap: 1.0,
		partials: 3,
		maxVoices: 16
	}
};

const SUBSTEP_MAX = 1 / 240;   // finest physics step; substep COUNT varies, size does not
const SUBSTEP_CAP = 24;
const DT_CAP = 0.100;          // a tab that stalls must not fire 3 seconds of physics at once
const COMPASS_16 = [ 'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
	'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW' ];

// ---------------------------------------------------------------------------
// Error log. Short string tags only, capped, deduplicated so a subsystem that
// throws every frame cannot flood the snapshot the verifier reads.
// ---------------------------------------------------------------------------

const errors = [];

function noteError( tag, err ) {

	if ( errors.length < 20 && errors.indexOf( tag ) === -1 ) errors.push( tag );
	// One console line per unique tag; enough to debug, not enough to spam.
	if ( err && ! noteError.seen[ tag ] ) {

		noteError.seen[ tag ] = true;
		console.warn( '[wcs] ' + tag, err );

	}

}
noteError.seen = Object.create( null );

const clamp = ( v, lo, hi ) => ( v < lo ? lo : ( v > hi ? hi : v ) );
const finite = ( v, fallback ) => ( Number.isFinite( v ) ? v : fallback );
const round3 = ( v ) => Math.round( finite( v, 0 ) * 1000 ) / 1000;
const vec3out = ( v ) => [ round3( v[ 0 ] ), round3( v[ 1 ] ), round3( v[ 2 ] ) ];

// ---------------------------------------------------------------------------
// 2a. Params, then URL overrides. No DOM read yet.
// ---------------------------------------------------------------------------

const params = Object.assign( {}, DEFAULTS );

let urlQuery = '';

try {

	const q = new URLSearchParams( window.location.search );
	if ( q.has( 'wind' ) ) params.windSpeedMph = clamp( finite( parseFloat( q.get( 'wind' ) ), DEFAULTS.windSpeedMph ), 0, 60 );
	if ( q.has( 'dir' ) ) {

		const d = finite( parseFloat( q.get( 'dir' ) ), DEFAULTS.dirDeg );
		params.dirDeg = ( ( d % 360 ) + 360 ) % 360;

	}

	if ( q.has( 'style' ) ) {

		const st = String( q.get( 'style' ) );
		if ( st === 'storybook' || st === 'golden' ) params.style = st;

	}

	if ( q.has( 'quality' ) ) {

		const qual = String( q.get( 'quality' ) );
		if ( qual === 'high' || qual === 'low' || qual === 'auto' ) params.quality = qual;

	}

	// ?q= is a location string. It only pre-fills the box: fetching weather is
	// user-triggered work, so a shared link still costs the visitor no network
	// until they press the button.
	if ( q.has( 'q' ) ) urlQuery = String( q.get( 'q' ) ).slice( 0, 120 );

} catch ( err ) {

	noteError( 'url-parse-failed', err );

}

// ---------------------------------------------------------------------------
// 2b. Quality tier. A throwaway context tells us whether we are on a software
// rasteriser (SwiftShader in the verifier, llvmpipe on a bare Linux box),
// where 9000 grass blades and a bloom pass are not affordable.
// ---------------------------------------------------------------------------

function detectTierName() {

	if ( params.quality === 'high' || params.quality === 'low' ) return params.quality;

	let name = 'high';

	try {

		const probe = document.createElement( 'canvas' );
		const gl = probe.getContext( 'webgl2' ) || probe.getContext( 'webgl' );
		if ( ! gl ) return 'low';

		const info = gl.getExtension( 'WEBGL_debug_renderer_info' );
		const renderer = info ? String( gl.getParameter( info.UNMASKED_RENDERER_WEBGL ) ) : '';
		if ( /swiftshader|llvmpipe|software/i.test( renderer ) ) {

			name = 'low';

		} else if ( ( navigator.hardwareConcurrency || 8 ) <= 4 ||
			( window.matchMedia && window.matchMedia( '(pointer: coarse)' ).matches ) ) {

			name = 'low';

		}

		// Give the driver the context back immediately rather than waiting for
		// the GC; browsers cap live contexts per page and we need the real one.
		const lose = gl.getExtension( 'WEBGL_lose_context' );
		if ( lose ) lose.loseContext();

	} catch ( err ) {

		noteError( 'tier-detect-failed', err );
		name = 'low';

	}

	return name;

}

let tier = TIERS[ detectTierName() ];

// ---------------------------------------------------------------------------
// DOM handles. Every one of these is optional: a partial or edited page must
// degrade, never break the loop.
// ---------------------------------------------------------------------------

const $ = ( id ) => document.getElementById( id );

const dom = {
	canvas: $( 'glCanvas' ),
	container: $( 'canvasContainer' ),
	fallbackNotice: $( 'fallbackNotice' ),
	statusLine: $( 'statusLine' ),
	startButton: $( 'startButton' ),
	locationInput: $( 'locationInput' ),
	menuToggle: $( 'menuToggle' ),
	sliderMenu: $( 'sliderMenu' ),
	windSpeedSlider: $( 'windSpeedSlider' ),
	windSpeedValue: $( 'windSpeedValue' ),
	turbulenceSlider: $( 'turbulenceSlider' ),
	turbulenceValue: $( 'turbulenceValue' ),
	chimeScaleSelect: $( 'chimeScaleSelect' ),
	noteCountSlider: $( 'noteCountSlider' ),
	noteCountValue: $( 'noteCountValue' ),
	attackSlider: $( 'attackSlider' ),
	attackValue: $( 'attackValue' ),
	decaySlider: $( 'decaySlider' ),
	decayValue: $( 'decayValue' ),
	loudnessSlider: $( 'loudnessSlider' ),
	loudnessValue: $( 'loudnessValue' ),
	sunSlider: $( 'sunSlider' ),
	clapperWidthSlider: $( 'clapperWidthSlider' ),
	clapperWidthValue: $( 'clapperWidthValue' ),
	clapperMassSlider: $( 'clapperMassSlider' ),
	clapperMassValue: $( 'clapperMassValue' ),
	clapperDropSlider: $( 'clapperDropSlider' ),
	clapperDropValue: $( 'clapperDropValue' ),
	sailMassSlider: $( 'sailMassSlider' ),
	sailMassValue: $( 'sailMassValue' ),
	sailHeightSlider: $( 'sailHeightSlider' ),
	sailHeightValue: $( 'sailHeightValue' ),
	sunValue: $( 'sunValue' ),
	qualitySelect: $( 'qualitySelect' ),
	styleSelect: $( 'styleSelect' ),
	windCard: $( 'windCard' ),
	windSpeedText: $( 'windSpeedText' ),
	windCompassNeedle: $( 'windCompassNeedle' ),
	gustSpark: $( 'gustSpark' ),
	hudOverlay: $( 'hudOverlay' )
};

// ---------------------------------------------------------------------------
// 2c-2h. Subsystems.
// ---------------------------------------------------------------------------

const wind = createWind( params );
// Push the part values into physics BEFORE the first build, so the rig is
// assembled from them rather than from the module defaults and the two can
// never disagree.
Object.assign( params, setParts( params ) );

const rig = createRig( freqsFor( params.scaleName, params.noteCount ) );

// The one wind sampling contract, handed to physics as a stable reference so
// nothing allocates a closure per substep.
const sampleWind = ( out, x, y, z ) => wind.sample( out, x, y, z );

let stage = null;
let viz = null;
let audio = null;

try {

	stage = createStage( {
		canvas: dom.canvas,
		container: dom.container,
		params,
		tier,
		onContextLost: () => handleContextLost()
	} );

} catch ( err ) {

	// createStage is specified to return null rather than throw, but a thrown
	// error here must still leave a running page.
	noteError( 'stage-create-failed', err );
	stage = null;

}

// The sun slider's range and default are authored per style, so they come back
// from the stage rather than being fixed in the HTML.
let sunLo = 2;
let sunHi = 20;

if ( ! stage ) {

	noteError( 'webgl-unavailable', null );
	if ( dom.fallbackNotice ) dom.fallbackNotice.classList.remove( 'hidden' );
	if ( ! Number.isFinite( params.sunElevDeg ) ) params.sunElevDeg = 11;

} else {

	const r = stage.sunRange ? stage.sunRange() : [ 2, 20 ];
	sunLo = r[ 0 ];
	sunHi = r[ 1 ];
	params.sunElevDeg = stage.sunElevation();
	if ( dom.sunSlider ) {

		dom.sunSlider.min = String( sunLo );
		dom.sunSlider.max = String( sunHi );

	}

	try {

		stage.buildChime( rig.tubes );

	} catch ( err ) {

		noteError( 'buildchime-failed', err );

	}

	try {

		viz = createWindViz( { scene: stage.scene, camera: stage.camera, wind, params, tier, palette: stage.palette } );

	} catch ( err ) {

		noteError( 'windviz-create-failed', err );
		viz = null;

	}

}

try {

	audio = createAudio( params );
	// The tier has to reach audio at boot as well as on a later change, or a
	// phone runs the desktop's five partials and sixteen voices all session.
	audio.setTier( tier );
	audio.setTubes( rig.tubes );

} catch ( err ) {

	noteError( 'audio-create-failed', err );
	audio = null;

}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

let frames = 0;
let strikes = 0;
let lastMs = performance.now();
let rafId = 0;
let running = false;
let lastSubsteps = 0;

let stageAlive = stage !== null;   // false while the GL context is lost
let vizFailures = 0;
let stageFailures = 0;

const dtRing = new Float32Array( 30 );
let dtRingIndex = 0;
const costRing = new Float32Array( 40 );
let costRingIndex = 0;
let costOverBudgetSince = -1;

let builtDeferred = false;
let builtEnvironment = false;

let lastInteractionMs = performance.now();
let hudIdle = false;
let autoRotateSuspended = true;   // starts suspended until the first idle window

// The learn section is a plain anchor target, so pressing "How it works" leaves
// #learn in the address bar -- and the next load lands the visitor in the
// documentation with the simulation scrolled off the top. Browsers also restore
// the previous scroll offset on reload, which does the same thing without any
// hash at all. The simulation IS the page; it always opens on it.
try {

	if ( 'scrollRestoration' in history ) history.scrollRestoration = 'manual';
	if ( window.location.hash ) {

		history.replaceState( null, '', window.location.pathname + window.location.search );

	}

	window.scrollTo( 0, 0 );

} catch ( err ) {

	noteError( 'scroll-reset-failed', err );

}

const reducedMotion = ( window.matchMedia && window.matchMedia( '(prefers-reduced-motion: reduce)' ) ) || null;

// Weather bookkeeping for the snapshot and the poller.
const weatherState = { source: null, place: null, at: null, coords: null };
let stopPolling = null;
let audioUnlocked = false;
let unlockInFlight = false;

// Scratch, hoisted: the tick must not allocate.
const _windVec = new THREE.Vector3();
const _camRight = [ 0, 0, 0 ];
const _camTarget = [ 0, 0, 0 ];
const _grabPoint = [ 0, 0, 0 ];
const _grabAnchor = [ 0, 0, 0 ];

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function setStatus( text ) {

	if ( dom.statusLine ) dom.statusLine.textContent = text;

}

function setText( el, text ) {

	if ( el && el.textContent !== text ) el.textContent = text;

}

function syncControlValues() {

	if ( dom.windSpeedSlider ) dom.windSpeedSlider.value = String( Math.round( params.windSpeedMph ) );
	setText( dom.windSpeedValue, Math.round( params.windSpeedMph ) + ' mph' );
	if ( dom.turbulenceSlider ) dom.turbulenceSlider.value = String( params.turbulence );
	setText( dom.turbulenceValue, params.turbulence.toFixed( 2 ) );
	if ( dom.chimeScaleSelect ) dom.chimeScaleSelect.value = params.scaleName;
	if ( dom.noteCountSlider ) dom.noteCountSlider.value = String( params.noteCount );
	setNoteCountLabel();
	if ( dom.attackSlider ) dom.attackSlider.value = String( params.attack );
	setText( dom.attackValue, params.attack.toFixed( 4 ) + ' s' );
	if ( dom.decaySlider ) dom.decaySlider.value = String( params.decay );
	setText( dom.decayValue, params.decay.toFixed( 1 ) + ' s ring' );
	if ( dom.loudnessSlider ) dom.loudnessSlider.value = String( params.loudness );
	setText( dom.loudnessValue, Math.round( params.loudness * 100 ) + '%' );
	if ( dom.sunSlider ) dom.sunSlider.value = String( params.sunElevDeg );
	setText( dom.sunValue, Math.round( params.sunElevDeg ) + ' deg' );
	if ( dom.qualitySelect ) dom.qualitySelect.value = params.quality;
	if ( dom.styleSelect ) dom.styleSelect.value = params.style;
	syncPartControls();

}

// The label reports the tubes that actually got hung, not the number that was
// asked for. cOctaveIntervals runs out of usable notes at four, so a slider set
// to six there would otherwise sit there claiming six.
function setNoteCountLabel() {

	const built = rig.tubes.length;
	setText( dom.noteCountValue, built + ( built === 1 ? ' tube' : ' tubes' ) );

}

function compassLetters( dirDeg ) {

	const d = ( ( finite( dirDeg, 0 ) % 360 ) + 360 ) % 360;
	return COMPASS_16[ Math.round( d / 22.5 ) % 16 ];

}

// ---------------------------------------------------------------------------
// Rebuild: the tube LENGTHS change on screen, which is the whole point of
// exposing the scale and the tube count as controls.
// ---------------------------------------------------------------------------

function rebuildChime() {

	try {

		const f = freqsFor( params.scaleName, params.noteCount );
		rig.rebuild( f );
		if ( stage ) stage.buildChime( rig.tubes );
		if ( audio ) audio.setTubes( rig.tubes );
		setNoteCountLabel();

	} catch ( err ) {

		noteError( 'rebuild-failed', err );

	}

}

function applyTier( next ) {

	tier = next;
	try {

		if ( stage ) stage.setTier( tier );

	} catch ( err ) {

		noteError( 'stage-settier-failed', err );

	}

	try {

		if ( viz ) viz.setTier( tier );

	} catch ( err ) {

		noteError( 'viz-settier-failed', err );

	}

	try {

		if ( audio ) audio.setTier( tier );

	} catch ( err ) {

		noteError( 'audio-settier-failed', err );

	}

}

// ---------------------------------------------------------------------------
// Control bindings
// ---------------------------------------------------------------------------

// The five adjustable parts. Every one of them moves a particle mass, a cord
// rest length or the collision radius, so a change means rebuilding the rig --
// which is why they are coalesced rather than applied on every input event of a
// drag. 80 ms is under a tenth of a second, so it still feels live.
const PART_UNITS = {
	clapperWidth: { scale: 1000, unit: 'mm', dp: 0 },
	clapperMass: { scale: 1000, unit: 'g', dp: 0 },
	clapperDrop: { scale: 100, unit: 'cm', dp: 0 },
	sailMass: { scale: 1000, unit: 'g', dp: 0 },
	sailHeight: { scale: 1000, unit: 'mm', dp: 0 },
};

function partLabel( key ) {

	const u = PART_UNITS[ key ];
	return ( params[ key ] * u.scale ).toFixed( u.dp ) + ' ' + u.unit;

}

function syncPartControls() {

	for ( const key of Object.keys( PART_UNITS ) ) {

		const slider = dom[ key + 'Slider' ];
		if ( slider ) slider.value = String( params[ key ] );
		setText( dom[ key + 'Value' ], partLabel( key ) );

	}

}

let partsTimer = 0;

function applyParts() {

	clearTimeout( partsTimer );
	partsTimer = setTimeout( () => {

		try {

			// physics.js clamps, and hands back what is actually in force, so a
			// value the rig refused never lingers in the UI.
			Object.assign( params, setParts( params ) );
			rebuildChime();
			syncPartControls();

		} catch ( err ) {

			noteError( 'parts-apply-failed', err );

		}

	}, 80 );

}

function bindPart( key ) {

	const slider = dom[ key + 'Slider' ];
	if ( ! slider ) return;
	const [ lo, hi ] = PART_LIMITS[ key ];
	slider.min = String( lo );
	slider.max = String( hi );
	slider.value = String( params[ key ] );
	setText( dom[ key + 'Value' ], partLabel( key ) );
	slider.addEventListener( 'input', () => {

		const v = parseFloat( slider.value );
		if ( ! Number.isFinite( v ) ) return;
		params[ key ] = clamp( v, lo, hi );
		// The readout follows the pointer even though the rebuild is coalesced.
		setText( dom[ key + 'Value' ], partLabel( key ) );
		applyParts();

	} );

}

for ( const key of Object.keys( PART_UNITS ) ) bindPart( key );

function bindRange( el, apply ) {

	if ( ! el ) return;
	el.addEventListener( 'input', () => {

		const v = parseFloat( el.value );
		if ( ! Number.isFinite( v ) ) return;
		apply( v );

	} );

}

bindRange( dom.windSpeedSlider, ( v ) => {

	params.windSpeedMph = clamp( v, 0, 60 );
	setText( dom.windSpeedValue, Math.round( params.windSpeedMph ) + ' mph' );

} );

bindRange( dom.turbulenceSlider, ( v ) => {

	params.turbulence = clamp( v, 0.05, 1.0 );
	setText( dom.turbulenceValue, params.turbulence.toFixed( 2 ) );

} );

if ( dom.chimeScaleSelect ) {

	dom.chimeScaleSelect.addEventListener( 'change', () => {

		const name = dom.chimeScaleSelect.value;
		params.scaleName = Object.prototype.hasOwnProperty.call( SCALES, name ) ? name : 'cMajorPentatonic';
		rebuildChime();

	} );

}

bindRange( dom.noteCountSlider, ( v ) => {

	// The old page allowed zero tubes, which is a chime that cannot ring.
	const n = clamp( Math.round( v ), 3, 8 );
	if ( n === params.noteCount ) return;
	params.noteCount = n;
	rebuildChime();   // sets the label from the tubes that were actually built

} );

bindRange( dom.attackSlider, ( v ) => {

	params.attack = clamp( v, 0.0005, 0.05 );
	setText( dom.attackValue, params.attack.toFixed( 4 ) + ' s' );

} );

bindRange( dom.decaySlider, ( v ) => {

	params.decay = clamp( v, 0.5, 16 );
	setText( dom.decayValue, params.decay.toFixed( 1 ) + ' s ring' );

} );

bindRange( dom.loudnessSlider, ( v ) => {

	params.loudness = clamp( v, 0, 1 );
	setText( dom.loudnessValue, Math.round( params.loudness * 100 ) + '%' );

} );

bindRange( dom.sunSlider, ( v ) => {

	params.sunElevDeg = clamp( v, sunLo, sunHi );
	setText( dom.sunValue, Math.round( params.sunElevDeg ) + ' deg' );

} );

// Changing the look swaps the camera's projection type, every material, the
// lighting model and whether there is an environment map at all. That is a
// different stage, not a setting on this one, so it reloads rather than
// pretending to hot-swap. The location box's contents survive in the URL.
if ( dom.styleSelect ) {

	dom.styleSelect.addEventListener( 'change', () => {

		const next = dom.styleSelect.value;
		if ( next !== 'storybook' && next !== 'golden' ) return;
		try {

			const u = new URL( window.location.href );
			u.hash = '';
			u.searchParams.set( 'style', next );
			const typed = dom.locationInput && dom.locationInput.value.trim();
			if ( typed ) u.searchParams.set( 'q', typed.slice( 0, 120 ) );
			window.location.assign( u.toString() );

		} catch ( err ) {

			noteError( 'style-switch-failed', err );

		}

	} );

}

if ( dom.qualitySelect ) {

	dom.qualitySelect.addEventListener( 'change', () => {

		const q = dom.qualitySelect.value;
		params.quality = ( q === 'high' || q === 'low' ) ? q : 'auto';
		applyTier( TIERS[ detectTierName() ] );

	} );

}

if ( dom.menuToggle && dom.sliderMenu ) {

	dom.menuToggle.addEventListener( 'click', () => {

		dom.sliderMenu.classList.toggle( 'visible' );
		markInteraction();

	} );

}

if ( urlQuery && dom.locationInput ) dom.locationInput.value = urlQuery;

syncControlValues();

// wind.js owns windSpeedMph and dirDeg once a weather reading is ramping in.
// Mirror the ramp back onto the slider so the UI never lies about the state.
let lastPushedLabel = '';
params.__onWindPushed = ( mph, dirDeg ) => {

	const label = Math.round( mph ) + ' mph';
	if ( label === lastPushedLabel ) return;
	lastPushedLabel = label;
	if ( dom.windSpeedSlider ) dom.windSpeedSlider.value = String( Math.round( mph ) );
	setText( dom.windSpeedValue, label );

};

// ---------------------------------------------------------------------------
// Audio unlock and the weather chain. Both are lazy: nothing here runs before
// the visitor asks for it, and nothing here can stop the loop.
// ---------------------------------------------------------------------------

// LATCH ON SUCCESS, NOT ON ATTEMPT. Setting audioUnlocked before the promise
// resolved meant one failed attempt silenced the page for the rest of the
// visit, with no way back: every later gesture hit the guard and returned. That
// is exactly the case iOS Safari produces, where a context created inside
// pointerdown can stay suspended until a later trusted gesture. audio.unlock()
// is written to be safely repeatable and re-resumes an existing context, so the
// only thing that ever prevented the retry was this flag.
function unlockAudio() {

	if ( audioUnlocked || unlockInFlight || ! audio ) return;
	unlockInFlight = true;
	try {

		Promise.resolve( audio.unlock() )
			.then( ( ok ) => {

				audioUnlocked = !! ok;
				unlockInFlight = false;

			} )
			.catch( ( err ) => {

				unlockInFlight = false;
				noteError( 'audio-unlock-failed', err );

			} );

	} catch ( err ) {

		unlockInFlight = false;
		noteError( 'audio-unlock-failed', err );

	}

}

async function runWeatherChain() {

	try {

		const query = dom.locationInput ? dom.locationInput.value.trim() : '';
		let coords = null;
		let place = null;

		if ( query ) {

			setStatus( 'Looking up ' + query + '...' );
			const r = await weather.geocode( query );
			if ( r ) {

				coords = { lat: r.lat, lon: r.lon };
				place = r.label;

			}

		} else {

			setStatus( 'Asking your browser where you are...' );
			const loc = await weather.browserLocation( 8000 );
			if ( loc ) {

				coords = { lat: loc.lat, lon: loc.lon };
				place = await weather.reverseGeocode( loc.lat, loc.lon );

			} else {

				noteError( 'geolocation-denied', null );

			}

		}

		if ( ! coords ) {

			setStatus( 'Using a default breeze.' );
			return;

		}

		weatherState.coords = coords;
		setStatus( 'Fetching the wind' + ( place ? ' near ' + place : '' ) + '...' );

		const reading = await weather.fetchWeather( coords.lat, coords.lon );
		applyReading( reading, place );

		if ( stopPolling ) stopPolling();
		// 15 minutes. The old page polled every 15 seconds, per open tab.
		stopPolling = weather.startPolling(
			() => weatherState.coords,
			( r ) => applyReading( r, place ),
			900000
		);

	} catch ( err ) {

		// weather.js is specified never to throw; this is belt and braces so a
		// surprise can only ever cost the visitor real weather, not the page.
		noteError( 'weather-failed', err );
		setStatus( 'Using a default breeze.' );

	}

}

function applyReading( reading, fallbackPlace ) {

	if ( ! reading ) {

		noteError( 'weather-failed', null );
		setStatus( 'Using a default breeze - weather.gov only covers the US.' );
		return;

	}

	try {

		// Ramped over 8 seconds inside wind.js, so the chime eases into the
		// real weather instead of being kicked by it.
		wind.setWeather( reading.speedMph, reading.dirDeg );

	} catch ( err ) {

		noteError( 'wind-setweather-failed', err );

	}

	weatherState.source = reading.source || 'weather.gov';
	weatherState.place = reading.place || fallbackPlace || null;
	weatherState.at = reading.at || Date.now();

	const label = weatherState.place ? weatherState.place + ': ' : '';
	setStatus( label + compassLetters( reading.dirDeg ) + ' at ' + Math.round( reading.speedMph ) + ' mph' +
		( reading.gustMph ? ', gusting ' + Math.round( reading.gustMph ) : '' ) );

}

if ( dom.startButton ) {

	dom.startButton.addEventListener( 'click', () => {

		markInteraction();
		unlockAudio();
		runWeatherChain();

	} );

}

if ( dom.locationInput ) {

	dom.locationInput.addEventListener( 'keydown', ( e ) => {

		if ( e.key !== 'Enter' ) return;
		e.preventDefault();
		markInteraction();
		unlockAudio();
		runWeatherChain();

	} );

}

// ---------------------------------------------------------------------------
// Pointer gestures: orbit, or grab the sail or the clapper and shake the chime
// by hand. Ownership of a gesture is decided once at pointerdown and never
// revisited, because re-deciding mid-drag makes the camera lurch.
// ---------------------------------------------------------------------------

const activePointers = new Set();
let grabPointerId = -1;
let hoverName = null;
let lastHoverMs = 0;

function markInteraction() {

	lastInteractionMs = performance.now();
	if ( hudIdle && dom.hudOverlay ) {

		dom.hudOverlay.classList.remove( 'idle' );
		hudIdle = false;

	}

	if ( ! autoRotateSuspended && stage && stage.controls ) {

		stage.controls.autoRotate = false;
		autoRotateSuspended = true;

	}

}

function toNDC( e, out ) {

	const rect = dom.canvas.getBoundingClientRect();
	if ( rect.width <= 0 || rect.height <= 0 ) return false;
	out.x = ( ( e.clientX - rect.left ) / rect.width ) * 2 - 1;
	out.y = - ( ( e.clientY - rect.top ) / rect.height ) * 2 + 1;
	return true;

}

const _ndc = { x: 0, y: 0 };

function endGrab() {

	if ( grabPointerId === -1 ) return;
	grabPointerId = -1;
	try {

		rig.release();

	} catch ( err ) {

		noteError( 'rig-release-failed', err );

	}

	if ( stage && stage.controls ) stage.controls.enabled = true;

}

if ( dom.canvas ) {

	dom.canvas.addEventListener( 'pointerdown', ( e ) => {

		activePointers.add( e.pointerId );
		markInteraction();
		unlockAudio();

		// Two fingers is always the camera: pinch-zoom must never yank the sail.
		if ( ! e.isPrimary || activePointers.size > 1 ) {

			endGrab();
			return;

		}

		if ( ! stage || ! stageAlive ) return;
		if ( ! toNDC( e, _ndc ) ) return;

		let name = null;
		try {

			name = stage.raycastGrab( _ndc.x, _ndc.y );

		} catch ( err ) {

			noteError( 'raycast-failed', err );

		}

		if ( ! name ) return;

		const body = name === 'sail' ? rig.state.sail.pos : rig.state.clapper.pos;
		_grabAnchor[ 0 ] = body[ 0 ];
		_grabAnchor[ 1 ] = body[ 1 ];
		_grabAnchor[ 2 ] = body[ 2 ];

		try {

			rig.grab( name, _grabAnchor[ 0 ], _grabAnchor[ 1 ], _grabAnchor[ 2 ] );
			grabPointerId = e.pointerId;
			if ( stage.controls ) stage.controls.enabled = false;
			if ( dom.canvas.setPointerCapture ) dom.canvas.setPointerCapture( e.pointerId );

		} catch ( err ) {

			noteError( 'rig-grab-failed', err );

		}

	} );

	dom.canvas.addEventListener( 'pointermove', ( e ) => {

		markInteraction();
		if ( ! stage || ! stageAlive ) return;

		if ( grabPointerId === e.pointerId ) {

			if ( ! toNDC( e, _ndc ) ) return;
			try {

				// The drag plane is pinned to where the body was when it was
				// grabbed, so a long drag cannot walk the object toward the camera.
				stage.grabPlanePoint( _ndc.x, _ndc.y, _grabAnchor, _grabPoint );
				rig.moveGrab( _grabPoint[ 0 ], _grabPoint[ 1 ], _grabPoint[ 2 ] );

			} catch ( err ) {

				noteError( 'rig-movegrab-failed', err );

			}

			return;

		}

		// Hover highlight, throttled to 8 Hz: a raycast per mousemove is waste.
		const now = performance.now();
		if ( now - lastHoverMs < 125 ) return;
		lastHoverMs = now;
		if ( ! toNDC( e, _ndc ) ) return;
		try {

			const name = stage.raycastGrab( _ndc.x, _ndc.y );
			if ( name !== hoverName ) {

				hoverName = name;
				stage.setGrabHighlight( name );

			}

		} catch ( err ) {

			noteError( 'raycast-failed', err );

		}

	} );

	const release = ( e ) => {

		activePointers.delete( e.pointerId );
		if ( grabPointerId === e.pointerId ) endGrab();

	};

	dom.canvas.addEventListener( 'pointerup', release );
	dom.canvas.addEventListener( 'pointercancel', release );
	dom.canvas.addEventListener( 'pointerleave', release );
	dom.canvas.addEventListener( 'contextmenu', ( e ) => e.preventDefault() );

	dom.canvas.addEventListener( 'webglcontextlost', ( e ) => {

		e.preventDefault();
		handleContextLost();

	}, false );

	dom.canvas.addEventListener( 'webglcontextrestored', () => {

		handleContextRestored();

	}, false );

}

window.addEventListener( 'pointermove', markInteraction, { passive: true } );
window.addEventListener( 'keydown', markInteraction, { passive: true } );

// ---------------------------------------------------------------------------
// GL context loss. Physics, wind and audio keep running; only the picture
// stops, and it comes back when the driver hands the context back.
// ---------------------------------------------------------------------------

let contextLost = false;

function handleContextLost() {

	if ( contextLost ) return;
	contextLost = true;
	stageAlive = false;
	noteError( 'webgl-context-lost', null );

}

function handleContextRestored() {

	if ( ! contextLost ) return;
	contextLost = false;

	// A restored context has no GPU resources left, so the stage and everything
	// parented to its scene has to be built again from scratch.
	try {

		if ( viz ) viz.dispose();

	} catch ( err ) {

		noteError( 'viz-dispose-failed', err );

	}

	viz = null;

	try {

		if ( stage ) stage.dispose();

	} catch ( err ) {

		noteError( 'stage-dispose-failed', err );

	}

	stage = null;

	try {

		stage = createStage( {
			canvas: dom.canvas,
			container: dom.container,
			params,
			tier,
			onContextLost: () => handleContextLost()
		} );

		if ( stage ) {

			stage.buildChime( rig.tubes );
			viz = createWindViz( { scene: stage.scene, camera: stage.camera, wind, params, tier, palette: stage.palette } );
			builtDeferred = false;
			builtEnvironment = false;
			stageAlive = true;
			stageFailures = 0;
			vizFailures = 0;

		}

	} catch ( err ) {

		noteError( 'stage-rebuild-failed', err );
		stage = null;

	}

	if ( ! stage && dom.fallbackNotice ) dom.fallbackNotice.classList.remove( 'hidden' );

}

// ---------------------------------------------------------------------------
// Resize. A ResizeObserver on the container catches layout-driven changes that
// a window resize listener misses (menu opening, mobile URL bar collapsing).
// ---------------------------------------------------------------------------

if ( dom.container && typeof ResizeObserver !== 'undefined' ) {

	const ro = new ResizeObserver( () => {

		if ( stage && stageAlive ) {

			try {

				stage.resize();

			} catch ( err ) {

				noteError( 'resize-failed', err );

			}

		}

	} );
	ro.observe( dom.container );

} else {

	window.addEventListener( 'resize', () => {

		if ( stage && stageAlive ) {

			try {

				stage.resize();

			} catch ( err ) {

				noteError( 'resize-failed', err );

			}

		}

	} );

}

// ---------------------------------------------------------------------------
// Visibility: genuinely cancel the loop when hidden. Skipping work inside a
// still-scheduled rAF still costs a wake-up per frame.
// ---------------------------------------------------------------------------

document.addEventListener( 'visibilitychange', () => {

	if ( document.hidden ) {

		stopLoop();
		if ( audio ) {

			try {

				audio.suspend();

			} catch ( err ) {

				noteError( 'audio-suspend-failed', err );

			}

		}

	} else {

		lastMs = performance.now();   // do not hand the solver a ten-minute dt
		if ( audio ) {

			try {

				audio.resume();

			} catch ( err ) {

				noteError( 'audio-resume-failed', err );

			}

		}

		startLoop();

	}

} );

// ---------------------------------------------------------------------------
// HUD. Touched on every 10th frame only: layout thrash is the cheapest way to
// lose a frame budget that the physics already paid for.
// ---------------------------------------------------------------------------

function updateHud() {

	const st = wind.state;

	setText( dom.windSpeedText, compassLetters( st.dirDeg ) + ' - ' + Math.round( st.speedMph * st.gust ) + ' mph' );

	if ( dom.windCompassNeedle ) {

		// The needle is drawn pointing up; +180 turns it into a flow arrow that
		// points the way the air is going rather than where it came from.
		dom.windCompassNeedle.setAttribute( 'transform',
			'rotate(' + ( finite( st.dirDeg, 270 ) + 180 ).toFixed( 1 ) + ' 30 30)' );

	}

	if ( dom.gustSpark && wind.gustHistory ) {

		const hist = wind.gustHistory;
		const n = hist.length;
		const start = wind.gustHistoryIndex | 0;
		let pts = '';
		for ( let k = 0; k < n; k ++ ) {

			const g = clamp( finite( hist[ ( start + k ) % n ], 1 ), 0.15, 2.60 );
			const x = ( k / ( n - 1 ) ) * 120;
			// Map the OU gust range onto the 28-unit tall viewBox, 1 unit inset.
			const y = 27 - ( ( g - 0.15 ) / 2.45 ) * 26;
			pts += ( k ? ' ' : '' ) + x.toFixed( 1 ) + ',' + y.toFixed( 1 );

		}

		dom.gustSpark.setAttribute( 'points', pts );

	}

	const now = performance.now();
	const idleFor = now - lastInteractionMs;

	// The HUD gets out of the way once the visitor has settled in, but not before
	// they have started: fading the Start pill down to a quarter opacity while it
	// is still the thing they came to press hides the only call to action on the
	// page. Opacity on #hudOverlay composites the whole subtree, so a child
	// cannot opt back out of it — the gate has to be on applying it at all.
	if ( ! hudIdle && audioUnlocked && idleFor > 8000 && dom.hudOverlay ) {

		dom.hudOverlay.classList.add( 'idle' );
		hudIdle = true;

	}

	// Reduced motion: the simulation is the content and stays, but the camera
	// stops drifting on its own.
	const allowAutoRotate = ! ( reducedMotion && reducedMotion.matches );
	if ( autoRotateSuspended && idleFor > 12000 && allowAutoRotate && stage && stage.controls ) {

		stage.controls.autoRotate = true;
		autoRotateSuspended = false;

	}

}

// ---------------------------------------------------------------------------
// The tick.
// ---------------------------------------------------------------------------

function frame( nowMs ) {

	rafId = requestAnimationFrame( frame );
	const tFrameStart = performance.now();
	frames ++;

	let dt = clamp( ( nowMs - lastMs ) / 1000, 0, DT_CAP );
	lastMs = nowMs;
	if ( params.paused ) dt = 0;

	if ( dt > 0 ) {

		dtRing[ dtRingIndex ] = dt;
		dtRingIndex = ( dtRingIndex + 1 ) % dtRing.length;

	}

	// 3. Wind first: everything downstream samples the field this call leaves.
	try {

		wind.update( dt );

	} catch ( err ) {

		noteError( 'wind-update-failed', err );

	}

	// 4. Substeps. Fixed maximum step size, variable count, no leftover
	// accumulator: the solver sees at most 1/240 s no matter the frame rate.
	let h = 0;
	let n = 0;
	if ( dt > 0 ) {

		n = clamp( Math.ceil( dt / SUBSTEP_MAX ), 1, SUBSTEP_CAP );
		h = dt / n;
		try {

			for ( let k = 0; k < n; k ++ ) {

				rig.substepIndex = k;
				rig.step( h, sampleWind, params );

			}

		} catch ( err ) {

			noteError( 'physics-step-failed', err );

		}

	}

	lastSubsteps = n;

	// 5. Strikes. Each event carries the substep it happened in, so audio can
	// place it inside the frame instead of quantising every hit to the frame
	// boundary and comb-filtering a gust into a metallic flam.
	try {

		const events = rig.drainStrikes();
		for ( let i = 0; i < events.length; i ++ ) {

			dispatchStrike( events[ i ], h );

		}

	} catch ( err ) {

		noteError( 'strike-dispatch-failed', err );

	}

	// 6. One state sync per frame, after all the substeps.
	try {

		rig.syncState();

	} catch ( err ) {

		noteError( 'rig-sync-failed', err );

	}

	if ( rig.errors && rig.errors.length ) {

		for ( let i = 0; i < rig.errors.length; i ++ ) noteError( rig.errors[ i ], null );

	}

	// 5b. The two expensive one-time builds, kept off frame 1 on purpose:
	// filling 9000 grass instances costs about 15 ms and the PMREM bake more,
	// and either one on the first frame would delay first paint by that much.
	if ( ! builtDeferred && frames >= 2 && viz ) {

		builtDeferred = true;
		try {

			viz.buildDeferred();

		} catch ( err ) {

			noteError( 'viz-build-failed', err );

		}

	}

	if ( ! builtEnvironment && frames >= 3 && stage && stageAlive ) {

		builtEnvironment = true;
		try {

			stage.buildEnvironment();

		} catch ( err ) {

			noteError( 'env-build-failed', err );

		}

	}

	// 7-8. The picture follows the physics.
	if ( stage && stageAlive ) {

		try {

			// The cloud layer, the dust haze and the direction a slack cord
			// bellies are all bulk wind effects the rig state cannot describe, so
			// the scene gets the mean vector directly. Pushed before syncRig
			// because writeCord reads it in the same call.
			stage.setWind( wind.state.meanVec, wind.state.speedMph );
			stage.syncRig( rig.state );
			stageFailures = 0;

		} catch ( err ) {

			noteError( 'stage-sync-failed', err );
			if ( ++ stageFailures > 5 ) stageAlive = false;

		}

	}

	if ( viz && stageAlive ) {

		try {

			viz.update( dt, wind.state.time, rig.state.anchorBelowPlate, rig.state.plate.pos );
			vizFailures = 0;

		} catch ( err ) {

			noteError( 'viz-update-failed', err );
			if ( ++ vizFailures > 5 ) viz = null;   // drop the wind dressing, keep the chime

		}

	}

	// 9. The grass and shrub shaders read this; it re-bakes on every 3rd call.
	try {

		// Nothing samples the baked flow texture any more: it existed for the
		// grass and shrub vertex shaders, and the ground cover is static
		// geometry in scene.js now. Left in wind.js, simply not driven.
		// wind.updateFlowTexture();

	} catch ( err ) {

		noteError( 'flowtexture-failed', err );

	}

	// 10-12. Sun, listener, render.
	if ( stage && stageAlive ) {

		try {

			stage.setSunElevation( params.sunElevDeg );

		} catch ( err ) {

			noteError( 'sun-failed', err );

		}

	}

	if ( audio ) {

		try {

			if ( rig.contactMask ) audio.setContactMask( rig.contactMask );
			if ( stage && stageAlive ) {

				stage.cameraRight( _camRight );
				const target = stage.controls ? stage.controls.target : null;
				if ( target ) {

					_camTarget[ 0 ] = target.x;
					_camTarget[ 1 ] = target.y;
					_camTarget[ 2 ] = target.z;

				}

				audio.setListener( _camRight, _camTarget, stage.cameraDistance() );

			}

		} catch ( err ) {

			noteError( 'audio-listener-failed', err );

		}

	}

	if ( stage && stageAlive ) {

		try {

			stage.render();

		} catch ( err ) {

			noteError( 'render-failed', err );
			if ( ++ stageFailures > 5 ) stageAlive = false;

		}

	}

	// 13. HUD, every 10th frame.
	if ( frames % 10 === 0 ) {

		try {

			updateHud();

		} catch ( err ) {

			noteError( 'hud-failed', err );

		}

	}

	// 14. Adaptive quality. Sticky downgrade: a scene that has already proved it
	// cannot hold the budget should not be allowed to oscillate.
	const cost = performance.now() - tFrameStart;
	costRing[ costRingIndex ] = cost;
	costRingIndex = ( costRingIndex + 1 ) % costRing.length;

	if ( tier.name === 'high' && frames > 60 ) {

		if ( meanOf( costRing ) > 22 ) {

			if ( costOverBudgetSince < 0 ) costOverBudgetSince = nowMs;
			else if ( nowMs - costOverBudgetSince > 2000 ) {

				costOverBudgetSince = -1;
				noteError( 'tier-downgrade', null );
				applyTier( TIERS.low );

			}

		} else {

			costOverBudgetSince = -1;

		}

	}

}

function meanOf( ring ) {

	let sum = 0;
	let count = 0;
	for ( let i = 0; i < ring.length; i ++ ) {

		if ( ring[ i ] > 0 ) {

			sum += ring[ i ];
			count ++;

		}

	}

	return count ? sum / count : 0;

}

function dispatchStrike( ev, h ) {

	strikes ++;

	if ( audio ) {

		try {

			audio.strike( ev, ( ev.substep || 0 ) * h );

		} catch ( err ) {

			noteError( 'audio-strike-failed', err );

		}

	}

	if ( stage && stageAlive ) {

		try {

			// 0.014 N.s is a firm hit; brighter than that just saturates.
			stage.flashTube( ev.tube, clamp( ev.J / 0.014, 0, 1 ) );

		} catch ( err ) {

			noteError( 'flash-failed', err );

		}

	}

}

function startLoop() {

	if ( running ) return;
	running = true;
	lastMs = performance.now();
	rafId = requestAnimationFrame( frame );

}

function stopLoop() {

	if ( ! running ) return;
	running = false;
	cancelAnimationFrame( rafId );
	rafId = 0;

}

// ---------------------------------------------------------------------------
// Debug handle. The headless verifier reads this, and so does anyone poking at
// the page in a console. Everything it returns is plain JSON.
// ---------------------------------------------------------------------------

function snapshot() {

	const st = wind.state;
	let vector = [ 0, 0, 0 ];
	let sailPos = [ 0, 0, 0 ];
	let sailOffset = [ 0, 0, 0 ];
	let clapperPos = [ 0, 0, 0 ];
	let platePos = [ 0, 0, 0 ];
	let leanDeg = 0;

	try {

		const s = rig.state.sail;
		sailPos = vec3out( s.pos );
		sailOffset = vec3out( s.offset );
		leanDeg = round3( s.leanDeg );
		clapperPos = vec3out( rig.state.clapper.pos );
		platePos = vec3out( rig.state.plate.pos );
		// Sampled at the sail, not the origin: this is the wind that is doing
		// the work on the rig.
		wind.sample( _windVec, s.pos[ 0 ], s.pos[ 1 ], s.pos[ 2 ] );
		vector = [ round3( _windVec.x ), round3( _windVec.y ), round3( _windVec.z ) ];

	} catch ( err ) {

		noteError( 'snapshot-rig-failed', err );

	}

	let info = { drawCalls: 0, triangles: 0, programs: 0 };
	if ( stage ) {

		try {

			info = stage.info() || info;

		} catch ( err ) {

			noteError( 'stage-info-failed', err );

		}

	}

	const lengths = [];
	const freqs = [];
	for ( let i = 0; i < rig.tubes.length; i ++ ) {

		lengths.push( round3( rig.tubes[ i ].L ) );
		freqs.push( Math.round( finite( rig.tubes[ i ].f1, 0 ) * 10 ) / 10 );

	}

	const meanDt = meanOf( dtRing );

	return {
		mode: stage ? 'webgl' : 'nowebgl',
		frames,
		fps: meanDt > 0 ? Math.round( ( 1 / meanDt ) * 10 ) / 10 : 0,
		frameMs: Math.round( meanOf( costRing ) * 100 ) / 100,
		wind: {
			speedMph: round3( st.speedMph ),
			dirDeg: round3( st.dirDeg ),
			gust: round3( st.gust ),
			vector
		},
		tubes: rig.tubes.length,
		strikes,
		tubeStrikes: rig.tubeStrikeCount | 0,
		audioReady: audio ? !! audio.ready() : false,
		errors: errors.slice(),
		quality: tier.name,
		pixelRatio: stage && stage.renderer ? stage.renderer.getPixelRatio() : 0,
		drawCalls: info.drawCalls | 0,
		triangles: info.triangles | 0,
		particles: {
			// trails is a POOL size, leaves is a live count. Streamer alpha is
			// gated on wind speed, so in a lull the pool is allocated and
			// invisible; the two numbers do not mean the same thing.
			trails: viz && viz.counts ? viz.counts.trails | 0 : 0,
			looping: viz && viz.counts ? viz.counts.looping | 0 : 0,
			ribbonNodes: tier.ribbonSegs | 0,
			leaves: viz && viz.counts ? viz.counts.leaves | 0 : 0
		},
		// The wind couplings that live in the renderer rather than in the rig.
		// Without these the only way to check that clouds, haze and cord lean
		// actually follow the wind is to stare at a screenshot.
		air: stage && stage.windReadout ? stage.windReadout() : null,
		plate: { pos: platePos },
		sail: { pos: sailPos, leanDeg, offset: sailOffset },
		clapper: { pos: clapperPos },
		tubeLengths: lengths,
		tubeFreqs: freqs,
		substeps: lastSubsteps,
		simTime: round3( rig.simTime ),
		weather: {
			source: weatherState.source,
			place: weatherState.place,
			ageSec: weatherState.at ? Math.round( ( Date.now() - weatherState.at ) / 1000 ) : null
		}
	};

}

window.__wcs = {

	snapshot,

	setWind( mph, dirDeg ) {

		// Goes through the same 8 second ramp a real weather reading uses, so
		// the chime eases into the new wind rather than being kicked by it.
		const s = clamp( finite( mph, params.windSpeedMph ), 0, 60 );
		const d = ( ( finite( dirDeg, params.dirDeg ) % 360 ) + 360 ) % 360;
		wind.setWeather( s, d );
		return { speedMph: s, dirDeg: d };

	},

	gust( mult, seconds ) {

		wind.setGust( finite( mult, 1 ), finite( seconds, 1 ) );
		return true;

	},

	strike( tubeIndex, vn ) {

		const i = clamp( Math.round( finite( tubeIndex, 0 ) ), 0, rig.tubes.length - 1 );
		const speed = Math.abs( finite( vn, 0.4 ) );
		const tube = rig.tubes[ i ];
		const s = 0.45;
		// mu, the reduced mass at contact, is about 0.030 kg across the set.
		const mu = 0.030;
		const J = 1.45 * speed * mu;
		const st = rig.state.tubes[ i ];
		const pos = st
			? [
				st.top[ 0 ] + ( st.bottom[ 0 ] - st.top[ 0 ] ) * s,
				st.top[ 1 ] + ( st.bottom[ 1 ] - st.top[ 1 ] ) * s,
				st.top[ 2 ] + ( st.bottom[ 2 ] - st.top[ 2 ] ) * s
			]
			: [ 0, 1.65, 0 ];

		const ev = {
			tube: i,
			freq: tube.f1,
			L: tube.L,
			s,
			J,
			mu,
			vn: speed,
			substep: 0,
			t: rig.simTime,
			pos
		};

		// Same path a real contact takes, so this tests audio and flash at once.
		dispatchStrike( ev, 0 );
		return ev;

	},

	pause() {

		params.paused = true;
		return true;

	},

	resume() {

		params.paused = false;
		lastMs = performance.now();
		return true;

	},

	rebuild( scaleName, count ) {

		if ( typeof scaleName === 'string' && Object.prototype.hasOwnProperty.call( SCALES, scaleName ) ) {

			params.scaleName = scaleName;

		}

		if ( Number.isFinite( count ) ) params.noteCount = clamp( Math.round( count ), 3, 8 );
		rebuildChime();
		syncControlValues();
		return { scaleName: params.scaleName, noteCount: params.noteCount, tubes: rig.tubes.length };

	},

	tier() {

		return Object.assign( {}, tier );

	},

	camera() {

		if ( ! stage ) return null;
		const p = stage.camera.position;
		const t = stage.controls ? stage.controls.target : { x: 0, y: 0, z: 0 };
		return {
			position: [ round3( p.x ), round3( p.y ), round3( p.z ) ],
			target: [ round3( t.x ), round3( t.y ), round3( t.z ) ],
			distance: round3( stage.cameraDistance ? stage.cameraDistance() : 0 ),
			fov: stage.camera.fov
		};

	}

};

// ---------------------------------------------------------------------------
// Go. Nothing above this line awaited anything, so the first frame is drawn
// from the default breeze: 12 mph out of the west, blowing east along +X.
// ---------------------------------------------------------------------------

if ( stage && stage.controls ) {

	stage.controls.autoRotate = ! ( reducedMotion && reducedMotion.matches );
	autoRotateSuspended = ! stage.controls.autoRotate;

}

setStatus( '' );
startLoop();
