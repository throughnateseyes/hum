/**
 * AI director client. POSTs to /api/director (Claude on the server); falls back to the
 * offline director on 501 (no key), 429 (rate limit), 403 (access code), network errors
 * or unusable output. Everything that comes back is validated against the live registries.
 */
import type {
  CustomShaderSpec,
  DirectorRequest,
  DirectorResponse,
  EffectDef,
  LayerId,
  ModulationSeed,
  Palette,
  ParamDef,
  ParamValue,
  ParamValues,
  Preset,
  PresetEffect,
  PresetModulation,
  SceneDef,
  TrackCharacter,
} from '../core/types';
import { LAYERS, PALETTES } from '../core/palettes';
import { allScenes } from '../scenes';
import { allEffects } from '../fx';
import { buildCatalog } from './catalog';
import { localDirect } from './local';
import { cleanPlanTransition, type PlanTransition } from '../core/transitionList';

export const MAX_EFFECTS = 6;
export const MAX_MODULATIONS = 16;
export const MAX_SHADER_PARAMS = 10;
export const MAX_SHADER_MODULATIONS = 8;
export const MAX_FRAGMENT_CHARS = 16_000;

const LAYER_IDS = new Set<string>(LAYERS.map((l) => l.id));

/* ───────────────────────── small sanitisers ───────────────────────── */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number, fallback = '') => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : fallback);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const toNum = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** '#abc' / 'abc' / '#aabbcc' → '#aabbcc', else null */
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let s = v.trim().toLowerCase();
  if (!s.startsWith('#')) s = `#${s}`;
  if (/^#[0-9a-f]{3}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

function slug(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 28) || 'untitled'
  );
}
const rid = () => Math.floor(Math.random() * 36 ** 5).toString(36);

/** Coerce one value to a param's type and range; null if it can't be used. */
export function sanitizeParamValue(def: ParamDef, v: unknown): ParamValue | null {
  switch (def.type) {
    case 'number': {
      const n = toNum(v);
      if (n === null) return null;
      let x = clamp(n, def.min, def.max);
      if (def.step && def.step > 0) x = clamp(def.min + Math.round((x - def.min) / def.step) * def.step, def.min, def.max);
      return Math.round(x * 1e5) / 1e5;
    }
    case 'color':
      return normalizeHex(v);
    case 'bool':
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 1) return true;
      if (v === 'false' || v === 0) return false;
      return null;
    case 'select': {
      const s = String(v);
      if (def.options.some((o) => o.value === s)) return s;
      const byLabel = def.options.find((o) => o.label.toLowerCase() === s.toLowerCase());
      return byLabel ? byLabel.value : null;
    }
  }
}

export function sanitizeParams(defs: ParamDef[], raw: unknown, warnings?: string[], where = ''): ParamValues {
  const out: ParamValues = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const def = defs.find((d) => d.id === k);
    if (!def) {
      warnings?.push(`dropped unknown param ${where}${k}`);
      continue;
    }
    const s = sanitizeParamValue(def, v);
    if (s === null) warnings?.push(`dropped bad value for ${where}${k}`);
    else out[k] = s;
  }
  return out;
}

function sanitizePalette(raw: unknown, fallback: Palette): Palette {
  const known = isObj(raw) && typeof raw.id === 'string' ? PALETTES.find((p) => p.id === raw.id) : undefined;
  const base = known ?? fallback;
  if (!isObj(raw)) return { ...base };
  const pick = (k: keyof Omit<Palette, 'id' | 'name'>) => normalizeHex(raw[k]) ?? base[k];
  const out: Palette = {
    id: str(raw.id, 40) || `ai-${rid()}`,
    name: str(raw.name, 40) || (known ? known.name : 'Custom'),
    bg: pick('bg'),
    fg: pick('fg'),
    accent: pick('accent'),
    accent2: pick('accent2'),
    muted: pick('muted'),
  };
  // a custom palette must not masquerade as a curated id with different colours
  if (known && (['bg', 'fg', 'accent', 'accent2', 'muted'] as const).some((k) => out[k] !== known[k])) out.id = `${known.id}-ai-${rid()}`;
  return out;
}

/* ───────────────────────── preset validation ───────────────────────── */

export interface ValidateContext {
  scenes?: SceneDef[];
  effects?: EffectDef[];
  /** used when the scene id is unknown */
  fallbackSceneId?: string;
}

/**
 * Validate & sanitise a preset from the model (or anywhere untrusted): clamps numbers into
 * param ranges, drops unknown scene/effect/param ids, fixes palette hex colours, remaps
 * fx modulation indices after dropped effects, caps counts. Returns null if unusable.
 */
export function validatePreset(raw: unknown, warnings: string[] = [], ctx: ValidateContext = {}): Preset | null {
  if (!isObj(raw)) return null;
  const scenes = ctx.scenes ?? allScenes();
  const effects = ctx.effects ?? allEffects();

  // scene
  let sceneId = str(raw.sceneId, 80);
  let scene = scenes.find((s) => s.id === sceneId);
  if (!scene && scenes.length) {
    const fuzzy = scenes.find((s) => sceneId && (s.id.includes(sceneId) || sceneId.includes(s.id)));
    scene = fuzzy ?? scenes.find((s) => s.id === ctx.fallbackSceneId) ?? scenes.find((s) => s.category !== 'code') ?? scenes[0];
    warnings.push(`unknown scene "${sceneId}" → ${scene.id}`);
    sceneId = scene.id;
  }
  if (!sceneId) return null;

  const sceneParams = scene ? sanitizeParams(scene.params, raw.sceneParams, warnings, 'scene.') : {};

  // effects (track old index → new index for modulation targets)
  const rawFx = Array.isArray(raw.effects) ? raw.effects : [];
  const fx: PresetEffect[] = [];
  const indexMap = new Map<number, number>();
  rawFx.forEach((e, i) => {
    if (fx.length >= MAX_EFFECTS) return;
    const effectId = isObj(e) ? str(e.effectId, 80) : typeof e === 'string' ? e : '';
    const def = effects.find((d) => d.id === effectId);
    if (!def) {
      warnings.push(`dropped unknown effect "${effectId}"`);
      return;
    }
    indexMap.set(i, fx.length);
    fx.push({
      effectId: def.id,
      params: sanitizeParams(def.params, isObj(e) ? e.params : undefined, warnings, `${def.id}.`),
      enabled: isObj(e) && typeof e.enabled === 'boolean' ? e.enabled : true,
    });
  });

  // modulations
  const mods: PresetModulation[] = [];
  const seen = new Set<string>();
  for (const m of Array.isArray(raw.modulations) ? raw.modulations : []) {
    if (mods.length >= MAX_MODULATIONS) {
      warnings.push('capped modulation count');
      break;
    }
    if (!isObj(m)) continue;
    const source = str(m.source, 20);
    const amount = toNum(m.amount);
    const target = str(m.target, 120);
    if (!LAYER_IDS.has(source) || amount === null || amount === 0) continue;
    let resolved: string | null = null;
    const sm = /^scene\.(.+)$/.exec(target);
    const fm = /^fx\.(\d+)\.(.+)$/.exec(target);
    if (sm && scene) {
      const def = scene.params.find((p) => p.id === sm[1]);
      if (def?.type === 'number') resolved = `scene.${def.id}`;
    } else if (fm) {
      const ni = indexMap.get(Number(fm[1]));
      if (ni !== undefined) {
        const def = effects.find((d) => d.id === fx[ni].effectId)?.params.find((p) => p.id === fm[2]);
        if (def?.type === 'number') resolved = `fx.${ni}.${def.id}`;
      }
    } else if (scene && !target.includes('.')) {
      // bare param id → assume scene param
      const def = scene.params.find((p) => p.id === target);
      if (def?.type === 'number') resolved = `scene.${def.id}`;
    }
    if (!resolved) {
      warnings.push(`dropped modulation ${source}→${target}`);
      continue;
    }
    const key = `${source}|${resolved}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mods.push({ source: source as LayerId, target: resolved, amount: Math.round(clamp(amount, -1, 1) * 100) / 100 });
  }

  const name = str(raw.name, 60) || 'Untitled preset';
  const tags = (Array.isArray(raw.tags) ? raw.tags : [])
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.toLowerCase().trim().slice(0, 24))
    .filter(Boolean)
    .slice(0, 8);
  const rawId = str(raw.id, 60);
  return {
    id: rawId && /^[a-z0-9-]+$/i.test(rawId) && !rawId.startsWith('ai-tmp') ? rawId : `ai-${slug(name)}-${rid()}`,
    name,
    description: str(raw.description, 280),
    tags,
    sceneId,
    sceneParams,
    effects: fx,
    modulations: mods,
    palette: sanitizePalette(raw.palette, PALETTES[0]),
    custom: true,
  };
}

/* ───────────────────────── shader validation ───────────────────────── */

const HEADER_NAMES = [
  'vUv',
  'uResolution',
  'uTime',
  'uAspect',
  'uLevel',
  'uSub',
  'uBass',
  'uLowMid',
  'uMid',
  'uHighMid',
  'uAir',
  'uKick',
  'uSnare',
  'uHat',
  'uEnergy',
  'uBrightness',
  'uFlux',
  'uBeatPhase',
  'uBuild',
  'uDrop',
  'uSway',
  'uBeat',
  'uBeatCount',
  'uBpm',
  'uSpectrum',
  'uWaveform',
  'uBg',
  'uFg',
  'uAccent',
  'uAccent2',
  'uMuted',
  'uImage',
  'uImageSize',
  'uImage2',
  'uImage2Size',
  'uPhotoIndex',
  'tPrev',
];

/** strip fences, #version, and re-declarations of header uniforms / varyings / param uniforms */
export function sanitizeFragment(src: string, paramIds: string[]): string {
  let s = src.replace(/\r\n?/g, '\n').trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(s);
  if (fence) s = fence[1];
  const reserved = new Set([...HEADER_NAMES, ...paramIds.map((id) => `u_${id}`)]);
  return s
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (/^#version\b/.test(t)) return false;
      if (/^precision\s+\w+\s+float\s*;/.test(t)) return false;
      const decl = /^(uniform|varying|in)\s+\w+\s+([^;]+);/.exec(t);
      if (decl) {
        const names = decl[2].split(',').map((n) => n.trim().replace(/\[.*\]$/, ''));
        if (names.every((n) => reserved.has(n))) return false;
      }
      return true;
    })
    .join('\n')
    .trim();
}

function sanitizeShaderParam(raw: unknown): ParamDef | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id, 24).replace(/^u_/, '');
  if (!/^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(id)) return null;
  const label = str(raw.label, 32) || id;
  const group = str(raw.group, 20) || undefined;
  const type = str(raw.type, 10) || 'number';
  if (type === 'color') return { id, label, group, type: 'color', default: normalizeHex(raw.default) ?? '#ffffff' };
  if (type === 'bool') return { id, label, group, type: 'bool', default: raw.default === true || raw.default === 'true' };
  if (type === 'select' && Array.isArray(raw.options) && raw.options.length) {
    const options = raw.options
      .map((o) => (isObj(o) ? { value: str(o.value, 24), label: str(o.label, 24) || str(o.value, 24) } : { value: str(o, 24), label: str(o, 24) }))
      .filter((o) => o.value)
      .slice(0, 12);
    if (!options.length) return null;
    const def = options.some((o) => o.value === raw.default) ? String(raw.default) : options[0].value;
    return { id, label, group, type: 'select', options, default: def };
  }
  let min = toNum(raw.min) ?? 0;
  let max = toNum(raw.max) ?? 1;
  if (min > max) [min, max] = [max, min];
  if (min === max) max = min + 1;
  const step = toNum(raw.step);
  const d = toNum(raw.default);
  return {
    id,
    label,
    group,
    type: 'number',
    min,
    max,
    step: step && step > 0 ? step : undefined,
    default: clamp(d ?? (min + max) / 2, min, max),
  };
}

/** Validate a write_shader result into a CustomShaderSpec; null if unusable. */
export function validateShader(raw: unknown, warnings: string[] = []): CustomShaderSpec | null {
  if (!isObj(raw)) return null;
  const fragmentRaw = typeof raw.fragment === 'string' ? raw.fragment : '';
  if (!fragmentRaw || fragmentRaw.length > MAX_FRAGMENT_CHARS) return null;

  const params: ParamDef[] = [];
  for (const p of Array.isArray(raw.params) ? raw.params : []) {
    if (params.length >= MAX_SHADER_PARAMS) break;
    const s = sanitizeShaderParam(p);
    if (s && !params.some((x) => x.id === s.id)) params.push(s);
  }
  let fragment = sanitizeFragment(fragmentRaw, params.map((p) => p.id));
  if (!/void\s+main\s*\(\s*(void)?\s*\)/.test(fragment) || !/gl_FragColor/.test(fragment)) {
    warnings.push('shader has no main() writing gl_FragColor');
    return null;
  }
  // any u_<id> used but not declared as a param → add a 0..1 number param so it compiles
  for (const m of fragment.matchAll(/\bu_([A-Za-z][A-Za-z0-9_]{0,23})\b/g)) {
    const id = m[1];
    if (!params.some((p) => p.id === id) && params.length < MAX_SHADER_PARAMS + 4) {
      params.push({ id, label: id, type: 'number', min: 0, max: 1, default: 0.5 });
      warnings.push(`added missing param ${id}`);
    }
  }
  fragment = fragment.slice(0, MAX_FRAGMENT_CHARS);

  const modulations: ModulationSeed[] = [];
  for (const m of Array.isArray(raw.modulations) ? raw.modulations : []) {
    if (modulations.length >= MAX_SHADER_MODULATIONS) break;
    if (!isObj(m)) continue;
    const source = str(m.source, 20);
    const param = str(m.param ?? m.target, 40).replace(/^(scene\.|u_)/, '');
    const amount = toNum(m.amount);
    const def = params.find((p) => p.id === param);
    if (!LAYER_IDS.has(source) || def?.type !== 'number' || amount === null) continue;
    modulations.push({ source: source as LayerId, param, amount: Math.round(clamp(amount, -1, 1) * 100) / 100 });
  }

  const name = str(raw.name, 48) || 'Generated shader';
  return {
    id: `gen-${slug(name)}-${rid()}`,
    name,
    description: str(raw.description, 280),
    fragment,
    params,
    modulations,
  };
}

/* ───────────────────────── direct() ───────────────────────── */

export interface DirectOptions {
  /** sent as `accessCode` when the server requires HUM_ACCESS_CODE */
  accessCode?: string;
  /** defaults to '/api/director' */
  endpoint?: string;
  signal?: AbortSignal;
}

function fallback(req: DirectorRequest, reason: string): DirectorResponse {
  const local = localDirect(req);
  const warnings: string[] = [];
  if (local.preset) {
    const checked = validatePreset(local.preset, warnings, { fallbackSceneId: req.current?.sceneId });
    if (checked) local.preset = { ...checked, id: local.preset.id };
  }
  return { ...local, note: `${reason} ${local.note}`.trim(), source: 'local' };
}

/**
 * Ask the director for a preset or a new shader. Never throws for server/network trouble:
 * falls back to the offline director and explains why in `note`.
 * For shader mode, compile the returned spec with `makeCustomShaderScene(spec)`.
 */
export async function direct(req: DirectorRequest, opts: DirectOptions = {}): Promise<DirectorResponse> {
  const body = {
    prompt: req.prompt,
    mode: req.mode,
    track: req.track ?? null,
    current: req.current ?? null,
    catalog: buildCatalog(),
    accessCode: opts.accessCode,
  };

  let res: Response;
  try {
    res = await fetch(opts.endpoint ?? '/api/director', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return fallback(req, 'Couldn’t reach the AI director (offline?).');
  }

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  const serverNote = isObj(json) ? str(json.note ?? json.error, 200) : '';

  if (!res.ok) {
    if (res.status === 501) return fallback(req, 'No Claude API key is configured on the server.');
    if (res.status === 429) return fallback(req, serverNote || 'AI director rate limit reached — try again later.');
    if (res.status === 403) return fallback(req, 'The AI director needs a valid access code.');
    if (res.status === 404) return fallback(req, 'The AI director endpoint isn’t deployed.');
    return fallback(req, `AI director error (${res.status}${serverNote ? `: ${serverNote}` : ''}).`);
  }
  if (!isObj(json)) return fallback(req, 'The AI director sent an unreadable reply.');

  const warnings: string[] = [];
  const note = str(json.note, 400) || 'Directed by Claude.';
  const via = json.via === 'subscription' ? ('subscription' as const) : ('api' as const);
  if (req.mode === 'shader') {
    const shader = validateShader(json.shader, warnings);
    if (!shader) return fallback(req, 'Claude’s shader didn’t pass validation.');
    return { shader, note, source: 'claude', via };
  }
  const preset = validatePreset(json.preset, warnings, { fallbackSceneId: req.current?.sceneId });
  if (!preset) return fallback(req, 'Claude’s preset didn’t pass validation.');
  if (warnings.length && import.meta.env?.DEV) console.info('[director] sanitised:', warnings);
  return { preset, note, source: 'claude', via };
}

/* ───────────────────────── video plan ───────────────────────── */

export interface PlanRequest {
  wish?: string;
  track: DirectorRequest['track'];
  /** what kind of song it is (genre, instruments, mood), when the analysis knows */
  character?: TrackCharacter;
  /** `drop`: the section starts on a drop of this size (0..1) */
  sections: { label: string; group: number; start: number; end: number; energy: number; busy?: number; lyrics?: string; drop?: { strength: number; why: string } }[];
  /** whole lyrics when they have no timing */
  lyrics?: string;
  looks: { id: string; name: string; description: string; tags: string[]; category: string }[];
}
export type PlanReply =
  | {
      ok: true;
      title: string;
      note: string;
      looks: (string | null)[];
      why: string[];
      via: 'api' | 'subscription';
      /** pop-up windows per section, 0..3 (null when Claude didn't say) */
      pops: (number | null)[];
      /** board look shown for the first bars of a section (null = none) */
      interludes: (string | null)[];
      /** extra looks to rotate through in each section (null when Claude didn't say) */
      rotate: (string[] | null)[];
      /** bars per shot in each section (null when Claude didn't say) */
      shotBars: (number | null)[];
      /** how each section arrives and cuts between its shots (null when Claude didn't say) */
      transitions: (PlanTransition | null)[];
    }
  | { ok: false; reason: string };

/**
 * Ask Claude for a look per section. Never throws for server trouble: returns { ok: false, reason }
 * so the caller can use the offline plan. Unknown look ids and missing sections come back as null.
 */
export async function requestPlan(req: PlanRequest, opts: DirectOptions = {}): Promise<PlanReply> {
  let res: Response;
  try {
    res = await fetch(opts.endpoint ?? '/api/director', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'plan',
        prompt: req.wish ?? '',
        track: req.track,
        character: req.character,
        sections: req.sections,
        looks: req.looks,
        lyrics: req.lyrics,
        accessCode: opts.accessCode,
      }),
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return { ok: false, reason: 'Couldn’t reach the AI director (offline?).' };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  const serverNote = isObj(json) ? str(json.note ?? json.error, 200) : '';
  if (!res.ok) {
    if (res.status === 501) return { ok: false, reason: 'No Claude connection is set up.' };
    if (res.status === 429) return { ok: false, reason: serverNote || 'The AI director is rate limited right now.' };
    if (res.status === 403) return { ok: false, reason: 'The AI director needs a valid access code.' };
    return { ok: false, reason: `AI director error (${res.status}${serverNote ? `: ${serverNote}` : ''}).` };
  }
  if (!isObj(json) || !isObj(json.plan) || !Array.isArray(json.plan.sections)) return { ok: false, reason: 'The AI director sent an unreadable plan.' };
  const known = new Set(req.looks.map((l) => l.id));
  const looks: (string | null)[] = req.sections.map(() => null);
  const why: string[] = req.sections.map(() => '');
  const pops: (number | null)[] = req.sections.map(() => null);
  const interludes: (string | null)[] = req.sections.map(() => null);
  const rotate: (string[] | null)[] = req.sections.map(() => null);
  const shotBars: (number | null)[] = req.sections.map(() => null);
  const transitions: (PlanTransition | null)[] = req.sections.map(() => null);
  const boards = new Set(req.looks.filter((l) => l.category === 'board').map((l) => l.id));
  for (const e of json.plan.sections) {
    if (!isObj(e)) continue;
    const i = toNum(e.index);
    const id = str(e.lookId, 60);
    if (i === null || i < 0 || i >= looks.length || !Number.isInteger(i) || !known.has(id)) continue;
    looks[i] = id;
    why[i] = str(e.why, 120);
    const p = toNum(e.pops);
    if (p !== null) pops[i] = Math.max(0, Math.min(3, Math.round(p)));
    const inter = str(e.interlude, 60);
    if (inter && boards.has(inter) && inter !== id) interludes[i] = inter;
    if (Array.isArray(e.rotate)) {
      const extra = [...new Set(e.rotate.map((r) => str(r, 60)))].filter((r) => known.has(r) && !boards.has(r) && r !== id).slice(0, 3);
      if (extra.length) rotate[i] = extra;
    }
    const bars = toNum(e.pace);
    if (bars !== null && [1, 2, 4, 8, 16].includes(bars)) shotBars[i] = bars;
    transitions[i] = cleanPlanTransition({ into: e.transition, within: e.within, beats: toNum(e.transitionBeats) });
  }
  if (!looks.some(Boolean)) return { ok: false, reason: 'Claude’s plan didn’t use any known looks.' };
  return {
    ok: true,
    title: str(json.plan.title, 60) || 'Your video',
    note: str(json.note, 400),
    looks,
    why,
    via: json.via === 'subscription' ? 'subscription' : 'api',
    pops,
    interludes,
    rotate,
    shotBars,
    transitions,
  };
}
