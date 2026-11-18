# Hum — build brief (shared by all contributors)

Hum is a browser-based **audio-reactive visual playground**: drop in a song, it splits the sound into
"layers" (sub, bass, mids, air, kick/snare/hat hits, energy, build, drop…), and those layers drive
scenes (3D forms, shader fields, photo treatments, instrument-board layouts) plus a stack of
post effects (dither, halftone, ASCII, grain…). An AI "director" (Claude) can generate presets and
even brand-new GLSL scenes from a mood prompt.

## Stack
- Vite 8 + React 19 + TypeScript 7 (`tsgo`) + three r187 + zustand. WebGL2.
- **Color management is OFF app-wide** (`THREE.ColorManagement.enabled = false`, output pass-through).
  Hex colors go into shaders as-is. Textures should use `THREE.NoColorSpace`.
- No new npm dependencies.
- Typecheck: `npx tsc -p tsconfig.app.json --noEmit`. Other people are writing other folders at the
  same time — only fix errors in files you own. `noUnusedLocals` is on.
- Don't start the dev server or use a browser; integration and visual QA happen centrally.

## Read first
- `src/core/types.ts` — every contract (AudioFrame, SceneDef, EffectDef, Preset, …)
- `src/core/glsl.ts` — the shader header + common GLSL library (names you must not redefine)
- `src/core/uniforms.ts` — uniform helpers, `num/str/bool` param readers
- `src/core/sceneHelpers.ts` — `defineShaderScene`, `defineCanvasScene`, `defineThreeScene`, quad + RT utils
- `src/core/palettes.ts` — palettes and layer metadata

Don't edit `src/core/*`. If you need a core change, describe it in your final report.

## Visual DNA (from the reference reels)
1. **Off-white instrument boards.** Cream / paper backgrounds (#f2f0ea, #ece8d6), hairline 1px
   borders, tiny uppercase monospace labels, panels in a grid: spectrograms, stacked band waveforms,
   piano-roll dashes, radial meters with a beat number, Tetris blocks falling on each kick, topographic
   contour lines, voronoi cells, step-sequencer pads, glowing knob meters. Accents: ultramarine
   (#2f4bff), soft periwinkle, violet, a hit of orange.
2. **Photo treatments.** Blocky datamosh dissolve that reveals the next photo; posterized
   voronoi/mosaic in blue duotone; a portrait rebuilt as a glowing point cloud with horizontal slices
   displaced on hits.
3. **Flowing fields.** Thousands of hairline flow strokes like combed hair (blue on cream);
   domain-warped liquid marble (ultramarine + gold); monochrome slit-scan smears (TouchDesigner feel).

Quality bar: tasteful, editorial, minimal — not rainbow "winamp". It should look good **paused/silent**
(gentle idle motion from time / `sway`), and you should **feel every hit** when music plays:
- continuous bands (`sub`, `bass`, `mid`, `air`) → size, displacement, density, speed
- hit envelopes (`kick`, `snare`, `hat`, and the one-frame `kickHit/snareHit/hatHit/beat` flags) → impulses, flashes, spawns
- macro (`energy`, `build`, `drop`) → section-level changes: calm in the verse, chaos on the drop
- `brightness` → colour temperature / sharpness; `beatPhase`, `sway` → tempo-locked motion
Make motion springy/smoothed rather than jittery. Palette-driven: use `frame.palette` (or the
`uBg/uFg/uAccent/uAccent2/uMuted` uniforms) so every scene re-skins with the palette picker. Scenes
marked `light: true` are designed for off-white palettes but must still work on dark ones.

## Params & modulation
Every scene/effect exposes 4–10 params with good defaults (`ParamDef`). Users can route any audio
layer to any number param in the modulation matrix; scenes may suggest default routings via
`modulations: ModulationSeed[]`. Params arrive in `frame.params` already modulated — read them every
frame with `num(frame.params, 'id', default)`. Keep built-in reactivity too (a scene with zero
routings should still dance).

## Performance
60 fps at 1080p on an M-series MacBook. Render targets are device-pixel sized (DPR capped at 2).
Prefer GPU work (vertex/fragment shaders, instancing) over per-frame JS loops over big arrays.
Dispose everything you create in `dispose()`.
