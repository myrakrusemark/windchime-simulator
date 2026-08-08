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
import { createRig, freqsFor, setParts, PART_DEFAULTS, PART_LIMITS } from './physics.js';
import { createStage } from './scene.js';
import { createWindViz } from './windviz.js';
import { createAudio } from './audio.js';
import { CATALOGUE, DECAY_NOMINAL, TUBE_STOCK, stockFor, tubeLengthFor } from './modal.js';
import * as weather from './weather.js';

// === WCS:DESIGN-IMPORTS ===
// Design + UI module imports. One line per piece, kept in alphabetical order by
// module path so two pieces adding a line never collide on the same diff hunk.
import { applyDesign, currentDesign, emitFrame, foldIntoParams, onDesign, onFrame, setBaseDesign } from './apply.js';
import { RANGES, designFromLocation } from './design.js';
// === /WCS:DESIGN-IMPORTS ===

// ---------------------------------------------------------------------------
// Defaults and tier tables
// ---------------------------------------------------------------------------

// Which catalogue tube physics.js is actually hanging. Found by diameter rather
// than typed, so the name in the picker cannot drift away from the section the
// rig is built on: modal.js's TUBE_STOCK is one of these seven rows and every
// row has a different outside diameter.
const DEFAULT_STOCK = CATALOGUE.find( ( c ) => c.od === TUBE_STOCK.od );
const DEFAULT_STOCK_NAME = DEFAULT_STOCK ? DEFAULT_STOCK.name : 'Theta Flower of Life';

const DEFAULTS = {
	windSpeedMph: 12,      // mean wind at the 10 m reference height
	dirDeg: 270,           // meteorological FROM-bearing: 270 = from the west, blowing +X
	turbulence: 0.30,
	scaleName: 'cMajorPentatonic',
	stockName: DEFAULT_STOCK_NAME,   // a row of modal.js's CATALOGUE, by name
	noteCount: 6,
	attack: 0.002,
	decay: 8.0,            // ring trim; 8 is the tube as modelled, see modal.js DECAY_NOMINAL
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

// === WCS:DESIGN-BOOT ===
// Decode the shared design from the URL and fold it into params. Runs BEFORE any
// subsystem is constructed, so the first frame is already the shared chime.
let design = null;

try {

	const q = new URLSearchParams( window.location.search );

	// design.js reads ?wind= ?dir= ?style= ?quality= through fromLegacyParams and
	// then lets ?c= win on conflict, so every link ever shared still works. It is
	// synchronous string work: nothing above startLoop() awaits, and that is the
	// property the first paint depends on (H4).
	design = designFromLocation( window.location.search, noteError );

	// The look switch predates places. scene.js still reads params.style for its
	// projection, tone mapping and materials, so the legacy value is honoured
	// here until P4's places own the backdrop and the style becomes an idiom.
	if ( q.has( 'style' ) ) {

		const st = String( q.get( 'style' ) );
		if ( st === 'storybook' || st === 'golden' ) params.style = st;

	}

	// ?q= is a location string. It only pre-fills the box: fetching weather is
	// user-triggered work, so a shared link still costs the visitor no network
	// until they press the button. It is not part of the design and never
	// travels in ?c=.
	if ( q.has( 'q' ) ) urlQuery = String( q.get( 'q' ) ).slice( 0, 120 );

} catch ( err ) {

	noteError( 'url-parse-failed', err );

}

// One writer into params, one direction, mutating in place: wind, scene, windviz
// and audio are all about to capture this exact object (H1).
design = setBaseDesign( design );
foldIntoParams( design, params );
// === /WCS:DESIGN-BOOT ===

// ---------------------------------------------------------------------------
// 2b. Quality tier. A throwaway context tells us whether we are on a software
// rasteriser (SwiftShader in the verifier, llvmpipe on a bare Linux box),
// where 9000 grass blades and a bloom pass are not affordable.
// ---------------------------------------------------------------------------

function detectTierName() {

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

// The probe runs EXACTLY ONCE per page. Re-running it burns another WebGL
// context on a page browsers already cap, and the one the driver drops is as
// likely to be the real renderer's as the throwaway's: black picture,
// 'webgl-context-lost' in the snapshot (H35). Every later quality change
// resolves 'auto' through this cached answer and goes via applyTier().
const AUTO_TIER_NAME = detectTierName();

function tierNameFor( quality ) {

	return ( quality === 'high' || quality === 'low' ) ? quality : AUTO_TIER_NAME;

}

let tier = TIERS[ tierNameFor( params.quality ) ];

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
	tubeStockSelect: $( 'tubeStockSelect' ),
	tubeStockValue: $( 'tubeStockValue' ),
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
	hudOverlay: $( 'hudOverlay' ),
	audioToast: $( 'audioToast' ),
	dockWeather: $( 'dockWeather' ),
	wxUse: $( 'wxUse' )
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

// ---------------------------------------------------------------------------
// The tube stock the visitor picked.
//
// The section is the load-bearing number in modal.js: it sets the radius of
// gyration, which is what the Timoshenko correction turns into the mode ratios,
// and it sets the radiating area, which is what the loss budget turns into the
// ring times. Two tubes cut to the same note out of different pipe are two
// different instruments, and until now the page could only ever hang one.
//
// The wall is NOT exposed alongside it, on purpose: across the whole catalogue
// the radius of gyration is 0.323 to 0.340 of the diameter against a 5:1 range
// of stock, so a wall slider would move nothing anyone could hear. See the note
// beside the markup.
//
// KNOWN LIMIT: this reaches the sound and not the picture. physics.js hangs
// TUBE_STOCK unconditionally (createRig takes only frequencies), so the drawn
// tubes keep the default section and the default cut lengths. Give createRig a
// stock and this becomes rig.stock again, with the re-cut below deleted.
// ---------------------------------------------------------------------------

// Cached because solving a Wind River wall costs a 200-step bisection and the
// snapshot asks for the current section every time it is polled. Seven entries
// at most, so this never needs eviction.
const stockCache = new Map();

function stockNamed( name ) {

	let s = stockCache.get( name );
	if ( s !== undefined ) return s;

	try {

		s = stockFor( name );

	} catch ( err ) {

		noteError( 'unknown-tube-stock', err );
		s = rig.stock;

	}

	stockCache.set( name, s );
	return s;

}

function currentStock() {

	return params.stockName === DEFAULT_STOCK_NAME ? rig.stock : stockNamed( params.stockName );

}

// The tube list audio.js gets, re-cut for the chosen section.
//
// A tube's length is not free once its note and its stock are fixed, so voicing
// a 76 mm section on a length cut for a 44 mm one would describe a tube that
// rings at 490 Hz while claiming middle C. audio.js reads only `f1` and `L`, so
// the honest thing to hand it is the length THIS stock has to be cut to for
// that note, which is exactly what modal.js derives internally when no length
// is given. On the default stock this is the rig's own array, untouched, so
// nothing about the shipped chime changes by a single bit.
function audioTubes( stock ) {

	if ( stock === rig.stock ) return rig.tubes;
	return rig.tubes.map( ( t ) => ( { f1: t.f1, L: tubeLengthFor( t.f1, stock ) } ) );

}

function pushTubesToAudio() {

	if ( ! audio ) return;
	const stock = currentStock();
	audio.setTubes( audioTubes( stock ), stock );

}

try {

	audio = createAudio( params );
	// The tier has to reach audio at boot as well as on a later change, or a
	// phone runs the desktop's five partials and sixteen voices all session.
	audio.setTier( tier );
	// The section travels with the tubes. audio.js voices the mode ratios of
	// the tube the rig is actually hanging rather than a constant of its own.
	pushTubesToAudio();

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
let toastDone = false;
let autoRotateSuspended = true;   // starts suspended until the first idle window

// The simulation IS the page; it always opens on it. Browsers restore the
// previous scroll offset on reload, and pressing "How it works" leaves #learn in
// the address bar, so a later load would land the visitor in the documentation
// with the chime scrolled off the top. Both are handled by turning scroll
// restoration off and going to the top.
//
// What used to be here as well was an unconditional replaceState that STRIPPED
// the fragment. It is gone, for three reasons in order of weight (CONTRACTS
// section 4.4): a shareable-URL product may not rewrite the URL it was handed,
// and this fired at module-eval time so whatever a stranger pasted, the address
// bar they can copy back is a different string; it races P6, which owns the
// address bar and writes it with replaceState on every design change, and two
// writers 200 lines apart is a boot-order dependency between two pieces that
// must not know about each other; and it bought nothing on top of the two lines
// below, which already fix both failures it was written for.
try {

	if ( 'scrollRestoration' in history ) history.scrollRestoration = 'manual';
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
	if ( dom.tubeStockSelect ) dom.tubeStockSelect.value = params.stockName;
	setStockLabel();
	if ( dom.noteCountSlider ) dom.noteCountSlider.value = String( params.noteCount );
	setNoteCountLabel();
	if ( dom.attackSlider ) dom.attackSlider.value = String( params.attack );
	setText( dom.attackValue, params.attack.toFixed( 4 ) + ' s' );
	if ( dom.decaySlider ) dom.decaySlider.value = String( params.decay );
	setText( dom.decayValue, ringTrimText() );
	if ( dom.loudnessSlider ) dom.loudnessSlider.value = String( params.loudness );
	setText( dom.loudnessValue, Math.round( params.loudness * 100 ) + '%' );
	if ( dom.sunSlider ) dom.sunSlider.value = String( params.sunElevDeg );
	setText( dom.sunValue, Math.round( params.sunElevDeg ) + ' deg' );
	if ( dom.qualitySelect ) dom.qualitySelect.value = params.quality;
	if ( dom.styleSelect ) dom.styleSelect.value = params.style;
	syncPartControls();

}

// `decay` stopped being a T60 in seconds when modal.js started computing the
// ring time from the tube's own radiation and its cord. It is a multiplier on
// that result now, so the readout is a ratio against DECAY_NOMINAL rather than
// a duration, and the neutral position is called out by name: a visitor who has
// dragged the slider needs to be able to find their way back to the tube the
// physics actually builds.
function ringTrimText() {

	const x = params.decay / DECAY_NOMINAL;
	return x.toFixed( 2 ) + '×' + ( Math.abs( x - 1 ) < 5e-3 ? ' (as built)' : '' );

}

// The picker names an instrument; the readout gives the two numbers that name
// actually stands for, in the units a hardware shop sells pipe in. The wall is
// shown because Wind River do not publish theirs and modal.js solves it from
// their own length and key, which is worth being able to see.
function setStockLabel() {

	const s = currentStock();
	const mm = ( m ) => ( Math.round( m * 10000 ) / 10 ).toFixed( 1 );
	setText( dom.tubeStockValue, mm( s.od ) + ' mm across, ' + mm( 0.5 * ( s.od - s.id ) ) + ' mm wall' );

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
		pushTubesToAudio();
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

			// The debounce stays on the DRAG, not on the apply: a rebuild per input
			// event of a slider drag is unaffordable. What lands at the end of it is
			// the ordinary synchronous apply, so params, the rig, audio, the
			// readouts and the shared design all move together and the design can
			// never fall behind what the rig is actually built from.
			applyDesign( {
				clapper: { width: params.clapperWidth, mass: params.clapperMass, drop: params.clapperDrop },
				sail: { mass: params.sailMass, height: params.sailHeight }
			}, designCtx );

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

// The same idea as bindPart, one level up: a slider's travel comes from the
// authority on the value, not from a number typed into the markup. Without it
// the shipped attack slider runs to 0.05 while the design clamps at 0.020 and
// the top half of its travel is silently dead, and the ring trim starts below
// the range the design allows at all. index.html belongs to P3; this keeps the
// two honest without either file having to know the other's numbers (H32).
function bindDesignRange( el, key, apply ) {

	if ( ! el ) return;
	const r = RANGES[ key ];
	if ( r ) {

		el.min = String( r[ 0 ] );
		el.max = String( r[ 1 ] );

	}

	bindRange( el, apply );

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

		// Through applyDesign, like every other control: clampDesign refuses a
		// scale that is not in the table, and the shared design cannot drift away
		// from the chime that is hanging.
		applyDesign( { tubes: { scale: dom.chimeScaleSelect.value } }, designCtx );

	} );

}

if ( dom.tubeStockSelect ) {

	// Built from the catalogue rather than written into the markup, for the same
	// reason the Chime parts sliders take their limits from physics.js: adding a
	// published tube to modal.js should put it in this menu and nowhere else.
	dom.tubeStockSelect.textContent = '';
	for ( const entry of CATALOGUE ) {

		const opt = document.createElement( 'option' );
		opt.value = entry.name;
		opt.textContent = entry.name;
		dom.tubeStockSelect.appendChild( opt );

	}

	dom.tubeStockSelect.value = params.stockName;

	dom.tubeStockSelect.addEventListener( 'change', () => {

		// No rebuild: the notes and the tube count are unchanged, and the rig is
		// still hanging the section physics.js was built on. Only what audio.js
		// voices moves, so applyDesign takes the push-once branch. See the KNOWN
		// LIMIT note above pushTubesToAudio.
		applyDesign( { tubes: { stock: dom.tubeStockSelect.value } }, designCtx );

	} );

}

bindDesignRange( dom.noteCountSlider, 'tubes.notes', ( v ) => {

	// The old page allowed zero tubes, which is a chime that cannot ring; three
	// is the floor everywhere, and eight is structural rather than a UI limit -
	// physics.js allocates its pair-collision arrays once per rig for MAX_TUBES,
	// so a ninth tube would ring off the clapper and never clack against its
	// neighbour (H33). clampDesign holds the same 3..8 so there is one authority.
	applyDesign( { tubes: { notes: Math.round( v ) } }, designCtx );

} );

// The voice and the sun are immediate: no rebuild, no audio push, nothing to
// coalesce. They still go through applyDesign so the shared design is what the
// address bar and the caption read, rather than a second copy of the state.
bindDesignRange( dom.attackSlider, 'voice.attack', ( v ) => {

	applyDesign( { voice: { attack: v } }, designCtx );

} );

bindDesignRange( dom.decaySlider, 'voice.decay', ( v ) => {

	applyDesign( { voice: { decay: v } }, designCtx );

} );

bindDesignRange( dom.loudnessSlider, 'voice.loudness', ( v ) => {

	applyDesign( { voice: { loudness: v } }, designCtx );

} );

bindRange( dom.sunSlider, ( v ) => {

	applyDesign( { view: { sun: v } }, designCtx );

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
		applyTier( TIERS[ tierNameFor( params.quality ) ] );

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

// ---------------------------------------------------------------------------
// The design runtime.
//
// window.__wcs is the ONLY API the other five pieces get into this file. params,
// rig, wind, viz and audio stay private: everything the pieces need, they get
// through these five members, which is what keeps main.js a file one person can
// still edit after six branches have landed in it.
//
// designCtx is the bundle of seams apply.js drives. Every member is a function
// so a `let` that gets reassigned later - stage, viz, tier - is read live rather
// than captured stale.
// ---------------------------------------------------------------------------

const designCtx = {
	params,
	noteError,
	setParts,
	rebuildChime,
	pushTubesToAudio,
	syncControlValues,
	applyTier,
	tierFor: ( quality ) => TIERS[ tierNameFor( quality ) ],
	sunRange: () => [ sunLo, sunHi ],
	defaultSun: () => ( stage && stage.sunElevation ? stage.sunElevation() : params.sunElevDeg ),
	setWeather: ( mph, dirDeg ) => wind.setWeather( mph, dirDeg ),
	// P4 adds setPlace to the stage object and P5 adds setFraming (CONTRACTS
	// section 2.4). Routed through the stage so neither piece has to edit a line
	// of main.js to be wired up; absent today, which makes both a no-op.
	setPlace: ( id ) => {

		if ( stage && stage.setPlace ) stage.setPlace( id );

	},
	setFraming: ( u, v, scale ) => {

		if ( stage && stage.setFraming ) stage.setFraming( u, v, scale );

	}
};

if ( ! window.__wcs ) window.__wcs = {};

window.__wcs.design = () => structuredClone( currentDesign() );
window.__wcs.applyDesign = ( d ) => applyDesign( d, designCtx );
window.__wcs.onDesign = onDesign;
window.__wcs.onFrame = onFrame;
// A getter, not a copy: `stage` is rebuilt from scratch after a GL context loss,
// and a piece holding the old handle would be drawing into a dead renderer.
Object.defineProperty( window.__wcs, 'stage', { get: () => stage, configurable: true } );

// === WCS:UI-MOUNT ===
// UI pieces mount here, after the stage exists and after syncControlValues().
// One line per piece, alphabetical by function name. A mount must not throw and
// must not await; wrap your own body in try/catch and call noteError on failure.
// === /WCS:UI-MOUNT ===

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

	// Sky icon and conditions. The row is hidden until there is a reading, so
	// before then the dock has no empty strip under the input.
	if ( dom.dockWeather && dom.wxUse ) {

		const sky = String( reading.sky || 'clear' );
		// Only clear and partly have a night face; a cloud looks the same at
		// midnight as it does at noon.
		const night = reading.isDay === false && ( sky === 'clear' || sky === 'partly' );
		dom.wxUse.setAttribute( 'href', '#wx-' + sky + ( night ? '-night' : '' ) );
		dom.dockWeather.classList.remove( 'hidden' );

	}

	const label = weatherState.place ? weatherState.place + ': ' : '';
	const bits = [];
	if ( reading.forecast ) bits.push( reading.forecast );
	if ( Number.isFinite( reading.tempF ) ) bits.push( Math.round( reading.tempF ) + '\u00B0F' );
	bits.push( compassLetters( reading.dirDeg ) + ' at ' + Math.round( reading.speedMph ) + ' mph' +
		( reading.gustMph ? ', gusting ' + Math.round( reading.gustMph ) : '' ) );
	setStatus( label + bits.join( ' \u00B7 ' ) );

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

// How long the pointer must be still before the HUD starts to go. Short, because
// the fade itself is long: the controls begin dissolving almost as soon as you
// stop, and take a couple of seconds about it. updateHud runs every tenth frame,
// so the check granularity is a frame or two either side of this.
const HUD_IDLE_MS = 850;

function goIdle() {

	if ( hudIdle || ! audioUnlocked || ! dom.hudOverlay ) return;
	// Not while the settings drawer is open: that is a deliberate mode, and
	// fading the HUD out from under someone reading the sliders is wrong.
	if ( dom.sliderMenu && dom.sliderMenu.classList.contains( 'visible' ) ) return;
	dom.hudOverlay.classList.add( 'idle' );
	hudIdle = true;

}

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

// Leaving the window is as clear a signal as going still, and clearer than
// waiting out the timer: the pointer is not coming back to these controls until
// it comes back to the page. pointerleave on the document catches the pointer
// crossing the edge; blur catches the window losing focus with the pointer
// already outside it, which a keyboard switch does.
// Any gesture at all unlocks the audio, which is what the toast promises.
// The canvas already did it, but a click on the HUD backdrop or a key press did
// not, and "click anywhere" has to mean anywhere. Capture phase so a handler
// that stops propagation cannot swallow it, and passive because none of this
// wants to preventDefault.
for ( const evt of [ 'pointerdown', 'keydown' ] ) {

	window.addEventListener( evt, () => {

		markInteraction();
		unlockAudio();

	}, { capture: true, passive: true } );

}

window.addEventListener( 'blur', goIdle );
// documentElement as well as document: leave events on `document` are not
// reliably delivered across browsers, while the root ELEMENT gets them when the
// cursor crosses the window edge. goIdle is idempotent, so a double delivery
// costs nothing and a missing one would leave the controls up.
for ( const target of [ document, document.documentElement ] ) {

	target.addEventListener( 'pointerleave', goIdle );
	target.addEventListener( 'mouseleave', goIdle );

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

// ---------------------------------------------------------------------------
// Hidden tabs.
//
// The chime is meant to be left running in a tab you are not looking at, so a
// hidden page keeps making sound. It cannot keep ANIMATING: requestAnimationFrame
// stops when the page is hidden and there is no way around that, nor any point
// -- nobody is watching. But Web Audio runs on its own thread and does not stop,
// and Chrome exempts an audible page from the intensive throttling that would
// otherwise cut its timers to one a minute.
//
// So the physics moves onto a timer, and the drawing simply stops.
//
// The catch is that a background timer is clamped to about a second, and a
// second of strikes dispatched at once is a burst, not a chime. The fix is to
// simulate AHEAD of the audio clock and schedule each strike at its true offset:
// Web Audio plays them at the right moments whether or not the main thread is
// awake in between. That is the same look-ahead a step sequencer uses.
//
// LEAD is how far ahead of real time the simulation is kept. It has to comfortably
// exceed the timer's period, or the audio runs dry between wake-ups.
// ---------------------------------------------------------------------------

const BG_TICK_MS = 250;
const BG_LEAD_SEC = 1.6;
// A tab that was hidden for an hour must not try to catch up on an hour. The
// chime simply missed that time, which is what a real one does.
const BG_MAX_CATCHUP_SEC = 3.0;

let bgTimer = 0;
let bgLead = 0;        // seconds of simulation produced beyond the audio clock
let bgLastMs = 0;

function backgroundTick() {

	const now = performance.now();
	const real = clamp( ( now - bgLastMs ) / 1000, 0, BG_MAX_CATCHUP_SEC );
	bgLastMs = now;

	// Real time has passed, so the cushion built last wake-up has been consumed.
	bgLead = Math.max( 0, bgLead - real );

	let todo = Math.min( BG_LEAD_SEC - bgLead, BG_MAX_CATCHUP_SEC );

	while ( todo > 1e-3 ) {

		// One frame's worth at a time, so the solver sees the same step sizes it
		// sees in the foreground and the rig behaves identically.
		const chunk = Math.min( todo, SUBSTEP_MAX * SUBSTEP_CAP );
		stepSimulation( chunk, bgLead );
		bgLead += chunk;
		todo -= chunk;

	}

	try {

		rig.syncState();
		if ( audio ) audio.setContactMask( rig.contactMask );

	} catch ( err ) {

		noteError( 'bg-sync-failed', err );

	}

}

function startBackground() {

	if ( bgTimer ) return;
	bgLastMs = performance.now();
	bgLead = 0;
	bgTimer = setInterval( backgroundTick, BG_TICK_MS );

}

function stopBackground() {

	if ( ! bgTimer ) return;
	clearInterval( bgTimer );
	bgTimer = 0;
	bgLead = 0;

}

document.addEventListener( 'visibilitychange', () => {

	if ( document.hidden ) {

		stopLoop();
		// Audio is deliberately NOT suspended. Suspending it is what silenced a
		// backgrounded tab, and it also forfeits the throttling exemption an
		// audible page gets -- so suspending would have made the timers below
		// useless as well as pointless.
		startBackground();

	} else {

		stopBackground();
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
	if ( idleFor > HUD_IDLE_MS ) goIdle();

	// Reduced motion: the simulation is the content and stays, but the camera
	// stops drifting on its own.
	const allowAutoRotate = ! ( reducedMotion && reducedMotion.matches );
	if ( autoRotateSuspended && idleFor > 12000 && allowAutoRotate && stage && stage.controls ) {

		stage.controls.autoRotate = true;
		autoRotateSuspended = false;

	}

}

// ---------------------------------------------------------------------------
// The simulation, with no drawing in it.
//
// Split out of the frame because the tab can be hidden, where there are no
// animation frames but there is still an audio thread. leadSec is how far ahead
// of the audio clock this chunk is being computed: zero in the foreground,
// where the chunk IS now, and up to the look-ahead in the background.
// ---------------------------------------------------------------------------

function stepSimulation( dt, leadSec ) {

	// Wind first: everything downstream samples the field this call leaves.
	try {

		wind.update( dt );

	} catch ( err ) {

		noteError( 'wind-update-failed', err );

	}

	// Substeps. Fixed maximum step size, variable count, no leftover
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

	// Strikes. Each event carries the substep it happened in, so audio can place
	// it inside the chunk instead of quantising every hit to the chunk boundary
	// and comb-filtering a gust into a metallic flam. leadSec shifts the whole
	// chunk into the future, which is what makes background audio come out
	// evenly spaced rather than in one burst per wake-up.
	try {

		const events = rig.drainStrikes();
		for ( let i = 0; i < events.length; i ++ ) {

			dispatchStrike( events[ i ], h, leadSec );

		}

	} catch ( err ) {

		noteError( 'strike-dispatch-failed', err );

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

	stepSimulation( dt, 0 );

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

	// === WCS:FRAME-HOOK ===
	// Per-frame callbacks registered by UI pieces. Called once per rendered frame,
	// after stage.render(). Must be allocation-free and must never throw.
	emitFrame( dt, noteError );
	// === /WCS:FRAME-HOOK ===

	// The toast comes down when the context is actually RUNNING, not when the
	// gesture arrives: resume() is a promise and can be refused, and a toast
	// that leaves on the click would be lying in exactly the case it matters.
	if ( dom.audioToast && ! toastDone && audio && audio.ready() ) {

		toastDone = true;
		dom.audioToast.classList.add( 'done' );

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

function dispatchStrike( ev, h, leadSec ) {

	strikes ++;

	if ( audio ) {

		try {

			audio.strike( ev, ( ev.substep || 0 ) * h + ( leadSec || 0 ) );

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
		// The section audio.js is voicing, and the length the longest tube would
		// be cut to out of it. Without these a regression run can see that the
		// stock picker moved, but not that anything downstream heard it. In
		// millimetres, because round3 on metres would round a 2.6 mm wall to 3.
		stock: ( () => {

			const s = currentStock();
			return {
				name: params.stockName,
				odMm: round3( s.od * 1000 ),
				wallMm: round3( 0.5 * ( s.od - s.id ) * 1000 ),
				cutLongest: round3( rig.tubes.reduce( ( m, t ) => Math.max( m, tubeLengthFor( t.f1, s ) ), 0 ) )
			};

		} )(),
		substeps: lastSubsteps,
		simTime: round3( rig.simTime ),
		weather: {
			source: weatherState.source,
			place: weatherState.place,
			ageSec: weatherState.at ? Math.round( ( Date.now() - weatherState.at ) / 1000 ) : null
		}
	};

}

// Assign rather than replace: the design members were installed at WCS:UI-MOUNT,
// ~1200 lines up, because the UI pieces mount there and need them.
Object.assign( window.__wcs, {

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
		dispatchStrike( ev, 0, 0 );
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

		// Kept for the verifiers that already call it, but it is now a thin shim
		// over applyDesign rather than a second writer: clampDesign refuses an
		// unknown scale and holds the same 3..8 on the tube count, and the shared
		// design cannot end up describing a chime other than the one hanging.
		const patch = { tubes: {} };
		if ( typeof scaleName === 'string' ) patch.tubes.scale = scaleName;
		if ( Number.isFinite( count ) ) patch.tubes.notes = count;
		const d = applyDesign( patch, designCtx );
		return { scaleName: d.tubes.scale, noteCount: d.tubes.notes, tubes: rig.tubes.length };

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

} );

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
