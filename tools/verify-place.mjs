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

		// A PLATE'S CAMERA IS FIXED; A SPLAT'S IS NOT, AND THEY SHARE A `kind`.
		// One photograph taken from one direction has nothing on its far side,
		// so orbiting a plate walks the object off its own picture. A capture is
		// a reconstruction and does have a far side, so it may orbit - bounded,
		// or a visitor swings behind the gaussians and finds the back of the
		// world. Which branch a place takes is decided by `splat`, exactly as
		// scene.js decides which module draws it.
		if ( p.backdrop.splat === null ) {

			ok( id + ': the camera is fixed', p.camera.fixed === true );

		} else {

			const orb = p.camera.orbit;
			ok( id + ': a capture may orbit, but only inside authored bounds',
				p.camera.fixed === false && !! orb
					&& orb.azDeg.length === 2 && orb.azDeg[ 0 ] < orb.azDeg[ 1 ]
					&& orb.elevDeg.length === 2 && orb.elevDeg[ 0 ] < orb.elevDeg[ 1 ],
				JSON.stringify( orb ) );

			// The capture is the place. Naming one nobody shipped is a frame
			// with a chime hanging in empty space, and the fetch fails quietly
			// into onError - there is no louder failure to wait for.
			let kb = 0;
			try { kb = statSync( join( ROOT, p.backdrop.splat ) ).size / 1024; } catch ( e ) {}
			ok( id + ': the declared capture is on disk under assets/',
				kb > 0 && p.backdrop.splat.startsWith( 'assets/' ),
				p.backdrop.splat + ( kb ? ' at ' + Math.round( kb ) + ' kB' : ' is missing' ) );

			// How far hang.u/v may slide the capture. splat.js falls back to
			// {x:6,y:3} when it is absent, which is a quiet 6 m of travel the
			// place never agreed to.
			ok( id + ': the capture authors its own hang reach',
				!! p.backdrop.reach && p.backdrop.reach.x > 0 && p.backdrop.reach.y > 0,
				JSON.stringify( p.backdrop.reach ) );

		}

		ok( id + ': the shadow catcher is on', p.shadow.catcher === true );
		ok( id + ': has a credit with a named author', !! ( p.credit && p.credit.author && p.credit.author.length > 1 ) );
		ok( id + ': has a credit with a source URL', !! ( p.credit && /^https?:\/\//.test( p.credit.source || '' ) ) );

	} else {

		ok( id + ': a procedural place declares no backdrop image', p.backdrop.src === null );
		ok( id + ': a procedural place declares no capture', p.backdrop.splat === null );

	}

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
const splatSrc = read( 'assets/js/splat.js' );
// Read for one assertion only: that the bridle still hangs on the ring
// particle. The eye a place draws and the anchor the rig solves are one fact in
// two files, and this is the file that notices when they part company.
const physicsSrc = read( 'assets/js/physics.js' );

function styleField( style, field ) {

	const block = sceneSrc.split( '\n  ' + style + ': {' )[ 1 ];
	if ( ! block ) return null;
	const m = block.split( '\n  },' )[ 0 ].match( new RegExp( '\\n\\s+' + field + ':\\s*([^,\\n]+)' ) );
	return m ? m[ 1 ].trim() : null;

}

// ---------------------------------------------------------------------------
// EVERY STYLE HAS TO ANSWER THE PORTRAIT QUESTION.
//
// applyFraming reads these off S unconditionally when the window is taller than
// it is wide. `camTargetPortraitY` was authored on golden and on golden only,
// and both shipped places run under storybook - so the first narrow window put
// `controls.target.set(0, undefined, 0)` in, which is a NaN target, a NaN camera
// position one line later, and a view matrix that draws nothing anywhere. No
// error, no console message, twenty-eight draw calls a frame of nothing, and it
// did not come back when the window was widened again because the recovery path
// measures an offset from the camera position it had already destroyed.
//
// Found by Myra on a 645 px window, 2026-08-11. applyFraming now falls back and
// then backstops a non-finite result, so this cannot brick the page any more -
// but a style that has not been asked the question is still a style nobody
// framed, and that is what this catches.
// Scoped to the branch applyFraming actually takes, because the two halves read
// different fields and asserting both would fail a style for not answering a
// question it is never asked: an ortho style reframes by growing the frustum and
// never touches baseDistPortrait, a perspective one moves the eye and never
// touches viewHeightPortrait. camPos and camTarget are in both lists because the
// non-finite backstop falls back to them whichever branch ran.
const PORTRAIT_KEYS_COMMON = [ 'camPos', 'camTarget' ];
const PORTRAIT_KEYS_ORTHO = [ 'viewHeight', 'viewHeightPortrait' ];
const PORTRAIT_KEYS_PERSP = [ 'camTargetPortraitY', 'baseDist', 'baseDistPortrait' ];

for ( const style of STYLE_NAMES ) {

	const ortho = styleField( style, 'ortho' ) === 'true';
	const keys = PORTRAIT_KEYS_COMMON.concat( ortho ? PORTRAIT_KEYS_ORTHO : PORTRAIT_KEYS_PERSP );

	for ( const key of keys ) {

		const v = styleField( style, key );
		ok( style + ': the ' + ( ortho ? 'ortho' : 'perspective' ) + ' style authors ' + key,
			v !== null && v !== 'undefined', String( v ) );

	}

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

// ---------------------------------------------------------------------------
// THE COMPOSITE. Seven numbers in three files describe one picture, and every
// one of the defects this file was extended for was two of them disagreeing.
// ---------------------------------------------------------------------------

{
	const D = P.PLACES[ P.DEFAULT_PLACE_ID ];
	const render = JSON.parse( read( 'assets/places/forest-path/render.json' ) );

	// 1. The design's default hang IS the default place's default hang. If these
	//    drift, a cold load of ?c=v1 - the canonical share string - shows a frame
	//    nobody composed, and design() and the picture disagree with no error.
	//    design.js may not import places.js, so this assertion is the tie.
	const dh = designSrc.match( /\n\thang:\s*\{\s*u:\s*([\d.]+),\s*v:\s*([\d.]+),\s*scale:\s*([\d.]+)/ );
	ok( 'design.js DESIGN_DEFAULTS.hang matches the default place\'s own default',
		!! dh && Math.abs( + dh[ 1 ] - D.hang.default.u ) < 1e-9
			&& Math.abs( + dh[ 2 ] - D.hang.default.v ) < 1e-9
			&& Math.abs( + dh[ 3 ] - D.hang.default.scale ) < 1e-9,
		dh ? 'design.js has ' + dh.slice( 1, 4 ).join( '/' ) + ', places.js has '
			+ [ D.hang.default.u, D.hang.default.v, D.hang.default.scale ].join( '/' ) : 'not found' );

	// 2. THE CAMERA TARGET AND THE CROP CENTRE ARE ONE FACT WRITTEN TWICE.
	//    The plate was rendered with its optical axis at render.json's target and
	//    anchor, which fixes the world height of the image's top edge. The
	//    runtime aims at camera.target and crops at hang.default.v. If those two
	//    stop agreeing, the photograph's ground and the object's ground part
	//    company - the chime floats or sinks - and nothing errors.
	const topY = render.camera.target[ 1 ] + render.anchor[ 1 ] * render.world[ 1 ];
	const wantV = ( topY - D.camera.target[ 1 ] ) / render.world[ 1 ];
	ok( 'the camera target and the plate crop centre describe the same world point',
		Math.abs( wantV - D.hang.default.v ) < 0.006,
		'target y ' + D.camera.target[ 1 ] + ' implies v ' + wantV.toFixed( 4 )
			+ ', authored ' + D.hang.default.v );

	// 3. THE FRAME HOLDS THE WHOLE COMPOSITE. The arithmetic is written out at
	//    the top of places.js; this is it, executed. h = cos(el)*(y-Ty) -
	//    sin(el)*z is the screen height of a world point above the frame's
	//    middle. The page's own caption and pill row are opaque over the bottom
	//    11 % of the frame, so a shadow below -0.391*V is a shadow no critic can
	//    judge and criterion 5 asks one to.
	const el = D.camera.elevDeg * Math.PI / 180;
	const Ty = D.camera.target[ 1 ];
	const HOOK_Y = 2.60;                       // physics.js, read-only to P4
	const TOP_PLATE_Y = 2.05;                  // the tallest shadow caster on the chime
	const CHROME = 0.391;                      // measured: chrome covers y 802..880 of 900
	const h = ( y, z ) => Math.cos( el ) * ( y - Ty ) - Math.sin( el ) * z;

	for ( const [ label, V ] of [ [ 'landscape', D.camera.viewHeight ], [ 'portrait', D.camera.viewHeightPortrait ] ] ) {

		ok( 'forest-path ' + label + ': the hook is inside the frame with room over it',
			h( HOOK_Y, 0 ) <= V / 2 - 0.05,
			'hook at h ' + h( HOOK_Y, 0 ).toFixed( 3 ) );

		// Where the top plate's shadow lands, at the place's own sun.
		const se = D.sun.elevDeg * Math.PI / 180;
		const sa = D.sun.azDeg * Math.PI / 180;
		const reach = TOP_PLATE_Y / Math.tan( se );
		const tipZ = reach * Math.cos( sa );
		ok( 'forest-path ' + label + ': the cast shadow lands clear of the page\'s own chrome',
			h( D.shadow.y, tipZ ) >= - CHROME * V,
			'shadow tip at h ' + h( D.shadow.y, tipZ ).toFixed( 3 ) + ', usable bottom ' + ( - CHROME * V ).toFixed( 3 ) );

	}

	// 4. THE EYE IS ON THE RING. There is no limb any more - the capture has a
	//    real canopy and a modelled branch in front of a photographed one looked
	//    worse than none. What is left is the iron eye, and its whole job is to
	//    be the point the bridle's three cords meet at. Put it anywhere else by
	//    even a few centimetres and the chime hangs visibly BESIDE its own ring,
	//    with nothing to error on: this is exactly how `z: -0.06` survived the
	//    limb it was written for and put the ring off-centre on screen.
	ok( 'the hanger spec carries no lateral offset for the eye to inherit',
		D.hanger.z === undefined && D.hanger.x === undefined,
		'hanger has ' + JSON.stringify( D.hanger ) );
	//    This used to be "the eye is at HOOK_X/HOOK_Z", a constant, and that was
	//    only ever true because the bridle hung off the same constant. The ring
	//    is a particle now and it swings, so pinning the eye to an axis would
	//    assert the opposite of what is wanted. The invariant that survives is
	//    the one that always mattered: the eye is drawn WHERE THE BRIDLE MEETS.
	//    Two halves, because the agreement can break from either end - splat.js
	//    reading a constant again, or physics.js going back to a static anchor.
	//    The one constant left is the eye's BUILD pose, and that one is wanted:
	//    a hanger added to the scene before the rig has reported a ring has to
	//    stand somewhere sane for a frame. What is asserted is that a frame with
	//    a ring in it overrides that pose from the rig.
	ok( 'splat.js places the eye from the rig ring rather than from a constant',
		/function placeEye\(/.test( splatSrc ) &&
		/placeEye\( ringPos\[ 0 \], ringPos\[ 1 \], ringPos\[ 2 \] \)/.test( splatSrc ),
		'expected placeEye() fed from RigState.ring.pos inside frame()' );
	ok( 'physics.js hangs the bridle on the ring particle, not on a point in the sky',
		/link\(\[RING\], \[1\], \[i\], \[1\], BRIDLE_CORD, CORD_ALPHA, true, null\)/.test( physicsSrc ),
		'expected the three bridle strands to take RING as their anchor with staticA null' );

	// 5. A place may narrow the sun but never past what scene.js will accept.
	// The no-sky branch, which is the one a plate place runs under.
	const lo = + ( sceneSrc.match( /SUN_LO\s*=\s*S\.sky\s*\?\s*[\d.]+\s*:\s*([\d.]+)/ ) || [] )[ 1 ];
	const hi = + ( sceneSrc.match( /SUN_HI\s*=\s*S\.sky\s*\?\s*[\d.]+\s*:\s*([\d.]+)/ ) || [] )[ 1 ];
	ok( 'forest-path pins its sun to a range the photograph can survive',
		Array.isArray( D.sun.range ) && D.sun.range[ 0 ] >= lo && D.sun.range[ 1 ] <= hi
			&& D.sun.elevDeg >= D.sun.range[ 0 ] && D.sun.elevDeg <= D.sun.range[ 1 ],
		JSON.stringify( D.sun.range ) + ' against scene.js [' + lo + ',' + hi + ']' );
}

// H14, made true by construction rather than by two places happening to agree.
// audio.js turns cameraDistance() into distGain, so a place that authors its own
// frustum height must not be able to change how loud the chime is.
ok( 'cameraDistance() reports the STYLE frustum, not the live one (H14)',
	/if \(S\.ortho\) return S\.viewHeight \/ Math\.max\(camera\.zoom/.test( sceneSrc ),
	'scene.js cameraDistance() still reads the per-place viewHeight' );

// The windviz furniture that has no business over a photograph.
for ( const n of [ 'wcs-streamers', 'wcs-leaves', 'wcs-telltale' ] ) {

	ok( 'scene.js hides ' + n + ' on a plate place',
		new RegExp( "'" + n + "'" ).test( sceneSrc ) );

}

// The design's hang has to survive a place switch: applyPlace rebuilds the plate
// from scratch, so it has to put the visitor's framing back on top of it.
ok( 'applyPlace re-applies the live framing after rebuilding the plate',
	/wantFraming/.test( sceneSrc ) && /plate\.setFraming\(wantFraming\.u/.test( sceneSrc ) );

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
