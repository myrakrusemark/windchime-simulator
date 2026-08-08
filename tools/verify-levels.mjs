#!/usr/bin/env node
/**
 * Gate the mode LEVEL law across every tube the simulator can be asked to build.
 *
 * tools/verify-decay.mjs gates how long each mode rings. Nothing gated how LOUD
 * each one starts, and that is where the model was worst: modes 3 to 5 were born
 * 15 to 21 dB over the three reference instruments, and every check in the tree
 * stayed green through it. This file is the standing check on the other half of
 * the modal budget.
 *
 * WHAT IT MEASURES, and why each one is pitch-independent
 *
 *   The quantity gated here is the EXCITATION WEIGHT, w_n = amps[n] / |Y_n(s)|.
 *   Dividing the mode shape back out is the whole trick: |Y_n(s)| is where the
 *   clapper happened to land, it swings several dB per mode as the strike moves,
 *   and it is a property of the strike rather than of the instrument. What is
 *   left is `bright` times RAD - the model's claim about how a chime's partials
 *   balance - and that claim must hold at every pitch, not just at the three
 *   pitches somebody had a recording of.
 *
 *   MONOTONE   w_n falls with mode number, everywhere. A chime whose fourth
 *              partial speaks louder than its third is a bell, and the mode
 *              shape can no longer hide it once it is divided out.
 *   MODE 3 GAP w_3 sits at least 15 dB under w_2. This is the piece this file
 *              was written for. The references put mode 3 at -33.9 / -37.7 /
 *              -38.7 dB under mode 1 in a 60 ms window while mode 2 sits at
 *              -11.5 / -16.0 / -18.3, so the real gap is 17 to 22 dB; 15 is the
 *              loose side of that and it is a floor, not a target.
 *   TAPER      RAD itself: starts at 1, never rises, and RAD[1] is pinned at
 *              0.85. Mode 2 is the one partial this model already gets right -
 *              inside 0.7 dB on two of three instruments - so it is nailed down
 *              rather than left free for the next person tuning mode 3.
 *   ENERGY     sum of amps^2 equals A0^2 whatever the taper is. strikeVoice
 *              normalises the voice to constant energy so that moving the strike
 *              changes the colour and not the level; a taper edit that broke
 *              that would quietly change how loud the whole instrument is.
 *
 * WHAT IS DELIBERATELY NOT HERE. No reference pitch and no reference level. A
 * gate that asserted "mode 3 is -36 dB at 592 Hz" would pass the tuning that
 * produced it and reject every physical model anyone tried afterwards, which is
 * a mistake this repo has already made once. The reference numbers live in the
 * commit message and in modal.js's own comment, where they are evidence; here
 * only the shape of the law is gated.
 *
 * Exit status is 0 on pass, 1 on fail. --json prints the report.
 *
 * Usage:
 *   node tools/verify-levels.mjs [--json]
 */

import { fileURLToPath } from 'node:url';
import { join, normalize } from 'node:path';

const HERE = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const modal = await import(join(HERE, 'assets', 'js', 'modal.js'));
const { MAX_PARTIALS, RAD, chimeStock, modeShape, strikeVoice } = modal;

// The pitch range verify-decay.mjs sweeps, for the same reason: it covers the
// shipping scales top to bottom with room either side.
const F_LO = 90;
const F_HI = 2100;
const STEPS = 48;

// Three strike heights, none of them on a node of any of the five modes. The
// law under test must not depend on where the clapper lands, so it is asked at
// three different places and the worst answer is the one that counts.
const STRIKES = [0.28, 0.45, 0.62];

// Floors. Both are loose sides of measured quantities, stated above.
const MODE3_GAP_DB = 15.0;
const MODE2_RAD = 0.85;

const db = (x) => 20 * Math.log10(x);

function weights(f1, s, tube) {
  const v = strikeVoice({ f1, s, vn: 0.4, tube });
  const w = new Array(MAX_PARTIALS);
  for (let n = 0; n < MAX_PARTIALS; n++) {
    const y = Math.abs(modeShape(n, s));
    w[n] = y > 1e-9 ? v.amps[n] / y : NaN;
  }
  return { v, w };
}

function sweep(label, stockOf) {
  const rows = [];
  for (let i = 0; i <= STEPS; i++) {
    const f1 = F_LO * Math.pow(F_HI / F_LO, i / STEPS);
    const tube = stockOf(f1);
    for (const s of STRIKES) {
      const { v, w } = weights(f1, s, tube);
      let monotone = true;
      for (let n = 1; n < MAX_PARTIALS; n++) if (!(w[n] < w[n - 1])) monotone = false;
      let energy = 0;
      for (let n = 0; n < MAX_PARTIALS; n++) energy += v.amps[n] * v.amps[n];
      rows.push({
        label, f1, s,
        finite: w.every((x) => Number.isFinite(x) && x > 0),
        monotone,
        gap32: db(w[2] / w[1]),
        gap21: db(w[1] / w[0]),
        gap31: db(w[2] / w[0]),
        energyErr: Math.abs(Math.sqrt(energy) - v.A0) / v.A0
      });
    }
  }
  return rows;
}

function summarise(rows) {
  return {
    tubes: rows.length,
    allFinite: rows.every((r) => r.finite),
    allMonotone: rows.every((r) => r.monotone),
    worstGap32: Math.max(...rows.map((r) => r.gap32)),
    bestGap32: Math.min(...rows.map((r) => r.gap32)),
    worstGap32AtHz: rows.reduce((a, b) => (b.gap32 > a.gap32 ? b : a)).f1,
    gap21Range: [Math.min(...rows.map((r) => r.gap21)), Math.max(...rows.map((r) => r.gap21))],
    gap31Range: [Math.min(...rows.map((r) => r.gap31)), Math.max(...rows.map((r) => r.gap31))],
    worstEnergyErr: Math.max(...rows.map((r) => r.energyErr))
  };
}

const defaultRows = sweep('default stock', () => undefined);
const makerRows = sweep('chimeStock()', (f1) => chimeStock(f1));
const dflt = summarise(defaultRows);
const maker = summarise(makerRows);

let taperMonotone = RAD[0] === 1;
for (let n = 1; n < RAD.length; n++) if (!(RAD[n] <= RAD[n - 1])) taperMonotone = false;

const checks = {
  'every excitation weight finite and positive': dflt.allFinite && maker.allFinite,
  'excitation weight falls with mode number at every pitch and strike':
    dflt.allMonotone && maker.allMonotone,
  [`mode 3 sits at least ${MODE3_GAP_DB} dB under mode 2 at every pitch`]:
    dflt.worstGap32 <= -MODE3_GAP_DB && maker.worstGap32 <= -MODE3_GAP_DB,
  'RAD starts at 1 and never rises': taperMonotone,
  'RAD[1] pinned at the measured-matched mode 2': RAD[1] === MODE2_RAD,
  'voice energy preserved by the taper': dflt.worstEnergyErr < 1e-9 && maker.worstEnergyErr < 1e-9
};

const report = {
  range_hz: [F_LO, F_HI],
  steps: STEPS,
  strikes: STRIKES,
  mode3_gap_floor_db: MODE3_GAP_DB,
  rad: Array.from(RAD),
  default_stock: dflt,
  maker_stock: maker,
  checks,
  pass: Object.values(checks).every(Boolean)
};

const w = (v, n) => String(v).padStart(n);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`level sweep: ${F_LO}-${F_HI} Hz, ${STEPS + 1} tubes x ${STRIKES.length} strike heights per stock`);
  console.log(`  taper RAD ${report.rad.join(' / ')}`);
  for (const [name, s] of [['default stock', dflt], ['chimeStock() ', maker]]) {
    console.log(`  ${name}  finite ${s.allFinite ? 'yes' : 'NO'}   monotone ${s.allMonotone ? 'yes' : 'NO'}` +
                `   mode3-mode2 ${w(s.worstGap32.toFixed(1), 7)} to ${w(s.bestGap32.toFixed(1), 7)} dB` +
                ` (worst at ${s.worstGap32AtHz.toFixed(0)} Hz)`);
    console.log(`                 mode2-mode1 ${w(s.gap21Range[0].toFixed(1), 7)} to ${w(s.gap21Range[1].toFixed(1), 7)} dB` +
                `   mode3-mode1 ${w(s.gap31Range[0].toFixed(1), 7)} to ${w(s.gap31Range[1].toFixed(1), 7)} dB`);
  }
  console.log('');
  for (const [k, v] of Object.entries(checks)) if (!v) console.log(`  FAILED: ${k}`);
  console.log(report.pass ? 'PASS' : 'FAIL');
}

process.exit(report.pass ? 0 : 1);
