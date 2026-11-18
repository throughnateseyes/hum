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
Claude Messages API (plain fetch)     one tool per mode: make_preset | write_shader
       ▼
{ preset | shader, note, source: 'claude' }
       ▼
validatePreset / validateShader       clamp numbers to ranges, drop unknown ids, fix hex colours,
                                      remap fx indices, cap counts, strip header redeclarations
```

- **Preset mode.** The system prompt is an art-director persona. It covers how music maps to visuals and what each layer means (sub is the low end you feel, kick/snare/hat are hit envelopes, energy/build/drop shape whole sections), plus the house taste and the catalog. Claude answers through the `make_preset` tool.
- **Shader mode.** Same persona, plus `SHADER_AUTHORING_GUIDE` (`src/scenes/shader/guide.ts`). Claude answers through `write_shader`. The client returns a `CustomShaderSpec`, which the app compiles with `makeCustomShaderScene(spec)` and registers with `registerScene`. If WebGL fails to compile it, show the error and offer a retry.
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
