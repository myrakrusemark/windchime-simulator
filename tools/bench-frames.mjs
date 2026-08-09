#!/usr/bin/env node
/**
 * bench-frames.mjs — find out what is actually eating the frame.
 *
 * The first attempt at this measured four-second windows at one frame per
 * second, which is four samples, and produced numbers that disagreed with each
 * other in both directions. This runs long windows, tests one variable at a
 * time, and re-measures the baseline at the end so drift is visible rather than
 * silent.
 *
 *   node tools/bench-frames.mjs [--url http://localhost:8080/] [--window 10]
 *
 * Frame counts come from __wcs.snapshot().frames, which main.js increments once
 * per rendered frame, so this measures the page's real loop rather than a
 * requestAnimationFrame the harness installed.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sleep = ( ms ) => new Promise( ( r ) => setTimeout( r, ms ) );
const CHROME = path.join( process.env.HOME, '.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' );

function args() {

	const a = {};
	for ( let i = 2; i < process.argv.length; i ++ ) {

		const k = process.argv[ i ];
		if ( k.startsWith( '--' ) ) a[ k.slice( 2 ) ] = process.argv[ ++ i ];

	}

	return a;

}

class CDP {

	constructor( ws ) {

		this.ws = ws; this.id = 0; this.pend = new Map();
		ws.addEventListener( 'message', ( e ) => {

			const m = JSON.parse( e.data );
			if ( m.id === undefined ) return;
			const p = this.pend.get( m.id );
			if ( ! p ) return;
			this.pend.delete( m.id );
			m.error ? p.reject( new Error( m.error.message ) ) : p.resolve( m.result );

		} );

	}

	static async connect( url ) {

		const ws = new WebSocket( url );
		await new Promise( ( res, rej ) => {

			ws.addEventListener( 'open', res, { once: true } );
			ws.addEventListener( 'error', () => rej( new Error( 'ws' ) ), { once: true } );

		} );
		return new CDP( ws );

	}

	send( method, params = {}, sessionId ) {

		const id = ++ this.id;
		this.ws.send( JSON.stringify( sessionId ? { id, method, params, sessionId } : { id, method, params } ) );
		return new Promise( ( resolve, reject ) => this.pend.set( id, { resolve, reject } ) );

	}

}

/**
 * Each condition is a snippet that mutates the live page, plus a snippet that
 * puts it back. They are applied cumulatively in the order listed and undone in
 * reverse, so the last row is the baseline again and any gap between the first
 * and last row is drift rather than signal.
 */
const CONDITIONS = [
	{
		name: 'baseline',
		on: '1',
		off: '1',
	},
	{
		name: 'pixelRatio 1',
		on: `(() => { const r = __wcs.stage.renderer; window.__pr = r.getPixelRatio();
			r.setPixelRatio(1); r.setSize(innerWidth, innerHeight, false); return r.getPixelRatio(); })()`,
		off: `(() => { const r = __wcs.stage.renderer; r.setPixelRatio(window.__pr || 1);
			r.setSize(innerWidth, innerHeight, false); return 1; })()`,
	},
	{
		name: 'shadows off',
		on: `(() => { const r = __wcs.stage.renderer; r.shadowMap.enabled = false;
			__wcs.stage.scene.traverse(o => { if (o.isLight && o.shadow) o.castShadow = false; }); return 1; })()`,
		off: `(() => { const r = __wcs.stage.renderer; r.shadowMap.enabled = true;
			__wcs.stage.scene.traverse(o => { if (o.isDirectionalLight && o.shadow) o.castShadow = true; }); return 1; })()`,
	},
	{
		// Not `visible = false`. Spark's SparkRenderer draws the splats it has
		// accumulated, so hiding the mesh hides nothing - the first run of this
		// bench reported no change from hiding and that is why. Detach it.
		name: 'splat detached',
		on: `(() => { const sc = __wcs.stage.scene; const s = sc.getObjectByName('wcs-splat');
			window.__splat = s || null; if (s) sc.remove(s); return !!s; })()`,
		off: `(() => { if (window.__splat) __wcs.stage.scene.add(window.__splat); return 1; })()`,
	},
];

async function main() {

	const a = args();
	const url = a.url || 'http://localhost:8080/';
	const win = Number( a.window || 10 ) * 1000;
	const w = Number( a.w || 1440 ), h = Number( a.h || 900 );

	if ( ! existsSync( CHROME ) ) throw new Error( 'no chromium' );
	const port = 9800 + ( process.pid % 500 );
	const profile = mkdtempSync( path.join( tmpdir(), 'bench-' ) );
	const chrome = spawn( CHROME, [
		'--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
		'--no-first-run', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
		'--use-angle=gl-egl', '--use-gl=angle', '--enable-gpu', '--ignore-gpu-blocklist',
		'--ozone-platform=headless', '--disable-background-timer-throttling',
		'--disable-renderer-backgrounding', `--window-size=${w},${h}`, 'about:blank',
	], { stdio: 'ignore' } );

	try {

		let wsUrl;
		for ( let i = 0; i < 160; i ++ ) {

			try { const r = await fetch( `http://127.0.0.1:${port}/json/version` ); if ( r.ok ) { wsUrl = ( await r.json() ).webSocketDebuggerUrl; break; } } catch {}
			await sleep( 150 );

		}

		const b = await CDP.connect( wsUrl );
		const { targetId } = await b.send( 'Target.createTarget', { url: 'about:blank' } );
		const { sessionId } = await b.send( 'Target.attachToTarget', { targetId, flatten: true } );
		const S = ( m, p ) => b.send( m, p, sessionId );
		await S( 'Runtime.enable' ); await S( 'Page.enable' );
		await S( 'Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false } );
		await S( 'Page.navigate', { url } );

		const ev = async ( expr ) => {

			const r = await S( 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true } );
			if ( r.exceptionDetails ) throw new Error( r.exceptionDetails.text + ' :: ' + expr.slice( 0, 60 ) );
			return r.result.value;

		};

		// Wait for the page to have a loop AND for the capture to have landed,
		// so the first window is not measuring a download.
		for ( let i = 0; i < 120; i ++ ) {

			const ok = await ev( `!!(window.__wcs && __wcs.snapshot().frames > 3
				&& (!__wcs.stage.plate || !__wcs.stage.plate.loaded || __wcs.stage.plate.loaded()))` ).catch( () => false );
			if ( ok ) break;
			await sleep( 500 );

		}

		await sleep( 2000 );

		const measure = async () => {

			const a0 = await ev( 'JSON.stringify([__wcs.snapshot().frames, performance.now()])' );
			const [ f0, t0 ] = JSON.parse( a0 );
			await sleep( win );
			const a1 = await ev( 'JSON.stringify([__wcs.snapshot().frames, performance.now()])' );
			const [ f1, t1 ] = JSON.parse( a1 );
			return { fps: ( f1 - f0 ) / ( ( t1 - t0 ) / 1000 ), frames: f1 - f0 };

		};

		const rows = [];
		const applied = [];
		for ( const c of CONDITIONS ) {

			await ev( c.on );
			applied.push( c );
			await sleep( 1200 );
			const m = await measure();
			rows.push( { name: `+ ${c.name}`, ...m } );

		}

		// Unwind, so the last row is the first condition again.
		for ( let i = applied.length - 1; i >= 1; i -- ) await ev( applied[ i ].off );
		await sleep( 1500 );
		const back = await measure();
		rows.push( { name: 'baseline again', ...back } );

		const info = await ev( `JSON.stringify({
			splats: (() => { const s = __wcs.stage.scene.getObjectByName('wcs-splat'); return s && (s.numSplats || (s.packedSplats && s.packedSplats.numSplats)) || null; })(),
			dpr: devicePixelRatio, drawCalls: __wcs.stage.renderer.info.render.calls,
			tris: __wcs.stage.renderer.info.render.triangles,
			mode: __wcs.snapshot().mode
		})` );

		console.log( '\ncondition                     fps    frames' );
		console.log( '------------------------------------------' );
		for ( const r of rows ) console.log( r.name.padEnd( 28 ) + r.fps.toFixed( 2 ).padStart( 6 ) + String( r.frames ).padStart( 10 ) );
		console.log( '\ncontext: ' + info );
		console.log( '\nEach row is CUMULATIVE with the ones above it.' );

	} finally {

		chrome.kill( 'SIGKILL' );

	}

	process.exit( 0 );

}

main().catch( ( e ) => { console.error( 'bench failed:', e.message ); process.exit( 1 ); } );
