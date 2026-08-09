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
 * back would put a projection in the middle of a mapping that has none: it would
 * be right at the frame's centre and progressively wrong toward its edges under
 * the perspective styles, and it would need a depth the plate does not have.
 *
 * So the conversion is the plate's own arithmetic, read off plate.limits():
 *
 *     du = ( dxPixels / frameWidth ) * 2 * hx
 *     dv = ( dyPixels / frameHeight ) * 2 * hy
 *
 * Recorded here rather than left as a silent deviation. grabPlanePoint IS still
 * used, for the one thing it is the authority on: deciding whether the press
 * that started this gesture landed on the sail or the clapper, which belong to
 * main.js's rig grab and are not ours to steal.
 *
 *
 * WHICH WAY A DRAG GOES
 *
 * The chime is nailed to the middle of the frame and cannot follow a finger, so
 * "direct manipulation" is not available at any price; the only thing a drag can
 * be direct about is the chime's position RELATIVE TO THE PLACE. Dragging right
 * therefore moves the chime right ALONG THE PATH, which means the photograph
 * travels left under it. That matches the slider's label ("Across the place"),
 * the panel's own sentence, and the gizmo, whose box is drawn in plate space and
 * visibly slides while the chime does not.
 *
 *
 * THE THREE THINGS THIS FILE HANDLES BY HAND
 *
 *   1. THE RANGES ARE THE PLACE'S, AND design.js CANNOT KNOW THEM. clampDesign
 *      holds hang.u/v to the structural 0..1 and the scale to 0.6..1.8, because
 *      design.js is pure and may not import places.js. The real limits are
 *      narrower, they are viewport- and scale-dependent, and plate.limits()
 *      re-derives them live. So the slider travel comes from limits(), and a
 *      design that arrives outside them - a hand-typed ?c=v1_hu-90, or a size
 *      raised until the pan margin ran out - is canonicalised back into them.
 *      Without that the URL would promise a frame the picture cannot draw, which
 *      is the same defect P4 fixed for the sun.
 *
 *   2. THE PORCH IS NOT A LIE, IT IS A DIFFERENT KIND OF PLACE. Its ranges are
 *      degenerate on purpose: a built world has a real size and there is no
 *      photograph behind the chime to slide. The controls stay on screen,
 *      visibly off, with the reason on their own label - never missing, and
 *      never live-but-inert (criterion 5). Nothing is canonicalised there
 *      either: scene.js deliberately remembers a hang set elsewhere so it
 *      survives a round trip through the porch, and rewriting it to 0.5 on the
 *      way through would throw that away.
 *
 *   3. A CLICK IS NOT A DRAG. The page's whole claim is that one click anywhere
 *      turns the sound on, and count-clicks.mjs presses the middle of the frame
 *      to prove it. So a press only becomes a hang once the pointer has actually
 *      travelled, and a stationary press changes nothing.
 */

const DRAG_SLOP_PX = 3;

// How long the gizmo stays up after a drag ends. Long enough to read where the
// edges were, short enough not to become chrome.
const LINGER_MS = 900;

// The design quantises hang.u/v/scale to 1 % (design.js snaps at 100), which is
// also what the URL carries - `hu` is an integer percent. Applying anything finer
// would be a number the share link cannot reproduce, so the drag rounds to the
// codec's own resolution and skips the apply when the rounded value has not
// moved. That is what keeps a fast drag to about twenty applies instead of one
// per pointer event, and with it twenty history.replaceState calls instead of
// two hundred.
const Q = 100;

const clamp = ( v, lo, hi ) => ( v < lo ? lo : ( v > hi ? hi : v ) );
const quant = ( v ) => Math.round( v * Q ) / Q;

/** Inward, always: a slider must not offer a value the plate will refuse. */
const floorTo = ( v ) => Math.floor( v * Q ) / Q;
const ceilTo = ( v ) => Math.ceil( v * Q ) / Q;

/**
 * @param {object} wcs  window.__wcs. design(), applyDesign(), onDesign(),
 *                      onFrame(), stage. Every member is optional so a
 *                      half-built page degrades instead of throwing.
 * @param {function} [noteError] main.js's error sink, (tag, err) => void.
 * @returns {object|null} { sync, enabled } for the verifiers, or null when the
 *                      Hang panel is not on the page.
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
	 * One function so the slider's travel, the drag's clamp and the
	 * canonicaliser cannot disagree. Rounding to nearest would be wrong at both
	 * ends: a low limit of 0.4149 rounds to 0.41, which the plate then silently
	 * clamps back to 0.4149, and the design would be describing a frame that is
	 * not on screen. Inward is the only rounding that keeps every notch legal.
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
	 * `max-height: min(26vh, 222px); overflow-y: auto` - three slider rows fill
	 * it exactly, and the reason as it originally shipped, in a note UNDER them,
	 * was scrolled out of the panel on a 900 px window. A reason a visitor has to
	 * scroll to find is not "visibly disabled with a reason" (criterion 5); it is
	 * three dead sliders and no explanation. So the line lives in the WCS:HANG
	 * region, which is the first thing in the body, and the sliders'
	 * aria-describedby is repointed at it so the two agree.
	 */
	function reasonFor( on, pl ) {

		if ( on ) return 'Drag the chime in the picture to move it. The bigger it hangs, the less room there is to move it.';
		if ( ! pl ) return 'The picture is not up, so there is nothing behind the chime to move.';
		if ( pl.kind !== 'plate' ) {

			return 'Not here: ' + pl.name + ' is a built world with a real size, so there is nothing behind the chime to slide it across.';

		}

		return 'This window has no margin left around the picture, so there is nowhere for the chime to go.';

	}

	// -----------------------------------------------------------------------
	// The gizmo.
	// -----------------------------------------------------------------------

	let root = null;
	let box = null;
	let pin = null;

	if ( container ) {

		root = document.createElement( 'div' );
		root.className = 'wcs-hang-gizmo';
		// It is a picture of a control, not a control, and everything it says is
		// already said by the three sliders and their readouts.
		root.setAttribute( 'aria-hidden', 'true' );
		box = document.createElement( 'div' );
		box.className = 'wcs-hang-field';
		pin = document.createElement( 'div' );
		pin.className = 'wcs-hang-pin';
		root.appendChild( box );
		root.appendChild( pin );
		container.appendChild( root );

	}

	let enabled = false;
	let shown = false;
	let dirty = true;
	let lingerUntil = 0;
	let stateKey = '';

	/** Plate space -> frame pixels, through the crop the plate is actually using. */
	function layout() {

		if ( ! box || ! pin || ! container ) return;
		const L = limits();
		// The INWARD bounds, not the raw ones, so the rectangle on screen is
		// exactly the travel the sliders and the drag offer. Drawn from the raw
		// limits it would be up to 1 % of the plate too generous at each edge -
		// about 7 px at 1440 - and the pin would stop just short of the corner it
		// is supposed to arrive at.
		const B = boundsFrom( L );
		const d = design();
		if ( ! L || ! B || ! d ) return;

		const w = container.clientWidth || 1;
		const h = container.clientHeight || 1;
		const cx = L.crop[ 0 ], cy = L.crop[ 1 ], hx = L.crop[ 2 ], hy = L.crop[ 3 ];
		if ( ! ( hx > 0 ) || ! ( hy > 0 ) ) return;

		const px = ( u ) => ( ( u - ( cx - hx ) ) / ( 2 * hx ) ) * w;
		const py = ( v ) => ( ( v - ( cy - hy ) ) / ( 2 * hy ) ) * h;

		const l = px( B.u[ 0 ] );
		const r = px( B.u[ 1 ] );
		const t = py( B.v[ 0 ] );
		const b = py( B.v[ 1 ] );

		box.style.transform = 'translate(' + l.toFixed( 1 ) + 'px,' + t.toFixed( 1 ) + 'px)';
		box.style.width = Math.max( 0, r - l ).toFixed( 1 ) + 'px';
		box.style.height = Math.max( 0, b - t ).toFixed( 1 ) + 'px';

		pin.style.transform = 'translate(' + px( d.hang.u ).toFixed( 1 ) + 'px,' + py( d.hang.v ).toFixed( 1 ) + 'px)';

		const eps = 1e-6;
		const pinned = d.hang.u <= B.u[ 0 ] + eps || d.hang.u >= B.u[ 1 ] - eps ||
			d.hang.v <= B.v[ 0 ] + eps || d.hang.v >= B.v[ 1 ] - eps;
		box.classList.toggle( 'is-pinned', pinned );

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
	 * Pull the design back inside what the place will actually draw.
	 *
	 * Only where hanging is a thing that can be done. On the porch the design's
	 * hang is DORMANT, not wrong: scene.js remembers it precisely so a hang
	 * dragged in the forest survives a trip to the porch and back, and clamping
	 * it to the porch's degenerate 0.5/0.5/1.0 would be this file quietly
	 * deleting the visitor's work on the way past.
	 */
	function canonicalise( bounds ) {

		if ( ! bounds ) return;
		const d = design();
		if ( ! d || ! d.hang ) return;
		const u = quant( clamp( d.hang.u, bounds.u[ 0 ], bounds.u[ 1 ] ) );
		const v = quant( clamp( d.hang.v, bounds.v[ 0 ], bounds.v[ 1 ] ) );
		const s = quant( clamp( d.hang.scale, bounds.scale[ 0 ], bounds.scale[ 1 ] ) );
		if ( u === d.hang.u && v === d.hang.v && s === d.hang.scale ) return;
		apply( { hang: { u, v, scale: s } } );

	}

	/**
	 * The whole state of the control, recomputed from the place that is up.
	 * Cheap enough to call on every design change: the DOM writes below are all
	 * guarded on an actual change, and the string key is built once per call
	 * rather than once per frame.
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

		const bounds = on ? B : null;

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

			if ( on ) setRange( el, bounds[ key ] );

		}

		const key = ( pl ? pl.id : '-' ) + '|' + on + '|' +
			( on ? sliders.u.min + ',' + sliders.u.max + ',' + sliders.v.min + ',' + sliders.v.max : '' );
		if ( key !== stateKey ) {

			stateKey = key;
			const line = reasonFor( on, pl );
			if ( hint ) {

				if ( hint.textContent !== line ) hint.textContent = line;
				// The static copy in the markup is the no-JS fallback and nothing
				// more. Leaving it on screen would print the same sentence twice,
				// once above the sliders and once below them.
				if ( why ) { why.textContent = ''; why.hidden = true; }

			} else if ( why && why.textContent !== line ) {

				why.textContent = line;

			}

		}

		if ( canvas ) canvas.classList.toggle( 'wcs-can-hang', on );

		canonicalise( bounds );
		dirty = true;

	}

	// -----------------------------------------------------------------------
	// The drag.
	//
	// Registered on the canvas at mount, which is ~280 lines above main.js's own
	// canvas listeners, so this handler runs first. That is safe in one direction
	// only: this one has to decide whether the press belongs to the rig before it
	// claims it, which is what the raycastGrab call below is for. main.js's
	// handler then runs, raycasts the same point, gets null and returns.
	// -----------------------------------------------------------------------

	let dragId = -1;
	let moved = false;
	const start = { x: 0, y: 0, u: 0, v: 0, hx: 0.5, hy: 0.5, w: 1, h: 1, uLo: 0, uHi: 1, vLo: 0, vHi: 1 };

	function endDrag() {

		if ( dragId === -1 ) return;
		try {

			if ( canvas && canvas.releasePointerCapture ) canvas.releasePointerCapture( dragId );

		} catch ( err ) { /* the capture is gone either way */ }

		dragId = -1;
		moved = false;
		lingerUntil = performance.now() + LINGER_MS;
		if ( canvas ) canvas.classList.remove( 'wcs-hanging' );
		dirty = true;

	}

	if ( canvas ) {

		canvas.addEventListener( 'pointerdown', ( e ) => {

			if ( dragId !== -1 || ! enabled ) return;
			// Two fingers is a pinch and the second button is a context menu;
			// neither is a hang.
			if ( ! e.isPrimary || e.button !== 0 ) return;

			const st = stage();
			const L = limits();
			const b = boundsFrom( L );
			const d = design();
			if ( ! st || ! L || ! b || ! d ) return;

			const rect = canvas.getBoundingClientRect();
			if ( rect.width <= 0 || rect.height <= 0 ) return;

			// The sail and the clapper are main.js's to drag. grabPlanePoint's own
			// picker answers that question, and it is the one thing in this file
			// that reaches into the world rather than into the frame.
			try {

				if ( typeof st.raycastGrab === 'function' ) {

					const ndcX = ( ( e.clientX - rect.left ) / rect.width ) * 2 - 1;
					const ndcY = - ( ( e.clientY - rect.top ) / rect.height ) * 2 + 1;
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
			start.w = rect.width;
			start.h = rect.height;
			start.uLo = b.u[ 0 ]; start.uHi = b.u[ 1 ];
			start.vLo = b.v[ 0 ]; start.vHi = b.v[ 1 ];

			dragId = e.pointerId;
			moved = false;
			try {

				if ( canvas.setPointerCapture ) canvas.setPointerCapture( e.pointerId );

			} catch ( err ) { /* a browser without capture still delivers the moves */ }

			canvas.classList.add( 'wcs-hanging' );
			dirty = true;

		} );

		canvas.addEventListener( 'pointermove', ( e ) => {

			if ( e.pointerId !== dragId ) return;

			const dx = e.clientX - start.x;
			const dy = e.clientY - start.y;
			// H3 of this file: a click is not a drag. The page's one-click claim is
			// measured by pressing the middle of the frame, and that press must
			// leave the design exactly where it was.
			if ( ! moved && Math.abs( dx ) < DRAG_SLOP_PX && Math.abs( dy ) < DRAG_SLOP_PX ) return;
			moved = true;

			// The plate's own arithmetic: one frame width is 2 * hx of photograph.
			const u = quant( clamp( start.u + ( dx / start.w ) * 2 * start.hx, start.uLo, start.uHi ) );
			const v = quant( clamp( start.v + ( dy / start.h ) * 2 * start.hy, start.vLo, start.vHi ) );

			const d = design();
			if ( ! d ) return;
			if ( u === d.hang.u && v === d.hang.v ) return;

			apply( { hang: { u, v } } );

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

	function wantVisible( now ) {

		if ( ! enabled ) return false;
		if ( dragId !== -1 ) return true;
		if ( panel && panel.hidden === false ) return true;
		return now < lingerUntil;

	}

	try {

		if ( typeof api.onFrame === 'function' ) api.onFrame( () => {

			// Allocation-free in the steady state: two comparisons and a class
			// toggle that is itself guarded. layout() - which does allocate, via
			// plate.limits() - runs only on the frames where something moved.
			const now = performance.now();
			const vis = wantVisible( now );
			if ( vis !== shown ) {

				shown = vis;
				if ( root ) root.classList.toggle( 'is-on', vis );
				if ( vis ) dirty = true;

			}

			if ( vis && dirty ) {

				dirty = false;
				layout();

			}

		} );

	} catch ( err ) {

		note( 'hang-frame-subscribe-failed', err );

	}

	try {

		if ( typeof api.onDesign === 'function' ) api.onDesign( () => {

			// Re-entrancy: canonicalise() applies, which emits, which lands back
			// here. `applying` makes the inner apply a no-op and the outer pass
			// then finds the design already inside the bounds, so this settles in
			// two passes and never loops.
			if ( applying ) { dirty = true; return; }
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

	return {
		sync,
		enabled: () => enabled,
		dragging: () => dragId !== -1
	};

}
