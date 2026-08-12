/**
 * ui/slots.js - the builder shell.
 *
 * A row of pills along the bottom of the frame naming the PARTS of the object -
 * Place, Tubes, Striker, Sail, Hang. Pressing one opens a panel over the bottom
 * third while the chime keeps swinging and sounding behind it. Every change
 * takes effect on the object as it is made, and one sentence under the object
 * says what has been made.
 *
 * WHAT THIS FILE IS ALLOWED TO TOUCH
 *
 * Exactly one thing: window.__wcs. It never reaches for params, the rig, the
 * wind or audio, it never rebuilds anything itself, and it never reloads the
 * page. The control it replaces - the Look picker - did a window.location.assign
 * on every change, which threw the visitor's entire chime away mid-build
 * (CONTRACTS H6). Nothing here navigates.
 *
 * WHERE THE NUMBERS COME FROM
 *
 * Every slider's travel is set from design.js's RANGES and every choice group's
 * options from design.js's own tables, so a limit is never typed twice and a
 * fourth clamp cannot drift away from the other three (CONTRACTS H32). The two
 * ranges design.js does not own - the sun, whose legal elevation is
 * place-dependent, and the compass, which wraps rather than clamps - come from
 * stage.sunRange() and from the markup respectively, both noted where they are
 * read.
 *
 * THE THREE HAZARDS THIS FILE HANDLES BY HAND
 *
 *   H8   applyParts() in main.js coalesces a slider drag at 80 ms because a rig
 *        rebuild per input event is unaffordable. Any control whose change
 *        rebuilds the rig - the part sliders and the tube count - is deferred
 *        here by the same 80 ms, and its readout still follows the pointer.
 *        Everything else applies on the event.
 *
 *   H20  goIdle() in main.js keys "a mode is open" off the settings drawer's
 *        class list, and the drawer is deleted. Nothing the shell draws sits in
 *        an .idle selector, so a panel cannot dissolve while it is being read;
 *        on top of that, an open panel keeps the HUD awake through the one seam
 *        main.js exposes - the window pointermove listener that markInteraction
 *        is bound to.
 *
 *   H21  the drawer this replaces was off-canvas by transform only, so all
 *        sixteen of its controls stayed reachable by Tab while it was shut. A
 *        closed panel here carries the `hidden` attribute and is display:none,
 *        which takes its whole subtree out of the focus order.
 */

import { RANGES, SCALE_KEYS, STOCK_NAMES, describe } from '../design.js';
import { DECAY_NOMINAL, stockFor } from '../modal.js';

// ---------------------------------------------------------------------------
// Labels.
//
// design.js keeps its own display names for the caption and does not export
// them, and these are shorter anyway: every scale here is in C, so the chips do
// not repeat the letter eight times. If a scale is added to design.js and not
// here, the chip falls back to the raw key rather than disappearing.
// ---------------------------------------------------------------------------

const SCALE_LABEL = {
	cMajorPentatonic: 'Major pentatonic',
	cMinorPentatonic: 'Minor pentatonic',
	cMajorDiatonic: 'Major',
	cNaturalMinor: 'Natural minor',
	cLydian: 'Lydian',
	cMixolydian: 'Mixolydian',
	cWholeTone: 'Whole tone',
	cOctaveIntervals: 'Octaves'
};

const QUALITY_LABEL = { auto: 'Auto', high: 'High', low: 'Low' };

const COMPASS_16 = [ 'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
	'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW' ];

// The option lists, resolved once. Each is [value, label].
const OPTION_SETS = {
	scale: SCALE_KEYS.map( ( k ) => [ k, SCALE_LABEL[ k ] || k ] ),
	stock: STOCK_NAMES.map( ( n ) => [ n, n ] ),
	quality: [ 'auto', 'high', 'low' ].map( ( q ) => [ q, QUALITY_LABEL[ q ] ] )
};

// ---------------------------------------------------------------------------
// Formatting. One function per data-fmt, all total.
// ---------------------------------------------------------------------------

const round = Math.round;

const FORMAT = {
	mph: ( v ) => round( v ) + ' mph',
	bearing: ( v ) => {

		const d = ( ( round( v ) % 360 ) + 360 ) % 360;
		return COMPASS_16[ round( d / 22.5 ) % 16 ] + ' ' + d + '°';

	},
	deg: ( v ) => round( v ) + '°',
	ratio2: ( v ) => v.toFixed( 2 ),
	tubes: ( v ) => round( v ) + ( round( v ) === 1 ? ' tube' : ' tubes' ),
	mm: ( v ) => round( v * 1000 ) + ' mm',
	cm: ( v ) => round( v * 100 ) + ' cm',
	g: ( v ) => round( v * 1000 ) + ' g',
	ms: ( v ) => ( v * 1000 ).toFixed( 1 ) + ' ms',
	// Not a T60 any more: modal.js computes the ring time from the tube's own
	// radiation and its cord, and this multiplies the result. DECAY_NOMINAL is
	// where it multiplies by one, and that position is called out by name so a
	// visitor who has dragged it can find their way back.
	ring: ( v ) => {

		const x = v / DECAY_NOMINAL;
		return x.toFixed( 2 ) + '×' + ( Math.abs( x - 1 ) < 5e-3 ? ' (as built)' : '' );

	},
	pct: ( v ) => round( v * 100 ) + '%',
	// A percentage of the FIELD'S OWN TOP rather than of one, for a field whose
	// stored unit is a fraction of something the visitor never sees. view.splats
	// is a fraction of tanha's 998,709 gaussians and stops at 0.35, because 0.35
	// is the whole of the export this page ships - there is no more detail to
	// have. Printed as "35%" it looked like a slider that quit early. `max` is
	// the top of the RANGES entry the control already names in data-range, so
	// this cannot drift from the travel it is describing.
	pctmax: ( v, max ) => round( ( v / ( max > 0 ? max : 1 ) ) * 100 ) + '%'
};

// The denominator for pctmax, read off the same data-range the slider's travel
// came from. Every other formatter ignores it.
function scaleFor( el ) {

	const key = el && el.dataset ? el.dataset.range : null;
	const r = key ? RANGES[ key ] : null;
	return r ? r[ 1 ] : 1;

}

function format( kind, value, el ) {

	const fn = FORMAT[ kind ];
	if ( typeof fn !== 'function' || ! Number.isFinite( value ) ) return '';
	return fn( value, scaleFor( el ) );

}

// ---------------------------------------------------------------------------
// Path helpers. A control names its field as 'clapper.width'; the design is a
// nested object and applyDesign takes a nested partial.
// ---------------------------------------------------------------------------

function readPath( obj, path ) {

	let cur = obj;
	for ( const key of path.split( '.' ) ) {

		if ( cur === null || typeof cur !== 'object' ) return undefined;
		cur = cur[ key ];

	}

	return cur;

}

function writePath( obj, path, value ) {

	const keys = path.split( '.' );
	let cur = obj;
	for ( let i = 0; i < keys.length - 1; i ++ ) {

		const k = keys[ i ];
		if ( cur[ k ] === undefined || cur[ k ] === null || typeof cur[ k ] !== 'object' ) cur[ k ] = {};
		cur = cur[ k ];

	}

	cur[ keys[ keys.length - 1 ] ] = value;
	return obj;

}

// The fields whose change rebuilds the rig. This list has to be apply.js's
// needsRebuild exactly, and the reason those controls are deferred rather than
// applied on the event (H8). Everything else - the voice, the sun, the wind, the
// hang, the stock - is a push or a copy and costs nothing.
//
// tubes.scale is in the list. It was missed the first time, and the miss was not
// theoretical: six ArrowRight presses on the Scale chips 30 ms apart produced six
// un-coalesced rebuildChime() + audio.setTubes() calls in about 250 ms, and
// setTubes resets every per-tube contact tracker each time (H10). It is here
// rather than imported because apply.js exports the applier, not the predicate;
// if a third field is ever added to needsRebuild, it belongs in both or in
// neither, and there is a test in tools/verify.mjs's sights either way.
const HEAVY_PATHS = new Set( [ 'tubes.notes', 'tubes.scale' ] );

function isHeavy( path ) {

	return HEAVY_PATHS.has( path ) ||
		path.indexOf( 'clapper.' ) === 0 ||
		path.indexOf( 'sail.' ) === 0;

}

// The four fields where null is a real value meaning "the place decides".
const NULLABLE = new Set( [ 'wind.mph', 'wind.dirDeg', 'wind.turbulence', 'view.sun' ] );

/**
 * What a screen reader says when the thumb moves.
 *
 * Without this, a slider announces its raw SI number - the Striker's width read
 * "0.06800000369548798" while the screen said "68 mm", the attack read "0.002"
 * against "2.0 ms", and the ring trim read "8" against "1.00x (as built)". The
 * page had already computed the human string; it was just not telling anybody
 * who could not see it.
 *
 * The other half of the same fix is in the markup: <label for> now wraps the
 * field NAME only, not the whole row, so the accessible name is the stable
 * "Across" instead of "Across 68 mm" - a name that changed on every arrow-key
 * press, which is the one thing a name may never do.
 *
 * Together: "Across, slider, 68 mm", not "Across 68 mm, slider, 0.07".
 */
function setValueText( el, text ) {

	if ( typeof text !== 'string' || text === '' ) el.removeAttribute( 'aria-valuetext' );
	else if ( el.getAttribute( 'aria-valuetext' ) !== text ) el.setAttribute( 'aria-valuetext', text );

}

// ---------------------------------------------------------------------------
// mountSlots
// ---------------------------------------------------------------------------

/**
 * @param {object} wcs   window.__wcs. design(), applyDesign(), onDesign(),
 *                       stage, and later snapshot(). Every member is optional so
 *                       a half-built page degrades instead of throwing.
 * @param {function} [noteError] main.js's error sink, (tag, err) => void.
 * @returns {object|null} a small handle for tools and for the pieces that follow
 *                        - { open, close, panelFor, refresh } - or null if the
 *                        markup is not on the page.
 */
export function mountSlots( wcs, noteError ) {

	const note = typeof noteError === 'function' ? noteError : () => {};

	// A mount must not throw and must not await (CONTRACTS 2.3). main.js gets one
	// line in its marker block and cannot wrap us, so the guard lives here: a
	// builder shell that fails to build costs the visitor its controls and
	// nothing else. The chime keeps swinging and the loop keeps running.
	try {

		return build( wcs, note );

	} catch ( err ) {

		note( 'slots-mount-failed', err );
		return null;

	}

}

function build( wcs, note ) {

	const root = document.getElementById( 'wcsSlots' );
	const caption = document.getElementById( 'wcsCaption' );
	const pillRow = document.getElementById( 'wcsPills' );
	const host = document.getElementById( 'wcsPanelHost' );
	if ( ! root || ! pillRow || ! host ) return null;

	const api = wcs && typeof wcs === 'object' ? wcs : {};
	const design = () => {

		try {

			return typeof api.design === 'function' ? api.design() : {};

		} catch ( err ) {

			note( 'slots-design-read-failed', err );
			return {};

		}

	};

	const apply = ( partial ) => {

		try {

			if ( typeof api.applyDesign === 'function' ) api.applyDesign( partial );

		} catch ( err ) {

			note( 'slots-apply-failed', err );

		}

	};

	const pills = Array.from( pillRow.querySelectorAll( '.wcs-pill' ) );
	const panels = new Map();
	for ( const el of host.querySelectorAll( '.wcs-panel' ) ) panels.set( el.dataset.slot, el );

	const ranges = Array.from( host.querySelectorAll( 'input[type="range"][data-path]' ) );
	const choices = Array.from( host.querySelectorAll( '.wcs-choice[data-path]' ) );

	// -----------------------------------------------------------------------
	// Slider travel, from the authority on each value rather than from a number
	// typed into the markup.
	// -----------------------------------------------------------------------

	for ( const el of ranges ) {

		const key = el.dataset.range;
		const r = key ? RANGES[ key ] : null;
		if ( r ) {

			el.min = String( r[ 0 ] );
			el.max = String( r[ 1 ] );

		}

	}

	// The sun is the exception: its legal elevation is place-dependent - 2 to 20
	// with a sky above the scene and 26 to 74 without - so the range comes from
	// the stage that is actually up, not from a constant (CONTRACTS H12).
	function sunRange() {

		try {

			const st = api.stage;
			if ( st && typeof st.sunRange === 'function' ) {

				const r = st.sunRange();
				if ( Array.isArray( r ) && r.length === 2 && Number.isFinite( r[ 0 ] ) && Number.isFinite( r[ 1 ] ) ) return r;

			}

		} catch ( err ) { /* fall through to the design's own superset */ }

		return RANGES[ 'view.sun' ];

	}

	function sunNow() {

		try {

			const st = api.stage;
			if ( st && typeof st.sunElevation === 'function' ) {

				const v = st.sunElevation();
				if ( Number.isFinite( v ) ) return v;

			}

		} catch ( err ) { /* fall through */ }

		return sunRange()[ 0 ];

	}

	function liveWind() {

		try {

			if ( typeof api.snapshot === 'function' ) {

				const s = api.snapshot();
				if ( s && s.wind ) return s.wind;

			}

		} catch ( err ) { /* the snapshot is installed later in main.js than we mount */ }

		return null;

	}

	// What a nullable slider should SHOW while the design is still deferring to
	// the place. The design itself stays null - moving the slider is what makes
	// it explicit - so this only ever feeds the thumb position and the readout.
	function inherited( path ) {

		const w = liveWind();
		if ( path === 'wind.mph' ) return w ? w.speedMph : 12;
		if ( path === 'wind.dirDeg' ) return w ? w.dirDeg : 270;
		if ( path === 'wind.turbulence' ) return 0.30;
		if ( path === 'view.sun' ) return sunNow();
		return 0;

	}

	// -----------------------------------------------------------------------
	// Choice groups. role=radiogroup with a roving tabindex, so a group is one
	// Tab stop and the arrow keys move inside it.
	// -----------------------------------------------------------------------

	// The picker names an instrument; this gives the two numbers that name
	// actually stands for, in the units a hardware shop sells pipe in. It goes
	// through modal.js's stockFor rather than reading CATALOGUE directly, because
	// three of the seven rows publish no wall thickness at all and stockFor is
	// what solves those from the maker's own length and key. It throws on a name
	// it does not know, which for a chip label is a missing line and not a
	// failure.
	function stockLine( name ) {

		try {

			const s = stockFor( name );
			const mm = ( m ) => ( Math.round( m * 10000 ) / 10 ).toFixed( 1 );
			return mm( s.od ) + ' mm across, ' + mm( 0.5 * ( s.od - s.id ) ) + ' mm wall';

		} catch ( err ) {

			return '';

		}

	}

	for ( const group of choices ) {

		const path = group.dataset.path;
		const options = OPTION_SETS[ group.dataset.options ] || [];
		group.textContent = '';

		for ( const [ value, label ] of options ) {

			const b = document.createElement( 'button' );
			b.type = 'button';
			b.className = 'wcs-choice-option';
			b.setAttribute( 'role', 'radio' );
			b.setAttribute( 'aria-checked', 'false' );
			b.tabIndex = - 1;
			b.dataset.value = value;
			b.textContent = label;
			b.addEventListener( 'click', () => {

				applyOrDefer( path, value );

			} );
			group.appendChild( b );

		}

		group.addEventListener( 'keydown', ( e ) => {

			const keys = [ 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End' ];
			if ( keys.indexOf( e.key ) === - 1 ) return;
			const items = Array.from( group.children );
			if ( items.length === 0 ) return;
			const at = items.indexOf( document.activeElement );
			let next;
			if ( e.key === 'Home' ) next = 0;
			else if ( e.key === 'End' ) next = items.length - 1;
			else if ( e.key === 'ArrowRight' || e.key === 'ArrowDown' ) next = ( at + 1 + items.length ) % items.length;
			else next = ( at - 1 + items.length ) % items.length;
			e.preventDefault();
			items[ next ].focus();
			// Held down, an arrow key repeats at the OS rate - about 30 a second
			// on a default Linux desktop - and Scale is a rig rebuild. Through the
			// same 80 ms coalescer as the sliders, so a held key costs one rebuild
			// rather than thirty (H8, H10).
			applyOrDefer( path, items[ next ].dataset.value );

		} );

	}

	// -----------------------------------------------------------------------
	// Ranges. The heavy ones coalesce at 80 ms, the rest apply on the event.
	// -----------------------------------------------------------------------

	let pending = null;
	let pendingTimer = 0;

	function flush() {

		clearTimeout( pendingTimer );
		pendingTimer = 0;
		const p = pending;
		pending = null;
		if ( p ) apply( p );

	}

	function defer( partial ) {

		pending = pending || {};
		// One level per section is all a design partial ever needs.
		for ( const section of Object.keys( partial ) ) {

			const v = partial[ section ];
			if ( v !== null && typeof v === 'object' ) {

				pending[ section ] = Object.assign( pending[ section ] || {}, v );

			} else {

				pending[ section ] = v;

			}

		}

		clearTimeout( pendingTimer );
		pendingTimer = setTimeout( flush, 80 );

	}

	/** One door for every control: coalesced if the field rebuilds the rig. */
	function applyOrDefer( path, value ) {

		const partial = writePath( {}, path, value );
		if ( isHeavy( path ) ) defer( partial ); else apply( partial );

	}

	for ( const el of ranges ) {

		const path = el.dataset.path;
		const fmt = el.dataset.fmt;
		const out = host.querySelector( '[data-value-for="' + el.id + '"]' );

		el.addEventListener( 'input', () => {

			const v = parseFloat( el.value );
			if ( ! Number.isFinite( v ) ) return;
			// The readout follows the pointer even where the apply is coalesced,
			// and so does what a screen reader is told. Both come from the same
			// format() call, so the number in the ear and the number on the screen
			// cannot drift.
			const text = format( fmt, v, el );
			if ( out ) {

				out.textContent = text;
				out.classList.remove( 'is-inherited' );

			}

			setValueText( el, text );
			applyOrDefer( path, v );

		} );

		// A drag that ends inside the debounce window must not be left hanging.
		el.addEventListener( 'change', flush );

	}

	// -----------------------------------------------------------------------
	// Render: the design in, the controls and the caption out.
	// -----------------------------------------------------------------------

	function render( d ) {

		const live = ( d !== null && typeof d === 'object' ) ? d : {};

		if ( caption ) {

			const line = describe( live );
			if ( caption.textContent !== line ) caption.textContent = line;

		}

		const sr = sunRange();

		for ( const el of ranges ) {

			const path = el.dataset.path;
			const raw = readPath( live, path );
			const isNull = raw === null || raw === undefined;
			const v = isNull ? inherited( path ) : raw;
			if ( ! Number.isFinite( v ) ) continue;

			if ( path === 'view.sun' ) {

				el.min = String( sr[ 0 ] );
				el.max = String( sr[ 1 ] );

			}

			// Comparing before writing means a thumb being dragged is never
			// nudged, while a value the physics clamped still snaps back.
			const s = String( v );
			if ( el.value !== s ) el.value = s;

			const text = format( el.dataset.fmt, v, el ) + ( isNull && NULLABLE.has( path ) ? ' (this place)' : '' );
			setValueText( el, text );

			const out = host.querySelector( '[data-value-for="' + el.id + '"]' );
			if ( out ) {

				if ( out.textContent !== text ) out.textContent = text;
				out.classList.toggle( 'is-inherited', isNull );

			}

		}

		for ( const group of choices ) {

			const value = readPath( live, group.dataset.path );
			let checked = null;
			for ( const b of group.children ) {

				const on = b.dataset.value === value;
				b.setAttribute( 'aria-checked', on ? 'true' : 'false' );
				b.tabIndex = on ? 0 : - 1;
				if ( on ) checked = b;

			}

			// Nothing matched - a place or a stock this build does not know. The
			// group must still be reachable by Tab, so the first chip takes the
			// stop rather than the group becoming a dead end.
			if ( ! checked && group.firstElementChild ) group.firstElementChild.tabIndex = 0;

		}

		const stockNote = host.querySelector( '[data-stock-note]' );
		if ( stockNote ) {

			const line = stockLine( readPath( live, 'tubes.stock' ) );
			if ( stockNote.textContent !== line ) stockNote.textContent = line;

		}

	}

	// -----------------------------------------------------------------------
	// Open and close.
	// -----------------------------------------------------------------------

	let openSlot = null;
	let awakeTimer = 0;
	let armTimer = 0;

	// Matched to --wcs-t-slow, the panel's own opening transition: the panel
	// starts taking input at the moment it has finished arriving.
	const ARM_MS = 300;

	// H20. goIdle() reads the settings drawer's class list as its only "a mode is
	// open" signal, and the drawer is gone. The one seam main.js leaves is the
	// window pointermove listener markInteraction is bound to, so an open panel
	// pokes it twice a second. That is two synthetic events per second against a
	// simulation already running sixty frames, and it is the difference between
	// a visitor reading a picker and a visitor watching it dissolve.
	function keepAwake() {

		try {

			const ev = new PointerEvent( 'pointermove', { bubbles: false } );
			// Tagged, so a listener added later can tell a forged gesture from a
			// visitor. main.js's markInteraction is the only window pointermove
			// listener today and does not care, but anything that starts counting
			// real input would otherwise inherit two phantom moves a second with no
			// way to see they are ours. The honest fix is a real
			// __wcs.setModeOpen(bool) that goIdle reads; this is the marker until
			// P1 can be asked for one.
			ev.__wcsSynthetic = true;
			window.dispatchEvent( ev );

		} catch ( err ) {

			// PointerEvent is constructible everywhere this page runs; if it ever
			// is not, the only cost is the fade, so this must not be fatal.

		}

	}

	function startAwake() {

		keepAwake();
		clearInterval( awakeTimer );
		awakeTimer = setInterval( keepAwake, 500 );

	}

	function stopAwake() {

		clearInterval( awakeTimer );
		awakeTimer = 0;

	}

	function focusablesIn( panel ) {

		const sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
		return Array.from( panel.querySelectorAll( sel ) )
			.filter( ( el ) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement );

	}

	// -----------------------------------------------------------------------
	// The modal half.
	//
	// The panels shipped as role="dialog" with a hard Tab trap and nothing else:
	// no aria-modal, nothing inert outside them, and no pointer behaviour at all.
	// That is neither of the two patterns ARIA defines. Measured, it meant a
	// mouse visitor could orbit the scene and press the pills while a keyboard
	// visitor was locked inside the dialog, and a screen-reader user browsing the
	// page outside it was yanked back by the next Tab.
	//
	// Of the two ways out, this is the modal one, because CONTRACTS P3 criterion
	// 4 requires role="dialog", a focus trap and Escape - so the trap stays and
	// the rest of the pattern is completed around it:
	//
	//   aria-modal="true"   on the panel (in the markup).
	//   inert               on everything outside it, so Tab and the screen
	//                       reader's own browse mode agree with the trap instead
	//                       of fighting it.
	//   light dismiss       a press outside the panel closes it, which is the
	//                       half that makes the trap survivable with a mouse.
	//
	// THREE THINGS ARE DELIBERATELY NOT INERT, and each one was measured before
	// it was let off:
	//
	//   the canvas    holds nothing focusable and nothing an assistive technology
	//                 reads, and `inert` removes a subtree from HIT TESTING as
	//                 well as from focus - which would break main.js's
	//                 capture-phase unlock listener, the one thing on the page
	//                 that must accept a gesture from anywhere. The chime keeps
	//                 swinging and sounding behind the panel, which is what
	//                 CONTRACTS section 1 asks for.
	//
	//   the pill row  is the dialog's own tab strip, not the page behind it.
	//                 Inerting it was tried first and elementFromPoint at the
	//                 pill's own centre came back `glCanvas`: the row went out of
	//                 hit testing, so pressing Sail while Tubes was open did
	//                 nothing at all and the only way between two parts was to
	//                 close and reopen. A modal whose own switcher is dead is not
	//                 a stricter modal, it is a broken one.
	//
	//   the caption   is the live region that says what the control you just
	//                 moved did. aria-live inside an aria-hidden subtree is not
	//                 announced, so inerting it would have silently deleted the
	//                 only feedback a screen-reader user gets from the panel.
	//
	// Everything else - the article, the top bar with Share in it, the status
	// line and the unlock line - goes inert, which is what makes the Tab trap
	// agree with browse mode instead of fighting it.
	// -----------------------------------------------------------------------

	const OUTSIDE = [ '#article', '.hud-top', '#audioToast', '#statusLine' ];

	function setOutsideInert( on ) {

		for ( const sel of OUTSIDE ) {

			for ( const el of document.querySelectorAll( sel ) ) {

				try {

					// Both, and in this order. `inert` is the real mechanism and is
					// what removes the subtree from the focus order and the
					// accessibility tree; aria-hidden is the fallback for a browser
					// too old to know the property, where it at least stops the
					// content being narrated. Setting aria-hidden on a subtree that
					// is ALSO inert cannot trap focus behind it, which is the usual
					// reason not to use it.
					if ( on ) el.setAttribute( 'inert', '' ); else el.removeAttribute( 'inert' );
					if ( on ) el.setAttribute( 'aria-hidden', 'true' ); else el.removeAttribute( 'aria-hidden' );

				} catch ( err ) { /* a missing region is not a failure */ }

			}

		}

	}

	function closePanel( slot, restoreFocus ) {

		const panel = panels.get( slot );
		const pill = pills.find( ( p ) => p.dataset.slot === slot );
		if ( ! panel ) return;
		flush();
		panel.classList.remove( 'is-open' );
		// `hidden` and display:none, not a transform, and set on this tick rather
		// than after a closing animation. A closed panel has to be out of the
		// focus order the instant it is closed (H21), and a transitionend that
		// never fires - a backgrounded tab, a dropped frame - would otherwise
		// leave sixteen controls reachable by Tab behind an invisible surface.
		// The close is therefore instant and only the open is animated.
		panel.hidden = true;
		panel.classList.remove( 'is-arming' );
		clearTimeout( armTimer );
		if ( pill ) pill.setAttribute( 'aria-expanded', 'false' );
		if ( openSlot === slot ) openSlot = null;
		stopAwake();
		// The page comes back BEFORE focus is handed to the pill: focusing an
		// element inside an inert subtree silently does nothing.
		setOutsideInert( false );
		if ( restoreFocus && pill ) {

			try {

				// preventScroll matters here: the article starts at 100vh, and a
				// plain focus() on a control near the bottom edge can scroll the
				// hero out from under the visitor.
				pill.focus( { preventScroll: true } );

			} catch ( err ) { /* focus is a nicety, never a failure */ }

		}

	}

	function openPanel( slot ) {

		const panel = panels.get( slot );
		const pill = pills.find( ( p ) => p.dataset.slot === slot );
		if ( ! panel ) return;

		if ( openSlot && openSlot !== slot ) closePanel( openSlot, false );

		panel.hidden = false;
		// Deaf to the pointer for the length of the opening transition. The
		// layout fix in slots.css is what actually stops a double-tap on a pill
		// landing on a slider - the row does not move any more - but a panel that
		// accepts a press before it has finished arriving is a bad idea on its own
		// terms, and this costs one class and one timer.
		panel.classList.add( 'is-arming' );
		clearTimeout( armTimer );
		armTimer = setTimeout( () => panel.classList.remove( 'is-arming' ), ARM_MS );

		render( design() );
		// A frame between "in the layout" and "open", so the transition has a
		// from-value to run from rather than snapping.
		requestAnimationFrame( () => {

			if ( ! panel.hidden ) panel.classList.add( 'is-open' );

		} );

		if ( pill ) pill.setAttribute( 'aria-expanded', 'true' );
		openSlot = slot;
		startAwake();
		setOutsideInert( true );

		try {

			panel.focus( { preventScroll: true } );

		} catch ( err ) { /* older browsers ignore the option; the focus still lands */ }

	}

	function toggle( slot ) {

		if ( openSlot === slot ) closePanel( slot, true );
		else openPanel( slot );

	}

	for ( const pill of pills ) {

		pill.addEventListener( 'click', () => toggle( pill.dataset.slot ) );

	}

	// Light dismiss. The other half of the modal: a press anywhere that is not
	// inside the open panel closes it. Without this the only exits were Escape,
	// the Done button and the pill - and a mouse visitor who clicked the scene
	// got a dialog that stayed open while their click reached the canvas
	// underneath, which is a half-modal in the worst direction.
	//
	// pointerdown rather than click, and on the capture phase, so it fires before
	// main.js's orbit handler claims the gesture; and the pill row is excluded
	// because those buttons run toggle() themselves a moment later and a close
	// here would make the second press look like it did nothing.
	document.addEventListener( 'pointerdown', ( e ) => {

		if ( ! openSlot ) return;
		const panel = panels.get( openSlot );
		if ( ! panel ) return;
		// A piece whose control lives OVER the picture claims the press before
		// this listener runs and names the panel it belongs to. P5 is the one
		// case: the Hang panel's own first line is "Take hold of the chime and
		// drag it", and obeying it dismissed the instruction, the readouts and
		// the Size slider before the pointer had moved. Two listeners on the same
		// node in the same phase cannot suppress one another without
		// stopImmediatePropagation, which would take main.js's canvas handler
		// with it - so the claim is a flag on the event instead.
		if ( e.wcsKeepPanel === openSlot ) return;
		const t = e.target;
		if ( ! ( t instanceof Node ) ) return;
		if ( panel.contains( t ) ) return;
		if ( pillRow.contains( t ) ) return;

		// And a geometric test on top of the DOM one, because for the first
		// ~300 ms the panel is `is-arming` and therefore out of hit testing: a
		// press ON the panel in that window has the canvas as its target and
		// would otherwise read as a press outside, closing the panel the visitor
		// just opened. Inside the rectangle is inside the panel, whatever the
		// event says its target was.
		const r = panel.getBoundingClientRect();
		if ( e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom ) return;
		// restoreFocus false: the visitor is pointing at something else, and
		// yanking focus back to a pill they did not press would scroll the page
		// under them.
		closePanel( openSlot, false );

	}, true );

	for ( const [ slot, panel ] of panels ) {

		const close = panel.querySelector( '[data-close]' );
		if ( close ) close.addEventListener( 'click', () => closePanel( slot, true ) );

		panel.addEventListener( 'keydown', ( e ) => {

			if ( e.key === 'Escape' ) {

				e.stopPropagation();
				closePanel( slot, true );
				return;

			}

			if ( e.key !== 'Tab' ) return;

			// The trap. Focus started inside the dialog and stays inside it until
			// Escape or Done sends it back to the pill that opened it.
			const items = focusablesIn( panel );
			if ( items.length === 0 ) return;
			const first = items[ 0 ];
			const last = items[ items.length - 1 ];
			const at = document.activeElement;

			if ( e.shiftKey && ( at === first || at === panel ) ) {

				e.preventDefault();
				last.focus();

			} else if ( ! e.shiftKey && at === last ) {

				e.preventDefault();
				first.focus();

			}

		} );

	}

	// -----------------------------------------------------------------------
	// Live binding.
	// -----------------------------------------------------------------------

	try {

		if ( typeof api.onDesign === 'function' ) api.onDesign( render );

	} catch ( err ) {

		note( 'slots-subscribe-failed', err );

	}

	render( design() );

	// snapshot() is assigned onto __wcs about twelve hundred lines below the
	// mount point, so the live wind the nullable sliders sit at is not readable
	// yet. One deferred pass picks it up without polling.
	requestAnimationFrame( () => render( design() ) );

	return {
		open: openPanel,
		close: ( restoreFocus ) => {

			if ( openSlot ) closePanel( openSlot, !! restoreFocus );

		},
		panelFor: ( slot ) => panels.get( slot ) || null,
		refresh: () => render( design() )
	};

}
