/**
 * scene.js -- the picture.
 *
 * Renderer, camera, orbit controls, golden-hour sky and sun, ground, porch, the
 * chime's meshes and materials, the cords, a procedurally generated environment
 * map, the post chain, resize, and the invisible grab proxies.
 *
 * This module knows nothing about sound, and it does not simulate wind. It is
 * handed a RigState once per frame and moves things to match. It also takes a
 * two-number summary of the wind (mean flow vector and speed) through setWind,
 * because three things that live here are genuinely wind-driven and cannot be
 * derived from the rig alone: the cloud layer, the dust haze, and which way a
 * slack cord bellies. Units are metres, Y up, +X east.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ---------------------------------------------------------------------------
// Constants shared with the rest of the rig. These mirror physics.js; they are
// duplicated rather than imported because scene.js must not depend on physics.
// ---------------------------------------------------------------------------

const HOOK_Y = 2.60;          // the porch beam underside; the rig hangs from here
const R_TUBE = 0.014;         // tube outer radius, m (28 mm OD aluminium)
const R_BORE = 0.0125;        // inner bore radius, m (25 mm ID)
const SUN_AZ_DEG = 205;       // compass bearing the sun sits in: behind-left of the default camera
const CORD_SEGMENTS = 6;      // line segments per cord; enough to read a belly of sag
const DEG = Math.PI / 180;

// Module-scope scratch. syncRig runs every frame and must not allocate.
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _vMid = new THREE.Vector3();
const _ndc = new THREE.Vector2();
const _plane = new THREE.Plane();
const _ray = new THREE.Raycaster();
const _camDir = new THREE.Vector3();
const _colA = new THREE.Color();
const _colB = new THREE.Color();
const _cordPts = new Float32Array((CORD_SEGMENTS + 1) * 3);
const _hits = [];

/**
 * Deterministic 1D hash in [0,1). Used for the brushed-metal roughness map so
 * the tubes look identical between reloads (a chime that re-scuffs itself on
 * every visit reads as noise, not as an object).
 */
function hash1(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Direction FROM the origin TOWARD the sun, from a compass azimuth and an
 * elevation, in the project's axis convention (+X east, -Z north).
 */
function sunDirection(elevDeg, out) {
  const az = SUN_AZ_DEG * DEG;
  const el = elevDeg * DEG;
  const ce = Math.cos(el);
  return out.set(Math.sin(az) * ce, Math.sin(el), -Math.cos(az) * ce).normalize();
}

/**
 * 256 x 8 roughness map for the tubes.
 *
 * The variation runs around the circumference (u) and is constant along the
 * length (v). On a cylinder that smears the specular highlight into a LINE
 * running down the tube instead of a dot -- visually what real anisotropic
 * brushing does, with no tangent frame and no extra shader cost. It is also
 * why the highlight visibly crawls and re-forms as a tube turns in the wind.
 *
 * Note on the value range: three.js MULTIPLIES roughnessMap.g by
 * material.roughness. The map therefore carries the absolute roughness
 * (0.24 .. 0.44 plus scratches) and the material's roughness stays at 1.0.
 */
function makeTubeRoughnessMap() {
  const W = 256;
  const H = 8;
  const col = new Float32Array(W);
  for (let i = 0; i < W; i++) col[i] = 0.24 + 0.16 * hash1(i + 0.5);

  // A handful of sharper scratches: single columns of much rougher metal.
  const scratches = [13, 47, 88, 131, 170, 203, 241];
  for (let k = 0; k < scratches.length; k++) {
    const s = scratches[k];
    col[s] = Math.min(0.72, col[s] + 0.32);
    col[(s + 1) % W] = Math.min(0.60, col[(s + 1) % W] + 0.14);
  }

  // One smoothing tap. Pure salt-and-pepper at 256 px aliases into a shimmer
  // when the tube rotates; a single blur pass leaves the streaks but kills it.
  const sm = new Float32Array(W);
  for (let i = 0; i < W; i++) {
    const a = col[(i - 1 + W) % W];
    const b = col[i];
    const c = col[(i + 1) % W];
    sm[i] = 0.25 * a + 0.5 * b + 0.25 * c;
  }

  const data = new Uint8Array(W * H * 4);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const v = Math.round(255 * Math.min(1, Math.max(0, sm[i])));
      const o = (j * W + i) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Ground map, 256 x 256 covering the whole 60 m plane.
 *
 * Two jobs, one texture. First, LARGE-SCALE VARIATION: an unbroken flat colour
 * reads as paint no matter how good the grass on top of it is, so a few octaves
 * of value noise give the earth patches of dry and green. Second, SKY
 * OCCLUSION: the porch roof, the beam and the post block a real share of the
 * sky dome from the ground beneath them, and that darkening -- not a cast
 * shadow, which at this sun angle lands fourteen metres away -- is what
 * actually attaches an object to the ground it stands on. It is baked because
 * the porch never moves.
 */
function makeGroundMap() {
  const S = 256;
  const HALF = 30;                    // the plane is 60 x 60 m
  const M = HALF * 2 / S;             // metres per texel
  const data = new Uint8Array(S * S * 4);

  // Value noise on a small lattice, smoothed. Cheap and good enough for
  // something that is mostly hidden behind nine thousand grass blades.
  const lat = 32;
  const rnd = new Float32Array(lat * lat);
  for (let i = 0; i < rnd.length; i++) rnd[i] = hash1(i * 3.77 + 0.13);
  const at = (i, j) => rnd[((j % lat) + lat) % lat * lat + (((i % lat) + lat) % lat)];
  function vnoise(u, v) {
    const x = u * lat, y = v * lat;
    const i = Math.floor(x), j = Math.floor(y);
    const fx = x - i, fy = y - j;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1);
    return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
  }

  // Occlusion boxes: half extents in x and z, plus the height they sit at. The
  // higher a blocker is, the wider and softer the patch of sky it takes away.
  const OCC = [
    [0, 0, 1.5, 0.7, 2.78, 0.42],   // roof slab
    [0, 0, 1.3, 0.05, 2.60, 0.16],  // beam
    [-1.25, 0, 0.05, 0.05, 1.30, 0.55]   // post, occluding from its own base up
  ];

  for (let j = 0; j < S; j++) {
    const wz = -HALF + (j + 0.5) * M;
    for (let i = 0; i < S; i++) {
      const wx = -HALF + (i + 0.5) * M;

      let n = 0.55 * vnoise(i / S * 3.0, j / S * 3.0)
            + 0.30 * vnoise(i / S * 9.0 + 0.31, j / S * 9.0 + 0.77)
            + 0.15 * vnoise(i / S * 24.0 + 0.61, j / S * 24.0 + 0.19);

      // Dry straw to damp green, warm at both ends.
      let r = 0.42 + 0.16 * n;
      let g = 0.41 + 0.12 * n;
      let b = 0.20 + 0.05 * n;

      let occ = 1;
      for (let k = 0; k < OCC.length; k++) {
        const o = OCC[k];
        // Distance outside the blocker's footprint, softened by its height:
        // something 2.8 m up shades a wide, gentle patch, something at knee
        // height shades a small hard one.
        const dx = Math.max(0, Math.abs(wx - o[0]) - o[2]);
        const dz = Math.max(0, Math.abs(wz - o[1]) - o[3]);
        const d = Math.sqrt(dx * dx + dz * dz);
        const soft = o[4] * 0.75;
        occ *= 1 - o[5] * Math.max(0, 1 - d / soft);
      }
      r *= occ; g *= occ; b *= occ;

      const p = (j * S + i) * 4;
      data[p] = Math.round(255 * Math.min(1, r));
      data[p + 1] = Math.round(255 * Math.min(1, g));
      data[p + 2] = Math.round(255 * Math.min(1, b));
      data[p + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Create the stage. Returns null -- never throws -- if WebGL2 is unavailable,
 * so main.js can fall back to a physics-and-audio-only page.
 *
 * opts = { canvas, container, params, tier, onContextLost?, onContextRestored? }
 */
export function createStage(opts) {
  if (!opts || !opts.canvas || !opts.params || !opts.tier) return null;

  const canvas = opts.canvas;
  const container = opts.container || canvas.parentElement || canvas;
  const params = opts.params;
  let tier = opts.tier;

  // -- renderer ------------------------------------------------------------
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: tier.name === 'high',
      alpha: false,
      powerPreference: 'high-performance',
    });
    if (!renderer.getContext()) return null;
  } catch (err) {
    // No WebGL2, a blocked context, or a driver that refuses. Not our problem
    // to solve here -- main.js shows a calm notice and keeps the sim running.
    return null;
  }

  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, tier.dprCap));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.74;
  renderer.shadowMap.enabled = true;
  // r185 deprecated PCFSoftShadowMap and silently substitutes PCFShadowMap.
  // Naming the substitute directly gives the identical filter with no console
  // deprecation warning on every page load.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // renderer.info is reset per renderer.render() call, so with a post chain the
  // last thing measured is the fullscreen output quad. Take it manual and reset
  // once per frame in render(), so info() reports the whole frame.
  renderer.info.autoReset = false;

  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  // Is this a CPU rasteriser (SwiftShader, llvmpipe, Mesa software)? Those
  // backends fail to LINK programs once the bloom chain, the fogged scene
  // shaders and the PMREM convolution shaders are all live at the same time --
  // a driver limit, not a bug in the passes, and it takes the whole picture
  // down. Any of the three alone is fine, so the post chain is the one to drop.
  // main.js normally tiers software down to 'low' (bloom off) anyway; this
  // catches a forced ?quality=high on a machine that cannot survive it.
  let softwareGL = false;
  try {
    const gl = renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    softwareGL = /swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(name);
  } catch (err) {
    softwareGL = false;
  }

  // -- scene, camera, controls --------------------------------------------
  const scene = new THREE.Scene();
  // Warm haze rather than grey. Applied before tone mapping, so it is
  // deliberately over-saturated at source: ACES pulls the chroma back out.
  scene.fog = new THREE.FogExp2(0xd8a061, 0.018);

  const startW = Math.max(1, container.clientWidth || canvas.clientWidth || 1);
  const startH = Math.max(1, container.clientHeight || canvas.clientHeight || 1);

  // Two changes from the first cut, both about where the light is.
  //
  // HEIGHT AND AIM: it used to look UP at the chime, which put the whole near
  // meadow behind the bottom edge -- the ground the post stands on, and the
  // first few metres of every shadow, were simply not in frame, and the object
  // read as floating on a painted plane. This is level enough to see the grass
  // the chime hangs over and still low enough to keep the tube tops against
  // sky.
  //
  // AZIMUTH: it used to sit at compass bearing 143, which is the same side of
  // the scene as the sun at 205 -- so the default view was FRONT lit, and a
  // front-lit meadow at eleven degrees is a flat olive field. Bearing 52 puts
  // the camera opposite the sun instead. The grass lights from behind and goes
  // gold, the tubes pick up a rim, and the sun's glow sits off to the left of
  // the subject rather than dead behind it.
  const camera = new THREE.PerspectiveCamera(38, startW / startH, 0.05, 6000);
  camera.position.set(2.719, 1.66, -2.124);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 1.44, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.rotateSpeed = 0.45;
  controls.zoomSpeed = 0.6;
  controls.minDistance = 1.2;
  controls.maxDistance = 7;
  controls.minPolarAngle = 0.35;
  controls.maxPolarAngle = 1.62;   // never dips under the ground plane
  controls.enablePan = false;      // panning is how you lose the subject
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.12; // slow enough to feel like drifting air
  controls.update();

  renderer.setSize(startW, startH, false);

  // -- sky ------------------------------------------------------------------
  // The sun-facing half of an 11 degree sky is radiometrically enormous: the
  // aureole comes out of the Sky shader around ten times over, so no amount of
  // exposure brings colour back into it (measured -- dropping exposure from
  // 0.62 to 0.20 moved that region by twelve levels out of 255 and took the
  // whole picture down with it). What actually fixes a featureless white wall
  // is putting something IN it, so this build turns the addon's cloud layer on:
  // the cloud mask breaks the glare into lit edges and shaded bellies. The
  // layer is then drifted from the live wind vector in render(), which makes it
  // one more channel telling you which way the air is moving -- see the cloud
  // drift block there. Stock Sky cannot do that, so assets/vendor's copy carries
  // a marked two-line change swapping its scalar clock for a drift vector.
  const sky = new Sky();
  sky.scale.setScalar(4500);
  sky.material.uniforms.turbidity.value = 6.0;
  sky.material.uniforms.rayleigh.value = 2.6;
  sky.material.uniforms.mieCoefficient.value = 0.012;
  sky.material.uniforms.mieDirectionalG.value = 0.84;
  // Thin high cirrus, not weather. Past about 0.6 the layer stops adding
  // structure and starts acting as a neutral-density filter over the whole sky,
  // and the picture slides from late afternoon into dusk.
  sky.material.uniforms.cloudCoverage.value = 0.50;
  sky.material.uniforms.cloudDensity.value = 0.52;
  sky.material.uniforms.cloudScale.value = 0.00050;
  sky.material.uniforms.cloudSpeed.value = 0.0001;
  // cloudElevation sets how far down the sky the layer is allowed to reach. The
  // default 0.5 fades everything out below about 17 degrees, which is exactly
  // the band this camera looks at, so the clouds were there all along and
  // invisible.
  sky.material.uniforms.cloudElevation.value = 0.14;
  sky.material.uniforms.time.value = 900;
  scene.add(sky);

  // -- light ----------------------------------------------------------------
  // Exactly one shadow caster. Everything else is ambient bounce; a second
  // shadowed light doubles the shadow pass for a difference nobody can name.
  const sun = new THREE.DirectionalLight(0xffd3a0, 2.8);
  sun.castShadow = true;
  // THE FRUSTUM HAS TO COVER WHERE THE SHADOWS LAND, WHICH IS NOWHERE NEAR THE
  // OBJECTS. At an 11 degree sun a shadow is 5.1 times the caster's height:
  // the chime at 1.6 m throws to 8.2 m, the porch post at 2.6 m to 13.4 m, the
  // roof at 2.78 m to 14.3 m. The previous 3.6 x 4.0 m box was aimed at the
  // chime, so every one of those shadows fell outside it and was clipped away
  // before it could reach the ground. That, and not a broken bias or a missing
  // receiveShadow, is why this scene had no shadows anywhere.
  //
  // In light space a ground point D metres downsun of the aim sits at
  // v = D*sin(elev) - 1.7*cos(elev), so +-3.8 reaches 28 m downsun at 11
  // degrees and still 12 m at the 20 degree end of the slider. Lateral +-6.0
  // covers the whole visible meadow. At 2048 that is 5.9 mm per texel, which is
  // finer than the 28 mm tubes it has to resolve.
  sun.shadow.camera.left = -6.0;
  sun.shadow.camera.right = 6.0;
  sun.shadow.camera.top = 3.8;
  sun.shadow.camera.bottom = -3.8;
  sun.shadow.camera.near = 22;
  sun.shadow.camera.far = 62;
  sun.shadow.mapSize.set(tier.shadowMapSize, tier.shadowMapSize);
  // Bias is expressed in NORMALISED depth, so it scales with near..far. Over
  // this 40 m range -0.0004 is 16 mm of slop; the ground is nearly edge-on to
  // an 11 degree sun, which is the worst case for acne, so most of the work is
  // done by normalBias instead (it offsets along the surface normal, which is
  // exactly the direction the error lies in here).
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.035;
  // MANDATORY, and the reason this scene had no shadows at all until now: three
  // never calls updateProjectionMatrix on a shadow camera for you, so the six
  // assignments above sit on the object doing nothing and the camera keeps the
  // DirectionalLight default of near 0.5 / far 500. The frustum being wrong is
  // survivable; the depth RANGE being wrong is not. shadow.bias is expressed in
  // normalised depth, so over the intended 30 m range -0.0009 is 27 mm of slop,
  // and over the default 499.5 m range it is 45 CENTIMETRES -- which lifts every
  // receiver clear of its own shadow and silently erases the lot.
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);

  const sunTarget = new THREE.Object3D();
  sunTarget.position.set(0, 1.70, 0);
  scene.add(sunTarget);
  sun.target = sunTarget;

  // Sky/ground fill so the tube undersides never go to pure black. The ground
  // half is a warm lit-meadow bounce rather than dark soil: with the old dark
  // value the top plate's underside sampled at (66, 61, 48), a charcoal puck
  // capping the whole object every time it tipped toward the camera.
  const hemi = new THREE.HemisphereLight(0x9fc7ff, 0x9c8259, 1.05);
  scene.add(hemi);

  // -- ground and porch -----------------------------------------------------
  const groundGeo = new THREE.PlaneGeometry(60, 60);
  // envMapIntensity well under 1 on every matte surface. The baked sky is a
  // real radiance map and a flat plane has no ambient occlusion of its own, so
  // taking it at full strength floods the picture and flattens the sun out of
  // it. The map below supplies the occlusion that is not being computed.
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.95, metalness: 0, envMapIntensity: 0.58,
    map: makeGroundMap(),
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const cedarMat = new THREE.MeshStandardMaterial({
    color: 0x6b5236, roughness: 0.85, metalness: 0, envMapIntensity: 0.56,
  });

  const porch = new THREE.Group();
  // Beam: 2.6 m along X, 0.09 x 0.12 in section, underside at y = 2.60.
  const beamGeo = new THREE.BoxGeometry(2.6, 0.12, 0.09);
  const beam = new THREE.Mesh(beamGeo, cedarMat);
  beam.position.set(0, 2.66, 0);
  beam.castShadow = true;
  porch.add(beam);

  // Post: the thing that gives the picture a human scale.
  const postGeo = new THREE.BoxGeometry(0.10, 2.60, 0.10);
  const post = new THREE.Mesh(postGeo, cedarMat);
  post.position.set(-1.25, 1.30, 0);
  post.castShadow = true;
  post.receiveShadow = true;
  porch.add(post);

  // Roof underside. It DOES cast: the earlier worry was that a 3 x 1.4 m slab
  // would put the chime in flat shade, but at this sun the ray that reaches the
  // chime passes 1.18 m under the roof and clears its edge 6.1 m away, so the
  // slab cannot shade the chime anywhere in the slider's 2-20 degree range. Its
  // shadow is a long bar across the far meadow, which is the strongest single
  // golden-hour cue in the picture.
  const roofGeo = new THREE.BoxGeometry(3.0, 0.06, 1.4);
  const roofMat = new THREE.MeshStandardMaterial({
    color: 0x4a3925, roughness: 0.9, metalness: 0, envMapIntensity: 0.40,
  });
  const roof = new THREE.Mesh(roofGeo, roofMat);
  roof.position.set(0, 2.78, 0);
  roof.castShadow = true;
  porch.add(roof);

  // The screw eye the whole rig hangs from, at (0, 2.60, 0).
  const hookGeo = new THREE.TorusGeometry(0.016, 0.004, 6, 16);
  const hookMat = new THREE.MeshStandardMaterial({
    color: 0x8d8f92, roughness: 0.5, metalness: 0.8, envMapIntensity: 0.9,
  });
  const hook = new THREE.Mesh(hookGeo, hookMat);
  hook.position.set(0, HOOK_Y + 0.012, 0);
  hook.rotation.y = Math.PI / 2;
  hook.castShadow = true;
  porch.add(hook);

  scene.add(porch);

  // -- chime ----------------------------------------------------------------
  const chime = new THREE.Group();
  scene.add(chime);

  const roughMap = makeTubeRoughnessMap();
  roughMap.anisotropy = maxAniso;

  let plateMesh = null;
  let clapperMesh = null;
  let sailMesh = null;
  let cordLine = null;
  let cordPositions = null;
  let tubeMeshes = [];
  let tubeMats = [];
  let ringAmp = new Float32Array(0);
  let chimeGeoms = [];
  let chimeMats = [];
  let highlight = null;   // which body the pointer is hovering, if any

  function disposeChime() {
    for (let i = chime.children.length - 1; i >= 0; i--) chime.remove(chime.children[i]);
    for (const g of chimeGeoms) g.dispose();
    for (const m of chimeMats) m.dispose();
    chimeGeoms = [];
    chimeMats = [];
    tubeMeshes = [];
    tubeMats = [];
    plateMesh = null;
    clapperMesh = null;
    sailMesh = null;
    cordLine = null;
    cordPositions = null;
  }

  function buildChime(tubes) {
    disposeChime();
    // The old highlighted mesh is gone; forget it or the next hover on the
    // same body would early-out and never light up.
    highlight = null;
    const n = tubes.length;

    // Suspension disk.
    const plateGeo = new THREE.CylinderGeometry(0.070, 0.070, 0.012, 32);
    const plateMat = new THREE.MeshStandardMaterial({
      color: 0x6b5236, roughness: 0.85, metalness: 0, envMapIntensity: 0.56,
    });
    plateMesh = new THREE.Mesh(plateGeo, plateMat);
    plateMesh.castShadow = true;
    chime.add(plateMesh);
    chimeGeoms.push(plateGeo);
    chimeMats.push(plateMat);

    // Tubes. Open-ended so you can see down the bore when they tilt, with a
    // BackSide inner cylinder standing in for the dark interior.
    const boreMat = new THREE.MeshStandardMaterial({
      color: 0x191510, roughness: 0.92, metalness: 0.05, side: THREE.BackSide,
      envMapIntensity: 0.34,
    });
    chimeMats.push(boreMat);

    for (let i = 0; i < n; i++) {
      const L = tubes[i].L;
      const outerGeo = new THREE.CylinderGeometry(R_TUBE, R_TUBE, L, 20, 1, true);
      // A 4 percent hue spread across the set. Nobody consciously notices it;
      // it is what stops six identical cylinders looking clone-stamped.
      const h = THREE.MathUtils.lerp(35, 205, n > 1 ? i / (n - 1) : 0.5) / 360;
      const mat = new THREE.MeshStandardMaterial({
        // Saturation is kept low: a metal tints its reflection by its base
        // colour, so anything stronger turns the far tubes visibly cyan.
        color: new THREE.Color().setHSL(h, 0.06, 0.62, THREE.SRGBColorSpace),
        metalness: 0.92,
        roughness: 1.0,          // absolute roughness lives in roughMap; see makeTubeRoughnessMap
        roughnessMap: roughMap,
        envMapIntensity: 1.15,
        emissive: new THREE.Color(0xfff2d0),
        emissiveIntensity: 0,
      });
      const mesh = new THREE.Mesh(outerGeo, mat);
      mesh.castShadow = true;
      chime.add(mesh);

      const boreGeo = new THREE.CylinderGeometry(R_BORE, R_BORE, L - 0.0006, 14, 1, true);
      const bore = new THREE.Mesh(boreGeo, boreMat);
      mesh.add(bore);

      tubeMeshes.push(mesh);
      tubeMats.push(mat);
      chimeGeoms.push(outerGeo, boreGeo);
      chimeMats.push(mat);
    }

    ringAmp = new Float32Array(n);

    // Clapper: a paler cedar disk.
    const clapGeo = new THREE.CylinderGeometry(0.034, 0.034, 0.014, 24);
    const clapMat = new THREE.MeshStandardMaterial({
      color: 0x9c7a4f, roughness: 0.8, metalness: 0, envMapIntensity: 0.68,
      emissive: new THREE.Color(0xffd9a0), emissiveIntensity: 0,
    });
    clapperMesh = new THREE.Mesh(clapGeo, clapMat);
    clapperMesh.castShadow = true;
    chime.add(clapperMesh);
    chimeGeoms.push(clapGeo);
    chimeMats.push(clapMat);

    // Wind sail: the only part the wind meaningfully pushes.
    const sailGeo = new THREE.BoxGeometry(0.11, 0.15, 0.004);
    const sailMat = new THREE.MeshStandardMaterial({
      color: 0xc6a677, roughness: 0.7, metalness: 0, envMapIntensity: 0.68,
      emissive: new THREE.Color(0xffd9a0), emissiveIntensity: 0,
    });
    sailMesh = new THREE.Mesh(sailGeo, sailMat);
    sailMesh.castShadow = true;
    chime.add(sailMesh);
    chimeGeoms.push(sailGeo);
    chimeMats.push(sailMat);

    // Cords. One LineSegments for all of them: a TubeGeometry per cord rebuilt
    // every frame would cost more than the entire rest of the sync. The count
    // is three bridle strands to the hook, one per tube, the clapper cord and
    // the sail cord. syncRig clamps to whatever the rig actually reports, so an
    // undersized buffer degrades to fewer drawn cords rather than to garbage.
    const cordCount = n + 5;
    cordPositions = new Float32Array(cordCount * CORD_SEGMENTS * 2 * 3);
    const cordGeo = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(cordPositions, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    cordGeo.setAttribute('position', attr);
    const cordMat = new THREE.LineBasicMaterial({
      color: 0xd8ccb4, transparent: true, opacity: 0.85, fog: true,
    });
    cordLine = new THREE.LineSegments(cordGeo, cordMat);
    cordLine.frustumCulled = false;   // positions are rewritten every frame
    chime.add(cordLine);
    chimeGeoms.push(cordGeo);
    chimeMats.push(cordMat);
  }

  // -- grab proxies ---------------------------------------------------------
  // Invisible to the camera but hittable by a ray: they sit on layer 1, which
  // the camera does not render and the raycaster is explicitly pointed at.
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const grabScale = coarse ? 1.6 : 1.0;
  const sailProxyGeo = new THREE.SphereGeometry(0.085 * grabScale, 8, 6);
  const clapProxyGeo = new THREE.SphereGeometry(0.075 * grabScale, 8, 6);
  const proxyMat = new THREE.MeshBasicMaterial();
  const sailProxy = new THREE.Mesh(sailProxyGeo, proxyMat);
  const clapProxy = new THREE.Mesh(clapProxyGeo, proxyMat);
  sailProxy.layers.set(1);
  clapProxy.layers.set(1);
  sailProxy.matrixAutoUpdate = true;
  clapProxy.matrixAutoUpdate = true;
  scene.add(sailProxy, clapProxy);

  // -- environment map ------------------------------------------------------
  let pmrem = null;
  let envScene = null;
  let envSky = null;
  let envRT = null;
  let envBaked = false;

  function buildEnvScene() {
    envScene = new THREE.Scene();

    envSky = new Sky();
    // The PMREM cube camera runs near 0.1 / far 100. A 4500-unit sky box (the
    // scale the visible sky uses) falls entirely outside that frustum and is
    // clipped away, which bakes a BLACK environment and leaves the aluminium
    // looking like painted plastic. Everything in the env scene has to fit
    // inside 100 units.
    envSky.scale.setScalar(60);
    envSky.material.uniforms.turbidity.value = 6.0;
    envSky.material.uniforms.rayleigh.value = 2.6;
    envSky.material.uniforms.mieCoefficient.value = 0.012;
    envSky.material.uniforms.mieDirectionalG.value = 0.84;
    // No clouds in the bake: a cloud mask baked into a prefiltered cube shows
    // up as fixed blotches crawling over the tubes as they turn.
    envSky.material.uniforms.cloudDensity.value = 0.0;
    // Dim the sun disc. Left at full strength it burns a single blinding texel
    // into the prefiltered cube and produces fireflies on the roughest mip;
    // the directional light supplies the real key anyway.
    envSky.material.uniforms.showSunDisc.value = 0.25;
    envScene.add(envSky);

    // PMREMGenerator samples from the ORIGIN of the scene it is given, so the
    // local geometry is shifted down to put the origin at the chime's centre
    // of mass (about y = 1.85 in world space).
    const local = new THREE.Group();
    local.position.y = -1.85;

    // Ground bounce: the meadow, seen from the inside as a lower hemisphere.
    // Warmer and brighter than the old olive, because the meadow this bakes for
    // is dry gold at eleven degrees rather than green. This is what lights the
    // underside of the top plate and the insides of the tubes, and with the old
    // value that underside sampled around (51, 39, 24) -- a charcoal puck
    // capping the object whenever the camera got below it.
    const bounceGeo = new THREE.SphereGeometry(24, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
    const bounceMat = new THREE.MeshBasicMaterial({ color: 0x8a7742, side: THREE.BackSide, fog: false });
    local.add(new THREE.Mesh(bounceGeo, bounceMat));

    // The roof proxy. This is what puts a dark band across the top of every
    // tube; without something overhead the aluminium reflects uniform sky and
    // reads as plastic.
    const slabGeo = new THREE.BoxGeometry(3.0, 0.06, 1.4);
    const slabMat = new THREE.MeshBasicMaterial({ color: 0x140f0a, fog: false });
    const slab = new THREE.Mesh(slabGeo, slabMat);
    slab.position.set(0, 2.78, 0);
    local.add(slab);

    envScene.add(local);
    envScene.userData.geoms = [bounceGeo, slabGeo];
    envScene.userData.mats = [bounceMat, slabMat];
  }

  function bakeEnvironment() {
    if (!envScene) buildEnvScene();
    if (!pmrem) pmrem = new THREE.PMREMGenerator(renderer);

    sunDirection(currentSunElev, _vA);
    envSky.material.uniforms.sunPosition.value.copy(_vA).multiplyScalar(4000);

    let rt = null;
    try {
      rt = pmrem.fromScene(envScene, 0.04, 0.1, 100);
    } catch (err) {
      return;   // a failed bake is a duller chime, not a broken page
    }
    // fromScene allocates a BRAND NEW render target on every call. Leaking one
    // cube per sun-slider tick is the single easiest way to sink this project
    // in a tab left open all day. Dispose the old one, every time.
    if (envRT) envRT.dispose();
    envRT = rt;
    scene.environment = rt.texture;
    envBaked = true;
  }

  function buildEnvironment() {
    if (envBaked) return;
    bakeEnvironment();
  }

  // -- sun ------------------------------------------------------------------
  let currentSunElev = THREE.MathUtils.clamp(
    Number.isFinite(params.sunElevDeg) ? params.sunElevDeg : 11, 2, 20
  );

  function applySun() {
    sunDirection(currentSunElev, _vA);
    sky.material.uniforms.sunPosition.value.copy(_vA).multiplyScalar(4000);
    sun.position.copy(_vA).multiplyScalar(40);

    // Low sun is redder and weaker; high sun is paler and stronger.
    const t = THREE.MathUtils.clamp((currentSunElev - 4) / 12, 0, 1);
    _colA.setHex(0xff9d4a, THREE.SRGBColorSpace);
    _colB.setHex(0xffe3b8, THREE.SRGBColorSpace);
    sun.color.copy(_colA).lerp(_colB, t);
    sun.intensity = THREE.MathUtils.lerp(2.2, 3.4, t);

    // Exposure tracks the sky's own brightness so the picture holds its value
    // across the slider. Exactly 0.74 at the default 11 degrees. Raised from
    // 0.62: with the cloud layer taking the top off the sky, and the meadow
    // now carrying real shadow, the old value read as an overcast dusk.
    renderer.toneMappingExposure = THREE.MathUtils.clamp(
      0.74 * Math.pow(11 / Math.max(2, currentSunElev), 0.08), 0.64, 0.90
    );
  }
  applySun();

  function setSunElevation(deg) {
    if (!Number.isFinite(deg)) return;
    const d = THREE.MathUtils.clamp(deg, 2, 20);
    if (Math.abs(d - currentSunElev) <= 0.5) return;   // PMREM bakes are not free
    currentSunElev = d;
    applySun();
    if (envBaked) bakeEnvironment();
  }

  // -- post chain -----------------------------------------------------------
  let composer = null;
  let bloomPass = null;
  let renderPass = null;
  let outputPass = null;

  function buildComposer() {
    if (composer || softwareGL) return;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    composer = new EffectComposer(renderer);
    composer.setPixelRatio(renderer.getPixelRatio());
    renderPass = new RenderPass(scene, camera);
    // Threshold 0.86 sits above the diffuse ceiling at this exposure (lit wood
    // tops out near 0.45, grass near 0.5), so only the sun disc, the tube
    // speculars and the hottest streaks glow.
    bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.34, 0.62, 0.86);
    // OutputPass does the tone map at the very end, so bloom operates on
    // linear HDR. Do not also tone-map inside RenderPass.
    outputPass = new OutputPass();
    composer.addPass(renderPass);
    composer.addPass(bloomPass);
    composer.addPass(outputPass);
    const w = Math.max(1, container.clientWidth || 1);
    const h = Math.max(1, container.clientHeight || 1);
    composer.setSize(w, h);
  }

  function disposeComposer() {
    if (!composer) return;
    if (bloomPass && bloomPass.dispose) bloomPass.dispose();
    if (outputPass && outputPass.dispose) outputPass.dispose();
    if (renderPass && renderPass.dispose) renderPass.dispose();
    if (composer.renderTarget1) composer.renderTarget1.dispose();
    if (composer.renderTarget2) composer.renderTarget2.dispose();
    composer = null;
    bloomPass = null;
    outputPass = null;
    renderPass = null;
  }

  if (tier.bloom) buildComposer();   // no-ops on a software rasteriser

  // -- context loss ---------------------------------------------------------
  function onLost(e) {
    e.preventDefault();
    if (typeof opts.onContextLost === 'function') opts.onContextLost(e);
  }
  function onRestored(e) {
    // three re-uploads textures and relinks programs by itself, but the
    // CONTENTS of a render target do not survive. The prefiltered environment
    // cube is a render target, so without this the aluminium comes back as
    // dark plastic after a GPU reset.
    if (envBaked) {
      envBaked = false;
      // Both of these belong to a context that no longer exists. Drop the
      // references rather than dispose them; their GPU side is already gone.
      envRT = null;
      pmrem = null;
      bakeEnvironment();
    }
    if (typeof opts.onContextRestored === 'function') opts.onContextRestored(e);
  }
  canvas.addEventListener('webglcontextlost', onLost, false);
  canvas.addEventListener('webglcontextrestored', onRestored, false);

  // -- per-frame sync -------------------------------------------------------
  let lastSyncMs = -1;

  function writeCord(k, a, b, rest, slack) {
    // Quadratic sag: at slack 0 the cord is a straight taut line, at slack 0.3
    // it visibly bellies. Cords going slack and snapping taut is a wind cue in
    // its own right, and it comes free from the unilateral constraints.
    //
    // The belly is not straight down. A slack cord is a light body with a lot of
    // side area and nothing holding it, so the air pushes the middle downwind
    // while the ends stay put -- the catenary leans. The lean is the ratio of
    // drag to weight, saturating once the cord is streaming, so this uses a
    // half-angle that reaches about 40 degrees at 15 m/s and never goes past 45,
    // where a cord would be blowing straight out sideways.
    const sag = 0.55 * rest * (slack > 0 ? slack : 0);
    _vA.set(a[0], a[1], a[2]);
    _vB.set(b[0], b[1], b[2]);
    _vMid.addVectors(_vA, _vB).multiplyScalar(0.5);
    if (sag > 0) {
      const lean = windSpeedMs / (windSpeedMs + 18.0);   // 0 calm, 0.45 at 15 m/s
      _vMid.y -= sag * (1 - lean);
      _vMid.x += windFlow.x * sag * lean;
      _vMid.z += windFlow.y * sag * lean;
    }

    for (let s = 0; s <= CORD_SEGMENTS; s++) {
      const u = s / CORD_SEGMENTS;
      const iu = 1 - u;
      const w0 = iu * iu;
      const w1 = 2 * iu * u;
      const w2 = u * u;
      const o = s * 3;
      _cordPts[o] = w0 * _vA.x + w1 * _vMid.x + w2 * _vB.x;
      _cordPts[o + 1] = w0 * _vA.y + w1 * _vMid.y + w2 * _vB.y;
      _cordPts[o + 2] = w0 * _vA.z + w1 * _vMid.z + w2 * _vB.z;
    }

    let p = k * CORD_SEGMENTS * 2 * 3;
    for (let s = 0; s < CORD_SEGMENTS; s++) {
      const o0 = s * 3;
      const o1 = o0 + 3;
      cordPositions[p++] = _cordPts[o0];
      cordPositions[p++] = _cordPts[o0 + 1];
      cordPositions[p++] = _cordPts[o0 + 2];
      cordPositions[p++] = _cordPts[o1];
      cordPositions[p++] = _cordPts[o1 + 1];
      cordPositions[p++] = _cordPts[o1 + 2];
    }
  }

  function syncRig(state) {
    if (!state) return;

    // syncRig is not handed dt, so it keeps its own clock for the ring decay.
    const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let dt = lastSyncMs < 0 ? 1 / 60 : (nowMs - lastSyncMs) / 1000;
    if (!(dt > 0) || dt > 0.1) dt = 1 / 60;
    lastSyncMs = nowMs;
    const tSec = nowMs / 1000;

    if (plateMesh && state.plate) {
      plateMesh.position.set(state.plate.pos[0], state.plate.pos[1], state.plate.pos[2]);
      plateMesh.quaternion.set(state.plate.quat[0], state.plate.quat[1], state.plate.quat[2], state.plate.quat[3]);
    }

    const st = state.tubes;
    if (st) {
      const n = Math.min(tubeMeshes.length, st.length);
      const decay = Math.exp(-2.2 * dt);
      for (let i = 0; i < n; i++) {
        const s = st[i];
        const mesh = tubeMeshes[i];
        // Position is the midpoint of the physical ends; orientation comes
        // straight from the rig, which is why the rendered tube and the
        // collision capsule are literally the same object.
        mesh.position.set(
          0.5 * (s.top[0] + s.bottom[0]),
          0.5 * (s.top[1] + s.bottom[1]),
          0.5 * (s.top[2] + s.bottom[2])
        );
        mesh.quaternion.set(s.quat[0], s.quat[1], s.quat[2], s.quat[3]);

        // Strike flash. Physics may seed state.ring; scene owns the decay so
        // the flare lasts about 300 ms, long enough for bloom to catch it.
        let r = ringAmp[i];
        if (typeof s.ring === 'number' && s.ring > r) r = s.ring;
        r *= decay;
        if (r < 1e-3) r = 0;
        ringAmp[i] = r;
        s.ring = r;

        const mat = tubeMats[i];
        mat.emissiveIntensity = 0.35 * r;
        // Sub-millimetre bend wobble: 6 percent of a 14 mm radius is 0.8 mm.
        mesh.scale.x = r > 0 ? 1 + 0.06 * r * Math.sin(60 * tSec) : 1;
      }
    }

    if (clapperMesh && state.clapper) {
      clapperMesh.position.set(state.clapper.pos[0], state.clapper.pos[1], state.clapper.pos[2]);
      if (state.plate) {
        // The clapper hangs level with the plate; borrowing its orientation
        // gives it the same gentle tilt without a second rigid body.
        clapperMesh.quaternion.set(state.plate.quat[0], state.plate.quat[1], state.plate.quat[2], state.plate.quat[3]);
      }
      clapProxy.position.copy(clapperMesh.position);
    }

    if (sailMesh && state.sail) {
      sailMesh.position.set(state.sail.pos[0], state.sail.pos[1], state.sail.pos[2]);
      sailMesh.quaternion.set(state.sail.quat[0], state.sail.quat[1], state.sail.quat[2], state.sail.quat[3]);
      sailProxy.position.copy(sailMesh.position);
    }

    if (cordLine && state.cords && cordPositions) {
      const cords = state.cords;
      const maxCords = (cordPositions.length / (CORD_SEGMENTS * 2 * 3)) | 0;
      const k = Math.min(maxCords, cords.length);
      for (let i = 0; i < k; i++) {
        const c = cords[i];
        writeCord(i, c.a, c.b, c.rest, c.slack);
      }
      // Any unused slots collapse to a degenerate point rather than a stale line.
      for (let i = k; i < maxCords; i++) {
        let p = i * CORD_SEGMENTS * 2 * 3;
        const end = p + CORD_SEGMENTS * 2 * 3;
        for (; p < end; p++) cordPositions[p] = 0;
      }
      cordLine.geometry.attributes.position.needsUpdate = true;
    }
  }

  function flashTube(index, intensity) {
    if (!(index >= 0) || index >= ringAmp.length) return;
    const v = THREE.MathUtils.clamp(Number.isFinite(intensity) ? intensity : 0, 0, 1);
    if (v > ringAmp[index]) ringAmp[index] = v;
  }

  // -- tier -----------------------------------------------------------------
  function setTier(next) {
    if (!next) return;
    tier = next;
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, tier.dprCap));
    if (sun.shadow.mapSize.x !== tier.shadowMapSize) {
      // The shadow map is a live GPU target; it has to be released before the
      // size change takes, or three keeps rendering into the old one.
      if (sun.shadow.map) {
        sun.shadow.map.dispose();
        sun.shadow.map = null;
      }
      sun.shadow.mapSize.set(tier.shadowMapSize, tier.shadowMapSize);
    }
    if (tier.bloom && !composer) buildComposer();
    else if (!tier.bloom && composer) disposeComposer();
    resize();
  }

  // -- resize ---------------------------------------------------------------
  // Portrait re-framing. A 38 degree vertical field on a 390 x 780 phone is
  // only 20 degrees WIDE, and the chime plus the metre of downwind space the
  // sail and the telltale need does not fit in it -- they were running off the
  // right-hand edge, which is the one cue the whole picture is built around.
  // Backing off and dropping the aim keeps the subject and its downwind side in
  // frame. Applied only when the orientation class actually changes, so it
  // cannot fight a visitor who has zoomed in.
  const BASE_DIST = 3.45;
  let lastPortrait = null;

  function applyFraming(portrait) {
    _vA.subVectors(camera.position, controls.target);
    const len = _vA.length() || BASE_DIST;
    const want = portrait ? 4.75 : BASE_DIST;
    controls.target.set(0, portrait ? 1.52 : 1.44, 0);
    camera.position.copy(controls.target).addScaledVector(_vA, want / len);
    controls.update();
  }

  function resize() {
    const w = Math.max(1, container.clientWidth || canvas.clientWidth || 0);
    const h = Math.max(1, container.clientHeight || canvas.clientHeight || 0);
    if (w < 2 || h < 2) return;
    const portrait = h > w * 1.05;
    if (portrait !== lastPortrait) {
      lastPortrait = portrait;
      applyFraming(portrait);
    }
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, tier.dprCap));
    renderer.setSize(w, h, false);
    if (composer) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    }
  }

  // -- wind coupling --------------------------------------------------------
  // A two-number summary of the field, pushed in once per frame. Everything
  // here reads the mean, never a point sample: clouds, haze and cord sag are
  // all bulk effects and would only shimmer if they chased the turbulence.
  const windFlow = new THREE.Vector2(1, 0);   // unit vector the air blows TOWARD, in world XZ
  let windSpeedMs = 0;

  function setWind(meanVec, speedMph) {
    const mx = meanVec && Number.isFinite(meanVec[0]) ? meanVec[0] : 0;
    const mz = meanVec && Number.isFinite(meanVec[2]) ? meanVec[2] : 0;
    const mag = Math.hypot(mx, mz);
    if (mag > 1e-4) windFlow.set(mx / mag, mz / mag);
    windSpeedMs = mag;
    if (Number.isFinite(speedMph)) windSpeedMph = speedMph;
  }

  let windSpeedMph = 0;

  // What the renderer currently believes the air is doing, and what it did with
  // it. Reported into the snapshot so the cloud, haze and cord-lean couplings
  // can be checked by reading a number instead of by staring at a screenshot.
  function windReadout() {
    return {
      flow: [Math.round(windFlow.x * 1000) / 1000, Math.round(windFlow.y * 1000) / 1000],
      speedMs: Math.round(windSpeedMs * 1000) / 1000,
      speedMph: Math.round(windSpeedMph * 10) / 10,
      cloudDrift: [Math.round(cloudDrift.x * 1e6) / 1e6, Math.round(cloudDrift.y * 1e6) / 1e6],
      fogDensity: Math.round(scene.fog.density * 1e5) / 1e5,
      cordLean: Math.round((windSpeedMs / (windSpeedMs + 18.0)) * 1000) / 1000,
    };
  }

  // -- render ---------------------------------------------------------------
  // Cloud drift, derived from the cloud geometry rather than tuned by eye.
  //
  // The Sky shader builds its lookup as
  //     cloudUV = direction.xz / (direction.y * elevation) * cloudScale
  // and samples fbm(cloudUV * 1000). For a deck at height H, direction.xz over
  // direction.y is just worldXZ / H, so
  //     cloudUV = worldXZ * cloudScale / (H * elevation)
  // and a deck moving at V metres per second advances cloudUV at
  //     V * cloudScale / (H * elevation)
  // per second. No free constant, and it stays right if cloudScale or
  // cloudElevation are retuned. The offset is subtracted because shifting the
  // sample point one way slides the pattern the other.
  //
  // This replaced a fixed 0.0055 UV/s crawl, which works out to a cloud field
  // crossing its own feature width about every fifth of a second -- roughly
  // 20 km/s at this scale. It went unnoticed because render() used to discard
  // any frame over 250 ms, so under software rendering the clock never ticked
  // and the sky was simply frozen.
  //
  // The honest number is slow: real cloud is kilometres away and creeps. That
  // is the point. The streaks, grass and ribbon are the wind cues; the sky is
  // scenery, and scenery that races reads as wrong before anyone can say why.
  const cloudDrift = sky.material.uniforms.cloudDrift.value;
  const CLOUD_HEIGHT = 900;          // stratocumulus base, m
  const CLOUD_GRADIENT = 1.8;        // wind aloft against wind at the porch

  // Dust haze. Dry meadow in a stiff wind genuinely lifts material, and the
  // horizon goes milky before anything else tells you it is blowing hard. Kept
  // deliberately small: this is a second-order cue, and at full strength it
  // reads as fog rolling in rather than as wind.
  const FOG_CALM = 0.018;
  const FOG_BLOWN = 0.032;
  const FOG_FULL_MS = 15.0;        // ~34 mph, where the haze tops out

  let lastRenderMs = -1;

  function render() {
    const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let dt = lastRenderMs < 0 ? 0 : (nowMs - lastRenderMs) / 1000;
    // Clamp a long frame, do not discard it. Discarding meant the sky froze on
    // exactly the machines that render slowly -- below 4 fps every frame was
    // over the old 0.25 s limit, so the clouds never moved once.
    if (!(dt > 0)) dt = 0; else if (dt > 0.25) dt = 0.25;
    lastRenderMs = nowMs;

    // mix(1.0, 0.1, cloudElevation), matching the shader's own projection.
    const cloudElev = 1.0 - 0.9 * sky.material.uniforms.cloudElevation.value;
    const cloudRate = windSpeedMs * CLOUD_GRADIENT * sky.material.uniforms.cloudScale.value
      / (CLOUD_HEIGHT * cloudElev);
    cloudDrift.x -= windFlow.x * cloudRate * dt;
    cloudDrift.y -= windFlow.y * cloudRate * dt;

    const hazeT = Math.min(1, windSpeedMs / FOG_FULL_MS);
    scene.fog.density = FOG_CALM + (FOG_BLOWN - FOG_CALM) * hazeT * hazeT;

    renderer.info.reset();
    controls.update();
    if (composer) composer.render();
    else renderer.render(scene, camera);
  }

  // -- picking --------------------------------------------------------------
  function raycastGrab(ndcX, ndcY) {
    sailProxy.updateMatrixWorld();
    clapProxy.updateMatrixWorld();
    _ndc.set(ndcX, ndcY);
    _ray.setFromCamera(_ndc, camera);
    _ray.layers.set(1);
    _hits.length = 0;
    _ray.intersectObjects([sailProxy, clapProxy], false, _hits);
    if (_hits.length === 0) return null;
    const obj = _hits[0].object;   // intersectObjects sorts by distance
    _hits.length = 0;
    return obj === sailProxy ? 'sail' : 'clapper';
  }

  function grabPlanePoint(ndcX, ndcY, aroundWorld, out) {
    const dst = out || [0, 0, 0];
    _vC.set(aroundWorld[0], aroundWorld[1], aroundWorld[2]);
    camera.getWorldDirection(_camDir);
    // A plane facing the camera through the grabbed body: drags then map 1:1
    // to what the pointer does on screen, whatever angle the camera sits at.
    _plane.setFromNormalAndCoplanarPoint(_camDir, _vC);
    _ndc.set(ndcX, ndcY);
    _ray.setFromCamera(_ndc, camera);
    const hit = _ray.ray.intersectPlane(_plane, _vA);
    if (hit) {
      dst[0] = hit.x; dst[1] = hit.y; dst[2] = hit.z;
    } else {
      dst[0] = _vC.x; dst[1] = _vC.y; dst[2] = _vC.z;
    }
    return dst;
  }

  function setGrabHighlight(name) {
    if (name === highlight) return;
    highlight = name === 'sail' || name === 'clapper' ? name : null;
    if (sailMesh) sailMesh.material.emissiveIntensity = highlight === 'sail' ? 0.30 : 0;
    if (clapperMesh) clapperMesh.material.emissiveIntensity = highlight === 'clapper' ? 0.30 : 0;
  }

  function cameraRight(out) {
    const dst = out || [0, 0, 0];
    camera.updateMatrixWorld();
    _vA.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    dst[0] = _vA.x; dst[1] = _vA.y; dst[2] = _vA.z;
    return dst;
  }

  function cameraDistance() {
    return camera.position.distanceTo(controls.target);
  }

  function info() {
    const r = renderer.info;
    return {
      drawCalls: r.render.calls | 0,
      triangles: r.render.triangles | 0,
      programs: r.programs ? r.programs.length : 0,
    };
  }

  // -- teardown -------------------------------------------------------------
  function dispose() {
    canvas.removeEventListener('webglcontextlost', onLost, false);
    canvas.removeEventListener('webglcontextrestored', onRestored, false);
    controls.dispose();
    disposeChime();
    disposeComposer();

    if (envRT) { envRT.dispose(); envRT = null; }
    if (pmrem) { pmrem.dispose(); pmrem = null; }
    if (envScene) {
      for (const g of envScene.userData.geoms || []) g.dispose();
      for (const m of envScene.userData.mats || []) m.dispose();
      envSky.geometry.dispose();
      envSky.material.dispose();
      envScene = null;
      envSky = null;
    }
    scene.environment = null;

    sky.geometry.dispose();
    sky.material.dispose();
    groundGeo.dispose();
    groundMat.dispose();
    beamGeo.dispose();
    postGeo.dispose();
    roofGeo.dispose();
    roofMat.dispose();
    hookGeo.dispose();
    hookMat.dispose();
    cedarMat.dispose();
    sailProxyGeo.dispose();
    clapProxyGeo.dispose();
    proxyMat.dispose();
    roughMap.dispose();
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }

    renderer.dispose();
  }

  const stage = {
    scene,
    camera,
    renderer,
    controls,
    get composer() { return composer; },
    buildChime,
    buildEnvironment,
    setWind,
    windReadout,
    syncRig,
    flashTube,
    setSunElevation,
    setTier,
    resize,
    render,
    raycastGrab,
    grabPlanePoint,
    setGrabHighlight,
    cameraRight,
    cameraDistance,
    info,
    dispose,
  };

  return stage;
}
