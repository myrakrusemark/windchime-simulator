#!/usr/bin/env node
/**
 * shot.mjs — screenshot a page with no npm dependencies.
 *
 * Drives a headless Chromium over CDP using Node's built-in WebSocket, so any
 * number of these can run at once without fighting over one browser. Each run
 * gets its own port and its own profile directory.
 *
 *   node tools/shot.mjs --url http://localhost:8080/ --out /tmp/a.png \
 *     --w 1440 --h 900 --wait 4000
 *
 * Options
 *   --url    page to load                     (required)
 *   --out    .png path to write               (required; a .jpg is written beside it)
 *   --w --h  viewport                         (default 1440x900)
 *   --dpr    device pixel ratio               (default 1)
 *   --mobile emulate a touch phone
 *   --wait   ms to settle after load          (default 3500)
 *   --js     JS to evaluate before the shot; may return a promise
 *   --click  text of a button/link to click before the shot (repeatable)
 *   --full   capture the whole scrolling page
 *   --log    also write console + page errors to <out>.log.txt
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME_CANDIDATES = [
	path.join( process.env.HOME, '.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' ),
	'/usr/bin/google-chrome',
	'/usr/bin/chromium-browser',
	'/usr/bin/chromium',
];

function chromeBinary() {
	for ( const c of CHROME_CANDIDATES ) if ( existsSync( c ) ) return c;
	throw new Error( 'no chromium binary found' );
}

function parseArgs( argv ) {
	const out = { clicks: [] };
	for ( let i = 2; i < argv.length; i ++ ) {
		const a = argv[ i ];
		if ( a === '--mobile' ) out.mobile = true;
		else if ( a === '--full' ) out.full = true;
		else if ( a === '--log' ) out.log = true;
		else if ( a === '--click' ) out.clicks.push( argv[ ++ i ] );
		else if ( a.startsWith( '--' ) ) out[ a.slice( 2 ) ] = argv[ ++ i ];
	}
	return out;
}

const sleep = ( ms ) => new Promise( ( r ) => setTimeout( r, ms ) );

/** Minimal CDP client over the browser-level WebSocket endpoint. */
class CDP {

	constructor( ws ) {

		this.ws = ws;
		this.id = 0;
		this.pending = new Map();
		this.listeners = [];
		ws.addEventListener( 'message', ( ev ) => {

			const msg = JSON.parse( ev.data );
			if ( msg.id !== undefined ) {

				const p = this.pending.get( msg.id );
				if ( ! p ) return;
				this.pending.delete( msg.id );
				if ( msg.error ) p.reject( new Error( msg.error.message ) );
				else p.resolve( msg.result );

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
		const payload = { id, method, params };
		if ( sessionId ) payload.sessionId = sessionId;
		this.ws.send( JSON.stringify( payload ) );
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

async function main() {

	const args = parseArgs( process.argv );
	if ( ! args.url || ! args.out ) {

		console.error( 'usage: shot.mjs --url <url> --out <file.png> [--w 1440] [--h 900]' );
		process.exit( 2 );

	}

	const w = Number( args.w || 1440 );
	const h = Number( args.h || 900 );
	const dpr = Number( args.dpr || 1 );
	const wait = Number( args.wait ?? 3500 );

	mkdirSync( path.dirname( path.resolve( args.out ) ), { recursive: true } );

	const port = 9500 + Math.floor( process.pid % 3000 );
	const profile = mkdtempSync( path.join( tmpdir(), 'shot-profile-' ) );

	const chrome = spawn( chromeBinary(), [
		'--headless=new',
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profile}`,
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-background-timer-throttling',
		'--disable-renderer-backgrounding',
		'--autoplay-policy=no-user-gesture-required',
		'--use-angle=swiftshader',
		'--enable-unsafe-swiftshader',
		'--hide-scrollbars',
		'--force-device-scale-factor=' + dpr,
		`--window-size=${w},${h}`,
		'about:blank',
	], { stdio: 'ignore' } );

	const logLines = [];
	let code = 0;

	try {

		const wsUrl = await waitForEndpoint( port );
		const browser = await CDP.connect( wsUrl );

		const { targetId } = await browser.send( 'Target.createTarget', { url: 'about:blank' } );
		const { sessionId } = await browser.send( 'Target.attachToTarget', { targetId, flatten: true } );
		const S = ( m, p ) => browser.send( m, p, sessionId );

		browser.on( ( msg ) => {

			if ( msg.method === 'Runtime.consoleAPICalled' ) {

				const text = ( msg.params.args || [] ).map( ( a ) => a.value ?? a.description ?? a.type ).join( ' ' );
				logLines.push( `[${msg.params.type}] ${text}` );

			} else if ( msg.method === 'Runtime.exceptionThrown' ) {

				const d = msg.params.exceptionDetails;
				logLines.push( `[error] ${d.text} ${d.exception?.description || ''}` );

			}

		} );

		await S( 'Runtime.enable' );
		await S( 'Page.enable' );
		await S( 'Emulation.setDeviceMetricsOverride', {
			width: w, height: h, deviceScaleFactor: dpr, mobile: !! args.mobile,
		} );
		if ( args.mobile ) await S( 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 } );

		const loaded = new Promise( ( res ) => {

			const off = ( msg ) => { if ( msg.method === 'Page.loadEventFired' ) res(); };
			browser.on( off );
			setTimeout( res, 30000 );

		} );
		await S( 'Page.navigate', { url: args.url } );
		await loaded;
		await sleep( wait );

		for ( const text of args.clicks ) {

			await S( 'Runtime.evaluate', {
				expression: `(() => { const t = ${JSON.stringify( text )}.toLowerCase();
					const el = [...document.querySelectorAll('button,a,[role=button],label')]
						.find(e => (e.textContent||'').trim().toLowerCase() === t)
						|| [...document.querySelectorAll('button,a,[role=button],label')]
						.find(e => (e.textContent||'').trim().toLowerCase().includes(t));
					if (el) el.click(); return !!el; })()`,
				awaitPromise: false, returnByValue: true,
			} );
			await sleep( 1200 );

		}

		if ( args.js ) {

			await S( 'Runtime.evaluate', {
				expression: `(async () => { ${args.js} })()`,
				awaitPromise: true, returnByValue: true,
			} );
			await sleep( 600 );

		}

		const shotParams = { format: 'png', captureBeyondViewport: !! args.full };
		if ( args.full ) {

			const m = await S( 'Page.getLayoutMetrics' );
			const cs = m.cssContentSize || m.contentSize;
			shotParams.clip = { x: 0, y: 0, width: cs.width, height: Math.min( cs.height, 20000 ), scale: 1 };

		}

		const { data } = await S( 'Page.captureScreenshot', shotParams );
		writeFileSync( path.resolve( args.out ), Buffer.from( data, 'base64' ) );

		if ( args.log ) writeFileSync( path.resolve( args.out ) + '.log.txt', logLines.join( '\n' ) + '\n' );

		console.log( path.resolve( args.out ) );

	} catch ( err ) {

		console.error( 'shot failed:', err.message );
		if ( logLines.length ) console.error( logLines.slice( - 40 ).join( '\n' ) );
		code = 1;

	} finally {

		chrome.kill( 'SIGKILL' );

	}

	process.exit( code );

}

main();
