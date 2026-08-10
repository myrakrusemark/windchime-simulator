#!/usr/bin/env node
/**
 * verify-design.mjs - the design object and its URL codec, checked without a
 * browser.
 *
 *   node tools/verify-design.mjs [--n 500] [--seed 1]
 *
 * No dependencies, no browser, no network. design.js imports only modal.js and
 * modal.js imports nothing, so both load straight into node.
 *
 * What it proves, in order:
 *   1. clampDesign is total: 40 hostile inputs, none throws, all complete.
 *   2. decode is total: the five inputs P1's pass criterion 2 names, plus a
 *      4 KB junk string, none throws, all complete and idempotent.
 *   3. decode(encode(d)) round-trips 500 random valid designs with zero
 *      mismatches - the headline number.
 *   4. The codec is canonical: same design, same string, every time; defaults
 *      omitted; the documented example strings decode to what they say.
 *   5. Legacy links still map, and ?c= still wins over them.
 *   6. describe() is total and says something.
 *   7. The share link stays short and stays inside [A-Za-z0-9_-].
 *   8. NO DRIFT: every range and every name restated in design.js still agrees
 *      with physics.js and modal.js, the files that actually own them.
 *
 * Exit 0 = everything above passed. Exit 1 = read the failures.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..' );

const D = await import( pathToFileURL( join( ROOT, 'assets/js/design.js' ) ).href );

// ---------------------------------------------------------------------------
// Test plumbing
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];

function ok( name, condition, detail ) {

	if ( condition ) {

		passed ++;
		return true;

	}

	failures.push( name + ( detail ? '  ->  ' + detail : '' ) );
	return false;

}

function section( title ) {

	process.stdout.write( '\n' + title + '\n' );

}

function line( text ) {

	process.stdout.write( '  ' + text + '\n' );

}

/** Structural deep equality over plain JSON values. Distinguishes null from 0. */
function deepEqual( a, b ) {

	if ( a === b ) return true;
	if ( typeof a !== typeof b ) return false;
	if ( a === null || b === null ) return false;
	if ( typeof a !== 'object' ) return false;
	const ka = Object.keys( a ).sort();
	const kb = Object.keys( b ).sort();
	if ( ka.length !== kb.length ) return false;
	for ( let i = 0; i < ka.length; i ++ ) if ( ka[ i ] !== kb[ i ] ) return false;
	for ( const k of ka ) if ( ! deepEqual( a[ k ], b[ k ] ) ) return false;
	return true;

}

function diff( a, b, path = '' ) {

	if ( deepEqual( a, b ) ) return [];
	if ( a === null || b === null || typeof a !== 'object' || typeof b !== 'object' ) {

		return [ ( path || '<root>' ) + ': ' + JSON.stringify( a ) + ' != ' + JSON.stringify( b ) ];

	}

	const out = [];
	for ( const k of new Set( [ ...Object.keys( a ), ...Object.keys( b ) ] ) ) {

		out.push( ...diff( a[ k ], b[ k ], path ? path + '.' + k : k ) );

	}

	return out;

}

// A small deterministic PRNG, so a failure is reproducible from its seed.
function mulberry32( seed ) {

	let t = seed >>> 0;
	return function () {

		t += 0x6D2B79F5;
		let x = t;
		x = Math.imul( x ^ ( x >>> 15 ), 1 | x );
		x ^= x + Math.imul( x ^ ( x >>> 7 ), 61 | x );
		return ( ( x ^ ( x >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

function arg( name, fallback ) {

	const i = process.argv.indexOf( '--' + name );
	return i !== - 1 && process.argv[ i + 1 ] ? process.argv[ i + 1 ] : fallback;

}

const N = Number( arg( 'n', 500 ) );
const SEED = Number( arg( 'seed', 1 ) );

// ---------------------------------------------------------------------------
// 1. clampDesign is total
// ---------------------------------------------------------------------------

section( '1. clampDesign is total' );

const HOSTILE_VALUES = [
	undefined, null, 0, 1, - 1, NaN, Infinity, - Infinity, '', 'garbage', true, false,
	[], [ 1, 2, 3 ], {}, ( () => {} ), Symbol ? undefined : undefined,
	{ tubes: null }, { tubes: 'x' }, { tubes: [] }, { tubes: { notes: 'x' } },
	{ tubes: { notes: 1e9 } }, { tubes: { notes: - 1e9 } }, { tubes: { notes: NaN } },
	{ tubes: { scale: 'nope' } }, { tubes: { stock: 42 } },
	{ clapper: { width: '0.09' } }, { clapper: { width: null } },
	{ hang: { u: - 5, v: 99, scale: 0 } },
	{ view: { sun: 'high' } }, { view: { sun: - 400 } }, { view: { quality: 'ultra' } },
	{ voice: { attack: 0, decay: 1e300, loudness: - 3 } },
	{ wind: { mph: 'gusty', dirDeg: - 725, turbulence: 88, source: 'satellite' } },
	{ wind: { dirDeg: 359.7 } },
	{ place: 'FOREST PATH' }, { place: '../../etc/passwd' }, { place: 'a'.repeat( 500 ) },
	{ v: 99, junk: 1, tubes: { notes: 7, junk: 1 } },
	Object.assign( Object.create( { notes: 9 } ), {} ),
	new Date( 0 ),
	( () => { const o = { tubes: {} }; o.self = o; o.tubes.up = o; return o; } )()
];

const DEFAULT_CLAMPED = D.clampDesign( D.DESIGN_DEFAULTS );
const SHAPE_KEYS = Object.keys( D.DESIGN_DEFAULTS ).sort();

function isComplete( d ) {

	if ( d === null || typeof d !== 'object' ) return false;
	if ( Object.keys( d ).sort().join( ',' ) !== SHAPE_KEYS.join( ',' ) ) return false;
	for ( const k of SHAPE_KEYS ) {

		const def = D.DESIGN_DEFAULTS[ k ];
		if ( def !== null && typeof def === 'object' ) {

			if ( d[ k ] === null || typeof d[ k ] !== 'object' ) return false;
			const want = Object.keys( def ).sort().join( ',' );
			if ( Object.keys( d[ k ] ).sort().join( ',' ) !== want ) return false;
			for ( const f of Object.keys( def ) ) {

				const v = d[ k ][ f ];
				if ( v === undefined ) return false;
				if ( typeof v === 'number' && ! Number.isFinite( v ) ) return false;

			}

		}

	}

	return true;

}

let totalOk = true;
for ( let i = 0; i < HOSTILE_VALUES.length; i ++ ) {

	let out;
	try {

		out = D.clampDesign( HOSTILE_VALUES[ i ] );

	} catch ( err ) {

		totalOk = ok( 'clampDesign threw on hostile input #' + i, false, err.message ) && totalOk;
		continue;

	}

	if ( ! ok( 'clampDesign incomplete on hostile input #' + i, isComplete( out ), JSON.stringify( out ) ) ) totalOk = false;
	if ( ! ok( 'clampDesign not idempotent on hostile input #' + i, deepEqual( out, D.clampDesign( out ) ) ) ) totalOk = false;

}

line( HOSTILE_VALUES.length + ' hostile inputs, none threw, all complete and idempotent: ' + ( totalOk ? 'PASS' : 'FAIL' ) );
line( 'clampDesign(DESIGN_DEFAULTS) deep-equals DESIGN_DEFAULTS: ' +
	( ok( 'defaults are not their own clamp', deepEqual( DEFAULT_CLAMPED, D.DESIGN_DEFAULTS ),
		diff( DEFAULT_CLAMPED, D.DESIGN_DEFAULTS ).join( '; ' ) ) ? 'PASS' : 'FAIL' ) );

// ---------------------------------------------------------------------------
// 2. decode is total - P1 pass criterion 2
// ---------------------------------------------------------------------------

section( '2. decode is total (pass criterion 2)' );

const JUNK_4K = ( () => {

	const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789_-%. <>&"\'\\/{}[]';
	const r = mulberry32( 99 );
	let s = '';
	while ( s.length < 4096 ) s += alphabet[ Math.floor( r() * alphabet.length ) ];
	return s;

} )();

const HOSTILE_C = [
	[ "''", '' ],
	[ "'v1'", 'v1' ],
	[ "'v9_zz-1'", 'v9_zz-1' ],
	[ "'garbage'", 'garbage' ],
	[ '4 KB junk string', JUNK_4K ],
	// Beyond the five the contract names, because these are what a chat client
	// and a copy-paste actually produce.
	[ 'null', null ],
	[ 'undefined', undefined ],
	[ 'number', 12345 ],
	[ 'object', { evil: true } ],
	[ "'v1_'", 'v1_' ],
	[ "'v1_n-'", 'v1_n-' ],
	[ "'v1_-8'", 'v1_-8' ],
	[ "'v1_n-99999999999999999999'", 'v1_n-99999999999999999999' ],
	[ "'v1_n-1e9'", 'v1_n-1e9' ],
	[ "'v1_n-NaN'", 'v1_n-NaN' ],
	[ '2000 empty segments', 'v1' + '_'.repeat( 2000 ) ]
];

for ( const [ label, input ] of HOSTILE_C ) {

	const tags = [];
	let out;
	let threw = null;
	try {

		out = D.decode( input, ( t ) => tags.push( t ) );

	} catch ( err ) {

		threw = err;

	}

	const good = ok( 'decode threw on ' + label, threw === null, threw && threw.message ) &&
		ok( 'decode incomplete on ' + label, isComplete( out ) ) &&
		ok( 'decode not idempotent on ' + label, deepEqual( out, D.clampDesign( out ) ) );

	line( label.padEnd( 30 ) + ( good ? 'complete' : 'FAIL' ) +
		( tags.length ? '  warn: ' + tags.join( ',' ) : '' ) );

}

ok( "'garbage' does not report design-decode-failed", ( () => {

	const t = [];
	D.decode( 'garbage', ( x ) => t.push( x ) );
	return t.includes( 'design-decode-failed' );

} )() );

ok( "'v9_zz-1' does not report design-version-ahead", ( () => {

	const t = [];
	D.decode( 'v9_zz-1', ( x ) => t.push( x ) );
	return t.includes( 'design-version-ahead' );

} )() );

ok( "'v9_zz-1' should not also report a decode failure", ( () => {

	const t = [];
	D.decode( 'v9_zz-1', ( x ) => t.push( x ) );
	return ! t.includes( 'design-decode-failed' );

} )() );

ok( "'v1' must produce exactly the defaults", deepEqual( D.decode( 'v1' ), D.DESIGN_DEFAULTS ) );
ok( "'' must produce exactly the defaults", deepEqual( D.decode( '' ), D.DESIGN_DEFAULTS ) );

line( 'design-decode-failed on garbage, design-version-ahead on v9, defaults on v1 and empty: checked' );

// ---------------------------------------------------------------------------
// 3. The round trip - the headline number
// ---------------------------------------------------------------------------

section( '3. decode(encode(d)) over ' + N + ' random valid designs' );

const rand = mulberry32( SEED );

function pickFrom( list ) {

	return list[ Math.floor( rand() * list.length ) ];

}

function between( lo, hi ) {

	return lo + rand() * ( hi - lo );

}

function maybeNull( value ) {

	return rand() < 0.25 ? null : value;

}

/**
 * A random RAW design - deliberately not pre-quantised. clampDesign is what
 * snaps it onto the wire grid, so this exercises the snap as well as the codec,
 * and a design that survived clampDesign is by definition one the URL must be
 * able to carry.
 */
function randomDesign() {

	const R = D.RANGES;
	return D.clampDesign( {
		// Real place ids, plus one unknown-but-well-formed one: a link from a
		// newer build must survive an older build's codec untouched.
		place: pickFrom( [ 'forest-path', 'porch', 'forest-path', 'sea-cliff' ] ),
		tubes: {
			scale: pickFrom( D.SCALE_KEYS ),
			notes: between( R[ 'tubes.notes' ][ 0 ], R[ 'tubes.notes' ][ 1 ] ),
			stock: pickFrom( D.STOCK_NAMES )
		},
		clapper: {
			width: between( R[ 'clapper.width' ][ 0 ], R[ 'clapper.width' ][ 1 ] ),
			mass: between( R[ 'clapper.mass' ][ 0 ], R[ 'clapper.mass' ][ 1 ] ),
			drop: between( R[ 'clapper.drop' ][ 0 ], R[ 'clapper.drop' ][ 1 ] )
		},
		sail: {
			mass: between( R[ 'sail.mass' ][ 0 ], R[ 'sail.mass' ][ 1 ] ),
			height: between( R[ 'sail.height' ][ 0 ], R[ 'sail.height' ][ 1 ] )
		},
		hang: {
			u: between( 0, 1 ),
			v: between( 0, 1 ),
			scale: between( R[ 'hang.scale' ][ 0 ], R[ 'hang.scale' ][ 1 ] )
		},
		view: {
			sun: maybeNull( between( R[ 'view.sun' ][ 0 ], R[ 'view.sun' ][ 1 ] ) ),
			quality: pickFrom( [ 'auto', 'high', 'low' ] )
		},
		voice: {
			attack: between( R[ 'voice.attack' ][ 0 ], R[ 'voice.attack' ][ 1 ] ),
			decay: between( R[ 'voice.decay' ][ 0 ], R[ 'voice.decay' ][ 1 ] ),
			loudness: between( 0, 1 )
		},
		wind: {
			mph: maybeNull( between( 0, 60 ) ),
			dirDeg: maybeNull( between( 0, 360 ) ),
			turbulence: maybeNull( between( R[ 'wind.turbulence' ][ 0 ], R[ 'wind.turbulence' ][ 1 ] ) ),
			source: pickFrom( [ 'place', 'weather' ] )
		}
	} );

}

let mismatches = 0;
let longest = { chars: 0, text: '' };
let maxHangError = 0;
const charset = /^[A-Za-z0-9_-]+$/;

for ( let i = 0; i < N; i ++ ) {

	const d = randomDesign();
	const text = D.encode( d );
	const back = D.decode( text );

	if ( ! deepEqual( d, back ) ) {

		mismatches ++;
		if ( mismatches <= 3 ) failures.push( 'round trip #' + i + ' (' + text + '): ' + diff( d, back ).join( '; ' ) );

	}

	if ( ! charset.test( text ) ) failures.push( 'round trip #' + i + ': string leaves [A-Za-z0-9_-]: ' + text );

	// Re-encoding what came back must give the identical string, or the codec is
	// not canonical and two people sharing the same chime share two URLs.
	if ( D.encode( back ) !== text ) failures.push( 'round trip #' + i + ': not canonical, ' + text + ' -> ' + D.encode( back ) );

	// P5 pass criterion 4: hang survives to within 0.005 in u and v.
	maxHangError = Math.max( maxHangError, Math.abs( d.hang.u - back.hang.u ), Math.abs( d.hang.v - back.hang.v ) );

	// Full round trip through the query string a share link actually carries.
	const viaUrl = D.designFromLocation( '?' + 'c=' + text );
	if ( ! deepEqual( d, viaUrl ) ) failures.push( 'round trip #' + i + ': designFromLocation disagrees: ' + diff( d, viaUrl ).join( '; ' ) );

	if ( text.length > longest.chars ) longest = { chars: text.length, text };

}

ok( 'round trip mismatches', mismatches === 0, mismatches + ' of ' + N );
passed += N;

line( 'designs tested          ' + N + '  (seed ' + SEED + ')' );
line( 'mismatches              ' + mismatches );
line( 'max hang error (u, v)   ' + maxHangError.toFixed( 6 ) + '   (P5 allows 0.005)' );
line( 'longest string          ' + longest.chars + ' chars   (P6 allows 120)' );
line( '                        ' + longest.text );

ok( 'hang round trip worse than 0.005', maxHangError <= 0.005, String( maxHangError ) );

// P6 pass criterion 5: the copied text has to stay legible. "A fully customised
// chime" is one where every slot on the pill row - Place, Tubes, Striker, Sail,
// Hang - has been moved off its default, which is the twelve fields below. The
// absolute worst case, with the sun, the quality, the voice and a hand-set wind
// all off default too, is measured as well and reported honestly: it does not
// fit in 120 and is not reachable from the pill row.
const MAX_SLOTS = D.clampDesign( {
	place: 'forest-path',
	tubes: { scale: 'cMinorPentatonic', notes: 8, stock: 'Corinthian Bells 65' },
	clapper: { width: 0.100, mass: 0.090, drop: 0.620 },
	sail: { mass: 0.090, height: 0.300 },
	hang: { u: 1, v: 1, scale: 1.8 }
} );

const MAX_EVERYTHING = D.clampDesign( D.mergeDesign( MAX_SLOTS, {
	view: { sun: 74, quality: 'low' },
	voice: { attack: 0.020, decay: 20, loudness: 1 },
	wind: { mph: 60, dirDeg: 359, turbulence: 1, source: 'weather' }
} ) );

const slotsText = D.encode( MAX_SLOTS );
const everythingText = D.encode( MAX_EVERYTHING );

line( '' );
line( 'every pill slot off default   ' + String( slotsText.length ).padStart( 3 ) + ' chars   ' + slotsText );
line( 'every field off default       ' + String( everythingText.length ).padStart( 3 ) + ' chars   ' + everythingText );

ok( 'a fully customised chime exceeds 120 characters', slotsText.length < 120, String( slotsText.length ) );

// ---------------------------------------------------------------------------
// 4. The codec is canonical, and says what the contract says it says
// ---------------------------------------------------------------------------

section( '4. Canonical form' );

ok( 'the default design must encode to exactly v1', D.encode( D.DESIGN_DEFAULTS ) === 'v1', D.encode( D.DESIGN_DEFAULTS ) );
line( 'encode(DESIGN_DEFAULTS)  = ' + JSON.stringify( D.encode( D.DESIGN_DEFAULTS ) ) );

const VECTORS = [
	[ 'v1_sc-lyd_n-8', { tubes: { scale: 'cLydian', notes: 8 } } ],
	[ 'v1_pl-porch', { place: 'porch' } ],
	[ 'v1_st-cb65', { tubes: { stock: 'Corinthian Bells 65' } } ],
	[ 'v1_st-tf-s', { tubes: { stock: 'Theta Twin Flame small' } } ],
	// forest-path is the DEFAULT place now that P4 has landed the plate, so pl is
	// correctly ABSENT from the second of these and present on the first. These
	// two swapped over in that commit, which is exactly the drift this file
	// exists to make loud rather than silent.
	[ 'v1_pl-porch_hu-38_hv-55_hs-130', { place: 'porch', hang: { u: 0.38, v: 0.55, scale: 1.30 } } ],
	[ 'v1_hu-38_hv-55_hs-130', { place: 'forest-path', hang: { u: 0.38, v: 0.55, scale: 1.30 } } ],
	[ 'v1_su-34', { view: { sun: 34 } } ],
	[ 'v1_q-l', { view: { quality: 'low' } } ],
	[ 'v1_at-70', { voice: { attack: 0.0070 } } ],
	[ 'v1_dk-120', { voice: { decay: 12.0 } } ],
	[ 'v1_ld-65', { voice: { loudness: 0.65 } } ],
	[ 'v1_cw-82_cm-40_cd-455', { clapper: { width: 0.082, mass: 0.040, drop: 0.455 } } ],
	[ 'v1_sm-28_sh-210', { sail: { mass: 0.028, height: 0.210 } } ],
	[ 'v1_w-24_wd-90_wt-45_ws-w', { wind: { mph: 24, dirDeg: 90, turbulence: 0.45, source: 'weather' } } ]
];

for ( const [ text, patch ] of VECTORS ) {

	const expected = D.clampDesign( D.mergeDesign( D.DESIGN_DEFAULTS, patch ) );
	const got = D.decode( text );
	const decodedOk = ok( 'decode(' + text + ') is wrong', deepEqual( got, expected ), diff( got, expected ).join( '; ' ) );
	const encodedOk = ok( 'encode of that design is not ' + text, D.encode( expected ) === text, D.encode( expected ) );
	line( text.padEnd( 40 ) + ( decodedOk && encodedOk ? 'both directions agree' : 'FAIL' ) );

}

// at-20 is the contract's own worked example: 0.002 s is 2 ms is 20 tenths of a
// millisecond. If the quantum were wrong this is the assertion that catches it.
ok( 'attack quantum is not tenths of a millisecond', D.decode( 'v1_at-20' ).voice.attack === 0.002 );
ok( 'decay quantum is not tenths of a second', D.decode( 'v1_dk-120' ).voice.decay === 12 );
ok( 'clapper width quantum is not millimetres', D.decode( 'v1_cw-82' ).clapper.width === 0.082 );

// Field order is canonical whatever order the object was built in.
ok( 'field order is not canonical', D.encode( { wind: { mph: 24 }, tubes: { notes: 8 }, place: 'porch' } ) === 'v1_pl-porch_n-8_w-24',
	D.encode( { wind: { mph: 24 }, tubes: { notes: 8 }, place: 'porch' } ) );

// An unknown but well-formed place id survives, so a link from a newer build is
// not mangled by an older one.
ok( 'a well-formed unknown place id must survive the round trip', D.decode( 'v1_pl-sea-cliff' ).place === 'sea-cliff' );

// ---------------------------------------------------------------------------
// 5. Legacy links
// ---------------------------------------------------------------------------

section( '5. Legacy links still work, and ?c= still wins' );

const legacy = D.designFromLocation( '?wind=30&dir=90&quality=low&style=golden&q=Boulder' );
ok( 'legacy ?wind= lost', legacy.wind.mph === 30, String( legacy.wind.mph ) );
ok( 'legacy ?dir= lost', legacy.wind.dirDeg === 90, String( legacy.wind.dirDeg ) );
ok( 'legacy ?quality= lost', legacy.view.quality === 'low', legacy.view.quality );
ok( 'legacy ?style=golden must map to the porch', legacy.place === 'porch', legacy.place );
ok( '?q= must not become part of the design', D.encode( legacy ).indexOf( 'Boulder' ) === - 1 );
line( '?wind=30&dir=90&quality=low&style=golden  ->  ' + D.encode( legacy ) );

ok( 'legacy ?style=storybook must map to the porch too', D.designFromLocation( '?style=storybook' ).place === 'porch' );

const both = D.designFromLocation( '?wind=30&dir=90&c=v1_w-7' );
ok( '?c= must win over ?wind=', both.wind.mph === 7, String( both.wind.mph ) );
ok( '?c= must not clear a legacy field it does not carry', both.wind.dirDeg === 90, String( both.wind.dirDeg ) );
line( '?wind=30&dir=90&c=v1_w-7                  ->  ' + D.encode( both ) + '   (c wins on mph, dir survives)' );

ok( 'a broken ?c= must not take the legacy values down with it', ( () => {

	const d = D.designFromLocation( '?wind=30&c=garbage' );
	return d.wind.mph === 30;

} )() );

ok( 'designFromLocation must be total on junk', ( () => {

	for ( const s of [ '', '?', '?&&&', '?c', '?c=', '?%%%', null, undefined, 12, {} ] ) {

		if ( ! isComplete( D.designFromLocation( s ) ) ) return false;

	}

	return true;

} )() );

// ---------------------------------------------------------------------------
// 6. describe()
// ---------------------------------------------------------------------------

section( '6. describe()' );

let describeOk = true;
for ( let i = 0; i < 200; i ++ ) {

	const d = randomDesign();
	let s;
	try {

		s = D.describe( d );

	} catch ( err ) {

		describeOk = ok( 'describe threw', false, err.message );
		break;

	}

	// A caption is assembled from optional clauses, so the failure mode that
	// matters is a seam: a doubled space, a stranded comma, a missing full stop.
	if ( typeof s !== 'string' || s.length < 20 || s.indexOf( 'undefined' ) !== - 1 || s.indexOf( 'NaN' ) !== - 1 ||
		/\s\s|\s,|,,|, ,|^\s|\s\.$/.test( s ) || ! /[a-z0-9]\.$/i.test( s ) ) {

		describeOk = ok( 'describe produced ' + JSON.stringify( s ), false );
		break;

	}

}

for ( const v of HOSTILE_VALUES ) {

	try {

		if ( typeof D.describe( v ) !== 'string' ) describeOk = ok( 'describe did not return a string on a hostile input', false );

	} catch ( err ) {

		describeOk = ok( 'describe threw on a hostile input', false, err.message );

	}

}

ok( 'describe is not total', describeOk );
line( 'defaults      ' + D.describe( D.DESIGN_DEFAULTS ) );
line( 'v1_sc-lyd_n-8 ' + D.describe( D.decode( 'v1_sc-lyd_n-8' ) ) );
line( 'v1_pl-porch         ' + D.describe( D.decode( 'v1_pl-porch_st-cb78_n-3' ) ) );

// ---------------------------------------------------------------------------
// 6b. Every control moves the caption (CONTRACTS section 6, P3 criterion 3)
//
// One field at a time, swept across its whole legal range from the shipped
// defaults, and the question asked of each sample is only "is this a different
// sentence from the default one". That is the criterion, and it is deliberately
// NOT "is it a different sentence from its neighbour" - the values are bucketed
// on purpose so that 68 mm and 69 mm read the same. The two columns that matter
// are therefore the ends of the travel, and the distinct-caption count says how
// much resolution the field has in between.
//
// hang.*, view.quality and view.splats are listed too, asserted SILENT rather
// than skipped, so that this table is a complete statement about all twenty-two
// codec fields and not a selective one. Hang moves the plate and not the chime
// (Rule A); quality is a renderer tier and splats is how much of the capture
// this machine draws. A caption naming any of them would be describing
// something other than the wind chime.
// ---------------------------------------------------------------------------

section( '6b. Every control moves the caption' );

const CAPTION_BASE = D.describe( D.DESIGN_DEFAULTS );

function setAt( design, path, value ) {

	const out = structuredClone( design );
	const keys = path.split( '.' );
	let cur = out;
	for ( let i = 0; i < keys.length - 1; i ++ ) cur = cur[ keys[ i ] ];
	cur[ keys[ keys.length - 1 ] ] = value;
	return out;

}

/** Words in `s` that are not in `base`, so the table shows what the field said. */
function added( base, s ) {

	const have = new Set( base.toLowerCase().replace( /[.,]/g, '' ).split( /\s+/ ) );
	const out = [];
	for ( const w of s.toLowerCase().replace( /[.,]/g, '' ).split( /\s+/ ) ) {

		if ( ! have.has( w ) && out.indexOf( w ) === - 1 ) out.push( w );

	}

	return out.length ? out.join( ' ' ) : '-';

}

function sweep( key, steps ) {

	const r = D.RANGES[ key ];
	const out = [];
	for ( let i = 0; i <= steps; i ++ ) out.push( r[ 0 ] + ( r[ 1 ] - r[ 0 ] ) * ( i / steps ) );
	return out;

}

// value lists span the FULL legal range of each field, null included where null
// is legal, because null is the shipped value there and has to be one of the
// samples the sweep is measured against.
const COVERAGE = [
	[ 'place', [ 'porch', 'forest-path' ] ],
	[ 'tubes.scale', D.SCALE_KEYS.slice() ],
	[ 'tubes.notes', [ 3, 4, 5, 6, 7, 8 ] ],
	[ 'tubes.stock', [ ...D.STOCK_NAMES ] ],
	[ 'clapper.width', sweep( 'clapper.width', 70 ) ],
	[ 'clapper.mass', sweep( 'clapper.mass', 82 ) ],
	[ 'clapper.drop', sweep( 'clapper.drop', 74 ) ],
	[ 'sail.mass', sweep( 'sail.mass', 82 ) ],
	[ 'sail.height', sweep( 'sail.height', 46 ) ],
	[ 'voice.attack', sweep( 'voice.attack', 39 ) ],
	[ 'voice.decay', sweep( 'voice.decay', 190 ) ],
	[ 'voice.loudness', sweep( 'voice.loudness', 100 ) ],
	[ 'wind.mph', [ null, ...sweep( 'wind.mph', 60 ) ] ],
	[ 'wind.dirDeg', [ null, ...Array.from( { length: 360 }, ( _, i ) => i ) ] ],
	[ 'wind.turbulence', [ null, ...sweep( 'wind.turbulence', 95 ) ] ],
	[ 'view.sun', [ null, ...sweep( 'view.sun', 72 ) ] ]
];

const SILENT = [
	[ 'hang.u', sweep( 'hang.u', 100 ) ],
	[ 'hang.v', sweep( 'hang.v', 100 ) ],
	[ 'hang.scale', sweep( 'hang.scale', 120 ) ],
	[ 'view.quality', [ 'auto', 'high', 'low' ] ],
	[ 'view.splats', sweep( 'view.splats', 95 ) ]
];

function pad( s, n ) {

	s = String( s );
	return s.length >= n ? s : s + ' '.repeat( n - s.length );

}

line( pad( 'field', 17 ) + pad( 'low end', 24 ) + pad( 'high end', 24 ) + pad( 'distinct', 9 ) + 'moves' );
line( '-'.repeat( 79 ) );

function defaultOf( path ) {

	const keys = path.split( '.' );
	let cur = D.DESIGN_DEFAULTS;
	for ( const k of keys ) cur = cur[ k ];
	return cur;

}

for ( const [ path, values ] of COVERAGE ) {

	const captions = values.map( ( v ) => D.describe( setAt( D.DESIGN_DEFAULTS, path, v ) ) );
	const distinct = new Set( captions ).size;

	// The two ends of the field's own travel, EXCLUDING the shipped value where
	// that value is itself an end. place, tubes.scale and the four nullable
	// fields all default to the first entry of their own list, so testing index 0
	// against the default caption would be asking whether a field moves when it
	// has not been moved.
	const def = defaultOf( path );
	const lo = values.findIndex( ( v ) => v !== def );
	let hi = values.length - 1;
	while ( hi > 0 && values[ hi ] === def ) hi --;

	const bothEnds = lo >= 0 && captions[ lo ] !== CAPTION_BASE && captions[ hi ] !== CAPTION_BASE;

	line( pad( path, 17 ) +
		pad( added( CAPTION_BASE, captions[ lo < 0 ? 0 : lo ] ), 24 ) +
		pad( added( CAPTION_BASE, captions[ hi ] ), 24 ) +
		pad( distinct, 9 ) + ( bothEnds ? 'yes' : 'NO' ) );

	ok( path + ' does not move the caption at both ends of its range', bothEnds );
	ok( path + ' produces only one caption across its whole range', distinct > 1 );

}

line( '' );
for ( const [ path, values ] of SILENT ) {

	const distinct = new Set( values.map( ( v ) => D.describe( setAt( D.DESIGN_DEFAULTS, path, v ) ) ) ).size;
	line( pad( path, 17 ) + pad( '-', 24 ) + pad( '-', 24 ) + pad( distinct, 9 ) + 'silent by design' );
	ok( path + ' leaked into the caption; it is not a property of the chime', distinct === 1 );

}

line( '' );

// LENGTH, measured rather than guessed. At 390x844 the caption box is 282 px
// wide at 16 px/21.6 px, which is 40 characters a line and 40 px of headroom
// per extra line before the pill row would have to move (it never moves: the
// caption grows upwards into the scene, slots.css:71-75).
//
//    74 chars ->  2 lines, top 738   the shipped default
//   115 chars ->  3 lines, top 718
//   204 chars ->  5 lines, top 679, still ~100 px clear of the object
//
// Three gates, because "short" means different things for the three cases:
//
//   1. The default sentence is byte-identical to the one P3 shipped. Every word
//      added below is a word a visitor asked for by moving something.
//   2. A realistically customised chime - one control moved in each of the five
//      pills - stays inside three lines.
//   3. The pathological case, every one of the sixteen fields driven to a stop,
//      stays inside five. It cannot be made to fit three: the fixed part of the
//      sentence plus an overridden wind plus an overridden sun is already 117
//      characters before a single part has been described. Capping the parts to
//      fit would mean a control that changes nothing once a neighbouring control
//      is already off stock, which is the defect this whole section exists to
//      catch. Long is the honest price of eleven off-stock choices; silent is not.
const EVERY_LIGHT = D.clampDesign( {
	place: 'porch',
	tubes: { scale: 'cMajorPentatonic', notes: 3, stock: 'Theta Twin Flame small' },
	clapper: { width: 0.030, mass: 0.008, drop: 0.250 },
	sail: { mass: 0.008, height: 0.070 },
	voice: { attack: 0.0005, decay: 1.0, loudness: 0 },
	wind: { mph: 0, dirDeg: 0, turbulence: 0.05 },
	view: { sun: 2 }
} );

const EVERY_HEAVY = D.clampDesign( {
	place: 'forest-path',
	tubes: { scale: 'cWholeTone', notes: 8, stock: 'Corinthian Bells 78' },
	clapper: { width: 0.100, mass: 0.090, drop: 0.620 },
	sail: { mass: 0.090, height: 0.300 },
	voice: { attack: 0.020, decay: 20, loudness: 1 },
	wind: { mph: 60, dirDeg: 270, turbulence: 1.0 },
	view: { sun: 74 }
} );

ok( 'the default caption is no longer the sentence P3 shipped',
	CAPTION_BASE === 'Six-tube C major pentatonic, voiced on Theta Flower of Life, on the forest path.',
	CAPTION_BASE );

// One control moved in each of the five pills, which is about as far as a
// visitor gets before they reach for Share.
const CUSTOMISED = D.clampDesign( D.mergeDesign( D.DESIGN_DEFAULTS, {
	place: 'forest-path',
	tubes: { notes: 8 },
	clapper: { mass: 0.090 },
	sail: { height: 0.300 }
} ) );

// The budgets are characters, not a modelled line count, because the wrap was
// measured in the shipped page rather than estimated: at 390x844 the caption
// reported 74 chars -> 2 lines, 115 -> 3, 204 -> 5. A word-wrapped line averages
// a little under the 40 characters the box holds, so a character ceiling one
// notch above each measured case is the honest gate.
for ( const [ name, d, budget, measured ] of [
	[ 'defaults', D.DESIGN_DEFAULTS, 80, '2 lines, measured' ],
	[ 'one per pill', CUSTOMISED, 125, '3 lines, measured' ],
	[ 'everything light', EVERY_LIGHT, 210, '5 lines, measured' ],
	[ 'everything heavy', EVERY_HEAVY, 210, '5 lines' ]
] ) {

	const s = D.describe( d );
	line( pad( name, 17 ) + pad( s.length + '/' + budget + ' chars', 15 ) + measured );
	line( pad( '', 17 ) + s );
	ok( 'the "' + name + '" caption is over its ' + budget + '-character budget at 390 px',
		s.length <= budget, s.length + ' chars' );

}

// ---------------------------------------------------------------------------
// 8. No drift against the files that actually own these numbers
// ---------------------------------------------------------------------------

section( '7. No drift against physics.js and modal.js' );

// physics.js imports three by bare specifier, which node cannot resolve on its
// own and which design.js deliberately refuses to depend on. A synchronous
// resolve hook points that one specifier at the vendored bundle - still plain
// node, still no npm - so the drift check reads the REAL tables rather than a
// copy of them.
try {

	const threeUrl = pathToFileURL( join( ROOT, 'assets/vendor/three.module.min.js' ) ).href;
	registerHooks( {
		resolve( specifier, context, next ) {

			if ( specifier === 'three' ) return { url: threeUrl, shortCircuit: true };
			return next( specifier, context );

		}
	} );

	const physics = await import( pathToFileURL( join( ROOT, 'assets/js/physics.js' ) ).href );
	const modal = await import( pathToFileURL( join( ROOT, 'assets/js/modal.js' ) ).href );

	const scaleKeys = Object.keys( physics.SCALES );
	ok( 'SCALE_KEYS has drifted from physics.js SCALES',
		deepEqual( scaleKeys.slice().sort(), D.SCALE_KEYS.slice().sort() ),
		scaleKeys.join( ',' ) + '  vs  ' + D.SCALE_KEYS.join( ',' ) );
	line( 'scale keys        ' + scaleKeys.length + ' in physics.js, all aliased' );

	for ( const k of scaleKeys ) {

		ok( 'no alias for scale ' + k, typeof D.SCALE_ALIAS[ k ] === 'string' );

	}

	const aliasValues = Object.values( D.SCALE_ALIAS );
	ok( 'two scales share an alias', new Set( aliasValues ).size === aliasValues.length );

	const stockNames = modal.CATALOGUE.map( ( c ) => c.name );
	ok( 'STOCK_NAMES has drifted from modal.js CATALOGUE', deepEqual( stockNames, [ ...D.STOCK_NAMES ] ) );
	for ( const n of stockNames ) ok( 'no alias for stock ' + JSON.stringify( n ), typeof D.STOCK_ALIAS[ n ] === 'string' );
	const stockAliases = Object.values( D.STOCK_ALIAS );
	ok( 'two stocks share an alias', new Set( stockAliases ).size === stockAliases.length );
	line( 'stock names       ' + stockNames.length + ' in modal.js, all aliased' );

	const PART_MAP = {
		'clapper.width': 'clapperWidth',
		'clapper.mass': 'clapperMass',
		'clapper.drop': 'clapperDrop',
		'sail.mass': 'sailMass',
		'sail.height': 'sailHeight'
	};

	for ( const [ key, part ] of Object.entries( PART_MAP ) ) {

		const mine = D.RANGES[ key ];
		const theirs = physics.PART_LIMITS[ part ];
		ok( key + ' has drifted from PART_LIMITS.' + part,
			mine[ 0 ] === theirs[ 0 ] && mine[ 1 ] === theirs[ 1 ],
			JSON.stringify( mine ) + '  vs  ' + JSON.stringify( theirs ) );

	}

	line( 'part ranges       5 checked against PART_LIMITS' );

	// The defaults are physics.js's own PART_DEFAULTS, not a second opinion.
	ok( 'clapper defaults have drifted from PART_DEFAULTS',
		D.DESIGN_DEFAULTS.clapper.width === physics.PART_DEFAULTS.clapperWidth &&
		D.DESIGN_DEFAULTS.clapper.mass === physics.PART_DEFAULTS.clapperMass &&
		D.DESIGN_DEFAULTS.clapper.drop === physics.PART_DEFAULTS.clapperDrop );
	ok( 'sail defaults have drifted from PART_DEFAULTS',
		D.DESIGN_DEFAULTS.sail.mass === physics.PART_DEFAULTS.sailMass &&
		D.DESIGN_DEFAULTS.sail.height === physics.PART_DEFAULTS.sailHeight );

	// The default stock must be the section physics.js is actually hanging.
	const hung = modal.CATALOGUE.find( ( c ) => c.od === modal.TUBE_STOCK.od );
	ok( 'the default stock is not the one physics.js hangs',
		hung && hung.name === D.DESIGN_DEFAULTS.tubes.stock,
		hung ? hung.name : 'none' );

	// The tube count really is clamped to 3..8 by freqsFor, and MAX_TUBES really
	// is 8 - H32 says this number is clamped in three places with no shared
	// constant, so it gets asserted rather than trusted.
	ok( 'freqsFor does not clamp the tube count to 3..8',
		physics.freqsFor( 'cMajorPentatonic', 99 ).length === 8 &&
		physics.freqsFor( 'cMajorPentatonic', - 5 ).length === 3 &&
		physics.freqsFor( 'cMajorPentatonic', 0 ).length === 3 );
	line( 'note count        freqsFor(99) -> ' + physics.freqsFor( 'cMajorPentatonic', 99 ).length +
		' tubes, freqsFor(-5) -> ' + physics.freqsFor( 'cMajorPentatonic', - 5 ).length + ' tubes' );

	line( 'defaults          clapper, sail and stock all match their source' );

} catch ( err ) {

	ok( 'the drift check could not run', false, err.message );

}

// ---------------------------------------------------------------------------

section( 'Result' );

if ( failures.length ) {

	for ( const f of failures ) line( 'FAIL  ' + f );
	line( '' );
	line( passed + ' checks passed, ' + failures.length + ' FAILED' );
	process.exit( 1 );

}

line( passed + ' checks passed, 0 failed' );
line( 'round trip: ' + N + '/' + N + ' designs survived decode(encode(d)) intact' );
process.exit( 0 );
