/**
 * places.js - where the chime hangs.
 *
 * A place owns the WORLD: the backdrop, the sun, the shadow, the camera, the
 * hang ranges and the weather that is already blowing when you arrive. A style
 * (`scene.js` STYLES) owns the IDIOM: projection, tone mapping, bloom,
 * environment map and the tube material. That split is CONTRACTS Rule B and it
 * is what stops a visitor changing place and finding the chime made of
 * different metal. Both places below name the same style for exactly that
 * reason.
 *
 * This file is DATA plus one lookup. No DOM, no three.js, no imports at all, so
 * tools/verify-place.mjs can read it under plain node and check every number
 * against the arithmetic the runtime does with it.
 *
 *
 * THE ONE RULE THAT MAKES A PLACE SAFE (CONTRACTS 5.3, Rule A)
 *
 * The chime never moves. It hangs at physics.js HOOK_X/Y/Z = (0, 2.60, 0)
 * forever and scene.js's `chime` Group stays at identity. `hang.u/v/scale` move
 * and scale THE PLATE behind it. Everything downstream of that decision stays
 * correct for free: the frozen BRIDLE_CORD, the grab proxies parented to the
 * scene, the shadow frustum aimed at a fixed point, windviz's hard-coded world
 * extents, and - the one a visitor would actually hear - `cameraDistance()`,
 * which is the sole input to audio's distance gain.
 *
 *
 * WHY THE TWO PLACES REPORT SLIGHTLY DIFFERENT CAMERA DISTANCES (H14)
 *
 * `stage.cameraDistance()` returns the ORTHOGRAPHIC FRUSTUM HEIGHT in metres,
 * and audio.js turns it into `distGain = clamp(1.6 / max(0.8, d), 0.35, 1.0)`.
 * The porch frames 2.60 m; the forest path frames 3.00 m, so the chime is 15 %
 * smaller there and 1.2 dB quieter. That is the model working rather than
 * failing: distance gain exists to say how big the object is on screen, and in
 * the forest it IS smaller. The page already moves further than this when a
 * phone is rotated - the porch's own portrait frame is 3.50 m, which is 2.6 dB.
 *
 * What H14 actually warns about is the UNITS changing, because cameraDistance()
 * returns a frustum height for an orthographic camera and an eye distance for a
 * perspective one. Both places here are orthographic, so both numbers are
 * metres of frame and the comparison is honest.
 *
 * The 3.00 m frame is not taste either. The chime stands 2.05 m from the ground
 * to the top plate, the frame has to hold the object AND the ground its shadow
 * lands on AND a sliver of cord above it, and the page's own caption and pill
 * row cover the bottom sixth. At 2.60 m the cast shadow lands underneath the
 * caption; at 3.00 m it lands clear of it. Measured, not guessed.
 *
 *
 * HOW THE PLATE'S WORLD SIZE IS USED
 *
 * `backdrop.world` is how many metres of world the image spans AT THE CHIME'S
 * DEPTH: 7.00 m across by 4.90 m tall. The visible frame is the camera's own
 * 3.00 m frustum, so at a 16:10 viewport the page shows 3.0 x 1.6 / 7.0 = 69 %
 * of the plate's width and 3.0 / 4.9 = 61 % of its height. The rest is the
 * margin `hang` pans and zooms inside. Because the mapping is world-locked
 * rather than a CSS-style cover fit, a wider window shows more forest at the
 * same scale instead of magnifying it - the trees never change size relative to
 * the chime, whatever the window does.
 *
 *
 * THE ONE HONEST MISMATCH IN forest-path
 *
 * The runtime camera is orthographic (storybook's projection, and porch's).
 * The plate was rendered from a PERSPECTIVE camera 5.5 m back, because an
 * orthographic eye sits 40 m out and its rays traverse the entire near bush on
 * the way in - rendered that way this capture is an unreadable smear of leaves,
 * measured and screenshotted before this was written. Over the chime's own
 * 0.2 m of depth the two projections differ by 4 %, which is nothing. Over the
 * cast shadow, which reaches about 1 m toward the camera, they differ by about
 * a quarter of that shadow's length. The shadow's DIRECTION is identical in
 * both - the object sits on the principal axis - and direction is the thing
 * that has to agree with the plate's own light. Recorded here rather than
 * discovered later.
 */

/** The place a visitor who has never been here lands in. */
export const DEFAULT_PLACE_ID = 'forest-path';

/**
 * @typedef {Object} Place
 * @property {string} id            URL-safe, stable forever.
 * @property {string} name          Shown in the Place slot.
 * @property {'plate'|'procedural'} kind
 */

export const PLACES = Object.freeze( {

	// -------------------------------------------------------------------------
	// forest-path - a photograph with a chime hanging in it.
	// -------------------------------------------------------------------------
	'forest-path': Object.freeze( {
		id: 'forest-path',
		name: 'Forest path',
		kind: 'plate',
		// One line, in the page's own voice, for the Place panel.
		blurb: 'A cut through summer woodland, shot down the path at a walker’s eye height.',

		backdrop: Object.freeze( {
			src: 'assets/places/forest-path/plate.webp',
			width: 2560,
			height: 1792,
			// Metres of world the image spans at the chime's depth: [across, tall].
			world: Object.freeze( [ 7.00, 4.90 ] ),
			// Where the default frame's centre sits in the image, 0 = left / top.
			// This is the design's own default hang, so a cold load shows exactly
			// the frame the plate was composed for.
			anchor: Object.freeze( [ 0.50, 0.42 ] ),
			// What the page paints while the image is still arriving, and behind
			// it forever after. Sampled from the plate's own deep shade, so the
			// first frame is already the right colour rather than a white flash.
			tint: 0x1a2119,
			// Which STYLES row supplies the render idiom - and only the idiom.
			style: 'storybook',
			// ARBITRATION 4 authors this field now and loads nothing at runtime.
			// When the plate-first, gaussians-after upgrade lands, the .sog goes
			// here and the still is swapped for the live capture once it arrives.
			// A place with no `splat` is a plate place forever.
			splat: null
		} ),

		// The light. `azDeg` is NOT free: scene.js's applySun reads the STYLE's
		// sunAzDeg and its body is off limits to this piece, so a plate place has
		// to be shot under the style's own bearing. Storybook's is 28, and the
		// capture's own tree shadows fall on a measured bearing of about 35 - a
		// 7 degree disagreement, well inside the 25 the criterion allows. The
		// number is recorded here so verify-place.mjs can fail the day the style
		// moves and nobody notices the shadows stopped agreeing.
		sun: Object.freeze( {
			elevDeg: 68,
			azDeg: 28,
			color: 0xfff4de,
			intensity: 1.55
		} ),

		// A plate has no geometry to receive a shadow, so the place brings its
		// own: an invisible plane at the height of the path (H18). 68 degrees of
		// elevation is chosen as much for framing as for daylight - the sun is
		// behind the subject and to its right, so the shadow falls toward the
		// camera and to the left, and a lower sun throws it out of the bottom of
		// the frame entirely.
		shadow: Object.freeze( {
			catcher: true,
			y: 0.0,
			// Read off the shipped plate rather than picked: at 0.55 the tube
			// shadows disappeared into the path's own dappling, and a shadow a
			// critic cannot see on a screenshot is a shadow that is not there.
			opacity: 0.68,
			halfExtent: Object.freeze( [ 3.4, 2.8 ] )
		} ),

		// Fixed, because the capture is one direction only - the author's own
		// note. Off axis there is nothing to see. `eye` is a DIRECTION from the
		// target, not a position: an orthographic eye's distance changes nothing
		// but clipping, which is scene.js's own convention for camPos.
		camera: Object.freeze( {
			fixed: true,
			azDeg: 180,
			elevDeg: 14,
			eye: Object.freeze( [ 0, 0.24192, 0.97030 ] ),
			target: Object.freeze( [ 0, 0.98, 0 ] ),
			viewHeight: 3.00,
			viewHeightPortrait: 4.00,
			fov: null,
			orbit: null
		} ),

		// The ranges are derived, not taste. The visible crop is 3.0 x aspect
		// metres of a 7.0 m plate across and 3.0 of a 4.9 m plate down, so its
		// centre can travel to within half of that of either edge. The widest
		// aspect they are authored to survive is 16:9, where the crop is 77 % of
		// the plate's width and u can reach 0.381 - hence 0.39, not the 0.35 a
		// 16:10 window would allow. Vertically the crop does not depend on the
		// aspect at all, so 0.32 holds everywhere in landscape.
		//
		// Wider than 16:9 the margin runs out and the pan pins toward the middle.
		// plate.js re-derives all of this live against the real viewport, clamps
		// to whichever is tighter, and reports the result through limits() so the
		// hang control can show what is actually reachable rather than the
		// authored ideal. A narrow window has less room; it never shows an edge.
		//
		// Small numbers, large movement: 0.11 of the plate at a crop of 0.69 is
		// 16 % of the frame's width, which slides the chime most of the way from
		// the middle of the path to the bank beside it.
		hang: Object.freeze( {
			uRange: Object.freeze( [ 0.39, 0.61 ] ),
			vRange: Object.freeze( [ 0.32, 0.68 ] ),
			scaleRange: Object.freeze( [ 0.75, 1.30 ] ),
			default: Object.freeze( { u: 0.50, v: 0.42, scale: 1.00 } )
		} ),

		wind: Object.freeze( { mph: 9, dirDeg: 245, turbulence: 0.34 } ),

		// AUTHORED NOW, WIRED LATER. v1 reads `label` and nothing else: audio.js
		// is off limits this run and a ConvolverNode against 32 live voices is its
		// own piece. Nobody claims the place sounds different, because it does not.
		acoustic: Object.freeze( {
			label: 'open woodland',
			wet: 0.18,
			decayS: 1.1,
			damp: 2400
		} ),

		credit: Object.freeze( {
			title: 'Forest path',
			author: 'tanha',
			source: 'https://superspl.at/scene/2be1a75a',
			licence: 'CC BY 4.0',
			licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
			fetched: '2026-08-08'
		} ),

		fallback: 'porch'
	} ),

	// -------------------------------------------------------------------------
	// porch - the built scene, and the floor under everything.
	// -------------------------------------------------------------------------
	'porch': Object.freeze( {
		id: 'porch',
		name: 'The porch',
		kind: 'procedural',
		blurb: 'A sawn beam over a lawn, with bushes and a long afternoon shadow. Drag to walk around it.',

		backdrop: Object.freeze( {
			src: null,
			width: 0,
			height: 0,
			world: null,
			anchor: null,
			tint: 0xe9e3d3,
			style: 'storybook',
			splat: null
		} ),

		// 52 is storybook's own authored elevation, restated here so that coming
		// back from the forest restores the porch's light instead of leaving the
		// woodland's high sun over the lawn. A visitor who has actually moved the
		// sun slider keeps their angle either way: apply.js re-applies view.sun
		// after the place has changed.
		sun: Object.freeze( {
			elevDeg: 52,
			azDeg: 28,
			color: 0xfff4de,
			intensity: 1.55
		} ),

		// The ground plane is the shadow receiver here, and it is already in the
		// scene. A second catcher on top of it would double every shadow.
		shadow: Object.freeze( {
			catcher: false,
			y: 0.0,
			opacity: 0,
			halfExtent: Object.freeze( [ 3.4, 2.8 ] )
		} ),

		// Today's numbers, unchanged. This is the only place with a live orbit.
		camera: Object.freeze( {
			fixed: false,
			azDeg: null,
			elevDeg: null,
			eye: null,
			target: null,
			viewHeight: 2.60,
			viewHeightPortrait: 3.50,
			fov: null,
			orbit: Object.freeze( {
				azDeg: Object.freeze( [ - 180, 180 ] ),
				elevDeg: Object.freeze( [ 8, 80 ] ),
				zoom: Object.freeze( [ 0.55, 2.6 ] )
			} )
		} ),

		// Degenerate on purpose. A procedural world has a real size and there is
		// no plate to slide behind the object, so hanging is not a thing you can
		// do here. P5 shows the control disabled with the reason rather than
		// hiding it, which is the difference between "not here" and "broken".
		hang: Object.freeze( {
			uRange: Object.freeze( [ 0.5, 0.5 ] ),
			vRange: Object.freeze( [ 0.5, 0.5 ] ),
			scaleRange: Object.freeze( [ 1, 1 ] ),
			default: Object.freeze( { u: 0.50, v: 0.50, scale: 1.00 } )
		} ),

		wind: Object.freeze( { mph: 12, dirDeg: 270, turbulence: 0.30 } ),

		acoustic: Object.freeze( {
			label: 'open air',
			wet: 0.06,
			decayS: 0.5,
			damp: 4000
		} ),

		// Original work. Already covered by the repository's own NOTICE.
		credit: null,

		fallback: null
	} )

} );

/** Every place id, in the order the Place panel shows them. */
export const PLACE_IDS = Object.freeze( [ 'forest-path', 'porch' ] );

/**
 * Total. An unknown id, a number, null, or a string with no place behind it all
 * come back as the default place rather than as undefined - the Place slot, the
 * URL codec and a hand-typed `?c=v1_pl-atlantis` all reach this, and none of
 * them may be able to blank the page.
 *
 * @param {string} id
 * @returns {Place}
 */
export function resolvePlace( id ) {

	if ( typeof id === 'string' && Object.prototype.hasOwnProperty.call( PLACES, id ) ) return PLACES[ id ];
	return PLACES[ DEFAULT_PLACE_ID ];

}

/**
 * The place to fall back to when this one's asset will not load, resolved to a
 * real place and guaranteed not to be the one that just failed. A place whose
 * fallback is itself, or whose fallback also fails, lands on porch - which
 * needs no asset at all and therefore cannot fail the same way.
 *
 * @param {Place} place
 * @returns {Place}
 */
export function fallbackFor( place ) {

	const id = place && typeof place.fallback === 'string' ? place.fallback : 'porch';
	const next = resolvePlace( id );
	if ( next.id === ( place && place.id ) ) return PLACES.porch;
	return next;

}
