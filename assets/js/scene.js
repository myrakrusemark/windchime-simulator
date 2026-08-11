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
// === WCS:PLACE-IMPORTS ===
// P4. A place owns the world, a style owns the idiom (CONTRACTS Rule B). Both
// modules are pure of three.js state: places.js is a table and a lookup,
// plate.js builds one clip-space quad and one shadow catcher.
import { resolvePlace, fallbackFor, DEFAULT_PLACE_ID } from './places.js';
import { createPlate } from './plate.js';
import { createSplat } from './splat.js';
// === /WCS:PLACE-IMPORTS ===

// ---------------------------------------------------------------------------
// Constants shared with the rest of the rig. These mirror physics.js; they are
// duplicated rather than imported because scene.js must not depend on physics.
// ---------------------------------------------------------------------------

const HOOK_Y = 2.60;          // the porch beam underside; the rig hangs from here
const R_TUBE = 0.022225;      // tube outer radius, m (44.45 mm OD chime stock)
// Radius of the suspension disk. It MUST stay larger than physics.js's R_RING
// (0.082), which is where the tube cords hang from: at 0.070 against a ring of
// 0.082 every cord left the disk 12 mm beyond its own edge and read as tied to
// thin air. A real chime drills its holes inside the rim, so the disk overhangs
// the tubes. physics.js carries the same number as PLATE_R for its drag area
// and its porch collision.
const R_PLATE = 0.12395;
const R_BORE = 0.019625;      // inner bore radius, m (39.25 mm ID, 2.6 mm wall)
const CORD_SEGMENTS = 6;      // line segments per cord; enough to read a belly of sag
// Half-extent of the ground plane, m. It has to outrun the shallowest sight
// line: an orthographic camera's rays are parallel, so at the lowest tilt and
// the widest zoom the ray leaving the TOP of the frame reaches the ground about
// 27 m out. At the old 30 m that cleared by three metres, which is close enough
// that a small change to the tilt floor or the zoom range would have put the
// plane's edge in shot -- and beyond the edge there is only background colour,
// which reads as the world running out. The bake below uses the same number, so
// the porch's occlusion stays where the porch is.
const GROUND_HALF = 45;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Art direction
//
// Everything the picture's LOOK depends on lives here as data, so the renderer
// below reads `S.whatever` and never a literal. Two presets:
//
//   storybook -- flat matte colour under soft even light, seen through an
//     orthographic camera. Untitled Goose Game is the reference: no texture, no
//     specular, no glare, a muted pastel palette, and shapes that read by
//     silhouette. Everything that makes a render look photographic is
//     deliberately switched off, because in this idiom those things read as
//     dirt on the lens.
//
//   golden -- the physically-lit version: anodised aluminium with a real
//     environment map, an 11 degree sun, ACES tone mapping and bloom.
//
// The wind simulation is identical in both. Only the picture changes.
// ---------------------------------------------------------------------------

const STYLES = {

  storybook: {
    name: 'storybook',

    // An orthographic camera is most of the feel on its own: parallel edges
    // stay parallel, so the porch reads as a diagram of a porch and the tubes
    // stay the same width top to bottom. Height is the frustum in metres, which
    // is the honest way to frame an ortho camera -- there is no field of view.
    ortho: true,
    // Tight enough that the chime is the subject. At 3.5 m the porch roof ate
    // the top third of the frame and the chime read as a detail in a landscape.
    viewHeight: 2.6,
    viewHeightPortrait: 3.5,
    // A 30 degree downward look. The ground plane reads as a plane rather than
    // as a horizon line, which is what makes this idiom sit up and look drawn.
    // For an ortho camera this vector only sets DIRECTION -- the eye is pushed
    // out to a fixed distance below, since an ortho eye's position changes
    // nothing but clipping.
    camPos: [2.83, 3.20, -2.22],
    camTarget: [0, 1.45, 0],
    porchRoof: false,
    // [lowest, highest] camera elevation above the horizon, degrees.
    elevRange: [8, 80],

    // Flat, slightly warm off-white. A gradient sky pulls the eye up and out of
    // the frame; a flat one keeps it on the object.
    sky: false,
    background: 0xe9e3d3,
    // An orthographic camera's eye sits far behind the scene and every fragment
    // comes back at nearly the same view depth, so distance fog degenerates into
    // a flat wash over everything. There is no haze in this style; the wind's
    // dust cue lives entirely in the streaks and the grass here.
    fogColor: 0xe9e3d3,
    fogCalm: 0.0,
    fogBlown: 0.0,

    // No tone curve and no bloom. Both exist to emulate a camera, and there is
    // no camera in this idiom -- the colours are meant to arrive as authored.
    toneMapping: 'none',
    exposure: 1.0,
    bloom: false,

    // Light from high up, soft, with most of the illumination coming from the
    // fill. A low raking sun carves out form and long shadows, which is exactly
    // what this look does not want.
    // With no tone curve there is no highlight rolloff, so the budget is
    // literal. The first cut looked blown out at 1.35 + 2.05, but that was 40
    // percent distance fog washing the frame, not the lights -- an ortho eye
    // sits 40 m back, so FogExp2 was fogging every fragment equally. With the
    // fog gone these are the values that put a lit surface near the top of the
    // range without clipping it.
    // Front-left, on the CAMERA's side. Under a camera that looks down, a
    // shadow cast away from the viewer climbs into frame and one cast toward
    // the viewer falls out the bottom -- at the golden style's 232 the chime's
    // shadow landed 190 px below the visible area, which is why this style
    // looked like it had no shadows even though the map was rendering. At 28
    // it lands up and to the left of the chime with clear separation.
    sunAzDeg: 28,
    sunElevDeg: 52,
    sunColor: 0xfff4de,
    sunIntensity: 1.55,
    hemiSky: 0xdce9f4,
    hemiGround: 0xb9a884,
    hemiIntensity: 1.45,
    // Shadows are short at 52 degrees, so the frustum can be tight and the map
    // is spent where it shows.
    // applySun parks the light 40 m out along the sun vector, so the depth
    // range has to bracket 40 -- not the scene's own size. At 1..12 every
    // caster sat beyond the far plane and nothing cast at all.
    shadowHalf: [3.4, 2.8],
    shadowNear: 32.0,
    shadowFar: 49.0,
    shadowBias: -0.0012,
    shadowNormalBias: 0.02,

    env: false,          // no environment map: nothing here is reflective
    envIntensity: 0,
    flatten: true,

    ground: 0x83b06d,
    groundVariation: 0.10,
    // Soft sky occlusion is what grounds an object under a real sky. Under flat
    // shading it just reads as a stain on the lawn, so most of it comes out.
    groundOcclusion: 0.30,
    cedar: 0xa8845c,
    roof: 0x8c6a4a,
    hook: 0x9a938a,
    plate: 0xa8845c,
    bore: 0x4a4438,
    clapper: 0xc49a68,
    sail: 0xd8c091,
    cord: 0xcfc4ac,
    // Tubes as painted metal rather than bare: a spread of muted pastels across
    // the set, which is how a viewer tells them apart when there is no highlight
    // travelling down them to do it.
    tubeHueDeg: [188, 26],
    tubeSat: 0.30,
    tubeLight: 0.66,
    tubeMetalness: 0.0,
    tubeRoughness: 1.0,
    tubeBrushed: false,

    tufts: 95,
    tuftRadius: 5.3,
    tuftDarken: 0.90,
    shrub: 0x54803f,
    bushFlat: 0.30,
    // Placed for a camera that looks DOWN: the golden set sits five to seven
    // metres out, which an orthographic frame 2.6 m tall never reaches. These
    // sit close enough to be in shot and low enough not to climb over the
    // chime.
    // Solved against the actual orthographic frame rather than guessed. Under a
    // camera that looks DOWN, a bush placed further away projects HIGHER up the
    // screen, so the intuition that "far means small and out of the way" is
    // exactly backwards -- the first set at 1.5 m behind the chime climbed
    // straight up into the tubes. These two clear the chime's screen box by a
    // fifth of a frame height and sit low in shot.
    shrubClusters: [
      { x: -1.20, y: 0.24, z: -0.40, r: 0.34 },
      { x: 0.05, y: 0.22, z: 1.20, r: 0.30 }
    ],
    streak: 0xfaf3e2,
    leafPalette: [0xd08a45, 0xdcae5c, 0xa9713a],
    ribbon: 0xd4566b,
  },

  golden: {
    name: 'golden',
    ortho: false,
    fov: 38,
    camPos: [2.719, 1.66, -2.124],
    camTarget: [0, 1.44, 0],
    baseDist: 3.45,
    baseDistPortrait: 4.75,
    elevRange: [1.5, 70],
    camTargetPortraitY: 1.52,

    sky: true,
    background: null,
    fogColor: 0xd8a061,
    fogCalm: 0.018,
    fogBlown: 0.032,

    toneMapping: 'aces',
    exposure: 0.74,
    bloom: true,

    sunAzDeg: 205,
    sunElevDeg: 11,
    sunColor: 0xffd3a0,
    sunIntensity: 2.8,
    hemiSky: 0x9fc7ff,
    hemiGround: 0x9c8259,
    hemiIntensity: 1.05,
    shadowHalf: [6.0, 3.8],
    shadowNear: 22,
    shadowFar: 62,
    shadowBias: -0.0004,
    shadowNormalBias: 0.035,

    env: true,
    envIntensity: 1.0,

    ground: 0x807839,
    groundVariation: 0.25,
    groundOcclusion: 1.0,
    cedar: 0x6b5236,
    roof: 0x4a3925,
    hook: 0x8d8f92,
    plate: 0x6b5236,
    bore: 0x191510,
    clapper: 0x9c7a4f,
    sail: 0xc6a677,
    cord: 0xd8ccb4,
    tubeHueDeg: [35, 205],
    tubeSat: 0.06,
    tubeLight: 0.62,
    tubeMetalness: 0.92,
    tubeRoughness: 1.0,
    tubeBrushed: true,

    // A perspective camera looking ACROSS a meadow sees far more ground than an
    // orthographic one looking down at a lawn, so this needs many more tufts
    // over a much wider disc. They are still static and still six triangles
    // each, which is a fraction of what nine thousand shader-driven blades cost.
    tufts: 1500,
    tuftRadius: 9.5,
    tuftHeight: 0.20,
    tuftDarken: 0.90,
    shrubClusters: [
      { x: -3.00, y: 0.60, z: 5.60, r: 1.05 },
      { x: -6.80, y: 0.70, z: -1.60, r: 1.15 },
      { x: -2.40, y: 0.45, z: 7.40, r: 0.90 }
    ],
    shrub: 0x4c5a2e,
    bushFlat: 0.22,
    streak: 0xffe9c9,
    leafPalette: [0xc46a2a, 0xd99a3c, 0x8d5a22],
    ribbon: 0xc9425a,
  },

};

// Module-scope scratch. syncRig runs every frame and must not allocate.
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _vMid = new THREE.Vector3();
const _ndc = new THREE.Vector2();
const _mat = new THREE.Matrix4();
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
function sunDirection(elevDeg, out, azDeg) {
  const az = (azDeg === undefined ? 205 : azDeg) * DEG;
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
function makeGroundMap(withRoof, base, variation, occStrength) {
  const S = 256;
  const HALF = GROUND_HALF;
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
  ].filter((o, i) => (i !== 0 || withRoof));

  for (let j = 0; j < S; j++) {
    const wz = -HALF + (j + 0.5) * M;
    for (let i = 0; i < S; i++) {
      const wx = -HALF + (i + 0.5) * M;

      let n = 0.55 * vnoise(i / S * 3.0, j / S * 3.0)
            + 0.30 * vnoise(i / S * 9.0 + 0.31, j / S * 9.0 + 0.77)
            + 0.15 * vnoise(i / S * 24.0 + 0.61, j / S * 24.0 + 0.19);

      // The base colour with large-scale variation around it. The golden style
      // wants a wide dry-straw-to-damp-green swing; the storybook style wants
      // almost none, because mottling is texture and texture is the thing that
      // idiom does not have. Either way the MAP carries the ground's colour and
      // the material stays white, so this is not multiplied by a tint twice.
      const v = (n - 0.5) * variation;
      let r = base[0] * (1 + v * 1.30);
      let g = base[1] * (1 + v * 1.00);
      let b = base[2] * (1 + v * 0.90);

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
        occ *= 1 - o[5] * occStrength * Math.max(0, 1 - d / soft);
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

  // === WCS:PLACE-BOOT ===
  // P4. Which place is up decides the world; the style row it names decides the
  // idiom. `opts.place` is the added argument CONTRACTS 2.4 grants; main.js does
  // not pass one, so the stage boots in the default place and ui/places.js
  // corrects it from the decoded design before startLoop() - one switch, before
  // the first frame, on the minority of links that ask for the other place.
  let place = resolvePlace(opts.place === undefined ? DEFAULT_PLACE_ID : opts.place);
  // === /WCS:PLACE-BOOT ===

  // The art direction. Everything below reads S rather than a literal, so the
  // whole look is one table lookup away from being a different picture.
  // A place names its idiom; the legacy ?style= override still wins, because a
  // link that predates places has to keep resolving to the picture it promised.
  const S = STYLES[opts.style] || STYLES[params.style] || STYLES[place.backdrop.style] || STYLES.storybook;

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

  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, dprCapFor(tier)));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = S.toneMapping === 'aces' ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
  renderer.toneMappingExposure = S.exposure;
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
  // Under ACES the fog colour is deliberately over-saturated at source, because
  // the tone curve pulls the chroma back out. With no tone curve it is taken as
  // authored, and it matches the background so distance dissolves rather than
  // fading to a different colour.
  scene.fog = new THREE.FogExp2(S.fogColor, S.fogCalm);
  if (S.background !== null && S.background !== undefined) {
    scene.background = new THREE.Color(S.background);
  }

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
  // An orthographic camera has no field of view, so it is framed by a frustum
  // HEIGHT in metres and the aspect gives the width. OrbitControls drives ortho
  // through camera.zoom rather than by dollying, so the min/max below are zoom
  // factors, not distances; the eye stays put and the frustum tightens.
  // === WCS:ORTHO-EYE ===
  // THE ORTHO EYE SITS ON THE TARGET, AND THAT IS A JITTER FIX.
  //
  // It used to stand 40 units back, because an ortho eye contributes nothing
  // but direction and pushing it clear stopped it clipping through the porch
  // roof on a high orbit. Correct, and it had a cost nobody had looked for:
  // spark re-sorts its gaussians when the view changes, and its test is
  // `center.distanceTo(sortedCenter) > 1e-3` - ONE MILLIMETRE of eye movement -
  // or 2.56 degrees of rotation. At a 40 unit radius a 1.4 deg/s orbit drags
  // the eye a metre a second, so the position term tripped on literally every
  // frame and the capture was re-sorted about fifteen times a second. Each
  // landing reshuffles the blend order of a hundred thousand overlapping
  // transparent quads at once, and that discrete swap is the jitter.
  //
  // For an orthographic camera the eye's POSITION is optically meaningless -
  // only its direction and the frustum matter - so all of that motion was
  // bought for nothing. The arithmetic for how close is close enough: the
  // direction term allows 2.56 degrees, which at 1.4 deg/s is 1.8 s, and the
  // eye must travel under 1 mm in that time. r x 0.0246 rad/s x 1.8 s < 0.001
  // gives r < 2.3 cm. Hence 2 cm - near enough to be still, far enough that
  // OrbitControls still has a well-conditioned direction to build its spherical
  // from.
  //
  // Which then requires a NEGATIVE near plane, and this is the part that makes
  // it safe rather than a clipping disaster. An orthographic projection has no
  // eye point to be in front of, so near may be negative: the visible slab
  // simply extends 200 units either side of the target instead of 0.05 to 200
  // in front of an eye standing 40 back. Everything that was in shot is still
  // in shot, and nothing can clip through the roof because the roof is inside
  // the slab from both directions.
  const ORTHO_EYE_R = 0.02;
  const ORTHO_SLAB = 200;
  let camera;
  if (S.ortho) {
    const hh = S.viewHeight / 2;
    const hw = hh * (startW / startH);
    camera = new THREE.OrthographicCamera(-hw, hw, hh, -hh, -ORTHO_SLAB, ORTHO_SLAB);
  } else {
    camera = new THREE.PerspectiveCamera(S.fov, startW / startH, 0.05, 6000);
  }
  camera.position.set(S.camPos[0], S.camPos[1], S.camPos[2]);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(S.camTarget[0], S.camTarget[1], S.camTarget[2]);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.rotateSpeed = 0.45;
  controls.zoomSpeed = 0.6;
  if (S.ortho) {
    controls.minZoom = 0.55;
    controls.maxZoom = 2.6;
    // On the target, near enough to be still. See WCS:ORTHO-EYE.
    _vA.subVectors(camera.position, controls.target).normalize();
    camera.position.copy(controls.target).addScaledVector(_vA, ORTHO_EYE_R);
  } else {
    controls.minDistance = 1.2;
    controls.maxDistance = 7;
  }
  // Camera elevation limits, in degrees above the horizon, per style. The old
  // pair were shared and the low one was 1.62 rad of polar angle -- which is
  // 2.8 degrees BELOW horizontal, so the camera could sink under the ground and
  // look up through it. Anywhere near the horizon also puts the far edge of the
  // 60 m ground plane in shot, which reads as the world running out.
  //
  // The floor has to be per style: storybook looks DOWN at a lawn from 26
  // degrees and can afford a high floor, while golden's whole composition is a
  // near-horizontal view across a meadow from 3.6 and would be thrown out of
  // frame by the same number.
  controls.minPolarAngle = (90 - S.elevRange[1]) * DEG;
  controls.maxPolarAngle = (90 - S.elevRange[0]) * DEG;
  controls.enablePan = false;      // panning is how you lose the subject
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.12; // slow enough to feel like drifting air
  controls.update();

  // === WCS:PLACE-CAMERA (1 of 2) ===
  // P4. Whether the visitor may move the camera is the PLACE's business, not the
  // style's: a procedural world can be walked around, and a capture shot in one
  // direction cannot (the author's own note - off axis there is nothing there).
  //
  // Three separate things rewrite this camera every frame and every resize, and
  // all three have to be told (H13):
  //   autoRotate     armed by main.js after 12 s idle, and it does NOT check
  //                  controls.enabled, so switching the controls off is not
  //                  enough. Held down in applyPlaceCamera and again per frame.
  //   applyFraming   resets target and distance on every orientation change.
  //   keepTopInShot  eases the target upward on every single render.
  // Part 2 of this region, down by the framing helpers, is where the last two
  // learn about it.
  let cameraFixed = false;

  function applyPlaceCamera(p) {
    const c = p.camera;
    const wasFixed = cameraFixed;
    cameraFixed = !!(c && c.fixed);
    if (!cameraFixed) {
      controls.enabled = true;
      // Coming back from a fixed place, the eye is still standing where that
      // place put it -- the porch seen from the forest's bearing, which is a
      // view of the porch nobody composed. Only on the way BACK, so a visitor
      // who has orbited, opened the Place panel and closed it again does not
      // find their view snapped home.
      if (wasFixed) {
        controls.target.set(S.camTarget[0], S.camTarget[1], S.camTarget[2]);
        _vA.set(S.camPos[0] - S.camTarget[0], S.camPos[1] - S.camTarget[1], S.camPos[2] - S.camTarget[2]);
        if (S.ortho) {
          camera.zoom = 1;
          _vA.normalize().multiplyScalar(ORTHO_EYE_R);
        }
        camera.position.copy(controls.target).add(_vA);
      }
      if (c && c.orbit) {
        controls.minPolarAngle = (90 - c.orbit.elevDeg[1]) * DEG;
        controls.maxPolarAngle = (90 - c.orbit.elevDeg[0]) * DEG;
        if (S.ortho) {
          controls.minZoom = c.orbit.zoom[0];
          controls.maxZoom = c.orbit.zoom[1];
        } else {
          controls.minDistance = c.orbit.zoom[0] * 3.0;
          controls.maxDistance = c.orbit.zoom[1] * 3.0;
        }
      }

      // AN ORBITABLE PLACE MAY STILL COMPOSE ITS OPENING SHOT.
      //
      // azDeg and elevDeg were read only under `cameraFixed` below, so a place
      // that authored them AND allowed orbit had them quietly ignored - the eye
      // kept the STYLE's bearing, which is a view composed for a porch pointed
      // at a wood. forest-path has carried 180/14 since it was written and has
      // never once used them.
      //
      // A start, not a cage: this runs when the place goes up, and the visitor
      // drags away from it freely afterwards. Aimed from S.camTarget rather than
      // the place's own target because applyFraming, which runs immediately
      // after this on a non-fixed ortho place, resets controls.target to exactly
      // that - so composing against anything else would be undone one line later.
      if (c && Number.isFinite(c.azDeg) && Number.isFinite(c.elevDeg)) {
        const el = c.elevDeg * DEG;
        const az = c.azDeg * DEG;
        _vA.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
        controls.target.set(S.camTarget[0], S.camTarget[1], S.camTarget[2]);
        // The fixed branch's own numbers, repeated rather than shared with
        // BASE_DIST: that const is declared six hundred lines below this
        // function and reading it here is a temporal dead zone away from a
        // ReferenceError the first time a place goes up.
        camera.position.copy(controls.target).addScaledVector(_vA, S.ortho ? ORTHO_EYE_R : 5.5);
        if (S.ortho && Number.isFinite(c.zoom)) camera.zoom = c.zoom;
        controls.update();
      }
      return;
    }

    // Fixed. Aim from the place's own bearing and elevation. For an ortho eye
    // the vector is direction only -- distance changes nothing but clipping --
    // which is the same convention S.camPos already uses.
    const tgt = c.target || [0, 1.45, 0];
    const el = (c.elevDeg === null || c.elevDeg === undefined ? 16 : c.elevDeg) * DEG;
    const az = (c.azDeg === null || c.azDeg === undefined ? 180 : c.azDeg) * DEG;
    _vA.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    camera.position.set(tgt[0], tgt[1], tgt[2]).addScaledVector(_vA, S.ortho ? ORTHO_EYE_R : 5.5);
    camera.lookAt(tgt[0], tgt[1], tgt[2]);
    if (S.ortho) camera.zoom = 1;

    // controls.target is not the aim any more -- nothing reads it as an aim once
    // the orbit is off. Two things DO read it, and both want it here:
    //
    //   cameraDistance()  the sole input to audio's distance gain (H14). It does
    //                     not read the target at all. It used to read the LIVE
    //                     frustum height and the comment here used to claim that
    //                     places.js kept both places on the same one; places.js
    //                     did not and does not -- it authors 2.85 here and 2.60
    //                     on the porch, and the level stepped 1.24 dB on every
    //                     switch. cameraDistance() now reports the STYLE's own
    //                     height, which is the same number in every place, so
    //                     the invariant holds by construction.
    //   audio.setListener the strike panner projects (strike - target) onto the
    //                     camera's right vector, so only the target's LATERAL
    //                     position matters. Leaving it on the aim point keeps
    //                     the panning identical to the porch's.
    controls.target.set(tgt[0], tgt[1], tgt[2]);
    controls.enabled = false;
    controls.autoRotate = false;
    controls.update();
  }
  // === /WCS:PLACE-CAMERA (1 of 2) ===

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
  // In the storybook style the sky is a flat background colour, so the Sky mesh
  // is never built. Everything downstream guards on `sky` being null rather
  // than on the style name, so there is one thing to get right instead of five.
  const sky = S.sky ? new Sky() : null;
  if (sky) {
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
  }

  // -- light ----------------------------------------------------------------
  // Exactly one shadow caster. Everything else is ambient bounce; a second
  // shadowed light doubles the shadow pass for a difference nobody can name.
  const sun = new THREE.DirectionalLight(S.sunColor, S.sunIntensity);
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
  sun.shadow.camera.left = -S.shadowHalf[0];
  sun.shadow.camera.right = S.shadowHalf[0];
  sun.shadow.camera.top = S.shadowHalf[1];
  sun.shadow.camera.bottom = -S.shadowHalf[1];
  sun.shadow.camera.near = S.shadowNear;
  sun.shadow.camera.far = S.shadowFar;
  sun.shadow.mapSize.set(tier.shadowMapSize, tier.shadowMapSize);
  // Bias is expressed in NORMALISED depth, so it scales with near..far. Over
  // this 40 m range -0.0004 is 16 mm of slop; the ground is nearly edge-on to
  // an 11 degree sun, which is the worst case for acne, so most of the work is
  // done by normalBias instead (it offsets along the surface normal, which is
  // exactly the direction the error lies in here).
  sun.shadow.bias = S.shadowBias;
  sun.shadow.normalBias = S.shadowNormalBias;
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
  const hemi = new THREE.HemisphereLight(S.hemiSky, S.hemiGround, S.hemiIntensity);
  scene.add(hemi);

  // -- ground and porch -----------------------------------------------------
  const groundGeo = new THREE.PlaneGeometry(GROUND_HALF * 2, GROUND_HALF * 2);
  // envMapIntensity well under 1 on every matte surface. The baked sky is a
  // real radiance map and a flat plane has no ambient occlusion of its own, so
  // taking it at full strength floods the picture and flattens the sun out of
  // it. The map below supplies the occlusion that is not being computed.
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.95, metalness: 0, envMapIntensity: 0.58 * S.envIntensity,
    map: makeGroundMap(
      S.porchRoof !== false,
      [(S.ground >> 16 & 255) / 255, (S.ground >> 8 & 255) / 255, (S.ground & 255) / 255],
      S.groundVariation,
      S.groundOcclusion
    ),
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const cedarMat = new THREE.MeshStandardMaterial({
    color: S.cedar, roughness: 0.85, metalness: 0, envMapIntensity: 0.56 * S.envIntensity,
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
    color: S.roof, roughness: 0.9, metalness: 0, envMapIntensity: 0.40 * S.envIntensity,
  });
  const roof = new THREE.Mesh(roofGeo, roofMat);
  roof.position.set(0, 2.78, 0);
  roof.castShadow = true;
  // Under an orthographic camera a 3 x 1.4 m slab overhead is a hard-edged
  // parallelogram across the top of the frame that never gets smaller with
  // distance, and it takes the whole upper third. The storybook scene hangs the
  // chime from the beam alone, which also lets the camera look down far enough
  // to put the meadow in frame.
  if (S.porchRoof !== false) porch.add(roof);

  // The screw eye the whole rig hangs from, at (0, 2.60, 0).
  const hookGeo = new THREE.TorusGeometry(0.016, 0.004, 6, 16);
  const hookMat = new THREE.MeshStandardMaterial({
    color: S.hook, roughness: S.ortho ? 1.0 : 0.5, metalness: S.ortho ? 0 : 0.8, envMapIntensity: 0.9 * S.envIntensity,
  });
  const hook = new THREE.Mesh(hookGeo, hookMat);
  hook.position.set(0, HOOK_Y + 0.012, 0);
  hook.rotation.y = Math.PI / 2;
  hook.castShadow = true;
  porch.add(hook);

  scene.add(porch);

  // -- ground cover ---------------------------------------------------------
  //
  // Bushes are a few overlapping spheres, not a cloud of alpha-tested leaf
  // cards. That is how the reference art gets its silhouette: a lumpy outline
  // made of round lobes, hard-edged against a flat lawn. Three practical wins
  // come with it. It is one draw call for every bush in the scene. It casts a
  // real, solid shadow, where a card cluster's shadow is a mess of pinholes.
  // And there is no alpha, so nothing has to sort against the grass.
  //
  // The lawn is just the ground plane. A field of individual blades reads as
  // stipple at this scale and spent three thousand instances doing it; a solid
  // surface with a real shadow falling across it is both cheaper and closer to
  // the reference. What is left of the grass is a sparse scatter of small
  // static tufts -- the spouts that poke up here and there -- clustered toward
  // the bushes, where growth actually gets away from a mower.
  const cover = new THREE.Group();
  scene.add(cover);

  const coverGeoms = [];
  const coverMats = [];

  // Bush sway. Applied in the vertex shader rather than by rewriting instance
  // matrices: one uniform write a frame moves every lobe of every bush, and the
  // lobes keep their relative positions so the mass never comes apart.
  //
  // The displacement is quadratic in height above the ground, so a bush pivots
  // at its skirt the way a rooted thing does, and it is divided by the
  // instance's own scale because `transformed` is in the sphere's local space
  // where a unit is one radius. instanceMatrix here is scale plus translation
  // only, so the length of its first column IS that scale.
  const bushUniforms = {
    uSway: { value: new THREE.Vector2() },
    uSwayH: { value: 1.15 },
  };

  function patchBushSway(mat) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uSway = bushUniforms.uSway;
      shader.uniforms.uSwayH = bushUniforms.uSwayH;
      shader.vertexShader = 'uniform vec2 uSway;\nuniform float uSwayH;\n' + shader.vertexShader
        .replace('#include <begin_vertex>', [
          '#include <begin_vertex>',
          '{',
          '  float sc = max(length(instanceMatrix[0].xyz), 1e-4);',
          '  vec3 wp = (instanceMatrix * vec4(transformed, 1.0)).xyz;',
          '  float hh = clamp(wp.y / uSwayH, 0.0, 1.0);',
          '  transformed.xz += (uSway * hh * hh) / sc;',
          '}'
        ].join('\n'));
    };
    mat.customProgramCacheKey = () => 'wcs-bush-sway';
  }

  function buildGroundCover() {
    const clusters = S.shrubClusters || [];

    // One bush is a big core lobe with a ring of smaller ones around its skirt
    // and a couple riding on top. Offsets are in units of the cluster radius so
    // a bush of any size keeps its proportions.
    // The skirt lobes sit well INSIDE the core's radius. Spread out they read as
    // a pile of separate balls; overlapping they merge into one mass whose only
    // trace of the spheres is a scalloped outline, which is the whole point.
    const LOBES = [
      [0.00, 0.60, 0.00, 1.00],
      [-0.56, 0.36, 0.16, 0.72],
      [0.52, 0.38, -0.18, 0.76],
      [0.11, 0.33, 0.55, 0.68],
      [-0.17, 0.36, -0.53, 0.64],
      [-0.33, 0.84, -0.24, 0.60],
      [0.32, 0.87, 0.21, 0.56],
      [0.03, 1.02, -0.05, 0.48],
    ];

    if (clusters.length) {
      // 12 x 8 segments is enough that a lobe reads as round at this scale and
      // few enough that two dozen of them are free.
      const bushGeo = new THREE.SphereGeometry(1, 12, 8);
      const bushMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,   // per-instance colour carries the tint
        roughness: 0.98,
        metalness: 0,
        envMapIntensity: 0.5 * S.envIntensity,
        // A sphere under a directional light has a wide tonal range and reads as
        // a ball. Lifting the dark end with a matching emissive compresses that
        // range so the mass reads as one flat-ish shape with a lumpy edge, and
        // leaves just enough gradient to say which side the sun is on.
        emissive: new THREE.Color(S.shrub),
        emissiveIntensity: S.bushFlat || 0,
      });
      patchBushSway(bushMat);
      const total = clusters.length * LOBES.length;
      const bushes = new THREE.InstancedMesh(bushGeo, bushMat, total);
      bushes.castShadow = true;
      bushes.receiveShadow = true;
      bushes.name = 'wcs-bushes';
      // The shadow pass runs its own material, so without this the bush would
      // sway while its shadow stood still.
      const bushDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
      patchBushSway(bushDepth);
      bushes.customDepthMaterial = bushDepth;
      coverMats.push(bushDepth);

      const base = new THREE.Color(S.shrub);
      let n = 0;
      for (let c = 0; c < clusters.length; c++) {
        const cl = clusters[c];
        const r = cl.r || 0.4;
        for (let k = 0; k < LOBES.length; k++) {
          const L = LOBES[k];
          // A little per-lobe jitter, seeded so the bush is the same shape on
          // every visit. A bush that reshuffles itself each reload reads as
          // noise rather than as a thing that grows there.
          const j = hash1(c * 37.1 + k * 5.7);
          const j2 = hash1(c * 11.3 + k * 19.4 + 0.5);
          const s = r * L[3] * (0.86 + 0.28 * j);
          _vA.set(
            cl.x + L[0] * r * (0.9 + 0.2 * j2),
            (cl.y || 0) * 0.25 + L[1] * r,
            cl.z + L[2] * r * (0.9 + 0.2 * j)
          );
          _mat.makeScale(s, s * 0.86, s);   // squashed: a bush is wider than it is tall
          _mat.setPosition(_vA.x, _vA.y, _vA.z);
          bushes.setMatrixAt(n, _mat);
          // Lobes that sit lower are deeper in the mass and darker; the shading
          // a sphere gets on its own is not enough to separate them.
          _colA.copy(base).multiplyScalar(0.86 + 0.16 * (L[1] / 1.02) + 0.04 * j);
          bushes.setColorAt(n, _colA);
          n++;
        }
      }
      bushes.instanceMatrix.needsUpdate = true;
      if (bushes.instanceColor) bushes.instanceColor.needsUpdate = true;
      cover.add(bushes);
      coverGeoms.push(bushGeo);
      coverMats.push(bushMat);
    }

    // -- tufts --------------------------------------------------------------
    // Three tapered blades in a fan, built once and instanced. No wind term at
    // all: the streamers, the leaves, the telltale and the chime itself carry
    // the wind, and grass that twitches with them was the single biggest source
    // of visual noise in the frame.
    const BLADES = 3;
    const TUFT_H = S.tuftHeight || 0.105;
    const posArr = [];
    const nrmArr = [];
    const idxArr = [];
    for (let b = 0; b < BLADES; b++) {
      const yaw = (b / BLADES) * Math.PI * 2 + 0.4;
      const lean = 0.22 + 0.16 * hash1(b * 3.3);
      const h = TUFT_H * (0.7 + 0.5 * hash1(b * 7.7));
      const w = 0.011;
      const cx = Math.cos(yaw), sz = Math.sin(yaw);
      // Root pair, then a tip leaning downwind of its own yaw.
      const tipX = cx * lean * h, tipZ = sz * lean * h;
      const px = -sz * w, pz = cx * w;
      const o = posArr.length / 3;
      posArr.push(px, 0, pz, -px, 0, -pz, tipX, h, tipZ);
      for (let k = 0; k < 3; k++) nrmArr.push(0, 1, 0);
      // Each blade is emitted TWICE with opposite winding, and the material is
      // single-sided. DoubleSide would be one triangle and half the work, but
      // three flips the normal on a back face -- and this normal points UP, so
      // the flipped copy points DOWN, gets no sun at all, and the blade reads
      // as near-black from one side. Two windings sharing one upward normal
      // means a blade shades like the lawn it grows out of from every angle.
      idxArr.push(o, o + 1, o + 2, o, o + 2, o + 1);
    }
    const tuftGeo = new THREE.BufferGeometry();
    tuftGeo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    tuftGeo.setAttribute('normal', new THREE.Float32BufferAttribute(nrmArr, 3));
    tuftGeo.setIndex(idxArr);

    const tuftMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1.0,
      metalness: 0,
      side: THREE.FrontSide,
      envMapIntensity: 0.4 * S.envIntensity,
    });

    const N_TUFTS = S.tufts || 0;
    if (N_TUFTS > 0) {
      const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, N_TUFTS);
      tufts.castShadow = false;   // a 10 cm blade's shadow is below the map's resolution
      // Nor does it receive: a thin vertical triangle carrying an upward normal
      // is the worst case for shadow acne, and normalBias offsets along that
      // normal, which is the one direction that cannot help here.
      tufts.receiveShadow = false;
      tufts.name = 'wcs-tufts';

      // Same hue and saturation as the bushes, at a lightness just below the
      // lawn's. Derived from the two colours rather than written down, so the
      // relationship survives either of them being retuned. The old olive and
      // straw pair belonged to the lit-blade shader and read as dead grass
      // scattered over a green lawn.
      // BOTH ends of this have to be in the same colour space. getHSL defaults
      // to the LINEAR working space while setHSL below is told sRGB, so reading
      // a lightness one way and writing it back the other darkened every tuft
      // twice -- 0.94 of the lawn came out at roughly half of it.
      const _hsl = {};
      new THREE.Color(S.shrub).getHSL(_hsl, THREE.SRGBColorSpace);
      const _lawnHsl = {};
      new THREE.Color(S.ground).getHSL(_lawnHsl, THREE.SRGBColorSpace);
      const tuftH = _hsl.h;
      // Saturation two thirds of the way from the lawn to the bush: the hue is
      // the bush's, as asked, but taking its full saturation as well made the
      // tufts pop off the lawn instead of sitting on it.
      const tuftS = _lawnHsl.s + (_hsl.s - _lawnHsl.s) * 0.65;
      const tuftL = _lawnHsl.l * (S.tuftDarken || 0.90);
      for (let i = 0; i < N_TUFTS; i++) {
        const a = hash1(i * 1.37) * Math.PI * 2;
        // Square-rooted radius spreads them evenly over the disc instead of
        // piling them at the middle.
        const rad = 0.7 + Math.sqrt(hash1(i * 2.71 + 0.3)) * (S.tuftRadius || 5.0);
        let x = Math.cos(a) * rad;
        let z = Math.sin(a) * rad;
        // Pull a third of them in toward a bush: grass gets away from a mower
        // at the foot of something, and the reference art puts its spouts
        // exactly there.
        if (clusters.length && hash1(i * 5.11 + 0.7) < 0.55) {
          const cl = clusters[i % clusters.length];
          const t = 0.72 + 0.5 * hash1(i * 8.9);
          x = cl.x + (x - cl.x) * 0.16 * t + (hash1(i * 4.4) - 0.5) * 0.75;
          z = cl.z + (z - cl.z) * 0.16 * t + (hash1(i * 6.2) - 0.5) * 0.75;
        }
        const s = 0.70 + 0.55 * hash1(i * 9.13);
        _mat.makeRotationY(hash1(i * 3.91) * Math.PI * 2);
        _mat.scale(_vB.set(s, s, s));
        _mat.setPosition(x, 0, z);
        tufts.setMatrixAt(i, _mat);
        // A little lightness spread so the scatter is not one flat tone.
        _colA.setHSL(tuftH, tuftS, tuftL * (0.90 + 0.20 * hash1(i * 12.7)), THREE.SRGBColorSpace);
        tufts.setColorAt(i, _colA);
      }
      tufts.instanceMatrix.needsUpdate = true;
      if (tufts.instanceColor) tufts.instanceColor.needsUpdate = true;
      cover.add(tufts);
    }
    coverGeoms.push(tuftGeo);
    coverMats.push(tuftMat);
  }

  buildGroundCover();

  // === WCS:PLACE-BACKDROP ===
  // P4. Everything above this line built the porch: a sky (or a flat background
  // colour), fog, a 120 m ground plane, a beam, a post, bushes and tufts. A
  // plate place is the third branch of that: the built world switches off and a
  // photograph switches on. It is a switch and not a rebuild, because a rebuild
  // is a second stage and a second stage is a second AudioContext away from
  // being a silent page (H3, H15).
  //
  // What is deliberately NOT here: nothing is disposed on a switch. The porch's
  // fifteen handles stay allocated and hidden, so twenty switches allocate one
  // plate texture and free it again and the heap comes back to where it started
  // (H15 says dispose() names its handles by hand and nothing traverses -- the
  // way to survive that is to stop asking it to run).

  let plate = null;
  // WHERE THE VISITOR ASKED THE CHIME TO HANG, held here and not only inside the
  // plate - because the plate is destroyed and rebuilt on every place switch and
  // a design that survives a switch has to be able to put the picture back.
  //
  // The bug this closes was silent and total: a cold load of ?c=v1_hu-39_hs-75
  // reported design().hang {u:0.39,...} while plate.limits().crop reported the
  // untouched place default, and a forest -> porch -> forest round trip did the
  // same to a hang the visitor had dragged. apply.js only calls setFraming when
  // a hang FIELD CHANGES, so a place switch that resets the framing underneath
  // an unchanged design can never repair itself, and the URL and the picture
  // diverge with nothing to report. Remembering the ask is the whole fix.
  let wantFraming = null;
  // The same bargain for the capture's detail, and it matters here for one more
  // reason than it does for the framing: the gaussians arrive ASYNCHRONOUSLY.
  // A design carrying 40 percent applies before the .sog has finished loading,
  // so the number has to be sitting here for createSplat to read on arrival or
  // the first sight of the forest is at full cost on a machine that asked for
  // less.
  let wantDetail = Number.isFinite(params.splatDetail) ? params.splatDetail : 1;
  let wantCord = Number.isFinite(params.hangCord) ? params.hangCord : 0.61;
  const placeErrors = [];
  let placeErrorSink = null;

  function notePlaceError(tag) {
    if (typeof placeErrorSink === 'function') placeErrorSink(tag);
    else if (placeErrors.indexOf(tag) === -1) placeErrors.push(tag);
  }

  function disposePlate() {
    if (!plate) return;
    plate.dispose();
    plate = null;
  }

  // windviz is meadow furniture, and ALL THREE of its pieces are (H16). It
  // allocates across a hard-coded volume 16 m across and 4.5 m tall, which over
  // a lawn reads as air moving and over a photograph reads as things laid on
  // top of it. Measured on the shipped frame, one at a time:
  //
  //   wcs-streamers  8 m streaks crossing the canopy, the path and the chime in
  //                  one straight line.
  //   wcs-leaves     autumn tan and red lozenges, at full luminance, drifting
  //                  in front of high-summer foliage that measures near black.
  //                  The first cut kept them on the argument that "a leaf
  //                  blowing past a photographed wood is the same leaf". It is
  //                  not: this capture is green end to end and these are
  //                  deciduous autumn colours at a depth the plate cannot hold.
  //   wcs-telltale   a maroon blade jutting 130 px out of the top plate, the
  //                  only saturated red in a green and grey frame. It is a
  //                  reading of the wind rather than a part of the object, and
  //                  on a place whose whole claim is "this is a photograph"
  //                  it is the loudest thing in it.
  //
  // On a plate place the chime is the only thing in frame that moves - the
  // amendment this piece makes to REQUIREMENTS.md - so all three come off.
  //
  // windviz builds lazily, so the meshes do not exist at the moment a place
  // goes up. This is polled from keepTopInShot, which is already a per-frame
  // call in this piece's own region: cached references and one boolean once
  // they are found, and one getObjectByName per second until they are.
  const VIZ_ON_BUILT_WORLD = ['wcs-streamers', 'wcs-leaves', 'wcs-telltale'];
  const vizParts = [];
  let vizProbe = 0;
  function syncVizForPlace() {
    // A CACHED MESH THAT HAS LOST ITS PARENT IS ONE WINDVIZ REBUILT UNDER US,
    // and this check is the whole reason the rule below ever reaches the screen.
    //
    // windviz.setTier disposes all three meshes and builds three new ones with
    // the same names. scene.remove leaves the old ones parentless; the new ones
    // are what gets drawn. This function cached the old three, found
    // vizParts.length already at 3 so never probed again, and spent every frame
    // afterwards writing `visible` to objects nobody renders. Silently, and
    // with every input to the decision correct.
    //
    // It is not a rare path. main.js drops the tier adaptively on a scene that
    // misses frame budget, and the heaviest scene here is the very one the wind
    // lines are supposed to be off in - so the forest downgraded itself and
    // turned its own streamers back on.
    let stale = false;
    for (const o of vizParts) if (!o.parent) { stale = true; break; }
    if (stale) { vizParts.length = 0; vizProbe = 0; }
    if (vizParts.length < VIZ_ON_BUILT_WORLD.length) {
      // The countdown is for meshes that do not exist YET - windviz builds
      // lazily - so a rebuild does not have to wait it out: the branch above
      // zeroes it and this probes on the same frame.
      if (vizProbe-- > 0) return;
      vizProbe = 60;
      vizParts.length = 0;
      for (const n of VIZ_ON_BUILT_WORLD) {
        const o = scene.getObjectByName(n);
        if (o) vizParts.push(o);
      }
      if (vizParts.length === 0) return;
    }
    // THE BUILT WORLD ONLY, which today means the porch and says so.
    //
    // This read `place.kind !== 'plate'`, which picked out the same one place
    // by describing everything it is not. The rule Myra asked for is the
    // positive one - the wind lines belong to the world this page models, not
    // to a photograph of somewhere else - and it is the phrasing that stays
    // true when a third place arrives. A capture has no ground plane these
    // streamers can be laid over and no way to know where its air goes, so
    // guessing a path through someone's photograph is the failure this avoids.
    const want = place.kind === 'procedural';
    for (const o of vizParts) if (o.visible !== want) o.visible = want;
  }

  /**
   * Put a place up. Total: an id this build does not know resolves to the
   * default, and a plate whose image will not load falls through to the
   * place's own fallback -- which is porch, which needs no asset and therefore
   * cannot fail the same way.
   */
  function applyPlace(next, depth) {
    const p = typeof next === 'string' ? resolvePlace(next) : (next || place);
    place = p;
    applyPlaceShadows();
    const isPlate = p.kind === 'plate' && p.backdrop && p.backdrop.src;

    disposePlate();

    // The built world. Hidden, never removed.
    ground.visible = !isPlate;
    porch.visible = !isPlate;
    cover.visible = !isPlate;
    if (sky) sky.visible = !isPlate;

    if (isPlate) {
      // Criterion 4: no ground plane, no Sky mesh, no background colour and no
      // fog may be visible on a plate place. The quad covers every pixel, but
      // the clear colour still shows for the frames before the image lands and
      // in any driver corner where it does not, so it is the plate's own tint
      // rather than the style's off-white.
      scene.background = new THREE.Color(p.backdrop.tint);
      // FogExp2 is applied to every mesh unconditionally (H17). Both places ship
      // under storybook, whose fogCalm and fogBlown are both 0.0, so there is no
      // fog on the chime in either. This zero is the statement of intent rather
      // than the enforcement: render() rewrites the density from the wind every
      // frame, and giving a plate place a fogged style would need a line there
      // as well. tools/verify-place.mjs fails the day one is given one.
      scene.fog.density = 0;
      // A place that ships a capture draws the capture. The plate path below is
      // still here and still correct - it is what a place with an image and no
      // gaussians gets - but the forest has both, and the gaussians are the
      // whole reason anyone can move through it.
      const onPlaceError = (tag) => {
        if (tag && tag !== 'place-asset-failed') { notePlaceError(tag); return; }
        // The asset 404'd or decoded badly. Land somewhere that works FIRST,
        // then say so -- in that order, because the listener's job is to make
        // the design admit where the visitor actually ended up, and a listener
        // fired before the fallback would read the place that just failed and
        // conclude nothing had changed. The load is asynchronous, so applyPlace
        // has long since returned and this re-entry is safe.
        if ((depth | 0) < 2) applyPlace(fallbackFor(p), (depth | 0) + 1);
        notePlaceError('place-asset-failed');
      };
      plate = (p.backdrop && p.backdrop.splat)
        // No camera hook, deliberately. A shiftView() used to live here so a
        // pick could move the eye and its target by the same vector the capture
        // moved by, holding the forest still on screen. It was written to fix a
        // disappearing forest that turned out to be an invalid SplatEdit blend
        // mode (see splat.js), and it made things worse on its own account: an
        // eye moved off the chime is an eye applyFraming re-aims on the next
        // resize and OrbitControls re-clamps on the next drag. A pick brings
        // the picked gaussian to the hook, the hook is already the middle of
        // this frame, and nothing here has to move for that to be in shot.
        ? createSplat({ scene, renderer, container, getCamera: () => camera }, p, onPlaceError)
        : createPlate({
        scene,
        container,
        maxAnisotropy: maxAniso,
        viewHeight: () => (S.ortho ? viewHeight / Math.max(camera.zoom, 1e-3) : viewHeight)
      }, p, onPlaceError);
    } else {
      scene.background = (S.background !== null && S.background !== undefined)
        ? new THREE.Color(S.background) : null;
      scene.fog.density = FOG_CALM;
    }

    // The light. A place owns where its sun is and how hard it burns; applySun
    // owns the direction, and for a style with no sky it returns before
    // touching colour or intensity, so these two assignments stick.
    if (p.sun) {
      if (Number.isFinite(p.sun.color)) sun.color.setHex(p.sun.color, THREE.SRGBColorSpace);
      if (Number.isFinite(p.sun.intensity)) sun.intensity = p.sun.intensity;
    }

    // The FILL, which is the half of ARBITRATION 5's second defect that is not
    // the dapple. A hemisphere light is the only lever this piece has on how the
    // chime's metal is coloured: the tube materials belong to the synthesis half
    // and CONTRACTS 2.1 puts every material definition off limits here. So the
    // place hands the light its own bounce instead - the canopy's green from
    // above and the path's warm grey from below, both sampled off the plate -
    // and the object picks the wood up without one line of buildChime moving.
    if (p.fill) {
      if (Number.isFinite(p.fill.sky)) hemi.color.setHex(p.fill.sky, THREE.SRGBColorSpace);
      if (Number.isFinite(p.fill.ground)) hemi.groundColor.setHex(p.fill.ground, THREE.SRGBColorSpace);
      if (Number.isFinite(p.fill.intensity)) hemi.intensity = p.fill.intensity;
    } else {
      hemi.color.setHex(S.hemiSky, THREE.SRGBColorSpace);
      hemi.groundColor.setHex(S.hemiGround, THREE.SRGBColorSpace);
      hemi.intensity = S.hemiIntensity;
    }

    if (p.shadow && p.shadow.halfExtent) {
      sun.shadow.camera.left = -p.shadow.halfExtent[0];
      sun.shadow.camera.right = p.shadow.halfExtent[0];
      sun.shadow.camera.top = p.shadow.halfExtent[1];
      sun.shadow.camera.bottom = -p.shadow.halfExtent[1];
      sun.shadow.camera.updateProjectionMatrix();
    }
    // r185 deprecated PCFSoftShadowMap and substitutes PCF, but PCF still scales
    // its own taps by shadow.radius - so this is the one knob that softens an
    // edge without changing the shadow map type out from under the other place.
    // A photograph whose every shadow is a soft-edged band is not a place to put
    // a 3 mm-per-texel hard edge.
    sun.shadow.radius = (p.shadow && Number.isFinite(p.shadow.softness)) ? p.shadow.softness : 1;

    applyPlaceCamera(p);
    // Through applyFraming rather than straight to applyOrthoFrustum, because a
    // place authors its own frustum height and applyFraming is the one function
    // that owns that variable. It also re-seats the orbit target on the way back
    // to a procedural place, which a bare frustum update would not.
    if (S.ortho) applyFraming(aspectNow() < 1 / 1.05);
    else { camera.aspect = aspectNow(); camera.updateProjectionMatrix(); }
    // The design's hang, put back on top of the place's default. plate.setFraming
    // clamps to whatever the NEW place allows, so a hang carried in from a place
    // with wider ranges lands legally rather than off the edge of the image.
    if (plate && wantFraming) {
      plate.setFraming(wantFraming.u, wantFraming.v, wantFraming.scale);
    } else if (plate) {
      plate.resize();
    }
    // And the detail and the cord the design asked for, on the same terms. A
    // plate implements neither, so both are no-ops there by construction rather
    // than by a test on p.kind.
    if (plate && typeof plate.setDetail === 'function') plate.setDetail(wantDetail);
    if (plate && typeof plate.setCord === 'function') plate.setCord(wantCord);

    // Last, because a PMREM bake is not free and setSunElevation only does one
    // if the angle actually moved by more than half a degree.
    //
    // It has to land in `params` as well as in the stage: frame() pushes
    // params.sunElevDeg back through setSunElevation on EVERY frame, so an
    // elevation set here and not there survives exactly one frame. Writing the
    // one field is also the correct handoff -- apply.js reads it straight back
    // out through defaultSun() whenever design.view.sun is null, which is what
    // "the place decides" means. A visitor who HAS moved the sun slider keeps
    // their angle: apply.js re-applies view.sun after setPlace returns, which
    // is the documented cost of leaving that slider live on a plate place.
    if (p.sun && Number.isFinite(p.sun.elevDeg)) {
      setSunElevation(p.sun.elevDeg);
      params.sunElevDeg = currentSunElev;
    }
  }
  // === /WCS:PLACE-BACKDROP ===

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
    const plateGeo = new THREE.CylinderGeometry(R_PLATE, R_PLATE, 0.012, 32);
    const plateMat = new THREE.MeshStandardMaterial({
      color: S.plate, roughness: 0.85, metalness: 0, envMapIntensity: 0.56 * S.envIntensity,
    });
    plateMesh = new THREE.Mesh(plateGeo, plateMat);
    plateMesh.castShadow = true;
    // RECEIVE as well as cast, and this is new for every piece of the chime.
    // Every mesh here has cast since the beginning and not one of them has ever
    // caught anything, so the object has been lit as though it were convex: no
    // plate shadow across the tube tops, no tube darkening the tube behind it,
    // the striker and the sail floating in their own even light. On the porch
    // that was a missed detail. On a capture, where the object has to sit in a
    // photograph of real light, it is most of why it reads as pasted on.
    plateMesh.receiveShadow = true;
    chime.add(plateMesh);
    chimeGeoms.push(plateGeo);
    chimeMats.push(plateMat);

    // Tubes. Open-ended so you can see down the bore when they tilt, with a
    // BackSide inner cylinder standing in for the dark interior.
    const boreMat = new THREE.MeshStandardMaterial({
      color: S.bore, roughness: 0.92, metalness: 0.05, side: THREE.BackSide,
      envMapIntensity: 0.34,
    });
    chimeMats.push(boreMat);

    for (let i = 0; i < n; i++) {
      const L = tubes[i].L;
      const outerGeo = new THREE.CylinderGeometry(R_TUBE, R_TUBE, L, 20, 1, true);
      // A 4 percent hue spread across the set. Nobody consciously notices it;
      // it is what stops six identical cylinders looking clone-stamped.
      const h = THREE.MathUtils.lerp(S.tubeHueDeg[0], S.tubeHueDeg[1], n > 1 ? i / (n - 1) : 0.5) / 360;
      const mat = new THREE.MeshStandardMaterial({
        // On the metal tubes saturation is kept very low, because a metal tints
        // its reflection by its base colour and anything stronger turns the far
        // tubes visibly cyan. Painted tubes have no such constraint, so the
        // storybook set carries real colour -- with no travelling highlight to
        // tell them apart, colour is the only thing that does.
        color: new THREE.Color().setHSL(h, S.tubeSat, S.tubeLight, THREE.SRGBColorSpace),
        metalness: S.tubeMetalness,
        roughness: S.tubeRoughness,   // absolute roughness lives in roughMap; see makeTubeRoughnessMap
        roughnessMap: S.tubeBrushed ? roughMap : null,
        envMapIntensity: 1.15 * S.envIntensity,
        emissive: new THREE.Color(0xfff2d0),
        emissiveIntensity: 0,
      });
      const mesh = new THREE.Mesh(outerGeo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
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
    // The clapper's diameter and the sail's height are user-adjustable, so the
    // meshes read them from params. The physics owns the authoritative clamped
    // values; these fall back to the same defaults if params is bare.
    const clapD = Number.isFinite(params.clapperWidth) ? params.clapperWidth : 0.068;
    const clapGeo = new THREE.CylinderGeometry(clapD * 0.5, clapD * 0.5, 0.014, 24);
    const clapMat = new THREE.MeshStandardMaterial({
      color: S.clapper, roughness: 0.8, metalness: 0, envMapIntensity: 0.68 * S.envIntensity,
      emissive: new THREE.Color(0xffd9a0), emissiveIntensity: 0,
    });
    clapperMesh = new THREE.Mesh(clapGeo, clapMat);
    clapperMesh.castShadow = true;
    clapperMesh.receiveShadow = true;
    chime.add(clapperMesh);
    chimeGeoms.push(clapGeo);
    chimeMats.push(clapMat);

    // Wind sail: the only part the wind meaningfully pushes.
    const sailH = Number.isFinite(params.sailHeight) ? params.sailHeight : 0.15;
    const sailGeo = new THREE.BoxGeometry(0.11, sailH, 0.004);
    const sailMat = new THREE.MeshStandardMaterial({
      color: S.sail, roughness: 0.7, metalness: 0, envMapIntensity: 0.68 * S.envIntensity,
      emissive: new THREE.Color(0xffd9a0), emissiveIntensity: 0,
    });
    sailMesh = new THREE.Mesh(sailGeo, sailMat);
    sailMesh.castShadow = true;
    sailMesh.receiveShadow = true;
    chime.add(sailMesh);
    chimeGeoms.push(sailGeo);
    chimeMats.push(sailMat);

    // Cords. One LineSegments for all of them: a TubeGeometry per cord rebuilt
    // every frame would cost more than the entire rest of the sync. The count
    // is three bridle strands to the RING, one per tube, the clapper cord, the
    // sail cord, and the rope from the branch down to the ring. syncRig clamps
    // to whatever the rig actually reports, so an undersized buffer degrades to
    // fewer drawn cords rather than to garbage -- which is exactly how the rope
    // came out invisible the first time this ran: physics.js grew a cord, this
    // number did not, and the clamp silently dropped the last one.
    const cordCount = n + 6;
    cordPositions = new Float32Array(cordCount * CORD_SEGMENTS * 2 * 3);
    const cordGeo = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(cordPositions, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    cordGeo.setAttribute('position', attr);
    // OPAQUE, and that is what puts the cords behind the leaves.
    //
    // They were transparent at 0.85 to soften a one-pixel line, and on a built
    // world that cost nothing. On a capture it cost the whole illusion: three.js
    // draws every opaque object first and every transparent one after, so the
    // tubes and the plate wrote depth, the gaussians blended over them and the
    // object sat convincingly IN the wood - while the cords, alone in the
    // transparent pass with the splats, were sorted against the capture as one
    // lump and drawn over the top of it. A chime tucked behind a branch, hung on
    // strings painted across the front of it.
    //
    // Opaque puts them back with the rest of the object, in the pass that writes
    // depth, and the splats occlude them exactly as they occlude the tubes. The
    // softening goes; at this line width it was worth about one shade and it is
    // not worth being the only part of the chime the forest cannot cover.
    const cordMat = new THREE.LineBasicMaterial({
      color: S.cord, transparent: false, fog: true,
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

    sunDirection(currentSunElev, _vA, S.sunAzDeg);
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
    // Nothing in the storybook style is reflective, so there is no environment
    // map to bake -- and skipping the PMREM convolution is the single biggest
    // saving in that style.
    if (!S.env || envBaked) return;
    bakeEnvironment();
  }

  // -- sun ------------------------------------------------------------------
  // The slider's range is authored per style: a 2..20 degree sun is what makes
  // the golden look, and the same range under flat shading just makes a dim
  // picture with the light coming from the side.
  const SUN_LO = S.sky ? 2 : 26;
  const SUN_HI = S.sky ? 20 : 74;
  let currentSunElev = THREE.MathUtils.clamp(
    Number.isFinite(params.sunElevDeg) ? params.sunElevDeg : S.sunElevDeg, SUN_LO, SUN_HI
  );

  function applySun() {
    sunDirection(currentSunElev, _vA, S.sunAzDeg);
    if (sky) sky.material.uniforms.sunPosition.value.copy(_vA).multiplyScalar(4000);
    sun.position.copy(_vA).multiplyScalar(40);

    // Low sun is redder and weaker; high sun is paler and stronger.
    const t = THREE.MathUtils.clamp((currentSunElev - 4) / 12, 0, 1);
    if (!S.sky) {
      // Flat style: the light is authored, not simulated. The slider still
      // swings the sun around, which moves the shading and the short shadows,
      // but it must not push the picture toward sunset -- there is no sky here
      // for a sunset to happen in.
      return;
    }

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
    const d = THREE.MathUtils.clamp(deg, SUN_LO, SUN_HI);
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

  // A splat place is fragment-bound in a way nothing else in this scene is: a
  // million alpha-blended quads, unsorted against each other until spark sorts
  // them, and every one of them costs again for every full-frame pass laid on
  // top. Measured at 1440x900 on an Iris Xe, cumulatively:
  //
  //     bloom on, dpr 2, splat        1.25 fps
  //     bloom off                     2.62
  //     ... and dpr 1                 5.49
  //     ... and shadows off           5.49   <- shadows cost nothing, leave them
  //     ... and no splat             15.34
  //
  // So bloom is worth 2x and the pixel ratio another 2x, and neither is worth
  // having here. The capture arrived with real bokeh and real blown highlights
  // in its own pixels; UnrealBloom on top of a photograph is paying twice for
  // something we already own.
  // Function declarations, not consts: setPixelRatio runs during init, long
  // before this line is reached, and a const arrow would still be in its
  // temporal dead zone when it did.
  function splatPlace() {
    return !!(place && place.backdrop && place.backdrop.splat);
  }

  function dprCapFor(t) {
    return splatPlace() ? Math.min(t.dprCap, 1) : t.dprCap;
  }

  /**
   * Shadows, everywhere, including on a capture.
   *
   * This used to be "shadows on a splat place, which is to say: none", and the
   * reasoning was sound at the time and wrong in one particular: the capture
   * does carry its own baked shadows, and the ground plane IS hidden on a
   * non-procedural place, so a cast shadow had nothing to land on. What that
   * missed is that the chime is its own receiver. A six-tube chime is not a
   * convex object - the plate is a lid over the whole ring, the tubes stand in
   * each other's light, the striker hangs inside all of it - and none of that
   * was being drawn, on either place, because every mesh cast and nothing
   * received. The object was lit as though it had no interior.
   *
   * That is most of why it read as pasted onto the photograph rather than
   * standing in it: the wood behind it is full of directional light and
   * occlusion, and the object in front of it had neither.
   *
   * The old note recorded turning it off taking 3.37 fps to 5.73 at 300k
   * gaussians. That was measured on the software rasteriser, where 3.37 was
   * already unusable; the number that matters is what it costs on a machine
   * that can draw this at all, and the commit body carries it.
   */
  function applyPlaceShadows() {
    renderer.shadowMap.enabled = true;
    sun.castShadow = true;
    renderer.shadowMap.needsUpdate = true;
  }

  function buildComposer() {
    if (composer || softwareGL || !S.bloom || splatPlace()) return;
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
  let lastRigState = null;

  // === WCS:DRIFT ===
  // The camera's own slow breath: a sweep across the place's arc and a lazy
  // push in and out, running whenever nobody has touched anything.
  //
  // NOT OrbitControls.autoRotate, which is what this used to be. That spins one
  // way forever, and forever is wrong for a capture: tanha shot one direction,
  // so past about seventy degrees off axis the reconstruction thins out and the
  // visitor is looking at the inside of a shell. places.js has authored that arc
  // since it was written (orbit.azDeg) and nothing ever read it. Driving the
  // azimuth here means the drift can TURN AROUND at the edges of what a place
  // actually contains, which is the difference between a camera that wanders and
  // one that wanders somewhere there is nothing to see.
  //
  // Two periods, deliberately not multiples of each other, so the sweep and the
  // zoom do not lock into one motion and start reading as a rail.
  //
  // Set from the SPEED they produce rather than picked: a sinusoid of swing S
  // and period P peaks at S x 2pi / P. 18 degrees over 320 s peaks at 0.35
  // deg/s - a degree every three seconds, which is under what the eye reads as
  // motion and about what it reads as the scene being alive.
  //
  // Four settings in one session and the path matters. 160 s matched the old
  // OrbitControls autoRotate; it doubled to 80 because at that speed the drift
  // took half a minute to notice; then it halved twice, back through 160 to
  // here. What changed in between was not taste - it was the jitter. A camera
  // that shimmers while it travels has to get somewhere quickly to be worth the
  // shimmer, so the drift was being asked to outrun a rendering artifact. With
  // the re-sorting fixed and the near cull gone, slow reads as deliberate
  // rather than as broken, and slow is what it was always supposed to be.
  //
  // The period is what changes, not the swing. Doubling the swing would double
  // how far it travels as well, and on a capture the extra degrees get spent
  // against the clamp at the edge of the arc.
  const DRIFT_SWEEP_S = 320;
  // THE SECOND MOTION IS A TRUCK, NOT A ZOOM.
  //
  // It used to breathe camera.zoom. A zoom is a lens doing something no camera
  // operator's body can do, and on an orthographic projection it is purely a
  // crop: the frame tightens and nothing moves past anything else. A truck is
  // the camera itself sliding sideways, which is a shot - and against a capture
  // full of near branches and far path it is the one that reads as being
  // somewhere rather than looking at something.
  //
  // 97 s against the sweep's 320 is 3.3 to 1, deliberately not a simple ratio,
  // so the two never fall into a single motion.
  const DRIFT_TRUCK_S = 97;
  const DRIFT_SWEEP_DEG = 18;
  // Metres either side of where the visitor left the camera, along its own
  // right vector. 0.22 is about a fifteenth of the frame's width at the shipped
  // zoom - enough that the near branches visibly pass the far ones, small
  // enough that the chime never leaves the middle of the shot.
  const DRIFT_TRUCK_M = 0.22;
  // A quarter cycle of head start, and this is the answer to "are they
  // sequential?". They were not sequential, they were WORSE: both phases began
  // at zero on every arm, so the sweep and the second motion set off together at
  // full speed and only pulled apart over minutes, which reads as one compound
  // move rather than two. Offsetting the truck by a quarter cycle puts it at
  // full displacement and zero speed exactly when the sweep is at zero
  // displacement and full speed, so they interleave from the first frame.
  const DRIFT_TRUCK_PHASE0 = Math.PI * 0.5;
  const DRIFT_TRUCK_SIN0 = Math.sin(DRIFT_TRUCK_PHASE0);
  // How long the drift takes to get up to speed and to come back down.
  //
  // Longer in than out on purpose. Coming ON is unrequested - the visitor did
  // nothing and the picture started moving - so it wants to arrive under the
  // threshold of noticing, which is a few seconds. Going OFF is the answer to
  // something they just did, and an answer that takes three seconds reads as
  // lag rather than as grace.
  const DRIFT_EASE_IN_S = 3.0;
  const DRIFT_EASE_OUT_S = 1.2;
  let driftOn = false;
  let driftArmed = false;
  // 0 stopped, 1 at full speed. This multiplies the PHASE RATE and never the
  // amplitude, and that distinction is the whole of getting this right: the
  // sweep writes an absolute bearing, base + swing x sin(phase), so fading the
  // amplitude would haul the camera back to where the drift started instead of
  // letting it coast to a halt where it is. Fading the rate freezes the phase,
  // which leaves the picture exactly where it stopped.
  let driftGain = 0;
  let driftSweepPhase = 0;
  let driftTruckPhase = 0;
  let driftAzBase = 0, driftAzSwing = 0;
  const _driftRight = new THREE.Vector3();

  // THE TRUCK, WHICH NOW HAS TWO CONTRIBUTORS.
  //
  // The drift's sinusoid and the visitor's wheel both slide the camera sideways
  // along the same axis, so they cannot each own controls.target - the second
  // writer would erase the first every frame. One offset in metres, summed, and
  // one function that writes it.
  //
  // Measured from the PLACE's authored target rather than from wherever the
  // target happens to be, because applyFraming resets it to exactly that on
  // every orientation change; anchoring on the live value would let a resize
  // bake the current truck in and let it wander a little further each time.
  let truckManual = 0;        // where the wheel has got to, eased
  let truckManualWant = 0;    // where the wheel has asked for
  let truckDrift = 0;         // the idle sweep's contribution, metres
  // Far enough to put the chime against either edge of the frame and no
  // further: past that the subject is gone and the control has stopped being a
  // camera move and started being a way to get lost.
  const TRUCK_MAX_M = 1.5;
  const TRUCK_STEP_M = 0.12;
  const _driftSph = new THREE.Spherical();
  const _driftVec = new THREE.Vector3();

  function driftCamera(dt) {
    const want = (driftOn && !cameraFixed) ? 1 : 0;
    // Keep running while there is still speed to bleed off, which is what makes
    // a stop a deceleration rather than a freeze-frame.
    if (want === 0 && driftGain <= 0) {
      if (driftArmed) {
        // HAND THE DRIFT'S LATERAL OFFSET TO THE MANUAL ONE on the way out.
        // truckDrift is only recomputed while this function runs, so once it
        // returns early the last value would sit there forever - the camera
        // would keep a sweep's worth of truck it could never get rid of, and
        // the wheel's clamp would measure from the wrong place. Folding it in
        // leaves the camera exactly where it is and lets the drift restart
        // from zero.
        truckManual += truckDrift;
        truckManualWant = truckManual;
        truckDrift = 0;
        driftArmed = false;
      }
      return;
    }
    if (!(dt > 0)) return;

    // Re-anchor every time the drift starts. The visitor has usually just spent
    // twelve seconds putting the camera somewhere; the breath is around THAT,
    // not around wherever the place opened.
    if (!driftArmed) {
      driftArmed = true;
      driftSweepPhase = 0;
      driftTruckPhase = DRIFT_TRUCK_PHASE0;
      _driftVec.subVectors(camera.position, controls.target);
      _driftSph.setFromVector3(_driftVec);
      driftAzBase = _driftSph.theta;


      // How far it may sweep, never past half the authored arc: a place that
      // only holds 20 degrees of usable capture gets a 10 degree swing rather
      // than an 18 degree one spending half its time against a clamp.
      const c = place.camera || {};
      const arc = c.orbit && Array.isArray(c.orbit.azDeg) ? c.orbit.azDeg : null;
      const cap = arc ? Math.abs(arc[1] - arc[0]) * 0.5 : DRIFT_SWEEP_DEG;
      driftAzSwing = Math.min(DRIFT_SWEEP_DEG, cap) * DEG;
    }

    // Toward full speed or toward nothing, at whichever rate applies.
    const step = dt / (want > driftGain ? DRIFT_EASE_IN_S : DRIFT_EASE_OUT_S);
    driftGain = want > driftGain
      ? Math.min(want, driftGain + step)
      : Math.max(want, driftGain - step);

    // Smoothstep, so the ramp has no corner at either end. A linear gain still
    // starts and stops with a visible kink - the speed goes from nothing to
    // rising in one frame - and a kink in a camera move is exactly the thing
    // being got rid of here.
    const g = driftGain * driftGain * (3 - 2 * driftGain);

    driftSweepPhase += (dt / DRIFT_SWEEP_S) * Math.PI * 2 * g;
    driftTruckPhase += (dt / DRIFT_TRUCK_S) * Math.PI * 2 * g;

    _driftVec.subVectors(camera.position, controls.target);
    _driftSph.setFromVector3(_driftVec);
    // Elevation and radius are the visitor's; only the bearing is ours, and it
    // is written absolutely rather than incremented so a clamp cannot ratchet.
    _driftSph.theta = driftAzBase + driftAzSwing * Math.sin(driftSweepPhase);
    const c = place.camera || {};
    const arc = c.orbit && Array.isArray(c.orbit.azDeg) ? c.orbit.azDeg : null;
    if (arc && Number.isFinite(c.azDeg)) {
      // TWO CONVENTIONS, AND THEY ARE 180 DEGREES APART.
      //
      // A place authors bearings the way applyPlaceCamera consumes them:
      // direction = (sin az, _, -cos az), so az 0 looks along -Z. Spherical
      // measures theta = atan2(x, z), so that same direction is theta = PI.
      // The identity is theta = PI - az, checked at 0, 90 and 180.
      //
      // Clamping raw degrees against raw theta - which is what this did first -
      // put every legal bearing outside the range, so the very first drift frame
      // snapped the camera hard onto a bound and pinned it there. It looked like
      // the sweep simply not working; it was the sweep working perfectly against
      // a wall 124 degrees from where the visitor was standing.
      const a = Math.PI - (c.azDeg + arc[0]) * DEG;
      const b = Math.PI - (c.azDeg + arc[1]) * DEG;
      _driftSph.theta = THREE.MathUtils.clamp(_driftSph.theta, Math.min(a, b), Math.max(a, b));
    }
    _driftSph.makeSafe();
    _driftVec.setFromSpherical(_driftSph);

    // The drift only REPORTS its share of the truck. applyTruck below owns the
    // write, because the wheel contributes to the same axis and two writers on
    // one number is how the second one silently wins.
    // RELATIVE TO WHERE THE PHASE STARTED, which is what the offset costs. The
    // truck begins a quarter cycle in, where sine is at 1, so a bare
    // DRIFT_TRUCK_M * sin(phase) would slam the camera 22 cm sideways the
    // instant the drift armed - and the ease-in could not soften it, because
    // the gain scales the phase RATE and not the amplitude. Subtracting the
    // value at phase zero starts the contribution at nothing while keeping the
    // quarter-cycle relationship with the sweep.
    truckDrift = DRIFT_TRUCK_M * (Math.sin(driftTruckPhase) - DRIFT_TRUCK_SIN0);

    camera.position.copy(controls.target).add(_driftVec);
  }

  /**
   * Slide the camera sideways: the drift's share plus the visitor's, written
   * once, every frame, whether or not anything is drifting.
   *
   * SCROLL TRUCKS INSTEAD OF ZOOMING, and that is a real trade Myra made with
   * her eyes open. OrbitControls' wheel handler is off, so there is now no way
   * at all to change how big the chime is on screen - under an orthographic
   * projection zoom was the ONLY way, since moving an ortho eye along its view
   * direction changes not one pixel. What is bought is that every camera
   * control on the page is now a camera move: drag orbits, wheel trucks, and
   * nothing crops. A zoom always looks like a crop, because it is one.
   *
   * X and Z only. controls.target.y belongs to keepTopInShot, which eases it
   * upward as the frame tightens on a procedural place, and writing it here
   * would be two owners fighting over one number every frame.
   */
  function applyTruck(dt) {
    // Eased, because a wheel notch is a step function and a camera that jumps
    // 12 cm per click is a camera nobody is holding. About a sixth of a second
    // to arrive, which is under the threshold of feeling laggy.
    const k = dt > 0 ? Math.min(1, dt * 6) : 1;
    truckManual += (truckManualWant - truckManual) * k;

    const lat = truckManual + truckDrift;
    _driftVec.subVectors(camera.position, controls.target);
    // The camera's own right, flattened: a truck is a move across the ground,
    // not a tilt. Perpendicular to the view in the horizontal plane, which for
    // an offset of (x, _, z) is (z, 0, -x).
    _driftRight.set(_driftVec.z, 0, -_driftVec.x);
    if (_driftRight.lengthSq() < 1e-12) return;
    _driftRight.normalize().multiplyScalar(lat);

    controls.target.x = S.camTarget[0] + _driftRight.x;
    controls.target.z = S.camTarget[2] + _driftRight.z;
    // Position from the target LAST, so the eye carries the truck rather than
    // being left behind aiming at a point that has slid away. That is the
    // difference between trucking the camera and panning its head.
    camera.position.copy(controls.target).add(_driftVec);
  }

  // OrbitControls' own wheel handling is off; this replaces it. Not passive,
  // because it has to preventDefault: with nothing consuming the wheel, a
  // scroll over the fixed canvas falls through to the document and drags the
  // visitor down into the article they were not reading.
  controls.enableZoom = false;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dir = e.deltaY > 0 ? 1 : -1;
    truckManualWant = THREE.MathUtils.clamp(
      truckManualWant + dir * TRUCK_STEP_M, -TRUCK_MAX_M, TRUCK_MAX_M
    );
  }, { passive: false });
  // === /WCS:DRIFT ===

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
    // Held for render(), which needs the ring's position to place a capture
    // place's iron eye and is not handed the state itself. main.js calls syncRig
    // every frame before render, so this is never more than one frame old.
    lastRigState = state;

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
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, dprCapFor(tier)));
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
  const BASE_DIST = S.baseDist || 3.45;
  let viewHeight = S.viewHeight || 3.5;
  let lastPortrait = null;
  // The target height the framing WANTS at a wide view. render() lifts the live
  // target above this as the view tightens; see keepTopInShot.
  let baseTargetY = S.camTarget[1];

  // === WCS:PLACE-CAMERA (2 of 2) ===
  // P4. The three rewriters from part 1, taught about a fixed place.
  //
  // A fixed place changes where the camera stands AND how much it can see: a
  // photograph has one frame that works and the object has to fit in it. The
  // reason that used to be forbidden was H14 -- audio's distance gain read the
  // live frustum height, so a place with a different frame was a place with a
  // different volume. cameraDistance() no longer reads it; see the note there.

  function aspectNow() {
    const w = Math.max(1, container.clientWidth || canvas.clientWidth || 1);
    const h = Math.max(1, container.clientHeight || canvas.clientHeight || 1);
    return w / h;
  }

  function applyFraming(portrait) {
    if (S.ortho) {
      // Re-frame by changing how much world the frustum covers. The eye does
      // not move, so this cannot walk the camera into the porch.
      const cam = place.camera || {};
      viewHeight = portrait
        ? (cam.viewHeightPortrait || S.viewHeightPortrait)
        : (cam.viewHeight || S.viewHeight);
      if (cameraFixed) {
        // No re-aim: the place authored where this camera stands and a portrait
        // window is not a reason to move it. Only the frustum grows, which is
        // the same thing the plate's crop is solved from, so the picture stays
        // world-locked and the chime keeps its size against the trees.
        applyOrthoFrustum();
        return;
      }
      baseTargetY = portrait ? S.camTarget[1] + 0.10 : S.camTarget[1];
      controls.target.set(S.camTarget[0], baseTargetY, S.camTarget[2]);
      applyOrthoFrustum();
      controls.update();
      return;
    }
    if (cameraFixed) return;
    _vA.subVectors(camera.position, controls.target);
    const len = _vA.length() || BASE_DIST;
    const want = portrait ? S.baseDistPortrait : BASE_DIST;
    baseTargetY = portrait ? S.camTargetPortraitY : S.camTarget[1];
    controls.target.set(0, baseTargetY, 0);
    camera.position.copy(controls.target).addScaledVector(_vA, want / len);
    controls.update();
  }

  function applyOrthoFrustum() {
    const hh = viewHeight / 2;
    const hw = hh * aspectNow();
    camera.left = -hw;
    camera.right = hw;
    camera.top = hh;
    camera.bottom = -hh;
    camera.updateProjectionMatrix();
    // The plate's crop is solved from the frustum and the viewport, so the two
    // are recomputed together or they disagree for a frame on every resize.
    if (plate) plate.resize();
  }
  // === /WCS:PLACE-CAMERA (2 of 2) ===

  function resize() {
    const w = Math.max(1, container.clientWidth || canvas.clientWidth || 0);
    const h = Math.max(1, container.clientHeight || canvas.clientHeight || 0);
    if (w < 2 || h < 2) return;
    const portrait = h > w * 1.05;
    if (portrait !== lastPortrait) {
      lastPortrait = portrait;
      applyFraming(portrait);
    }
    if (S.ortho) {
      applyOrthoFrustum();
    } else {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, dprCapFor(tier)));
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
      cloudDrift: cloudDrift ? [Math.round(cloudDrift.x * 1e6) / 1e6, Math.round(cloudDrift.y * 1e6) / 1e6] : null,
      fogDensity: Math.round(scene.fog.density * 1e5) / 1e5,
      cordLean: Math.round((windSpeedMs / (windSpeedMs + 18.0)) * 1000) / 1000,
      bushSway: [Math.round(bushUniforms.uSway.value.x * 1e4) / 1e4, Math.round(bushUniforms.uSway.value.y * 1e4) / 1e4],
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
  const cloudDrift = sky ? sky.material.uniforms.cloudDrift.value : null;
  const CLOUD_HEIGHT = 900;          // stratocumulus base, m
  const CLOUD_GRADIENT = 1.8;        // wind aloft against wind at the porch

  // Dust haze. Dry meadow in a stiff wind genuinely lifts material, and the
  // horizon goes milky before anything else tells you it is blowing hard. Kept
  // deliberately small: this is a second-order cue, and at full strength it
  // reads as fog rolling in rather than as wind.
  const FOG_CALM = S.fogCalm;
  const FOG_BLOWN = S.fogBlown;
  const FOG_FULL_MS = 15.0;        // ~34 mph, where the haze tops out

  // Zooming in must not lose the top of the chime.
  //
  // The orbit target is a fixed height, so tightening the view shrinks the frame
  // around that point -- and at full zoom that left the middle of the tubes and
  // the sail in shot while the top plate and its cords went off the top. The
  // plate is the more interesting end: it is where the whole rig hangs from.
  //
  // So the target rises as the frame shrinks, just enough to hold KEEP_TOP_Y at
  // the upper edge, and never falls below the height the framing chose. It only
  // starts to bite once the frame is shorter than about 1.5 m, which is roughly
  // half way in; wider than that the plate is comfortably inside already.
  //
  // KEEP_TOP_Y lands between the two extremes on purpose. Holding the plate well
  // clear of the edge pushed the target to 1.80 at the stop, which threw away
  // more of the tubes than it was worth; leaving it alone kept the target at
  // 1.45 and lost the plate entirely. This sits in the middle, with a sliver of
  // cord still showing above the plate at full zoom.
  //
  // Moving the target PANS rather than tilts: OrbitControls preserves the
  // camera's offset from the target across an update, so the camera comes with
  // it. That holds for the perspective style too.
  const KEEP_TOP_Y = 2.18;   // top plate sits at 2.05, so this leaves cord showing

  function frameHalfHeight() {
    if (S.ortho) return viewHeight / Math.max(camera.zoom, 1e-3) * 0.5;
    return camera.position.distanceTo(controls.target) * Math.tan(camera.fov * DEG * 0.5);
  }

  function keepTopInShot(dt) {
    // === WCS:PLACE-CAMERA (2 of 2, cont.) ===
    // A fixed place authored its own frame and this function's whole job is to
    // drift away from an authored frame. It also has to hold autoRotate down
    // here rather than only in applyPlaceCamera: main.js arms it after twelve
    // seconds of idle, from outside this module, and OrbitControls.update()
    // spins on autoRotate WITHOUT checking `enabled` -- so switching the
    // controls off is not enough on its own (H13).
    // A splat place holds autoRotate down for a different reason than a fixed
    // one, and it needs saying because the two used to be the same clause.
    //
    // A fixed place suppresses it because it authored its own frame. A splat
    // place suppresses it because the drift is not free: every camera move
    // makes spark re-sort the gaussians by depth, and splats at near-identical
    // depth swap places between frames, so their blend order flips and the
    // whole capture boils. Measured with no input at all - the camera moved on
    // 5 of 5 samples, 28.638,18.95,-21.762 to 28.688,18.95,-21.697 - and that
    // slow unasked-for orbit is what the shimmer was.
    //
    // A photograph could afford a drifting camera. A million sorted quads
    // cannot, and it was never worth much: it is a screensaver flourish that
    // costs a full re-sort per frame.
    if (cameraFixed || splatPlace()) {
      // autoRotate stays down, and now it stays down everywhere: the drift is
      // driven by driftCamera, which sweeps inside the place's own arc instead
      // of spinning past the edge of the capture. This line is the belt to that
      // brace - main.js used to set the flag directly and something else may
      // yet, and OrbitControls.update() spins on it WITHOUT checking `enabled`.
      if (controls.autoRotate) controls.autoRotate = false;
      syncVizForPlace();
      // Return for a splat place too. Falling through meant keepTopInShot
      // eased controls.target back to its own computed value every frame,
      // which undid the shift a pick had just made - the camera walked back to
      // the chime while the capture stayed where the pick put it, and the
      // forest was gone. That is what "the entire forest disappears" is.
      return;
    }
    syncVizForPlace();
    // === /WCS:PLACE-CAMERA (2 of 2, cont.) ===
    const want = Math.max(baseTargetY, KEEP_TOP_Y - frameHalfHeight());
    // Eased rather than snapped, so a zoom does not also jolt the view.
    const k = dt > 0 ? Math.min(1, dt * 7) : 1;
    controls.target.y += (want - controls.target.y) * k;
  }

  let swayPhase = 0;
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
    if (cloudDrift) {
      const cloudElev = 1.0 - 0.9 * sky.material.uniforms.cloudElevation.value;
      const cloudRate = windSpeedMs * CLOUD_GRADIENT * sky.material.uniforms.cloudScale.value
        / (CLOUD_HEIGHT * cloudElev);
      cloudDrift.x -= windFlow.x * cloudRate * dt;
      cloudDrift.y -= windFlow.y * cloudRate * dt;
    }

    // Light, and both amplitude and rate scale with the wind so a bush is
    // perfectly still in dead air. The phase is integrated rather than
    // multiplied into a clock, for the same reason the streamers' swirl is: a
    // growing clock times a changing rate jumps.
    swayPhase += windSpeedMs * 0.40 * dt;
    if (swayPhase > Math.PI * 2048) swayPhase -= Math.PI * 2048;
    const swayAmp = Math.min(windSpeedMs * 0.0105, 0.078) * (0.70 + 0.30 * Math.sin(swayPhase));
    bushUniforms.uSway.value.set(windFlow.x * swayAmp, windFlow.y * swayAmp);

    const hazeT = Math.min(1, windSpeedMs / FOG_FULL_MS);
    scene.fog.density = FOG_CALM + (FOG_BLOWN - FOG_CALM) * hazeT * hazeT;

    keepTopInShot(dt);
    // After keepTopInShot, because that one owns controls.target and this reads
    // the offset from it. Before controls.update(), so damping sees the pose
    // this frame rather than chasing it by one.
    driftCamera(dt);
    applyTruck(dt);

    // The place's own moving parts, if it has any. A capture place draws the
    // iron eye, and the eye now belongs to a particle the rig solves - so this
    // hands over where that particle ended up rather than any wind of its own.
    // A plate has no eye and does not implement this.
    if (plate && typeof plate.frame === 'function') {
      plate.frame(dt, lastRigState && lastRigState.ring ? lastRigState.ring.pos : null);
    }

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
    // === WCS:PLACE-CAMERA (2 of 2, listener) ===
    // For an ortho camera the eye sits ON the target and its distance is
    // meaningless; what "how big is the subject on screen" actually means here
    // is the frustum height, and that is what the audio panner wants.
    //
    // It is the STYLE's frustum height and not the live one, which is H14 made
    // true by construction rather than by two places happening to agree. Before
    // this, forest-path framed 3.00 m and porch 2.60, so audio.js's
    // distGain = clamp(1.6/max(0.8,d), 0.35, 1.0) stepped 0.533 -> 0.615 - a
    // measured 1.24 dB - the instant a visitor opened the Place panel and picked
    // the other card, and again every time a phone was rotated. A place is
    // allowed to frame whatever its picture needs; it is not allowed to change
    // how loud the chime is by doing so. The visitor's own zoom still moves the
    // level, because that one IS the subject getting bigger.
    if (S.ortho) return S.viewHeight / Math.max(camera.zoom, 1e-3);
    return camera.position.distanceTo(controls.target);
    // === /WCS:PLACE-CAMERA (2 of 2, listener) ===
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

    if (sky) {
      sky.geometry.dispose();
      sky.material.dispose();
    }
    groundGeo.dispose();
    groundMat.dispose();
    beamGeo.dispose();
    postGeo.dispose();
    roofGeo.dispose();
    roofMat.dispose();
    for (const g of coverGeoms) g.dispose();
    for (const m of coverMats) m.dispose();
    hookGeo.dispose();
    hookMat.dispose();
    cedarMat.dispose();
    sailProxyGeo.dispose();
    clapProxyGeo.dispose();
    proxyMat.dispose();
    roughMap.dispose();
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    // dispose() names fifteen handles by hand and nothing traverses (H15), so
    // the plate has to be threaded in here or its texture outlives the stage on
    // a context loss. It is the sixteenth.
    disposePlate();

    renderer.dispose();
  }

  // === WCS:PLACE-API ===
  // P4. The place goes up here, at the end, because applyPlace reaches forward
  // to setSunElevation, applyOrthoFrustum and `viewHeight` -- all of which are
  // declared between it and this line. The first frame is therefore already the
  // right place, with no post-boot switch and no flash of the wrong world.
  applyPlace(place, 0);
  // === /WCS:PLACE-API ===

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
    // === WCS:PLACE-API (sun range) ===
    // A PLACE may narrow the sun, and forest-path does. CONTRACTS 5.2 says
    // sun.elevDeg is "authored, fixed. The visitor never sets it" - but the
    // shipped page has a live slider on it and P6 puts its value in the URL, so
    // "fixed" was a sentence in a document with nothing enforcing it. One drag
    // from 68 to 27 lengthens the cast shadow by 1/tan, a factor of 4.9, throws
    // it out of the bottom of the frame and washes the object out, and every
    // point of that 48 degree range was one click from being shared. A place
    // that is a photograph gets to say how much of the sky it can survive.
    // P3's slider already reads this live and apply.js clamps a decoded su-NN
    // into it, so the narrowing reaches the control and the URL for free.
    sunRange: () => (place.sun && Array.isArray(place.sun.range)
      ? [Math.max(SUN_LO, place.sun.range[0]), Math.min(SUN_HI, place.sun.range[1])]
      : [SUN_LO, SUN_HI]),
    // === /WCS:PLACE-API (sun range) ===
    sunElevation: () => currentSunElev,
    palette: S,
    style: S.name,
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

    // === WCS:PLACE-API (members) ===
    // P4's three additions, and nothing else on this object changes shape.
    setPlace(id) {
      applyPlace(id, 0);
      return place.id;
    },
    setFraming(u, v, scale) {
      // Rule A. This moves the PLATE. On a procedural place there is no plate
      // to move and the world has a real size, so it is a no-op by construction
      // rather than by a special case -- which is also why porch's hang ranges
      // are degenerate.
      //
      // The ask is remembered EVEN WHEN THERE IS NO PLATE TO APPLY IT TO, which
      // is what makes a hang set on the porch survive a switch to the forest.
      const w = wantFraming || { u: place.hang.default.u, v: place.hang.default.v, scale: place.hang.default.scale };
      if (Number.isFinite(u)) w.u = u;
      if (Number.isFinite(v)) w.v = v;
      if (Number.isFinite(scale)) w.scale = scale;
      wantFraming = w;
      if (plate) plate.setFraming(u, v, scale);
    },
    /**
     * How much of the capture to draw, 0..1. Remembered the same way the
     * framing is, and for the same reason: the ask has to survive a place that
     * cannot honour it. A plate place has no gaussians and simply does not
     * implement setDetail, so switching to the forest afterwards has to find
     * the number waiting rather than back at one.
     */
    setSplatDetail(fraction) {
      if (Number.isFinite(fraction)) wantDetail = Math.min(1, Math.max(0, fraction));
      if (plate && typeof plate.setDetail === 'function') plate.setDetail(wantDetail);
    },
    /**
     * Turn the camera's idle drift on or off. main.js owns WHEN - it is the
     * piece that knows how long since the visitor last touched anything, and
     * whether they asked for reduced motion - and this owns what drifting is.
     */
    setDrift(on) {
      // Note what is NOT here: turning it off does not disarm. driftCamera has
      // to keep running until its gain has bled to nothing, or "stop" is a
      // freeze-frame instead of a deceleration. Disarming is driftCamera's own
      // business, once it has actually come to rest.
      driftOn = !!on;
    },
    /** Metres of rope between the chime's eye and what it hangs from. */
    setCord(metres) {
      if (Number.isFinite(metres)) wantCord = Math.max(0, metres);
      if (plate && typeof plate.setCord === 'function') plate.setCord(wantCord);
    },
    get plate() { return plate; },
    place: () => place,
    /**
     * Register the sink for place failures and drain anything that already
     * happened. The image load can fail before ui/places.js has mounted, and an
     * error nobody was listening for is exactly the one criterion 7 asks for.
     */
    onPlaceError(fn) {
      placeErrorSink = typeof fn === 'function' ? fn : null;
      if (!placeErrorSink) return;
      while (placeErrors.length) placeErrorSink(placeErrors.shift());
    },
    // === /WCS:PLACE-API (members) ===
  };

  return stage;
}
