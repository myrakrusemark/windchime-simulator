#!/usr/bin/env node
/**
 * verify-hang.mjs - the five pass criteria for P5 (CONTRACTS section 6/P5),
 * measured rather than argued.
 *
 *   node tools/verify-hang.mjs [--url http://localhost:8080/] [--out /tmp/hang]
 *
 * What it checks, in the contract's own order:
 *
 *   1  A real pointer drag moves the chime within the place and STOPS HARD at
 *      place.hang.uRange / vRange. "Moves" is measured twice: the plate's own
 *      crop centre, and the mean absolute pixel difference between two
 *      screenshots, so a crop that moved without the picture moving would fail.
 *   2  snapshot().tubeLengths, .tubeFreqs, .plate.pos, .clapper.pos and
 *      .sail.pos are BIT-IDENTICAL across a hang change. The sim is paused
 *      first, because a chime that is swinging moves those numbers every frame
 *      on its own and the question is whether HANGING moved them.
 *   3  __wcs.camera().distance is identical at every hang.scale, so a bigger
 *      chime cannot become a louder one (audio.js's distGain reads exactly this
 *      number). Checked at 0.75 and at 1.45 as the contract asks, and at 1.30,
 *      which is where forest-path's own scaleRange actually stops
 *      (ARBITRATION section 9).
 *   4  hang round-trips through encode/decode to within 0.005 in u and v. Run
 *      in plain node against assets/js/design.js, which is pure.
 *   5  On the porch, whose ranges are degenerate, the three controls are PRESENT
 *      and visibly disabled with a one-line reason - not missing, and not
 *      live-but-inert.
 *
 * Exit code 0 = all five passed. No npm dependency: CDP over node's built-in
 * WebSocket, the same way tools/shot.mjs and tools/count-clicks.mjs do it.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.normalize( path.join( fileURLToPath( new URL( '.', import.meta.url ) ), '..' ) );

const CHROME_CANDIDATES = [
	path.join( process.env.HOME || '', '.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' ),
	'/usr/bin/google-chrome',
	'/usr/bin/chromium-browser',
	'/usr/bin/chromium'
];

const sleep = ( ms ) => new Promise( ( r ) => setTimeout( r, ms ) );

function chromeBinary() {

	for ( const c of CHROME_CANDIDATES ) if ( c && existsSync( c ) ) return c;
	throw new Error( 'no chromium binary found' );

}

function parseArgs( argv ) {

	const out = {};
	for ( let i = 2; i < argv.length; i ++ ) {

		const a = argv[ i ];
		if ( a === '--gpu' ) out.gpu = true;
		else if ( a.startsWith( '--' ) ) out[ a.slice( 2 ) ] = argv[ ++ i ];

	}

	return out;

}

class CDP {

	constructor( ws ) {

		this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
		ws.addEventListener( 'message', ( ev ) => {

			const msg = JSON.parse( ev.data );
			if ( msg.id !== undefined ) {

				const p = this.pending.get( msg.id );
				if ( ! p ) return;
				this.pending.delete( msg.id );
				if ( msg.error ) p.reject( new Error( msg.error.message ) ); else p.resolve( msg.result );

			} else {

				for ( const l of this.listeners ) l( msg );

			}

		} );

	}

	static async connect( url ) {

		const ws = new WebSocket( url );
		await new Promise( ( res, rej ) => {

			ws.addEventListener( 'open', res, { once: true } );
			ws.addEventListener( 'error', () => rej( new Error( 'ws error' ) ), { once: true } );

		} );
		return new CDP( ws );

	}

	on( fn ) {

		this.listeners.push( fn );

	}

	send( method, params = {}, sessionId ) {

		const id = ++ this.id;
		this.ws.send( JSON.stringify( sessionId ? { id, method, params, sessionId } : { id, method, params } ) );
		return new Promise( ( resolve, reject ) => this.pending.set( id, { resolve, reject } ) );

	}

}

async function waitForEndpoint( port, deadlineMs = 25000 ) {

	const t0 = Date.now();
	while ( Date.now() - t0 < deadlineMs ) {

		try {

			const r = await fetch( `http://127.0.0.1:${port}/json/version` );
			if ( r.ok ) return ( await r.json() ).webSocketDebuggerUrl;

		} catch {}

		await sleep( 150 );

	}

	throw new Error( 'chrome never opened its debugging port' );

}

// ---------------------------------------------------------------------------
// A PNG reader, so "the picture moved" is a number and not a claim.
//
// Chrome's Page.captureScreenshot writes 8-bit non-interlaced RGB or RGBA, which
// is the only case this handles; anything else reports null and the criterion
// falls back to the plate's own crop, which is measured independently anyway.
// ---------------------------------------------------------------------------

function decodePNG( buf ) {

	if ( buf.length < 8 || buf.readUInt32BE( 0 ) !== 0x89504e47 ) return null;
	let off = 8;
	let w = 0, h = 0, depth = 0, color = 0, interlace = 0;
	const idat = [];

	while ( off + 8 <= buf.length ) {

		const len = buf.readUInt32BE( off );
		const type = buf.toString( 'latin1', off + 4, off + 8 );
		const body = buf.subarray( off + 8, off + 8 + len );
		if ( type === 'IHDR' ) {

			w = body.readUInt32BE( 0 );
			h = body.readUInt32BE( 4 );
			depth = body[ 8 ];
			color = body[ 9 ];
			interlace = body[ 12 ];

		} else if ( type === 'IDAT' ) {

			idat.push( body );

		} else if ( type === 'IEND' ) break;

		off += 12 + len;

	}

	if ( depth !== 8 || interlace !== 0 ) return null;
	const ch = color === 6 ? 4 : ( color === 2 ? 3 : 0 );
	if ( ch === 0 ) return null;

	const raw = inflateSync( Buffer.concat( idat ) );
	const stride = w * ch;
	const out = Buffer.alloc( h * stride );

	for ( let y = 0; y < h; y ++ ) {

		const f = raw[ y * ( stride + 1 ) ];
		const src = ( y * ( stride + 1 ) ) + 1;
		const dst = y * stride;
		for ( let x = 0; x < stride; x ++ ) {

			const a = x >= ch ? out[ dst + x - ch ] : 0;
			const b = y > 0 ? out[ dst - stride + x ] : 0;
			const c = ( x >= ch && y > 0 ) ? out[ dst - stride + x - ch ] : 0;
			const v = raw[ src + x ];
			let r;
			if ( f === 0 ) r = v;
			else if ( f === 1 ) r = v + a;
			else if ( f === 2 ) r = v + b;
			else if ( f === 3 ) r = v + ( ( a + b ) >> 1 );
			else {

				const p = a + b - c;
				const pa = Math.abs( p - a ), pb = Math.abs( p - b ), pc = Math.abs( p - c );
				r = v + ( ( pa <= pb && pa <= pc ) ? a : ( pb <= pc ? b : c ) );

			}

			out[ dst + x ] = r & 0xff;

		}

	}

	return { w, h, ch, data: out };

}

/** Mean absolute RGB difference, 0..255, over the rows above `bottom`. */
function meanDiff( a, b, bottom ) {

	if ( ! a || ! b || a.w !== b.w || a.h !== b.h || a.ch !== b.ch ) return null;
	const rows = Math.min( a.h, bottom );
	let sum = 0, n = 0;
	for ( let y = 0; y < rows; y ++ ) {

		const o = y * a.w * a.ch;
		for ( let x = 0; x < a.w * a.ch; x += a.ch ) {

			sum += Math.abs( a.data[ o + x ] - b.data[ o + x ] ) +
				Math.abs( a.data[ o + x + 1 ] - b.data[ o + x + 1 ] ) +
				Math.abs( a.data[ o + x + 2 ] - b.data[ o + x + 2 ] );
			n += 3;

		}

	}

	return n ? sum / n : null;

}

// ---------------------------------------------------------------------------
// Criterion 4 runs in plain node: design.js is pure and imports only modal.js.
// ---------------------------------------------------------------------------

async function checkCodec() {

	const design = await import( path.join( ROOT, 'assets/js/design.js' ) );
	const { clampDesign, encode, decode } = design;
	const rows = [];
	let worst = 0;

	// The authored corners of forest-path's ranges, the design default, and a
	// sweep across the structural 0..1 so a place that widens its ranges later is
	// covered too.
	const cases = [];
	for ( const u of [ 0, 0.33, 0.41, 0.5, 0.59, 0.67, 1 ] ) {

		for ( const v of [ 0, 0.33, 0.4, 0.56, 1 ] ) {

			for ( const s of [ 0.6, 0.75, 1, 1.3, 1.45, 1.8 ] ) cases.push( { u, v, s } );

		}

	}

	for ( const c of cases ) {

		const d = clampDesign( { hang: { u: c.u, v: c.v, scale: c.s } } );
		const back = decode( encode( d ) );
		const du = Math.abs( back.hang.u - d.hang.u );
		const dv = Math.abs( back.hang.v - d.hang.v );
		const ds = Math.abs( back.hang.scale - d.hang.scale );
		worst = Math.max( worst, du, dv, ds );
		if ( du > 0.005 || dv > 0.005 || ds > 0.005 ) rows.push( { c, du, dv, ds } );

	}

	// And one wire-level sample, so the report shows what a hang actually looks
	// like in a shared link.
	const sample = encode( clampDesign( { hang: { u: 0.44, v: 0.52, scale: 1.25 } } ) );

	return { cases: cases.length, worst, failures: rows, sample };

}

// ---------------------------------------------------------------------------

const READ = `( () => {
	const w = window.__wcs;
	if ( ! w ) return null;
	const st = w.stage || null;
	const pl = st && typeof st.place === 'function' ? st.place() : null;
	const plate = st ? st.plate : null;
	const s = w.snapshot ? w.snapshot() : null;
	const el = ( id ) => document.getElementById( id );
	const ui = {};
	for ( const [ k, id ] of [ [ 'u', 'wcsHangU' ], [ 'v', 'wcsHangV' ], [ 'scale', 'wcsHangScale' ] ] ) {
		const e = el( id );
		if ( ! e ) { ui[ k ] = null; continue; }
		const cs = getComputedStyle( e );
		const r = e.getBoundingClientRect();
		ui[ k ] = {
			present: true,
			disabled: !! e.disabled,
			min: e.min, max: e.max, value: e.value,
			opacity: Number( cs.opacity ),
			display: cs.display,
			visibility: cs.visibility,
			rendered: r.width > 0 && r.height > 0,
			fieldDimmed: !! ( e.closest( '.wcs-field' ) && e.closest( '.wcs-field' ).classList.contains( 'is-disabled' ) ),
			describedBy: e.getAttribute( 'aria-describedby' )
		};
	}
	const why = el( 'wcsHangWhy' );
	const hint = el( 'wcsHangHint' );
	// .wcs-panel-body is max-height: min(26vh, 222px) with overflow-y: auto, so
	// "the reason is on the page" and "the reason is in front of the visitor"
	// are different questions. This asks the second one.
	const body = document.querySelector( '#wcsPanel-hang .wcs-panel-body' );
	let reasonVisible = null;
	if ( hint && body && ! document.getElementById( 'wcsPanel-hang' ).hidden ) {
		const a = hint.getBoundingClientRect();
		const b = body.getBoundingClientRect();
		reasonVisible = a.height > 0 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
	}
	return {
		place: pl ? pl.id : null,
		placeRanges: pl && pl.hang ? { u: pl.hang.uRange, v: pl.hang.vRange, scale: pl.hang.scaleRange } : null,
		design: w.design ? w.design().hang : null,
		limits: plate && plate.limits ? plate.limits() : null,
		framing: plate && plate.framing ? plate.framing() : null,
		camera: w.camera ? w.camera() : null,
		ui,
		why: why ? why.textContent.trim() : null,
		whyHidden: why ? !! why.hidden : null,
		hint: hint ? hint.textContent.trim() : null,
		reasonVisible,
		errors: s ? s.errors : null,
		frozen: s ? {
			tubeLengths: s.tubeLengths, tubeFreqs: s.tubeFreqs,
			plate: s.plate.pos, clapper: s.clapper.pos, sail: s.sail.pos
		} : null,
		historyLength: window.history.length,
		search: window.location.search
	};
} )()`;

async function main() {

	const args = parseArgs( process.argv );
	const url = args.url || 'http://localhost:8080/';
	const outDir = args.out || path.join( tmpdir(), 'wcs-hang' );
	const W = Number( args.w || 1440 );
	const H = Number( args.h || 900 );
	mkdirSync( outDir, { recursive: true } );

	const report = { url, viewport: [ W, H ], criteria: {} };

	// ---- 4 first: it needs no browser. ----
	try {

		report.criteria.c4 = await checkCodec();

	} catch ( err ) {

		report.criteria.c4 = { error: err.message };

	}

	const port = 9100 + Math.floor( process.pid % 3000 );
	const profile = mkdtempSync( path.join( tmpdir(), 'hang-profile-' ) );
	const chrome = spawn( chromeBinary(), [
		'--headless=new',
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profile}`,
		'--no-first-run', '--no-default-browser-check',
		'--disable-background-timer-throttling', '--disable-renderer-backgrounding',
		'--autoplay-policy=no-user-gesture-required', '--mute-audio',
		...( args.gpu
			? [ '--use-angle=gl-egl', '--use-gl=angle', '--enable-gpu', '--ignore-gpu-blocklist',
				'--enable-features=UseOzonePlatform', '--ozone-platform=headless' ]
			: [ '--use-angle=swiftshader', '--enable-unsafe-swiftshader' ] ),
		'--hide-scrollbars',
		`--window-size=${W},${H}`,
		'about:blank'
	], { stdio: 'ignore' } );

	let code = 0;

	try {

		const browser = await CDP.connect( await waitForEndpoint( port ) );
		const { targetId } = await browser.send( 'Target.createTarget', { url: 'about:blank' } );
		const { sessionId } = await browser.send( 'Target.attachToTarget', { targetId, flatten: true } );
		const S = ( m, p ) => browser.send( m, p, sessionId );

		const pageErrors = [];
		browser.on( ( msg ) => {

			if ( msg.method === 'Runtime.exceptionThrown' ) {

				pageErrors.push( msg.params.exceptionDetails.text + ' ' + ( msg.params.exceptionDetails.exception?.description || '' ) );

			}

		} );

		await S( 'Runtime.enable' );
		await S( 'Page.enable' );
		await S( 'Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false } );
		await S( 'Page.navigate', { url } );
		await sleep( 7000 );

		const evalIn = async ( expr ) => {

			const r = await S( 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true } );
			if ( r.exceptionDetails ) throw new Error( r.exceptionDetails.text + ' ' + ( r.exceptionDetails.exception?.description || '' ) );
			return r.result.value;

		};

		const read = () => evalIn( READ );

		const shot = async ( name ) => {

			const { data } = await S( 'Page.captureScreenshot', { format: 'png' } );
			const buf = Buffer.from( data, 'base64' );
			writeFileSync( path.join( outDir, name ), buf );
			return decodePNG( buf );

		};

		const mouse = async ( type, x, y, buttons ) => {

			await S( 'Input.dispatchMouseEvent', {
				type, x, y, button: type === 'mouseMoved' ? 'none' : 'left',
				buttons: buttons === undefined ? 0 : buttons,
				clickCount: type === 'mouseMoved' ? 0 : 1
			} );

		};

		// ---------------------------------------------------------------
		// 1. The drag.
		// ---------------------------------------------------------------

		const before = await read();
		const imgBefore = await shot( 'hang-1-before.png' );

		// A drag, in fractions of the viewport rather than in pixels.
		//
		// Written in pixels first, and it silently under-measured at 390 wide:
		// Chrome DROPS a synthesised mouse move whose coordinates fall outside the
		// viewport, so a fixed +30 px per step walked off the right edge after six
		// steps and the run reported a hang that had stopped moving because the
		// EVENTS stopped, not because the range did. The drag has to stay inside
		// the frame it is testing.
		const drag = async ( from, to ) => {

			const x0 = Math.round( W * from[ 0 ] ), y0 = Math.round( H * from[ 1 ] );
			const x1 = Math.round( W * to[ 0 ] ), y1 = Math.round( H * to[ 1 ] );
			await mouse( 'mousePressed', x0, y0, 1 );
			const steps = 24;
			for ( let i = 1; i <= steps; i ++ ) {

				await mouse( 'mouseMoved',
					Math.round( x0 + ( x1 - x0 ) * i / steps ),
					Math.round( y0 + ( y1 - y0 ) * i / steps ), 1 );
				await sleep( 16 );

			}

			await sleep( 150 );
			const mid = await read();
			await mouse( 'mouseReleased', x1, y1, 0 );
			await sleep( 400 );
			return mid;

		};

		// Corner to corner, because the drag is 1:1 WITH THE POINTER and a phone
		// in portrait shows a narrow strip of a 7 m plate: at 390 one whole screen
		// width is 0.218 of the photograph against a u range of 0.18, so anything
		// less than about 83 % of the width cannot cross the range even when the
		// range is working perfectly. Measured, not guessed - a 45 % sweep stopped
		// at 0.49 here and at 0.41 on the desktop, which is the viewport talking
		// and not the control.
		const during = await drag( [ 0.04, 0.12 ], [ 0.96, 0.88 ] );
		const after = await read();
		const imgAfter = await shot( 'hang-2-after-drag.png' );

		// And back the other way, past the low limits.
		await drag( [ 0.96, 0.88 ], [ 0.04, 0.12 ] );
		const afterBack = await read();
		await shot( 'hang-3-after-drag-back.png' );

		const cx = Math.round( W / 2 );
		const cy = Math.round( H * 0.42 );

		// And a bare click in the middle of the frame, which must move nothing:
		// count-clicks.mjs presses exactly here to unlock the audio.
		const beforeClick = ( await read() ).design;
		await mouse( 'mousePressed', cx, cy, 1 );
		await mouse( 'mouseReleased', cx, cy, 0 );
		await sleep( 300 );
		const afterClick = ( await read() ).design;

		report.criteria.c1 = {
			place: before.place,
			authoredRanges: before.placeRanges,
			liveLimits: { u: before.limits.u, v: before.limits.v, scale: before.limits.scale },
			hangBefore: before.design,
			hangDuringDrag: during.design,
			hangAfterDragRight: after.design,
			hangAfterDragLeft: afterBack.design,
			cropBefore: before.limits.crop,
			cropAfterRight: after.limits.crop,
			cropAfterLeft: afterBack.limits.crop,
			// The proof it stopped: the drag asked for far more than the range and
			// the design sits exactly on the limit. Against the SLIDER's own
			// travel, which hang.js rounds inward from plate.limits() - the two
			// have to be the same number or the drag and the slider would stop in
			// different places.
			reachOffered: {
				u: [ Number( before.ui.u.min ), Number( before.ui.u.max ) ],
				v: [ Number( before.ui.v.min ), Number( before.ui.v.max ) ],
				scale: [ Number( before.ui.scale.min ), Number( before.ui.scale.max ) ]
			},
			stoppedAtUHigh: after.design.u === Number( before.ui.u.max ),
			stoppedAtVHigh: after.design.v === Number( before.ui.v.max ),
			stoppedAtULow: afterBack.design.u === Number( before.ui.u.min ),
			stoppedAtVLow: afterBack.design.v === Number( before.ui.v.min ),
			// The proof it moved: the picture, not just the number. Rows above the
			// caption and the pill row only, which start at 780 of 900.
			pictureMeanDiff: meanDiff( imgBefore, imgAfter, Math.round( H * 0.86 ) ),
			clickMovesNothing: JSON.stringify( beforeClick ) === JSON.stringify( afterClick ),
			urlAfterDrag: after.search
		};

		// ---------------------------------------------------------------
		// 2. The physics, before and after, with the sim held still.
		// ---------------------------------------------------------------

		await evalIn( 'window.__wcs.applyDesign({hang:{u:0.50,v:0.40,scale:1.00}})' );
		await sleep( 400 );
		await evalIn( 'window.__wcs.pause()' );
		await sleep( 250 );

		const frozenA = ( await read() ).frozen;
		// A control reading: two snapshots with NOTHING done between them, so a
		// pass below cannot be an artefact of a sim that had already stopped
		// moving on its own.
		await sleep( 250 );
		const frozenIdle = ( await read() ).frozen;

		await evalIn( 'window.__wcs.applyDesign({hang:{u:0.57,v:0.55,scale:1.28}})' );
		await sleep( 250 );
		const frozenB = ( await read() ).frozen;
		const cropAfterPhysics = ( await read() ).limits.crop;

		await evalIn( 'window.__wcs.resume()' );

		const same = ( a, b ) => JSON.stringify( a ) === JSON.stringify( b );
		report.criteria.c2 = {
			idleControlIdentical: same( frozenA, frozenIdle ),
			tubeLengths: same( frozenA.tubeLengths, frozenB.tubeLengths ),
			tubeFreqs: same( frozenA.tubeFreqs, frozenB.tubeFreqs ),
			platePos: same( frozenA.plate, frozenB.plate ),
			clapperPos: same( frozenA.clapper, frozenB.clapper ),
			sailPos: same( frozenA.sail, frozenB.sail ),
			allIdentical: same( frozenA, frozenB ),
			before: frozenA,
			after: frozenB,
			// And the plate DID move, so this is not "nothing happened".
			cropMoved: JSON.stringify( cropAfterPhysics ) !== JSON.stringify( before.limits.crop )
		};

		// ---------------------------------------------------------------
		// 3. The camera distance, which is audio's distance gain.
		// ---------------------------------------------------------------

		const dist = {};
		for ( const s of [ 0.75, 1.0, 1.3, 1.45 ] ) {

			await evalIn( `window.__wcs.applyDesign({hang:{scale:${s}}})` );
			await sleep( 300 );
			const st = await read();
			dist[ String( s ) ] = {
				asked: s,
				inForce: st.design.scale,
				cameraDistance: st.camera.distance,
				cropHalfWidth: st.limits.crop[ 2 ]
			};

		}

		const values = Object.values( dist ).map( ( d ) => d.cameraDistance );
		report.criteria.c3 = {
			byScale: dist,
			identicalAcrossScale: values.every( ( v ) => v === values[ 0 ] ),
			// The contract names 1.45; ARBITRATION section 9 lowered forest-path's
			// own top to 1.30, so both are reported and the clamp is visible.
			scale145ClampsTo: dist[ '1.45' ].inForce,
			distanceAt075: dist[ '0.75' ].cameraDistance,
			distanceAt145: dist[ '1.45' ].cameraDistance
		};

		// ---------------------------------------------------------------
		// 1b. A bigger chime has less room, and the control says so.
		//
		// Not a criterion of its own; it is what criterion 1's "stops hard at
		// the range" means once the size is live, because the pan margin is what
		// the zoom is spent out of. A hang sitting at the old edge has to be
		// pulled in with it, or the URL promises a frame the plate will not draw.
		// ---------------------------------------------------------------

		await evalIn( 'window.__wcs.applyDesign({hang:{u:0.59,v:0.56,scale:0.75}})' );
		await sleep( 350 );
		const wide = await read();
		await evalIn( 'window.__wcs.applyDesign({hang:{scale:1.30}})' );
		await sleep( 350 );
		const tight = await read();

		report.criteria.c1b = {
			atScale075: { hang: wide.design, reach: { u: wide.ui.u.max, v: wide.ui.v.max } },
			atScale130: { hang: tight.design, reach: { u: tight.ui.u.max, v: tight.ui.v.max } },
			reachNarrowed: Number( tight.ui.u.max ) < Number( wide.ui.u.max ),
			// Not a gate, and false is a legitimate answer: a portrait window shows
			// a narrow strip of a 7 m plate, so it still has margin to spare at
			// 1.30 and there is nothing to pull in. On a 16:10 desktop it does not.
			note: Number( tight.ui.u.max ) < Number( wide.ui.u.max )
				? 'the zoom ate the pan margin and the hang was pulled in with it'
				: 'this viewport has margin left at 1.30, so nothing needed pulling in',
			// Across only. The plate is 7.0 m wide and 4.9 m tall against a frame
			// that is 5.12 x 3.20 at this viewport, so the vertical margin is the
			// bigger of the two and v is still reachable at its top when u is not.
			hangPulledIn: tight.design.u < wide.design.u,
			// The whole point: the design is never left describing a frame the
			// plate is silently refusing to draw.
			designInsideLimits: tight.design.u >= tight.limits.u[ 0 ] - 1e-9 && tight.design.u <= tight.limits.u[ 1 ] + 1e-9 &&
				tight.design.v >= tight.limits.v[ 0 ] - 1e-9 && tight.design.v <= tight.limits.v[ 1 ] + 1e-9,
			cropCentreFollows: tight.limits.crop[ 0 ] === tight.design.u && tight.limits.crop[ 1 ] === tight.design.v
		};

		// ---------------------------------------------------------------
		// 5. The porch.
		// ---------------------------------------------------------------

		await evalIn( 'window.__wcs.applyDesign({hang:{u:0.44,v:0.47,scale:1.10}})' );
		await sleep( 300 );
		const forestHang = ( await read() ).design;

		await evalIn( 'window.__wcs.applyDesign({place:"porch"})' );
		await sleep( 1200 );
		await shot( 'hang-4-porch.png' );

		// Read with the panel OPEN. A control inside a closed dialog has no box
		// to measure, and "present" is a question about the panel a visitor is
		// actually looking at - the panel is display:none when shut precisely so
		// its controls are out of the focus order (H21).
		await evalIn( 'document.getElementById("wcsPill-hang").click()' );
		await sleep( 700 );
		const porch = await read();
		await shot( 'hang-5-porch-panel.png' );
		await evalIn( 'document.getElementById("wcsPill-hang").click()' );
		await sleep( 300 );

		await evalIn( 'window.__wcs.applyDesign({place:"forest-path"})' );
		await sleep( 1200 );
		const backToForest = await read();

		report.criteria.c5 = {
			place: porch.place,
			authoredRanges: porch.placeRanges,
			controlsPresent: Object.values( porch.ui ).every( ( c ) => c && c.present && c.rendered ),
			controlsDisabled: Object.values( porch.ui ).every( ( c ) => c && c.disabled ),
			fieldsDimmed: Object.values( porch.ui ).every( ( c ) => c && c.fieldDimmed ),
			reason: porch.hint,
			reasonIsOneLine: !! ( porch.hint && porch.hint.length > 0 && porch.hint.indexOf( '\n' ) === -1 ),
			// Not merely in the DOM: inside the scroll box the visitor is looking
			// at, without scrolling.
			reasonVisibleWithoutScrolling: porch.reasonVisible,
			reasonReachableFromControls: Object.values( porch.ui ).every( ( c ) => c && c.describedBy === 'wcsHangHint' ),
			staticFallbackRetired: porch.whyHidden === true,
			// And the hang the visitor set in the forest is not destroyed by the
			// trip through a place that cannot use it.
			hangKeptThroughPorch: JSON.stringify( forestHang ) === JSON.stringify( backToForest.design ),
			forestHangBefore: forestHang,
			forestHangAfter: backToForest.design,
			forestControlsEnabled: Object.values( backToForest.ui ).every( ( c ) => c && ! c.disabled ),
			forestSliderTravel: {
				u: [ backToForest.ui.u.min, backToForest.ui.u.max ],
				v: [ backToForest.ui.v.min, backToForest.ui.v.max ],
				scale: [ backToForest.ui.scale.min, backToForest.ui.scale.max ]
			},
			forestReason: backToForest.hint
		};

		report.pageErrors = pageErrors;
		report.snapshotErrors = backToForest.errors;
		report.historyLength = backToForest.historyLength;
		report.shots = outDir;

	} catch ( err ) {

		report.error = err.message;
		code = 1;

	} finally {

		chrome.kill( 'SIGKILL' );

	}

	// ---- verdicts ----
	const c = report.criteria;
	const pass = {
		'1 drag moves and stops hard at the range': !! ( c.c1 && c.c1.stoppedAtUHigh && c.c1.stoppedAtVHigh &&
			c.c1.stoppedAtULow && c.c1.stoppedAtVLow && c.c1.pictureMeanDiff > 1 && c.c1.clickMovesNothing ),
		'2 physics bit-identical across a hang change': !! ( c.c2 && c.c2.allIdentical && c.c2.cropMoved ),
		'3 camera distance identical across hang.scale': !! ( c.c3 && c.c3.identicalAcrossScale ),
		'4 hang round-trips within 0.005': !! ( c.c4 && ! c.c4.error && c.c4.failures.length === 0 ),
		'5 porch: present, disabled, one-line reason': !! ( c.c5 && c.c5.controlsPresent && c.c5.controlsDisabled &&
			c.c5.fieldsDimmed && c.c5.reasonIsOneLine && c.c5.reasonVisibleWithoutScrolling &&
			c.c5.reasonReachableFromControls && c.c5.hangKeptThroughPorch )
	};
	report.pass = pass;
	report.allPassed = Object.values( pass ).every( Boolean ) &&
		( report.pageErrors || [] ).length === 0 &&
		( report.snapshotErrors || [] ).length === 0;

	console.log( JSON.stringify( report, null, 2 ) );
	process.exit( report.allPassed && code === 0 ? 0 : 1 );

}

main();
