/**
 * ui/hang.js - where the chime hangs in the place, and how big it hangs there.
 *
 * The visitor sets exactly two things about placement: a POINT in the place and
 * a SIZE. Both are implemented as plate framing and nothing else - the plate
 * slides and zooms behind an object that never moves (CONTRACTS 5.3, Rule A).
 *
 *
 * WHAT THIS FILE IS ALLOWED TO TOUCH
 *
 * window.__wcs, and the three sliders P3 already put in the Hang panel. It never
 * reaches for params, the rig, the wind or audio; it never calls
 * plate.setFraming itself. Every change goes through __wcs.applyDesign, which
 * routes it to stage.setFraming through apply.js step 7 - so the design, the
 * URL, the sliders and the picture cannot disagree, because there is one writer.
 *
 *
 * YOU HAVE TO GRAB THE CHIME. THAT IS THE WHOLE GESTURE.
 *
 * The first cut let a drag start anywhere on the picture. It worked, and it read
 * as panning a photograph, because that is exactly what a drag on empty canopy
 * IS. Worse, the direction is inverted for that reading: drag right and the
 * photograph travels LEFT, because the chime is being carried right along the
 * path. Grab a leaf, watch the leaf run away from your finger.
 *
 * So the press has to land ON the chime. Then the same motion reads the way it
 * is meant to: you have hold of the object, the object goes where your finger
 * goes, and the forest slides past behind it the way a forest does when you walk
 * a chime down a path. The chime is still nailed to the middle of the frame -
 * Rule A is not negotiable - but nothing about the gesture claims otherwise any
 * more, and the one mark on screen that says "this is what you are holding" is
 * drawn around the object rather than floating on empty air.
 *
 * The region is the chime's own metal plus a margin: from the hook down past the
 * longest tube, as wide as the tube ring swings, never smaller than a 44 px
 * touch target. `overChime()` is the test, and it is pure arithmetic on two
 * corner samples taken once per design change, so hovering costs nothing.
 *
 * The sail and the clapper live inside that region and belong to main.js's rig
 * grab. stage.raycastGrab decides, exactly as before: it answers first, and a
 * press it claims is never a hang.
 *
 *
 * WHY THE POINTER MATHS IS SCREEN SPACE, AND NOT grabPlanePoint
 *
 * CONTRACTS 6/P5 names scene.js's grabPlanePoint as the seam to reuse - a
 * camera-facing drag plane that returns WORLD coordinates, which is exactly
 * right for the sail and the clapper, because those are bodies standing in the
 * world at a known depth.
 *
 * The plate is not. plate.js writes its quad in CLIP SPACE:
 *
 *     gl_Position = vec4( position.xy, 1.0, 1.0 );
 *
 * - no model matrix, no view matrix, no projection. `uRect` maps the frame's own
 * 0..1 surface onto the photograph, so ONE SCREEN WIDTH IS EXACTLY 2 * hx OF
 * PLATE, whatever the camera is doing. Routing a drag through a world plane and
 * back would put a projection in the middle of a mapping that has none.
 *
 * So the DRAG's conversion is the plate's own arithmetic, read off
 * plate.limits():
 *
 *     du = ( dxPixels / frameWidth ) * 2 * hx
 *     dv = ( dyPixels / frameHeight ) * 2 * hy
 *
 * grabPlanePoint IS still used, twice, and for the one thing it is the authority
 * on: turning the chime's WORLD extent into a screen rectangle, so the grab
 * region and the mark drawn around it come from where the object actually is
 * rather than from numbers typed into this file.
 *
 *
 * THE FOUR THINGS THIS FILE HANDLES BY HAND
 *
 *   1. THE DESIGN IS THE ASK, NOT THE VIEWPORT'S ANSWER. The reachable range is
 *      viewport-dependent: a 16:9 window at 1920 shows more forest across than a
 *      4:3 one, so the crop is wider and there is less margin left to pan into.
 *      The first cut CANONICALISED the design into that live range, which meant
 *      one shared link resolved to five different hangs across five ordinary
 *      windows AND rewrote each recipient's address bar to their own number, so
 *      re-sharing propagated the drift. That is the one promise this run makes,
 *      broken.
 *
 *      Now: the design carries what was asked for, the URL carries what the
 *      design carries, and the CLAMP HAPPENS AT THE DRAW - plate.js's solve()
 *      already pins the crop inside the image, and has all along. Open a link
 *      too wide a window cannot honour and you see the nearest frame it can
 *      draw; narrow the window and your frame comes back, because the number was
 *      never deleted.
 *
 *      The one thing still written back is a hang outside the PLACE's authored
 *      range - a hand-typed ?c=v1_hu-90, or a hang carried in from another
 *      place. That range is a frozen table in places.js: it does not move with
 *      the viewport, so every visitor canonicalises to the same value or to none
 *      at all. And it is applied from a requestAnimationFrame, never from inside
 *      an onDesign callback - see 2.
 *
 *   2. NEVER APPLY FROM INSIDE A NOTIFICATION. apply.js's emit() walks its
 *      listener list handing each one the design object it captured before the
 *      loop. A listener that applies re-enters emit(), the inner pass writes the
 *      right value, and then the OUTER loop resumes and hands every later
 *      listener the stale object - so P6's address writer, which is registered
 *      after this file, wrote the pre-correction hang and won. Measured: ask for
 *      size 1.30 and the bar says the u you had one correction ago, every time.
 *      Both corrective paths in this file - settle() and the drag - therefore go
 *      through requestAnimationFrame, so the apply is always a fresh top-level
 *      one whose emission is the last word.
 *
 *   3. THE PORCH IS NOT A LIE, IT IS A DIFFERENT KIND OF PLACE. Its ranges are
 *      degenerate on purpose: a built world has a real size and there is no
 *      photograph behind the chime to slide. The controls stay on screen,
 *      visibly off, with the reason on their own label - never missing, and
 *      never live-but-inert (criterion 5). Nothing is settled there either:
 *      scene.js deliberately remembers a hang set elsewhere so it survives a
 *      round trip through the porch, and rewriting it to 0.5 on the way through
 *      would throw that away.
 *
 *   4. A CLICK IS NOT A DRAG. The page's whole claim is that one click anywhere
 *      turns the sound on, and count-clicks.mjs presses the middle of the frame
 *      to prove it. So a press only becomes a hang once the pointer has actually
 *      travelled, and a stationary press changes nothing.
 *
 *
 * ONE LINE OF THIS PIECE LIVES IN slots.js, AND IT IS DECLARED
 *
 * P3's light dismiss closes the open panel on any press outside it. The Hang
 * panel's own first sentence is "Take hold of the chime and drag it", so obeying
 * it dismissed the instruction, all three readouts and the Size slider before
 * the pointer had moved - measured on desktop and on touch. There is no way to
 * suppress one listener from another listener on the same node and in the same
 * phase without stopImmediatePropagation, which would also take main.js's own
 * canvas handler and the pointer bookkeeping with it.
 *
 * So slots.js gained ONE guard - `if ( e.wcsKeepPanel === openSlot ) return;` -
 * and this file sets that flag on the press it claims, from a document-capture
 * listener registered at mount, which is before slots.js's because WCS:UI-MOUNT
 * is alphabetical and mountHang precedes mountSlots. That is a cross-piece edit
 * and it is named here and in the commit rather than left to be discovered.
 */

const DRAG_SLOP_PX = 3;

// How long the gizmo stays up after a drag ends. Long enough to read where the
// edges were, short enough not to become chrome.
const LINGER_MS = 900;

// The design quantises hang.u/v/scale to 1 % (design.js snaps at 100), which is
// also what the URL carries - `hu` is an integer percent. Applying anything
// finer would be a number the share link cannot reproduce, so the drag rounds to
// the codec's own resolution.
//
// The quantum is NOT the rate limit, and the first cut's comment claiming it was
// is why this one says so. A slow drag moves less than 1 % of the plate per
// pointer event and coalesces; a flick or a wiggle does not, and on the real GPU
// five seconds of dragging fired 257 history.replaceState calls, peaking at 56
// in one second. WebKit throws past 100 in 30 seconds. So the drag also
// coalesces to ONE apply per animation frame, which caps it at the display's
// refresh whatever the pointer's sample rate is.
const Q = 100;

// The grab region, in metres, measured off the rig rather than guessed. It is
// the METAL: from a little above the top plate down past the longest tube, as
// wide as the tube ring swings. The cords above the plate are deliberately
// outside it - the hook is 0.545 m up and a region that reached it would run off
// the top of the frame, and an outline clipped by the frame edge reads as a
// floating panel rather than as an object being held.
const GRAB_ABOVE_PLATE = 0.16;
const GRAB_BELOW_TUBES = 0.10;
const GRAB_HALF_WIDTH = 0.32;

// No hit region smaller than a finger, whatever the metal is doing.
const MIN_TARGET_PX = 44;

const clamp = ( v, lo, hi ) => ( v < lo ? lo : ( v > hi ? hi : v ) );
const quant = ( v ) => Math.round( v * Q ) / Q;

/** Inward, always: a slider must not offer a value the plate will refuse. */
const floorTo = ( v ) => Math.floor( v * Q ) / Q;
const ceilTo = ( v ) => Math.ceil( v * Q ) / Q;

/**
 * @param {object} wcs  window.__wcs. design(), applyDesign(), onDesign(),
 *                      onFrame(), snapshot(), stage. Every member is optional so
 *                      a half-built page degrades instead of throwing.
 * @param {function} [noteError] main.js's error sink, (tag, err) => void.
 * @returns {object|null} a small handle for the verifiers, or null when the Hang
 *                      panel is not on the page.
 */
export function mountHang( wcs, noteError ) {

	const note = typeof noteError === 'function' ? noteError : () => {};

	// A mount must not throw and must not await (CONTRACTS 2.3). Losing the hang
	// control costs the visitor two of the design's twenty fields; it must not
	// cost them the chime.
	try {

		return build( wcs, note );

	} catch ( err ) {

		note( 'hang-mount-failed', err );
		return null;

	}

}

function build( wcs, note ) {

	const api = ( wcs !== null && typeof wcs === 'object' ) ? wcs : {};

	const sliders = {
		u: document.getElementById( 'wcsHangU' ),
		v: document.getElementById( 'wcsHangV' ),
		scale: document.getElementById( 'wcsHangScale' )
	};
	if ( ! sliders.u || ! sliders.v || ! sliders.scale ) return null;

	const why = document.getElementById( 'wcsHangWhy' );
	const hint = document.getElementById( 'wcsHangHint' );
	const panel = document.getElementById( 'wcsPanel-hang' );
	const canvas = document.getElementById( 'glCanvas' );
	const container = document.getElementById( 'canvasContainer' );

	// -----------------------------------------------------------------------
	// The seams, all read live. `stage` is reassigned wholesale after a GL
	// context loss and `plate` is destroyed and rebuilt on every place switch,
	// so nothing here is allowed to hold either one.
	// -----------------------------------------------------------------------

	function stage() {

		try {

			return api.stage || null;

		} catch ( err ) {

			return null;

		}

	}

	function place() {

		const st = stage();
		try {

			return st && typeof st.place === 'function' ? st.place() : null;

		} catch ( err ) {

			return null;

		}

	}

	function limits() {

		const st = stage();
		try {

			const p = st ? st.plate : null;
			if ( ! p || typeof p.limits !== 'function' ) return null;
			return p.limits();

		} catch ( err ) {

			return null;

		}

	}

	function design() {

		try {

			return typeof api.design === 'function' ? api.design() : null;

		} catch ( err ) {

			note( 'hang-design-read-failed', err );
			return null;

		}

	}

	let applying = false;

	function apply( partial ) {

		if ( applying ) return;
		try {

			applying = true;
			if ( typeof api.applyDesign === 'function' ) api.applyDesign( partial );

		} catch ( err ) {

			note( 'hang-apply-failed', err );

		} finally {

			applying = false;

		}

	}

	// -----------------------------------------------------------------------
	// Is hanging a thing you can do here?
	//
	// Not "is this a plate place" - "does this place, at this window size and
	// this size of chime, leave anything to move". They are different questions
	// once the scale is at its top: the pan margin is spent on the zoom and the
	// travel goes to nothing while the size slider is still live.
	// -----------------------------------------------------------------------

	/**
	 * The reachable range, rounded INWARD to the design's own 1 % quantum.
	 *
	 * One function so the slider's travel and the drag's clamp cannot disagree.
	 * Rounding to nearest would be wrong at both ends: a low limit of 0.4149
	 * rounds to 0.41, which the plate then silently clamps back to 0.4149.
	 * Inward is the only rounding that keeps every notch legal.
	 *
	 * This is what the CONTROLS offer. It is deliberately NOT what the design is
	 * held to - see the note at the top of the file, item 1.
	 */
	function boundsFrom( L ) {

		if ( ! L ) return null;
		const one = ( r ) => [ ceilTo( r[ 0 ] ), Math.max( ceilTo( r[ 0 ] ), floorTo( r[ 1 ] ) ) ];
		return { u: one( L.u ), v: one( L.v ), scale: one( L.scale ) };

	}

	function spanOf( L ) {

		if ( ! L ) return 0;
		return Math.max(
			L.u[ 1 ] - L.u[ 0 ],
			L.v[ 1 ] - L.v[ 0 ],
			L.scale[ 1 ] - L.scale[ 0 ]
		);

	}

	/**
	 * The one line the panel says about itself, in both states.
	 *
	 * ONE line, and at the TOP of the panel body, because .wcs-panel-body is
	 * `max-height: min(26vh, 222px); overflow-y: auto` and three slider rows plus
	 * prose do not fit that on a phone - measured: 297 px of content in a 240 px
	 * body, with the Size slider below the fold. The paragraph that used to sit
	 * under this one explained the physics to the visitor and is gone.
	 */
	function reasonFor( on, pl ) {

		if ( on ) return 'Take hold of the chime and drag it along the path.';
		if ( ! pl ) return 'The picture is not up, so there is nothing behind the chime to move.';
		if ( pl.kind !== 'plate' ) {

			return 'Not here: ' + pl.name + ' is a built world with a real size, so there is nothing behind the chime to slide it across.';

		}

		return 'This window has no margin left around the picture, so there is nowhere for the chime to go.';

	}

	// -----------------------------------------------------------------------
	// The gizmo. Two marks and they say two different things.
	//
	//   .wcs-hang-hold   a soft outline AROUND THE CHIME. "This is the thing you
	//                    have hold of." It does not move, because the chime does
	//                    not move, and being drawn on the object is what makes
	//                    that legible instead of baffling. The first cut drew a
	//                    crosshair at the crop's centre instead, which is the
	//                    middle of the frame by construction - measured at the
	//                    same pixel in every state, sitting on the tube ends and
	//                    on nothing at all when the chime was small.
	//
	//   .wcs-hang-field  the reach, drawn in PLATE space, so it slides with the
	//                    photograph and its edge arriving at the chime is what
	//                    "stops hard at the range" looks like.
	// -----------------------------------------------------------------------

	let root = null;
	let box = null;
	let hold = null;

	if ( container ) {

		root = document.createElement( 'div' );
		root.className = 'wcs-hang-gizmo';
		// It is a picture of a control, not a control, and everything it says is
		// already said by the panel's own line and by the sliders.
		root.setAttribute( 'aria-hidden', 'true' );
		box = document.createElement( 'div' );
		box.className = 'wcs-hang-field';
		hold = document.createElement( 'div' );
		hold.className = 'wcs-hang-hold';
		root.appendChild( box );
		root.appendChild( hold );
		container.appendChild( root );

	}

	let enabled = false;
	let shown = false;
	let holding = false;
	let dirty = true;
	let lingerUntil = 0;
	let stateKey = '';

	// -----------------------------------------------------------------------
	// The view cache.
	//
	// Everything the frame hook and the pointer handlers need, in one
	// preallocated object, refreshed once per design change and once per resize.
	// CONTRACTS 2.3 says a WCS:FRAME-HOOK callback must be allocation-free; the
	// first cut called design() (a structuredClone of the whole design) and
	// plate.limits() (an object and four arrays) from inside it, on every frame
	// of a drag. Now the frame hook reads floats.
	// -----------------------------------------------------------------------

	const view = {
		ok: false,
		// the crop the plate is drawing, in plate space
		cx: 0.5, cy: 0.5, hx: 0.5, hy: 0.5,
		// the travel the controls offer, inward-quantised
		uLo: 0, uHi: 1, vLo: 0, vHi: 1,
		// the hang the design is asking for
		u: 0.5, v: 0.5,
		// the frame, in CSS pixels
		w: 1, h: 1, left: 0, top: 0,
		// the chime's own rectangle, in CSS pixels relative to the frame
		gx0: 0, gy0: 0, gx1: 0, gy1: 0,
		hasGrab: false
	};

	// Scratch for the two grabPlanePoint samples. Module-level and reused, so the
	// mapping costs no allocation either.
	const _centre = [ 0, 0, 0 ];
	const _right = [ 0, 0, 0 ];
	const _lo = [ 0, 0, 0 ];
	const _hi = [ 0, 0, 0 ];

	// The chime's world extent. Only re-read when the tube list could have
	// changed, because snapshot() builds a whole object and the tubes are the
	// only thing in it that moves the outline.
	let geomKey = '';
	const geom = { top: 2.6, bottom: 1.0, ok: false };

	function readGeometry( d ) {

		const key = d ? ( d.tubes.scale + '|' + d.tubes.notes ) : '-';
		if ( key === geomKey && geom.ok ) return;
		geomKey = key;
		geom.ok = false;
		try {

			if ( typeof api.snapshot !== 'function' ) return;
			const s = api.snapshot();
			const pos = s && s.plate ? s.plate.pos : null;
			const lens = s ? s.tubeLengths : null;
			if ( ! Array.isArray( pos ) || ! Array.isArray( lens ) || lens.length === 0 ) return;
			let longest = 0;
			for ( let i = 0; i < lens.length; i ++ ) if ( lens[ i ] > longest ) longest = lens[ i ];
			geom.top = pos[ 1 ] + GRAB_ABOVE_PLATE;
			geom.bottom = pos[ 1 ] - longest - GRAB_BELOW_TUBES;
			geom.ok = true;

		} catch ( err ) {

			note( 'hang-geometry-read-failed', err );

		}

	}

	/**
	 * The chime's world box, as a rectangle of the frame.
	 *
	 * Two samples of the camera-facing plane through the object - its bottom-left
	 * corner of the frame and its top-right - give an affine map from world to
	 * screen that is exact for both projections, because a plane under an ortho
	 * or a perspective camera projects affinely. Everything after this is
	 * arithmetic, which is what lets a hover test run on every pointermove.
	 */
	function measureGrab() {

		view.hasGrab = false;
		const st = stage();
		if ( ! st || ! geom.ok ) return;
		if ( typeof st.grabPlanePoint !== 'function' || typeof st.cameraRight !== 'function' ) return;

		_centre[ 0 ] = 0;
		_centre[ 1 ] = ( geom.top + geom.bottom ) * 0.5;
		_centre[ 2 ] = 0;

		try {

			st.cameraRight( _right );
			st.grabPlanePoint( - 1, - 1, _centre, _lo );
			st.grabPlanePoint( 1, 1, _centre, _hi );

		} catch ( err ) {

			note( 'hang-measure-failed', err );
			return;

		}

		// Lateral offset of each sample along the camera's own right vector.
		const latLo = ( _lo[ 0 ] - _centre[ 0 ] ) * _right[ 0 ] +
			( _lo[ 1 ] - _centre[ 1 ] ) * _right[ 1 ] +
			( _lo[ 2 ] - _centre[ 2 ] ) * _right[ 2 ];
		const latHi = ( _hi[ 0 ] - _centre[ 0 ] ) * _right[ 0 ] +
			( _hi[ 1 ] - _centre[ 1 ] ) * _right[ 1 ] +
			( _hi[ 2 ] - _centre[ 2 ] ) * _right[ 2 ];

		// _lo is the frame's bottom-left corner and _hi its top-right, so x counts
		// UP from _lo and y counts DOWN from _hi - screen y grows downward and
		// world y does not.
		const spanX = latHi - latLo;
		const spanY = _hi[ 1 ] - _lo[ 1 ];
		if ( ! ( Math.abs( spanX ) > 1e-6 ) || ! ( Math.abs( spanY ) > 1e-6 ) ) return;

		const pxPerMx = view.w / spanX;
		const pxPerMy = view.h / spanY;

		let x0 = ( - GRAB_HALF_WIDTH - latLo ) * pxPerMx;
		let x1 = ( GRAB_HALF_WIDTH - latLo ) * pxPerMx;
		let y0 = ( _hi[ 1 ] - geom.top ) * pxPerMy;
		let y1 = ( _hi[ 1 ] - geom.bottom ) * pxPerMy;
		if ( x1 < x0 ) { const t = x0; x0 = x1; x1 = t; }
		if ( y1 < y0 ) { const t = y0; y0 = y1; y1 = t; }

		// A finger is 44 px wide wherever the metal happens to be.
		const padX = Math.max( 0, ( MIN_TARGET_PX - ( x1 - x0 ) ) * 0.5 );
		const padY = Math.max( 0, ( MIN_TARGET_PX - ( y1 - y0 ) ) * 0.5 );

		// Kept inside the frame: a press outside it never arrives anyway, and the
		// outline drawn on this rectangle must not run off an edge.
		view.gx0 = clamp( x0 - padX, 2, view.w - 2 );
		view.gx1 = clamp( x1 + padX, 2, view.w - 2 );
		view.gy0 = clamp( y0 - padY, 2, view.h - 2 );
		view.gy1 = clamp( y1 + padY, 2, view.h - 2 );
		view.hasGrab = view.gx1 - view.gx0 > 8 && view.gy1 - view.gy0 > 8;

	}

	function refreshView() {

		view.ok = false;
		const L = limits();
		const B = boundsFrom( L );
		const d = design();
		if ( ! container ) return;

		view.w = Math.max( 1, container.clientWidth || 1 );
		view.h = Math.max( 1, container.clientHeight || 1 );
		if ( canvas ) {

			const r = canvas.getBoundingClientRect();
			view.left = r.left;
			view.top = r.top;

		}

		if ( d ) {

			view.u = d.hang.u;
			view.v = d.hang.v;
			readGeometry( d );

		}

		measureGrab();

		if ( ! L || ! B ) return;
		view.cx = L.crop[ 0 ]; view.cy = L.crop[ 1 ];
		view.hx = L.crop[ 2 ]; view.hy = L.crop[ 3 ];
		view.uLo = B.u[ 0 ]; view.uHi = B.u[ 1 ];
		view.vLo = B.v[ 0 ]; view.vHi = B.v[ 1 ];
		view.ok = view.hx > 0 && view.hy > 0;

	}

	/** Is this client point on the chime? Pure arithmetic against the cache. */
	function overChime( clientX, clientY ) {

		if ( ! view.hasGrab ) return false;
		const x = clientX - view.left;
		const y = clientY - view.top;
		return x >= view.gx0 && x <= view.gx1 && y >= view.gy0 && y <= view.gy1;

	}

	/** Plate space -> frame pixels, through the crop the plate is actually using. */
	function layout() {

		if ( ! box || ! hold || ! view.ok ) return;

		const w = view.w;
		const h = view.h;
		const px = ( u ) => ( ( u - ( view.cx - view.hx ) ) / ( 2 * view.hx ) ) * w;
		const py = ( v ) => ( ( v - ( view.cy - view.hy ) ) / ( 2 * view.hy ) ) * h;

		const l = px( view.uLo );
		const r = px( view.uHi );
		const t = py( view.vLo );
		const b = py( view.vHi );

		box.style.transform = 'translate(' + l.toFixed( 1 ) + 'px,' + t.toFixed( 1 ) + 'px)';
		box.style.width = Math.max( 0, r - l ).toFixed( 1 ) + 'px';
		box.style.height = Math.max( 0, b - t ).toFixed( 1 ) + 'px';

		// Pinned reads off the CROP, not off the design: the design carries the
		// ask and the crop carries what this window could draw, so the amber edge
		// appears exactly when the picture has stopped moving - which is the
		// moment the visitor is feeling.
		const eps = 1e-6;
		const pinned = view.cx <= view.uLo + eps || view.cx >= view.uHi - eps ||
			view.cy <= view.vLo + eps || view.cy >= view.vHi - eps;
		box.classList.toggle( 'is-pinned', pinned );

		if ( view.hasGrab ) {

			hold.style.transform = 'translate(' + view.gx0.toFixed( 1 ) + 'px,' + view.gy0.toFixed( 1 ) + 'px)';
			hold.style.width = ( view.gx1 - view.gx0 ).toFixed( 1 ) + 'px';
			hold.style.height = ( view.gy1 - view.gy0 ).toFixed( 1 ) + 'px';

		}

	}

	// -----------------------------------------------------------------------
	// The controls.
	// -----------------------------------------------------------------------

	function setRange( el, range ) {

		const a = String( range[ 0 ] );
		const b = String( range[ 1 ] );
		if ( el.min !== a ) el.min = a;
		if ( el.max !== b ) el.max = b;

	}

	/**
	 * Pull the design back inside what the PLACE will draw. Never inside what
	 * this window can draw - see item 1 at the top of the file.
	 *
	 * Deferred to a frame, so the corrective apply is a fresh top-level one and
	 * its emission is the last thing every subscriber sees (item 2). Runs at most
	 * once on a cold load of an out-of-range link, and never during ordinary use.
	 */
	let settlePending = false;

	function scheduleSettle() {

		if ( settlePending ) return;
		settlePending = true;
		requestAnimationFrame( () => {

			settlePending = false;
			settle();

		} );

	}

	function settle() {

		const pl = place();
		if ( ! pl || pl.kind !== 'plate' || ! pl.hang ) return;
		const d = design();
		if ( ! d || ! d.hang ) return;
		const hr = pl.hang;
		const u = quant( clamp( d.hang.u, hr.uRange[ 0 ], hr.uRange[ 1 ] ) );
		const v = quant( clamp( d.hang.v, hr.vRange[ 0 ], hr.vRange[ 1 ] ) );
		const s = quant( clamp( d.hang.scale, hr.scaleRange[ 0 ], hr.scaleRange[ 1 ] ) );
		if ( u === d.hang.u && v === d.hang.v && s === d.hang.scale ) return;
		apply( { hang: { u, v, scale: s } } );

	}

	/**
	 * The whole state of the control, recomputed from the place that is up.
	 */
	function sync() {

		const pl = place();
		const L = limits();
		// spanOf against the INWARD bounds, so a place whose reach has collapsed
		// to less than one notch reads as "nothing to move" rather than offering a
		// slider with a single legal position.
		const B = boundsFrom( L );
		const on = !! ( pl && pl.kind === 'plate' && B && spanOf( B ) > 1e-9 );
		enabled = on;

		for ( const key of [ 'u', 'v', 'scale' ] ) {

			const el = sliders[ key ];
			const off = ! on;
			if ( el.disabled !== off ) el.disabled = off;
			const field = el.closest ? el.closest( '.wcs-field' ) : null;
			if ( field ) field.classList.toggle( 'is-disabled', off );
			// The description a screen reader reads for these three is the line
			// above them, not the note that used to sit below the fold.
			if ( hint && el.getAttribute( 'aria-describedby' ) !== 'wcsHangHint' ) {

				el.setAttribute( 'aria-describedby', 'wcsHangHint' );

			}

			if ( on ) setRange( el, B[ key ] );

		}

		const key = ( pl ? pl.id : '-' ) + '|' + on + '|' +
			( on ? sliders.u.min + ',' + sliders.u.max + ',' + sliders.v.min + ',' + sliders.v.max : '' );
		if ( key !== stateKey ) {

			stateKey = key;
			const line = reasonFor( on, pl );
			if ( hint ) {

				if ( hint.textContent !== line ) hint.textContent = line;
				// The static copy in the markup is the no-JS fallback and nothing
				// more. Leaving it on screen would print the same sentence twice.
				if ( why ) { why.textContent = ''; why.hidden = true; }

			} else if ( why && why.textContent !== line ) {

				why.textContent = line;

			}

		}

		if ( ! on ) {

			holding = false;
			if ( canvas ) canvas.classList.remove( 'wcs-over-chime' );

		}

		refreshView();
		if ( on ) scheduleSettle();
		dirty = true;

	}

	// -----------------------------------------------------------------------
	// The drag.
	//
	// pointerdown is on DOCUMENT, capture phase, registered at mount - which is
	// before slots.js's light dismiss, because WCS:UI-MOUNT is alphabetical. Two
	// things need that ordering: the flag that keeps the Hang panel open while
	// the visitor obeys it, and deciding whether the press belongs to the rig
	// before anyone else claims it. Nothing is stopped: main.js's own canvas
	// handler still runs, still counts the pointer, and still unlocks the audio.
	// -----------------------------------------------------------------------

	let dragId = -1;
	let moved = false;
	const start = { x: 0, y: 0, u: 0, v: 0, hx: 0.5, hy: 0.5, w: 1, h: 1, uLo: 0, uHi: 1, vLo: 0, vHi: 1 };

	// One apply per animation frame, whatever the pointer's sample rate is.
	let pendU = -1, pendV = -1, pendRaf = 0;

	function flushDrag() {

		pendRaf = 0;
		if ( pendU < 0 ) return;
		const u = pendU, v = pendV;
		pendU = -1; pendV = -1;
		const d = design();
		if ( ! d ) return;
		if ( u === d.hang.u && v === d.hang.v ) return;
		apply( { hang: { u, v } } );

	}

	function schedule( u, v ) {

		pendU = u; pendV = v;
		if ( pendRaf ) return;
		pendRaf = requestAnimationFrame( flushDrag );

	}

	function endDrag() {

		if ( dragId === -1 ) return;
		try {

			if ( canvas && canvas.releasePointerCapture ) canvas.releasePointerCapture( dragId );

		} catch ( err ) { /* the capture is gone either way */ }

		dragId = -1;
		moved = false;
		lingerUntil = performance.now() + LINGER_MS;
		if ( canvas ) canvas.classList.remove( 'wcs-hanging' );
		// The last sample must land even if the pointer came up inside the frame
		// it was scheduled in.
		if ( pendRaf ) { cancelAnimationFrame( pendRaf ); flushDrag(); }
		dirty = true;

	}

	/**
	 * A second finger arrived. That is a pinch, and the code that cancels it has
	 * to UNDO what the first finger did as the hand opened - the guard the first
	 * cut had rejected the second pointer's start and left the drag running, so a
	 * two-finger spread walked the chime 0.02 of the plate before anyone noticed.
	 */
	function abortDrag() {

		if ( dragId === -1 ) return;
		const u = start.u, v = start.v;
		pendU = -1; pendV = -1;
		endDrag();
		const d = design();
		if ( d && ( d.hang.u !== u || d.hang.v !== v ) ) apply( { hang: { u, v } } );

	}

	if ( canvas ) {

		document.addEventListener( 'pointerdown', ( e ) => {

			// A second pointer, or a second button, on a live drag: pinch, or a
			// context menu. Neither is a hang, and the hang that was in flight is
			// put back where it started.
			if ( dragId !== -1 ) {

				if ( e.pointerId !== dragId || ! e.isPrimary || e.button !== 0 ) abortDrag();
				return;

			}

			if ( ! enabled ) return;
			if ( e.target !== canvas ) return;
			if ( ! e.isPrimary || e.button !== 0 ) return;
			if ( ! overChime( e.clientX, e.clientY ) ) return;

			const st = stage();
			const L = limits();
			const b = boundsFrom( L );
			const d = design();
			if ( ! st || ! L || ! b || ! d ) return;

			// The sail and the clapper are main.js's to drag, and they hang inside
			// the chime's own outline. Its picker answers first.
			try {

				if ( typeof st.raycastGrab === 'function' ) {

					const ndcX = ( ( e.clientX - view.left ) / view.w ) * 2 - 1;
					const ndcY = - ( ( e.clientY - view.top ) / view.h ) * 2 + 1;
					if ( st.raycastGrab( ndcX, ndcY ) ) return;

				}

			} catch ( err ) {

				note( 'hang-raycast-failed', err );
				return;

			}

			start.x = e.clientX;
			start.y = e.clientY;
			start.u = d.hang.u;
			start.v = d.hang.v;
			// The crop half-sizes are fixed for the length of a drag: they move
			// with the viewport and with hang.scale, and neither changes while a
			// pointer is down.
			start.hx = L.crop[ 2 ];
			start.hy = L.crop[ 3 ];
			start.w = view.w;
			start.h = view.h;
			start.uLo = b.u[ 0 ]; start.uHi = b.u[ 1 ];
			start.vLo = b.v[ 0 ]; start.vHi = b.v[ 1 ];

			dragId = e.pointerId;
			moved = false;
			try {

				if ( canvas.setPointerCapture ) canvas.setPointerCapture( e.pointerId );

			} catch ( err ) { /* a browser without capture still delivers the moves */ }

			// P3's light dismiss reads this and leaves the Hang panel alone. See
			// the declaration at the top of this file.
			e.wcsKeepPanel = 'hang';

			canvas.classList.add( 'wcs-hanging' );
			dirty = true;

		}, true );

		canvas.addEventListener( 'pointermove', ( e ) => {

			if ( e.pointerId !== dragId ) {

				// Hover: the cursor is the only thing on a desktop that says the
				// chime can be picked up, and it must never promise it anywhere
				// else on the picture.
				if ( dragId === -1 ) {

					const over = enabled && overChime( e.clientX, e.clientY );
					if ( over !== holding ) {

						holding = over;
						canvas.classList.toggle( 'wcs-over-chime', over );
						dirty = true;

					}

				}

				return;

			}

			const dx = e.clientX - start.x;
			const dy = e.clientY - start.y;
			// Item 4: a click is not a drag. The page's one-click claim is measured
			// by pressing the middle of the frame, and that press must leave the
			// design exactly where it was.
			if ( ! moved && Math.abs( dx ) < DRAG_SLOP_PX && Math.abs( dy ) < DRAG_SLOP_PX ) return;
			moved = true;

			// The plate's own arithmetic: one frame width is 2 * hx of photograph.
			const u = quant( clamp( start.u + ( dx / start.w ) * 2 * start.hx, start.uLo, start.uHi ) );
			const v = quant( clamp( start.v + ( dy / start.h ) * 2 * start.hy, start.vLo, start.vHi ) );

			schedule( u, v );

		} );

		canvas.addEventListener( 'pointerleave', () => {

			if ( dragId !== -1 || ! holding ) return;
			holding = false;
			canvas.classList.remove( 'wcs-over-chime' );

		} );

		for ( const type of [ 'pointerup', 'pointercancel' ] ) {

			canvas.addEventListener( type, ( e ) => {

				if ( e.pointerId === dragId ) endDrag();

			} );

		}

		// A pointer that leaves the window mid-drag without a capture: without
		// this the drag would still be live when it came back, and the chime
		// would jump.
		window.addEventListener( 'blur', endDrag );

	}

	// -----------------------------------------------------------------------
	// When the gizmo is on screen.
	//
	// While dragging, while the Hang panel is open, and for a moment after a
	// drag. Never otherwise: the first frame this page draws contains the object
	// and nothing else, and a permanent rectangle over the forest would be one
	// more thing competing with it.
	// -----------------------------------------------------------------------

	/** The reach: only when the visitor is actually placing the chime. */
	function wantReach( now ) {

		if ( ! enabled ) return false;
		if ( dragId !== -1 ) return true;
		if ( panel && panel.hidden === false ) return true;
		return now < lingerUntil;

	}

	/** The hold outline: whenever the chime is under the pointer or in hand. */
	function wantHold() {

		return enabled && ( holding || dragId !== -1 );

	}

	let reachShown = false;
	let heldShown = false;

	try {

		if ( typeof api.onFrame === 'function' ) api.onFrame( () => {

			// Allocation-free, in every state. layout() reads the view cache and
			// writes strings into style properties; nothing here calls design(),
			// snapshot() or plate.limits().
			const now = performance.now();
			const reach = wantReach( now );
			const held = wantHold();
			if ( reach !== reachShown ) {

				reachShown = reach;
				if ( root ) root.classList.toggle( 'is-reach', reach );
				if ( reach ) dirty = true;

			}

			if ( held !== heldShown ) {

				heldShown = held;
				if ( root ) root.classList.toggle( 'is-held', held );
				if ( held ) dirty = true;

			}

			shown = reach || held;
			if ( shown && dirty ) {

				dirty = false;
				layout();

			}

		} );

	} catch ( err ) {

		note( 'hang-frame-subscribe-failed', err );

	}

	try {

		if ( typeof api.onDesign === 'function' ) api.onDesign( () => {

			// Nothing is applied from in here. sync() refreshes the cache and, at
			// most, SCHEDULES a settle for a later frame (item 2 at the top).
			sync();

		} );

	} catch ( err ) {

		note( 'hang-subscribe-failed', err );

	}

	// The reachable range is a function of the viewport, so a rotated phone or a
	// dragged window edge changes it. Coalesced to one pass per frame: a resize
	// drag fires this at the pointer's rate.
	let resizePending = false;
	window.addEventListener( 'resize', () => {

		if ( resizePending ) return;
		resizePending = true;
		requestAnimationFrame( () => {

			resizePending = false;
			sync();

		} );

	} );

	sync();

	// WCS:UI-MOUNT is alphabetical by function name, so this file mounts before
	// ui/places.js - and places.js is what reconciles the decoded place and the
	// decoded hang with the stage that was built before either was known. Until
	// it has run, limits() reports the boot place's defaults. One deferred pass
	// reads the settled page, which is the same trick slots.js uses for the same
	// reason.
	requestAnimationFrame( sync );

	// The handle is also parked on window, because main.js's marker block allows
	// this piece exactly one mount line and therefore has nowhere to keep it, and
	// a grab region that only exists as a hit test is a region no critic can
	// measure. Read-only, no behaviour hangs off it.
	try {

		window.__wcsHang = {
			sync,
			enabled: () => enabled,
			dragging: () => dragId !== -1,
			overChime,
			view: () => Object.assign( {}, view ),
			grabRect: () => ( view.hasGrab
				? { x: view.gx0 + view.left, y: view.gy0 + view.top, w: view.gx1 - view.gx0, h: view.gy1 - view.gy0 }
				: null )
		};

	} catch ( err ) { /* a frozen window is not our problem */ }

	return {
		sync,
		enabled: () => enabled,
		dragging: () => dragId !== -1,
		overChime,
		grabRect: () => ( view.hasGrab
			? { x: view.gx0 + view.left, y: view.gy0 + view.top, w: view.gx1 - view.gx0, h: view.gy1 - view.gy0 }
			: null )
	};

}
