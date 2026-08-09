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
 * is left is a small control that reports a state - the sound is off - in the
 * place the bar puts its one quiet extra control, directly under the object and
 * above the caption.
 *
 * IT HAS NO CLICK HANDLER, ON PURPOSE
 *
 * main.js already listens for `pointerdown` and `keydown` on window in the
 * capture phase and unlocks audio from any gesture anywhere (main.js, the block
 * above `window.addEventListener( 'blur', goIdle )`). Pressing this button is
 * one of those gestures, and so is pressing Share, and so is clicking the sky.
 * Wiring a second unlock path here would mean two callers racing one promise for
 * no gain. The button is an affordance for something the whole page already
 * does; it is a real <button> so that a keyboard visitor has somewhere to land
 * and something to press, and Enter or Space on it is a keydown.
 *
 * WHEN IT GOES
 *
 * It follows main.js's latch rather than its own. That latch keys on
 * `audio.ready()` inside the frame loop, not on the click, because resume() is a
 * promise that can be refused: a control that left on the press would be lying
 * in exactly the case where it is the only thing on screen worth reading. So
 * this watches #audioToast for the `done` class main.js writes and leaves when
 * that arrives. #audioToast itself stays exactly where P3 put it, still the
 * page's aria-live region, carrying the sentence for a screen reader where a
 * mute glyph says nothing. landing.css takes it off the screen and nothing else.
 */

/**
 * @param {object} wcs        window.__wcs
 * @param {function} noteError (tag, err) => void
 */
export function mountLanding( wcs, noteError ) {

	try {

		// First, and outside the unlock control's own guard: the two are
		// unrelated, and the geolocation guard must not be skipped because a
		// container is missing.
		guardWeather();

		const root = document.getElementById( 'wcsLanding' );
		const button = document.getElementById( 'wcsSound' );
		if ( ! root || ! button ) return;

		const toast = document.getElementById( 'audioToast' );

		let observer = null;
		let unhook = null;
		let done = false;

		function dismiss() {

			if ( done ) return;
			done = true;

			// visibility, not display: the fade needs something to fade, and the
			// control sits in #hudOverlay's empty middle row where nothing else
			// is laid out against it, so leaving the box in place costs nothing
			// and moves nothing when it goes.
			root.classList.add( 'is-done' );
			button.disabled = true;
			button.tabIndex = -1;

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
 * The live-weather row inside the Place panel.
 *
 * CONTRACTS 6/P2 gives this to P2: live weather moves off the front door and
 * becomes an option one panel in, defaulting off. P3 rebuilt the two ids as a
 * stopgap when it deleted the dock, because they are the only callers
 * runWeatherChain has and it dies silently without one (H22). This finishes it,
 * and both ids stay exactly as main.js expects to find them.
 *
 * What is left to fix is H23. `runWeatherChain` branches on an empty query, and
 * the empty branch calls navigator.geolocation, which puts a native permission
 * prompt on the screen. Two ways in:
 *
 *   the button   named for the wrong thing. "Use live weather" over an empty box
 *                produces a location prompt the visitor never asked for. So the
 *                label tracks the box: empty it reads "Use where I am", and it
 *                only reads "Use live weather" once there is a town in there.
 *                Same button, same id, same one caller.
 *
 *   Enter        a reflex, not a decision. Swallowed while the box is empty.
 *                Caught on window in the CAPTURE phase, which runs before any
 *                listener on the field itself, so main.js's keydown handler
 *                never sees it. stopPropagation and NOT stopImmediatePropagation
 *                deliberately: main.js's own window-capture unlock listener is
 *                on the same node and has to keep running, or a keyboard
 *                visitor's first Enter would stop turning the sound on.
 */
function guardWeather() {

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

}
