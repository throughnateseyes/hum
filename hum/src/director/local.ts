/**
 * Offline director: keyword + mood heuristics that build a valid Preset (or a template
 * shader) without any network. Seeded from the prompt, so the same prompt gives the
 * same answer but different prompts wander.
 */
import type {
  CustomShaderSpec,
  DirectorRequest,
  DirectorResponse,
  EffectDef,
  LayerId,
  NumberParam,
  Palette,
  ParamDef,
  ParamValues,
  Preset,
  PresetEffect,
  PresetModulation,
  SceneCategory,
  SceneDef,
} from '../core/types';
import { PALETTES, isLightPalette } from '../core/palettes';
import { allScenes } from '../scenes';
import { allEffects } from '../fx';

export interface LocalInputs {
  scenes?: SceneDef[];
  effects?: EffectDef[];
  palettes?: Palette[];
}

/* ───────────────────────── seeded random ───────────────────────── */

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function seededRandom(seed: string | number): () => number {
  let a = typeof seed === 'number' ? seed >>> 0 : hashString(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ───────────────────────── rules ───────────────────────── */

interface Rule {
  re: RegExp;
  label: string;
  scenes?: string[];
  categories?: SceneCategory[];
  effects?: string[];
  palettes?: string[];
  tags?: string[];
  /** -1 calm … 1 intense */
  energy?: number;
}

const RULES: Rule[] = [
  {
    re: /\b(sad|rain\w*|lonely|lonel\w*|melanchol\w*|grie\w*|tears?|cry\w*|heartbr\w*|blue mood|nostalg\w*)\b/,
    label: 'melancholy',
    scenes: ['aura', 'silk', 'flow-hair', 'slit-smear', 'rain'],
    effects: ['grain', 'trails', 'bloom', 'vignette'],
    palettes: ['rain', 'midnight', 'sky-film', 'bone-ink'],
    tags: ['melancholic', 'rain', 'sad', 'calm'],
    energy: -0.6,
  },
  {
    re: /\b(dubstep|heavy|blomp\w*|wobbl\w*|riddim|brostep|bass ?music|filthy|grime|sub ?bass|808s?)\b/,
    label: 'heavy bass',
    scenes: ['sub-pressure', 'monolith-grid', 'ring-tunnel', 'tetris'],
    effects: ['glitch', 'flash', 'zoom-punch', 'chroma', 'displace'],
    palettes: ['acid', 'bruise', 'sodium', 'mono'],
    tags: ['dubstep', 'heavy', 'bass', 'aggressive'],
    energy: 1,
  },
  {
    re: /\b(dream\w*|ethereal|float\w*|haz[ey]|shoegaze|lush|cloud\w*|soft focus)\b/,
    label: 'dreamy',
    scenes: ['liquid-marble', 'aura', 'silk', 'point-swarm'],
    effects: ['bloom', 'trails', 'grain'],
    palettes: ['marble', 'sky-film', 'blush', 'cream-violet'],
    tags: ['dreamy', 'ethereal'],
    energy: -0.3,
  },
  {
    re: /\b(photos?|pictures?|portraits?|selfies?|images?|faces?|camera)\b/,
    label: 'photo',
    categories: ['photo'],
    effects: ['halftone', 'grain', 'posterize', 'gradient-map'],
    tags: ['photo'],
  },
  {
    re: /\b(lo-?fi|chillhop|study|cozy|cosy|tape|cassette|vinyl|bedroom)\b/,
    label: 'lofi',
    scenes: ['board-orbit', 'board', 'orbit'],
    effects: ['dither', 'grain', 'crt', 'halftone'],
    palettes: ['clay', 'cream-violet', 'paper-blue'],
    tags: ['lofi', 'calm', 'warm'],
    energy: -0.4,
  },
  {
    re: /\b(techno|house|rave|club|warehouse|driving|four.on.the.floor|trance|minimal techno)\b/,
    label: 'club',
    scenes: ['step-sequencer', 'monolith-grid', 'ring-tunnel', 'tetris'],
    categories: ['board'],
    effects: ['flash', 'zoom-punch', 'halftone', 'crt'],
    palettes: ['mono', 'acid', 'midnight', 'bone-ink'],
    tags: ['driving', 'techno', 'hypnotic'],
    energy: 0.7,
  },
  {
    re: /\b(ambient|calm|meditat\w*|peaceful|serene|still|quiet|minimal)\b/,
    label: 'calm',
    scenes: ['topo', 'ridgeline', 'clay-orb', 'aura'],
    effects: ['grain', 'vignette'],
    palettes: ['paper-blue', 'bone-ink', 'mint-lab', 'sky-film'],
    tags: ['calm', 'spacious', 'ambient'],
    energy: -0.7,
  },
  {
    re: /\b(happy|euphori\w*|uplift\w*|summer|sunny|joy\w*|pop|festival|anthem\w*)\b/,
    label: 'euphoric',
    scenes: ['chrome-blobs', 'clay-orb', 'point-swarm'],
    effects: ['bloom', 'halftone', 'kaleido', 'flash'],
    palettes: ['blush', 'mint-lab', 'cream-violet', 'sodium'],
    tags: ['euphoric', 'bright', 'happy'],
    energy: 0.5,
  },
  {
    re: /\b(dark\w*|night\w*|noir|horror|sinister|goth\w*|shadow\w*|void)\b/,
    label: 'dark',
    effects: ['grain', 'vignette', 'ascii'],
    palettes: ['midnight', 'bruise', 'mono', 'rain'],
    tags: ['dark'],
    energy: 0.1,
  },
  {
    re: /\b(glitch\w*|broken|corrupt\w*|datamosh\w*|digital|cyber\w*|error)\b/,
    label: 'glitch',
    scenes: ['photo-mosh', 'datamosh', 'glitch'],
    effects: ['glitch', 'chroma', 'pixelate', 'smear'],
    palettes: ['acid', 'bruise', 'mono'],
    tags: ['glitch', 'digital', 'aggressive'],
    energy: 0.6,
  },
  {
    re: /\b(retro|8.?bit|pixel\w*|arcade|game ?boy|ascii|terminal|crt)\b/,
    label: 'retro',
    effects: ['dither', 'pixelate', 'ascii', 'crt', 'posterize'],
    palettes: ['mint-lab', 'mono', 'acid'],
    tags: ['retro'],
    energy: 0.2,
  },
  {
    re: /\b(paper|print|editorial|risograph|riso|zine|newspaper|instrument\w*|board|dashboard|data|meters?|spectrogram)\b/,
    label: 'editorial',
    categories: ['board'],
    scenes: ['board', 'spectrogram', 'ridgeline', 'topo'],
    effects: ['halftone', 'grain', 'dither', 'edge'],
    palettes: ['paper-blue', 'cream-violet', 'bone-ink'],
    tags: ['editorial', 'minimal'],
    energy: 0,
  },
  {
    re: /\b(marble|liquid|fluid|ink|oil|gold\w*|molten)\b/,
    label: 'liquid',
    scenes: ['liquid-marble', 'silk', 'marble'],
    effects: ['bloom', 'displace', 'grain'],
    palettes: ['marble', 'sodium'],
    tags: ['liquid', 'dreamy'],
    energy: -0.1,
  },
  {
    re: /\b(hair|combed|flow\w*|lines|strokes|silk\w*|threads?|wind)\b/,
    label: 'flow',
    scenes: ['flow-hair', 'silk', 'slit-smear', 'flow'],
    categories: ['field'],
    palettes: ['paper-blue', 'sky-film', 'bone-ink'],
    tags: ['flowing'],
  },
  {
    re: /\b(point ?cloud|3d|sculpt\w*|orbs?|spheres?|blobs?|crystal\w*|geometr\w*|monolith)\b/,
    label: 'form',
    categories: ['form'],
    effects: ['bloom', 'chroma'],
    tags: ['form'],
  },
  {
    re: /\b(angry|aggressive|rage|metal|punk|hard ?core|intense|chaos|chaotic|violent)\b/,
    label: 'aggressive',
    effects: ['zoom-punch', 'flash', 'glitch', 'chroma'],
    palettes: ['sodium', 'acid', 'mono'],
    tags: ['aggressive', 'intense'],
    energy: 1,
  },
  {
    re: /\b(drum ?(and|n|&) ?bass|dnb|jungle|breakbeat|breaks)\b/,
    label: 'breaks',
    scenes: ['tetris', 'step-sequencer', 'ring-tunnel'],
    effects: ['flash', 'chroma', 'crt'],
    palettes: ['acid', 'midnight', 'bruise'],
    tags: ['drum-and-bass', 'fast', 'driving'],
    energy: 0.8,
  },
  { re: /\b(warm|sunset|autumn|fire|amber|orange|desert)\b/, label: 'warm', palettes: ['sodium', 'clay', 'blush'], tags: ['warm'] },
  { re: /\b(ocean|sea|water|underwater|ice|icy|cold|winter|snow)\b/, label: 'cold', palettes: ['sky-film', 'midnight', 'rain', 'marble'], tags: ['cold'] },
  { re: /\b(forest|green|nature|plants?|garden|leaf|leaves)\b/, label: 'green', palettes: ['mint-lab'], tags: ['organic'] },
  { re: /\b(black and white|monochrome|mono|b&w|grayscale|greyscale)\b/, label: 'mono', palettes: ['mono', 'bone-ink'] },
  {
    re: /\b(love|romantic|tender|soft|gentle|pink|intimate)\b/,
    label: 'tender',
    scenes: ['clay-orb', 'aura'],
    effects: ['bloom', 'grain'],
    palettes: ['blush', 'cream-violet'],
    tags: ['tender', 'soft'],
    energy: -0.4,
  },
  {
    re: /\b(space|cosmic|stars?|galax\w*|nebula\w*|astral|orbit\w*)\b/,
    label: 'cosmic',
    scenes: ['point-swarm', 'ring-tunnel'],
    effects: ['bloom', 'kaleido', 'grain'],
    palettes: ['midnight', 'bruise', 'marble'],
    tags: ['spacious', 'cosmic'],
  },
  { re: /\b(neon|acid|toxic|lime)\b/, label: 'neon', palettes: ['acid', 'bruise'], effects: ['bloom', 'chroma'], tags: ['neon'], energy: 0.5 },
  { re: /\b(blue|ultramarine|cobalt)\b/, label: 'blue', palettes: ['paper-blue', 'marble', 'sky-film'] },
  { re: /\b(violet|purple|lilac)\b/, label: 'violet', palettes: ['cream-violet', 'bruise'] },
];

/** words that hint at an edit of the current preset */
const EDIT_RE = /\b(more|less|make it|bit|too|calmer|darker|brighter|lighter|faster|slower|heavier|softer|add|remove|without|no more|tone it|crank|push|swap|change)\b/;
const MORE_RE = /\b(more intense|intenser|harder|heavier|crazier|chaotic|wilder|more energy|crank|push it|louder|punchier|more reactive|stronger)\b/;
const LESS_RE = /\b(calmer|softer|gentler|subtler|subtle|less|tone it down|quieter|chill(er)?|slower|smoother)\b/;
const DARK_RE = /\b(darker|dark mode|moodier|night)\b/;
const LIGHT_RE = /\b(brighter|lighter|light mode|paper|cream|off-?white)\b/;

/* ───────────────────────── helpers ───────────────────────── */

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const tokenize = (s: string) => s.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
const fuzzy = (id: string, want: string) => id === want || id.includes(want) || want.includes(id);

function quantize(p: NumberParam, v: number): number {
  let x = clamp(v, p.min, p.max);
  if (p.step && p.step > 0) x = p.min + Math.round((x - p.min) / p.step) * p.step;
  return Math.round(clamp(x, p.min, p.max) * 10000) / 10000;
}

function pickWeighted<T>(items: { item: T; w: number }[], rnd: () => number): T | undefined {
  const total = items.reduce((a, b) => a + Math.max(0, b.w), 0);
  if (total <= 0) return items[0]?.item;
  let r = rnd() * total;
  for (const it of items) {
    r -= Math.max(0, it.w);
    if (r <= 0) return it.item;
  }
  return items[items.length - 1]?.item;
}

/** Which audio layer suits a param, judged by its id/label. */
function layerForParam(p: ParamDef, energy: number, rnd: () => number): { source: LayerId; amount: number } {
  const key = `${p.id} ${p.label}`.toLowerCase();
  const sign = rnd() < 0.12 ? -1 : 1;
  const base = 0.25 + 0.25 * Math.max(0, energy) + rnd() * 0.15;
  const amt = (a: number) => Math.round(clamp(a * sign, -1, 1) * 100) / 100;
  if (/size|scale|radius|zoom|thick|width|height|amp/.test(key)) return { source: rnd() < 0.5 ? 'sub' : 'bass', amount: amt(base) };
  if (/displace|warp|distort|wobble|bend|turb|noise/.test(key)) return { source: rnd() < 0.6 ? 'bass' : 'kick', amount: amt(base) };
  if (/glow|bright|flash|bloom|light|exposure|punch/.test(key)) return { source: rnd() < 0.6 ? 'kick' : 'drop', amount: amt(base + 0.1) };
  if (/speed|rate|tempo|flow|time/.test(key)) return { source: 'energy', amount: amt(base * 0.8) };
  if (/density|count|amount|detail|cells|lines|grain/.test(key)) return { source: rnd() < 0.5 ? 'hat' : 'energy', amount: amt(base * 0.8) };
  if (/rot|twist|spin|angle|swirl/.test(key)) return { source: 'sway', amount: amt(base * 0.6) };
  if (/glitch|shift|split|offset|jitter|shake|slice/.test(key)) return { source: rnd() < 0.5 ? 'snare' : 'drop', amount: amt(base + 0.1) };
  if (/hue|color|colour|tint|temp/.test(key)) return { source: 'brightness', amount: amt(base * 0.6) };
  const pool: LayerId[] = ['kick', 'bass', 'energy', 'mid', 'snare', 'air'];
  return { source: pool[Math.floor(rnd() * pool.length)], amount: amt(base * 0.8) };
}

function tweakParams(params: ParamDef[], energy: number, rnd: () => number, spread = 0.15): ParamValues {
  const out: ParamValues = {};
  for (const p of params) {
    if (p.type !== 'number') continue;
    if (rnd() < 0.45) continue; // leave many at their designed default
    const range = p.max - p.min;
    const key = `${p.id} ${p.label}`.toLowerCase();
    let bias = 0;
    if (/intens|amount|strength|speed|chaos|glitch|displace|warp/.test(key)) bias = energy * 0.12;
    out[p.id] = quantize(p, p.default + range * (bias + (rnd() * 2 - 1) * spread));
  }
  return out;
}

function effectParams(e: EffectDef, energy: number, rnd: () => number): ParamValues {
  const out: ParamValues = {};
  for (const p of e.params) {
    if (p.type !== 'number') continue;
    const key = `${p.id} ${p.label}`.toLowerCase();
    const range = p.max - p.min;
    if (/amount|intens|strength|mix|opacity/.test(key)) out[p.id] = quantize(p, p.default + range * (energy * 0.12 + (rnd() * 2 - 1) * 0.06));
    else if (rnd() < 0.3) out[p.id] = quantize(p, p.default + range * (rnd() * 2 - 1) * 0.1);
  }
  return out;
}

function sceneModulations(scene: SceneDef, energy: number, rnd: () => number): PresetModulation[] {
  const mods: PresetModulation[] = [];
  const nums = scene.params.filter((p): p is NumberParam => p.type === 'number');
  for (const seed of scene.modulations ?? []) {
    if (!nums.some((p) => p.id === seed.param)) continue;
    const scale = 0.85 + rnd() * 0.3 + Math.max(0, energy) * 0.2;
    mods.push({ source: seed.source, target: `scene.${seed.param}`, amount: Math.round(clamp(seed.amount * scale, -1, 1) * 100) / 100 });
  }
  const used = new Set(mods.map((m) => m.target));
  const extra = nums.filter((p) => !used.has(`scene.${p.id}`));
  // shuffle deterministically
  for (let i = extra.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [extra[i], extra[j]] = [extra[j], extra[i]];
  }
  const want = Math.max(0, (energy > 0.4 ? 4 : 3) - mods.length) + (rnd() < 0.4 ? 1 : 0);
  for (const p of extra.slice(0, want)) {
    const l = layerForParam(p, energy, rnd);
    mods.push({ source: l.source, target: `scene.${p.id}`, amount: l.amount });
  }
  return mods;
}

function fxModulations(effects: PresetEffect[], defs: EffectDef[], energy: number, rnd: () => number): PresetModulation[] {
  const mods: PresetModulation[] = [];
  effects.forEach((pe, i) => {
    const def = defs.find((d) => d.id === pe.effectId);
    if (!def) return;
    const nums = def.params.filter((p): p is NumberParam => p.type === 'number');
    if (!nums.length) return;
    const p =
      nums.find((q) => /amount|intens|strength|mix/.test(`${q.id} ${q.label}`.toLowerCase())) ?? nums[Math.floor(rnd() * nums.length)];
    let source: LayerId = 'kick';
    if (def.category === 'glitch') source = rnd() < 0.5 ? 'drop' : 'snare';
    else if (def.category === 'texture') source = rnd() < 0.5 ? 'air' : 'hat';
    else if (def.category === 'optics') source = 'kick';
    else if (def.category === 'time') source = 'energy';
    else if (def.category === 'distort') source = rnd() < 0.5 ? 'bass' : 'sub';
    else if (def.category === 'color') source = 'brightness';
    const amount = Math.round((0.2 + 0.25 * Math.max(0, energy) + rnd() * 0.15) * 100) / 100;
    mods.push({ source, target: `fx.${i}.${p.id}`, amount });
  });
  return mods;
}

const ADJ = ['Low', 'Velvet', 'Paper', 'Quiet', 'Hollow', 'Static', 'Glass', 'Slow', 'Soft', 'Bright', 'Night', 'Signal', 'Iron', 'Salt', 'Halo', 'Field'];
const NOUN = ['Tide', 'Pressure', 'Bloom', 'Drift', 'Weather', 'Engine', 'Hymn', 'Grain', 'Current', 'Pulse', 'Room', 'Orbit', 'Lantern', 'Mirror', 'Signal', 'Season'];

function makeName(rnd: () => number, hint?: string): string {
  const a = ADJ[Math.floor(rnd() * ADJ.length)];
  let n = NOUN[Math.floor(rnd() * NOUN.length)];
  if (n === a) n = 'Study';
  return hint && rnd() < 0.35 ? `${a} ${hint}` : `${a} ${n}`;
}

function slug(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'preset'
  );
}

/* ───────────────────────── analysis of the request ───────────────────────── */

interface Intent {
  rules: Rule[];
  energy: number;
  tags: string[];
  words: string[];
}

/** drop negated phrases ("no glitch", "without grain", "less blue") so they don't count as wishes */
const stripNegations = (text: string) => text.replace(/\b(?:no|not|without|remove|less|drop|lose|kill|minus)\s+(?:the\s+|any\s+|more\s+)?[a-z0-9-]+/g, ' ');

function readIntent(req: DirectorRequest): Intent {
  const text = stripNegations((req.prompt ?? '').toLowerCase());
  const rules = RULES.filter((r) => r.re.test(text));
  const words = tokenize(text);
  const tags = new Set<string>();
  for (const r of rules) for (const t of r.tags ?? []) tags.add(t);
  let energy = 0;
  let n = 0;
  for (const r of rules) {
    if (r.energy !== undefined) {
      energy += r.energy;
      n++;
    }
  }
  energy = n ? energy / n : 0;
  const track = req.track;
  if (track) {
    for (const t of track.tags ?? []) tags.add(t);
    const trackEnergy = clamp((track.mood?.arousal ?? 0.5) * 2 - 1, -1, 1);
    energy = n ? energy * 0.7 + trackEnergy * 0.3 : trackEnergy;
    // track mood can recruit rules the prompt didn't name
    if (!rules.length) {
      for (const r of RULES) if ((r.tags ?? []).some((t) => track.tags?.includes(t))) rules.push(r);
    }
  }
  return { rules, energy: clamp(energy, -1, 1), tags: [...tags], words };
}

function chooseScene(intent: Intent, scenes: SceneDef[], rnd: () => number, wantsCode: boolean): SceneDef | undefined {
  const pool = scenes.filter((s) => wantsCode || s.category !== 'code');
  if (!pool.length) return scenes[0];
  const scored = pool.map((s) => {
    let w = 0.3 + rnd() * 1.2;
    intent.rules.forEach((r, ri) => {
      const k = ri === 0 ? 1.3 : 1; // first matched rule counts a bit more
      for (const want of r.scenes ?? []) {
        if (s.id === want) w += 4 * k;
        else if (fuzzy(s.id, want)) w += 2 * k;
      }
      if (r.categories?.includes(s.category)) w += 2.2 * k;
    });
    for (const t of s.tags) if (intent.tags.includes(t.toLowerCase())) w += 0.8;
    // explicit scene name in the prompt
    const nameWords = tokenize(`${s.id} ${s.name}`);
    if (intent.words.some((wd) => wd.length > 3 && nameWords.includes(wd))) w += 3;
    if (s.usesPhotos && !intent.rules.some((r) => r.label === 'photo')) w -= 0.6;
    return { item: s, w };
  });
  scored.sort((a, b) => b.w - a.w);
  // pick among the top three, weighted — varied but on-brief
  return pickWeighted(scored.slice(0, 3).map((x, i) => ({ item: x.item, w: x.w * (i === 0 ? 1.6 : 1) })), rnd);
}

function chooseEffects(intent: Intent, effects: EffectDef[], rnd: () => number): EffectDef[] {
  if (!effects.length) return [];
  const scored = effects.map((e) => {
    let w = rnd() * 0.8;
    intent.rules.forEach((r, ri) => {
      const k = ri === 0 ? 1.3 : 1;
      (r.effects ?? []).forEach((want, wi) => {
        const pos = 1 - wi * 0.12;
        if (e.id === want) w += 3 * k * pos;
        else if (fuzzy(e.id, want) || e.name.toLowerCase().includes(want)) w += 1.8 * k * pos;
      });
    });
    if (intent.energy > 0.5 && e.category === 'glitch') w += 0.8;
    if (intent.energy < -0.3 && e.category === 'glitch') w -= 1.5;
    if (intent.words.includes(e.id) || intent.words.includes(e.name.toLowerCase())) w += 4;
    return { e, w };
  });
  scored.sort((a, b) => b.w - a.w);
  const strong = scored.filter((s) => s.w >= 1.6);
  let count = 1 + Math.floor(rnd() * 2) + (intent.energy > 0.6 ? 1 : 0);
  if (!strong.length) {
    // nothing asked for: a single subtle texture most of the time
    const gentle = scored.filter((s) => /grain|noise|vignette|bloom/.test(s.e.id));
    const subtle = gentle.length ? gentle : scored.filter((s) => s.e.category === 'texture');
    return rnd() < 0.75 && subtle.length ? [subtle[0].e] : [];
  }
  count = Math.min(count, strong.length, 4);
  const picked: EffectDef[] = [];
  const cats = new Map<string, number>();
  for (const s of strong) {
    if (picked.length >= count) break;
    const c = cats.get(s.e.category) ?? 0;
    if (c >= 2) continue; // avoid stacking three of a kind
    picked.push(s.e);
    cats.set(s.e.category, c + 1);
  }
  return picked;
}

function choosePalette(intent: Intent, scene: SceneDef | undefined, palettes: Palette[], rnd: () => number, req: DirectorRequest): Palette {
  const byId = (id: string) => palettes.find((p) => p.id === id);
  const cands = new Map<string, number>();
  intent.rules.forEach((r, ri) => {
    (r.palettes ?? []).forEach((id, i) => {
      if (byId(id)) cands.set(id, (cands.get(id) ?? 0) + (ri === 0 ? 3 : 2) - i * 0.4);
    });
  });
  if (!cands.size) {
    const mood = req.track?.mood;
    let ids: string[];
    if (mood) {
      if (mood.valence < 0.4 && mood.arousal < 0.5) ids = ['rain', 'midnight', 'bone-ink', 'sky-film'];
      else if (mood.arousal > 0.65) ids = mood.valence > 0.5 ? ['sodium', 'blush', 'acid'] : ['acid', 'bruise', 'mono', 'sodium'];
      else if (mood.brightness > 0.55) ids = ['paper-blue', 'sky-film', 'mint-lab', 'blush'];
      else ids = ['cream-violet', 'marble', 'clay', 'midnight'];
    } else if (scene?.light) ids = ['paper-blue', 'cream-violet', 'bone-ink', 'sky-film', 'clay', 'mint-lab'];
    else ids = ['midnight', 'marble', 'paper-blue', 'bruise', 'cream-violet', 'sodium'];
    ids.forEach((id, i) => byId(id) && cands.set(id, 2 - i * 0.2));
  }
  if (scene?.light) for (const [id, w] of cands) if (isLightPalette(byId(id)!)) cands.set(id, w + 0.6);
  const list = [...cands.entries()].map(([id, w]) => ({ item: byId(id)!, w: w + rnd() * 0.8 }));
  list.sort((a, b) => b.w - a.w);
  return { ...(pickWeighted(list.slice(0, 3), rnd) ?? palettes[0] ?? PALETTES[0]) };
}

/* ───────────────────────── preset building ───────────────────────── */

function freshPreset(req: DirectorRequest, scenes: SceneDef[], effects: EffectDef[], palettes: Palette[], rnd: () => number): { preset: Preset; note: string } {
  const intent = readIntent(req);
  const wantsCode = /\b(shader|glsl|code)\b/.test(req.prompt.toLowerCase());
  const scene = chooseScene(intent, scenes, rnd, wantsCode);
  const fx = chooseEffects(intent, effects, rnd);
  const palette = choosePalette(intent, scene, palettes, rnd, req);
  const presetEffects: PresetEffect[] = fx.map((e) => ({ effectId: e.id, params: effectParams(e, intent.energy, rnd), enabled: true }));
  const modulations = [
    ...(scene ? sceneModulations(scene, intent.energy, rnd) : []),
    ...fxModulations(presetEffects, effects, intent.energy, rnd),
  ].slice(0, 12);
  const label = intent.rules[0]?.label;
  const name = makeName(rnd, scene?.name.split(' ')[0]);
  const tags = [...new Set([...intent.tags, ...(scene?.tags ?? []).slice(0, 2)])].slice(0, 6);
  const fxNames = fx.map((e) => e.name.toLowerCase());
  const preset: Preset = {
    id: `local-${slug(name)}-${Math.floor(rnd() * 1e6).toString(36)}`,
    name,
    description: `${scene?.name ?? 'Scene'}${fxNames.length ? ` through ${fxNames.join(' + ')}` : ''} on ${palette.name}.`,
    tags,
    sceneId: scene?.id ?? req.current?.sceneId ?? '',
    sceneParams: scene ? tweakParams(scene.params, intent.energy, rnd) : {},
    effects: presetEffects,
    modulations,
    palette,
    custom: true,
  };
  const why = label ? `read the prompt as ${label}` : req.track ? 'followed the track mood' : 'took a free swing';
  const reactive = modulations.slice(0, 2).map((m) => `${m.source}→${m.target.split('.').pop()}`);
  const note = `Offline director ${why}: ${scene?.name ?? 'scene'} with ${palette.name}${reactive.length ? `, ${reactive.join(', ')}` : ''}.`;
  return { preset, note };
}

function editPreset(
  req: DirectorRequest,
  current: Preset,
  scenes: SceneDef[],
  effects: EffectDef[],
  palettes: Palette[],
  rnd: () => number,
): { preset: Preset; note: string } {
  const text = req.prompt.toLowerCase();
  const intent = readIntent(req);
  const p: Preset = JSON.parse(JSON.stringify(current)) as Preset;
  const changes: string[] = [];

  // scene swap when a scene is named
  const named = scenes.find((s) => {
    const w = tokenize(`${s.id} ${s.name}`).filter((x) => x.length > 3);
    return s.id !== p.sceneId && (text.includes(s.id) || w.some((x) => intent.words.includes(x)));
  });
  if (named) {
    p.sceneId = named.id;
    p.sceneParams = tweakParams(named.params, intent.energy, rnd, 0.08);
    p.modulations = [...sceneModulations(named, intent.energy, rnd), ...p.modulations.filter((m) => m.target.startsWith('fx.'))];
    changes.push(`switched to ${named.name}`);
  }

  // remove effects: "no grain", "without glitch", "remove dither"
  const removeRe = /\b(?:no|without|remove|drop|lose|kill)\s+(?:the\s+)?([a-z0-9-]+)/g;
  for (const m of text.matchAll(removeRe)) {
    const word = m[1];
    const idx = p.effects.findIndex((e) => fuzzy(e.effectId, word));
    if (idx >= 0) {
      p.effects.splice(idx, 1);
      p.modulations = p.modulations
        .filter((mo) => !mo.target.startsWith(`fx.${idx}.`))
        .map((mo) => {
          const mm = /^fx\.(\d+)\.(.+)$/.exec(mo.target);
          if (mm && Number(mm[1]) > idx) return { ...mo, target: `fx.${Number(mm[1]) - 1}.${mm[2]}` };
          return mo;
        });
      changes.push(`removed ${word}`);
    }
  }

  // add effects by name or by matched rules
  const addWanted = new Set<string>();
  for (const m of text.matchAll(/\b(?:add|with|plus|more)\s+(?:some\s+)?([a-z0-9-]+)/g)) addWanted.add(m[1]);
  for (const r of intent.rules) if (r.effects?.length && /\bmore\b/.test(text)) addWanted.add(r.effects[0]);
  for (const want of addWanted) {
    if (p.effects.length >= 5) break;
    const def = effects.find((e) => fuzzy(e.id, want) || e.name.toLowerCase() === want);
    if (def && !p.effects.some((e) => e.effectId === def.id)) {
      p.effects.push({ effectId: def.id, params: effectParams(def, intent.energy, rnd), enabled: true });
      p.modulations.push(...fxModulations([p.effects[p.effects.length - 1]], effects, intent.energy, rnd).map((m) => ({ ...m, target: m.target.replace(/^fx\.0\./, `fx.${p.effects.length - 1}.`) })));
      changes.push(`added ${def.name.toLowerCase()}`);
    }
  }

  // intensity
  if (MORE_RE.test(text)) {
    p.modulations = p.modulations.map((m) => ({ ...m, amount: Math.round(clamp(m.amount * 1.4, -1, 1) * 100) / 100 }));
    const scene = scenes.find((s) => s.id === p.sceneId);
    if (scene && p.modulations.length < 10) {
      const extra = sceneModulations(scene, 1, rnd).filter((m) => !p.modulations.some((x) => x.target === m.target));
      p.modulations.push(...extra.slice(0, 2));
    }
    changes.push('pushed the reactivity');
  } else if (LESS_RE.test(text)) {
    p.modulations = p.modulations.map((m) => ({ ...m, amount: Math.round(m.amount * 0.6 * 100) / 100 }));
    const before = p.effects.length;
    const keep = p.effects.map((e) => effects.find((d) => d.id === e.effectId)?.category !== 'glitch');
    const remap = new Map<number, number>();
    let j = 0;
    keep.forEach((k, i) => {
      if (k) remap.set(i, j++);
    });
    p.effects = p.effects.filter((_, i) => keep[i]);
    p.modulations = p.modulations
      .map((m) => {
        const mm = /^fx\.(\d+)\.(.+)$/.exec(m.target);
        if (!mm) return m;
        const ni = remap.get(Number(mm[1]));
        return ni === undefined ? null : { ...m, target: `fx.${ni}.${mm[2]}` };
      })
      .filter((m): m is PresetModulation => m !== null);
    changes.push(before !== p.effects.length ? 'calmed it and dropped the glitch' : 'calmed the motion');
  }

  // palette
  const rulePalettes = intent.rules.flatMap((r) => r.palettes ?? []).filter((id) => palettes.some((x) => x.id === id));
  let nextPalette: Palette | undefined;
  if (DARK_RE.test(text)) {
    const dark = palettes.filter((x) => !isLightPalette(x));
    nextPalette = dark.find((x) => rulePalettes.includes(x.id)) ?? dark[Math.floor(rnd() * dark.length)];
  } else if (LIGHT_RE.test(text)) {
    const light = palettes.filter((x) => isLightPalette(x));
    nextPalette = light.find((x) => rulePalettes.includes(x.id)) ?? light[Math.floor(rnd() * light.length)];
  } else if (rulePalettes.length && intent.rules.some((r) => r.palettes && !r.scenes && !r.effects)) {
    nextPalette = palettes.find((x) => x.id === rulePalettes[0]);
  }
  if (nextPalette && nextPalette.id !== p.palette.id) {
    p.palette = { ...nextPalette };
    changes.push(`moved to ${nextPalette.name}`);
  }

  if (!changes.length) {
    // nothing specific understood: nudge params so the edit is visible
    const scene = scenes.find((s) => s.id === p.sceneId);
    if (scene) p.sceneParams = { ...p.sceneParams, ...tweakParams(scene.params, intent.energy, rnd, 0.2) };
    changes.push('nudged the scene params');
  }
  p.id = `local-${slug(p.name)}-${Math.floor(rnd() * 1e6).toString(36)}`;
  p.tags = [...new Set([...(p.tags ?? []), ...intent.tags])].slice(0, 8);
  p.custom = true;
  return { preset: p, note: `Offline director ${changes.join(', ')}.` };
}

/* ───────────────────────── shader templates ───────────────────────── */

interface ShaderTemplate {
  key: string;
  name: string;
  description: string;
  fragment: string;
  params: ParamDef[];
  modulations: CustomShaderSpec['modulations'];
  fits: RegExp;
}

const SHADERS: ShaderTemplate[] = [
  {
    key: 'rings',
    name: 'Ripple Rings',
    description: 'Concentric rings pushed by the bass, spectrum spokes that flare on kicks.',
    fits: /\b(ring|ripple|circle|radial|pulse|sonar|target|heavy|bass|dubstep)\b/,
    fragment: `void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float r = length(p);
  float a = atan(p.y, p.x);
  float rings = sin(r * u_density - uTime * (1.0 + u_speed * 3.0) - uBass * 6.0);
  float spokes = spectrum(fract(a / TAU + 0.5)) * (0.6 + uKick);
  float m = smoothstep(0.02 + u_soft * 0.05, 0.0, abs(rings) * r - spokes * 0.05);
  vec3 col = mix(uBg, uAccent, m);
  col = mix(col, uAccent2, smoothstep(0.35 + uEnergy * 0.2, 0.0, r) * uKick);
  col = mix(col, uFg, uDrop * 0.2 * m);
  gl_FragColor = vec4(col, 1.0);
}`,
    params: [
      { id: 'density', label: 'Ring density', type: 'number', min: 4, max: 80, step: 1, default: 28 },
      { id: 'speed', label: 'Speed', type: 'number', min: 0, max: 1, default: 0.35 },
      { id: 'soft', label: 'Softness', type: 'number', min: 0, max: 1, default: 0.2 },
    ],
    modulations: [
      { source: 'sub', param: 'density', amount: 0.15 },
      { source: 'energy', param: 'speed', amount: 0.3 },
    ],
  },
  {
    key: 'marble',
    name: 'Marble Drift',
    description: 'Domain-warped liquid marble; sub swells the warp, kicks light the veins.',
    fits: /\b(marble|liquid|fluid|dream\w*|ink|oil|gold|smoke|silk|calm|ambient|sad|rain)\b/,
    fragment: `void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0) * u_scale;
  float t = uTime * (0.04 + 0.12 * u_speed) + uSway * 0.15;
  vec2 q = vec2(fbm(p + t, 4), fbm(p + vec2(5.2, 1.3) - t, 4));
  vec2 r = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2) + uBass * u_warp * 0.6, 4),
                fbm(p + 3.0 * q + vec2(8.3, 2.8) - uSub * u_warp * 0.6, 4));
  float f = fbm(p + (1.5 + u_warp * 2.0 + uSub * 1.5) * r, 5);
  float v = 0.5 + 0.5 * f;
  vec3 col = mix(uBg, uAccent, smoothstep(0.25, 0.85, v));
  col = mix(col, uAccent2, smoothstep(0.6, 1.1, length(q)) * (0.35 + uKick * 0.65));
  float veins = smoothstep(0.06, 0.0, abs(fract(v * u_bands + t) - 0.5) - 0.44);
  col = mix(col, uFg, veins * (0.15 + 0.35 * uHat));
  gl_FragColor = vec4(col, 1.0);
}`,
    params: [
      { id: 'scale', label: 'Scale', type: 'number', min: 0.5, max: 6, default: 2.2 },
      { id: 'speed', label: 'Drift', type: 'number', min: 0, max: 1, default: 0.3 },
      { id: 'warp', label: 'Warp', type: 'number', min: 0, max: 2, default: 0.8 },
      { id: 'bands', label: 'Veins', type: 'number', min: 1, max: 24, step: 1, default: 7 },
    ],
    modulations: [
      { source: 'bass', param: 'warp', amount: 0.25 },
      { source: 'energy', param: 'speed', amount: 0.2 },
    ],
  },
  {
    key: 'grid',
    name: 'Pulse Grid',
    description: 'An instrument-board grid of squares sized by the spectrum; kicks pop random cells.',
    fits: /\b(grid|board|pixel\w*|techno|house|step|sequenc\w*|data|editorial|paper|lofi|retro|minimal|club)\b/,
    fragment: `void main() {
  vec2 uv = vUv * vec2(uAspect, 1.0);
  vec2 g = uv * u_cells;
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  float x = clamp(id.x / max(1.0, u_cells * uAspect), 0.0, 1.0);
  float s = spectrum(x);
  float h = hash21(id + floor(uBeatCount * 0.25));
  float size = 0.06 + 0.36 * s * u_gain + 0.12 * uKick * step(0.75, h);
  float d = sdBox(f, vec2(size));
  float fill = smoothstep(0.015, 0.0, d);
  float grid = smoothstep(0.47, 0.5, max(abs(f.x), abs(f.y)));
  vec3 col = mix(uBg, uMuted, grid * u_lines);
  vec3 ink = mix(uAccent, uAccent2, step(0.85, h) * uSnare);
  col = mix(col, ink, fill);
  col = mix(col, uFg, uDrop * 0.15);
  gl_FragColor = vec4(col, 1.0);
}`,
    params: [
      { id: 'cells', label: 'Cells', type: 'number', min: 4, max: 48, step: 1, default: 16 },
      { id: 'gain', label: 'Gain', type: 'number', min: 0, max: 2, default: 1 },
      { id: 'lines', label: 'Grid lines', type: 'number', min: 0, max: 1, default: 0.6 },
    ],
    modulations: [{ source: 'energy', param: 'gain', amount: 0.25 }],
  },
];

function localShader(req: DirectorRequest, rnd: () => number): { shader: CustomShaderSpec; note: string } {
  const text = `${req.prompt} ${(req.track?.tags ?? []).join(' ')}`.toLowerCase();
  const weighted = SHADERS.map((s) => ({ item: s, w: (s.fits.test(text) ? 3 : 0.5) + rnd() }));
  weighted.sort((a, b) => b.w - a.w);
  const t = weighted[0].item;
  const energy = readIntent(req).energy;
  const params = t.params.map((p) => {
    if (p.type !== 'number') return { ...p };
    const range = p.max - p.min;
    return { ...p, default: quantize(p, p.default + range * (rnd() * 2 - 1) * 0.12 + range * energy * 0.05) };
  });
  const id = `local-${t.key}-${Math.floor(rnd() * 1e6).toString(36)}`;
  return {
    shader: { id, name: t.name, description: t.description, fragment: t.fragment, params, modulations: t.modulations?.map((m) => ({ ...m })) },
    note: `Offline director can't write new GLSL, so it adapted the "${t.name}" template to your prompt.`,
  };
}

/* ───────────────────────── entry ───────────────────────── */

/** Offline fallback for the AI director. Only references ids that exist in the registries. */
export function localDirect(req: DirectorRequest, inputs: LocalInputs = {}): DirectorResponse {
  const scenes = (inputs.scenes ?? allScenes()).filter((s) => !s.tags.includes('generated'));
  const effects = inputs.effects ?? allEffects();
  const palettes = inputs.palettes?.length ? inputs.palettes : PALETTES;
  const rnd = seededRandom(`${req.mode}|${req.prompt}|${req.current?.id ?? ''}|${req.track?.bpm ?? ''}`);

  if (req.mode === 'shader') {
    const { shader, note } = localShader(req, rnd);
    return { shader, note, source: 'local' };
  }

  const current = req.current;
  const isEdit = !!current && EDIT_RE.test(req.prompt.toLowerCase());
  const { preset, note } = isEdit
    ? editPreset(req, current!, scenes, effects, palettes, rnd)
    : freshPreset(req, scenes, effects, palettes, rnd);
  if (!preset.sceneId) {
    return { preset, note: `${note} (No scenes are registered yet, so the scene is empty.)`, source: 'local' };
  }
  return { preset, note, source: 'local' };
}
