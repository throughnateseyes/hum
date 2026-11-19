# Hum — sound → sight

An audio-reactive visual playground. Drop a song in; Hum splits it into layers (sub, bass, mids,
air, kick / snare / hat hits, energy, build-ups, drops), reads its mood, picks a look that fits, and
paints with it. Everything is tweakable: scenes, a stackable effect chain, a modulation matrix that
routes any audio layer to any slider, palettes, photos, and an AI director that writes looks — or
brand-new GLSL scenes — from a sentence.

```bash
npm install
npm run dev          # http://localhost:5173
```

The Claude director works out of the box in dev if Claude Code (`claude`) is installed and signed in:
it runs on your Claude subscription, no key needed. For a deployed site, set `ANTHROPIC_API_KEY`.
With neither, an offline heuristic director answers. See [docs/DIRECTOR.md](docs/DIRECTOR.md).

## Using it

- **Drop audio** anywhere (mp3 / wav / m4a / flac), pick a built-in demo (*Pressure* — 140 bpm
  halftime bass with a build and a drop; *Driftwood* — 72 bpm rain and piano), or use the mic.
- **Drop photos** anywhere — photo scenes and the instrument boards dissolve, mosh and rebuild them
  (a new photo every 4 bars).
- **Looks** (left) are presets. After a track is analysed they're ranked for it ("fits"). Hover any
  look or scene to preview it live in a small window beside the list; click to use it.
- **The timeline** (bottom) is one lane: the waveform, the song's parts (intro, verse, chorus,
  bridge, build, drop, break, outro) with each part's look as a picture and name (or an empty
  "No look yet" slot), drops marked by how big they are, and one playhead. Parts that sound alike
  share a colour, so a returning chorus is easy to spot.
  **Make a video** asks Claude to give every part a look (offline plan if Claude isn't reachable) and
  plays the song from the top. Each part is cut into short shots on musical phrases, rotating
  through 2–4 related looks: busy parts cut faster, calm parts hold longer, extra cuts land when the
  kick or bass comes back, a vocal starts or a lyric line begins, and every big drop is a hard cut.
  Transitions come from a library of 15 (crossfade, fades through the background colour or black,
  light and cloud dissolves, film burn, ink, soft wipe, iris, ripple, mosaic, glyphs, zoom push,
  slit-scan, cut), timed in beats and picked to fit the moment: long dissolves in calm parts, wipes
  and slit-scans on builds, quick pushes and glitch swaps in loud ones, and a hard cut on every big
  drop. Dissolves step forward on kicks. **Transition** (Look tab) pins one for everything (videos,
  auto-pilot and your own picks) or Cut, and **Length** sets it in beats.
  **Pace** (Look tab: Slow / Song-driven / Fast) sets how often it cuts. To edit, drag a look onto
  a part (hold ⌥ to change only that one), or pick a look while a part plays, or ask in words in the
  Director's **Video** mode ("calmer chorus", "something brighter on the drop", "fewer pop-ups"):
  only the parts you mention change, on the small model, for a fraction of a cent. Picking a scene
  pauses the song map.
  **Saved videos:** the last video Claude made for a song stays in this browser (24 songs), edits
  included, so **Make a video** on a song you've done before plays it straight away with no new
  request. **Remake video** (or typing a wish) always asks Claude for a fresh take.
- **Your taste.** Hum learns what you like as you use it. While a video plays (or any look is on
  screen), hover the stage and press **♥ Keep** (`K`) on looks you love or **✕ Skip** (`X`) on ones
  you don't; Skip also takes that look out of the part and moves on. Looks you pick from the list
  or drag onto a part count too, and a look Hum chose that you swap out within a few seconds counts
  a little against it. Each reaction remembers where it happened (chorus, drop…) and what kind of
  song it was (genre, mood, energy), so Hum can learn "Paper looks on choruses" and "no Glyph on
  tender songs" at once. Recent reactions count most and old ones fade (half as much every 30
  days). It steers the offline planner, auto-pilot, each part's rotation and the AI planner, but
  about one pick in five still explores, and every **Make a video** is a new take: renders are
  seeded and Hum remembers the last few plans per song so it doesn't repeat one. **Your taste**
  (Look tab) says in plain words what Hum has learned, with a switch to turn learning off and a
  reset. It all stays in this browser (localStorage); the AI planner only gets a short summary
  (look ids, tags, section names and counts) with a plan you asked for.
- **Breakdown** (button by the timeline, or `B`) shows how Hum took the song apart: its genre,
  mood and instruments, the parts, every drop with how big it is and why, the waveform, energy and
  low / mid / high lanes, kick, snare and hat hits, a piano roll of the bass and lead notes, and
  where the vocals are. Click anywhere to jump there.
- **Overlays** (switch by the timeline) turns the pop-up windows off or back on.
- **Lyrics** are found on their own. Hum reads the song's title and artist from the file's tags
  (or its name, like `Artist - Title.mp3`; music-video rips work too, with "(Official Video)",
  "[Lyrics]", "feat. …" and the like ignored), then gets timed lyrics from
  [LRCLIB](https://lrclib.net), a free lyrics library. Lyrics saved inside the file are used first.
  If LRCLIB only has a longer or shorter version (videos add intros and outros), Hum moves the lines
  to where the singing starts in your file. Wrong song or nothing found? **Search LRCLIB** in the
  chip by artist and song, or paste a lrclib.net link.
  Only the title, artist and length are sent, never the audio. The chip beside the track name shows
  what was found. It also switches between **Auto** (the default, a lyric video: see *Auto lyrics*
  below), **Subtitles**, **Big words** (one line at a time, word by
  word), **Cutouts** (the same big line as a ransom note: each word or letter cut from a different
  clipping, slapped down as it's sung) and **Off**. On looks that already type the words out (Diary,
  Orbit) the big lines stand down by default; *Show anyway* in the chip brings them back. Lyrics show up in recordings and stills, and the song map's planner reads them
  to fit each part's look to the words. Songs that aren't on LRCLIB (unreleased ones, for example)
  get no lyrics, but you can **paste them** in the chip. Hum then times each line by listening for
  the sung words on this computer (Whisper, about a 95 MB model downloaded once; the audio never
  leaves your machine). If a line is off, **Fix timing** lets you tap along as each line starts, and
  **Shift all lines** moves them all earlier or later. Pasted or fixed lyrics are remembered for that
  song.
- **Auto lyrics** direct the words like a lyric video. Each part of the song gets its own medium:
  subtitles for verses and wordy parts, big words or cutouts for choruses and drops, a word or two in
  a calm corner for builds and intros, and the look's own lyric components where it has them (the
  Diary typewriter, the lyric walls, the word cards: overlay text stands down there). One-off moments
  land too: one giant word on the biggest drop, a burst of cutouts on one chorus. The choice comes from
  each part's label, energy, words per second and the look planned there; the whole song keeps one
  type family (serif, grotesk, condensed, mono, rounded or typewriter, picked to fit its mood) and one
  motion (soft fades, blur-ins, slams or shaking type). **Make a video** plans the lyrics together with
  the looks (Claude when it's connected, the offline planner otherwise), with a fresh seed each time,
  so two videos of the same song read differently. The chip shows what Auto chose for the part that's
  playing and why. Every style is **guarded for legibility**: every other frame Hum shrinks the
  picture under the text to 96×54 and checks it, then picks the calmest place for the line, an ink
  that reads there and the lightest backing that clears the contrast target (none, a soft shadow, a
  soft plate, a band, or a torn paper strip on paper looks), easing between them so nothing flickers
  when a cut changes the picture. The per-look lyric profiles and the audit behind them are in
  [docs/LYRICS-AUDIT.md](docs/LYRICS-AUDIT.md).
- While a new song is being analysed, the Hum mark floats on the stage, breathing with the music.
- **Busy boards and pop-ups.** Four more instrument boards join Orbit, Lab and Oto: **Arcade** (Pong
  with the ball hitting on the beat, a runner that jumps on kicks, Tetris, a BPM odometer, a
  hi-score table of the most-sung words), **Mission** (a terminal log narrating the song — "BAR 017 · KICK .82",
  "DROP IN 4" — with radar, an XY figure, the song map and meters), **Diary** (the sung line on a
  typewriter, a word cloud of everything sung so far, the next line coming up, a mood weather
  report) and **Forecast** (a weather station for the song: sun, drizzle, a storm on the drop, the
  next parts as a forecast, a news crawl of the whole lyric sheet).
  **Pop-ups** (Look tab) are little framed windows of these instruments that pop in over whatever is
  playing on new parts, drops and some bars, then snap shut a few bars later. They're in recordings too. *In videos* (the default) shows them while a video plan
  plays, busier on choruses and drops; *Always* keeps a few coming. The video planner (Claude or
  offline) marks how busy each part's pop-ups get and can open a part with a board look for its
  first four bars.
- **Scene windows.** Pop-ups can also be other looks: framed windows (a title bar with the look's
  name, a plain card, or a round cut-out) each playing a different look live over the picture, so
  looks combine like a desktop stacked with programs. They open on new parts and phrases, bump on
  kicks, stamp a cascade of copies on snares, huddle and tremble through a build, slam shut on the
  drop and burst back open a beat later. *Windows show* (Look tab → Video) picks Instruments, Looks
  or Both (the default); the Pop-ups switch turns all of them on or off.
- **Song colours.** A video cut from many looks still reads as one piece: every look leans toward
  the colours of the look the song uses most (choruses and drops count double), and scene windows
  wear them too. Only hue moves, so each look keeps its own lights and darks and stays readable.
  *Song colours* (Look tab → Video): *Blend* (the default) meets halfway, *Match* puts every look on
  the main look's colours, *Off* leaves them alone. See `docs/song-colours.jpg`.
- **Text wall, particle columns, glass planes, tracking HUD.** **Text Wall** (*Redacted*,
  *Highlighter*) fills the page with the song's lyrics, knocks words out and snaps red, yellow,
  blue and cyan boxes onto them on the beat; the sung line lights up wherever it appears and drops
  flood the wall (no lyrics → title, genre, mood and section names). **Particle Columns** (*Ice*,
  *Sodium*) is a spectrum of stippled glowing dots over a haze band. **Glass Planes** (*Glasshouse*,
  *Violet Glass*) folds isometric glass strips with lime edges and hairlines: kicks extrude, snares
  streak, drops re-fold. **Tracking HUD** (*Tracking HUD*, *Surveillance*) puts red tracking boxes,
  centroids, motion arrows and live x / y readouts over a swirling body of light.
- **Paper, glyphs, a pixel cube and flip cards.** **Paper Visualizer** (*Paper Visualizer*,
  *Paper Tangerine*) stands red cut-paper bars, a curve, a waterfall of slices and a radial ring up
  off white card in soft daylight, folding from one to the next on new parts and drops, with paper
  type, a scrubber bead and dots that hop on kicks. **Glyph Mosaic** (*Glyph Mosaic*, *Glyph
  Negative*) prints dots, rings, crosses and asterisks in one ink; patches flip on kicks, the bands
  pick the glyphs, drops dissolve to the negative. **Pixel Cube** (*Pixel Cube*, *Bubblegum Cube*)
  is a 3×3 puzzle cube with pixel-art faces drawn from the music on a pastel poster: layers turn on
  the beat, it solves itself back, drops make it tumble. **Flip Cards** (*Flip Cards*, *Flip Cards
  Paper*) deals big turned words from the lyrics (else the title) onto colour cards that flip on the
  beat and skew on snares.
- **Worlds.** Places and living things that follow the song's arc. **Willow** is a woodblock willow
  lake where wind is the music and the drop blows the curtain open to let the sun in. **Night
  Windows** is a picture-book tower whose floors are frequency bands, so the facade is an equaliser
  made of people's evenings. **Signal Forest** reads a night glade as contour lines and spectral
  rings round each trunk. **Wing** is a butterfly wing in close-up whose veins carry each kick out
  to its eyespots. **Shoal** puts you inside about 2,000 fish that wind into a bait ball before a
  drop and burst on it; **Jellies** is a tank of jellyfish that pulse on the beat. **Night Train**
  is a dithered pixel-art subway car that bursts out of the tunnel on the drop. **Retro Desktop**
  types the lyrics into a notes window and crashes in a cascade of error dialogs; **Observer** is a
  wall of little windows full of eyes and skies that switches off like a CRT before the drop.
  **Orrery** turns rings of watching eyes over a sea of cloud.
- **Print.** **Bead Fire** (hot-rod flames in beadwork), **Halftone Flow** (poured paint printed as a
  grid of dots), **Confetti** (a pointillist field that falls into rings in a build and bursts on
  the drop) and **Specimen Tiles** (a sheet of tiles, each a plate resonating to one part of the song).
- **Type.** **Ribbon Type** snakes ribbons of type through a gig poster with the sung line on the
  ribbon in focus, and deals a new poster on every drop. **Word Drop** drops every sung word as a
  colour tag that falls, bounces and piles up.
- **Light, particles, forms, data.** **Prism** (light through cut crystal), **Soft Orbs** (each orb
  a voice of the mix), **Neurones** (a branching organism that grows with the song and fires root to
  tip on kicks), **Dot Assembly** (dots pack into the song's title, a few more docking on each kick),
  **Gradient Cubes** (a toy box that rolls with the beat) and **Signal Scan** (the last seconds of
  the song as a black-and-white line-scan recording).
- **Style chips** at the top of the Looks list filter by family (Worlds, Light, Particles, Forms,
  Print, Type, Data, Photo, Boards) alongside the mood chips; with no song loaded the list is grouped
  by family. The Scenes tab is grouped the same way.
- **Impact** (next to the timeline) sets how hard everything reacts: 0% is still, 200% is wild. Every
  look also gets a built-in hit layer: a punch on kicks, a split on snares, a hit on the drop and
  tension during build-ups.
- **Hand-drawn** (next to Impact, or `H`) runs every scene through a hand-made finish. It draws a
  new picture only 12 or 8 times a second, like hand animation (kicks, snares and drops always get
  a fresh drawing so hits land), and lines wobble between drawings. Colours print as a few flat inks
  from the palette, slightly out of line, on paper, with an optional pencil outline. Fine-tune it in
  the Look tab. Lyrics go through it too, and saved looks keep their hand-drawn settings.
- **Scenes** (left) are the raw visual engines; **Inspector** (right) has the scene's sliders, the
  **Effects** stack, **Routing** (the modulation matrix) and **Look** (palette, lyric text, frame
  aspect for 9:16 reels / 4:5 / 1:1, quality, auto-pilot, save look).
- **Drag a layer meter** from the bottom strip onto any slider to make it react to that layer. The
  blue tick on a slider shows its live, modulated value.
- **Director** (bottom of the right column, `/` to focus): a chat with history. Describe a feeling →
  a *Look*; switch to *New scene* → Claude writes a brand-new GLSL scene that's compiled live (errors
  show in the Scene tab); with a video made, *Video* changes it in plain words. A short tweak of the
  look on screen ("warmer", "less busy", "more grain") goes to the small model with a shorter catalog.
- **Render quality** (Look tab → Advanced) is the most detail Hum draws. When frames run late Hum
  eases off by itself, cheapest first: fewer pop-up scene windows, then the main picture drawn a
  little smaller, then effects at that size, then a lighter hand-drawn finish. It tries the detail
  back when there's room, and waits longer after each try that didn't hold, so it settles instead of
  flickering (`src/render/quality.ts`; the field says "easing off" while it is).
- **Thumbnails** for the built-in looks live in `src/assets/thumbs`. After changing looks, regenerate
  them from the browser console with a track playing: `await __hum.makeThumbs()`.
- **Record** captures video + audio (MP4 where supported, else WebM). The camera icon saves a PNG.
- Keys: `space` play/pause · `←/→` previous/next look · `K` keep · `X` skip · `R` shuffle · `H` hand-drawn · `B` breakdown · `F` perform mode · `esc` exit.

## How it's built

```
audio file / mic
  → AudioEngine (src/audio/engine.ts)      real-time: 6 bands, onset envelopes, beat phase, energy, build, drop
  → analyzeTrack (src/audio/analysis*.ts)  offline worker: bpm, sections (harmony/timbre self-similarity,
                                           bar-aligned, repeats grouped), drops, mood, tags, preset ranking
  → lyrics (src/audio/tags.ts, lyrics.ts)    file tags / name → embedded LRC or LRCLIB timed lines
  → video plan (src/state/plan.ts)         a look per section; switches looks along the song
  → taste memory (src/state/taste.ts)      Keep / Skip and hand picks, in context; biases every pick
AudioFrame + analysis → Feel (src/core/feel.ts)       the song's emotional state and a shared world, the same for every look
AudioFrame → modulation matrix (src/state/modulation.ts) → resolved params
  → SceneInstance.render → render target   (src/scenes/{board,three,shader,photo,nature,worlds,print,type})
  → FxChain (src/render/fxChain.ts)        stackable GLSL passes (src/fx/defs)
  → transition (src/render/transitions.ts) blends the outgoing look (still playing) into the new one;
                                           picked by src/state/transitionPick.ts
  → impact, pop-ups, lyrics, hand-drawn     (src/render/stage.ts, popups.ts, lyricLayer.ts, handPass.ts)
  → scene windows (src/render/sceneWindows.ts)  other looks, each rendered at its window's size, framed over the picture
  → screen / MediaRecorder
```

- `src/core/` — the contracts (`types.ts`), the shared GLSL header + function library (`glsl.ts`),
  and helpers to define scenes (`defineShaderScene`, `defineCanvasScene`, `defineThreeScene`).
- **Feel** (`src/core/feel.ts`, `frame.feel`, `uFeel*` in shaders) is what keeps looks in agreement.
  The audio layers say what is sounding now; Feel says what it means: `intensity` (how big this
  part is), `tension` (winding up, including the last seconds before a drop the analysis already
  knows is coming, so a look can wind up before the hit), `release` (the afterglow of a drop) and
  `warmth`. It also carries a small shared world: wind direction, gusts and a time of day that runs
  from dawn to dusk over the song. Looks with wind, weather or a light source read them from there,
  so a cut between looks keeps the same weather and light.
- **Style families** (`src/core/styles.ts`): every scene names one (`world`, `light`, `particles`,
  `form`, `print`, `type`, `data`, `photo`, `board`). The library filters and groups by them, and the
  video planner keeps a part's shots inside one family.
- **Shared engines for scenes:** `tnoise` / `tfbm` read a shared noise texture (several times cheaper
  than computed noise; `src/core/noise.ts`), and `Flock` (`src/core/flock.ts`) steers a few thousand
  bodies for anything made of a crowd.
- **Song palette** (`src/core/songPalette.ts`): `harmonize(look, key, strength)` rotates a palette's
  hues onto a key palette's in OKLCH, keeping lightness exactly. Colours far round the wheel commit
  to the key's hue rather than stopping halfway in mud; greys take a breath of the key's ground. The
  plan applies it as looks come on screen (`songTinted` in `src/state/plan.ts`).
- **Adding a scene:** write a `SceneDef` with params and a `style`, and drop it in one of the
  `src/scenes/*/index.ts` arrays. A shader scene is only a `void main()` — see
  `src/scenes/shader/guide.ts` (this is also the guide the AI reads).
- **Seeing a scene while you build it:** `/solo.html` (dev only; `src/dev/solo.ts`) plays one scene
  against a scripted 64-second test song (`src/dev/testSong.ts`: intro, verse, build, a drop at
  0:32, break, outro) with no audio to load. With `npm run dev` running
  (and `npm i -D playwright-core` done once, which drives your installed Chrome),
  `node scripts/look-shot.mjs --preset willow-print --out sheet.png` renders a contact sheet of the
  song's key moments in a headless browser and prints shader errors and the frame cost
  (`--scene <id>`, `--mod <file>` for a scene not registered yet, `--portrait`, `--at 16,32.1`).
- **Smooth frames:** the quality governor (`src/render/quality.ts`) watches frame times from the
  stage's own loop and steps detail down and back up (see Render quality above). Anything that renders
  frame by frame for export must call `quality.freeze(true)` first (and `freeze(false)` after) so
  every frame gets full detail; the stage also ignores the governor while `setOutputSize` pins an
  output size. `quality.force(n)` pins a rung to look at it. Shaders for the song map's next look,
  its effects and the next pop-up window compile in the background ahead of the cut
  (`src/render/warmup.ts`, `renderer.compileAsync` with KHR_parallel_shader_compile), so cuts don't
  stall on a compile. Dev console: `await __hum.perf.moments()`, `__hum.perf.rungs()`,
  `__hum.perf.hitch(ids, 'async')` time frames at 1080p (`src/dev/perfProbe.ts`).
- **Adding an effect:** an `EffectDef` with a fragment shader in `src/fx/defs/`.
- **Adding a look:** an entry in `src/presets/library.ts`. Tags matter — the analyser matches on them.

Colour management is off on purpose: palette hex values go into shaders untouched.

## Deploying (e.g. on your site)

It's a static Vite app plus one serverless function (`api/director.ts`, Web-standard `POST`).
On Vercel: import the folder and set `ANTHROPIC_API_KEY`. Without a key the site still works with the
offline director.

Limits (all in `server/limits.ts`, every one optional):

| Setting | What it does | Default |
|---|---|---|
| `HUM_ACCESS_CODES` | One code per person: `sam=river-42, jo=blue-moon`. Delete an entry to cut that person off. Counts and logs use the name, never the code. | off (open) |
| `HUM_ACCESS_CODE` | One shared code (counted as "shared") | off |
| `HUM_DAILY_BUDGET` | Dollars per day for everyone together | 5 |
| `HUM_CODE_DAILY_BUDGET` | Dollars per day per code | 1 |
| `HUM_RATE_LIMIT` | Requests per visitor (IP) per hour | 20 |
| `HUM_TIMEZONE` | When the day resets (e.g. `America/Los_Angeles`) | UTC |
| `UPSTASH_REDIS_REST_URL` + `_TOKEN` (or `KV_REST_API_URL` + `_TOKEN`) | Keeps the counts in Upstash Redis so they hold across every Vercel instance | memory |

Spend is counted from each response's real token usage at the model's price. A request is refused
once today's total has reached the cap, so a cap can go over by at most the calls already running
(about $0.03 each for Make a video). Refused requests fall back to the offline director. If Redis
can't be reached, the counts drop to memory for that request instead of failing. Each call is logged
as `[hum-director] plan on claude-sonnet-5-5 for sam: $0.0213 (today $0.53) · …tokens…` in the
function logs. Your Claude
subscription in `npm run dev` skips the limits and the access codes (it only answers your own computer).

In the app, an AI action that comes back needing a code opens a small box (`src/ui/AccessGate.tsx`,
logic in `src/director/access.ts`): the code is checked with the free `mode: "check"` request (no
Claude call, same rule as a real request), saved, and the action retries. Closing it keeps the offline
result. On a site with no key the box explains how to run Hum yourself instead.

What each action costs (a 12-part song with lyrics; "warm" = the fixed rules were read from the
prompt cache because someone asked within the last 5 minutes):

| Action | Model | Tokens in / out | Cost |
|---|---|---|---|
| Make a video | Sonnet 5.5 | ~9,400 (4,200 cacheable) / ~1,050 | ≈ $0.031 cold, $0.021 warm |
| Make a video again on the same song | — | none (saved in the browser) | $0 |
| Change the video in words (*Video* mode) | Haiku 5.5 | ~4,200 (3,500 cacheable) / ~900 | ≈ $0.001 |
| Describe a feeling → look | Sonnet 5.5 | ~14,400 (13,000 cacheable) / ~800 | ≈ $0.044 cold, $0.011 warm |
| Tweak the look on screen ("warmer") | Haiku 5.5 | ≤ 14,400 / ~800 | ≈ $0.002 |
| A new GLSL scene | Sonnet 5.5 | ~7,000 (mostly cacheable) / up to 16,000 | ≈ $0.05–0.10 |

Which model does what (all optional, `server/models.ts`):

| Setting | Used for | Default |
|---|---|---|
| `HUM_MODEL` | everything below unless set | `claude-sonnet-5-5` |
| `HUM_PLAN_MODEL` | Make a video | `HUM_MODEL` |
| `HUM_SHADER_MODEL` | New scene | `HUM_MODEL` |
| `HUM_EDIT_MODEL` | small edits: changing a video in words, tweaking the look on screen (`main` = use `HUM_MODEL`) | `claude-haiku-5-5` |
| `HUM_CLI_MODEL` / `HUM_CLI_EDIT_MODEL` | the same split for your subscription in `npm run dev` | `sonnet` / `haiku` |

`HUM_MODEL=claude-haiku-5-5` makes everything about 20× cheaper, at some cost to the plans. Each
call is logged with its tokens (`… · 5236 in, 4170 from cache, 0 into cache, 1045 out`). Also set a
monthly spend limit for the key in the Anthropic Console as the hard backstop.
