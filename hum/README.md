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
  a part (hold ⌥ to change only that one), or pick a look while a part plays. Picking a scene
  pauses the song map.
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
  show in the Scene tab).
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
AudioFrame → modulation matrix (src/state/modulation.ts) → resolved params
  → SceneInstance.render → render target   (src/scenes/{board,three,shader,photo})
  → FxChain (src/render/fxChain.ts)        stackable GLSL passes (src/fx/defs)
  → transition (src/render/transitions.ts) blends the outgoing look (still playing) into the new one;
                                           picked by src/state/transitionPick.ts
  → impact, pop-ups, lyrics, hand-drawn     (src/render/stage.ts, popups.ts, lyricLayer.ts, handPass.ts)
  → screen / MediaRecorder
```

- `src/core/` — the contracts (`types.ts`), the shared GLSL header + function library (`glsl.ts`),
  and helpers to define scenes (`defineShaderScene`, `defineCanvasScene`, `defineThreeScene`).
- **Adding a scene:** write a `SceneDef` with params and drop it in one of the `src/scenes/*/index.ts`
  arrays. A shader scene is only a `void main()` — see `src/scenes/shader/guide.ts` (this is also the
  guide the AI reads).
- **Adding an effect:** an `EffectDef` with a fragment shader in `src/fx/defs/`.
- **Adding a look:** an entry in `src/presets/library.ts`. Tags matter — the analyser matches on them.

Colour management is off on purpose: palette hex values go into shaders untouched.

## Deploying (e.g. on your site)

It's a static Vite app plus one serverless function (`api/director.ts`, Web-standard `POST`).
On Vercel: import the folder, set `ANTHROPIC_API_KEY`, optionally `HUM_RATE_LIMIT` (per IP per hour,
default 20) and `HUM_ACCESS_CODE`. Without a key the site still works with the offline director.
