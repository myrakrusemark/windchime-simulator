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
 *
 *
 * THE THING IT HANGS FROM, AND THE LIGHT THAT FALLS THROUGH IT
 *
 * ARBITRATION 5 names two defects in the composite, and both of them live in
 * this file because both of them are the PLACE's business rather than the
 * chime's.
 *
 * 1. A cord that ends at the top edge of a photograph is a cord attached to
 *    nothing. This capture has no limb over the path at the hook's height and
 *    no camera in it does - the measurement is in places.js. So `hanger` builds
 *    one: a tapered limb whose underside meets physics.js's HOOK_Y, an iron eye
 *    at the hook itself, and leaf clusters on the limb. It is lit by the
 *    place's own sun and it casts into the same catcher, so the shadow on the
 *    path stops being six tubes floating on their own.
 *
 * 2. Evenly lit geometry sits ON a photograph rather than IN it. The leaves are
 *    the lever. They are placed UP-SUN of the object, which puts most of them
 *    above the top edge of the frame and all of their shade across the tubes -
 *    broken light, from the thing the chime is hanging in, at no cost beyond
 *    one alpha-tested draw. three's shadow pass honours `map` + `alphaTest`
 *    (WebGLShadowMap.getDepthMaterial), so the holes between the leaves are
 *    holes in the shadow map too.
 *
 *
 * WHY THE CATCHER IS NOT A PLAIN ShadowMaterial ANY MORE
 *
 * A ShadowMaterial darkens every pixel it covers by the same amount. On a
 * photograph of a path that is half sunlit and half canopy shadow, that paints
 * a hard sun shadow across ground receiving no direct sun - and it paints
 * rather than multiplies, because at any real opacity it swamps the gravel's
 * own texture. So the catcher samples the plate underneath itself, through the
 * IDENTICAL crop mapping the backdrop quad uses, and fades its own alpha out
 * where the photograph is already dark. Where the path is lit the shadow lands
 * at full strength; where the canopy already shades it, it fades to
 * `shadow.shadeFloor` of that.
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
 * A deterministic little PRNG. The leaf cluster has to be identical on every
 * load, because a shared URL that reproduces a different scatter of shade is a
 * shared URL that reproduces a different picture.
 */
function rng( seed ) {

	let s = seed >>> 0;
	return () => {

		s = ( s * 1664525 + 1013904223 ) >>> 0;
		return s / 4294967296;

	};

}

/**
 * One leaf, as an alpha mask. Procedural because CONTRACTS 8 forbids adding a
 * runtime dependency and a second image download for something 128 px square
 * would be one; a canvas costs nothing and cannot 404.
 *
 * RGB is left white and the colour comes from the material, so the same texture
 * can serve a place that authors a different foliage.
 */
function makeLeafTexture() {

	const N = 128;
	const cv = document.createElement( 'canvas' );
	cv.width = N;
	cv.height = N;
	const g = cv.getContext( '2d' );
	if ( ! g ) return null;
	g.clearRect( 0, 0, N, N );
	g.fillStyle = '#ffffff';

	// A pointed ellipse - two quadratic curves meeting at the tip and the stem -
	// which is what most broadleaf silhouettes reduce to at this size.
	g.beginPath();
	g.moveTo( N * 0.5, N * 0.04 );
	g.quadraticCurveTo( N * 0.97, N * 0.42, N * 0.5, N * 0.96 );
	g.quadraticCurveTo( N * 0.03, N * 0.42, N * 0.5, N * 0.04 );
	g.closePath();
	g.fill();

	// A midrib bitten out of it. Real foliage lets pinholes of sky through and a
	// solid blob casts a solid shadow, which is the thing being avoided.
	g.globalCompositeOperation = 'destination-out';
	g.lineWidth = N * 0.02;
	g.strokeStyle = '#000';
	for ( let i = 0; i < 5; i ++ ) {

		const t = 0.22 + i * 0.15;
		g.beginPath();
		g.moveTo( N * 0.5, N * t );
		g.lineTo( N * ( 0.5 + ( i % 2 ? 0.3 : - 0.3 ) ), N * ( t + 0.14 ) );
		g.stroke();

	}

	const tex = new THREE.CanvasTexture( cv );
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.generateMipmaps = true;
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	tex.magFilter = THREE.LinearFilter;
	return tex;

}

/**
 * A tube swept along a curve whose radius falls off along its length. three has
 * TubeGeometry, but its radius is constant, and constant radius is exactly what
 * makes a branch read as a pipe. Frenet frames come free from the curve, so the
 * only work here is the taper and the index buffer.
 *
 * @param {THREE.Curve} curve
 * @param {number} r0     radius at t = 0, the thick end
 * @param {number} taper  radius at t = 1, as a fraction of r0
 */
function sweptLimb( curve, r0, taper, segs, radial ) {

	const frames = curve.computeFrenetFrames( segs, false );
	const pos = new Float32Array( ( segs + 1 ) * ( radial + 1 ) * 3 );
	const nor = new Float32Array( ( segs + 1 ) * ( radial + 1 ) * 3 );
	const uv = new Float32Array( ( segs + 1 ) * ( radial + 1 ) * 2 );
	const idx = [];
	const P = new THREE.Vector3();
	const N = new THREE.Vector3();

	for ( let i = 0; i <= segs; i ++ ) {

		const t = i / segs;
		curve.getPointAt( t, P );
		// Cubic falloff, so the thinning is slow near the trunk and quick at the
		// tip - which is how a branch actually tapers.
		const r = r0 * ( 1 - ( 1 - taper ) * t * t * t );
		const nrm = frames.normals[ i ];
		const bin = frames.binormals[ i ];

		for ( let j = 0; j <= radial; j ++ ) {

			const a = j / radial * Math.PI * 2;
			const sx = Math.cos( a );
			const sy = Math.sin( a );
			N.set( nrm.x * sx + bin.x * sy, nrm.y * sx + bin.y * sy, nrm.z * sx + bin.z * sy );
			const o = ( i * ( radial + 1 ) + j ) * 3;
			pos[ o ] = P.x + N.x * r; pos[ o + 1 ] = P.y + N.y * r; pos[ o + 2 ] = P.z + N.z * r;
			nor[ o ] = N.x; nor[ o + 1 ] = N.y; nor[ o + 2 ] = N.z;
			uv[ ( i * ( radial + 1 ) + j ) * 2 ] = t;
			uv[ ( i * ( radial + 1 ) + j ) * 2 + 1 ] = j / radial;

		}

	}

	for ( let i = 0; i < segs; i ++ ) {

		for ( let j = 0; j < radial; j ++ ) {

			const a = i * ( radial + 1 ) + j;
			const b = a + radial + 1;
			idx.push( a, b, a + 1, b, b + 1, a + 1 );

		}

	}

	const geo = new THREE.BufferGeometry();
	geo.setAttribute( 'position', new THREE.BufferAttribute( pos, 3 ) );
	geo.setAttribute( 'normal', new THREE.BufferAttribute( nor, 3 ) );
	geo.setAttribute( 'uv', new THREE.BufferAttribute( uv, 2 ) );
	geo.setIndex( idx );
	return geo;

}

/**
 * The limb, the eye and the leaves, as three meshes in one group.
 *
 * Everything is authored in metres against physics.js's HOOK_Y, so the limb's
 * underside meets the cord's top wherever the place puts it. Nothing here
 * touches the chime: Rule A still holds, and this group is scene furniture the
 * same way the porch's beam is.
 */
function buildHanger( spec, leafTex ) {

	const g = new THREE.Group();
	g.name = 'wcs-hanger';
	const tilt = ( spec.tiltDeg || 0 ) * Math.PI / 180;
	const geoms = [];
	const mats = [];

	const bark = new THREE.MeshStandardMaterial( {
		color: spec.color,
		roughness: spec.roughness === undefined ? 0.95 : spec.roughness,
		metalness: 0
	} );
	mats.push( bark );

	// The limb. A straight cylinder of constant radius reads as a scaffold pole -
	// that was the first cut and a screenshot said so immediately. What makes it
	// a branch is that it is thick where it comes from the tree, thin where it
	// runs out, and SAGS in the middle, which is where the weight is hanging.
	// So it is swept along a curve with a per-ring radius rather than extruded.
	//
	// The curve is forced through (0, y, z) - the point directly over the hook -
	// so the underside meets the cord wherever the place moves it to.
	const half = spec.length / 2;
	const zz = spec.z || 0;
	const curve = new THREE.CatmullRomCurve3( [
		new THREE.Vector3( half, spec.y + half * Math.tan( - tilt ) + 0.14, zz - 0.34 ),
		new THREE.Vector3( half * 0.45, spec.y + half * 0.45 * Math.tan( - tilt ) + 0.02, zz - 0.14 ),
		new THREE.Vector3( 0, spec.y, zz ),
		new THREE.Vector3( - half * 0.5, spec.y - half * 0.5 * Math.tan( - tilt ) + 0.04, zz + 0.08 ),
		new THREE.Vector3( - half, spec.y - half * Math.tan( - tilt ) + 0.16, zz + 0.22 )
	] );
	const limbGeo = sweptLimb( curve, spec.radius, spec.taper === undefined ? 0.55 : spec.taper, 64, 10 );
	geoms.push( limbGeo );
	const limb = new THREE.Mesh( limbGeo, bark );
	limb.castShadow = true;
	limb.receiveShadow = true;
	g.add( limb );

	// Two twigs off it, so the silhouette forks. Both lean away from the camera,
	// which keeps them out of the object's own space.
	for ( const t of [
		{ u: 0.30, len: 0.92, rot: [ 0.55, 0, 0.85 ] },
		{ u: 0.68, len: 0.70, rot: [ - 0.42, 0, - 0.72 ] }
	] ) {

		const at = curve.getPointAt( t.u );
		const tw = new THREE.CylinderGeometry( spec.radius * 0.16, spec.radius * 0.42, t.len, 7 );
		geoms.push( tw );
		const m = new THREE.Mesh( tw, bark );
		m.position.set( at.x, at.y + t.len * 0.36, at.z );
		m.rotation.set( t.rot[ 0 ], t.rot[ 1 ], t.rot[ 2 ] );
		m.castShadow = true;
		g.add( m );

	}

	// The iron eye at the hook. Small, dark, and exactly where physics hangs the
	// bridle from, so the cord passes through a thing rather than stopping in
	// mid-air a few centimetres under a branch.
	if ( spec.eye ) {

		const eyeGeo = new THREE.TorusGeometry( spec.eye.radius, spec.eye.tube, 8, 20 );
		geoms.push( eyeGeo );
		const eyeMat = new THREE.MeshStandardMaterial( {
			color: spec.eye.color, roughness: 0.55, metalness: 0.65
		} );
		mats.push( eyeMat );
		const eye = new THREE.Mesh( eyeGeo, eyeMat );
		// HOOK_Y. Mirrored from physics.js, which is read-only to this piece.
		eye.position.set( 0, 2.60 + spec.eye.radius * 0.55, spec.z || 0 );
		eye.castShadow = true;
		g.add( eye );

	}

	// The leaves. One merged geometry across every cluster, so the whole canopy
	// is one draw call and one alpha test however many clusters a place authors.
	//
	// Two clusters, doing two different jobs. The SHADE cluster sits up-sun and
	// above the top edge: it is never seen and its only output is the broken
	// light it throws down the tubes and across the path. The SPRAY cluster
	// hangs off the limb inside the frame, where its job is the opposite - it is
	// seen and casts almost nothing, and it exists because a bare swept tube
	// crossing the top of a photograph reads as a scaffold pole no matter how
	// well it is tapered. Foliage on it is what makes it a branch.
	const clusters = Array.isArray( spec.leaves ) ? spec.leaves : ( spec.leaves ? [ spec.leaves ] : [] );
	const total = clusters.reduce( ( a, c ) => a + ( c.count | 0 ), 0 );
	if ( total > 0 && leafTex ) {

		const n = total;
		const pos = new Float32Array( n * 4 * 3 );
		const nor = new Float32Array( n * 4 * 3 );
		const uv = new Float32Array( n * 4 * 2 );
		const idx = new Uint16Array( n * 6 );
		const rnd = rng( 0x5eed1eaf );
		const q = new THREE.Quaternion();
		const e = new THREE.Euler();
		const v = new THREE.Vector3();
		const nv = new THREE.Vector3();
		const corners = [ [ - 0.5, - 0.5 ], [ 0.5, - 0.5 ], [ 0.5, 0.5 ], [ - 0.5, 0.5 ] ];
		const uvs = [ [ 0, 0 ], [ 1, 0 ], [ 1, 1 ], [ 0, 1 ] ];
		let i = 0;

		for ( const L of clusters ) {

			for ( let c = 0; c < ( L.count | 0 ); c ++, i ++ ) {

				const cx = L.at[ 0 ] + ( rnd() - 0.5 ) * 2 * L.spread[ 0 ];
				const cy = spec.y + L.at[ 1 ] + ( rnd() - 0.5 ) * 2 * L.spread[ 1 ] + Math.sin( tilt ) * - cx;
				const cz = ( spec.z || 0 ) + L.at[ 2 ] + ( rnd() - 0.5 ) * 2 * L.spread[ 2 ];
				e.set( rnd() * Math.PI, rnd() * Math.PI * 2, rnd() * Math.PI );
				q.setFromEuler( e );
				const s = L.size * ( 0.6 + rnd() * 0.8 );
				nv.set( 0, 0, 1 ).applyQuaternion( q );

				for ( let k = 0; k < 4; k ++ ) {

					v.set( corners[ k ][ 0 ] * s, corners[ k ][ 1 ] * s, 0 ).applyQuaternion( q );
					const o = ( i * 4 + k ) * 3;
					pos[ o ] = cx + v.x; pos[ o + 1 ] = cy + v.y; pos[ o + 2 ] = cz + v.z;
					nor[ o ] = nv.x; nor[ o + 1 ] = nv.y; nor[ o + 2 ] = nv.z;
					uv[ ( i * 4 + k ) * 2 ] = uvs[ k ][ 0 ];
					uv[ ( i * 4 + k ) * 2 + 1 ] = uvs[ k ][ 1 ];

				}

				const b = i * 4;
				idx.set( [ b, b + 1, b + 2, b, b + 2, b + 3 ], i * 6 );

			}

		}

		const lg = new THREE.BufferGeometry();
		lg.setAttribute( 'position', new THREE.BufferAttribute( pos, 3 ) );
		lg.setAttribute( 'normal', new THREE.BufferAttribute( nor, 3 ) );
		lg.setAttribute( 'uv', new THREE.BufferAttribute( uv, 2 ) );
		lg.setIndex( new THREE.BufferAttribute( idx, 1 ) );
		geoms.push( lg );

		const lm = new THREE.MeshStandardMaterial( {
			map: leafTex,
			color: clusters[ 0 ].color,
			// Not `transparent`: a transparent caster is skipped by the shadow
			// pass, and the shadow is the entire point of these. alphaTest keeps
			// it in the opaque queue and cuts the holes in the depth map.
			alphaTest: 0.5,
			side: THREE.DoubleSide,
			roughness: 0.92,
			metalness: 0
		} );
		mats.push( lm );
		const leaves = new THREE.Mesh( lg, lm );
		leaves.castShadow = true;
		leaves.name = 'wcs-hanger-leaves';
		g.add( leaves );

	}

	g.userData.geoms = geoms;
	g.userData.mats = mats;
	return g;

}

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

		// The plate's own pixels, reaching the shadow that lands on them.
		//
		// The two uniform OBJECTS are shared with the backdrop quad rather than
		// copied, so the crop can never be one frame out of step between the
		// picture and the shade sitting on it - setFraming writes uRect once and
		// both shaders read it.
		const shadeFloor = Number.isFinite( place.shadow.shadeFloor ) ? place.shadow.shadeFloor : 1;
		const litAt = Number.isFinite( place.shadow.litAt ) ? place.shadow.litAt : 0;
		catcherMat.onBeforeCompile = ( shader ) => {

			shader.uniforms.uMap = uniforms.uMap;
			shader.uniforms.uRect = uniforms.uRect;
			shader.uniforms.uHasMap = uniforms.uHasMap;
			shader.uniforms.uShadeFloor = { value: shadeFloor };
			shader.uniforms.uLitAt = { value: litAt };

			// The clip position, carried across so the fragment can find its own
			// pixel in the backdrop. Doing it this way rather than through
			// gl_FragCoord means no resolution uniform to keep in sync and no
			// device-pixel-ratio trap.
			shader.vertexShader = shader.vertexShader
				.replace( '#include <common>', '#include <common>\nvarying vec4 wcsClip;' )
				.replace( '#include <project_vertex>', '#include <project_vertex>\n\twcsClip = gl_Position;' );

			shader.fragmentShader = shader.fragmentShader
				.replace( '#include <common>', [
					'#include <common>',
					'varying vec4 wcsClip;',
					'uniform sampler2D uMap;',
					'uniform vec4 uRect;',
					'uniform float uHasMap;',
					'uniform float uShadeFloor;',
					'uniform float uLitAt;',
					'float wcsPlateLit() {',
					'	if ( uHasMap < 0.5 || uLitAt <= 0.0 ) return 1.0;',
					'	vec2 s = wcsClip.xy / wcsClip.w * 0.5 + 0.5;',
					'	float tx = uRect.x - uRect.z + 2.0 * uRect.z * s.x;',
					'	float ty = uRect.y - uRect.w + 2.0 * uRect.w * ( 1.0 - s.y );',
					'	vec3 c = texture2D( uMap, vec2( tx, 1.0 - ty ) ).rgb;',
					'	float lum = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );',
					'	return mix( uShadeFloor, 1.0, smoothstep( 0.0, uLitAt, lum ) );',
					'}'
				].join( '\n' ) )
				.replace(
					'gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );',
					'gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) * wcsPlateLit() );'
				);

		};
		// Two ShadowMaterials with different injected source must not share a
		// compiled program.
		catcherMat.customProgramCacheKey = () => 'wcs-catcher-' + place.id;

		catcher = new THREE.Mesh( catcherGeo, catcherMat );
		catcher.rotation.x = - Math.PI / 2;
		catcher.position.y = place.shadow.y || 0;
		catcher.receiveShadow = true;
		catcher.name = 'wcs-plate-catcher';
		scene.add( catcher );

	}

	// -- what it hangs from ---------------------------------------------------
	let hanger = null;
	let leafTex = null;
	if ( place.hanger ) {

		try {

			leafTex = makeLeafTexture();
			hanger = buildHanger( place.hanger, leafTex );
			scene.add( hanger );

		} catch ( err ) {

			// A place without its limb is worse than a place with one, but it is
			// not worse than a black page. Report and carry on.
			hanger = null;
			if ( typeof onError === 'function' ) onError( 'place-hanger-failed' );

		}

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
		hanger,

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
			// H15: dispose() names its handles by hand and nothing traverses, so a
			// place switch that allocated a limb has to free one. The group carries
			// its own lists rather than being walked, which is the same bargain the
			// rest of this file makes.
			if ( hanger ) {

				scene.remove( hanger );
				for ( const g of hanger.userData.geoms ) g.dispose();
				for ( const m of hanger.userData.mats ) m.dispose();
				hanger = null;

			}
			if ( leafTex ) { leafTex.dispose(); leafTex = null; }

		}

	};

}
