/**
 * design.js - the design object, its clamp, its caption and its URL codec.
 *
 * This file is pure. No DOM, no three.js, no await, no module-level state that
 * anything can write to. Given the same arguments it always returns the same
 * answer, in a browser or under plain `node`, which is what lets
 * tools/verify-design.mjs import it directly and run 500 round trips without a
 * browser anywhere in the picture.
 *
 * ONE IMPORT, ON PURPOSE. modal.js has no imports of its own, so pulling
 * CATALOGUE from it costs nothing and means the tube names in the codec cannot
 * drift away from the tubes the simulator actually hangs. physics.js is NOT
 * imported even though it owns SCALES and PART_LIMITS: it imports three, and a
 * design module that drags a WebGL library behind it is not a design module and
 * cannot be verified without a browser. The scale keys and the part ranges are
 * therefore restated below, and tools/verify-design.mjs cross-checks every one
 * of them against physics.js on every run, so a drift is a failing test rather
 * than a silent lie (CONTRACTS H32).
 *
 * The design object is the only state the six pieces share. params stays
 * main.js's private business and only apply.js writes into it.
 */

import { CATALOGUE } from './modal.js';

// ---------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------

export const CODEC_VERSION = 1;

export const DESIGN_DEFAULTS = {
	v: 1,                              // int, codec version

	// FLIPPED BY P4, IN THE COMMIT THAT SHIPS THE PLATE, exactly as the line it
	// replaces asked for.
	//
	// It was held at 'porch' while places.js did not exist, because the only
	// scene the build could draw was the procedural porch and describe() is the
	// one sentence a stranger reads - "hung on the forest path" over a green lawn
	// is a caption that lies. assets/places/forest-path/plate.webp is now on
	// disk, places.js resolves the id, and the caption is true again.
	place: 'forest-path',              // string, a key of places.js PLACES
	tubes: {
		scale: 'cMajorPentatonic',      // string, a key of physics.js SCALES
		notes: 6,                       // int
		stock: 'Theta Flower of Life'   // string, a .name of modal.js CATALOGUE
	},
	clapper: { width: 0.068, mass: 0.035, drop: 0.400 },    // m, kg, m
	sail: { mass: 0.032, height: 0.150 },                   // kg, m
	// AMENDS CONTRACTS section 3, which authored v as 0.42. The default hang has
	// to be the default PLACE's own hang default or a cold load of ?c=v1 shows a
	// frame nobody composed: places.js raised forest-path's frame 0.30 m to bring
	// the limb the chime hangs from into shot, and 0.36 is that same fact. The
	// authority column in CONTRACTS section 3 already says places.js decides this
	// number; design.js cannot import it (this file stays pure), so the two are
	// tied by an assertion in tools/verify-place.mjs instead.
	hang: { u: 0.50, v: 0.40, scale: 1.00 },                // plate fraction, plate fraction, ratio
	// splats is the fraction of the capture's gaussians that get drawn. It is a
	// SECOND quality dial and not a refinement of the first: `quality` is the
	// renderer tier for the chime - shadows, post-processing, the things scene.js
	// switches - and it has nothing to say about a place that arrived as a
	// hundred thousand sorted quads. One number cannot serve both, because the
	// device that needs the tier dropped is not always the device that needs the
	// forest thinned.
	view: { sun: null, quality: 'auto', splats: 1.00 },     // degrees or null, 'auto'|'high'|'low', 0..1
	voice: { attack: 0.002, decay: 8.0, loudness: 0.50 },   // s, s, 0..1
	wind: { mph: null, dirDeg: null, turbulence: null, source: 'place' }
};

// The four nested groups, named once. Everything that walks the shape walks
// this list, so adding a group is one edit and not five.
const SECTIONS = Object.freeze( [ 'tubes', 'clapper', 'sail', 'hang', 'view', 'voice', 'wind' ] );

// ---------------------------------------------------------------------------
// Ranges.
//
// The authority for each one is named in CONTRACTS section 3. The numbers are
// restated here because this file may not import physics.js (see the header);
// tools/verify-design.mjs asserts they still agree.
//
// `q` is the wire quantum: the number the value is multiplied by to reach the
// integer that travels in the URL. clampDesign SNAPS every number onto that
// grid, which is what makes decode(encode(d)) exact rather than approximate.
// It also means no field can ever hold a value the share link cannot carry.
// ---------------------------------------------------------------------------

export const RANGES = Object.freeze( {
	'tubes.notes': [ 3, 8 ],            // physics.js freqsFor clamps here; MAX_TUBES = 8 is structural
	'clapper.width': [ 0.030, 0.100 ],  // PART_LIMITS.clapperWidth
	'clapper.mass': [ 0.008, 0.090 ],   // PART_LIMITS.clapperMass
	'clapper.drop': [ 0.250, 0.620 ],   // PART_LIMITS.clapperDrop
	'sail.mass': [ 0.008, 0.090 ],      // PART_LIMITS.sailMass
	'sail.height': [ 0.070, 0.300 ],    // PART_LIMITS.sailHeight
	'hang.u': [ 0, 1 ],                 // the structural superset; a place narrows it further
	'hang.v': [ 0, 1 ],
	'hang.scale': [ 0.6, 1.8 ],
	'view.sun': [ 2, 74 ],              // scene.js SUN_LO/SUN_HI across both styles
	// Floor at 0.05 rather than 0. Zero is not a quality setting, it is deleting
	// the place, and a slider a visitor can drag into "there is no forest" reads
	// as a bug however honestly it was labelled. Five percent of this capture is
	// still 4,993 gaussians and still legibly a wood.
	'view.splats': [ 0.05, 1.00 ],
	'voice.attack': [ 0.0005, 0.020 ],
	'voice.decay': [ 1.0, 20.0 ],       // DECAY_NOMINAL = 8 is unity
	'voice.loudness': [ 0, 1 ],
	'wind.mph': [ 0, 60 ],
	'wind.turbulence': [ 0.05, 1.0 ]
} );

// ---------------------------------------------------------------------------
// The frozen alias tables. Adding a scale or a stock adds a row here and does
// NOT bump the codec version: an unknown alias decodes to the default, which is
// forward compatibility, not an error.
// ---------------------------------------------------------------------------

export const SCALE_KEYS = Object.freeze( [
	'cMajorPentatonic', 'cMinorPentatonic', 'cMajorDiatonic', 'cNaturalMinor',
	'cLydian', 'cMixolydian', 'cWholeTone', 'cOctaveIntervals'
] );

export const SCALE_ALIAS = Object.freeze( {
	cMajorPentatonic: 'pent',
	cMinorPentatonic: 'mpent',
	cMajorDiatonic: 'maj',
	cNaturalMinor: 'min',
	cLydian: 'lyd',
	cMixolydian: 'mix',
	cWholeTone: 'whole',
	cOctaveIntervals: 'oct'
} );

// Taken from the catalogue rather than typed, so a renamed tube is a decode
// miss the verifier catches instead of a name that silently no longer exists.
export const STOCK_NAMES = Object.freeze( CATALOGUE.map( ( c ) => c.name ) );

export const STOCK_ALIAS = Object.freeze( {
	'Theta Twin Flame small': 'tf-s',
	'Theta Twin Flame large': 'tf-l',
	'Theta Flower of Life': 'fol',
	'Theta Supergiant': 'sg',
	'Corinthian Bells 50': 'cb50',
	'Corinthian Bells 65': 'cb65',
	'Corinthian Bells 78': 'cb78'
} );

export const QUALITY_ALIAS = Object.freeze( { auto: 'a', high: 'h', low: 'l' } );
export const WIND_SOURCE_ALIAS = Object.freeze( { place: 'p', weather: 'w' } );

function invert( table ) {

	const out = Object.create( null );
	for ( const k of Object.keys( table ) ) out[ table[ k ] ] = k;
	return Object.freeze( out );

}

const SCALE_BY_ALIAS = invert( SCALE_ALIAS );
const STOCK_BY_ALIAS = invert( STOCK_ALIAS );
const QUALITY_BY_ALIAS = invert( QUALITY_ALIAS );
const WIND_SOURCE_BY_ALIAS = invert( WIND_SOURCE_ALIAS );

const SCALE_SET = new Set( SCALE_KEYS );
const STOCK_SET = new Set( STOCK_NAMES );
const QUALITY_SET = new Set( Object.keys( QUALITY_ALIAS ) );
const WIND_SOURCE_SET = new Set( Object.keys( WIND_SOURCE_ALIAS ) );

// A place id is validated for SHAPE only. design.js may not import places.js -
// P4 owns it and it does not exist yet - so the semantic fallback for an id
// that names no place lives in resolvePlace(). A well-formed unknown id
// therefore survives the round trip untouched, which is what keeps a link from
// a newer build from being mangled by an older one.
const PLACE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// ---------------------------------------------------------------------------
// Total, unopinionated coercion helpers. None of these can throw and none of
// them can return undefined.
// ---------------------------------------------------------------------------

const EMPTY = Object.freeze( {} );

function obj( v ) {

	return ( v !== null && typeof v === 'object' && ! Array.isArray( v ) ) ? v : EMPTY;

}

// Deliberately stricter than Number(): null, '', true, [] and {} are all
// "no number given", not zero. A design field that reads 0 because someone
// passed null is the kind of bug that only shows up as a silent chime.
function toNumber( v ) {

	if ( typeof v === 'number' ) return Number.isFinite( v ) ? v : NaN;
	if ( typeof v === 'string' && v.trim() !== '' ) {

		const x = Number( v );
		return Number.isFinite( x ) ? x : NaN;

	}

	return NaN;

}

function clampTo( x, lo, hi ) {

	return x < lo ? lo : ( x > hi ? hi : x );

}

/** Clamp into range, then snap onto the wire grid, then clamp again. */
function snap( v, key, quantum, fallback ) {

	const r = RANGES[ key ];
	let x = toNumber( v );
	if ( ! Number.isFinite( x ) ) x = fallback;
	x = clampTo( x, r[ 0 ], r[ 1 ] );
	x = Math.round( x * quantum ) / quantum;
	return clampTo( x, r[ 0 ], r[ 1 ] );

}

/** The same, but null is a legal value meaning "the place decides". */
function snapOrNull( v, key, quantum ) {

	if ( v === null || v === undefined ) return null;
	const x = toNumber( v );
	if ( ! Number.isFinite( x ) ) return null;
	const r = RANGES[ key ];
	return clampTo( Math.round( clampTo( x, r[ 0 ], r[ 1 ] ) * quantum ) / quantum, r[ 0 ], r[ 1 ] );

}

/** Compass bearing: null passes through, everything else wraps into 0..359. */
function bearingOrNull( v ) {

	if ( v === null || v === undefined ) return null;
	const x = toNumber( v );
	if ( ! Number.isFinite( x ) ) return null;
	const r = Math.round( x );
	return ( ( r % 360 ) + 360 ) % 360;

}

function pick( v, set, fallback ) {

	return ( typeof v === 'string' && set.has( v ) ) ? v : fallback;

}

// ---------------------------------------------------------------------------
// clampDesign - total. Never throws, never returns undefined, always returns a
// complete object with every key present. Out-of-range numbers clamp, unknown
// strings fall back to the default, unknown keys are dropped.
// ---------------------------------------------------------------------------

export function clampDesign( partial ) {

	const p = obj( partial );
	const tubes = obj( p.tubes );
	const clapper = obj( p.clapper );
	const sail = obj( p.sail );
	const hang = obj( p.hang );
	const view = obj( p.view );
	const voice = obj( p.voice );
	const wind = obj( p.wind );
	const D = DESIGN_DEFAULTS;

	return {
		// Only one version exists. A link from a future build decodes what this
		// build understands and carries this build's version number back out.
		v: CODEC_VERSION,
		place: ( typeof p.place === 'string' && PLACE_ID_RE.test( p.place ) ) ? p.place : D.place,
		tubes: {
			scale: pick( tubes.scale, SCALE_SET, D.tubes.scale ),
			notes: snap( tubes.notes, 'tubes.notes', 1, D.tubes.notes ),
			stock: pick( tubes.stock, STOCK_SET, D.tubes.stock )
		},
		clapper: {
			width: snap( clapper.width, 'clapper.width', 1000, D.clapper.width ),
			mass: snap( clapper.mass, 'clapper.mass', 1000, D.clapper.mass ),
			drop: snap( clapper.drop, 'clapper.drop', 1000, D.clapper.drop )
		},
		sail: {
			mass: snap( sail.mass, 'sail.mass', 1000, D.sail.mass ),
			height: snap( sail.height, 'sail.height', 1000, D.sail.height )
		},
		hang: {
			u: snap( hang.u, 'hang.u', 100, D.hang.u ),
			v: snap( hang.v, 'hang.v', 100, D.hang.v ),
			scale: snap( hang.scale, 'hang.scale', 100, D.hang.scale )
		},
		view: {
			sun: snapOrNull( view.sun, 'view.sun', 1 ),
			quality: pick( view.quality, QUALITY_SET, D.view.quality ),
			splats: snap( view.splats, 'view.splats', 100, D.view.splats )
		},
		voice: {
			attack: snap( voice.attack, 'voice.attack', 10000, D.voice.attack ),
			decay: snap( voice.decay, 'voice.decay', 10, D.voice.decay ),
			loudness: snap( voice.loudness, 'voice.loudness', 100, D.voice.loudness )
		},
		wind: {
			mph: snapOrNull( wind.mph, 'wind.mph', 1 ),
			dirDeg: bearingOrNull( wind.dirDeg ),
			turbulence: snapOrNull( wind.turbulence, 'wind.turbulence', 100 ),
			source: pick( wind.source, WIND_SOURCE_SET, D.wind.source )
		}
	};

}

/**
 * Structural merge, one level into each section. `partial` wins wherever it
 * carries a key, INCLUDING when the value is null - null is a real value on the
 * wind and sun fields and means "hand it back to the place". `undefined` is the
 * only way to say "leave this alone". Does not clamp; feed the result to
 * clampDesign.
 */
export function mergeDesign( base, partial ) {

	const b = obj( base );
	const p = obj( partial );
	const out = {};

	for ( const key of Object.keys( DESIGN_DEFAULTS ) ) {

		if ( SECTIONS.indexOf( key ) === - 1 ) {

			out[ key ] = ( p[ key ] !== undefined ) ? p[ key ] : b[ key ];
			continue;

		}

		const bs = obj( b[ key ] );
		const ps = obj( p[ key ] );
		const section = {};
		for ( const f of Object.keys( DESIGN_DEFAULTS[ key ] ) ) {

			section[ f ] = ( ps[ f ] !== undefined ) ? ps[ f ] : bs[ f ];

		}

		out[ key ] = section;

	}

	return out;

}

// ---------------------------------------------------------------------------
// The caption.
//
// ONE sentence, and the single source of truth for both the line under the
// object (P3) and the share text (P6). Nobody writes a second one.
//
// It names the tube stock as a SOUND choice, deliberately. physics.js hangs one
// section unconditionally, so the drawn tubes do not change with the picker
// (CONTRACTS H9) and a caption claiming the metal looks different would be
// lying about the picture.
// ---------------------------------------------------------------------------

const COUNT_WORDS = Object.freeze( {
	3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight'
} );

const SCALE_NAMES = Object.freeze( {
	cMajorPentatonic: 'C major pentatonic',
	cMinorPentatonic: 'C minor pentatonic',
	cMajorDiatonic: 'C major',
	cNaturalMinor: 'C natural minor',
	cLydian: 'C lydian',
	cMixolydian: 'C mixolydian',
	cWholeTone: 'C whole tone',
	cOctaveIntervals: 'C octaves'
} );

// The two places CONTRACTS section 5.4 names. Anything else is de-slugged, so a
// place P4 adds later reads as English here without editing this file.
const PLACE_PHRASES = Object.freeze( {
	'forest-path': 'the forest path',
	porch: 'the porch'
} );

export function placePhrase( id ) {

	if ( typeof id !== 'string' ) return PLACE_PHRASES[ DESIGN_DEFAULTS.place ];
	if ( PLACE_PHRASES[ id ] ) return PLACE_PHRASES[ id ];
	return 'the ' + id.replace( /-+/g, ' ' ).trim();

}

// ---------------------------------------------------------------------------
// Traits: how a slider becomes a word.
//
// THE THRESHOLD RULE, once, for every continuous field: the MIDDLE HALF of the
// slider's own travel is stock and gets no word; the outer quarters get one.
// The edges are therefore the field's own quartiles, read straight off RANGES,
// which section 7 of tools/verify-design.mjs asserts are still PART_LIMITS.
// Nothing here is a hand-typed number, so widening a limit in physics.js moves
// these thresholds with it instead of silently mis-describing the new range.
//
// Why quartiles and not thirds or halves. Three things had to be true at once:
//
//   1. Every shipped default lands in the silent middle. It does: 68 mm of
//      30..100, 35 g of 8..90, 400 mm of 250..620, 32 g of 8..90, 150 mm of
//      70..300, 8.0 s of 1..20, 0.50 of 0..1. Nothing is stock AND remarkable,
//      so the default sentence is the one already on screen, unchanged.
//   2. Either end of every slider clears its own edge, so every control can
//      still move the sentence. Quartiles are the widest silent band for which
//      that holds with these defaults; thirds would swallow the loudness slider
//      at 0.50 -> 1.00 and halves would make a 70 mm striker "broad".
//   3. The prompt's own case: 68 mm and 69 mm read the same (both inside
//      47.5..82.5 mm), 68 mm and 95 mm do not (95 is past the upper quartile).
//
// A word appears only when the visitor has pushed a part off stock, which is
// also why the sentence stays a sentence: at rest it names the tubes and the
// place, and it grows only as there is something to say.
// ---------------------------------------------------------------------------

/** The quarter and three-quarter points of a field's own range. */
function quartiles( key ) {

	const r = RANGES[ key ];
	const span = r[ 1 ] - r[ 0 ];
	return [ r[ 0 ] + span * 0.25, r[ 0 ] + span * 0.75 ];

}

/**
 * The same, on a log scale. Only voice.attack uses it: 0.5..20 ms is heard
 * logarithmically, and the shipped 2 ms sits at the 8th percentile linearly but
 * comfortably inside the middle half geometrically (1.26 .. 7.95 ms). Linear
 * quartiles would call the default attack "bright" and then have nowhere to go
 * when the visitor asks for brighter.
 */
function logQuartiles( key ) {

	const r = RANGES[ key ];
	const ratio = r[ 1 ] / r[ 0 ];
	return [ r[ 0 ] * Math.pow( ratio, 0.25 ), r[ 0 ] * Math.pow( ratio, 0.75 ) ];

}

const EDGES = Object.freeze( {
	clapperWidth: quartiles( 'clapper.width' ),    // 47.5 mm / 82.5 mm of 30..100
	clapperMass: quartiles( 'clapper.mass' ),      // 28.5 g  / 69.5 g  of 8..90
	clapperDrop: quartiles( 'clapper.drop' ),      // 342 mm  / 527 mm  of 250..620
	sailMass: quartiles( 'sail.mass' ),            // 28.5 g  / 69.5 g  of 8..90
	sailHeight: quartiles( 'sail.height' ),        // 127 mm  / 242 mm  of 70..300
	attack: logQuartiles( 'voice.attack' ),        // 1.26 ms / 7.95 ms of 0.5..20
	decay: quartiles( 'voice.decay' ),             // 5.75 s  / 15.25 s of 1..20
	loudness: quartiles( 'voice.loudness' )        // 0.25    / 0.75
} );

/** '' in the stock middle, `low` below the first quartile, `high` above the third. */
function trait( value, edges, low, high ) {

	if ( value < edges[ 0 ] ) return low;
	if ( value > edges[ 1 ] ) return high;
	return '';

}

function nonEmpty( list ) {

	const out = [];
	for ( const w of list ) if ( w ) out.push( w );
	return out;

}

/** ['a'] -> 'a'; ['a','b'] -> 'a and b'; ['a','b','c'] -> 'a, b and c'. */
function andList( list ) {

	if ( list.length < 2 ) return list.join( '' );
	return list.slice( 0, - 1 ).join( ', ' ) + ' and ' + list[ list.length - 1 ];

}

// Wind, when the visitor has taken it off the place's own weather. All three
// fields are null by default - null means "the place decides" - so at rest the
// sentence says nothing about the air, which is both shorter and more honest
// than naming a number nobody chose.
//
// Speed bands are Beaufort in mph, rounded: force 1/2 at 4, 3/4 at 13, 5/6 at
// 25, 7/8 at 39. A wind chime maker and a sailor mean the same thing by "fresh".
const WIND_SPEED_EDGES = Object.freeze( [ 4, 13, 25, 39 ] );
const WIND_SPEED_WORDS = Object.freeze( [ 'faint', 'light', 'fresh', 'strong', 'hard' ] );

// Gustiness has no outside authority, so it is plain thirds of its own range.
const WIND_TURB_EDGES = Object.freeze( ( () => {

	const r = RANGES[ 'wind.turbulence' ];
	const span = r[ 1 ] - r[ 0 ];
	return [ r[ 0 ] + span / 3, r[ 0 ] + span * 2 / 3 ];

} )() );
const WIND_TURB_WORDS = Object.freeze( [ 'steady', 'shifting', 'gusty' ] );

// wind.js reads dirDeg as a FROM-bearing (wind.js:179), so 270 is a westerly.
const WIND_FROM = Object.freeze( [
	'northerly', 'north-easterly', 'easterly', 'south-easterly',
	'southerly', 'south-westerly', 'westerly', 'north-westerly'
] );

// Sun elevation in degrees, thirds of scene.js's own 2..74. The place lights
// itself until the visitor says otherwise, so null is silent here too.
const SUN_EDGES = Object.freeze( ( () => {

	const r = RANGES[ 'view.sun' ];
	const span = r[ 1 ] - r[ 0 ];
	return [ r[ 0 ] + span / 3, r[ 0 ] + span * 2 / 3 ];

} )() );
const SUN_WORDS = Object.freeze( [ 'a low sun', 'a slanting sun', 'a high sun' ] );

function bandOf( value, edges ) {

	let i = 0;
	while ( i < edges.length && value >= edges[ i ] ) i ++;
	return i;

}

function windPhrase( w ) {

	if ( w.mph === null && w.dirDeg === null && w.turbulence === null ) return '';

	const adj = [];
	if ( w.mph !== null ) adj.push( WIND_SPEED_WORDS[ bandOf( w.mph, WIND_SPEED_EDGES ) ] );
	if ( w.turbulence !== null ) adj.push( WIND_TURB_WORDS[ bandOf( w.turbulence, WIND_TURB_EDGES ) ] );

	// A compass word is already a noun for a wind - "a gusty westerly" - so when
	// a direction is set it replaces the head rather than adding to it.
	const head = ( w.dirDeg !== null ) ? WIND_FROM[ Math.round( w.dirDeg / 45 ) % 8 ] : 'wind';
	return 'a ' + adj.concat( head ).join( ' ' );

}

/**
 * "Six-tube C major pentatonic, voiced on Theta Flower of Life, on the porch."
 *
 * One sentence, and the single source of truth for the line under the object
 * (P3) and the share text (P6). Nobody writes a second one.
 *
 * WHAT IT IS FOR. A stranger who drags a slider has to be able to see, in the
 * sentence, that the thing they just touched is part of what they are making.
 * That is the whole job, and it is why every one of the sixteen fields a panel
 * exposes can move a word here. It is NOT for reading a setting back: the
 * values are bucketed hard enough that nobody can reconstruct a slider from the
 * words, and the middle half of every slider says nothing at all.
 *
 * WHAT IT MAY CLAIM. Only what is true of the object on screen and the sound
 * coming out of it.
 *
 * - VOICED ON, not ON ... STOCK. physics.js hangs a single section
 *   unconditionally (CONTRACTS H9), so swapping the stock moves every tube's cut
 *   length inside audio.js and moves not one drawn cylinder. Probed side by
 *   side, `?c=v1` and `?c=v1_st-cb78` differ by 43 percent in tube diameter in
 *   the snapshot and are byte-identical in the geometry. "On Corinthian Bells 78
 *   stock" claimed the second one looked different; "voiced on Corinthian Bells
 *   78" says what is true, that it is a choice you hear. The same test applies
 *   to every word added since: the striker and the sail are drawn, so they are
 *   described as parts; attack, ring and loudness are audio.js only, so they sit
 *   inside the "voiced" clause with the stock and never outside it.
 * - The tube count and the scale are both drawn and heard, so they lead.
 * - hang.u/v/scale, view.quality and view.splats are deliberately absent. Hang
 *   is plate framing (CONTRACTS Rule A) - it moves the backdrop, not the chime,
 *   and a sentence claiming otherwise would be the exact lie H9 is about.
 *   Quality is a renderer tier and splats is how much of the capture this
 *   machine can afford to draw; neither is a property of the wind chime a
 *   stranger just made, and a caption that said "on the forest path at 40
 *   percent" would be describing the visitor's graphics card.
 *
 * @param {object} design any partial; it is clamped first, so this is total.
 * @param {object} [opts] { placeName } to override the place phrase once P4's
 *                        PLACES table can supply a nicer one.
 */
export function describe( design, opts ) {

	const d = clampDesign( design );
	const o = obj( opts );

	const count = COUNT_WORDS[ d.tubes.notes ] || String( d.tubes.notes );
	const scale = SCALE_NAMES[ d.tubes.scale ] || d.tubes.scale;

	// The two parts you can watch swing. They hang on the same cord, the striker
	// above the sail, so "over" is literal and not a flourish.
	const strikerAdj = nonEmpty( [
		trait( d.clapper.width, EDGES.clapperWidth, 'narrow', 'broad' ),
		trait( d.clapper.mass, EDGES.clapperMass, 'light', 'heavy' )
	] );
	const hung = trait( d.clapper.drop, EDGES.clapperDrop, 'high', 'low' );
	// No comma between the pair: "a broad heavy striker" is how it is said out
	// loud, and the sentence is meant to be heard rather than parsed.
	let striker = strikerAdj.length ? 'a ' + strikerAdj.join( ' ' ) + ' striker' : '';
	if ( hung ) striker = ( striker || 'a striker' ) + ' hung ' + hung;

	const sailAdj = nonEmpty( [
		trait( d.sail.height, EDGES.sailHeight, 'small', 'big' ),
		trait( d.sail.mass, EDGES.sailMass, 'light', 'heavy' )
	] );
	const sail = sailAdj.length ? 'a ' + sailAdj.join( ' ' ) + ' sail' : '';

	let parts = '';
	if ( striker && sail ) parts = ', ' + striker + ' over ' + sail;
	else if ( striker ) parts = ', ' + striker;
	else if ( sail ) parts = ', ' + sail;

	// Everything audio.js owns, in one clause with the stock.
	const voiceAdj = nonEmpty( [
		trait( d.voice.attack, EDGES.attack, 'bright', 'soft' ),
		trait( d.voice.decay, EDGES.decay, 'short', 'long' ),
		trait( d.voice.loudness, EDGES.loudness, 'quiet', 'loud' )
	] );
	const voiced = voiceAdj.length ? 'voiced ' + andList( voiceAdj ) + ' on ' : 'voiced on ';

	const where = ( typeof o.placeName === 'string' && o.placeName ) ? o.placeName : placePhrase( d.place );
	let tail = 'on ' + where;
	const air = windPhrase( d.wind );
	if ( air ) tail += ' in ' + air;
	if ( d.view.sun !== null ) tail += ' under ' + SUN_WORDS[ bandOf( d.view.sun, SUN_EDGES ) ];

	return count + '-tube ' + scale + parts + ', ' + voiced + d.tubes.stock + ', ' + tail + '.';

}

// ---------------------------------------------------------------------------
// The URL codec.
//
// One query parameter, `c`. Underscore-separated segments, first is the
// version, every other is `xx-value` with a short key. Segments equal to the
// default are OMITTED, and the order below is canonical, so the same design
// always produces the same string and the default chime shares as `?c=v1`.
//
// Every value on the wire is an integer or a fixed alias. No floats, no locale
// decimal separators, no base64, no JSON. The whole string stays inside
// [A-Za-z0-9_-], so it needs no percent-encoding and survives a chat client
// that eats punctuation.
// ---------------------------------------------------------------------------

const FIELDS = Object.freeze( [
	{ key: 'pl', path: [ 'place' ], kind: 'id' },
	{ key: 'sc', path: [ 'tubes', 'scale' ], kind: 'alias', to: SCALE_ALIAS, from: SCALE_BY_ALIAS },
	{ key: 'n', path: [ 'tubes', 'notes' ], kind: 'num', q: 1 },
	{ key: 'st', path: [ 'tubes', 'stock' ], kind: 'alias', to: STOCK_ALIAS, from: STOCK_BY_ALIAS },
	{ key: 'cw', path: [ 'clapper', 'width' ], kind: 'num', q: 1000 },
	{ key: 'cm', path: [ 'clapper', 'mass' ], kind: 'num', q: 1000 },
	{ key: 'cd', path: [ 'clapper', 'drop' ], kind: 'num', q: 1000 },
	{ key: 'sm', path: [ 'sail', 'mass' ], kind: 'num', q: 1000 },
	{ key: 'sh', path: [ 'sail', 'height' ], kind: 'num', q: 1000 },
	{ key: 'hu', path: [ 'hang', 'u' ], kind: 'num', q: 100 },
	{ key: 'hv', path: [ 'hang', 'v' ], kind: 'num', q: 100 },
	{ key: 'hs', path: [ 'hang', 'scale' ], kind: 'num', q: 100 },
	{ key: 'su', path: [ 'view', 'sun' ], kind: 'num', q: 1 },
	{ key: 'q', path: [ 'view', 'quality' ], kind: 'alias', to: QUALITY_ALIAS, from: QUALITY_BY_ALIAS },
	{ key: 'sp', path: [ 'view', 'splats' ], kind: 'num', q: 100 },
	{ key: 'at', path: [ 'voice', 'attack' ], kind: 'num', q: 10000 },
	{ key: 'dk', path: [ 'voice', 'decay' ], kind: 'num', q: 10 },
	{ key: 'ld', path: [ 'voice', 'loudness' ], kind: 'num', q: 100 },
	{ key: 'w', path: [ 'wind', 'mph' ], kind: 'num', q: 1 },
	{ key: 'wd', path: [ 'wind', 'dirDeg' ], kind: 'num', q: 1 },
	{ key: 'wt', path: [ 'wind', 'turbulence' ], kind: 'num', q: 100 },
	{ key: 'ws', path: [ 'wind', 'source' ], kind: 'alias', to: WIND_SOURCE_ALIAS, from: WIND_SOURCE_BY_ALIAS }
] );

const FIELD_BY_KEY = ( () => {

	const m = Object.create( null );
	for ( const f of FIELDS ) m[ f.key ] = f;
	return m;

} )();

function readPath( o, path ) {

	let cur = o;
	for ( let i = 0; i < path.length; i ++ ) {

		if ( cur === null || typeof cur !== 'object' ) return undefined;
		cur = cur[ path[ i ] ];

	}

	return cur;

}

function writePath( o, path, value ) {

	let cur = o;
	for ( let i = 0; i < path.length - 1; i ++ ) {

		const k = path[ i ];
		if ( cur[ k ] === undefined || cur[ k ] === null || typeof cur[ k ] !== 'object' ) cur[ k ] = {};
		cur = cur[ k ];

	}

	cur[ path[ path.length - 1 ] ] = value;

}

// A wire integer, and nothing else. No exponents, no decimal points, no
// whitespace, and a length cap so a hostile string cannot make Number() chew.
const WIRE_INT_RE = /^-?[0-9]{1,9}$/;

/**
 * @param {object} design any partial; it is clamped first, so this is total.
 * @returns {string} e.g. 'v1', 'v1_sc-lyd_n-8'
 */
export function encode( design ) {

	const d = clampDesign( design );
	const out = [ 'v' + d.v ];

	for ( const f of FIELDS ) {

		const value = readPath( d, f.path );
		const def = readPath( DESIGN_DEFAULTS, f.path );
		// Both sides are clamped and snapped, so === is exact for numbers here.
		if ( value === def ) continue;
		if ( value === null || value === undefined ) continue;

		if ( f.kind === 'num' ) {

			out.push( f.key + '-' + String( Math.round( value * f.q ) ) );

		} else if ( f.kind === 'alias' ) {

			const a = f.to[ value ];
			if ( a !== undefined ) out.push( f.key + '-' + a );

		} else {

			out.push( f.key + '-' + value );

		}

	}

	return out.join( '_' );

}

// A hostile `c` is cheap to refuse: cap the string, cap the segments, cap the
// key length. Nothing here allocates per character.
const MAX_C_CHARS = 4096;
const MAX_SEGMENTS = 96;

/**
 * The SPARSE half of decode: only the fields the string actually carried. This
 * is what lets `?c=` be layered over the legacy parameters without the codec's
 * defaults wiping out what the legacy parameters just set.
 *
 * @param {string} text the value of the `c` query parameter
 * @param {function} [onWarn] receives a short tag; main.js passes noteError
 */
export function decodePartial( text, onWarn ) {

	const warn = ( tag ) => {

		if ( typeof onWarn === 'function' ) {

			try {

				onWarn( tag, null );

			} catch ( err ) { /* a broken logger must not break a share link */ }

		}

	};

	const out = {};

	try {

		if ( typeof text !== 'string' ) return out;
		const s = text.length > MAX_C_CHARS ? text.slice( 0, MAX_C_CHARS ) : text;
		if ( s === '' ) return out;   // an empty `c` is nothing to decode, not a failure

		const segments = s.split( '_' );
		const first = segments[ 0 ];

		if ( ! /^v[0-9]{1,4}$/.test( first ) ) {

			// Unparseable in its entirety. Drop it and boot the defaults; never
			// blank the page over a URL.
			warn( 'design-decode-failed' );
			return out;

		}

		const version = parseInt( first.slice( 1 ), 10 );
		if ( version > CODEC_VERSION ) warn( 'design-version-ahead' );

		const n = Math.min( segments.length, MAX_SEGMENTS );
		for ( let i = 1; i < n; i ++ ) {

			const seg = segments[ i ];
			const dash = seg.indexOf( '-' );
			// The key is everything before the FIRST dash, so a value that
			// contains one - `st-tf-s`, `pl-forest-path` - survives intact.
			if ( dash < 1 || dash > 3 ) continue;

			const f = FIELD_BY_KEY[ seg.slice( 0, dash ) ];
			if ( f === undefined ) continue;   // unknown key: ignored, not an error

			const raw = seg.slice( dash + 1 );
			if ( raw === '' ) continue;

			if ( f.kind === 'num' ) {

				if ( ! WIRE_INT_RE.test( raw ) ) continue;
				writePath( out, f.path, Number( raw ) / f.q );

			} else if ( f.kind === 'alias' ) {

				const full = f.from[ raw ];
				if ( full !== undefined ) writePath( out, f.path, full );

			} else {

				writePath( out, f.path, raw );

			}

		}

	} catch ( err ) {

		// decodePartial is specified never to throw. This is belt and braces.
		warn( 'design-decode-failed' );

	}

	return out;

}

/**
 * The complete, clamped design a `c` string describes. Total: every input
 * returns a full object and nothing throws.
 */
export function decode( text, onWarn ) {

	return clampDesign( decodePartial( text, onWarn ) );

}

// ---------------------------------------------------------------------------
// Legacy links.
//
// ?wind= ?dir= ?style= ?quality= are still read and still work. They are
// applied BEFORE ?c=, so `c` wins on conflict.
//
// ?q= is a location string and is NOT part of the design: it pre-fills the
// weather box and never travels in `c`. main.js keeps reading it directly.
// ---------------------------------------------------------------------------

function toParams( input ) {

	try {

		if ( input instanceof URLSearchParams ) return input;
		if ( typeof input === 'string' ) return new URLSearchParams( input );
		if ( input !== null && typeof input === 'object' ) return new URLSearchParams( input );

	} catch ( err ) { /* fall through to empty */ }

	return new URLSearchParams();

}

/**
 * @returns {object} a SPARSE partial design - only what the legacy parameters
 *                   actually carried.
 */
export function fromLegacyParams( input ) {

	const q = toParams( input );
	const out = {};

	if ( q.has( 'wind' ) ) {

		const x = toNumber( q.get( 'wind' ) );
		if ( Number.isFinite( x ) ) writePath( out, [ 'wind', 'mph' ], x );

	}

	if ( q.has( 'dir' ) ) {

		const x = toNumber( q.get( 'dir' ) );
		if ( Number.isFinite( x ) ) writePath( out, [ 'wind', 'dirDeg' ], x );

	}

	if ( q.has( 'quality' ) ) {

		const v = String( q.get( 'quality' ) );
		if ( QUALITY_SET.has( v ) ) writePath( out, [ 'view', 'quality' ], v );

	}

	// Both shipped styles were the porch: one lit and one flat. The look itself
	// is params.style, which main.js still reads for scene.js; what the design
	// carries is WHERE the chime hangs, and for either legacy value that is the
	// porch rather than the new default place.
	if ( q.has( 'style' ) ) {

		const st = String( q.get( 'style' ) );
		if ( st === 'golden' || st === 'storybook' ) out.place = 'porch';

	}

	return out;

}

/**
 * The one call main.js's WCS:DESIGN-BOOT makes: legacy parameters first, `?c=`
 * over the top, clamped once at the end.
 *
 * @param {string} search location.search, with or without the leading '?'
 * @param {function} [onWarn] short-tag logger; main.js passes noteError
 */
export function designFromLocation( search, onWarn ) {

	const q = toParams( typeof search === 'string' ? search : '' );
	let d = mergeDesign( DESIGN_DEFAULTS, fromLegacyParams( q ) );
	if ( q.has( 'c' ) ) d = mergeDesign( d, decodePartial( q.get( 'c' ), onWarn ) );
	return clampDesign( d );

}

/**
 * The share link for a design, as a query string. P6 owns the button and the
 * address bar; this is the string it writes.
 */
export function toSearch( design ) {

	return '?c=' + encode( design );

}
