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
- **Looks** (left) are presets. After a track is analysed they're ranked for it ("fits").
- **Scenes** (left) are the raw visual engines; **Inspector** (right) has the scene's sliders, the
  **Effects** stack, **Routing** (the modulation matrix) and **Look** (palette, lyric text, frame
  aspect for 9:16 reels / 4:5 / 1:1, quality, auto-pilot, save look).
- **Drag a layer meter** from the bottom strip onto any slider to make it react to that layer. The
  blue tick on a slider shows its live, modulated value.
- **Director** (bottom of the stage): describe a feeling → a look; switch to *Shader* → Claude writes
  a new GLSL scene that's compiled live (errors show in the Scene tab).
- **Record** captures video + audio (MP4 where supported, else WebM). The camera icon saves a PNG.
- Keys: `space` play/pause · `←/→` previous/next look · `R` shuffle · `F` perform mode · `esc` exit.

## How it's built

```
audio file / mic
  → AudioEngine (src/audio/engine.ts)      real-time: 6 bands, onset envelopes, beat phase, energy, build, drop
  → analyzeTrack (src/audio/analysis*.ts)  offline worker: bpm, sections, drops, mood, tags, preset ranking
AudioFrame → modulation matrix (src/state/modulation.ts) → resolved params
  → SceneInstance.render → render target   (src/scenes/{board,three,shader,photo})
  → FxChain (src/render/fxChain.ts)        stackable GLSL passes (src/fx/defs)
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
