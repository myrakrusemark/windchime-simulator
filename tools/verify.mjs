#!/usr/bin/env node
/**
 * Headless verification harness for the 3D wind chime simulator.
 *
 * Serves the repo on a random port, loads index.html in headless Chrome with
 * WebGL (SwiftShader), lets the sim run, then reports:
 *   - every console message and page error
 *   - whether a WebGL context actually came up
 *   - a JSON probe of window.__wcs (the sim's debug handle)
 *   - screenshots at several points in time
 *
 * Usage:
 *   node tools/verify.mjs [--seconds 8] [--out /tmp/shots] [--page index.html]
 *
 * Exit code 0 = page loaded with no page errors and no console errors.
 * Exit code 1 = something failed; read the report.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));

// Where puppeteer-core is found, in order, with a legible failure at the end.
//
// This used to be one hard-coded path into a previous session's scratchpad
// directory under /tmp. It worked for as long as that directory happened to
// survive, and this file gates every piece in the run, so a machine reboot or a
// /tmp sweep would have failed the gate for every agent after that one with a
// MODULE_NOT_FOUND naming a path nobody would recognise.
const PUPPETEER_CANDIDATES = [
  process.env.WCS_PUPPETEER,                                  // explicit override
  join(ROOT, 'node_modules', 'puppeteer-core'),               // beside the repo
  'puppeteer-core',                                            // anywhere node resolves it
  // Last: whatever scratchpad happens to be current, then the historical one.
  process.env.CLAUDE_SCRATCHPAD && join(process.env.CLAUDE_SCRATCHPAD, 'node_modules', 'puppeteer-core'),
  '/tmp/claude-1000/-home-myra-Dropbox-Work/4d8dba3e-bbad-463d-95d3-30793b935525/scratchpad/node_modules/puppeteer-core',
].filter(Boolean);

function loadPuppeteer() {
  const tried = [];
  for (const c of PUPPETEER_CANDIDATES) {
    try { return require(c); } catch (err) { tried.push(`${c}  (${err.code || err.message})`); }
  }
  throw new Error(
    'puppeteer-core could not be resolved. Tried:\n  ' + tried.join('\n  ') +
    '\n\nFix by either:\n' +
    '  npm i --no-save puppeteer-core        (from the repo root; it is dev-only and not shipped)\n' +
    '  WCS_PUPPETEER=/path/to/puppeteer-core node tools/verify.mjs\n' +
    'tools/shot.mjs and tools/count-clicks.mjs need none of this - they speak CDP over\n' +
    "node's built-in WebSocket. This harness is the only thing here that wants npm."
  );
}

const puppeteer = loadPuppeteer();

// Screenshots land next to the repo unless asked otherwise, so a run leaves its
// evidence somewhere the next reader can actually find it.
const SCRATCH = process.env.CLAUDE_SCRATCHPAD || join(ROOT, '.verify-out');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SECONDS = Number(arg('seconds', 8));
const OUT = arg('out', join(SCRATCH, 'shots'));
const PAGE = arg('page', 'index.html');
// Emulates prefers-reduced-motion, which the page honours by never starting the
// idle camera drift. Without it any run longer than 12 seconds has the CAMERA
// moving, which swamps any attempt to measure how much the SCENE moves.
const REDUCED = process.argv.includes('--reduced-motion');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.glsl': 'text/plain', '.map': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || p.endsWith('/')) p += 'index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/${PAGE}`;

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'shell',
  args: [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,900',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
if (REDUCED) {
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
}

const logs = [];
const errors = [];
page.on('console', (m) => {
  const entry = { type: m.type(), text: m.text() };
  logs.push(entry);
  // Resource-load failures are reported separately by 'requestfailed', which
  // already filters the third-party ads/fonts we deliberately block.
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
    errors.push(`console.error: ${m.text()}`);
  }
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${(e.stack || '').split('\n').slice(0, 4).join('\n')}`));
page.on('response', (r) => {
  if (r.status() >= 400 && !/favicon\.ico/.test(r.url())) {
    errors.push(`http ${r.status()}: ${r.url()}`);
  }
});
page.on('requestfailed', (r) => {
  // Third-party ads/analytics/fonts are expected to fail or be blocked offline.
  const u = r.url();
  if (/googletagmanager|googlesyndication|doubleclick|fonts\.(googleapis|gstatic)/.test(u)) return;
  errors.push(`requestfailed: ${u} — ${r.failure()?.errorText}`);
});

// Block third-party noise so failures are about OUR code.
await page.setRequestInterception(true);
page.on('request', (r) => {
  if (/googletagmanager|googlesyndication|doubleclick|google-analytics|fonts\.(googleapis|gstatic)/.test(r.url())) {
    r.abort().catch(() => {});
  } else {
    r.continue().catch(() => {});
  }
});

let loadOk = true;
try {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
} catch (e) {
  loadOk = false;
  errors.push(`navigation: ${e.message}`);
}

// Give the sim time to boot, then sample screenshots over time so motion is visible.
const shots = [];
const frames = 4;
for (let i = 0; i < frames; i++) {
  await new Promise((r) => setTimeout(r, (SECONDS * 1000) / frames));
  const f = join(OUT, `frame-${i}.png`);
  try { await page.screenshot({ path: f }); shots.push(f); } catch (e) { errors.push(`screenshot: ${e.message}`); }
}

const probe = await page.evaluate(() => {
  const out = { webgl: null, canvases: [], dom: {}, debug: null };
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    out.webgl = gl ? (gl.getParameter(gl.VERSION) || 'context ok') : 'NO CONTEXT';
  } catch (e) { out.webgl = `throw: ${e.message}`; }

  out.canvases = [...document.querySelectorAll('canvas')].map((c) => ({
    id: c.id, w: c.width, h: c.height,
    clientW: c.clientWidth, clientH: c.clientHeight,
    hasGL: !!(c.getContext && (() => { try { return c.getContext('webgl2') || c.getContext('webgl'); } catch { return null; } })()),
  }));

  out.dom = {
    startButton: !!document.getElementById('startButton'),
    locationInput: !!document.getElementById('locationInput'),
    sliderMenu: !!document.getElementById('sliderMenu'),
  };

  // The sim is expected to expose a debug handle for verification.
  if (window.__wcs) {
    try {
      out.debug = JSON.parse(JSON.stringify(
        typeof window.__wcs.snapshot === 'function' ? window.__wcs.snapshot() : window.__wcs
      ));
    } catch (e) { out.debug = `unserializable: ${e.message}`; }
  }
  return out;
});

// The page catches subsystem failures so one bad module cannot blank the whole
// thing, and records them in the snapshot rather than throwing. That is right
// for a visitor and wrong for a verifier: a run where createStage failed and the
// page fell back to no-WebGL was reporting ok, because nothing reached the
// console as an error. Read the page's own error list.
if (probe.debug && Array.isArray(probe.debug.errors) && probe.debug.errors.length) {
  errors.push(`snapshot errors: ${probe.debug.errors.join(', ')}`);
}

// Compare first and last frame byte-wise: identical bytes means nothing moved.
let animated = null;
if (shots.length >= 2) {
  const [a, b] = [await readFile(shots[0]), await readFile(shots[shots.length - 1])];
  animated = !a.equals(b);
  if (animated === false) errors.push('static: first and last frames are byte-identical — nothing is animating');
}

await browser.close();
server.close();

const report = {
  ok: loadOk && errors.length === 0,
  url: base,
  errors,
  animated,
  probe,
  screenshots: shots,
  consoleTail: logs.slice(-40),
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
