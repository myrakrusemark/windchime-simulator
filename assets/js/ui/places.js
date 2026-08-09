/**
 * ui/places.js - the contents of the Place panel, and the one line that tells
 * the stage which place the shared link asked for.
 *
 * It builds its own radiogroup rather than reusing P3's `.wcs-choice[data-path]`
 * convention, for a reason worth stating: slots.js generates those groups from
 * a frozen OPTION_SETS table and clears whatever markup it finds
 * (`group.textContent = ''`). A place picker authored in HTML would be wiped on
 * mount, silently, and the panel would come up empty. Owning the widget keeps
 * the two pieces out of each other's files, which is the whole point of the
 * marker regions.
 *
 * Each place is a card, not a chip: a place is the only choice on this page
 * that changes the whole picture, and it is worth a line of prose and a credit
 * for the person whose capture it is. The CC BY attribution has to reach
 * somebody who only ever receives the built page, and a markdown table in the
 * repository does not do that (ASSETS.md's own rule).
 */

import { PLACES, PLACE_IDS, resolvePlace } from '../places.js';

/**
 * @param {object} wcs   window.__wcs. design(), applyDesign(), onDesign(), stage.
 * @param {function} [noteError] main.js's error sink.
 * @returns {object|null} { refresh } or null if the markup is not on the page.
 */
export function mountPlaces( wcs, noteError ) {

	const note = typeof noteError === 'function' ? noteError : () => {};

	// A mount must not throw and must not await (CONTRACTS 2.3). If the picker
	// cannot be built the visitor loses the ability to change place and keeps a
	// complete, sounding chime in the default one.
	try {

		return build( wcs, note );

	} catch ( err ) {

		note( 'places-mount-failed', err );
		return null;

	}

}

function build( wcs, note ) {

	const api = wcs && typeof wcs === 'object' ? wcs : {};
	const host = document.getElementById( 'wcsPlaceChoice' );

	// -----------------------------------------------------------------------
	// The stage, first.
	//
	// createStage() boots in the default place because main.js's call site is
	// not ours to edit and cannot pass one. This is where a link that asked for
	// the other place is honoured - before startLoop(), so the first frame is
	// already right and nobody sees a switch. It also installs the error sink,
	// which drains anything the plate loader already reported: an image that
	// 404s can lose its race with this mount, and an error nobody was listening
	// for is exactly the one a verifier goes looking for.
	// -----------------------------------------------------------------------

	const stage = api.stage;
	if ( stage && typeof stage.onPlaceError === 'function' ) {

		stage.onPlaceError( ( tag ) => {

			note( tag, null );

			// The stage has already landed somewhere that works. Tell the design,
			// so the caption stops naming a place nobody is standing in and Share
			// stops handing out a link to a picture this build cannot draw. A
			// caption that lies is worse than a caption that admits a fallback -
			// it is the one sentence a stranger reads.
			try {

				const now = api.stage && api.stage.place ? api.stage.place().id : null;
				if ( now && typeof api.applyDesign === 'function' && api.design().place !== now ) {

					api.applyDesign( { place: now } );

				}

			} catch ( err ) {

				note( 'places-fallback-sync-failed', err );

			}

		} );

	}

	let wanted = 'forest-path';
	try {

		if ( typeof api.design === 'function' ) wanted = api.design().place;

	} catch ( err ) {

		note( 'places-design-read-failed', err );

	}

	if ( stage && typeof stage.setPlace === 'function' && typeof stage.place === 'function' ) {

		try {

			if ( stage.place().id !== resolvePlace( wanted ).id ) stage.setPlace( wanted );

		} catch ( err ) {

			note( 'places-boot-failed', err );

		}

	}

	// -----------------------------------------------------------------------
	// THE SHARED LINK, PUT BACK ON TOP OF THE PLACE.
	//
	// WCS:DESIGN-BOOT decodes ?c= and applies it BEFORE createStage runs, which
	// is what makes the first frame the shared chime with no network. The cost
	// is that every field whose only consumer is the stage was applied into a
	// stage that did not exist yet, and then overwritten by the place going up.
	// Two of them, both measured on a cold load before this was written:
	//
	//   view.sun   ?c=v1_su-30 came back with design().view.sun === 30 and
	//              stage.sunElevation() === 68. apply.js clamped 30 against a
	//              range that was still the sky-place [2,20] because no stage had
	//              answered yet, and then main.js:349 wrote the stage's own angle
	//              straight back over params (H12, named against this piece).
	//   hang       ?c=v1_hu-39_hs-75 came back with the design saying 0.39/0.75
	//              and plate.limits().crop reporting the untouched place default,
	//              because apply.js only calls setFraming when a hang field
	//              CHANGES and the first apply had no plate to change.
	//
	// This is the first moment all three exist at once - stage, plate and decoded
	// design - so this is where they are reconciled. applyDesign({}) is not a
	// no-op: it re-runs the sun clamp against the live place unconditionally.
	// The hang goes straight to the stage because applyDesign would compare it
	// against itself and skip.
	// -----------------------------------------------------------------------

	try {

		if ( typeof api.applyDesign === 'function' ) api.applyDesign( {} );

		const d = typeof api.design === 'function' ? api.design() : null;
		if ( d && d.hang && stage && typeof stage.setFraming === 'function' ) {

			stage.setFraming( d.hang.u, d.hang.v, d.hang.scale );

		}

		// And the sun written back at the angle the PLACE actually accepted.
		// design.js clamps view.sun to the structural 2..74 because it may not
		// import places.js; the place's own range is narrower, so a link asking
		// for 30 on the forest path renders at 63. Leaving the design on 30 means
		// design() and the picture disagree and Share hands out a number this
		// place will never draw. Canonicalising here costs one apply at boot and
		// makes the URL a description of what is on screen.
		// The range rather than the live elevation, because the live elevation is
		// one frame behind: frame() pushes params.sunElevDeg through
		// setSunElevation, so reading it back on the line after an apply reports
		// the angle that was up before the apply.
		if ( d && d.view && d.view.sun !== null && stage && typeof stage.sunRange === 'function' ) {

			const r = stage.sunRange();
			if ( Array.isArray( r ) && r.length === 2 ) {

				const c = Math.min( Math.max( d.view.sun, r[ 0 ] ), r[ 1 ] );
				if ( c !== d.view.sun ) api.applyDesign( { view: { sun: c } } );

			}

		}

	} catch ( err ) {

		note( 'places-boot-design-failed', err );

	}

	if ( ! host ) return null;

	// -----------------------------------------------------------------------
	// The cards.
	// -----------------------------------------------------------------------

	const buttons = [];

	for ( const id of PLACE_IDS ) {

		const p = PLACES[ id ];
		if ( ! p ) continue;

		const b = document.createElement( 'button' );
		b.type = 'button';
		b.className = 'wcs-place';
		b.setAttribute( 'role', 'radio' );
		b.setAttribute( 'aria-checked', 'false' );
		b.tabIndex = - 1;
		b.dataset.value = id;

		const name = document.createElement( 'span' );
		name.className = 'wcs-place-name';
		name.textContent = p.name;
		b.appendChild( name );

		const blurb = document.createElement( 'span' );
		blurb.className = 'wcs-place-blurb';
		blurb.textContent = p.blurb || '';
		b.appendChild( blurb );

		if ( p.credit && p.credit.author ) {

			// Not a link inside the button - a button may not contain one, and a
			// nested interactive element is a real keyboard trap rather than a
			// pedantic one. The link lives beside the group; this is the byline.
			const cred = document.createElement( 'span' );
			cred.className = 'wcs-place-credit';
			cred.textContent = 'Capture by ' + p.credit.author + ' · ' + p.credit.licence;
			b.appendChild( cred );

		}

		b.addEventListener( 'click', () => choose( id ) );
		host.appendChild( b );
		buttons.push( b );

	}

	// Roving tabindex, same keyboard contract as P3's chip groups: one Tab stop
	// for the group, arrows to move inside it, and moving inside it commits.
	host.addEventListener( 'keydown', ( e ) => {

		const keys = [ 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End' ];
		if ( keys.indexOf( e.key ) === - 1 ) return;
		if ( buttons.length === 0 ) return;
		const at = buttons.indexOf( document.activeElement );
		let next;
		if ( e.key === 'Home' ) next = 0;
		else if ( e.key === 'End' ) next = buttons.length - 1;
		else if ( e.key === 'ArrowRight' || e.key === 'ArrowDown' ) next = ( at + 1 + buttons.length ) % buttons.length;
		else next = ( at - 1 + buttons.length ) % buttons.length;
		e.preventDefault();
		buttons[ next ].focus();
		choose( buttons[ next ].dataset.value );

	} );

	function choose( id ) {

		try {

			if ( typeof api.applyDesign === 'function' ) api.applyDesign( { place: id } );

		} catch ( err ) {

			note( 'places-apply-failed', err );

		}

		refresh();

	}

	function refresh() {

		let live = 'forest-path';
		try {

			if ( typeof api.design === 'function' ) live = api.design().place;

		} catch ( err ) { /* the cards just stop tracking; the chime does not care */ }

		// What is actually up, which is not always what was asked for: a plate
		// that will not load falls through to porch, and the picker has to admit
		// that rather than keep a tick against a place nobody is standing in.
		try {

			const st = api.stage;
			if ( st && typeof st.place === 'function' ) live = st.place().id;

		} catch ( err ) { /* fall back to the design's own answer */ }

		let checked = null;
		for ( const b of buttons ) {

			const on = b.dataset.value === live;
			b.setAttribute( 'aria-checked', on ? 'true' : 'false' );
			b.tabIndex = on ? 0 : - 1;
			if ( on ) checked = b;

		}

		if ( ! checked && buttons.length ) buttons[ 0 ].tabIndex = 0;

	}

	if ( typeof api.onDesign === 'function' ) api.onDesign( refresh );
	refresh();

	return { refresh };

}
