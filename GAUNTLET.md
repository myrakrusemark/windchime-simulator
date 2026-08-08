# Gauntlet prompts

A gauntlet loop sets a real bar, splits the work into pieces small enough to judge on
their own, runs a builder and a separate harsh critic on each, compares blind against the
bar, and loops until it wins. The bar is the whole trick: it has to be **named**,
**fetchable**, and **comparable**, or the critic invents a comparison and approves
everything.

Trigger: **"go go gadget gauntlet"** — run the active prompt below.

---

## Active: the structure

```
Build the structure the wind chime simulator does not have. First load lands on a default
chime, already hanging in a default place, already sounding — nothing to click through.
From there a visitor can build: choose a place, choose the pieces, hang it where they
want, and go back to enjoying it. A place is a still plate and the chime is the only
living thing in it. The visitor sets the hang point and the scale; everything else about
a place is authored with the place.

The bar is Apple Watch Studio. Open the real thing and work through it. Count the choices
it takes a stranger to reach something they made and could share, and beat that count.

Break this into the smallest pieces that can be improved and judged on their own. For
each piece, fan out a builder and a separate critic with fresh context. The critic drives
the real page in a browser, puts a screenshot of ours beside the real thing blind with
the labels stripped, says which one a stranger would understand faster, and names the
single biggest remaining gap. Then it goes back to the builder.

The critic should be a harsh critic. Praise is not useful. If ours does not win, it keeps
going.

/loop on each piece until the critic picks ours blind. Do not stop before that.

Keep a live progress page updating as the work evolves, with screenshots, so I can watch
it.

Fan out subagents and ultracode.
```

**Why this bar.** Apple Watch Studio is the same shape: pick a case, pick a band, watch it
assemble live, leave with something you made and a URL that carries it. No account, no
store, no progression. It is fetchable, it is comparable at a matched viewport, and it is
merciless about the thing that actually matters here — how few decisions stand between
arriving and having made something.

**What is already decided, so the loop does not relitigate it.**

- The chime's physics and sound are **finished and not under judgement this session**. Do
  not re-tune synthesis, damping or mode ratios. If a structural change breaks the sound,
  that is a bug to fix, not a piece to grind.
- A place is a still plate — a gaussian splat that never moves. A frozen sun is correct,
  not a defect, and the background owes nobody physically-derived weather.
- Sun, sky, shadow character, camera bounds, proxy hulls and the acoustic profile are
  authored once per place and ship with it. The visitor never sets them.
- The visitor sets exactly two things about placement: hang point and scale.
- Camera orbit is bounded per place so it never swings toward the thin side of a capture.
- The flow is: land on something alive → build → hang → enjoy. The builder is a door you
  can open, never a gate you pass through.

**Where the structure stands today**, surveyed 2026-08-08: there is one screen. The sim
starts on paint and "Start Wind Chimes" only unlocks audio for the browser's gesture
requirement. Every control lives in a settings drawer behind a hamburger. There is no
notion of a place, no build flow, no pieces as slots, no hang step, and no routes.
`URLSearchParams` is read on load and the hash is cleared, so share-by-URL is at best
partial. This is new construction, not a refactor.

**Assets on hand.** `~/.cache/windchime-splat/forest-path/` is an 18 MB SOG capture, CC BY
4.0, roughly a million gaussians, with bounds in `lod-meta.json`. It is the only splat
cleared to ship. Three others were evaluated and rejected on licence or size; see the
session notes. The SOG-into-three.js path is **unproven** and is the first real risk.

---

## Retired: the chime's sound

Ran 2026-08-07/08. Bar: real recorded single-tube strikes plus Stanford CCRMA's STK for
CPU only. Won the yardstick, the Timoshenko mode ratios, the upper-mode rolloff and the
polarisation beating. Per-mode damping is unfinished and its pass criteria need
re-deriving — see `~/.cache/windchime-gauntlet/HANDOFF.md` before restarting it.

```
Build the best windchime simulator there is. People come to design their own chimes and
leave it running in the background for hours, and the simulation code has to be good
enough that a game studio would drop it into a shipping title.

The bar is real recorded audio of a Music of the Spheres chime, plus STK's ModalBar and
TubeBell from Stanford CCRMA. Pull the actual recordings and build the actual STK code.
Compare against those directly, not against a description of them.

Break this into the smallest pieces that can be improved and judged on their own. For
each piece, fan out a builder and a separate critic with fresh context. The critic
listens to ours next to the real recording blind with the labels stripped, says which one
is the microphone, and names the single biggest remaining gap. It also checks our modes
against the free-free ratios 1 : 2.756 : 5.404 : 8.933 and our CPU per voice against
STK's at 48 kHz. Then it goes back to the builder.

The critic should be a harsh critic. Praise is not useful. If ours does not win, it keeps
going.

/loop on each piece until the critic picks ours blind. Do not stop before that.

Keep a live progress page updating as the work evolves so I can watch it.

Fan out subagents and ultracode.
```

**What that run taught, which applies to any future one.**

- Fix the yardstick before trusting it. `compare.py` scored partial level nowhere, so an
  18 dB error read as 0.0 divergence units and a whole class of defect was invisible.
- Measurement beats research. Three of eight physics findings were demoted or dropped once
  measured; one was backwards in sign.
- Control for the channel. Undoctored, our render's noise floor sat 44 dB below a
  YouTube-sourced reference, so a critic could identify the microphone without ever judging
  the instrument.
- Two critics, not one. A measurement critic verifies the numbers; an adversarial critic
  hunts the cheat. It caught reference pitches hard-coded into the test suite.
- Cap by clock, not by rounds, and report the cap rather than swallowing it.
