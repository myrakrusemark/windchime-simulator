// audio.js - modal synthesis of struck aluminium tubes.
//
// A wind chime tube is a free-free bar: clamped nowhere, free at both ends. Its
// transverse modes are NOT a harmonic series, and that single fact is why a chime
// sounds like a chime and not like a plucked string run through a reverb. Every
// voice here is built additively from the true free-free partials, with the
// per-partial amplitudes taken from the exact mode shape evaluated at the height
// the clapper actually landed, and with a brightness that follows the modelled
// contact time. Nothing is pre-rendered, because a pre-rendered buffer cannot
// change timbre with strike height, and strike height is half the character.
//
// No DOM, no three.js. The one import is modal.js, which is pure arithmetic and
// holds every number that decides how a strike sounds - the free-free mode
// tables, the excitation model, the envelopes. Keeping it browser-free is what
// lets tools/render-offline.mjs synthesise the identical voice in Node, so the
// sound can be measured without a browser being involved in making it. Anything
// audible belongs in modal.js; this file is the AudioContext around it.
//
// The AudioContext is built lazily on a user gesture; until then every entry
// point is a silent no-op and the simulation runs on regardless.

import {
  MAX_PARTIALS,
  CLICK_ATTACK,
  CLICK_T60,
  CLICK_Q,
  CLICK_STOP,
  clamp,
  num,
  decayTau,
  strikeVoice
} from './modal.js';

// --- Module state ----------------------------------------------------------

export function createAudio(params) {
  let ctx = null;
  let bus = null;             // voices -> here
  let compressor = null;
  let delayNode = null;
  let noiseBuffer = null;
  let unlockPromise = null;

  // Tier defaults. main.js calls setTier() once the tier is chosen; until then
  // assume the generous case, since nothing can sound before unlock() anyway.
  let partialCount = MAX_PARTIALS;
  let maxVoices = 16;

  // Per-tube cache, refreshed by setTubes on boot and after every rebuild.
  let tubeF1 = [];

  // Live voices, and the newest voice per tube so contact muting has something
  // to grab. A clapper resting against a tube genuinely damps it.
  const voices = [];
  let newestByTube = [];
  let contactPrev = null;
  // When each tube's current contact began, and whether its voice has actually
  // been ducked for it. Both are indexed by tube.
  let contactSince = null;
  let damped = null;
  // How long the hammer must stay on a tube before it counts as leaning rather
  // than striking. A strike's contact lasts a few milliseconds.
  const CONTACT_GRACE = 0.075;

  // Listener frame, in camera space. Updated every frame by main.js.
  const listenerRight = [1, 0, 0];
  const listenerTarget = [0, 1.7, 0];
  let listenerDistance = 3.2;

  // --- Graph construction (lazy, once, on the first gesture) ---------------

  function buildGraph() {
    // voiceGain -> panner -> bus -> compressor -> destination,
    // with a parallel short-delay send for outdoor space. No ConvolverNode:
    // a 90 ms slap with a darkening feedback path gives the same "this is
    // outside, and there is a wall over there" cue for a fraction of the cost,
    // and it never has to load a file.
    bus = ctx.createGain();
    bus.gain.value = 0.8;

    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 12;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.25;

    bus.connect(compressor);
    compressor.connect(ctx.destination);

    delayNode = ctx.createDelay(0.5);
    delayNode.delayTime.value = 0.09;

    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2800;
    damp.Q.value = 0.7;

    const feedback = ctx.createGain();
    feedback.gain.value = 0.22;

    const send = ctx.createGain();
    send.gain.value = 0.2;   // about -14 dB

    bus.connect(delayNode);
    delayNode.connect(damp);
    damp.connect(feedback);
    feedback.connect(delayNode);   // each repeat is darker than the last
    damp.connect(send);
    send.connect(ctx.destination);

    // One shared noise buffer for every contact click. 60 ms is longer than the
    // 25 ms click decay, so a randomised start offset still leaves plenty of
    // audible material and no two ticks are the same sample-for-sample.
    const frames = Math.max(1, Math.floor(ctx.sampleRate * 0.06));
    noiseBuffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    for (let i = 0; i < frames; i++) d[i] = Math.random() * 2 - 1;
  }

  // --- Voice bookkeeping ---------------------------------------------------

  function releaseVoice(v) {
    if (v.released) return;
    v.released = true;
    const i = voices.indexOf(v);
    if (i >= 0) voices.splice(i, 1);
    if (newestByTube[v.tube] === v) newestByTube[v.tube] = null;
    for (let n = 0; n < v.oscs.length; n++) {
      try { v.oscs[n].disconnect(); } catch (e) { /* already gone */ }
    }
    for (let n = 0; n < v.gains.length; n++) {
      try { v.gains[n].disconnect(); } catch (e) { /* already gone */ }
    }
    if (v.noise) { try { v.noise.disconnect(); } catch (e) { /* already gone */ } }
    try { v.gain.disconnect(); } catch (e) { /* already gone */ }
    try { v.pan.disconnect(); } catch (e) { /* already gone */ }
  }

  /**
   * Current amplitude of a voice, estimated analytically. The fundamental's
   * envelope is exactly setTargetAtTime, so exp(-age/timeConstant) is not an
   * approximation - it is the envelope. No AnalyserNode needed.
   */
  function estimateAmplitude(v, now) {
    const tau = decayTau(v.T60);
    return v.A0 * Math.exp(-Math.max(0, now - v.t0) / tau);
  }

  function stealQuietest(now) {
    let worst = null;
    let worstAmp = Infinity;
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      if (v.stealing) continue;
      const a = estimateAmplitude(v, now);
      if (a < worstAmp) { worstAmp = a; worst = v; }
    }
    if (!worst) return;
    worst.stealing = true;
    const g = worst.gain.gain;
    try {
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + 0.04);
    } catch (e) { /* automation race; the stop below still cleans up */ }
    // Stopping the oscillators fires onended, which routes into releaseVoice,
    // so there is exactly one teardown path however a voice dies.
    for (let n = 0; n < worst.oscs.length; n++) {
      try { worst.oscs[n].stop(now + 0.05); } catch (e) { /* already stopped */ }
    }
    if (newestByTube[worst.tube] === worst) newestByTube[worst.tube] = null;
  }

  function applyVoiceGain(v, when, target, seconds) {
    const g = v.gain.gain;
    try {
      g.cancelScheduledValues(when);
      g.setValueAtTime(g.value, when);
      g.linearRampToValueAtTime(target, when + seconds);
    } catch (e) { /* automation race; leave the gain where it is */ }
  }

  // --- Public surface ------------------------------------------------------

  const audio = {

    async unlock() {
      if (ctx) {
        if (ctx.state !== 'running') {
          try { await ctx.resume(); } catch (e) { /* user gesture may be stale */ }
        }
        return ctx.state === 'running';
      }
      if (unlockPromise) return unlockPromise;

      unlockPromise = (async () => {
        const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!Ctor) return false;   // no Web Audio at all; the sim carries on silently
        try {
          ctx = new Ctor({ latencyHint: 'interactive' });
          buildGraph();
        } catch (e) {
          ctx = null;
          return false;
        }
        try { await ctx.resume(); } catch (e) { /* some browsers start running */ }
        return ctx.state === 'running';
      })();

      const ok = await unlockPromise;
      unlockPromise = null;
      return ok;
    },

    ready() {
      return !!ctx && ctx.state === 'running';
    },

    setTubes(tubes) {
      const n = tubes ? tubes.length : 0;
      tubeF1 = new Array(n);
      for (let i = 0; i < n; i++) {
        tubeF1[i] = num(tubes[i] && tubes[i].f1, 261.63);
      }
      // The tube set changed under us; any voice still ringing belongs to a tube
      // that no longer exists at that length. Let them decay, but stop tracking
      // them for contact muting.
      newestByTube = new Array(n).fill(null);
      contactPrev = null;
      contactSince = null;
      damped = null;
    },

    setContactMask(mask) {
      if (!mask) return;
      if (!contactPrev || contactPrev.length !== mask.length) {
        contactPrev = new Uint8Array(mask.length);
        contactSince = new Float64Array(mask.length).fill(-1);
        damped = new Uint8Array(mask.length);
      }
      if (!ctx) {
        contactPrev.set(mask);
        return;
      }
      const now = ctx.currentTime;
      for (let i = 0; i < mask.length; i++) {
        const on = mask[i] ? 1 : 0;
        const was = contactPrev[i];
        contactPrev[i] = on;

        if (on && !was) {
          // Contact has just begun, which is also the instant of the strike.
          // Start the clock; do not touch the voice yet.
          contactSince[i] = now;
          continue;
        }

        const v = newestByTube[i];
        if (!v || v.released || v.stealing) continue;

        // A hammer LEANING on a tube damps it hard; a hammer bouncing off it is
        // what makes the note in the first place. CONTACT_GRACE is the line
        // between the two: a strike separates in a few milliseconds, so only a
        // contact that outlasts the grace period is a lean.
        if (on && !damped[i] && contactSince[i] >= 0 && now - contactSince[i] >= CONTACT_GRACE) {
          damped[i] = 1;
          applyVoiceGain(v, now, v.base * 0.25, 0.12);
        } else if (!on && was) {
          contactSince[i] = -1;
          // Only worth undoing if it was ever done. The release is slower than
          // the grab because that is how a damped bar behaves, and because a
          // fast return sounds like a fader glitch.
          if (damped[i]) {
            damped[i] = 0;
            applyVoiceGain(v, now, v.base, 0.2);
          }
        }
      }
    },

    strike(ev, delaySec) {
      if (!ctx || ctx.state !== 'running' || !ev) return;

      const idx = ev.tube | 0;
      const freq = num(ev.freq, tubeF1[idx] !== undefined ? tubeF1[idx] : 261.63);
      if (!(freq > 20) || freq > 8000) return;

      const J = clamp(num(ev.J, 0.008), 0, 1);

      // Every audible number for this strike, in one pure call. Nothing below
      // may recompute a frequency, an amplitude or a T60 by hand: if it is not
      // in modal.js, the offline renderer cannot reproduce it, and a voice the
      // offline renderer cannot reproduce is a voice nobody can measure.
      const voice = strikeVoice({
        // The pitch, and nothing else about the tube. Mode ratios turn on how
        // slender the tube is, so every tube in the chime still gets its own
        // overtone spectrum - a C3 tube's mode 2 lands 21 cents flat of the
        // ideal ratio and a C6 tube's 143 flat - but the slenderness is
        // worked out from the pitch and the stock, not read off the rig. See
        // the note on the two length laws in modal.js: physics.js sizes the
        // tube on screen from 28 mm stock and mixing the two descriptions
        // describes a tube that does not exist.
        f1: freq,
        s: ev.s,
        vn: ev.vn,
        mu: ev.mu,
        kind: ev.kind,
        partials: partialCount,
        decay: params && params.decay,
        attack: params && params.attack,
        loudness: params && params.loudness
      });

      const { A0, freqs, amps, t60s, attack } = voice;
      const nPart = voice.nPartials;
      if (A0 < 1e-4) return;

      const now = ctx.currentTime;
      const t0 = now + 0.012 + Math.max(0, num(delaySec, 0));

      // Cap the polyphony before allocating, so a gust that rings eight tubes at
      // once cannot outrun the pool. A stolen voice stays in the array for its
      // 40 ms fade, so count only the ones that are not already on their way out.
      let live = 0;
      for (let i = 0; i < voices.length; i++) if (!voices[i].stealing) live++;
      while (live >= maxVoices) {
        const before = live;
        stealQuietest(now);
        live = 0;
        for (let i = 0; i < voices.length; i++) if (!voices[i].stealing) live++;
        if (live >= before) return;   // nothing left to steal; drop this strike
      }

      // A strike that landed on a node of every mode at once has no energy to
      // give anything. Checked here rather than before the steal loop so the
      // sequence of side effects is exactly what it has always been.
      if (voice.norm <= 0) return;

      // Camera-space pan and distance. Because the camera orbits, the chime
      // moves around the listener as you move, which sells the third dimension
      // harder than anything on screen does.
      const p = ev.pos;
      let pan = 0;
      if (p && p.length === 3) {
        const dx = p[0] - listenerTarget[0];
        const dy = p[1] - listenerTarget[1];
        const dz = p[2] - listenerTarget[2];
        const proj = dx * listenerRight[0] + dy * listenerRight[1] + dz * listenerRight[2];
        pan = clamp(proj / 0.35, -1, 1) * 0.7;
      }
      const distGain = clamp(1.6 / Math.max(0.8, listenerDistance), 0.35, 1.0);

      // voice.gain already carries A0, the loudness parameter and the voice
      // trim; distance is the one term modal.js cannot know.
      const base = voice.gain * distGain;

      const voiceGain = ctx.createGain();
      voiceGain.gain.value = base;

      let panner;
      if (ctx.createStereoPanner) {
        panner = ctx.createStereoPanner();
        panner.pan.value = pan;
      } else {
        // Ancient Safari. Mono is a downgrade, not a failure.
        panner = ctx.createGain();
        panner.gain.value = 1;
      }
      voiceGain.connect(panner);
      panner.connect(bus);

      const oscs = [];
      const gains = [];
      const T60_0 = t60s[0];

      for (let n = 0; n < nPart; n++) {
        const T60 = t60s[n];

        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(amps[n], t0 + attack);
        // setTargetAtTime with tau = T60/6.908 lands exactly 60 dB down at T60.
        g.gain.setTargetAtTime(0, t0 + attack, decayTau(T60));

        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freqs[n], t0);
        osc.connect(g);
        g.connect(voiceGain);
        osc.start(t0);

        oscs.push(osc);
        gains.push(g);
      }

      // Contact click. Wood on metal makes a broadband tick whose centre follows
      // the same contact time as the brightness, so hardness reads in the attack
      // before any partial has had time to establish. This layer is a large part
      // of why the result does not sound like a bell preset.
      let noise = null;
      if (noiseBuffer) {
        noise = ctx.createBufferSource();
        noise.buffer = noiseBuffer;
        noise.playbackRate.value = 0.85 + Math.random() * 0.35;

        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = clamp(voice.clickFreq, 60, ctx.sampleRate * 0.45);
        bp.Q.value = CLICK_Q;

        const cg = ctx.createGain();
        cg.gain.setValueAtTime(0, t0);
        cg.gain.linearRampToValueAtTime(voice.clickPeak, t0 + CLICK_ATTACK);
        cg.gain.setTargetAtTime(0, t0 + CLICK_ATTACK, decayTau(CLICK_T60));

        noise.connect(bp);
        bp.connect(cg);
        cg.connect(voiceGain);
        gains.push(cg, bp);   // tracked either way, so teardown always reaches them
        // Offset within the buffer so repeated ticks are not identical; the click
        // is inaudible past ~40 ms so a short remaining tail is plenty.
        const offset = Math.random() * 0.02;
        try {
          noise.start(t0, offset);
        } catch (e) {
          try { noise.start(t0); } catch (e2) { /* click dropped; the tube still rings */ }
        }
        try { noise.stop(t0 + CLICK_STOP); } catch (e) { /* stops itself at buffer end */ }
      }

      const v = {
        tube: idx,
        t0,
        A0,
        T60: T60_0,
        base,
        gain: voiceGain,
        pan: panner,
        oscs,
        gains,
        noise,
        stealing: false,
        released: false
      };
      voices.push(v);
      if (idx >= 0 && idx < newestByTube.length) newestByTube[idx] = v;

      // Free the slot as soon as the fundamental is 60 dB down plus a margin.
      // A session left open all afternoon must not accumulate nodes.
      // Each partial stops once it is 69 dB down, not when the voice does. The
      // fifth partial is finished in under half a second while the fundamental
      // hums for eight, so this retires four of the five oscillators early - the
      // difference between 16 voices costing 80 oscillators and costing about 20.
      // The fundamental is always the last to stop, so its onended is the single
      // teardown path for the whole voice.
      oscs[0].onended = () => releaseVoice(v);
      for (let n = oscs.length - 1; n >= 0; n--) {
        const until = t0 + t60s[n] * 1.15 + 0.2;
        try { oscs[n].stop(until); } catch (e) { if (n === 0) releaseVoice(v); }
      }

      // Deliberately NOT damped at birth for being in contact. A strike happens
      // on the RISING EDGE of contact, so the tube is in contact at the moment
      // its voice is created, every single time -- this used to duck every new
      // note to a quarter over 120 ms and then let it climb back, which is
      // exactly the "note starts and gets cut off" it sounded like. Damping is
      // for a hammer that STAYS leaning on the tube, and setContactMask below
      // now waits for the contact to persist before applying it.
      // Clear only the DAMPED flag, not the contact clock. The clock has to keep
      // running: if the hammer struck and then stayed leaning, this new voice
      // still needs to be ducked once the contact outlasts the grace period.
      if (damped && idx >= 0 && idx < damped.length) damped[idx] = 0;
    },

    setListener(right, target, distance) {
      if (right && right.length === 3) {
        listenerRight[0] = num(right[0], 1);
        listenerRight[1] = num(right[1], 0);
        listenerRight[2] = num(right[2], 0);
      }
      if (target && target.length === 3) {
        listenerTarget[0] = num(target[0], 0);
        listenerTarget[1] = num(target[1], 1.7);
        listenerTarget[2] = num(target[2], 0);
      }
      listenerDistance = num(distance, listenerDistance);
    },

    setTier(tier) {
      if (!tier) return;
      partialCount = clamp(num(tier.partials, MAX_PARTIALS) | 0, 1, MAX_PARTIALS);
      maxVoices = Math.max(1, num(tier.maxVoices, 16) | 0);
    },

    suspend() {
      if (!ctx) return;
      try { ctx.suspend(); } catch (e) { /* nothing to suspend */ }
    },

    resume() {
      if (!ctx) return;
      try { ctx.resume(); } catch (e) { /* needs a fresh gesture; unlock() handles it */ }
    },

    voices() {
      return voices.length;
    },

    state() {
      return {
        ready: !!ctx && ctx.state === 'running',
        voices: voices.length,
        sampleRate: ctx ? ctx.sampleRate : null,
        contextState: ctx ? ctx.state : 'none'
      };
    }
  };

  return audio;
}
