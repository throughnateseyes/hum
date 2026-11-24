# AI director

You type a mood ("sad rain on a lonely night", "make it heavier") and get back a full preset (scene, effect chain, audio modulations and palette) or a brand-new GLSL scene.

## How it works

```
UI → direct(req)                      src/director/client.ts
       │  + buildCatalog()            src/director/catalog.ts  (scenes/effects/params/palettes/layers from the live registries)
       ▼
POST /api/director                    server/vitePlugin.ts (dev) · api/director.ts (Vercel)
       ▼
handleDirector(body, ip)              server/director.ts
       │  access code → rate limit → caps (prompt ≤ 600 chars, catalog ≤ 20 kB)
       ▼
Claude Messages API (plain fetch)     one tool per mode: make_preset | write_shader | plan_video
       ▼
{ preset | shader, note, source: 'claude' }
       ▼
validatePreset / validateShader       clamp numbers to ranges, drop unknown ids, fix hex colours,
                                      remap fx indices, cap counts, strip header redeclarations
```

- **Preset mode.** The system prompt is an art-director persona. It covers how music maps to visuals and what each layer means (sub is the low end you feel, kick/snare/hat are hit envelopes, energy/build/drop shape whole sections), plus the house taste and the catalog. Claude answers through the `make_preset` tool.
- **Shader mode.** Same persona, plus `SHADER_AUTHORING_GUIDE` (`src/scenes/shader/guide.ts`). Claude answers through `write_shader`. The client returns a `CustomShaderSpec`, which the app compiles with `makeCustomShaderScene(spec)` and registers with `registerScene`. If WebGL fails to compile it, show the error and offer a retry.
- **Plan mode.** For *Make a video*. The request carries the song's sections (label, group, time, energy) and the looks to choose from; a short director-of-music-videos prompt asks for one look per section through `plan_video` (same group → same look, contrast between verse and chorus, the strongest look on drops). `requestPlan()` keeps only known look ids, and `makeVideo()` (`src/state/plan.ts`) fills any gaps from the offline `localPlan()`, which is also used when Claude isn't reachable.
- **Structured output.** The current models (Sonnet 5.5, Opus 5.5) reject forced `tool_choice`. So the request offers exactly one tool with `tool_choice: auto` and tells Claude to call it. If no call comes back, the server asks once more.
- **Refusals.** With `claude-sonnet-5-5`, `claude-opus-5-5` and `claude-fable-5-x`, the server sends `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta. A safety decline is then retried on a fallback model inside the same call.
- **Offline fallback.** `direct()` never throws for server trouble. It switches to `localDirect()` (keyword and mood heuristics, seeded from the prompt) on 501 (no key), 429 (rate limit), 403 (access code), network errors or output that fails validation. The reason goes at the start of `note`, and the response has `source: 'local'`. In offline shader mode, a built-in GLSL template is adapted to the prompt.

```ts
import { direct } from './director/client';
const res = await direct({ prompt, mode: 'preset', track, current }, { accessCode });
if (res.preset) applyPreset(res.preset);
if (res.shader) registerScene(makeCustomShaderScene(res.shader));
toast(res.note);
```

## Environment

| Var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | The API backend (needed for a deployed site). In dev, with no key, the director uses your Claude subscription through the `claude` CLI instead. |
| `HUM_DIRECTOR` | auto | `cli` forces the subscription backend in dev, `api` forces the API key. Auto uses the key when there is one, otherwise the CLI. |
| `HUM_CLI_MODEL` | `sonnet` | Model for the CLI backend (`sonnet`, `opus`, `fable`, or a full id). |
| `HUM_CLAUDE_BIN` | found automatically | Path to the `claude` binary if it isn't on PATH or in `~/.local/bin`. |
| `HUM_MODEL` | `claude-sonnet-5-5` | Model id. |
| `HUM_RATE_LIMIT` | `20` | Requests per IP per hour. `0` turns the limit off. |
| `HUM_ACCESS_CODE` | — | If set, a request must send a matching `accessCode`. |
| `HUM_EFFORT` | low (preset) / medium (shader) | Effort level, for models that support it. |
| `HUM_TIMEOUT_MS` | `120000` | Timeout for the call to Claude. |
| `HUM_ALLOWED_ORIGIN` | — | CORS origins for `api/director.ts` (comma-separated, or `*`). |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Optional proxy or gateway. |

These variables are read on the server only. Never prefix them with `VITE_`, or Vite ships them to the browser.

## Local dev on your Claude subscription (no API key)

If Claude Code (`claude`) is installed and signed in on this machine, you don't need a key. Run
`npm run dev`: the terminal prints `hum director → your Claude subscription (claude CLI)` and the
Director's notes say **✦ Claude (your plan)**.

Under the hood, `server/cliDirector.ts` runs `claude -p --json-schema …` for each request. It runs
with no tools, no MCP servers and `--safe-mode`, so your own CLAUDE.md and plugins stay out of the
prompt, and with the API key removed from its environment so it bills your plan. Each call counts
toward your plan's usage limits. A look takes about 8–15 s and a shader about 20–40 s.

This backend only exists on the dev server. A subscription is for your own use, so the deployed
Vercel function never uses it: put an API key on the site for visitors.

If you see "the claude CLI isn't signed in", run `claude` once in Terminal and sign in.

## Local dev with an API key

1. `cp .env.example .env.local` and fill in `ANTHROPIC_API_KEY`.
2. Add the plugin in `vite.config.ts`: `plugins: [react(), directorDevPlugin()]` (`import { directorDevPlugin } from './server/vitePlugin'`).
3. Run `npm run dev`. The plugin reads env through `loadEnv`, so `.env.local` works.

## Putting it on your website (Vercel)

1. Deploy the repo to Vercel. The static Vite build is served from `dist/`, and `api/director.ts` becomes the function at `/api/director` (Web `POST(request)` signature, Node runtime).
2. In Project → Settings → Environment Variables, set `ANTHROPIC_API_KEY`, plus `HUM_RATE_LIMIT` and, if you like, `HUM_ACCESS_CODE`.
3. Optional: give the function more time for shader requests:
   ```json
   { "functions": { "api/director.ts": { "maxDuration": 60 } } }
   ```
4. If you embed Hum in an iframe on another domain, it still calls its own `/api/director`, so no CORS setup is needed. Set `HUM_ALLOWED_ORIGIN` only when a page on a different origin calls the API directly.

### Keeping costs bounded

- **Per-IP limit.** `HUM_RATE_LIMIT` is an in-memory sliding window. On serverless it applies per warm instance, so treat it as a soft limit. For a hard cap, add a Vercel Firewall rate-limit rule on `/api/director`, or swap the `Map` in `server/director.ts` for Upstash or Vercel KV.
- **Access code.** Set `HUM_ACCESS_CODE` for private demos. The UI should ask for the code and pass it as `direct(req, { accessCode })`. Don't bake the code into the bundle.
- **Input caps.** The server cuts prompts to 600 characters, the catalog to 20 kB and request bodies to 64 kB. Output is capped at 8k tokens for presets and 16k for shaders.
- **Spend limit.** Set a monthly spend limit on the API key in the Anthropic Console as a backstop.

## The feeling step

A video made from the person's footage first asks one more small question (`server/steps/feel.ts`, main model, low effort), at the same time as the footage is watched: the song's distinct lyric lines go up, and each comes back with an emotion, a tone from dark to bright, a weight, the place of the word that carries it, and whether the song turns there. The answer is kept in the browser by the words alone (`src/director/feeling.ts`), so a remake or a re-timed lyric asks nothing.

`src/feeling` puts it against the clock with the sound (key, brightness, harmonic tension, never tempo) and finds the wind-up to every landing. From there it decides the moments when Claude doesn't, is told to the story and shots steps in a few words per section and part, keeps a soft line that matters on one picture, cuts closer into a big landing, and bends each shot's speed and camera (`bend` and `lean`). A plan keeps the feeling it was made with; plans made before it have none and play as they did.

## The mix

`Your footage` (`src/director/mix.ts`) is told to the story and plan steps, and then enforced by code: `dealMix` takes the sections a planner gave to footage and moves as few as it must to keep footage inside its share of the time.

## Drawings in the scene

After the shots are chosen and their depth is read, `roomFor` (`footageStills.ts`) works out which places each Inside shot has for a drawing with its words standing round it, and the biggest size each holds. Shots with none aren't offered. While the stills of the cut are drawn, `art` (`server/steps/art.ts`, main model, medium effort, needs drawing access) gets the story, the feeling, the cut with what each part shows, the colours and the drawings the song already has. It answers with one thread, two or three rules, one hand, up to three recurring things (each with a start and, where the song changes it, an end) and the parts each stands in. At most five drawings, four of them new. `src/director/footageArt.ts` checks it, names the missing drawings before they exist, and writes `drawn` into the cues, so the placements travel with the parts like everything else (a person's own choice lies over them, `null` meaning none here).

The video goes on at once. The missing drawings are made by the usual jobs under those ids and join it as they finish. Where one stands is found by `src/inside/drawn.ts` against the depth maps: on the ground, between two layers, far off, or on a wall. What faces the camera must have its foot hidden by something nearer or stand on the ground, must be mostly seen over the whole shot, and the words are laid out round it (`InsideShot.arrange`): they must still be read about as well as without it. A smaller size is tried before another place, another place before none, and there is a least size. If nowhere will do there is none, and the list says so (`src/inside/seated.ts`).

Lines along the clip's own edges cost no call. `measure.worker.ts` finds them on every second depth sample (up to 220 a frame), `linesOver` follows up to 130 through the seconds a shot plays, and `recipes.ts` gives each moment its acts. A long shot changes act every two bars. `INSIDE[moment].acts` empty means none (hush).

When all are in, `artReview` sees one still per placement and moves, takes out or has redrawn (two at most) whatever looks stuck on: one round, only on the video it was made for, never in a part on screen.

