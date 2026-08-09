/**
 * plate.js - the backdrop image, and the ground it is allowed to catch a
 * shadow on.
 *
 * A plate place's world is a photograph. This file draws it, and nothing else
 * in the renderer has to know that: the quad is written in CLIP SPACE, so it
 * ignores the camera entirely and covers the frame whatever the projection,
 * the zoom or the window does. That is what CONTRACTS 5.1 means by "a screen
 * space quad so the projection never touches it".
 *
 *
 * WHY THE MAPPING IS WORLD-LOCKED AND NOT A COVER FIT
 *
 * The obvious thing - fit the image to the viewport like CSS `background-size:
 * cover` - is wrong here, and wrong in a way that is invisible until someone
 * resizes the window. A cover fit scales the picture with the viewport while
 * the chime, which lives in an orthographic frustum of a fixed height in
 * metres, does not. Widen the window and the trees would grow and the chime
 * would not.
 *
 * So the plate carries its own size IN METRES (`backdrop.world`) and the crop
 * is solved from that against the camera's frustum:
 *
 *     visible world  = viewHeight * aspect  by  viewHeight
 *     visible plate  = that, divided by the plate's own metres
 *
 * Widen the window and you see MORE FOREST at the same scale, which is what a
 * window is. The trees hold their size against the tubes forever.
 *
 *
 * HANG IS THE PLATE MOVING, NEVER THE CHIME (CONTRACTS Rule A)
 *
 * `setFraming(u, v, scale)` slides and zooms the crop. `u`/`v` are the point of
 * the image that ends up under the object, 0 = left / top; `scale` is how big
 * the chime reads, so a bigger chime means a smaller world and therefore MORE
 * plate on screen. The centre is clamped so the crop can never walk off the
 * image - which means the pan range narrows as the chime grows, because the
 * margin is being spent on the zoom. `limits()` reports what is actually
 * reachable right now so the hang control can show the truth rather than the
 * authored ideal.
 *
 *
 * COLOUR
 *
 * The texture is loaded with NO colour space and the shader writes it straight
 * out. The plate is already sRGB bytes and the framebuffer wants sRGB bytes, so
 * the honest thing is to touch neither: the WebP is reproduced pixel for pixel.
 * Storybook sets `toneMapping: 'none'` and `bloom: false`, so there is no post
 * chain in the way of that. If a plate place is ever given a toned, bloomed
 * style, this shader has to grow a linear conversion - the assert is in
 * tools/verify-place.mjs.
 */

import * as THREE from 'three';

const VERT = `
varying vec2 vUv;
void main() {
	vUv = uv;
	// Clip space directly. No modelViewMatrix, no projectionMatrix: the quad is
	// the frame, and a camera that moves, zooms or changes projection cannot
	// touch it. z = 1.0 puts it on the far plane for anything that does depth
	// test against it; depthTest is off anyway.
	gl_Position = vec4( position.xy, 1.0, 1.0 );
}
`;

const FRAG = `
uniform sampler2D uMap;
uniform vec4 uRect;      // cx, cy, hx, hy   in plate space, cy/hy measured from the TOP
uniform vec3 uTint;
uniform float uHasMap;
varying vec2 vUv;
void main() {
	if ( uHasMap < 0.5 ) {
		gl_FragColor = vec4( uTint, 1.0 );
		return;
	}
	float tx = uRect.x - uRect.z + 2.0 * uRect.z * vUv.x;
	float ty = uRect.y - uRect.w + 2.0 * uRect.w * ( 1.0 - vUv.y );
	gl_FragColor = vec4( texture2D( uMap, vec2( tx, 1.0 - ty ) ).rgb, 1.0 );
}
`;

const clamp = ( v, lo, hi ) => ( v < lo ? lo : ( v > hi ? hi : v ) );

/**
 * @param {object} ctx  the stage's rendering context:
 *                      { scene, container, canvas, viewHeight: () => number }.
 *                      Named `stage` in CONTRACTS 2.2; it is called from inside
 *                      createStage, before the stage object literal exists, so
 *                      it takes the three handles it actually needs instead.
 * @param {object} place a PlaceDescriptor from places.js with kind === 'plate'.
 * @param {function} [onError] (tag) => void. Called once if the image will not
 *                      load. The caller falls back to another place; this file
 *                      never decides that on its own.
 */
export function createPlate( ctx, place, onError ) {

	const scene = ctx.scene;
	const container = ctx.container;
	const back = place.backdrop;
	const worldW = back.world ? back.world[ 0 ] : 1;
	const worldH = back.world ? back.world[ 1 ] : 1;
	const anchorU = back.anchor ? back.anchor[ 0 ] : 0.5;
	const anchorV = back.anchor ? back.anchor[ 1 ] : 0.5;

	let u = place.hang.default.u;
	let v = place.hang.default.v;
	let scale = place.hang.default.scale;
	let disposed = false;

	// -- the quad ------------------------------------------------------------
	// Two triangles in clip space. A PlaneGeometry would do, but this is four
	// vertices with no matrix behind them and it makes the clip-space vertex
	// shader read as deliberate rather than as a plane that happens to be at
	// the origin.
	const geo = new THREE.BufferGeometry();
	geo.setAttribute( 'position', new THREE.BufferAttribute( new Float32Array( [
		- 1, - 1, 0, 1, - 1, 0, 1, 1, 0, - 1, 1, 0
	] ), 3 ) );
	geo.setAttribute( 'uv', new THREE.BufferAttribute( new Float32Array( [
		0, 0, 1, 0, 1, 1, 0, 1
	] ), 2 ) );
	geo.setIndex( [ 0, 1, 2, 0, 2, 3 ] );

	const uniforms = {
		uMap: { value: null },
		uRect: { value: new THREE.Vector4( anchorU, anchorV, 0.5, 0.5 ) },
		uTint: { value: new THREE.Color( back.tint === undefined ? 0x000000 : back.tint ) },
		uHasMap: { value: 0 }
	};

	const mat = new THREE.ShaderMaterial( {
		uniforms,
		vertexShader: VERT,
		fragmentShader: FRAG,
		depthTest: false,
		depthWrite: false,
		// The scene has fog (storybook authors zero density, golden does not) and
		// FogExp2 is applied to every mesh unconditionally, so a backdrop that
		// opted in would drift toward the fog colour as the wind rose while the
		// forest behind it stayed crisp. It is a backdrop; it is not in the air.
		fog: false,
		toneMapped: false
	} );

	const mesh = new THREE.Mesh( geo, mat );
	// Nothing about a clip-space quad survives a frustum test against a camera
	// it does not use, and nothing may draw before it.
	mesh.frustumCulled = false;
	mesh.renderOrder = - 10000;
	mesh.name = 'wcs-plate';
	scene.add( mesh );

	// -- the shadow catcher --------------------------------------------------
	// Removing the ground plane removes the only large shadow receiver in the
	// scene (H18), and without one the chime reads as a sticker on a photograph.
	// ShadowMaterial draws the shadow and nothing else, so the plate shows
	// through everywhere the light is not blocked.
	let catcher = null;
	let catcherGeo = null;
	let catcherMat = null;
	if ( place.shadow && place.shadow.catcher ) {

		catcherGeo = new THREE.PlaneGeometry( 24, 24 );
		catcherMat = new THREE.ShadowMaterial( { opacity: place.shadow.opacity } );
		catcher = new THREE.Mesh( catcherGeo, catcherMat );
		catcher.rotation.x = - Math.PI / 2;
		catcher.position.y = place.shadow.y || 0;
		catcher.receiveShadow = true;
		catcher.name = 'wcs-plate-catcher';
		scene.add( catcher );

	}

	// -- the image -----------------------------------------------------------
	// Asynchronous, and deliberately not awaited anywhere: nothing above
	// startLoop() in main.js awaits and that is the property the first paint
	// depends on (H4). Until the bytes land the quad paints the place's own
	// tint, so the first frame is a dark forest green with the chime already
	// swinging in it rather than a white flash or a blank canvas.
	let texture = null;
	let reported = false;
	const loader = new THREE.TextureLoader();
	loader.load(
		back.src,
		( tex ) => {

			if ( disposed ) { tex.dispose(); return; }
			// Raw bytes in, raw bytes out. See the colour note at the top.
			tex.colorSpace = THREE.NoColorSpace;
			tex.magFilter = THREE.LinearFilter;
			tex.minFilter = THREE.LinearMipmapLinearFilter;
			tex.generateMipmaps = true;
			// The crop can sit hard against an edge, and a wrapped texel from the
			// far side of a forest is a visible seam.
			tex.wrapS = THREE.ClampToEdgeWrapping;
			tex.wrapT = THREE.ClampToEdgeWrapping;
			// A 69 % crop of a 2560 px plate lands near 1:1 on a 1440 px window,
			// but a phone in portrait shows a narrow strip and a 4K window shows a
			// wide one, so the sampler is doing real work in both directions.
			if ( ctx.maxAnisotropy ) tex.anisotropy = Math.min( 8, ctx.maxAnisotropy );
			texture = tex;
			uniforms.uMap.value = tex;
			uniforms.uHasMap.value = 1;

		},
		undefined,
		() => {

			if ( reported || disposed ) return;
			reported = true;
			if ( typeof onError === 'function' ) onError( 'place-asset-failed' );

		}
	);

	// -- framing -------------------------------------------------------------

	/**
	 * The crop, solved fresh every time. Half-sizes first, because they are what
	 * decides how far the centre is allowed to travel.
	 */
	function solve() {

		const w = Math.max( 1, container.clientWidth || 1 );
		const h = Math.max( 1, container.clientHeight || 1 );
		const vh = ctx.viewHeight();
		// Metres of world on screen, then that as a fraction of the plate. Capped
		// at the whole image: a window wider than the plate was rendered for, or a
		// chime scaled past the margin, shows all of it rather than its edge.
		const hx = Math.min( 1, ( vh * ( w / h ) * scale ) / worldW ) * 0.5;
		const hy = Math.min( 1, ( vh * scale ) / worldH ) * 0.5;
		const cx = clamp( u, hx, 1 - hx );
		const cy = clamp( v, hy, 1 - hy );
		return { hx, hy, cx, cy };

	}

	function push() {

		const r = solve();
		uniforms.uRect.value.set( r.cx, r.cy, r.hx, r.hy );

	}

	push();

	return {

		/** The mesh, for anything that needs to know the plate is there. */
		mesh,
		catcher,

		/**
		 * CONTRACTS Rule A: this moves the PLATE. The chime is at the origin and
		 * stays there.
		 */
		setFraming( nextU, nextV, nextScale ) {

			const hangRange = place.hang;
			if ( Number.isFinite( nextU ) ) u = clamp( nextU, hangRange.uRange[ 0 ], hangRange.uRange[ 1 ] );
			if ( Number.isFinite( nextV ) ) v = clamp( nextV, hangRange.vRange[ 0 ], hangRange.vRange[ 1 ] );
			if ( Number.isFinite( nextScale ) ) scale = clamp( nextScale, hangRange.scaleRange[ 0 ], hangRange.scaleRange[ 1 ] );
			push();

		},

		/** What the visitor can actually reach at this window size and scale. */
		limits() {

			const r = solve();
			return {
				u: [ Math.max( place.hang.uRange[ 0 ], r.hx ), Math.min( place.hang.uRange[ 1 ], 1 - r.hx ) ],
				v: [ Math.max( place.hang.vRange[ 0 ], r.hy ), Math.min( place.hang.vRange[ 1 ], 1 - r.hy ) ],
				scale: place.hang.scaleRange.slice(),
				crop: [ r.cx, r.cy, r.hx, r.hy ]
			};

		},

		framing() {

			return { u, v, scale };

		},

		/** The viewport changed, so the crop did. Called from scene.js's resize. */
		resize: push,

		loaded() {

			return uniforms.uHasMap.value === 1;

		},

		dispose() {

			disposed = true;
			scene.remove( mesh );
			geo.dispose();
			mat.dispose();
			if ( texture ) { texture.dispose(); texture = null; }
			if ( catcher ) {

				scene.remove( catcher );
				catcherGeo.dispose();
				catcherMat.dispose();
				catcher = null;

			}

		}

	};

}
