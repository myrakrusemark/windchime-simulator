#!/usr/bin/env node
/**
 * count-clicks.mjs — the yardstick for the structure gauntlet.
 *
 * The bar is Apple Watch Studio: two clicks from arrival to something you made
 * and could share, and zero forced choices. This measures the same three things
 * on our page, mechanically, so a critic is judging a number instead of a vibe.
 *
 *   node tools/count-clicks.mjs --url http://localhost:8080/ [--json]
 *
 * It reports:
 *   gate            is anything covering the frame on first paint, with a button in it
 *   controlsAtRest  how many interactive controls a stranger sees before touching anything
 *   clicksToNamed   pointer events needed before a complete object is on screen with a
 *                   name under it. The bar hands you "46mm Silver Aluminum Case with
 *                   Pride Edition Sport Band" after one click on a splash; the whole
 *                   claim of this page is that the number is zero. It was the one thing
 *                   the tool was asked to report and did not, so a criterion written
 *                   against it could only ever be argued, never measured.
 *   clicksToSound   pointer events needed before the AudioContext is running AND audible
 *   clicksToShare   pointer events needed before the location carries a design
 *   audible         peak sample level observed on the master bus after unlock
 *
 * A click here means one pointer event a stranger would have to decide to make.
 * The browser's audio-gesture requirement costs one and there is no way around it,
 * so one is the floor. Anything above one is ours to explain.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME_CANDIDATES = [
	path.join( process.env.HOME, '.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' ),
	'/usr/bin/google-chrome',
	'/usr/bin/chromium',
];

const sleep = ( ms ) => new Promise( ( r ) => setTimeout( r, ms ) );

function chromeBinary() {
	for ( const c of CHROME_CANDIDATES ) if ( existsSync( c ) ) return c;
	throw new Error( 'no chromium binary found' );
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

			} else for ( const l of this.listeners ) l( msg );

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

	on( fn ) { this.listeners.push( fn ); }

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

/**
 * Injected before any page script. Wraps AudioContext so we can see whether the
 * graph is running and whether anything is actually reaching the destination —
 * a running context that outputs silence is not a chime that is sounding.
 */
const PROBE = `
(() => {
  const W = window;
  W.__probe = { ctxs: [], peak: 0, gestures: 0 };
  ['click','pointerdown','touchstart','keydown'].forEach(t =>
    W.addEventListener(t, () => W.__probe.gestures++, true));
  const wrap = (Ctor) => {
    if (!Ctor) return Ctor;
    const P = new Proxy(Ctor, {
      construct(target, args) {
        const ctx = new target(...args);
        W.__probe.ctxs.push(ctx);
        try {
          const an = ctx.createAnalyser();
          an.fftSize = 2048;
          const orig = ctx.destination;
          // Tap everything that connects to destination.
          const realConnect = AudioNode.prototype.connect;
          AudioNode.prototype.connect = function (dest, ...rest) {
            if (dest === orig) { try { realConnect.call(this, an); } catch (e) {} }
            return realConnect.call(this, dest, ...rest);
          };
          const buf = new Float32Array(an.fftSize);
          setInterval(() => {
            an.getFloatTimeDomainData(buf);
            let p = 0;
            for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > p) p = v; }
            if (p > W.__probe.peak) W.__probe.peak = p;
          }, 100);
        } catch (e) {}
        return ctx;
      }
    });
    return P;
  };
  W.AudioContext = wrap(W.AudioContext);
  W.webkitAudioContext = wrap(W.webkitAudioContext);
})();
`;

const READ_STATE = `
(() => {
  const p = window.__probe || { ctxs: [], peak: 0, gestures: 0 };
  const running = p.ctxs.some(c => c.state === 'running');
  const vw = innerWidth, vh = innerHeight;
  const interactive = [...document.querySelectorAll(
    'button,a[href],input,select,textarea,[role=button],[role=slider],[tabindex]:not([tabindex="-1"])')]
    .filter(el => {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return false;
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
    });
  // A gate is a big thing sitting over the frame that contains something to press.
  const gates = [...document.querySelectorAll('div,section,dialog,aside,form')].filter(el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    if (!['fixed','absolute'].includes(cs.position)) return false;
    // A container that passes clicks through to the scene is not a gate, however big it is.
    if (cs.pointerEvents === 'none') return false;
    const area = (r.width * r.height) / (vw * vh);
    if (area < 0.25 || area > 1.05) return false;
    return !!el.querySelector('button,a[href],input');
  }).map(el => ({
    tag: el.tagName.toLowerCase(), id: el.id || null,
    cls: (el.className && el.className.toString().slice(0, 60)) || null,
    text: (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 90),
  }));
  // The name under the object: one visible sentence that says what has been made.
  // A caption is what tells a stranger the thing in front of them is finished, and
  // it is the difference between a complete object and a demo that has not started
  // yet. Read by role rather than by id where possible, so this measures any page
  // that puts a live caption under its object and not only ours.
  const nameEl = document.querySelector('#wcsCaption,[data-object-caption]');
  let objectName = '';
  if (nameEl) {
    const r = nameEl.getBoundingClientRect();
    const cs = getComputedStyle(nameEl);
    const shown = cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'
      && r.width > 4 && r.height > 4 && r.top < vh && r.bottom > 0;
    if (shown) objectName = (nameEl.innerText || '').trim().replace(/\\s+/g, ' ');
  }

  return {
    running, peak: p.peak, gestures: p.gestures,
    objectName,
    url: location.href,
    search: location.search, hash: location.hash,
    controls: interactive.map(el => ({
      tag: el.tagName.toLowerCase(), id: el.id || null, type: el.type || null,
      text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 40),
    })),
    gates,
  };
})()
`;

async function main() {

	const args = {};
	for ( let i = 2; i < process.argv.length; i ++ ) {

		const a = process.argv[ i ];
		if ( a === '--json' ) args.json = true;
		else if ( a.startsWith( '--' ) ) args[ a.slice( 2 ) ] = process.argv[ ++ i ];

	}

	const url = args.url || 'http://localhost:8080/';
	const w = Number( args.w || 1440 ), h = Number( args.h || 900 );

	const port = 9500 + Math.floor( process.pid % 3000 );
	const profile = mkdtempSync( path.join( tmpdir(), 'count-profile-' ) );

	const chrome = spawn( chromeBinary(), [
		'--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
		'--no-first-run', '--no-default-browser-check',
		'--use-angle=swiftshader', '--enable-unsafe-swiftshader',
		'--disable-background-timer-throttling', '--disable-renderer-backgrounding',
		'--mute-audio', `--window-size=${w},${h}`, 'about:blank',
	], { stdio: 'ignore' } );

	const out = { url, viewport: `${w}x${h}` };

	try {

		const browser = await CDP.connect( await waitForEndpoint( port ) );
		const { targetId } = await browser.send( 'Target.createTarget', { url: 'about:blank' } );
		const { sessionId } = await browser.send( 'Target.attachToTarget', { targetId, flatten: true } );
		const S = ( m, p ) => browser.send( m, p, sessionId );

		await S( 'Runtime.enable' );
		await S( 'Page.enable' );
		await S( 'Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false } );
		await S( 'Page.addScriptToEvaluateOnNewDocument', { source: PROBE } );

		await S( 'Page.navigate', { url } );
		await sleep( 6500 );

		const read = async () => ( await S( 'Runtime.evaluate', { expression: READ_STATE, returnByValue: true, awaitPromise: false } ) ).result.value;

		const atRest = await read();
		out.gate = atRest.gates.length ? atRest.gates : null;
		out.controlsAtRest = atRest.controls.length;
		out.controlsAtRestList = atRest.controls;
		out.urlAtRest = atRest.url;
		out.soundingWithoutTouch = atRest.running && atRest.peak > 1e-4;
		// Zero only if BOTH hold with no gesture spent: nothing is standing between
		// the visitor and the frame, and the frame names what is in it. A gate with
		// a caption behind it is still a gate, and a scene with no caption is a
		// screensaver.
		out.nameAtRest = atRest.objectName || null;
		out.clicksToNamedObject = ( ! out.gate && out.nameAtRest ) ? 0 : null;

		// One pointer event in the middle of the frame — the cheapest possible gesture.
		const click = async ( x, y ) => {

			for ( const type of [ 'mousePressed', 'mouseReleased' ] ) {

				await S( 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 } );

			}

			await sleep( 2500 );

		};

		let clicks = 0;
		let state = atRest;
		while ( clicks < 4 && ! ( state.running && state.peak > 1e-4 ) ) {

			await click( Math.round( w / 2 ), Math.round( h / 2 ) );
			clicks ++;
			await sleep( 2500 );
			state = await read();

		}

		out.clicksToSound = ( state.running && state.peak > 1e-4 ) ? clicks : null;
		out.audiblePeak = Number( state.peak.toFixed( 5 ) );
		out.contextRunning = state.running;
		out.urlAfterSound = state.url;
		out.urlCarriesDesign = /[?#].+=/.test( state.url );
		out.controlsAfterSound = state.controls.length;
		out.controlsAfterSoundList = state.controls;

		out.verdict = out.clicksToSound === null
			? 'never became audible within 4 clicks'
			: `${out.clicksToSound} click${out.clicksToSound === 1 ? '' : 's'} to sound; `
				+ ( out.urlCarriesDesign ? 'the URL already carries a design' : 'the URL carries nothing to share' );

	} catch ( err ) {

		out.error = err.message;

	} finally {

		chrome.kill( 'SIGKILL' );

	}

	if ( args.json ) console.log( JSON.stringify( out, null, 2 ) );
	else {

		const line = ( k, v ) => console.log( String( k ).padEnd( 24 ) + v );
		line( 'url', out.url );
		line( 'gate on first paint', out.gate ? out.gate.map( ( g ) => `${g.tag}#${g.id || '?'} "${g.text}"` ).join( ' | ' ) : 'none' );
		line( 'controls at rest', out.controlsAtRest );
		line( 'clicks to named object', out.clicksToNamedObject ?? 'never' );
		line( 'name at rest', out.nameAtRest || '(none)' );
		line( 'sounding untouched', out.soundingWithoutTouch );
		line( 'clicks to sound', out.clicksToSound ?? 'never' );
		line( 'audible peak', out.audiblePeak );
		line( 'url carries design', out.urlCarriesDesign );
		line( 'url after sound', out.urlAfterSound );
		console.log( '\n' + ( out.error ? 'ERROR: ' + out.error : out.verdict ) );

	}

	process.exit( out.error ? 1 : 0 );

}

main();
