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
 * THE FRAME, SOLVED RATHER THAN PICKED (and H14 with it)
 *
 * Four things have to be inside one orthographic frame at once, and only one
 * set of numbers holds all four. Writing the arithmetic down because the first
 * cut of this place got it wrong in a way a screenshot showed and a comment did
 * not.
 *
 * The camera looks from bearing 180 at 14 degrees down, so a world point P
 * lands at screen height h = 0.9703*(Py - Ty) - 0.2419*Pz above the middle of
 * the frame, where Ty is the aim height. The frame is viewHeight tall, so
 * everything has to sit inside +-viewHeight/2.
 *
 *   the hook          (0, 2.60, 0)     h = 0.9703*(2.60 - Ty)
 *   the limb over it  its own radius above that, plus room to read as a limb
 *   the object        1.08 m of plate, tubes and sail, centred near y = 1.50
 *   the shadow's tip  the top plate's shadow at a 68 degree sun reaches
 *                     z = +0.73 toward the camera, so h = -0.9703*Ty - 0.177
 *
 * And a fifth thing, which is not world at all: the page's own caption and pill
 * row are opaque and cover the bottom 11 % of the frame - measured, 802 to 880
 * of 900 at 1440x900 - so the usable bottom edge is -0.391*viewHeight, not
 * -0.5*viewHeight. A cast shadow behind the pill row is a cast shadow no critic
 * can judge, and criterion 5 asks one to.
 *
 * Solving the two together:
 *
 *     0.9703*Ty + 0.177          <= 0.391*V     the shadow tip clears the chrome
 *     0.9703*(2.69 - Ty) + 0.02  <= 0.500*V     the limb's top clears the frame
 *     ------------------------------------------------------------------
 *     V >= 3.16
 *
 * viewHeight 3.20 with Ty 1.078 is that, with a little slack. Measured on the
 * built page rather than predicted: the object is 35.4 % of the frame's height
 * at 1440x900 and 36.4 % at 390x844, and its centre sits 37.1 % and 38.5 % of
 * the way down. The bar's own watch is 39.8 % and 41.7 %. The frame that came
 * before this one measured 36.0 % / 32.1 % and 27.9 % / 37.0 % - so this is a
 * fifth of a point of height given up at desktop, five points gained at phone,
 * and the object finally owns the middle at both.
 *
 * There is no slack in the other direction: a taller frame shrinks the object,
 * a shorter one loses either the shadow or the thing the chime hangs from. 3.16
 * is a floor, not a preference.
 *
 * H14, and the shipped comment that used to be wrong about it: the two places
 * frame different amounts of world (3.20 m here, 2.60 on the porch), so the
 * frustum height CANNOT be what audio's distance gain reads or the chime would
 * change level the instant a visitor picks the other card. scene.js's
 * cameraDistance() now reports the STYLE's own frame height, which both places
 * share by construction, so the level is flat across a place switch and across
 * a phone being rotated. verify-place.mjs asserts it.
 *
 *
 * HOW THE PLATE'S WORLD SIZE IS USED
 *
 * `backdrop.world` is how many metres of world the image spans AT THE CHIME'S
 * DEPTH: 7.00 m across by 4.90 m tall. The visible frame is the camera's own
 * 3.20 m frustum, so at a 16:10 viewport the page shows 3.20 x 1.6 / 7.0 = 73 %
 * of the plate's width and 3.20 / 4.9 = 65 % of its height. The rest is the
 * margin `hang` pans and zooms inside. Because the mapping is world-locked
 * rather than a CSS-style cover fit, a wider window shows more forest at the
 * same scale instead of magnifying it - the trees never change size relative to
 * the chime, whatever the window does.
 *
 *
 * ARBITRATION 5's AUTHORED CAMERA, AND WHY THIS IS NOT IT
 *
 * ARBITRATION.md section 5 fixes a camera Myra flew herself:
 *
 *     eye 0.85, 1.02, 0.55    look 0.96, 0.39, -5.92    fov 52
 *
 * Resolved, that is a bearing of 181.0 degrees, an eye 1.02 m off the ground,
 * an aim 6.50 m away and 5.56 degrees below the horizon. It is a beautiful
 * frame and it was flown, rendered and looked at before this was written -
 * .gauntlet-bar/arb5-camera.jpg is that exact frame, and the second image
 * beside it is the same frame with metre-ticked poles standing on the path at
 * 2, 3 and 4.5 m so the arithmetic below can be read off a picture rather than
 * taken on trust.
 *
 * It cannot hold a wind chime, and the reason is geometry rather than taste.
 * The chime hangs from a hook at 2.60 m and throws its shadow on the ground at
 * 0 m, so any frame that contains both spans 2.60 m of world height before the
 * shadow's own reach is counted. From an eye at 1.02 m looking 5.56 degrees
 * DOWN, the frame's top edge at the depth that makes the object big enough to
 * be the subject sits at world y = 2.22 - the hook is 0.38 m above the picture,
 * which is precisely the cord-into-open-air defect section 5 was written to
 * stop. Pushing the chime far enough down the path for the hook to come into
 * shot puts it at 4.5 m, where the poles measure it at 16 % of the frame -
 * less than half the bar's watch. The two requirements pull opposite ways and
 * her camera cannot satisfy both.
 *
 * Section 5 says what to do about exactly this: "If this camera does not
 * contain one, find the nearest one that does and say so." So, saying so:
 *
 *   BEARING     181.0 authored, 180 shipped. A one-degree change, kept.
 *   FIELD       fov 52 authored. The plate ships from a 54.65 degree
 *               perspective frustum whose CENTRE crop is what the runtime
 *               shows, which is a 33 degree horizontal window on it - the
 *               capture is seen through a longer lens than she flew, because
 *               a 52 degree frame at this eye height is mostly near foliage.
 *   ELEVATION   5.56 degrees down authored, 14 shipped. This is the real
 *               deviation and it is the one the composite forces: at 5.56 the
 *               path underneath the object leaves the frame, and with it every
 *               pixel the cast shadow could land on.
 *   EYE HEIGHT  1.02 m authored, 2.31 m shipped, which is the height a 14
 *               degree look from 5.5 m implies. Not a walker's eye; a walker's
 *               eye holding a camera above their head. The Place card used to
 *               claim the first and now says the second.
 *
 * And the defect underneath the camera question, which no camera in this
 * capture fixes: THERE IS NO LIMB OVER THE PATH AT 2.6 m. The author's own
 * note is that only one direction was captured; the canopy that arches over
 * the path is 6 to 10 m away, where a chime is a smudge, and the near
 * vegetation is bank growth at the frame's edges. So the place brings its own:
 * `hanger` below is a real limb at the hook's height, lit by this place's sun,
 * casting into the same catcher as the chime. The cord ends on geometry.
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
		// One line, in the page's own voice, for the Place panel. It says "above"
		// because the plate camera stands at 2.31 m and looks 14 degrees down -
		// see the ARBITRATION 5 note at the top of this file. A card that claims
		// a walker's eye height while the picture is shot from over their head is
		// a small lie in the one sentence a stranger reads about the place.
		blurb: 'A cut through summer woodland, looking down the path from just above head height.',

		backdrop: Object.freeze( {
			src: 'assets/places/forest-path/plate.webp',
			width: 2560,
			height: 1792,
			// Metres of world the image spans at the chime's depth: [across, tall].
			world: Object.freeze( [ 7.00, 4.90 ] ),
			// Where the default frame's centre sits in the image, 0 = left / top.
			// This is the design's own default hang, so a cold load shows exactly
			// the frame the plate was composed for.
			//
			// 0.40, not the 0.42 the plate was rendered around: the frame was
			// raised 0.098 m and widened to 3.20 m so the hook at 2.60 m and the
			// limb over it come into shot. The plate itself did not have to move -
			// it spans world y from -1.86 to +3.04 and the frame (-0.57 .. +2.73)
			// is still inside it, which is why there is no re-render here.
			// v = (3.038 - Ty) / 4.9 with Ty = 1.078. The camera target and this
			// number are ONE FACT WRITTEN TWICE and have to move together, so
			// tools/verify-place.mjs fails the day they drift.
			anchor: Object.freeze( [ 0.50, 0.40 ] ),
			// What the page paints while the image is still arriving, and behind
			// it forever after. Sampled from the plate's own deep shade, so the
			// first frame is already the right colour rather than a white flash.
			tint: 0x1a2119,
			// Which STYLES row supplies the render idiom - and only the idiom.
			style: 'storybook',
			// THE CAPTURE ITSELF. A place with a `splat` draws the gaussians and
			// ignores `src` - the still above is kept as the poster a future
			// plate-first load can paint while these 11.4 MB are arriving.
			//
			// Myra's call, 2026-08-09, and the right one: a photograph cannot be
			// walked around. Orbit, zoom and pan only mean something when there
			// is somewhere to orbit to.
			splat: 'assets/places/forest-path/capture.sog',
			// WHAT THE AUTHOR ACTUALLY CAPTURED, which is not what ships.
			//
			// tanha's scene is 998,709 gaussians. The Quality panel's environment
			// slider is a fraction OF THIS NUMBER rather than of the file, so its
			// percentages mean something about the capture instead of something
			// about a build decision - 10 per cent is 99,871 whatever we ship.
			//
			// The file is the 35 per cent export because the whole one does not
			// render. Measured: 299,613 draws at 60 fps and 349,548 draws clean,
			// and 998,709 submits two million triangles at a steady 60 fps with
			// no errors and puts NOTHING on screen - then takes Chrome's
			// compositor with it, corrupting the tab bar and the address bar. Not
			// the sort (radial and planar both), not the harmonics (the 30 per
			// cent export carries the same three bands), not the thinning (a cold
			// load at full density fails the same way). Whatever the ceiling is,
			// it is below a million on this driver, and a place that can crash a
			// visitor's browser is not a place. So the slider stops at 35.
			fullGaussians: 998709,
			// Where the capture sits relative to the chime, which hangs at
			// physics.js HOOK = (0, 2.60, 0) and does not move (Rule A).
			//
			// The quaternion is the y-down flip every SOG capture needs.
			//
			// THIS POSE WAS PICKED, NOT SOLVED. It used to be [-0.85, 2.48, 9.15],
			// derived from the path surface reading about y = 0.39 in the
			// capture's own frame - correct arithmetic, and it hung the chime in
			// a thin part of the wood because nothing in that derivation knew
			// what was behind it. This is where Myra left it after clicking a
			// branch in the live page: read back off the browser as the base
			// pickOffset, with the u/v nudge taken out so a cold load with no
			// pick reproduces the same frame exactly.
			//
			// The y is the number that moved most, 2.48 to 0.786, because a
			// picked point sits wherever the branch was rather than wherever the
			// ground would have to be for the arithmetic to close.
			pose: Object.freeze( {
				position: Object.freeze( [ -0.851, 0.786, 4.682 ] ),
				quaternion: Object.freeze( [ 1, 0, 0, 0 ] ),
				scale: 1
			} ),
			// How far hang.u/v slide the capture, in metres either side of
			// centre. The chime stays nailed to the hook and the forest moves
			// behind it, which is Rule A implemented as a translation rather
			// than as a crop.
			reach: Object.freeze( { x: 3.2, y: 1.4 } )
		} ),

		// The light. `azDeg` is NOT free: scene.js's applySun reads the STYLE's
		// sunAzDeg and its body is off limits to this piece, so a plate place has
		// to be shot under the style's own bearing. Storybook's is 28, and the
		// capture's own tree shadows fall on a measured bearing of about 35 - a
		// 7 degree disagreement, well inside the 25 the criterion allows. The
		// number is recorded here so verify-place.mjs can fail the day the style
		// moves and nobody notices the shadows stopped agreeing.
		// Honest about which of these is measured and which is authored, because
		// the first version of this block was not and a critic was right to say
		// so. AZIMUTH IS MEASURED: the capture's own shadows run down and to the
		// left across the path on a bearing of about 35 degrees, and storybook
		// casts from 28 - a 7 degree disagreement, well inside the 25 the
		// criterion allows. ELEVATION IS AUTHORED, NOT MEASURED. Nothing in this
		// capture is a legible single shadow off a known height: it is broken
		// canopy light end to end, hot patches a hand's width from deep shade,
		// and the one candidate reference - the stump - has no crisp shadow to
		// measure. 68 degrees is the number the frame forces (see the frame
		// arithmetic at the top: a lower sun walks the cast shadow out of the
		// bottom edge, at 1/tan, so 27 degrees is 4.9 times the reach of 68).
		// It is written here as a choice rather than dressed up as a measurement.
		sun: Object.freeze( {
			// 70, Myra's, chosen against the capture with the chime's own shadows
			// finally switched on. 68 was solved when the only thing the angle
			// had to satisfy was keeping a CAST shadow inside the bottom edge of
			// a plate - see the frame arithmetic above, which is now history: a
			// capture place has no ground plane and casts nothing onto one. What
			// the angle does here is set how the light rakes across the object
			// itself, and that is a looking question rather than a solved one.
			elevDeg: 70,
			azDeg: 28,
			color: 0xfff4de,
			intensity: 1.62,
			// CONTRACTS 5.2 says sun.elevDeg is authored and fixed and the visitor
			// never sets it, but the shipped page has a live sun slider that P3
			// bound to the design and P6 puts in the URL - so "fixed" had to be
			// enforced somewhere or one drag produced a shareable link to a
			// picture this photograph cannot support. A place authoring its own
			// range is the seam CONTRACTS 6/P4 hands us: scene.js sunRange()
			// returns this, P3's slider reads it live, and apply.js clamps a
			// decoded ?c=..._su-27 into it. Wide enough to see the shading move,
			// narrow enough that the cast shadow stays in frame at both ends.
			range: Object.freeze( [ 63, 74 ] )
		} ),

		// The place's own bounce, sampled off the plate. This is the other half
		// of ARBITRATION 5's second defect: with a hemisphere light carrying the
		// scene's authored porch colours, nothing about this wood reached the
		// metal and the tubes read as an object photographed somewhere else.
		// `sky` is the canopy-filtered green that falls on everything here from
		// above; `ground` is the path's own warm grey bounce. Sampled from
		// plate.webp, not invented: the foliage band means (87,103,66) and the
		// lit path (150,144,128).
		fill: Object.freeze( {
			sky: 0xbcd3a0,
			ground: 0xa89e8c,
			intensity: 1.55
		} ),

		// A plate has no geometry to receive a shadow, so the place brings its
		// own: an invisible plane at the height of the path (H18).
		shadow: Object.freeze( {
			catcher: true,
			y: 0.0,
			// 0.32, near CONTRACTS 5.2's authored 0.34 and half what this place
			// first shipped. At 0.68 the catcher was not darkening the gravel, it
			// was painting over it: measured, the path's pixel-to-pixel standard
			// deviation fell from 21.1 to 7.1 inside the footprint and the
			// darkest pixel reached luminance 5.7 on a plate that reads 78.7
			// there. A shadow multiplies a surface; it does not replace it.
			opacity: 0.38,
			// Multiplier on the shadow map's PCF radius. The plate's own shadows
			// are soft-edged bands with the gravel fully visible through them,
			// and a 3 mm-per-texel hard edge next to them is the tell.
			softness: 7.0,
			// How far the catcher is allowed to darken a pixel that is ALREADY in
			// shade in the photograph, 0 = not at all. The capture's path is half
			// sunlit and half canopy shadow, and a hard sun shadow landing on
			// ground receiving no direct sun is the second thing a critic sees.
			// The catcher samples the plate underneath itself and fades out where
			// the photograph is already dark; this is the floor it fades to.
			shadeFloor: 0.12,
			// Plate luminance, 0..1, at which the ground counts as fully sunlit.
			litAt: 0.52,
			// Bigger than the porch's, for two reasons: the limb is 5.2 m long and
			// its shadow has to land inside the frustum, and a wider frustum means
			// bigger texels, which is free softness.
			halfExtent: Object.freeze( [ 4.6, 3.6 ] )
		} ),

		// WHAT THE CHIME HANGS FROM (ARBITRATION 5, defect 1).
		//
		// The capture does not contain a limb over the path at hook height and
		// no camera in it does - the reasoning is at the top of this file. So the
		// place carries one. It is a real mesh at the hook's own height, lit by
		// the sun above and casting into the catcher below, which is also what
		// puts something other than six tubes into the shadow on the path.
		//
		// The leaf clusters are not decoration. They sit UP-SUN of the object -
		// at 68 degrees elevation and a 28 degree bearing a shadow travels
		// (-0.19, +0.36) per metre of drop, so a leaf 1.4 m above a tube has to
		// be 0.27 m to its +x and 0.50 m to its -z to fall across it. That is
		// where they are, which is why most of them are above the top edge of
		// the frame and their shade is not.
		// THE LIMB IS GONE. It was scaffolding for a photograph: a still has
		// nothing at hook height for a cord to end on, so a branch had to be
		// modelled and lit to agree with a picture. The capture has a real
		// canopy, and a modelled limb in front of a photographed one looks
		// worse than no limb at all. Myra's call, 2026-08-09.
		//
		// What is left is what she asked for: the iron eye at the hook, and a
		// cord rising about two feet out of the top of it, ending where a rope
		// would disappear into leaves. splat.js builds both.
		//
		// No `z` here any more. It was -0.06, and it belonged to the limb: six
		// centimetres of clearance so a modelled branch did not grow through the
		// chime. Deleting the limb left the number behind, still being applied,
		// now to the eye alone - and the eye is the one thing that cannot be
		// moved, because the bridle meets at the hook and nowhere else. The
		// result was a ring the chime hung beside instead of under. splat.js
		// pins the eye to the hook and ignores a `z` if one is ever added back.
		hanger: Object.freeze( {
			cordLength: 0.61,
			cordColor: 0xcfc3ad,
			eye: Object.freeze( { radius: 0.030, tube: 0.0055, color: 0x2e2b27 } )
		} ),

		// Fixed, because the capture is one direction only - the author's own
		// note. Off axis there is nothing to see. `eye` is a DIRECTION from the
		// target, not a position: an orthographic eye's distance changes nothing
		// but clipping, which is scene.js's own convention for camPos.
		camera: Object.freeze( {
			// NOT fixed any more. The reason it was - "the capture is one
			// direction only, off axis there is nothing to see" - is true of the
			// far side and false of the near one, and it was being used to
			// justify a photograph. The orbit below is bounded so a visitor can
			// walk around the chime without swinging behind the capture's back.
			fixed: false,
			// THE OPENING SHOT, and it is applied now rather than ignored.
			//
			// These two were already here and were dead: applyPlaceCamera only
			// read azDeg/elevDeg on a FIXED place, so an orbitable one silently
			// fell back to the style's bearing of 52 - a view composed for a
			// porch, pointed at a wood. 180/14 was the authored guess; 186.8/4.2
			// is where Myra actually left the camera, read back off the browser,
			// looking down the path rather than across the canopy.
			//
			// Both are inside the orbit bounds below, and they have to be: this
			// is a starting pose, not a cage, and a start outside the arc the
			// visitor is allowed to reach would be snapped away on their first
			// drag.
			azDeg: 186.83,
			elevDeg: 4.22,
			// Ortho, so this is the frustum tightening rather than a dolly.
			// 0.85 of the authored 3.20 m frame is the crop that puts the path's
			// opening behind the chime.
			zoom: 0.846,
			eye: Object.freeze( [ 0, 0.24192, 0.97030 ] ),
			// Raised 0.30 m from the 0.98 the plate was rendered around, which is
			// what brings the hook and the limb into the picture. The plate's crop
			// centre (backdrop.anchor and hang.default.v) moved with it, by the
			// same 0.30 m expressed as 0.0612 of the plate's 4.9 m height, so the
			// photograph and the object still agree about where the ground is.
			target: Object.freeze( [ 0, 1.078, 0 ] ),
			// Solved, not picked. The arithmetic is at the top of this file: 3.16
			// is the smallest frame that holds the limb, the object and the tip of
			// its shadow CLEAR OF THE PAGE'S OWN CHROME, and the smallest frame is
			// the one that makes the object biggest. 3.20 is that with a little
			// slack. Portrait gets 0.10 m more because a phone's caption wraps to
			// three lines and the pill row is taller.
			viewHeight: 3.20,
			viewHeightPortrait: 3.30,
			fov: null,
			// Bounded, and the bounds are the capture's own geometry rather than
			// taste. tanha shot one direction, so the useful arc is the front
			// 140 degrees; past that the reconstruction thins out and you are
			// looking at the inside of a shell. Elevation stops short of
			// overhead for the same reason - there is no canopy data directly
			// above the camera path.
			orbit: Object.freeze( {
				azDeg: Object.freeze( [ - 70, 70 ] ),
				elevDeg: Object.freeze( [ 2, 46 ] ),
				zoom: Object.freeze( [ 0.6, 2.2 ] )
			} )
		} ),

		// The ranges are derived, not taste, and they are an AMENDMENT to
		// CONTRACTS 5.4 rather than a quiet deviation from it. 5.4 authored
		// u [0.28,0.72], v [0.18,0.58] and scale [0.75,1.45] before the plate
		// existed; here is the arithmetic that says what is actually reachable,
		// and P5's criterion 3 has to be read against 1.30 rather than 1.45.
		//
		// The visible crop is viewHeight x aspect metres of a 7.0 m plate across
		// and viewHeight of a 4.9 m plate down, so its centre can travel to
		// within half of that of either edge. At 16:9 the crop is 72 % of the
		// plate's width and u can reach 0.406; at 16:10, 0.366. 0.41 is the one
		// that survives both, and it is what verify-place.mjs holds this file to
		// at every viewport up to 1.8. 0.09 of the plate is 0.63 m of travel,
		// which is a quarter of the frame's width - the chime slides from the
		// middle of the path to the bank beside it. Down, the crop is 65 % of the plate's
		// height whatever the aspect, so v can reach 0.327 - and the frame was
		// raised to bring the limb into shot, so the default at 0.40 has 0.073 of
		// plate above it against 0.27 below. The range is asymmetric because the
		// picture is.
		//
		// Wider than about 21:9 the margin runs out and the pan pins toward the
		// middle. plate.js re-derives all of this live against the real viewport,
		// clamps to whichever is tighter, and reports the result through limits()
		// so the hang control can show what is actually reachable rather than the
		// authored ideal. A narrow window has less room; it never shows an edge.
		//
		// TOP OF v PULLED IN FROM 0.327 TO 0.36 - a range is judged by the picture
		// at its corners, not by how much margin the crop arithmetic allows. At
		// 0.33 the crop has 0.35 % of the plate left above it and the chime hangs
		// in the middle of the heavily defocused near canopy: it stays perfectly
		// sharp, it occludes the foreground, there is no midground behind the
		// tubes, and the wordmark lands on a blown-out grey blur. It is a frame
		// nobody would share, and the drag stopping cleanly at it does not help.
		// 0.36 is the highest hang that still puts sharp midground and the path's
		// opening behind the object; it costs 0.03 of 0.23 of travel. This is a
		// P4 table edited by P5, because P5's reach is what exposed it - declared
		// here and in the commit rather than left as drift.
		hang: Object.freeze( {
			uRange: Object.freeze( [ 0.41, 0.59 ] ),
			vRange: Object.freeze( [ 0.36, 0.56 ] ),
			scaleRange: Object.freeze( [ 0.75, 1.30 ] ),
			// scale 0.75, the bottom of the range above, because that is where
			// the chime was left after an evening of looking at it in the wood.
			// Tied to design.js DESIGN_DEFAULTS.hang by verify-place, so the two
			// move together or the build fails.
			default: Object.freeze( { u: 0.50, v: 0.40, scale: 0.75 } )
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
			intensity: 1.55,
			// null means "whatever the style's own SUN_LO..SUN_HI is". A built
			// world can take any light; it is the photograph that cannot.
			range: null
		} ),

		// null means "the style's own hemisphere colours", which are this scene's
		// authored porch light. A place only overrides the bounce when it has a
		// photograph to sample it from.
		fill: null,

		// The ground plane is the shadow receiver here, and it is already in the
		// scene. A second catcher on top of it would double every shadow.
		shadow: Object.freeze( {
			catcher: false,
			y: 0.0,
			opacity: 0,
			softness: 1.0,
			shadeFloor: 1.0,
			litAt: 0,
			halfExtent: Object.freeze( [ 3.4, 2.8 ] )
		} ),

		// Nothing to add: the porch already ships a beam, a post and an iron hook
		// and the chime hangs off them. This field exists so a plate place is not
		// a special case at the call site.
		hanger: null,

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
