#!/usr/bin/env node
/**
 * Sweep the loss budget across every tube the simulator can be asked to build,
 * and say out loud where it stops behaving like a chime.
 *
 * modal.js's T60s are checked against three reference recordings between 464 and
 * 739 Hz. The shipping scale dropdown reaches down to 130.81 Hz and up past
 * 1 kHz, and chimeStock() will size a tube at any pitch at all - so most of what
 * the model is asked for has never been measured against anything. This tool is
 * the standing check on that extrapolation, and validate.py runs it as a gate.
 *
 * It is a REGRESSION GATE, not a certificate. Two of the things it measures are
 * currently wrong, they are recorded in BASELINE below with the reason, and the
 * gate is that they must not get worse. Saying "this is broken and here is the
 * number" in a file that runs on every validate.py is worth more than a check
 * that quietly passes because its threshold was chosen to let the failure
 * through, which is what a 60-second cap on a 44-second runaway would have been.
 *
 * What it measures:
 *
 *   FINITE     every mode's T60 is a positive, finite number. A NaN here is
 *              silence in the browser and nobody would hear the difference
 *              between that and a bug. This one is a hard assertion.
 *   LONGEST    the longest ring anywhere in the sweep. Gated against the
 *              recorded 28.2 s (default stock) and 44.0 s (maker proportions).
 *              The second of those is a runaway and is NOT FIXED.
 *   ORDERING   the worst overtone-T60 / fundamental-T60 ratio, and the top of
 *              the band where it exceeds 1. This is measured against reality,
 *              not assumed: refs/deep carries three bass instruments (a 199 Hz
 *              tubular bell, a 282 Hz oversize bass chime, a 582 Hz bass chime)
 *              and on all three the partial T60s fall monotonically with
 *              frequency - 466 Hz at 26.9 s down to 2219 Hz at 1.6 s on the
 *              282 Hz instrument, 488 Hz at 41.7 s down to 1617 Hz at 2.4 s on
 *              the bell. A chime whose third partial outlives its hum is a
 *              whistle. NOT FIXED below 185 Hz on the default stock.
 *   WINDOW     the fundamental over the pitch range the page ships, against a
 *              broad physical band. Deliberately NOT a check against the three
 *              reference pitches - see WHAT IS DELIBERATELY NOT HERE below.
 *
 * WHY THE ORDERING INVERTS, since the number is useless without it. On the
 * simulator's single stock a 130.81 Hz tube is 32 diameters long; its
 * fundamental is far below the section's coincidence frequency and has no
 * radiation channel at all, while its 686 Hz third partial is above coincidence
 * and radiates freely. Cord loss then decides mode 1 alone and gives it 4.8 s
 * against mode 3's 18.3. The same law on maker proportions - chimeStock() picks
 * the diameter so the tube comes out 18 diameters long - puts that tube's mode 3
 * at 2.5 s against a 4.8 s fundamental, because a fat bass tube radiates its
 * overtones away. So the inversion is a consequence of cutting a whole scale
 * from one length of tube, which modal.js already flags as the honest cost of
 * hanging one stock. Fixing it needs a loss channel that survives below
 * coincidence; three were built and measured against the references and all
 * three failed there (see WHAT IS NOT IN THE BUDGET at CORD in modal.js).
 *
 * Usage:
 *   node tools/verify-decay.mjs [--json]
 */

import { fileURLToPath } from 'node:url';
import { join, normalize } from 'node:path';

const HERE = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const modal = await import(join(HERE, 'assets', 'js', 'modal.js'));
const { MAX_PARTIALS, TUBE_STOCK, chimeStock, modeT60s, tubeModes } = modal;

// WHERE THE MODEL STANDS TODAY, and this block is the point of the file.
//
// Two of these numbers are wrong and are known to be wrong. They are recorded
// rather than asserted away, and the gate is that they must not get WORSE - a
// regression bar, not a pass. Anyone who improves the loss budget should tighten
// them; anyone who breaks it will be told immediately, which is the thing that
// did not exist before.
//
//   longestModeS      the longest T60 anywhere in the sweep. 44 s belongs to an
//                     8.6 mm, 154 mm treble tube on maker proportions, and it is
//                     not a chime - it is the hysteretic cord term running away,
//                     because it gives T60 proportional to frequency with no
//                     ceiling and a slim tube barely radiates. The longest ring
//                     anyone has actually measured is 41.7 s, on a giant tubular
//                     bell, and even that fit was flagged invalid for outrunning
//                     its six second clip. NOT FIXED.
//   inversionMax      the worst overtone-T60 / fundamental-T60 ratio. Anything
//                     above 1 is a chime whose hum dies before its overtones,
//                     which refs/deep says no real bass instrument does. NOT
//                     FIXED on the default stock below 185 Hz. On maker
//                     proportions it USED to be nearly fixed - 90-93 Hz, seven
//                     percent over - and taking the radiation resistance from
//                     the exact cylinder instead of its compact limit made it
//                     worse, 90-106 Hz and 36 percent over, because the
//                     correction lengthens every mode above ka ~ 0.6 while a
//                     bass fundamental is cord-limited and does not lengthen.
//                     That is a real regression and it is recorded as one. It
//                     sits entirely below 130.81 Hz, the lowest note the page
//                     can be asked for, and it buys a resistance that is right
//                     to a part in 10^7 instead of one that is 17x too big at
//                     the top of the range. See modal.js dipoleEfficiency.
//
// WHAT IS DELIBERATELY NOT HERE. Until this round the block below also carried
// referenceFundamentalS - the model's own mode-1 T60 at 463.65, 592.36 and
// 739.46 Hz, gated to one percent. Those are the analyser-measured pitches of
// the three reference recordings, and the values were whatever the model
// happened to print on the day, so the gate did not test the model against
// anything. It tested the model against its own past self at three frequencies
// chosen by the test set, and it forbade improving it: every one of the four
// loss channels the previous round built and measured tripped it, as did a 1.6
// percent change in the cord constant. A gate that a correct change cannot pass
// is not a gate, it is a lock on the current answer.
// The calibration is checked where it can honestly be checked - against the
// recordings themselves, by the offline harness - and what is left here is a
// broad physical window on the shipping range, which no amount of memorising
// our own outputs can satisfy.
const BASELINE = {
  defaultStock: { longestModeS: 28.10, inversionMax: 8.55, inversionHiHz: 186 },
  makerStock:   { longestModeS: 43.80, inversionMax: 1.37, inversionHiHz: 107 }
};

// A plausibility window on the fundamental, over the pitch range the page can
// actually be asked for. The numbers are the range real chimes are reported to
// ring in - 5 to 30 seconds - opened out at both ends so that this catches a
// model that has fallen over rather than a model that has been improved. It is
// a sanity bar, not a calibration.
const SHIP_LO_HZ = 130.81;
const SHIP_HI_HZ = 1200;
const FUNDAMENTAL_WINDOW_S = [4, 45];

// A ring longer than this is not a long chime, it is arithmetic that has come
// apart - a NaN's less obvious cousin. Deliberately far above anything real so
// that tripping it means something has genuinely broken, not that a number
// drifted; the drift gate is BASELINE above.
const CAP_S = 200;

// The pitch range the shipping page can actually ask for. 130.81 Hz is the
// bottom of cOctaveIntervals in index.html; the top of the tube range is 1200 Hz
// and 2100 leaves headroom above it.
const F_LO = 90;
const F_HI = 2100;
const STEPS = 96;

function sweep(label, stockFor) {
  const rows = [];
  for (let i = 0; i <= STEPS; i++) {
    const f1 = F_LO * Math.pow(F_HI / F_LO, i / STEPS);
    const tube = stockFor(f1);
    const modes = tubeModes({ f1, tube });
    const freqs = new Array(MAX_PARTIALS);
    for (let n = 0; n < MAX_PARTIALS; n++) freqs[n] = f1 * modes.ratios[n];
    const t60 = modeT60s(freqs, modes.L, tube, new Array(MAX_PARTIALS));
    let worstOver = 0;
    for (let n = 1; n < MAX_PARTIALS; n++) {
      const over = t60[n] / t60[0];
      if (over > worstOver) worstOver = over;
    }
    rows.push({
      label, f1, od: tube ? tube.od : TUBE_STOCK.od, L: modes.L,
      slenderness: modes.L / (tube ? tube.od : TUBE_STOCK.od),
      t60, longest: Math.max(...t60), overtoneOverFundamental: worstOver,
      finite: t60.every((v) => Number.isFinite(v) && v > 0)
    });
  }
  return rows;
}

const defaultRows = sweep('default stock', () => undefined);
const makerRows = sweep('chimeStock()', (f1) => chimeStock(f1));

function summarise(rows) {
  const bad = rows.filter((r) => !r.finite);
  const over = rows.filter((r) => r.longest > CAP_S);
  const inv = rows.filter((r) => r.overtoneOverFundamental > 1);
  return {
    n: rows.length,
    allFinite: bad.length === 0,
    longest: Math.max(...rows.map((r) => r.longest)),
    withinCap: over.length === 0,
    inversions: inv.length,
    inversionBandHz: inv.length ? [inv[0].f1, inv[inv.length - 1].f1] : null,
    worstInversionRatio: Math.max(0, ...rows.map((r) => r.overtoneOverFundamental))
  };
}

const report = {
  cap_s: CAP_S,
  range_hz: [F_LO, F_HI],
  steps: STEPS + 1,
  default_stock: summarise(defaultRows),
  maker_stock: summarise(makerRows),
  checks: {}
};

const c = report.checks;
c.default_finite = report.default_stock.allFinite;
c.maker_finite = report.maker_stock.allFinite;
c.default_sane = report.default_stock.withinCap;
c.maker_sane = report.maker_stock.withinCap;
// Regression gates against the recorded state. A tenth of a second and a
// hundredth of a ratio of slack, so floating-point wobble does not trip them.
c.default_no_longer_ring = report.default_stock.longest <= BASELINE.defaultStock.longestModeS + 0.1;
c.maker_no_longer_ring = report.maker_stock.longest <= BASELINE.makerStock.longestModeS + 0.1;
c.default_no_worse_inversion =
  report.default_stock.worstInversionRatio <= BASELINE.defaultStock.inversionMax + 0.01;
c.maker_no_worse_inversion =
  report.maker_stock.worstInversionRatio <= BASELINE.makerStock.inversionMax + 0.01;
c.default_inversion_no_wider =
  !report.default_stock.inversionBandHz ||
  report.default_stock.inversionBandHz[1] <= BASELINE.defaultStock.inversionHiHz;
c.maker_inversion_no_wider =
  !report.maker_stock.inversionBandHz ||
  report.maker_stock.inversionBandHz[1] <= BASELINE.makerStock.inversionHiHz;

// The fundamental, over the range the page ships, against a physical window.
// No reference-clip frequency appears here and no past output of this model
// does either - only "a wind chime rings for seconds, not for a blink and not
// for a minute", which is a statement about chimes.
function shippingFundamentals(rows) {
  const inRange = rows.filter((r) => r.f1 >= SHIP_LO_HZ && r.f1 <= SHIP_HI_HZ);
  const t60s = inRange.map((r) => r.t60[0]);
  return {
    n: inRange.length,
    lo: Math.min(...t60s),
    hi: Math.max(...t60s),
    loAtHz: inRange[t60s.indexOf(Math.min(...t60s))].f1,
    hiAtHz: inRange[t60s.indexOf(Math.max(...t60s))].f1
  };
}
report.shipping_fundamental = {
  window_s: FUNDAMENTAL_WINDOW_S,
  range_hz: [SHIP_LO_HZ, SHIP_HI_HZ],
  default_stock: shippingFundamentals(defaultRows),
  maker_stock: shippingFundamentals(makerRows)
};
for (const [k, s] of [['default', report.shipping_fundamental.default_stock],
                      ['maker', report.shipping_fundamental.maker_stock]]) {
  c[`${k}_fundamental_in_window`] =
    s.lo >= FUNDAMENTAL_WINDOW_S[0] && s.hi <= FUNDAMENTAL_WINDOW_S[1];
}

// The exact cylindrical resistance, checked as a function rather than through a
// render: it must be 1 in the compact limit and must fall, not rise, once the
// section stops being small against the sound wavelength. Both are properties of
// the Hankel expression, so a broken polynomial coefficient shows up here.
report.dipole_efficiency = [0.001, 0.01, 0.1, 0.3, 1, 2, 4].map(
  (x) => ({ x, c: modal.dipoleEfficiency(x) }));
// C -> 1 as x -> 0, and it approaches from ABOVE like 1 + O(x^2): the true value
// at x = 0.01 is 1.00035, not 1, so the tolerance here is a slack band around
// the real function and not a claim that C is flat. validate.py checks it
// against scipy's Hankel to 1e-6 across the whole range; this is the smoke test.
c.dipole_compact_limit = Math.abs(modal.dipoleEfficiency(1e-3) - 1) < 1e-5 &&
                         Math.abs(modal.dipoleEfficiency(0.01) - 1) < 1e-3;
c.dipole_falls_past_one = modal.dipoleEfficiency(1) < 0.6 &&
                          modal.dipoleEfficiency(2) < modal.dipoleEfficiency(1) &&
                          modal.dipoleEfficiency(4) < modal.dipoleEfficiency(2);
c.dipole_positive = report.dipole_efficiency.every((r) => r.c > 0 && r.c <= 1.1);

report.pass = Object.values(c).every(Boolean);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const w = (s, n) => String(s).padStart(n);
  console.log(`decay sweep: ${F_LO}-${F_HI} Hz, ${STEPS + 1} tubes per stock, cap ${CAP_S} s`);
  for (const [name, s] of [['default stock', report.default_stock],
                           ['chimeStock() ', report.maker_stock]]) {
    console.log(`  ${name}  finite ${s.allFinite ? 'yes' : 'NO'}   longest mode ${w(s.longest.toFixed(2), 7)} s` +
                `   within cap ${s.withinCap ? 'yes' : 'NO'}   inversions ${w(s.inversions, 3)}` +
                (s.inversionBandHz
                  ? `  (${s.inversionBandHz[0].toFixed(0)}-${s.inversionBandHz[1].toFixed(0)} Hz,` +
                    ` worst overtone/fundamental ${s.worstInversionRatio.toFixed(2)}x)`
                  : ''));
  }
  console.log('');
  console.log('  f1 Hz    stock   L/od     mode1   mode2   mode3   mode4   mode5');
  for (const rows of [defaultRows, makerRows]) {
    for (const r of rows) {
      if (![90, 130.81, 261.63, 440, 1046, 2093].some((f) => Math.abs(r.f1 - f) / f < 0.03)) continue;
      console.log(`  ${w(r.f1.toFixed(1), 7)} ${w((r.od * 1000).toFixed(1), 8)} ${w(r.slenderness.toFixed(1), 6)}   ` +
                  r.t60.map((v) => w(v.toFixed(2), 7)).join(' ') +
                  (r.overtoneOverFundamental > 1 ? '   <- overtone outlives mode 1' : ''));
    }
    console.log('');
  }
  console.log(`  fundamental over the shipping range ${SHIP_LO_HZ}-${SHIP_HI_HZ} Hz` +
              `, window ${FUNDAMENTAL_WINDOW_S[0]}-${FUNDAMENTAL_WINDOW_S[1]} s:`);
  for (const [name, s] of [['default stock', report.shipping_fundamental.default_stock],
                           ['chimeStock() ', report.shipping_fundamental.maker_stock]]) {
    console.log(`    ${name}  ${w(s.lo.toFixed(2), 7)} s at ${w(s.loAtHz.toFixed(0), 5)} Hz` +
                `   ${w(s.hi.toFixed(2), 7)} s at ${w(s.hiAtHz.toFixed(0), 5)} Hz`);
  }
  console.log('');
  console.log('  exact-cylinder dipole efficiency C(x) = exact / compact limit:');
  console.log('    ' + report.dipole_efficiency
    .map((r) => `x=${r.x} ${r.c.toFixed(4)}`).join('   '));
  console.log('');
  console.log('  published instruments, mode 1 on the maker\'s own section:');
  for (const cat of modal.CATALOGUE) {
    const tube = modal.stockFor(cat.name);
    // Ask each tube for the note it is nearest to being asked for in the page's
    // range; the point is the section, not the pitch.
    const f1 = cat.lowest || 440;
    const modes = tubeModes({ f1, tube });
    const freqs = new Array(MAX_PARTIALS);
    for (let n = 0; n < MAX_PARTIALS; n++) freqs[n] = f1 * modes.ratios[n];
    const t60 = modeT60s(freqs, modes.L, tube, new Array(MAX_PARTIALS));
    console.log(`    ${cat.name.padEnd(24)} od ${w((tube.od * 1000).toFixed(1), 6)} mm` +
                `  f1 ${w(f1.toFixed(1), 7)} Hz  L ${modes.L.toFixed(3)} m` +
                `  L/od ${w((modes.L / tube.od).toFixed(1), 5)}  mode1 ${w(t60[0].toFixed(2), 7)} s`);
  }
  console.log('');
  console.log('  KNOWN LIMITS, recorded and gated against getting worse, NOT fixed:');
  console.log(`    default stock inverts mode order from ${F_LO} Hz to ` +
              `${report.default_stock.inversionBandHz ? report.default_stock.inversionBandHz[1].toFixed(0) : '-'} Hz` +
              ` (worst ${report.default_stock.worstInversionRatio.toFixed(2)}x)`);
  console.log(`    maker stock rings ${report.maker_stock.longest.toFixed(1)} s at the top of the range`);
  console.log('');
  for (const [k, v] of Object.entries(report.checks)) {
    if (!v) console.log(`  FAILED: ${k}`);
  }
  console.log(report.pass ? 'PASS' : 'FAIL');
}

process.exit(report.pass ? 0 : 1);
