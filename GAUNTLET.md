# Gauntlet prompts

A gauntlet loop sets a real bar, splits the work into pieces small enough to judge on
their own, runs a builder and a separate harsh critic on each, compares blind against the
bar, and loops until it wins. The bar is the whole trick: it has to be **named**,
**fetchable**, and **comparable**, or the critic invents a comparison and approves
everything.

Trigger: **"go go gadget gauntlet"** — run the active prompt below.

---

## Active: the environment

```
Build the environment step of the wind chime builder. You choose a place, build your
chime, and hang it up. The place is a gaussian splat plate that never moves — a
cinemagraph, where the only living thing in frame is the chime, driven by the physics
that already runs. Sun, sky, shadow character, camera bounds and acoustics are authored
once per environment and arrive with it. The visitor sets two things: hang point and
scale.

The bar is real video of a wind chime hanging outdoors in moving air. Pull actual footage
and compare against it directly, not against a description of it. The chime's shadow
direction, colour temperature and luminance range have to sit inside the plate's own.

Break this into the smallest pieces that can be improved and judged on their own. For
each piece, fan out a builder and a separate critic with fresh context. The critic
renders ours, puts a frame beside a frame of the real footage blind with the labels
stripped, says which one is the photograph, and names the single biggest remaining gap.
Then it goes back to the builder.

The critic should be a harsh critic. Praise is not useful. If ours does not win, it keeps
going.

/loop on each piece until the critic picks ours blind. Do not stop before that.

Keep a live progress page updating as the work evolves so I can watch it.

Fan out subagents and ultracode.
```

**Why this bar.** Real footage judges the whole composite at once — whether the chime sits
in the plate, whether it moves like an object with mass, whether the light agrees. A still
photograph would only test the first. And it is abundant, so the critic can always fetch
one.

**What is already decided, so the loop does not relitigate it.** The picture is a
cinemagraph, so a frozen sun is correct rather than a bug and the background owes nobody
physically-derived weather. The environment still colours the *sound* — a hand-authored
acoustic profile per place, which is a few numbers, not a renderer. Camera orbit is
bounded per environment so it never swings toward the thin side of a capture.

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
