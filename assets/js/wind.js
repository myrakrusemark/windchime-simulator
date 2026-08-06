// wind.js - the one wind field.
//
// Everything that moves because of wind reads this module and only this module:
// the sail, the tubes, the clapper, the airborne streaks, the leaves, the grass,
// the shrubs and the telltale ribbon. That shared-source rule is not tidiness,
// it is the reason a gust front physically crosses the frame and hits things in
// the order they stand in the flow.
//
// The field is layered, cheapest term first:
//
//   1. MEAN. A steady vector from the weather reading, scaled down near the
//      ground by the logarithmic wind profile. The chime at 2 m sees about 73
//      percent of the reported 10 m wind; the grass at 0.3 m sees 41 percent.
//   2. GUST. One scalar Ornstein-Uhlenbeck multiplier with a 6 second memory,
//      giving the minute-scale lull-build-surge that makes a breeze feel alive.
//      It is global, because a real gust at this scale is far larger than a
//      2 metre porch.
//   3. TURBULENCE. Three octaves of Perlin noise sampled in a frame of
//      reference that TRANSLATES DOWNWIND at the mean speed. That is Taylor's
//      frozen-turbulence hypothesis: eddies are assumed to be carried past the
//      observer faster than they evolve. It is what turns "everything surges at
//      once" into "a front arrives from upwind and sweeps across", which is the
//      single most important behaviour in this file.
//
// Units are metres, seconds and metres per second throughout. Miles per hour
// exist only in params, the weather module and the on-screen readout.

import {
	Vector3,
	DataTexture,
	RGBAFormat,
	UnsignedByteType,
	LinearFilter,
	ClampToEdgeWrapping,
	NoColorSpace,
	MathUtils
} from 'three';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';

// --- constants -------------------------------------------------------------

const MPH_TO_MS = 0.44704;
const DEG2RAD = Math.PI / 180;

// Surface roughness length for open grassland, and the 10 m anemometer height
// the weather service reports at. LOG_DENOM = ln((10 + z0) / z0), precomputed
// because sample() runs about 1200 times a frame.
const Z0 = 0.03;
const LOG_DENOM = 5.81234;

const GUST_TAU = 6.0;       // seconds of memory in the gust random walk
const GUST_MIN = 0.15;
const GUST_MAX = 2.60;

const DIR_TAU = 25.0;       // seconds of memory in the direction wander

// Weather arrives on a ramp, never a step, so the chime does not jolt when a
// fetch lands. tau 2.6 s puts 95 percent of the change inside 8 seconds.
const RAMP_TAU = 2.6;

// Turbulence octaves. Wavelengths in metres; amplitudes are fractions of the
// mean speed at the reference amplitude (params.turbulence === 0.30).
const OCTAVE_L = [ 2.40, 0.90, 0.35 ];
const OCTAVE_A = [ 0.55, 0.30, 0.15 ];
// Reciprocals, because sample() runs in the hot path and a divide is not free.
const OCTAVE_INV = [ 1 / 2.40, 1 / 0.90, 1 / 0.35 ];
const TURB_REFERENCE = 0.30;

// Three unequal offsets so the x, y and z components of a given octave are read
// from unrelated parts of the noise lattice instead of being the same wave.
const OFF_X = 0.0;
const OFF_Y = 71.3;
const OFF_Z = 143.7;

// Flow texture: a 64 x 64 slab of the horizontal field at grass height, handed
// to the grass and shrub vertex shaders so 9000 blades can read the wind
// without 9000 CPU samples.
const TEX_SIZE = 64;
const TEX_EXTENT = 32;      // metres covered, i.e. x and z in [-16, +16]
const TEX_HEIGHT = 0.30;    // sampled at grass-tip height
const TEX_SCALE = 12;       // m/s that maps to full deflection in the encoding
const TEX_TEXEL = TEX_EXTENT / TEX_SIZE;

const GUST_HISTORY_LEN = 60;
// One gust sample per update at 60 fps would give the sparkline a single second
// of history, which reads as noise. Sampling every 6th update covers about six
// seconds, which is roughly one gust cycle.
const GUST_HISTORY_STRIDE = 6;

const FLOW_TEXTURE_STRIDE = 3;  // rebake the 4096 texels on every 3rd call
const PUSH_STRIDE = 6;          // ~10 Hz ceiling on the slider-mirroring callback

const noise = new ImprovedNoise();

// --- helpers ----------------------------------------------------------------

function wrap360( deg ) {

	const d = deg % 360;
	return d < 0 ? d + 360 : d;

}

// Shortest signed angular distance from a to b, in degrees, in [-180, 180).
function shortestDelta( a, b ) {

	return ( ( ( b - a ) % 360 ) + 540 ) % 360 - 180;

}

function finiteOr( value, fallback ) {

	return Number.isFinite( value ) ? value : fallback;

}

/**
 * Logarithmic wind profile. Returns the fraction of the 10 m reference speed
 * present at height y. shear(2.05) = 0.729 at the top plate, shear(1.025) =
 * 0.612 at the sail, shear(0.30) = 0.413 in the grass. The grass genuinely
 * moves less than the chime, and that difference is a correct, readable detail
 * rather than something to compensate for.
 */
function shear( y ) {

	const h = y > 0 ? y : 0;
	return Math.log( ( h + Z0 ) / Z0 ) / LOG_DENOM;

}

/**
 * Box-Muller normal deviate with the second sample cached, so the pair of
 * transcendentals is amortised over two calls.
 */
let _spareGaussian = null;
function gaussian() {

	if ( _spareGaussian !== null ) {

		const s = _spareGaussian;
		_spareGaussian = null;
		return s;

	}

	let u = 0, v = 0;
	while ( u === 0 ) u = Math.random();
	while ( v === 0 ) v = Math.random();

	const r = Math.sqrt( - 2 * Math.log( u ) );
	const theta = 2 * Math.PI * v;
	_spareGaussian = r * Math.sin( theta );
	return r * Math.cos( theta );

}

// --- factory ----------------------------------------------------------------

/**
 * @param {object} params The shared Params object. Held BY REFERENCE and read
 *   every frame; wind.js writes only params.windSpeedMph and params.dirDeg, and
 *   only while ramping in a weather reading.
 */
export function createWind( params ) {

	// Live state object. Mutated in place, never replaced; everyone else treats
	// it as read-only.
	const state = {
		speedMph: finiteOr( params.windSpeedMph, 12 ),
		dirDeg: wrap360( finiteOr( params.dirDeg, 270 ) ),
		gust: 1.0,
		meanVec: [ 0, 0, 0 ],
		turbulence: finiteOr( params.turbulence, 0.30 ),
		time: 0
	};

	// Cached per-update so sample() does no trigonometry. flow is the unit
	// vector the air is BLOWING TOWARD, derived from the meteorological
	// FROM-bearing: flow = (-sin(dir), 0, cos(dir)). At the default 270 (from
	// the west) that is (+1, 0, 0), due east.
	let flowX = 1, flowZ = 0;
	let uBar = state.speedMph * MPH_TO_MS;   // mean speed at 10 m, m/s

	// Precomputed turbulence terms, refreshed once per update instead of per
	// sample. sweep is the distance the frozen eddy field has been carried
	// downwind since boot.
	let turbGain = 1;                        // OCTAVE_A scaling from params.turbulence
	let turbAmp = 0;                         // uBar * gust, the m/s the octaves multiply up to
	let sweepX = 0, sweepZ = 0;

	// Slow wander of the mean heading, held as a deviation from params.dirDeg so
	// the user's slider (or the weather) keeps ownership of the base bearing.
	let dirDev = 0;

	// Weather ramp targets. null means "nothing pending".
	let targetSpeedMph = null;
	let targetDirDeg = null;

	// Forced-gust hold, used by __wcs.gust() and the leaf-burst test.
	let gustHoldRemaining = 0;
	let gustHoldValue = 1;

	// Throttle for the slider-mirroring callback (see stepWeatherRamp).
	let pushCounter = 0;

	const gustHistory = new Float32Array( GUST_HISTORY_LEN );
	gustHistory.fill( 1.0 );
	let gustHistoryIndex = 0;
	let gustHistoryCounter = 0;

	let flowTextureCounter = 0;

	const flowData = new Uint8Array( TEX_SIZE * TEX_SIZE * 4 );
	const flowTexture = new DataTexture( flowData, TEX_SIZE, TEX_SIZE, RGBAFormat, UnsignedByteType );
	flowTexture.colorSpace = NoColorSpace;   // this is a vector field, not colour
	flowTexture.minFilter = LinearFilter;
	flowTexture.magFilter = LinearFilter;
	flowTexture.wrapS = ClampToEdgeWrapping;
	flowTexture.wrapT = ClampToEdgeWrapping;
	flowTexture.generateMipmaps = false;

	const flowInfo = { size: TEX_SIZE, extent: TEX_EXTENT, height: TEX_HEIGHT, scale: TEX_SCALE };

	// The bake resolves 0.5 m per texel, so by Nyquist the finest structure the
	// grid can carry has a 1.0 m wavelength. The 0.90 m and 0.35 m octaves are
	// below that: sampling them onto this grid does not add detail, it aliases
	// into slow fake ripples that would crawl across the lawn. So the bake uses
	// only the octaves the grid can actually represent, and the grass shader's
	// own per-blade flutter term supplies the finer scale instead. Skipping them
	// also cuts the bake from 9 noise lookups per texel to 2.
	const BAKE_MIN_L = 2 * TEX_TEXEL;
	let bakeOctaves = 0;
	while ( bakeOctaves < OCTAVE_L.length && OCTAVE_L[ bakeOctaves ] >= BAKE_MIN_L ) bakeOctaves ++;

	/**
	 * Refresh everything sample() depends on. Called once per update, so the hot
	 * path is pure arithmetic.
	 */
	function refreshDerived() {

		const rad = state.dirDeg * DEG2RAD;
		flowX = - Math.sin( rad );
		flowZ = Math.cos( rad );

		uBar = state.speedMph * MPH_TO_MS;

		state.meanVec[ 0 ] = flowX * uBar;
		state.meanVec[ 1 ] = 0;
		state.meanVec[ 2 ] = flowZ * uBar;

		state.turbulence = finiteOr( params.turbulence, TURB_REFERENCE );
		turbGain = state.turbulence / TURB_REFERENCE;
		turbAmp = uBar * state.gust;

		// NOTE: the Taylor sweep is INTEGRATED in update(), not computed here.
		// See advanceSweep for why the obvious closed form is wrong.

	}

	/**
	 * Taylor's frozen turbulence: the noise lattice is sampled in a frame that
	 * translates downwind at the mean speed, so eddies are carried past the
	 * scene rather than sitting still in world space. That is what makes a gust
	 * arrive as a FRONT that crosses the frame instead of everything surging at
	 * once, and it is the single most important behaviour in this file.
	 *
	 * It has to be integrated, not evaluated. The closed form sweep = flow *
	 * uBar * time looks equivalent and is not: flow turns a little every frame
	 * with the direction wander, and uBar moves whenever a slider or a weather
	 * ramp does, and multiplying that per-frame change by an ever-growing clock
	 * TELEPORTS the sample point by delta(flow*uBar) * time. The jump grows
	 * without bound with session age - about 0.02 m per frame at boot, 0.45 m
	 * per frame after eight minutes, against a finest octave wavelength of
	 * 0.35 m - so the eddies quietly dissolve into per-frame white noise and a
	 * long-lived tab stops showing the wind this module is documented to model.
	 * Measured: frame-to-frame correlation of the turbulent component fell 0.81
	 * -> 0.30 -> 0.03 at 0, 120 and 900 seconds of runtime.
	 *
	 * Accumulating the increment instead is continuous under a turning wind and
	 * a changing speed, and it keeps the sample coordinate bounded by the actual
	 * distance the air has travelled.
	 */
	function advanceSweep( dt ) {

		sweepX += flowX * uBar * dt;
		sweepZ += flowZ * uBar * dt;

	}

	/**
	 * The windFn contract. Writes the wind velocity in m/s at world point
	 * (x, y, z) into `out` and returns it. Never allocates, never returns null,
	 * safe below ground.
	 */
	function sample( out, x, y, z ) {

		const s = shear( y );

		let tx = 0, ty = 0, tz = 0;

		if ( turbGain > 0 && turbAmp > 0 ) {

			// Swept sample point, in the moving frame.
			const px = x - sweepX;
			const pz = z - sweepZ;

			for ( let k = 0; k < 3; k ++ ) {

				const inv = OCTAVE_INV[ k ];
				const qx = px * inv;
				const qy = y * inv;
				const qz = pz * inv;
				const a = OCTAVE_A[ k ] * turbGain;

				tx += a * noise.noise( qx + OFF_X, qy + OFF_X, qz + OFF_X );
				ty += a * noise.noise( qx + OFF_Y, qy + OFF_Y, qz + OFF_Y );
				tz += a * noise.noise( qx + OFF_Z, qy + OFF_Z, qz + OFF_Z );

			}

			// Turbulence near the ground is anisotropic: the vertical component
			// is suppressed by the surface, roughly sigma_w = 0.5 sigma_u. Without
			// this the motes bob like they are underwater.
			ty *= 0.5;

			tx *= turbAmp;
			ty *= turbAmp;
			tz *= turbAmp;

		}

		out.x = flowX * uBar * s * state.gust + tx;
		out.y = ty;
		out.z = flowZ * uBar * s * state.gust + tz;

		return out;

	}

	/**
	 * One step of the discrete-exact Ornstein-Uhlenbeck process for the gust
	 * multiplier. The exact form (rather than an Euler update) is stable at any
	 * step size, which matters because dt here is whatever the browser gives us.
	 */
	function stepGust( dt ) {

		if ( gustHoldRemaining > 0 ) {

			gustHoldRemaining -= dt;
			state.gust = MathUtils.clamp( gustHoldValue, GUST_MIN, GUST_MAX );
			return;

		}

		const sigmaG = 0.80 * finiteOr( params.turbulence, TURB_REFERENCE );
		const a = Math.exp( - dt / GUST_TAU );
		let g = 1 + ( state.gust - 1 ) * a + sigmaG * Math.sqrt( 1 - a * a ) * gaussian();
		state.gust = MathUtils.clamp( g, GUST_MIN, GUST_MAX );

	}

	/**
	 * Slow wander of the mean heading, also discrete-exact OU. Direction is
	 * steadier when it is windy: a 30 mph flow is going somewhere, a 3 mph one
	 * is just wandering around the garden.
	 */
	function stepDirection( dt ) {

		const sigma = MathUtils.lerp( 25, 4, MathUtils.clamp( state.speedMph / 12, 0, 1 ) );
		const a = Math.exp( - dt / DIR_TAU );
		dirDev = dirDev * a + sigma * Math.sqrt( 1 - a * a ) * gaussian();

	}

	/**
	 * Ease params.windSpeedMph and params.dirDeg toward the weather targets.
	 * This is the only place in the codebase besides main.js's slider handlers
	 * that writes those two keys.
	 */
	function stepWeatherRamp( dt ) {

		if ( targetSpeedMph === null && targetDirDeg === null ) return;

		const f = 1 - Math.exp( - dt / RAMP_TAU );
		let pushed = false;

		if ( targetSpeedMph !== null ) {

			const current = finiteOr( params.windSpeedMph, 12 );
			const delta = targetSpeedMph - current;

			if ( Math.abs( delta ) < 0.02 ) {

				params.windSpeedMph = targetSpeedMph;
				targetSpeedMph = null;

			} else {

				params.windSpeedMph = current + delta * f;

			}

			pushed = true;

		}

		if ( targetDirDeg !== null ) {

			const current = wrap360( finiteOr( params.dirDeg, 270 ) );
			// Ramp the SHORT way around the circle, so a swing from 350 to 10
			// crosses north rather than spinning the whole compass.
			const delta = shortestDelta( current, targetDirDeg );

			if ( Math.abs( delta ) < 0.1 ) {

				params.dirDeg = targetDirDeg;
				targetDirDeg = null;

			} else {

				params.dirDeg = wrap360( current + delta * f );

			}

			pushed = true;

		}

		if ( ! pushed || typeof params.__onWindPushed !== 'function' ) return;

		// The callback exists only to drag the sliders along with the ramp, so it
		// is a DOM write. Firing it 60 times a second for the 8 second ramp would
		// break the project's own rule about touching the DOM every frame, and a
		// slider cannot show a change smaller than its step anyway. Throttle to
		// about 10 Hz, but ALWAYS fire on the frame the ramp completes so the
		// control ends up showing the exact final value.
		const stillRamping = targetSpeedMph !== null || targetDirDeg !== null;
		pushCounter ++;

		if ( ! stillRamping || pushCounter >= PUSH_STRIDE ) {

			pushCounter = 0;
			params.__onWindPushed( params.windSpeedMph, params.dirDeg );

		}

	}

	function update( dt ) {

		const step = Number.isFinite( dt ) ? MathUtils.clamp( dt, 0, 0.100 ) : 0;

		if ( step > 0 ) {

			// Carry the frozen-turbulence frame forward on the flow and speed
			// this frame STARTED with, before anything below changes them. That
			// keeps the sweep a plain integral of velocity over time.
			advanceSweep( step );

			state.time += step;

			stepWeatherRamp( step );
			stepGust( step );

			// Read the base heading and speed back out of params AFTER the ramp,
			// so a slider move and a weather ramp both land the same way.
			state.speedMph = MathUtils.clamp( finiteOr( params.windSpeedMph, 12 ), 0, 60 );

			stepDirection( step );
			state.dirDeg = wrap360( finiteOr( params.dirDeg, 270 ) + dirDev );

			gustHistoryCounter ++;
			if ( gustHistoryCounter >= GUST_HISTORY_STRIDE ) {

				gustHistoryCounter = 0;
				gustHistory[ gustHistoryIndex ] = state.gust;
				gustHistoryIndex = ( gustHistoryIndex + 1 ) % GUST_HISTORY_LEN;

			}

		} else {

			// Paused, or the very first frame. Still track slider changes so the
			// picture matches the controls without waiting for the clock.
			state.speedMph = MathUtils.clamp( finiteOr( params.windSpeedMph, 12 ), 0, 60 );
			state.dirDeg = wrap360( finiteOr( params.dirDeg, 270 ) + dirDev );

		}

		refreshDerived();

	}

	function setWeather( speedMph, dirDeg ) {

		if ( Number.isFinite( speedMph ) ) {

			targetSpeedMph = MathUtils.clamp( speedMph, 0, 60 );

		}

		if ( Number.isFinite( dirDeg ) ) {

			targetDirDeg = wrap360( dirDeg );

		}

	}

	function setGust( mult, seconds ) {

		gustHoldValue = Number.isFinite( mult ) ? mult : 1;
		gustHoldRemaining = Number.isFinite( seconds ) ? Math.max( 0, seconds ) : 0;
		state.gust = MathUtils.clamp( gustHoldValue, GUST_MIN, GUST_MAX );
		// Release is implicit: once the hold expires the OU process resumes from
		// wherever it was forced to, so the wind decays back toward the mean over
		// its natural 6 second memory rather than snapping.

	}

	// shear at grass height is a constant; the whole slab sits at one altitude.
	const BAKE_SHEAR = shear( TEX_HEIGHT );

	function bakeFlowTexture() {

		let o = 0;

		// Hoisted out of the 4096-iteration loop.
		const baseX = flowX * uBar * BAKE_SHEAR * state.gust;
		const baseZ = flowZ * uBar * BAKE_SHEAR * state.gust;
		const qy = TEX_HEIGHT;
		const half = TEX_EXTENT / 2;

		for ( let j = 0; j < TEX_SIZE; j ++ ) {

			const worldZ = - half + ( j + 0.5 ) * TEX_TEXEL;
			const pz = worldZ - sweepZ;

			for ( let i = 0; i < TEX_SIZE; i ++ ) {

				const worldX = - half + ( i + 0.5 ) * TEX_TEXEL;
				const px = worldX - sweepX;

				// Horizontal components only - the shader decodes rg and never
				// asks for vertical velocity, so the y octaves are not computed.
				let tx = 0, tz = 0;

				if ( turbGain > 0 && turbAmp > 0 ) {

					for ( let k = 0; k < bakeOctaves; k ++ ) {

						const inv = OCTAVE_INV[ k ];
						const ax = px * inv, ay = qy * inv, az = pz * inv;
						const a = OCTAVE_A[ k ] * turbGain;

						tx += a * noise.noise( ax + OFF_X, ay + OFF_X, az + OFF_X );
						tz += a * noise.noise( ax + OFF_Z, ay + OFF_Z, az + OFF_Z );

					}

					tx *= turbAmp;
					tz *= turbAmp;

				}

				const vx = baseX + tx;
				const vz = baseZ + tz;
				const mag = Math.sqrt( vx * vx + vz * vz );

				// R and G carry the signed horizontal vector in [-scale, +scale];
				// B carries magnitude on a wider range so a shader can cheaply
				// read speed without decoding and re-normalising.
				flowData[ o ] = ( 255 * MathUtils.clamp( vx / TEX_SCALE * 0.5 + 0.5, 0, 1 ) + 0.5 ) | 0;
				flowData[ o + 1 ] = ( 255 * MathUtils.clamp( vz / TEX_SCALE * 0.5 + 0.5, 0, 1 ) + 0.5 ) | 0;
				flowData[ o + 2 ] = ( 255 * MathUtils.clamp( mag / ( TEX_SCALE * 2 ), 0, 1 ) + 0.5 ) | 0;
				flowData[ o + 3 ] = 255;

				o += 4;

			}

		}

		flowTexture.needsUpdate = true;

	}

	function updateFlowTexture() {

		// The coarsest octave has a 2.4 m scale, so it takes the better part of a
		// second to change meaningfully at walking pace. A 33 ms lag in the grass
		// is invisible, and skipping two frames in three turns a 0.6 ms bake into
		// a 0.2 ms average.
		flowTextureCounter ++;
		if ( flowTextureCounter < FLOW_TEXTURE_STRIDE ) return;
		flowTextureCounter = 0;

		bakeFlowTexture();

	}

	const wind = {
		state,
		flowTexture,
		flowInfo,
		gustHistory,
		update,
		sample,
		setWeather,
		setGust,
		updateFlowTexture,

		// wind.time is read directly by main.js when it drives viz.update; it is
		// the same clock as wind.state.time, exposed as a getter so the two can
		// never drift apart.
		get time() {

			return state.time;

		},

		// Ring-buffer write cursor for the HUD sparkline: the OLDEST sample sits
		// at this index.
		get gustHistoryIndex() {

			return gustHistoryIndex;

		}
	};

	// Prime the derived terms and the flow texture so frame 1 already has a
	// valid field and the grass shader is never handed an empty texture.
	refreshDerived();
	bakeFlowTexture();

	return wind;

}
