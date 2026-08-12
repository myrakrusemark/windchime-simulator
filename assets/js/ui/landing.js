/**
 * landing.js - the first frame.
 *
 * P2 owns exactly one behaviour on this page: the audio-unlock affordance and
 * when it goes away. Everything else about the first frame is now other pieces'
 * work - the object is P4's place and the rig's own physics, the caption and the
 * pill row are P3's, Share is P6's - and the whole point of this piece is that
 * it adds nothing else to the picture.
 *
 * WHY THERE IS AN AFFORDANCE AT ALL
 *
 * Browsers will not start an AudioContext without a gesture, so one click is the
 * floor and there is no way under it. The bar (Apple Watch Studio) has no
 * instruction anywhere in its first frame, and until now ours had the loudest
 * sentence on the page telling a stranger to click. The sentence is gone. What
 * is left is one underlined word that reports a state - the sound is off - in
 * the place the bar puts its own one quiet control, directly under the object
 * and above the caption.
 *
 * THE RELAY, AND WHY IT EXISTS
 *
 * main.js listens for `pointerdown` and `keydown` on window in the capture phase
 * and unlocks audio from any gesture anywhere. That covers a mouse press, a
 * finger and a key, which is every gesture a human makes directly.
 *
 * It does not cover `click` arriving on its own, and `click` on its own is what
 * assistive technology produces: a macOS or iOS Voice Control "click Muted", an
 * NVDA or JAWS browse-mode activate, and anything calling HTMLElement.click().
 * Measured before this was here: a trusted `document.getElementById('wcsSound')
 * .click()` left `audioReady` false, the toast without `.done` and the control
 * still on screen, with an empty error list - because no code had run at all.
 * Mouse, touch and Space all worked. The hole was narrow, invisible from a
 * keyboard, and total for the people who fell in it: the page stayed silent
 * forever and the thing that said "Muted" was what had failed them.
 *
 * The fix is one window-level capture listener that turns a click into the
 * gesture main.js is already listening for. It is deliberately on window rather
 * than on the button, because "click anywhere" has to mean anywhere and a pill,
 * Share and the canvas are all reachable the same way. `unlockAudio()` no-ops
 * on `audioUnlocked || unlockInFlight`, so the redundant call every ordinary
 * mouse click now makes costs one guarded return, and the listener is removed
 * the moment the sound is on.
 *
 * An event dispatched at window has window as its whole propagation path, so
 * this reaches main.js's unlock and nothing else - not slots.js's document-level
 * outside-click, not the canvas's own pointerdown.
 *
 * WHEN IT GOES
 *
 * It follows main.js's latch rather than its own. That latch keys on
 * `audio.ready()` inside the frame loop, not on the click, because resume() is a
 * promise that can be refused: a control that left on the press would be lying
 * in exactly the case where it is the only thing on screen worth reading. So
 * this watches #audioToast for the `done` class main.js writes and leaves when
 * that arrives. #audioToast itself stays exactly where P3 put it, still the
 * page's aria-live region - but its sentence is rewritten on the way out, see
 * dismiss().
 */

/**
 * @param {object} wcs        window.__wcs
 * @param {function} noteError (tag, err) => void
 */
export function mountLanding( wcs, noteError ) {

	try {

		// First, and outside the unlock control's own guard: the two are
		// unrelated, and the weather wiring must not be skipped because a
		// container is missing. The switch and the row it shows are separate
		// mounts for the same reason - a page missing one still gets the other.
		mountWindMode( wcs, noteError );
		mountWeather( wcs, noteError );

		const root = document.getElementById( 'wcsLanding' );
		const button = document.getElementById( 'wcsSound' );
		if ( ! root || ! button ) return;

		const toast = document.getElementById( 'audioToast' );

		let observer = null;
		let unhook = null;
		let done = false;

		// See THE RELAY above. Capture, so a handler that stops propagation
		// cannot swallow it; passive, because nothing here preventDefaults.
		function relayClick() {

			window.dispatchEvent( new Event( 'pointerdown' ) );

		}

		window.addEventListener( 'click', relayClick, { capture: true, passive: true } );

		function dismiss() {

			if ( done ) return;
			done = true;

			// Hand focus on BEFORE disabling. Disabling the focused element drops
			// focus to <body>, and the next Tab then restarts at the top of the
			// page - measured: activating this from the keyboard threw a visitor
			// backwards past their own position in a tab order that runs
			// [Share, Muted, Place, Tubes, Striker, Sail, Hang, ...]. Place is
			// the next stop and it is where someone who just turned the sound on
			// is going. Only if this control is what actually has focus: by the
			// time the latch fires the visitor may have tabbed on, and stealing
			// focus from them would be the same bug pointing the other way.
			if ( document.activeElement === button ) {

				const next = document.getElementById( 'wcsPill-place' );
				if ( next && typeof next.focus === 'function' ) next.focus();

			}

			root.classList.add( 'is-done' );
			button.disabled = true;
			button.tabIndex = -1;

			// The sentence describes the state it is in, not the one it was in.
			//
			// #audioToast is visually hidden and carries "Click or tap anywhere to
			// hear the wind chime" for a screen reader, because a muted glyph
			// reads as nothing at all. That is true before the click and false
			// after it, and the first version of this piece left the instruction
			// in the accessibility tree permanently - a stale order to do
			// something the visitor had already done. It is also the only one of
			// the page's four aria-live regions whose content never changed,
			// which means the polite region never announced anything: text
			// present at load is not an announcement. Rewriting it here fixes
			// both at once - the instruction goes, and the transition is finally
			// something the region can say.
			if ( toast ) {

				const line = toast.firstElementChild || toast;
				line.textContent = 'The chime is sounding.';

			}

			window.removeEventListener( 'click', relayClick, { capture: true } );

			if ( observer ) {

				observer.disconnect();
				observer = null;

			}

			if ( unhook ) {

				unhook();
				unhook = null;

			}

		}

		if ( toast ) {

			// Already running - a reload onto a tab that has kept its gesture
			// credit, mostly. Then there was never anything to press.
			if ( toast.classList.contains( 'done' ) ) {

				dismiss();

			} else {

				observer = new MutationObserver( () => {

					if ( toast.classList.contains( 'done' ) ) dismiss();

				} );
				observer.observe( toast, { attributes: true, attributeFilter: [ 'class' ] } );

			}

		} else if ( typeof wcs.onFrame === 'function' ) {

			// The toast is the page's only aria-live region and CONTRACTS 2.5
			// forbids removing it, so this branch should be unreachable. It
			// exists because the failure it guards is invisible: with no latch to
			// follow, a control that says the sound is off would sit there
			// through a chime that is audibly ringing. Polled at 1 Hz rather than
			// per frame, snapshot() being a large allocation, and unsubscribed
			// the moment it fires. `snapshot` is read inside the callback and not
			// here: main.js installs it ~1200 lines below WCS:UI-MOUNT, so at
			// mount time the member does not exist yet.
			let nextCheckMs = 0;
			unhook = wcs.onFrame( () => {

				const now = performance.now();
				if ( now < nextCheckMs ) return;
				nextCheckMs = now + 1000;
				if ( typeof wcs.snapshot !== 'function' ) return;
				const s = wcs.snapshot();
				if ( s && s.audioReady ) dismiss();

			} );

		}

	} catch ( err ) {

		noteError( 'landing-mount-failed', err );

	}

}


/**
 * LOCAL OR MANUAL - the switch above the weather controls.
 *
 * The group showed a location box AND three wind sliders at once, which is four
 * controls for one decision. Someone who had just fetched Asheville's wind was
 * still looking at a speed slider offering to overwrite it, and someone who had
 * dragged the speed slider was still looking at a box asking where they are.
 * They are two answers to the same question, so they became two positions of one
 * switch (Myra, 2026-08-11).
 *
 * WHAT THE SWITCH WRITES, AND WHAT IT DOES NOT
 *
 * Manual writes. `wind.source: 'place'` is a real revert and belongs in the
 * design and in the shared URL as `ws-p`, so pressing Manual after a reading has
 * landed says so. The numbers the weather left in `wind.mph` stay, which is what
 * makes Manual a starting point rather than a reset: the sliders open on the
 * wind that is actually blowing.
 *
 * Local writes NOTHING. `wind.source: 'weather'` means the visitor asked for a
 * reading, and it is still `arm()` below - the button press - that records it.
 * Two reasons, and the second is the load-bearing one:
 *
 *   1. no fetch fires when a tab is pressed, so a design saying 'weather' with
 *      no reading behind it would put `ws-w` in a link whose recipient gets the
 *      place's own wind. The URL would describe something that never happened.
 *   2. H23. The empty-box branch of runWeatherChain calls navigator.geolocation
 *      and the browser puts a permission prompt on the screen. Nothing that can
 *      be reached by an arrow key may lead there. The button is named for it and
 *      the switch is not.
 *
 * The traffic runs the other way instead: a landed reading, or a shared link
 * that arrived carrying `ws-w`, pulls the switch to Local through onDesign. It
 * never pushes back to Manual on its own - only the visitor's own press does
 * that, or the switch would jump under someone mid-drag.
 */
function mountWindMode( wcs, noteError ) {

	const group = document.getElementById( 'wcsWindMode' );
	if ( ! group ) return;

	const buttons = Array.from( group.querySelectorAll( '[data-wind-mode]' ) );
	const panes = Array.from( document.querySelectorAll( '[data-wind-pane]' ) );
	if ( buttons.length === 0 || panes.length === 0 ) return;

	// A link that asked for live weather opens on Local. Everything else opens
	// on Manual, which is CONTRACTS 6/P2's "defaulting off": the location box is
	// one press further in than it was, and nothing on the first frame reaches it.
	let mode = 'manual';
	try {

		if ( typeof wcs.design === 'function' && wcs.design().wind.source === 'weather' ) mode = 'local';

	} catch ( err ) {

		noteError( 'wind-mode-read-failed', err );

	}

	function paint() {

		for ( const b of buttons ) {

			const on = b.dataset.windMode === mode;
			b.setAttribute( 'aria-checked', on ? 'true' : 'false' );
			b.tabIndex = on ? 0 : - 1;

		}

		// `hidden`, not a transform. slots.js's Tab trap walks the panel for
		// anything focusable with a box, so the half that is not on screen has to
		// be out of the layout or the trap cycles through three sliders nobody
		// can see (the same reasoning as H21, one level down).
		for ( const p of panes ) p.hidden = p.dataset.windPane !== mode;

	}

	function set( next ) {

		if ( next !== 'local' && next !== 'manual' ) return;
		const changed = next !== mode;
		mode = next;
		paint();

		if ( ! changed || next !== 'manual' ) return;

		try {

			if ( typeof wcs.applyDesign !== 'function' || typeof wcs.design !== 'function' ) return;
			if ( wcs.design().wind.source !== 'place' ) wcs.applyDesign( { wind: { source: 'place' } } );

		} catch ( err ) {

			noteError( 'wind-mode-apply-failed', err );

		}

	}

	for ( const b of buttons ) b.addEventListener( 'click', () => set( b.dataset.windMode ) );

	// The same keyboard contract as every other radiogroup on this page: one Tab
	// stop, arrows to move inside it, and moving inside it commits.
	group.addEventListener( 'keydown', ( e ) => {

		const keys = [ 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End' ];
		if ( keys.indexOf( e.key ) === - 1 ) return;
		const at = buttons.indexOf( document.activeElement );
		let next;
		if ( e.key === 'Home' ) next = 0;
		else if ( e.key === 'End' ) next = buttons.length - 1;
		else if ( e.key === 'ArrowRight' || e.key === 'ArrowDown' ) next = ( at + 1 + buttons.length ) % buttons.length;
		else next = ( at - 1 + buttons.length ) % buttons.length;
		e.preventDefault();
		buttons[ next ].focus();
		set( buttons[ next ].dataset.windMode );

	} );

	try {

		if ( typeof wcs.onDesign === 'function' ) wcs.onDesign( ( d ) => {

			if ( d && d.wind && d.wind.source === 'weather' && mode !== 'local' ) set( 'local' );

		} );

	} catch ( err ) {

		noteError( 'wind-mode-subscribe-failed', err );

	}

	paint();

}


/**
 * The live-weather row inside the Place panel.
 *
 * CONTRACTS 6/P2 gives this to P2: live weather moves off the front door and
 * becomes an option one panel in, defaulting off. P3 rebuilt the two ids as a
 * stopgap when it deleted the dock, because they are the only callers
 * runWeatherChain has and it dies silently without one (H22). This finishes it,
 * and both ids stay exactly as main.js expects to find them.
 *
 * THREE THINGS HAPPEN HERE.
 *
 * 1. H23, the unrequested geolocation prompt. `runWeatherChain` branches on an
 *    empty query and the empty branch calls navigator.geolocation, which puts a
 *    native permission dialog on the screen. Two ways in:
 *
 *      the button   named for the wrong thing. "Use live weather" over an empty
 *                   box produces a location prompt the visitor never asked for.
 *                   So the label tracks the box: empty it reads "Use where I
 *                   am", and it only reads "Use live weather" once there is a
 *                   town in there. Same button, same id, same one caller.
 *
 *      Enter        a reflex, not a decision. Swallowed while the box is empty.
 *                   Caught on window in the CAPTURE phase, which runs before any
 *                   listener on the field itself, so main.js's keydown handler
 *                   never sees it. stopPropagation and NOT
 *                   stopImmediatePropagation deliberately: main.js's own
 *                   window-capture unlock listener is on the same node and has
 *                   to keep running, or a keyboard visitor's first Enter would
 *                   stop turning the sound on.
 *
 * 2. The asking is recorded in the design. CONTRACTS 3 defines
 *    `wind.source: 'weather'` and 4.1 gives it the wire key `ws-w`, and before
 *    this nothing anywhere wrote either. Measured: ask for Boulder, watch the
 *    whole chain succeed - nominatim, api.weather.gov/points, the forecast, a
 *    status line reading "Boulder, CO: Areas Of Smoke - 71F - W at 8 mph" - and
 *    `__wcs.design().wind` was still `{mph:null, dirDeg:null, turbulence:null,
 *    source:'place'}` with `location.search` still `?c=v1`. The visitor's own
 *    request fell out of the thing built to carry it. It is written the instant
 *    the button is pressed, because the asking is a decision and it is true
 *    whether or not weather.gov answers.
 *
 * 3. The reading itself is recorded, once it has landed and settled. See
 *    watchForReading.
 *
 * WHAT IS NOT DONE HERE, AND WHY NOT
 *
 * The right place for 2 and 3 is main.js's `applyReading()`, which should push
 * a reading through `__wcs.applyDesign` instead of calling `wind.setWeather`
 * directly - one call, no polling, exact values. `applyReading` is main.js, and
 * CONTRACTS 2.3 gives P2 exactly one import line and one mount line in that
 * file and nothing else anywhere in it. So this observes from outside instead.
 * It is a real behaviour and it is measurable, but the one-line version belongs
 * to whoever owns main.js.
 */
function mountWeather( wcs, noteError ) {

	const input = document.getElementById( 'locationInput' );
	const go = document.getElementById( 'startButton' );
	if ( ! input || ! go ) return;

	const label = go.querySelector( '[data-weather-go-label]' );

	function sync() {

		if ( ! label ) return;
		const named = input.value.trim().length > 0;
		const next = named ? 'Use live weather' : 'Use where I am';
		if ( label.textContent !== next ) label.textContent = next;

	}

	input.addEventListener( 'input', sync );
	sync();

	window.addEventListener( 'keydown', ( e ) => {

		if ( e.key !== 'Enter' ) return;
		if ( e.target !== input ) return;
		if ( input.value.trim() ) return;
		e.preventDefault();
		e.stopPropagation();

	}, { capture: true } );

	// Both of main.js's own triggers, mirrored. These listeners only record; the
	// fetch is still main.js's single caller, and weather.js is still imported
	// exactly once on this page (H25 - a second import forks its module-singleton
	// rate limiter and doubles our request rate to Nominatim).
	go.addEventListener( 'click', () => arm( wcs, noteError ) );
	input.addEventListener( 'keydown', ( e ) => {

		if ( e.key === 'Enter' && input.value.trim() ) arm( wcs, noteError );

	} );

}


// One watcher at a time. Pressing the button twice while the first request is
// still in flight would otherwise leave two pollers racing to write the same
// two fields, and the loser would write a value read half a ramp earlier.
let activeWatch = null;


/**
 * Record the asking, then wait for the answer.
 */
function arm( wcs, noteError ) {

	try {

		if ( typeof wcs.applyDesign !== 'function' || typeof wcs.design !== 'function' ) return;
		if ( activeWatch ) activeWatch();
		wcs.applyDesign( { wind: { source: 'weather' } } );
		watchForReading( wcs, noteError );

	} catch ( err ) {

		noteError( 'weather-arm-failed', err );

	}

}


/**
 * Turn a landed weather reading into design fields, so the shared URL carries
 * the sky the visitor actually got.
 *
 * WHY IT IS A WATCHER AND NOT A CALLBACK
 *
 * There is no callback to take. `applyReading` in main.js hands the numbers
 * straight to `wind.setWeather` and puts the prose on the status line; the only
 * thing it leaves anywhere a UI piece can read is `snapshot().weather`, which
 * carries the source, the place name and the age, and not the speed. So this
 * reads the wind itself.
 *
 * WHY IT WAITS FOR THE NUMBER TO STOP MOVING
 *
 * `wind.setWeather` sets a target and ramps to it over eight seconds so the
 * chime eases into real weather instead of being kicked by it. Sampling during
 * the ramp would bake into the URL a number the visitor was never given.
 * `state.speedMph` is read straight back out of params on every update and the
 * gust is a separate multiplier that never enters it, so the ramp is over
 * exactly when two consecutive samples are equal - compared raw, not rounded.
 * Rounded was the first version and it was wrong: the ramp from 12 mph to 8 mph
 * moves 0.25 mph per sample, so `Math.round` reported "settled" three seconds
 * early and wrote 10 mph into the URL of a page reading 8. Measured, then
 * fixed.
 *
 * WHY THE BEARING IS NOT RECORDED
 *
 * Because it cannot be read from out here, and writing the readable-looking
 * number would be worse than writing nothing. `snapshot().wind.dirDeg` is
 * `params.dirDeg + dirDev`, where dirDev is wind.js's slow wander of the mean
 * heading - an Ornstein-Uhlenbeck walk whose sigma runs from 4 degrees in a
 * stiff wind to 25 in a calm one (wind.js stepDirection). At Boulder's 8 mph
 * that is about 11 degrees of drift riding on top of the base bearing, and it
 * never settles, by design. The first version of this recorded 275 for a
 * reading of "W at 8 mph" - 270 - and would have recorded a different wrong
 * number every time. The base heading exists only in `params.dirDeg`, which is
 * main.js's private business, so `wind.dirDeg` stays null and the direction
 * stays the place's. That is the second half of why `applyReading` is the right
 * home for all of this: inside main.js both numbers are simply in hand.
 *
 * WHAT MAKES IT LET GO
 *
 *   - it recorded a reading. The good ending.
 *   - the visitor moved a wind control themselves. Their number wins.
 *   - 20 s after a reading landed and the wind is still moving. That is two and
 *     a half ramps; past it, something other than this reading is driving the
 *     wind, and it takes the last value rather than never writing one.
 *   - 45 s with no reading at all. weather.gov said nothing, or the place is
 *     outside the US, or geolocation was denied. `ws-w` stays in the URL, which
 *     is honest: they did ask.
 *
 * Polled at 2 Hz off the frame hook, never per frame: snapshot() allocates.
 */
function watchForReading( wcs, noteError ) {

	if ( typeof wcs.onFrame !== 'function' ) return;

	// Whatever the design said about wind when the button was pressed. If it
	// changes under us, a slider did it and this has no business overwriting it.
	const armedMph = wcs.design().wind.mph;

	const startedMs = performance.now();
	let readingMs = 0;
	let nextCheckMs = 0;
	let lastMph = null;
	let unhook = null;

	function stop() {

		if ( activeWatch === stop ) activeWatch = null;
		if ( ! unhook ) return;
		const u = unhook;
		unhook = null;
		u();

	}

	activeWatch = stop;

	unhook = wcs.onFrame( () => {

		try {

			const now = performance.now();
			if ( now < nextCheckMs ) return;
			nextCheckMs = now + 500;

			if ( typeof wcs.snapshot !== 'function' ) return;

			if ( wcs.design().wind.mph !== armedMph ) {

				stop();
				return;

			}

			const s = wcs.snapshot();
			if ( ! s ) return;

			// A reading has landed when main.js has stamped a source on it. ageSec
			// is 0 on the frame it arrives and the 15-minute poller re-stamps it,
			// so either the first reading or a later refresh trips this.
			if ( ! readingMs ) {

				if ( s.weather && s.weather.source && s.weather.ageSec !== null && s.weather.ageSec <= 2 ) {

					readingMs = now;
					lastMph = null;

				} else if ( now - startedMs > 45000 ) {

					stop();

				}

				return;

			}

			// Raw, not rounded. See WHY IT WAITS above.
			const mph = s.wind.speedMph;
			const settled = mph === lastMph;
			lastMph = mph;

			if ( ! settled && now - readingMs <= 20000 ) return;

			stop();
			// An integer, because the codec is integers: mph on the wire is
			// `w-24` (CONTRACTS 4.1), so rounding here means the design and the
			// URL agree exactly rather than to within half a unit.
			wcs.applyDesign( { wind: { source: 'weather', mph: Math.round( mph ) } } );

		} catch ( err ) {

			stop();
			noteError( 'weather-watch-failed', err );

		}

	} );

}
