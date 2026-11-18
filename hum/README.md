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
- **Song map** (under the timeline): the song's parts (intro, verse, chorus, bridge, build, drop,
  break, outro). Parts that sound alike share a colour, so a returning chorus is easy to spot.
  **Make a video** asks Claude to give every part a look (offline plan if Claude isn't reachable) and
  plays the song from the top. While **Follow** is on, looks change at each part: dissolves into
  calm parts, hard cuts on drops and choruses. To edit, drag a look onto a part (hold ⌥ to change
  only that one), or pick a look while a part plays. Picking a scene pauses the song map.
- **Lyrics** are found on their own. Hum reads the song's title and artist from the file's tags
  (or its name, like `Artist - Title.mp3`; music-video rips work too, with "(Official Video)",
  "[Lyrics]", "feat. …" and the like ignored), then gets timed lyrics from
  [LRCLIB](https://lrclib.net), a free lyrics library. Lyrics saved inside the file are used first.
  If LRCLIB only has a longer or shorter version (videos add intros and outros), Hum moves the lines
  to where the singing starts in your file. Wrong song or nothing found? **Search LRCLIB** in the
  chip by artist and song, or paste a lrclib.net link.
  Only the title, artist and length are sent, never the audio. The chip beside the track name shows
  what was found. It also switches between **Subtitles**, **Big words** (one line at a time, word by
  word) and **Off**. Lyrics show up in recordings and stills, and the song map's planner reads them
  to fit each part's look to the words. Songs that aren't on LRCLIB (unreleased ones, for example)
  get no lyrics, but you can **paste them** in the chip. Hum then times each line by listening for
  the sung words on this computer (Whisper, about a 95 MB model downloaded once; the audio never
  leaves your machine). If a line is off, **Fix timing** lets you tap along as each line starts, and
  **Shift all lines** moves them all earlier or later. Pasted or fixed lyrics are remembered for that
  song.
- While a new song is being analysed, the Hum mark floats on the stage, breathing with the music.
- **Busy boards and pop-ups.** Four more instrument boards join Orbit, Lab and Oto: **Arcade** (Pong
  with the ball hitting on the beat, a runner that jumps on kicks, Tetris, a BPM odometer, rubber
  stamps on the drop), **Mission** (a terminal log narrating the song — "BAR 017 · KICK .82",
  "DROP IN 4" — with radar, an XY figure, the song map and meters), **Diary** (the sung line on a
  typewriter, a word cloud of everything sung so far, a mood weather report) and **Forecast** (a
  weather station for the song: sun, drizzle, a storm on the drop, the next parts as a forecast).
  **Pop-ups** (Look tab) are little framed windows of these instruments that pop in over whatever is
  playing on new parts, drops and some bars, then snap shut a few bars later, with a sticker slapped
  on at the drop. They're in recordings too. *In videos* (the default) shows them while a video plan
  plays, busier on choruses and drops; *Always* keeps a few coming. The video planner (Claude or
  offline) marks how busy each part's pop-ups get and can open a part with a board look for its
  first four bars.
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
- Keys: `space` play/pause · `←/→` previous/next look · `R` shuffle · `H` hand-drawn · `F` perform mode · `esc` exit.

## How it's built

```
audio file / mic
  → AudioEngine (src/audio/engine.ts)      real-time: 6 bands, onset envelopes, beat phase, energy, build, drop
  → analyzeTrack (src/audio/analysis*.ts)  offline worker: bpm, sections (harmony/timbre self-similarity,
                                           bar-aligned, repeats grouped), drops, mood, tags, preset ranking
  → lyrics (src/audio/tags.ts, lyrics.ts)    file tags / name → embedded LRC or LRCLIB timed lines
  → video plan (src/state/plan.ts)         a look per section; switches looks along the song
AudioFrame → modulation matrix (src/state/modulation.ts) → resolved params
  → SceneInstance.render → render target   (src/scenes/{board,three,shader,photo})
  → FxChain (src/render/fxChain.ts)        stackable GLSL passes (src/fx/defs)
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
