# Loading scene code on demand: plan (not done yet)

The library is heading for 300+ looks. All scene code ships up front today: the `scenes` chunk is
921 kB (331 kB gzip) next to a 1,005 kB `index` chunk, and the browser parses all of it before the
first frame. Loading each scene's code when it's first needed would take most of that off the first
load. It wasn't done in the look-families change because it can't land cleanly while other work is
adding scene folders in parallel. It changes the shape of every scene file and makes a synchronous
lookup used in 17 files asynchronous.

## Why it isn't a small change

- **A scene is one object with metadata and code together.** `SceneDef` (`src/core/types.ts`) holds
  `id`, `name`, `style`, `tags`, `params`, `modulations`, `light`, `showsLyrics` and `create()`. The
  library, the Inspector's sliders, the planner, the Director's catalogue and preset application all
  need the metadata straight away, and only drawing needs `create()`. Each file also imports its
  heavy dependencies (three, shader strings, canvas helpers) at the top, so metadata can't be loaded
  without the code.
- **`getScene(id)` is synchronous and used everywhere** (31 calls in 17 files: plan 6, stage 4,
  Inspector 3, sceneWindows 3, Library 2, store 2, and taste, Director, popups, lyricLayer, apply,
  planEdit, App and the dev tools solo, thumbs and lyricAudit). The calls that draw (stage, sceneWindows,
  popups, timeline, solo) expect an instance in the same tick.
- **Several features depend on that.** `src/render/warmup.ts` compiles the next look's shaders ahead of
  the cut. The timeline renderer (`src/render/timeline.ts`) needs every scene of the stretch ready
  before frame 0 so renders stay deterministic. Scene windows build other looks at their own size
  mid-song. `/solo.html` and `scripts/look-shot.mjs` load a scene by id.

## Plan

1. **Split metadata from code, one folder at a time.** Each `src/scenes/<folder>/index.ts` exports
   `meta: SceneMeta[]` (everything but `create`) plus `load = () => import('./code')`, which returns
   `{ [id]: create }`. Chunk per folder (8 chunks), not per scene: shader scenes are a few kB each,
   and per-scene chunks would mean hundreds of requests. A small codemod can do the split, since
   `create` is always the last property.
2. **Two-step registry** (`src/scenes/index.ts`):
   - `getSceneMeta(id)` stays synchronous and is what the UI, planner, Director and presets use.
   - `loadScene(id): Promise<SceneDef>` caches per folder.
   - `getScene(id)` keeps working for scenes that are already loaded, and runtime-registered
     (AI-written) scenes are always loaded.
3. **Load ahead in the places that already look ahead:**
   - The plan sequencer calls `loadScene` for the next part's looks wherever `warmup.ts` queues their
     shaders today.
   - `stage.setScene` awaits the load and keeps showing the outgoing look until then. Transitions
     already blend from a live outgoing look, so a slow first load shows up as a longer hold, not a
     black frame.
   - Timeline renders await every scene in the stretch before the 3 s pre-roll. Determinism is
     unchanged because no frame is drawn before everything is loaded.
   - Scene windows and pop-ups load their looks when the plan places them, and skip a window whose
     look isn't ready yet.
   - Solo and look-shot await `loadScene` before the first frame.
4. **Check it:**
   - `npm run build` sizes before and after.
   - `look-shot` sheets for one scene per folder, compared pixel for pixel.
   - A 4:5 render of the same stretch before and after, with frame hashes equal.
   - Playback across a cut into a folder that hasn't loaded yet, with throttled network.

Expected result, not measured: most of the 921 kB `scenes` chunk leaves the first load (three.js
itself stays in `index`), and the first use of each folder costs a fetch of tens to a few hundred
kB, hidden by loading ahead. Best done in a quiet window, when no other branch is adding scenes, so
the codemod runs over every folder at once.
