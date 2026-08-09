# Wind Chime Simulator, requirements

Status: draft, 2026-08-07. Written to be fed to a gauntlet loop, so every section
ends with a bar a blind critic can actually fetch and compare against.

## Where the project stands today

The simulator is live at windchimesimulator.com and already does the hard part.

- `wind.js` carries one wind field (mean, gust, turbulence) that everything else samples.
- `physics.js` runs the plate, tubes, clapper and sail as a constrained particle rig,
  including tube-on-tube collisions.
- `audio.js` is modal synthesis of a struck aluminium tube driven by strike events, not
  samples.
- `weather.js` pulls api.weather.gov and classifies the sky into
  `storm | snow | rain | fog | cloudy | partly | clear`.
- `scene.js` renders through three.js r185, vendored, with a Sky shader and two visual styles.

About 9,400 lines of JS, no build step, no CDN. Weather already reaches the audio, but not
yet the picture.

## The organising idea

A place is an impulse response, not a backdrop.

A stone cloister has a long reverb tail and hard early reflections. A garden is dry, with
leaves scattering instead of reflecting. Snow on the courtyard floor absorbs the top end.
If the environment only changes what you see, it is wallpaper. If it changes what you
hear, it is part of the instrument, and a critic can judge it against a recording.

Same rule for the workbench. Every part on the bench has to change the sound physically.
A cosmetic-only part is out of scope.

## Priority order

Fixed, and it decides every trade-off below.

1. Audio never glitches. Dropouts, crackle and buffer underruns are release blockers.
2. Audio is physically plausible for the chosen materials and lengths.
3. The picture reaches the visual bar.
4. Frame rate.

Visual hiccups are acceptable. A stutter in the audio is not. Any render budget reserves
headroom for the audio thread first, and the render tier drops before the audio does.

## Phases

Sequenced, not parallel. Each phase ships on its own.

**Phase 1, the cloister.** One flagship environment at the visual bar, with its acoustics.
**Phase 2, weather in the picture.** The existing classification drives rain, snow, fog,
overcast and light.
**Phase 3, the workbench.** Build your own chime, hear it as you build it.
**Phase 4, the garden.** Second environment, reusing the foliage and acoustic work.

## Phase 1: the cloister

A monastery cloister: a square courtyard ringed by an arcade of repeating arches, stone
floor, a covered walk, sky above the open middle. The chime hangs under the arcade at the
courtyard edge.

Chosen over the garden for v1 because repeating arches are procedurally generable without
an artist, because stone and low sun through an arcade gives the strongest picture per
unit of work, and because the reverb is dramatic enough to prove the organising idea.

### Rendering

- Physically based materials throughout. Aluminium, copper with patina, glass, bamboo,
  ceramic and steel all need correct metalness and roughness, not tinted diffuse.
- Baked lightmaps for the static architecture. Real-time lights for sun and sky only.
- Cascaded shadow maps, with contact-hardening near the tubes.
- Volumetric shafts through the arcade openings, with dust in the beam.
- Ambient occlusion, baked where the geometry is static.
- Post chain on top of the existing ACES and bloom: SMAA or TAA, a colour grading LUT
  selected per weather state, depth of field focused on the chime.
- Foliage animated in the vertex shader, sampling the same wind field the rig samples. The
  grass, the chime and the audio all have to agree about the gust that just arrived.

  **This clause applies to procedural places only.** A place whose world is a still plate
  rendered from a photographic capture has no grass to animate, and the rule for one is the
  opposite of the rule for the other: in a plate place the chime is the only moving thing in
  frame, and everything behind it is a photograph. Amended 2026-08-08 per
  `.gauntlet-bar/ARBITRATION.md` §2, in the same commit as the first plate place. Nothing
  else in this document changes.

### Acoustics

Convolution reverb using an impulse response appropriate to a stone cloister. Wet and dry
mix set by where the camera sits relative to the arcade. Under the covered walk the early
reflections are strong; out in the open courtyard they fall away.

If a measured cloister impulse response cannot be sourced under a compatible licence,
synthesise one and compare it against a recording of a real stone cloister.

### Bar

Reference photographs of a real cloister at low sun, fetched at the start of the run.
Le Thoronet Abbey, Santo Domingo de Silos and The Cloisters in New York are all
photographed heavily and are good candidates. For the material and lighting bar, use
screenshots from a shipped title with stone architecture and strong sun, judged blind at
matched viewport and time of day.

For the reverb, a field recording of a wind chime in a stone courtyard, judged blind
against the simulator's output at matched wind speed.

## Phase 2: weather in the picture

`classifySky` already emits the state. It has to reach the renderer.

| State | Picture | Sound |
|---|---|---|
| clear | Hard sun, sharp shadows, warm stone, dust in the shafts | Dry, full reverb tail |
| partly | Cloud shadows crossing the courtyard | Unchanged |
| cloudy | Flat overcast, soft shadows, desaturated grade, no shafts | Unchanged |
| fog | Heavy distance fog, diffused shafts, bloom halo | Slight high-frequency roll-off |
| rain | Wet stone at lower roughness, puddles with reflections, ripples, drips off the arcade lip | Rain bed under the chime, damping on the tubes |
| storm | Rain plus lightning, darker grade, stronger gusts | Rain and wind bed, more frequent strikes |
| snow | Accumulation on horizontal surfaces, falling snow, cold grade | Shorter reverb, high end absorbed |

Sun position comes from real local time and latitude, so the courtyard at 7am in December
looks nothing like the same courtyard in July.

The wet-surface response and the snow accumulation give the largest jump in perceived
quality for the least work. Build those first inside this phase.

### Bar

The same weather condition photographed in a real stone courtyard, one reference per
state. For the wet-surface response specifically, screenshots from a shipped title known
for rain, judged blind at matched framing.

## Phase 3: the workbench

Looking down at a bench with the parts laid out on it. You scroll horizontally through the
options in each slot the way you would dress a doll, and the chime hanging at the end of
the bench re-rings with every change.

Slots:

- Tubes: material, count, wall thickness, and a length set that follows a tuning system
- Striker
- Sail
- Suspension plate
- Cord

Rules:

- Every slot changes the sound. If swapping a part produces no audible difference, the part
  does not ship.
- No currency, no unlocks, no progression, no store. Everything is available on arrival.
- First load drops you straight into the default chime in the cloister. The workbench is a
  door you can open, never a gate you pass through.
- The chime audible on the bench is the same synthesis path as the chime in the scene. No
  preview approximation.
- Configuration encodes into the URL, so a chime can be shared with no backend.

Tuning systems: pentatonic, Japanese *in* scale, whole tone, just intonation, and a manual
mode where you set each tube by ear.

### Bar

A real wind chime configurator from a manufacturer, judged blind on whether a first-time
visitor understands what each control does within thirty seconds. For the audio half,
recordings of real chimes in each material, judged blind against the synthesised
equivalent by someone told only that one of the two is a recording.

## Performance

- Audio buffer underruns: zero, on the target tier. This is the release gate.
- Desktop target: 60fps at 1440p on a mid-range discrete GPU.
- The page runs in a background tab without dropping the audio. The current build already
  handles this and it must not regress.
- Long sessions are the normal case, which means nothing may leak. A four-hour session ends
  at the same memory footprint it reached in the first ten minutes.

## Mobile

Desktop-first. Ship the desktop bar, measure real phones, then dial back until it runs.
Expect a reduced tier that keeps the audio path identical and cuts the render: lower
shadow resolution, no volumetrics, fewer particles, half-resolution post.

The audio path does not get a mobile variant. If a phone cannot run the picture, it shows
less picture and hears the same chime.

## Assets and licensing

The repository is public and the code is MIT, which already requires anyone reusing it to
keep the copyright notice. That is attribution, so switching the code to CC BY buys
nothing and creates a problem: Creative Commons advises against CC licences for software,
because they say nothing about source availability or patents.

Recommended split:

- Code stays MIT.
- Scenes, textures, models and the modal material library go under CC BY 4.0.
- A `NOTICE` file states both.

Sourcing rules, which are strict because the repo is public:

- CC0 sources preferred. Poly Haven and ambientCG are both CC0 and cover most of what a
  stone courtyard needs.
- CC BY is acceptable, with the attribution recorded.
- Anything carrying NC or ND is rejected outright. So is anything whose licence cannot be
  established.
- Every third-party asset gets a row in `ASSETS.md`: file, source URL, author, licence,
  and the date it was fetched. An asset with no row does not ship.

## Non-goals

- No game. No score, no objectives, no economy.
- No accounts and no server-side state. Sharing happens through the URL.
- No licence business. The engine is copyable and selling it is not worth the effort.
- No multiplayer.

## How a critic judges

Every piece above gets a builder and a separate critic with fresh context. The critic
fetches the real reference, strips the labels, puts the two side by side, picks one, and
names the single largest remaining gap. Scores out of ten are not used, because they drift
upward every round.

The audio pieces are judged by listening at matched wind speed, never by reading the
synthesis parameters.

## Open questions

- Which cloister impulse response, measured or synthesised, and under what licence.
- Whether the default location stays the visitor's real weather or offers a curated one on
  first load.
- Whether the garden in phase 4 is a botanical garden or a Japanese temple garden. The
  temple garden shares more with the cloister and would cost less.
