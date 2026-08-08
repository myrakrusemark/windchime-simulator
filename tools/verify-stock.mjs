#!/usr/bin/env node
/**
 * Does the mode-ratio law predict a real instrument from its spec sheet?
 *
 * modal.js contains one choice a reader is entitled to be suspicious of: the
 * simulator hangs one tube section, and a global section can only match a set
 * of recordings inside a narrow window of diameter. This tool is the answer to
 * that suspicion, and it is meant to be run rather than believed.
 *
 * For each reference recording it takes the section the MAKER publishes for the
 * instrument that made it - not the simulator's stock, not anything swept - and
 * prints where the model puts that tube's bending modes against where the lines
 * actually are in the recording. Nothing here is fitted: the only inputs are a
 * diameter, a wall, a Young's modulus, a density, a Poisson's ratio, and the
 * measured fundamental of the clip.
 *
 * It also prints n = 2 ovalling floors, because that is the one number that
 * decides whether the model is entitled to speak at all. A bending mode above
 * the floor is not a bending mode; the section is deforming, and free-free beam
 * theory of any order is the wrong model for it. The Theta Supergiant is below
 * its own second mode, which is why the analysis harness and this model
 * disagree about which line is its mode 2, and the disagreement is visible here
 * rather than argued about.
 *
 * The measured frequencies below are transcribed from analyze.py's partial list
 * for each clip; re-derive them with
 *   python3 tools/audio-analysis/analyze.py <clip> --json
 * if you do not want to take them on trust. They are OUTPUT of the frozen
 * analysis harness, never an input to modal.js.
 *
 *   node tools/verify-stock.mjs
 *
 * Exits non-zero if any mode the model claims (below the ovalling floor) misses
 * its measured line by more than 30 cents.
 */

import { fileURLToPath } from 'node:url';
import { join, normalize } from 'node:path';

const HERE = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const modal = await import(join(HERE, 'assets', 'js', 'modal.js'));

const TOL_CENTS = 30;
const cents = (a, b) => 1200 * Math.log2(a / b);

// f0 and the measured partial frequencies are analyze.py's, on the clips in
// ~/.cache/windchime-gauntlet/refs/clean. `mode` names which bending mode each
// measured line is claimed to be; where the harness's Euler-Bernoulli matcher
// picks a different line, that is recorded in `matcherPicks` and printed, so
// the disagreement is on the page instead of in a commit message.
const CLIPS = [
  {
    clip: 'thetachimes-supergiant-592hz.wav',
    stock: 'Theta Supergiant',
    published: '3 in tube, 3 mm wall, longest 49 in at D4, shortest 34.5 in at D5',
    f0: 592.3601415683443,
    lines: [
      { mode: 2, hz: 1507.013, rel_db: -23.46 },
      { mode: 3, hz: 2690.002, rel_db: -38.31 }
    ],
    matcherPicks: [
      { mode: 2, hz: 1571.413, rel_db: -37.83 },
      { mode: 3, hz: 2894.124, rel_db: -37.87 }
    ]
  },
  {
    clip: 'windriver-corinthian-bells-65in-466hz.wav',
    stock: 'Corinthian Bells 65',
    published: '2.25 in tube, longest 40.25 in, Eb pentatonic (wall solved from those)',
    f0: 463.6516,
    lines: [
      { mode: 2, hz: 1221.457, rel_db: -13.5 },
      { mode: 3, hz: 2248.468, rel_db: -51.9 },
      { mode: 4, hz: 3483.601, rel_db: null }
    ],
    matcherPicks: []
  },
  {
    clip: 'thetachimes-flower-of-life-741hz.wav',
    stock: 'Theta Flower of Life',
    published: '1.75 in tube, 2.6 mm average wall, 64 in hanging height, six tubes',
    f0: 739.4632,
    lines: [
      { mode: 2, hz: 1914.204, rel_db: -32.2 },
      { mode: 3, hz: 3471.310, rel_db: null }
    ],
    matcherPicks: []
  }
];

let worst = 0;
let worstAll = 0;
let failures = 0;

for (const c of CLIPS) {
  const stock = modal.stockFor(c.stock);
  const modes = modal.tubeModes({ f1: c.f0, tube: stock });
  const wallMm = (stock.od - stock.id) * 500;
  console.log(`\n${c.clip}`);
  console.log(`  stock   ${c.stock}: ${(stock.od * 1000).toFixed(2)} mm OD, ` +
              `${wallMm.toFixed(2)} mm wall, r = ${(modes.r * 1000).toFixed(2)} mm`);
  console.log(`  published: ${c.published}`);
  console.log(`  cut length for ${c.f0.toFixed(2)} Hz: ${modes.L.toFixed(4)} m ` +
              `(${(modes.L / 0.0254).toFixed(1)} in), L/r = ${modes.slenderness.toFixed(0)}`);
  console.log(`  n=2 ovalling floor ${modes.shellHz.toFixed(0)} Hz -> ` +
              `${modes.beamModes} of 5 modes are bending modes`);

  for (const line of c.lines) {
    const predicted = c.f0 * modes.ratios[line.mode - 1];
    const d = cents(predicted, line.hz);
    const claimed = line.mode <= modes.beamModes;
    const bad = claimed && Math.abs(d) > TOL_CENTS;
    if (claimed) worst = Math.max(worst, Math.abs(d));
    worstAll = Math.max(worstAll, Math.abs(d));
    if (bad) failures++;
    console.log(`    mode ${line.mode}: model ${predicted.toFixed(2)} Hz  vs measured ` +
                `${line.hz.toFixed(2)} Hz  ${d >= 0 ? '+' : ''}${d.toFixed(1)} cents` +
                `${claimed ? (bad ? '   FAIL' : '   ok') : '   (above the floor: not claimed)'}`);
  }
  for (const p of c.matcherPicks) {
    const predicted = c.f0 * modes.ratios[p.mode - 1];
    console.log(`    [analyze.py's nearest-to-Euler-Bernoulli match for mode ${p.mode} is ` +
                `${p.hz.toFixed(2)} Hz at ${p.rel_db} dB, ` +
                `${cents(predicted, p.hz).toFixed(1)} cents from the model]`);
  }
}

// Out of set: a fourth chime, recorded by the project owner, that had no part in
// choosing anything in modal.js and that no maker publishes a diameter for.
// chimeStock() sizes a maker's tube from the chime's LOWEST note alone; the
// mode-2 ratios below then follow from that one number, and the tubes span an
// octave. Both frequencies in each pair are analyze.py's, off the clips in
// refs/myra.
console.log('\nout of set - a chime nobody involved in this model has published');
const OWN = [
  { f1: 1024.586, f2: 2719.143 },
  { f1: 1026.338, f2: 2717.782 },
  { f1: 1323.466, f2: 3474.683 },
  { f1: 1524.578, f2: 3951.859 },
  { f1: 2080.765, f2: 5363.788 }
].map(t => ({ ...t, ratio2: t.f2 / t.f1 }));
const ownStock = modal.chimeStock(OWN[0].f1);
console.log(`  chimeStock(${OWN[0].f1} Hz) -> ${(ownStock.od * 1000).toFixed(2)} mm OD, ` +
            `${((ownStock.od - ownStock.id) * 500).toFixed(2)} mm wall`);
let ownWorst = 0;
for (const t of OWN) {
  const r2 = modal.modeRatios(t.f1, ownStock)[1];
  const d = cents(r2, t.ratio2);
  ownWorst = Math.max(ownWorst, Math.abs(d));
  console.log(`  ${t.f1.toFixed(0).padStart(5)} Hz: model ${r2.toFixed(4)}  measured ` +
              `${t.ratio2.toFixed(4)}  ${d >= 0 ? '+' : ''}${d.toFixed(1)} cents`);
}
// Two controls, so "18 cents" has something to be better than.
let wShipped = 0, wConst = 0;
for (const t of OWN) {
  wShipped = Math.max(wShipped, Math.abs(cents(modal.modeRatios(t.f1)[1], t.ratio2)));
  wConst = Math.max(wConst, Math.abs(cents(modal.IDEAL_RATIOS[1], t.ratio2)));
}
console.log(`  worst out-of-set mode-2 error ${ownWorst.toFixed(1)} cents`);
console.log(`  the same tubes on the simulator's own 44.45 mm stock: ${wShipped.toFixed(1)} cents`);
console.log(`  the same tubes on a constant Euler-Bernoulli 2.7565:  ${wConst.toFixed(1)} cents`);

console.log(`\nworst claimed-mode error in set: ${worst.toFixed(1)} cents ` +
            `(tolerance ${TOL_CENTS})`);
// The two modes the model declines to claim are the Supergiant's, and they are
// printed above rather than dropped: they land closer than several of the ones
// it does claim. The floor is not being used to hide a miss.
console.log(`worst error counting the two modes above their own ovalling floor ` +
            `as well: ${worstAll.toFixed(1)} cents`);
if (failures) {
  console.log(`${failures} claimed mode(s) outside tolerance`);
  process.exit(1);
}
console.log('every bending mode the model claims lands inside tolerance');
