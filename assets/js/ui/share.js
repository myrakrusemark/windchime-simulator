/**
 * ui/share.js - one click, and you leave holding it.
 *
 * The bar is Apple Watch Studio: Get started, then Save, top right, always
 * visible. Two clicks and a stranger walks off with the watch they made. Ours
 * was one click to sound and then a dead end - nothing in the top right, and an
 * address bar that stayed bare no matter what you built. The object could be
 * made and never taken.
 *
 * This file is both halves of the fix:
 *
 *   the button      copies a URL that carries the whole design, and says so.
 *   the writer      keeps location.search up to date on every design change, so
 *                   the browser's own Back, bookmark, reload and copy-the-URL all
 *                   carry the chime without anyone pressing anything.
 *
 * WHAT IT IS ALLOWED TO TOUCH
 *
 * window.__wcs and the address bar. It writes no codec of its own - encode() and
 * describe() come from design.js and are the single source of truth for the
 * string and for the sentence (CONTRACTS 2.2, section 3 rule 4). It never
 * reaches for params, the rig, the wind or audio, and it never navigates.
 *
 * THE FOUR THINGS THAT COST AN HOUR EACH IF YOU GET THEM WRONG
 *
 *   replaceState, never pushState.   Twenty slot changes must leave
 *                                    history.length exactly where it started, or
 *                                    the Back button becomes an undo stack for a
 *                                    slider drag and the visitor can never get
 *                                    off the page (CONTRACTS P6 criterion 3).
 *
 *   The address bar keeps what it     A shared-URL product may not silently
 *   was handed.                       rewrite the link a stranger pasted
 *                                     (CONTRACTS 4.4). So the writer edits ONE
 *                                     search parameter, `c`, and leaves ?q=,
 *                                     ?style= and the fragment exactly as they
 *                                     arrived. The legacy parameters still
 *                                     decode, and `c` still wins over them, so
 *                                     the meaning of the URL is unchanged by the
 *                                     write.
 *
 *   The clipboard copy is canonical.  What goes on the clipboard is
 *                                     origin + path + '?c=' + encode(design) and
 *                                     nothing else: the default chime shares as
 *                                     `?c=v1`, and the most customised chime the
 *                                     pill row can reach measures 92 characters
 *                                     (tools/verify-design.mjs prints it).
 *                                     Legacy parameters a visitor happened to
 *                                     arrive with are not somebody else's
 *                                     problem to inherit.
 *
 *   The copy runs INSIDE the click.   navigator.clipboard.writeText wants a live
 *                                     user gesture. Anything awaited before it -
 *                                     a permissions query, a design read that
 *                                     returns a promise - spends the gesture and
 *                                     the write is refused on exactly the
 *                                     browsers that are strictest about it. The
 *                                     string is built synchronously and handed
 *                                     over on the first line of the handler.
 *
 * The click also unlocks audio for free: main.js installs a capture-phase
 * pointerdown listener on the window that takes any gesture anywhere, so pressing
 * Share on a cold page starts the sound and copies the link in the same press.
 * That is the whole count - one click from arriving to holding something you can
 * send to somebody.
 */

import { describe, encode } from '../design.js';

// How long the confirmation stays up. Long enough to read twice, short enough
// that it is gone before the visitor looks back at the object.
const TOAST_MS = 3200;
const FADE_MS = 300;

/**
 * @param {object} wcs   window.__wcs. design(), onDesign(). Every member is
 *                       optional so a half-built page degrades instead of
 *                       throwing.
 * @param {function} [noteError] main.js's error sink, (tag, err) => void.
 * @returns {object|null} { url, copy, refresh } or null if the markup is absent.
 */
export function mountShare( wcs, noteError ) {

	const note = typeof noteError === 'function' ? noteError : () => {};

	// A mount must not throw and must not await (CONTRACTS 2.3). main.js gets one
	// line and cannot wrap us, so the guard lives here.
	try {

		return build( wcs, note );

	} catch ( err ) {

		note( 'share-mount-failed', err );
		return null;

	}

}

function build( wcs, note ) {

	const button = document.getElementById( 'wcsShareButton' );
	const toast = document.getElementById( 'wcsShareToast' );
	if ( ! button ) return null;

	const api = wcs && typeof wcs === 'object' ? wcs : {};

	function design() {

		try {

			return typeof api.design === 'function' ? api.design() : {};

		} catch ( err ) {

			note( 'share-design-read-failed', err );
			return {};

		}

	}

	// ------------------------------------------------------------------
	// The two strings.
	// ------------------------------------------------------------------

	/** The canonical share link: nothing in it but the design. */
	function shareURL( d ) {

		const loc = window.location;
		return loc.origin + loc.pathname + '?c=' + encode( d );

	}

	/**
	 * The address bar: the URL as it arrived, with `c` brought up to date. One
	 * parameter changes; ?q=, ?style= and the fragment are left alone.
	 */
	function addressURL( d ) {

		const u = new URL( window.location.href );
		u.searchParams.set( 'c', encode( d ) );
		return u.toString();

	}

	// ------------------------------------------------------------------
	// The address-bar writer.
	// ------------------------------------------------------------------

	let lastWritten = null;

	function writeAddress( d ) {

		try {

			const next = addressURL( d );
			// Two guards, and both matter. The string guard means a design change
			// that does not change the encoding - a slider nudged back to where it
			// started - costs no history write at all. replaceState rather than
			// pushState means twenty changes leave history.length untouched, so
			// Back still goes wherever the visitor came from.
			if ( next === lastWritten || next === window.location.href ) return;
			window.history.replaceState( window.history.state, '', next );
			lastWritten = next;

		} catch ( err ) {

			// A sandboxed iframe refuses replaceState. The button still works and
			// the page is still correct; only the live URL stops tracking.
			note( 'share-address-write-failed', err );

		}

	}

	// ------------------------------------------------------------------
	// The clipboard.
	// ------------------------------------------------------------------

	let toastTimer = 0;
	let fadeTimer = 0;

	function say( text ) {

		if ( ! toast ) return;
		clearTimeout( toastTimer );
		clearTimeout( fadeTimer );
		toast.classList.remove( 'is-going' );
		toast.textContent = text;
		toastTimer = setTimeout( () => {

			toast.classList.add( 'is-going' );
			fadeTimer = setTimeout( () => {

				toast.textContent = '';
				toast.classList.remove( 'is-going' );

			}, FADE_MS );

		}, TOAST_MS );

	}

	/**
	 * The fallback for a browser that has no async clipboard, or that refuses it
	 * over plain http on a LAN address. A hidden textarea plus execCommand still
	 * works everywhere, and a share button that says "copied" when it did not is
	 * worse than one that hands you the link to copy yourself.
	 */
	function legacyCopy( text ) {

		const ta = document.createElement( 'textarea' );
		ta.value = text;
		ta.setAttribute( 'readonly', '' );
		// Off-screen but not display:none: a hidden element cannot be selected.
		ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
		document.body.appendChild( ta );

		try {

			ta.select();
			ta.setSelectionRange( 0, text.length );
			return document.execCommand( 'copy' );

		} catch ( err ) {

			return false;

		} finally {

			ta.remove();

		}

	}

	function copy() {

		const d = design();
		const url = shareURL( d );

		// Built and handed over synchronously, on the gesture (see the header).
		let wrote = false;

		try {

			if ( navigator.clipboard && typeof navigator.clipboard.writeText === 'function' ) {

				wrote = true;
				navigator.clipboard.writeText( url ).then( () => {

					say( 'Link copied. ' + describe( d ) );

				} ).catch( ( err ) => {

					note( 'share-clipboard-refused', err );
					if ( legacyCopy( url ) ) say( 'Link copied. ' + describe( d ) );
					else say( url );

				} );

			}

		} catch ( err ) {

			note( 'share-clipboard-failed', err );
			wrote = false;

		}

		if ( ! wrote ) {

			if ( legacyCopy( url ) ) say( 'Link copied. ' + describe( d ) );
			else say( url );

		}

		// The address bar is brought level with the copy in the same press, so
		// what a visitor sees in the URL is what is on their clipboard.
		writeAddress( d );
		return url;

	}

	button.addEventListener( 'click', copy );

	// ------------------------------------------------------------------
	// Live binding.
	// ------------------------------------------------------------------

	try {

		if ( typeof api.onDesign === 'function' ) api.onDesign( writeAddress );

	} catch ( err ) {

		note( 'share-subscribe-failed', err );

	}

	// And once now, so the very first frame's URL already carries the chime on
	// screen. This is what makes the count finite even for a visitor who never
	// presses anything: select the address bar, copy, send.
	writeAddress( design() );

	return {
		url: () => shareURL( design() ),
		copy,
		refresh: () => writeAddress( design() )
	};

}
