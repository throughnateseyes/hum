/**
 * Hum AI director — framework-free server handler.
 *
 *   handleDirector(body, ip) → { status, json }
 *
 * Calls the Claude Messages API with plain fetch (no SDK) and a single tool per mode
 * (`make_preset` or `write_shader`) so the answer comes back as structured JSON.
 * Used by the Vite dev plugin (server/vitePlugin.ts) and the Vercel function (api/director.ts).
 *
 * Two backends:
 *   - the Messages API, when ANTHROPIC_API_KEY is set (what a deployed site uses)
 *   - a local backend passed in by the dev server (server/cliDirector.ts runs the `claude` CLI, so it
 *     uses your Claude subscription). HUM_DIRECTOR=api|cli forces one; the default prefers the key.
 *
 * Env:
 *   ANTHROPIC_API_KEY   API backend; with no key and no local backend the handler answers 501
 *   HUM_MODEL           default 'claude-sonnet-5-5'
 *   HUM_RATE_LIMIT      requests per IP per hour (default 20; 0 disables)
 *   HUM_ACCESS_CODE     optional shared code the request must send as `accessCode`
 *   HUM_EFFORT          optional effort override (low | medium | high | xhigh | max)
 *   ANTHROPIC_BASE_URL  optional API base URL override
 */
import type { LayerId } from '../src/core/types';
import { SHADER_AUTHORING_GUIDE } from '../src/scenes/shader/guide';

export type DirectorEnv = Record<string, string | undefined>;

export interface DirectorResult {
  status: number;
  json: unknown;
}

/** what a local backend gets: one system prompt, one user prompt, and the JSON schema to answer in */
export interface LocalRequest {
  mode: 'preset' | 'shader' | 'plan';
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  effort: string;
}
export type LocalResult = { ok: true; output: unknown } | { ok: false; status: number; error: string; note: string };
export type LocalBackend = (req: LocalRequest) => Promise<LocalResult>;

export interface DirectorOptions {
  /** a backend that doesn't need an API key (dev server only) */
  local?: LocalBackend | null;
}

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const MAX_PROMPT_CHARS = 600;
export const MAX_CATALOG_BYTES = 20_000;
const MAX_CURRENT_CHARS = 8_000;
const API_VERSION = '2026-10-21';

const LAYER_IDS: LayerId[] = [
  'level',
  'sub',
  'bass',
  'lowMid',
  'mid',
  'highMid',
  'air',
  'kick',
  'snare',
  'hat',
  'energy',
  'brightness',
  'flux',
  'beatPhase',
  'build',
  'drop',
  'sway',
];

/* ───────────────────────── rate limit (in-memory sliding window) ───────────────────────── */

const HOUR = 3_600_000;
const hits = new Map<string, number[]>();

function rateLimit(ip: string, limit: number, now = Date.now()): { ok: true } | { ok: false; retryAfter: number } {
  if (limit <= 0) return { ok: true };
  const list = (hits.get(ip) ?? []).filter((t) => now - t < HOUR);
  if (list.length >= limit) {
    hits.set(ip, list);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((list[0] + HOUR - now) / 1000)) };
  }
  list.push(now);
  hits.set(ip, list);
  // keep memory bounded on long-lived servers
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > HOUR) hits.delete(k);
  }
  return { ok: true };
}

/** constant-time-ish string compare */
function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/* ───────────────────────── prompts ───────────────────────── */

const PERSONA = `You are the art director inside Hum, a browser-based audio-reactive visual playground. People describe a mood, a song, a genre, or a change ("make it heavier"), and you answer with visuals that feel like the music.

## How Hum works
A song is split into layers, all 0..1 (sway is -1..1):
- sub (20–60 Hz): the low end you feel more than hear; the dubstep wobble floor. Slow, heavy motion: scale, pressure, displacement depth.
- bass (60–250 Hz): kick body and bassline. Size, push, warp.
- lowMid / mid / highMid: warmth; vocals and leads; presence and attack. Detail, colour drift, line weight.
- air (6–20 kHz): hats, shimmer, breath. Grain, sparkle, fine density.
- kick / snare / hat: hit envelopes that jump to 1 on a hit and decay. Impulses: flashes, pops, spawns, jolts.
- level: overall loudness.
- energy: slow section intensity over seconds; calm verse vs. full chorus. Overall speed, density, chaos.
- build: rises during build-ups and risers. Tension: tighten, speed up, brighten, gather.
- drop: fires when the drop lands after a build. The big release: glitch, flash, explode, invert.
- brightness: dark/warm vs. bright/harsh timbre; colour temperature and sharpness.
- flux: how fast the sound is changing.
- beatPhase (0→1 each beat) and sway (bar-locked sine): tempo-locked motion.

A preset is one scene + an ordered chain of post effects + modulations + a palette.
- Modulation: { source: <layer>, target: "scene.<paramId>" or "fx.<effectIndex>.<paramId>", amount: -1..1 }. amount is the fraction of the param's range added at full signal; negative moves the other way. Only number params can be modulated. effectIndex is the 0-based position in your effects array.
- Scenes and effects also have built-in reactivity, so modulations are seasoning on top, not the only motion.
- Palette: five hex colours (bg, fg, accent, accent2, muted). Colour management is off, so hex values reach the shaders unchanged. Use a catalog palette verbatim or invent one; keep bg/fg contrast strong. Scenes flagged "light" are designed for off-white backgrounds.

## Taste
- Editorial and minimal, never rainbow "winamp". The house style: off-white instrument boards (cream paper, hairlines, ultramarine #2f4bff, a hit of orange), photo treatments, and flowing fields.
- It should look good paused and you should feel every hit when it plays: continuous bands drive size, displacement and speed; hits drive impulses; energy, build and drop drive section-level change.
- Restraint: usually 0–3 effects and 3–8 modulations with amounts mostly 0.15–0.6. Let one or two layers lead.
- Translate mood to visuals. Sad, rain or lonely: slow fields, cool muted palettes, grain. Heavy bass or dubstep: sub drives scale and pressure, drop drives glitch and flash. Dreamy: liquid forms, bloom, soft palettes. Lo-fi: warm paper, dither. Photos: the photo scenes.
- When a track analysis is given, honour its tempo, mood and structure (a track with several drops deserves strong build and drop mappings; a sparse ambient one deserves slow sway and energy).
- For edits ("more X", "less Y", "add Z") start from the current preset and change only what was asked.`;

const PRESET_RULES = `## Rules
- Use only scene ids, effect ids, param ids, palette ids and layer ids that appear in the catalog. Respect each param's type and range; select params take one of the listed option values.
- Only include sceneParams you want to change from their defaults.
- Answer by calling the make_preset tool exactly once. name: at most 4 words. description: one sentence. note: one or two plain sentences on the creative choice, addressed to the user.`;

const SHADER_RULES = `## Writing a new scene
You write a brand-new fragment shader that becomes a live scene. Follow the authoring guide below exactly.
- Write only the shader body: helper functions plus void main() writing gl_FragColor. The shared header (audio, palette and time uniforms, vUv, the common function library) and one uniform per param (u_<paramId>) are injected for you: never redeclare them or the library functions.
- Declare 3–8 params with good defaults; reference them as u_<id>. Use the palette uniforms so the scene re-skins with the palette picker. Give it gentle idle motion (uTime, uSway) so it is alive in silence, and make the hits land (uKick, uSnare, uDrop).
- Keep it fast: constant loop bounds (≤ 64 iterations), no huge fbm octave counts, 60 fps at 1080p.
- Suggest 2–5 modulations (source layer → one of your number params).
- Answer by calling the write_shader tool exactly once. note: one or two plain sentences on the idea, addressed to the user.`;

const PLAN_SYSTEM = `You are the director of music videos inside Hum, a browser-based audio-reactive visual playground. A song has been split into sections (intro, verse, chorus, bridge, build, drop, break, outro). Sections that sound alike share a group letter. You choose one look for each section from the list of looks, so the visuals follow the song's story.

Every look already reacts to the music on its own (kicks, bass, builds and drops), so your job is the arc: which picture belongs to which part of the song.

## How to direct
- Repetition is structure. Sections in the same group should usually share a look, so a returning chorus returns to its look. You may escalate the final chorus or the last drop to a stronger look on purpose.
- Contrast between parts. Verses and choruses should look clearly different; drops should be the most intense look in the plan; intros, breaks and outros calm and spacious.
- Builds usually keep the look of the section before them (the tension is added automatically) or move to something tighter; the drop is the release.
- Use 2 to 5 different looks for the whole song. Fewer, stronger choices beat a slideshow.
- Honour the track's mood and genre: a sad piano song should never get a rave look; a dubstep track deserves heavy, glitchy drops.
- If the person adds a wish (for example "keep it dreamy" or "use the photo looks"), follow it.
- Use only look ids from the list.

## Answer
Return the plan by calling the plan_video tool exactly once. title: a name for the video, at most 5 words. note: one or two plain sentences to the person about the idea. sections: one entry per section index, each with the lookId and a short reason (at most 12 words).`;

/* ───────────────────────── tools ───────────────────────── */

const hex = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const layerEnum = { type: 'string', enum: LAYER_IDS };
const paramValue = { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'boolean' }] };

const MAKE_PRESET_TOOL = {
  name: 'make_preset',
  description: 'Return the Hum preset you designed: one scene, an ordered effect chain, audio modulations and a palette.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short evocative title, at most 4 words.' },
      description: { type: 'string', description: 'One sentence describing the look.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Mood / genre words, lowercase.' },
      sceneId: { type: 'string', description: 'A scene id from the catalog.' },
      sceneParams: {
        type: 'object',
        description: 'Scene param overrides keyed by param id (only those that differ from the defaults).',
        additionalProperties: paramValue,
      },
      effects: {
        type: 'array',
        maxItems: 5,
        description: 'Post effects in chain order.',
        items: {
          type: 'object',
          properties: {
            effectId: { type: 'string', description: 'An effect id from the catalog.' },
            params: { type: 'object', additionalProperties: paramValue },
            enabled: { type: 'boolean' },
          },
          required: ['effectId'],
        },
      },
      modulations: {
        type: 'array',
        maxItems: 12,
        items: {
          type: 'object',
          properties: {
            source: layerEnum,
            target: { type: 'string', description: '"scene.<paramId>" or "fx.<effectIndex>.<paramId>" (number params only).' },
            amount: { type: 'number', minimum: -1, maximum: 1 },
          },
          required: ['source', 'target', 'amount'],
        },
      },
      palette: {
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: 'string' }, bg: hex, fg: hex, accent: hex, accent2: hex, muted: hex },
        required: ['id', 'name', 'bg', 'fg', 'accent', 'accent2', 'muted'],
      },
      note: { type: 'string', description: 'One or two sentences to the user explaining the creative choice.' },
    },
    required: ['name', 'description', 'tags', 'sceneId', 'effects', 'modulations', 'palette', 'note'],
  },
};

const WRITE_SHADER_TOOL = {
  name: 'write_shader',
  description: 'Return a brand-new GLSL fragment shader scene for Hum, with its params and suggested audio modulations.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short title, at most 4 words.' },
      description: { type: 'string', description: 'One sentence describing the scene.' },
      fragment: {
        type: 'string',
        description: 'GLSL ES 1.0 fragment shader body (helpers + void main() writing gl_FragColor). No header uniforms, no u_<param> declarations.',
      },
      params: {
        type: 'array',
        maxItems: 10,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'camelCase id; the shader reads it as u_<id>.' },
            label: { type: 'string' },
            type: { type: 'string', enum: ['number', 'color', 'bool'] },
            min: { type: 'number' },
            max: { type: 'number' },
            step: { type: 'number' },
            default: paramValue,
            group: { type: 'string' },
          },
          required: ['id', 'label', 'type', 'default'],
        },
      },
      modulations: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          properties: {
            source: layerEnum,
            param: { type: 'string', description: 'id of one of your number params' },
            amount: { type: 'number', minimum: -1, maximum: 1 },
          },
          required: ['source', 'param', 'amount'],
        },
      },
      note: { type: 'string', description: 'One or two sentences to the user explaining the idea.' },
    },
    required: ['name', 'description', 'fragment', 'params', 'modulations', 'note'],
  },
};

const PLAN_TOOL = {
  name: 'plan_video',
  description: 'Return the video plan: one look per song section.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Name for the video, at most 5 words.' },
      note: { type: 'string', description: 'One or two sentences to the person explaining the idea.' },
      sections: {
        type: 'array',
        maxItems: 40,
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', description: 'Section index from the list.' },
            lookId: { type: 'string', description: 'A look id from the list.' },
            why: { type: 'string', description: 'Short reason, at most 12 words.' },
          },
          required: ['index', 'lookId', 'why'],
        },
      },
    },
    required: ['title', 'note', 'sections'],
  },
};

/* ───────────────────────── request parsing ───────────────────────── */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const byteLength = (s: string) => new TextEncoder().encode(s).length;

function capBytes(s: string, max: number): string {
  if (byteLength(s) <= max) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (byteLength(s.slice(0, mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}

function describeTrack(track: unknown): string {
  if (!isObj(track)) return '';
  const lines: string[] = [];
  if (typeof track.summary === 'string') lines.push(track.summary.slice(0, 1200));
  if (typeof track.bpm === 'number' && Number.isFinite(track.bpm)) lines.push(`BPM: ${Math.round(track.bpm)}`);
  if (isObj(track.mood)) {
    const m = Object.entries(track.mood)
      .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
      .slice(0, 8)
      .map(([k, v]) => `${k.slice(0, 16)} ${(v as number).toFixed(2)}`);
    if (m.length) lines.push(`Mood (0..1): ${m.join(', ')}`);
  }
  if (Array.isArray(track.tags)) {
    const tags = track.tags.filter((t): t is string => typeof t === 'string').slice(0, 14).map((t) => t.slice(0, 24));
    if (tags.length) lines.push(`Tags: ${tags.join(', ')}`);
  }
  return lines.join('\n');
}

const fmtT = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/** sections: [{ index, label, group, start, end, energy }] → one line each */
function describeSections(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  return raw
    .slice(0, 40)
    .filter(isObj)
    .map((x, i) => {
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      const label = typeof x.label === 'string' ? x.label.slice(0, 12) : 'section';
      const group = String.fromCharCode(65 + (Math.max(0, Math.floor(num(x.group))) % 26));
      return `#${i}  ${fmtT(num(x.start))}–${fmtT(num(x.end))}  ${label}  group ${group}  energy ${num(x.energy).toFixed(2)}`;
    })
    .join('\n');
}

/** looks: [{ id, name, description, tags, category }] → one line each */
function describeLooks(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  const lines = raw
    .slice(0, 80)
    .filter(isObj)
    .map((x) => {
      const s = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').slice(0, n) : '');
      const tags = Array.isArray(x.tags) ? x.tags.filter((t): t is string => typeof t === 'string').slice(0, 8).join(', ') : '';
      return `${s(x.id, 48)} — ${s(x.name, 40)} [${s(x.category, 12)}] ${tags ? `(${tags}) ` : ''}${s(x.description, 140)}`;
    });
  return capBytes(lines.join('\n'), 14_000);
}

function describeCurrent(current: unknown): string {
  if (!isObj(current)) return '';
  const json = JSON.stringify(current);
  return json.length <= MAX_CURRENT_CHARS ? json : '';
}

/* ───────────────────────── Claude call ───────────────────────── */

interface ContentBlock {
  type: string;
  name?: string;
  input?: unknown;
  text?: string;
}
interface MessagesResponse {
  content?: ContentBlock[];
  stop_reason?: string;
  error?: { type?: string; message?: string };
}

/** models that accept the server-side `fallbacks` parameter */
const FALLBACK_MODELS = /^claude-(fable-5-[12]|opus-5(-5)?|sonnet-5-5)$/;
/** models that accept output_config.effort */
const EFFORT_MODELS = /^claude-(opus-(4-[5-9]|5)|sonnet-(4-6|5)|fable|mythos|haiku-5)/;

async function callClaude(env: DirectorEnv, payload: Record<string, unknown>, model: string): Promise<{ status: number; data: MessagesResponse }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': env.ANTHROPIC_API_KEY ?? '',
    'anthropic-version': API_VERSION,
  };
  const body: Record<string, unknown> = { ...payload, model };
  if (FALLBACK_MODELS.test(model)) {
    // On a safety decline the API re-runs the request on a fallback model inside the same call.
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }
  const base = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(env.HUM_TIMEOUT_MS) || 120_000),
  });
  let data: MessagesResponse = {};
  try {
    data = (await res.json()) as MessagesResponse;
  } catch {
    data = {};
  }
  return { status: res.status, data };
}

function upstreamError(status: number, data: MessagesResponse): DirectorResult {
  const msg = (data.error?.message ?? '').slice(0, 200);
  if (status === 429) return { status: 429, json: { error: 'upstream_rate_limited', note: 'Claude is busy right now (rate limited).' } };
  if (status === 401 || status === 403) return { status: 502, json: { error: 'upstream_auth', note: 'The server’s Anthropic API key was rejected.' } };
  if (status === 529 || status >= 500) return { status: 503, json: { error: 'upstream_unavailable', note: 'Claude is temporarily unavailable.' } };
  return { status: 502, json: { error: 'upstream_error', note: `Claude API error ${status}${msg ? `: ${msg}` : ''}` } };
}

/* ───────────────────────── handler ───────────────────────── */

export async function handleDirector(body: unknown, ip: string, env: DirectorEnv = process.env, opts: DirectorOptions = {}): Promise<DirectorResult> {
  const key = env.ANTHROPIC_API_KEY?.trim();
  const pick = env.HUM_DIRECTOR?.trim().toLowerCase();
  const useLocal = !!opts.local && (pick === 'cli' || (pick !== 'api' && !key));
  if (!key && !useLocal) return { status: 501, json: { error: 'no_key', note: 'No ANTHROPIC_API_KEY is configured on the server.' } };

  if (!isObj(body)) return { status: 400, json: { error: 'bad_request', note: 'Expected a JSON object.' } };
  const mode = body.mode === 'shader' ? 'shader' : body.mode === 'preset' ? 'preset' : body.mode === 'plan' ? 'plan' : null;
  const promptRaw = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!mode) return { status: 400, json: { error: 'bad_request', note: 'mode must be "preset", "shader" or "plan".' } };
  if (mode === 'plan' && (!Array.isArray(body.sections) || !body.sections.length || !Array.isArray(body.looks))) {
    return { status: 400, json: { error: 'bad_request', note: 'A plan needs the song’s sections and the looks to choose from.' } };
  }
  if (!promptRaw && !body.current && !body.track) return { status: 400, json: { error: 'bad_request', note: 'Empty prompt.' } };

  const code = env.HUM_ACCESS_CODE?.trim();
  if (code) {
    const sent = typeof body.accessCode === 'string' ? body.accessCode.trim() : '';
    if (!safeEqual(sent, code)) return { status: 403, json: { error: 'access_code', note: 'A valid access code is required.' } };
  }

  const limitEnv = env.HUM_RATE_LIMIT?.trim();
  const limit = limitEnv !== undefined && limitEnv !== '' && Number.isFinite(Number(limitEnv)) ? Math.floor(Number(limitEnv)) : 20;
  // the local backend is just you on your own machine, so it skips the visitor rate limit
  const rl = useLocal ? ({ ok: true } as const) : rateLimit(ip || 'unknown', limit);
  if (!rl.ok) {
    const mins = Math.ceil(rl.retryAfter / 60);
    return { status: 429, json: { error: 'rate_limited', retryAfter: rl.retryAfter, note: `Hourly AI limit reached — try again in about ${mins} min.` } };
  }

  const prompt = promptRaw.slice(0, MAX_PROMPT_CHARS);
  const catalog = typeof body.catalog === 'string' ? capBytes(body.catalog, MAX_CATALOG_BYTES) : '';
  const track = describeTrack(body.track);
  const current = describeCurrent(body.current);

  const system: Record<string, unknown>[] =
    mode === 'plan'
      ? [{ type: 'text', text: PLAN_SYSTEM }]
      : mode === 'preset'
      ? [
          { type: 'text', text: `${PERSONA}\n\n${PRESET_RULES}` },
          { type: 'text', text: `## Catalog\n${catalog || '(catalog missing — use common sense ids sparingly)'}`, cache_control: { type: 'ephemeral' } },
        ]
      : [{ type: 'text', text: `${PERSONA}\n\n${SHADER_RULES}\n\n## Shader authoring guide\n${SHADER_AUTHORING_GUIDE}`, cache_control: { type: 'ephemeral' } }];

  const parts =
    mode === 'plan'
      ? [`Wish: ${prompt || '(none — direct it from the music)'}`]
      : [`Request: ${prompt || '(no words — design from the track)'}`];
  if (track) parts.push(`Track analysis:\n${track}`);
  if (mode === 'plan') {
    parts.push(`Sections (index, time, label, group, energy 0..1):\n${describeSections(body.sections)}`);
    parts.push(`Looks (id — name [kind] (tags) description):\n${describeLooks(body.looks)}`);
  } else if (current) parts.push(`Current preset (edit from this when the request asks for a change):\n${current}`);
  const tool = mode === 'plan' ? PLAN_TOOL : mode === 'preset' ? MAKE_PRESET_TOOL : WRITE_SHADER_TOOL;
  const model = env.HUM_MODEL?.trim() || DEFAULT_MODEL;
  const effort = env.HUM_EFFORT?.trim() || (mode === 'shader' ? 'medium' : 'low');

  if (useLocal && opts.local) {
    parts.push(`Answer with the structured output: ${tool.description}`);
    const r = await opts.local({
      mode,
      system: system.map((b) => String(b.text)).join('\n\n').replace(/calling the (make_preset|write_shader|plan_video) tool exactly once/g, 'returning the structured output'),
      prompt: parts.join('\n\n'),
      schema: tool.input_schema as Record<string, unknown>,
      effort,
    });
    if (!r.ok) return { status: r.status, json: { error: r.error, note: r.note } };
    return finishOutput(mode, r.output, 'subscription');
  }

  parts.push(`Call the ${tool.name} tool with your answer.`);
  const messages: Record<string, unknown>[] = [{ role: 'user', content: parts.join('\n\n') }];
  const payload: Record<string, unknown> = {
    max_tokens: mode === 'shader' ? 16_000 : mode === 'plan' ? 6_000 : 8_000,
    system,
    tools: [tool],
    // Current models (Sonnet 5.5, Opus 5.5, Fable 5.x) reject forced tool_choice, so offer exactly
    // one tool with `auto` and instruct the call; a missing call gets one nudge below.
    tool_choice: { type: 'auto' },
    messages,
  };
  if (EFFORT_MODELS.test(model)) payload.output_config = { effort };

  let toolInput: unknown = null;
  try {
    for (let attempt = 0; attempt < 2 && toolInput === null; attempt++) {
      const { status, data } = await callClaude(env, payload, model);
      if (status < 200 || status >= 300) return upstreamError(status, data);
      if (data.stop_reason === 'refusal') {
        return { status: 422, json: { error: 'refused', note: 'Claude declined this request.' } };
      }
      const block = (data.content ?? []).find((b) => b.type === 'tool_use' && b.name === tool.name);
      if (block && isObj(block.input)) {
        toolInput = block.input;
        break;
      }
      if (data.stop_reason === 'max_tokens') break;
      // nudge once: keep the assistant turn unchanged, then ask for the tool call
      messages.push({ role: 'assistant', content: data.content ?? [] });
      messages.push({ role: 'user', content: `Please call the ${tool.name} tool now with your final answer.` });
    }
  } catch (err) {
    const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { status: 504, json: { error: timeout ? 'timeout' : 'network', note: timeout ? 'Claude took too long to answer.' : 'Couldn’t reach the Claude API.' } };
  }

  return finishOutput(mode, toolInput, 'api');
}

function finishOutput(mode: 'preset' | 'shader' | 'plan', toolInput: unknown, via: 'api' | 'subscription'): DirectorResult {
  if (!isObj(toolInput)) return { status: 502, json: { error: 'no_tool_call', note: 'Claude didn’t return a structured answer.' } };
  if (mode === 'plan') {
    if (!Array.isArray(toolInput.sections)) return { status: 502, json: { error: 'bad_output', note: 'Claude’s plan had no sections.' } };
    const note = typeof toolInput.note === 'string' ? toolInput.note.trim().slice(0, 400) : '';
    const title = typeof toolInput.title === 'string' ? toolInput.title.trim().slice(0, 60) : '';
    return { status: 200, json: { plan: { title, sections: toolInput.sections.slice(0, 40) }, note: note || 'Directed by Claude.', source: 'claude', via } };
  }

  const { note, ...rest } = toolInput;
  const noteText = typeof note === 'string' && note.trim() ? note.trim().slice(0, 400) : 'Directed by Claude.';
  if (mode === 'preset') {
    if (typeof rest.sceneId !== 'string') return { status: 502, json: { error: 'bad_output', note: 'Claude’s preset had no scene.' } };
    return { status: 200, json: { preset: { ...rest, custom: true }, note: noteText, source: 'claude', via } };
  }
  if (typeof rest.fragment !== 'string') return { status: 502, json: { error: 'bad_output', note: 'Claude’s shader had no code.' } };
  return { status: 200, json: { shader: rest, note: noteText, source: 'claude', via } };
}
