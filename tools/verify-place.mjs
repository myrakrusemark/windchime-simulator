#!/usr/bin/env node
/**
 * verify-place.mjs - the place table, its asset and its arithmetic, checked
 * without a browser.
 *
 *   node tools/verify-place.mjs
 *
 * No dependencies, no browser, no network. places.js imports nothing at all, so
 * it loads straight into node, and scene.js and plate.js are read as TEXT
 * rather than imported - both pull in three.js, which is not the point here.
 *
 * What it proves, in order:
 *   1. Every place in the table is complete and self-consistent, and every id,
 *      fallback and style name resolves to something that exists.
 *   2. resolvePlace and fallbackFor are total: junk in, a real place out, never
 *      undefined and never the place that just failed.
 *   3. THE CROP ARITHMETIC. plate.js solves the visible crop from the place's
 *      world size and the camera's frustum. The same solve is done here, at
 *      seven viewport sizes from a 320 px phone to a 21:9 desktop, and every
 *      one of them has to land inside the image with the authored hang ranges
 *      still reachable. This is the check that catches a place authored with a
 *      plate too small for its own ranges - which reads as the picture sliding
 *      off its own edge, and only on somebody else's window.
 *   4. The plate file is on disk, is a WebP, matches the width and height the
 *      place declares, and is small enough to be a backdrop rather than a
 *      download.
 *   5. THE LICENCE GATE (CONTRACTS 5.5). A row in ASSETS.md naming a real
 *      author and a real source URL, a named attribution block in NOTICE, the
 *      asset stored under assets/, and the licence not NC, ND or SA.
 *   6. The one that will actually rot: the sun. A plate place's shadows are
 *      cast from the STYLE's azimuth, because applySun reads S.sunAzDeg and its
 *      body is off limits to this piece. If somebody moves storybook's sun, the
 *      chime's shadow silently stops agreeing with the photograph's - so the
 *      style's number is read out of scene.js and compared to the one the place
 *      recorded.
 *   7. The assumptions plate.js is written against: storybook has no tone curve
 *      and no bloom, so the plate can be written straight out as sRGB bytes,
 *      and its fog is zero, so the backdrop cannot be washed by a gust.
 *
 * Exit 0 = everything above passed. Exit 1 = read the failures.
 */

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const read = ( p ) => readFileSync( join( ROOT, p ), 'utf8' );

const P = await import( pathToFileURL( join( ROOT, 'assets/js/places.js' ) ).href );

let passed = 0;
const failures = [];

function ok( name, condition, detail ) {

	if ( condition ) {

		passed ++;
		return true;

	}

	failures.push( detail === undefined ? name : name + ' -- ' + detail );
	return false;

}

// ---------------------------------------------------------------------------
// 1. The table
// ---------------------------------------------------------------------------

const ids = P.PLACE_IDS;
ok( 'PLACE_IDS is a non-empty array', Array.isArray( ids ) && ids.length >= 2, JSON.stringify( ids ) );
ok( 'the default place is in the table', ids.indexOf( P.DEFAULT_PLACE_ID ) !== - 1, P.DEFAULT_PLACE_ID );

const STYLE_NAMES = [ ...read( 'assets/js/scene.js' ).matchAll( /^\s{2}(\w+): \{\n\s{4}name: '(\w+)'/gm ) ].map( ( m ) => m[ 2 ] );
ok( 'scene.js STYLES parsed', STYLE_NAMES.length >= 2, JSON.stringify( STYLE_NAMES ) );

for ( const id of ids ) {

	const p = P.PLACES[ id ];
	if ( ! ok( 'place ' + id + ' exists', !! p ) ) continue;

	ok( id + ': id matches its key', p.id === id, p.id );
	ok( id + ': has a name', typeof p.name === 'string' && p.name.length > 0 );
	ok( id + ': has a blurb', typeof p.blurb === 'string' && p.blurb.length > 10 );
	ok( id + ': kind is plate or procedural', p.kind === 'plate' || p.kind === 'procedural', p.kind );
	ok( id + ': names a style that exists', STYLE_NAMES.indexOf( p.backdrop.style ) !== - 1, p.backdrop.style );
	ok( id + ': authors an acoustic label', typeof p.acoustic.label === 'string' && p.acoustic.label.length > 0 );
	ok( id + ': wind is complete', Number.isFinite( p.wind.mph ) && Number.isFinite( p.wind.dirDeg ) && Number.isFinite( p.wind.turbulence ) );
	ok( id + ': hang default is inside its own ranges',
		p.hang.default.u >= p.hang.uRange[ 0 ] && p.hang.default.u <= p.hang.uRange[ 1 ] &&
		p.hang.default.v >= p.hang.vRange[ 0 ] && p.hang.default.v <= p.hang.vRange[ 1 ] &&
		p.hang.default.scale >= p.hang.scaleRange[ 0 ] && p.hang.default.scale <= p.hang.scaleRange[ 1 ],
		JSON.stringify( p.hang ) );
	ok( id + ': scale range is inside the structural 0.6..1.8',
		p.hang.scaleRange[ 0 ] >= 0.6 && p.hang.scaleRange[ 1 ] <= 1.8, JSON.stringify( p.hang.scaleRange ) );

	if ( p.fallback !== null ) {

		ok( id + ': fallback resolves', !! P.PLACES[ p.fallback ], p.fallback );

	}

	if ( p.kind === 'plate' ) {

		ok( id + ': the camera is fixed', p.camera.fixed === true );
		ok( id + ': the shadow catcher is on', p.shadow.catcher === true );
		ok( id + ': has a credit with a named author', !! ( p.credit && p.credit.author && p.credit.author.length > 1 ) );
		ok( id + ': has a credit with a source URL', !! ( p.credit && /^https?:\/\//.test( p.credit.source || '' ) ) );

	} else {

		ok( id + ': a procedural place declares no backdrop image', p.backdrop.src === null );

	}

	// ARBITRATION 4 authors the field and loads nothing this run.
	ok( id + ': no splat is loaded at runtime', p.backdrop.splat === null );

}

// The design's own default place has to be one this table can serve, or a cold
// load with no ?c= boots into a place that does not exist.
const designSrc = read( 'assets/js/design.js' );
const designPlace = ( designSrc.match( /\n\tplace:\s*'([a-z0-9-]+)'/ ) || [] )[ 1 ];
ok( 'design.js default place resolves', !! P.PLACES[ designPlace ], String( designPlace ) );
ok( 'design.js default place is the table default', designPlace === P.DEFAULT_PLACE_ID,
	designPlace + ' vs ' + P.DEFAULT_PLACE_ID );

// ---------------------------------------------------------------------------
// 2. Totality
// ---------------------------------------------------------------------------

const JUNK = [ undefined, null, 0, 1, NaN, '', 'atlantis', '__proto__', 'constructor', 'toString',
	{}, [], true, 'FOREST-PATH', ' forest-path ', 'x'.repeat( 4096 ) ];

for ( const j of JUNK ) {

	let out;
	let threw = false;
	try {

		out = P.resolvePlace( j );

	} catch ( err ) {

		threw = true;

	}

	ok( 'resolvePlace(' + String( j ).slice( 0, 20 ) + ') does not throw', ! threw );
	ok( 'resolvePlace(' + String( j ).slice( 0, 20 ) + ') returns a real place', !! ( out && out.id && P.PLACES[ out.id ] ) );

}

for ( const id of ids ) {

	const p = P.PLACES[ id ];
	const fb = P.fallbackFor( p );
	ok( 'fallbackFor(' + id + ') returns a real place', !! ( fb && P.PLACES[ fb.id ] ) );
	ok( 'fallbackFor(' + id + ') lands somewhere with no asset to fail',
		fb.kind === 'procedural', fb.id + ' is ' + fb.kind );
	// A place that declares a fallback must not resolve back to itself, or a
	// failed asset retries the same failure forever.
	if ( p.fallback !== null ) ok( 'fallbackFor(' + id + ') is not the place that failed', fb.id !== id, fb.id );

}

ok( 'fallbackFor(junk) does not throw', ( () => {

	try {

		return !! P.fallbackFor( undefined ) && !! P.fallbackFor( {} ) && !! P.fallbackFor( { fallback: 'nope' } );

	} catch ( err ) {

		return false;

	}

} )() );

// ---------------------------------------------------------------------------
// 3. The crop arithmetic - plate.js's solve(), restated
// ---------------------------------------------------------------------------

// Kept a separate implementation on purpose. Importing plate.js would drag in
// three.js and, worse, would make this test agree with the code by definition
// rather than by arithmetic.
function solve( place, w, h, scale, u, v ) {

	const portrait = h > w * 1.05;
	const vh = portrait ? place.camera.viewHeightPortrait : place.camera.viewHeight;
	const world = place.backdrop.world;
	const hx = Math.min( 1, ( vh * ( w / h ) * scale ) / world[ 0 ] ) * 0.5;
	const hy = Math.min( 1, ( vh * scale ) / world[ 1 ] ) * 0.5;
	const cx = Math.min( Math.max( u, hx ), 1 - hx );
	const cy = Math.min( Math.max( v, hy ), 1 - hy );
	return { hx, hy, cx, cy };

}

const VIEWPORTS = [
	[ 1440, 900, 'the judged desktop' ],
	[ 1920, 1080, '16:9 laptop' ],
	[ 2560, 1080, '21:9 ultrawide' ],
	[ 1280, 600, 'short landscape' ],
	[ 390, 844, 'the judged phone' ],
	[ 320, 568, 'the smallest phone' ],
	[ 844, 390, 'phone on its side' ]
];

for ( const id of ids ) {

	const p = P.PLACES[ id ];
	if ( p.kind !== 'plate' ) continue;

	for ( const [ w, h, label ] of VIEWPORTS ) {

		for ( const scale of [ p.hang.scaleRange[ 0 ], 1, p.hang.scaleRange[ 1 ] ] ) {

			const r = solve( p, w, h, scale, p.hang.default.u, p.hang.default.v );
			const tag = id + ' @ ' + w + 'x' + h + ' (' + label + ') scale ' + scale;
			ok( tag + ': the crop stays inside the image',
				r.cx - r.hx >= - 1e-9 && r.cx + r.hx <= 1 + 1e-9 &&
				r.cy - r.hy >= - 1e-9 && r.cy + r.hy <= 1 + 1e-9,
				JSON.stringify( r ) );

		}

		// At the default scale the AUTHORED hang range has to be reachable, or
		// P5's control promises travel the plate cannot give it.
		//
		// Only up to a 1.8 aspect. Wider than that the crop is a bigger slice of
		// the plate and the reachable range narrows - on a 21:9 window the crop
		// is the whole image and u is pinned. That is arithmetic, not a defect:
		// the margin is finite and a wider window spends it. plate.js reports
		// what is actually reachable through limits() so the hang control can
		// show the truth, and the check that matters at those sizes is the one
		// above, that the crop never leaves the image.
		if ( w / h > 1.05 && w / h <= 1.8 ) {

			const r = solve( p, w, h, 1, p.hang.default.u, p.hang.default.v );
			ok( id + ' @ ' + w + 'x' + h + ': the authored u range is reachable',
				p.hang.uRange[ 0 ] >= r.hx - 1e-9 && p.hang.uRange[ 1 ] <= 1 - r.hx + 1e-9,
				'need u in [' + r.hx.toFixed( 4 ) + ', ' + ( 1 - r.hx ).toFixed( 4 ) + '], authored ' + JSON.stringify( p.hang.uRange ) );
			ok( id + ' @ ' + w + 'x' + h + ': the authored v range is reachable',
				p.hang.vRange[ 0 ] >= r.hy - 1e-9 && p.hang.vRange[ 1 ] <= 1 - r.hy + 1e-9,
				'need v in [' + r.hy.toFixed( 4 ) + ', ' + ( 1 - r.hy ).toFixed( 4 ) + '], authored ' + JSON.stringify( p.hang.vRange ) );

		}

	}

	// The plate is only worth its bytes if the default crop is not an upscale on
	// the viewport the run is judged at.
	const r = solve( p, 1440, 900, 1, p.hang.default.u, p.hang.default.v );
	const srcPx = 2 * r.hx * p.backdrop.width;
	ok( id + ': the default crop is not upscaled at 1440x900',
		srcPx >= 1440, Math.round( srcPx ) + ' source px into 1440' );

	// And the default frame has to be the one the plate was composed for, or the
	// picture a stranger lands on is not the picture that was judged.
	ok( id + ': the backdrop anchor is the design default hang',
		Math.abs( p.backdrop.anchor[ 0 ] - p.hang.default.u ) < 1e-9 &&
		Math.abs( p.backdrop.anchor[ 1 ] - p.hang.default.v ) < 1e-9,
		JSON.stringify( p.backdrop.anchor ) + ' vs ' + JSON.stringify( p.hang.default ) );

}

// ---------------------------------------------------------------------------
// 4. The file on disk
// ---------------------------------------------------------------------------

for ( const id of ids ) {

	const p = P.PLACES[ id ];
	if ( ! p.backdrop.src ) continue;

	let buf = null;
	try {

		buf = readFileSync( join( ROOT, p.backdrop.src ) );

	} catch ( err ) {

		ok( id + ': the plate file exists', false, p.backdrop.src );
		continue;

	}

	ok( id + ': the plate file exists', true );
	ok( id + ': the plate is stored under assets/', p.backdrop.src.indexOf( 'assets/' ) === 0, p.backdrop.src );

	const riff = buf.slice( 0, 4 ).toString( 'latin1' ) === 'RIFF' && buf.slice( 8, 12 ).toString( 'latin1' ) === 'WEBP';
	ok( id + ': the plate is a WebP', riff );

	// VP8L and lossy VP8 carry their size differently; this build ships VP8L
	// or lossy, so read whichever chunk is present.
	let w = 0, h = 0;
	const fourcc = buf.slice( 12, 16 ).toString( 'latin1' );
	if ( fourcc === 'VP8 ' ) {

		w = buf.readUInt16LE( 26 ) & 0x3fff;
		h = buf.readUInt16LE( 28 ) & 0x3fff;

	} else if ( fourcc === 'VP8L' ) {

		const b = buf.readUInt32LE( 21 );
		w = ( b & 0x3fff ) + 1;
		h = ( ( b >> 14 ) & 0x3fff ) + 1;

	} else if ( fourcc === 'VP8X' ) {

		w = ( buf.readUIntLE( 24, 3 ) ) + 1;
		h = ( buf.readUIntLE( 27, 3 ) ) + 1;

	}

	ok( id + ': the plate size matches the declared size',
		w === p.backdrop.width && h === p.backdrop.height,
		w + 'x' + h + ' on disk vs ' + p.backdrop.width + 'x' + p.backdrop.height + ' declared' );

	const kb = statSync( join( ROOT, p.backdrop.src ) ).size / 1024;
	ok( id + ': the plate is under 600 KB', kb < 600, Math.round( kb ) + ' KB' );

}

// ---------------------------------------------------------------------------
// 5. The licence gate - CONTRACTS 5.5
// ---------------------------------------------------------------------------

const assetsMd = read( 'ASSETS.md' );
const notice = read( 'NOTICE' );

for ( const id of ids ) {

	const p = P.PLACES[ id ];
	if ( ! p.credit ) continue;

	ok( id + ': ASSETS.md has a row for the asset', assetsMd.indexOf( p.backdrop.src ) !== - 1, p.backdrop.src );
	ok( id + ': the ASSETS.md row names the author', assetsMd.indexOf( p.credit.author ) !== - 1, p.credit.author );
	ok( id + ': the ASSETS.md row carries the source URL', assetsMd.indexOf( p.credit.source ) !== - 1, p.credit.source );
	ok( id + ': the author is not a placeholder',
		! /TO BE FILLED|TODO|unknown|placeholder/i.test( p.credit.author ), p.credit.author );

	ok( id + ': NOTICE names the author', notice.indexOf( p.credit.author ) !== - 1, p.credit.author );
	ok( id + ': NOTICE links the scene', notice.indexOf( p.credit.source ) !== - 1 );
	ok( id + ': NOTICE links the licence deed', notice.indexOf( 'creativecommons.org/licenses/by/4.0' ) !== - 1 );

	ok( id + ': the licence is not NC, ND or SA',
		! /-nc|-nd|-sa|noncommercial|noderiv|sharealike/i.test( p.credit.licence ), p.credit.licence );

	// The visitor gets the attribution too, not only the repository.
	const html = read( 'index.html' );
	ok( id + ': the page itself credits the author', html.indexOf( p.credit.author ) !== - 1 );
	ok( id + ': the page itself links the licence', html.indexOf( 'creativecommons.org/licenses/by/4.0' ) !== - 1 );

}

// .gitignore:45 is a bare, unanchored `.cache`, so any path with a .cache
// directory in it is silently untracked and the asset 404s for everyone but the
// person who built it (H38).
const ignore = read( '.gitignore' );
const bare = ignore.split( '\n' ).some( ( l ) => l.trim() === '.cache' );
for ( const id of ids ) {

	const p = P.PLACES[ id ];
	if ( ! p.backdrop.src ) continue;
	ok( id + ': the asset path cannot be caught by the bare .cache rule',
		! bare || p.backdrop.src.split( '/' ).indexOf( '.cache' ) === - 1, p.backdrop.src );

}

// ---------------------------------------------------------------------------
// 6. The sun the shadows are actually cast from
// ---------------------------------------------------------------------------

const sceneSrc = read( 'assets/js/scene.js' );

function styleField( style, field ) {

	const block = sceneSrc.split( '\n  ' + style + ': {' )[ 1 ];
	if ( ! block ) return null;
	const m = block.split( '\n  },' )[ 0 ].match( new RegExp( '\\n\\s+' + field + ':\\s*([^,\\n]+)' ) );
	return m ? m[ 1 ].trim() : null;

}

for ( const id of ids ) {

	const p = P.PLACES[ id ];
	if ( p.kind !== 'plate' ) continue;

	const styleAz = Number( styleField( p.backdrop.style, 'sunAzDeg' ) );
	ok( id + ': the style publishes a sun azimuth', Number.isFinite( styleAz ), String( styleAz ) );

	// applySun's body is off limits to P4 and it aims the light from S.sunAzDeg,
	// so this IS the direction the chime's shadow falls in. The place records
	// the same number; if the style moves and the place does not, the shadow
	// stops agreeing with the photograph and nothing else says so.
	let delta = Math.abs( p.sun.azDeg - styleAz ) % 360;
	if ( delta > 180 ) delta = 360 - delta;
	ok( id + ': the place sun azimuth matches the style it is lit by',
		delta < 0.5, 'place ' + p.sun.azDeg + ' vs style ' + styleAz );

	const lo = /sky: true/.test( sceneSrc.split( '\n  ' + p.backdrop.style + ': {' )[ 1 ].split( '\n  },' )[ 0 ] ) ? 2 : 26;
	const hi = lo === 2 ? 20 : 74;
	ok( id + ': the authored sun elevation is inside the style range',
		p.sun.elevDeg >= lo && p.sun.elevDeg <= hi, p.sun.elevDeg + ' vs [' + lo + ', ' + hi + ']' );

}

// ---------------------------------------------------------------------------
// 7. The assumptions plate.js is written against
// ---------------------------------------------------------------------------

for ( const id of ids ) {

	const p = P.PLACES[ id ];
	if ( p.kind !== 'plate' ) continue;
	const block = sceneSrc.split( '\n  ' + p.backdrop.style + ': {' )[ 1 ].split( '\n  },' )[ 0 ];

	// plate.js writes the texture straight out as sRGB bytes. That is only
	// correct with no tone curve and no bloom pass in the way.
	ok( id + ': the style has no tone curve, so the plate can pass through raw',
		/toneMapping: 'none'/.test( block ), 'plate.js would need a linear conversion' );
	ok( id + ': the style has no bloom, so nothing post-processes the backdrop',
		/bloom: false/.test( block ) );
	// H17: FogExp2 is applied to every mesh and its density is rewritten from
	// the wind every frame, from render(), which is not P4's to edit.
	ok( id + ': the style has zero fog, so a gust cannot wash the backdrop',
		/fogCalm: 0\.0/.test( block ) && /fogBlown: 0\.0/.test( block ) );

}

// The one thing that would quietly undo Rule A.
const plateSrc = read( 'assets/js/plate.js' );
ok( 'plate.js never touches the chime, the rig or the hook',
	! /\bchime\s*[.[]|\brig\b|HOOK_[XYZ]/.test( plateSrc.replace( /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '' ) ) );
ok( 'plate.js draws in clip space', /gl_Position = vec4\( position\.xy/.test( plateSrc ) );
ok( 'scene.js still leaves the chime group at identity',
	! /chime\.(position|scale|rotation|quaternion)\s*[.=]/.test( sceneSrc ) );

// ---------------------------------------------------------------------------

if ( failures.length ) {

	console.error( '\nFAIL  ' + failures.length + ' of ' + ( failures.length + passed ) + '\n' );
	for ( const f of failures ) console.error( '  - ' + f );
	console.error( '' );
	process.exit( 1 );

}

console.log( 'verify-place: ' + passed + ' checks passed' );
process.exit( 0 );
