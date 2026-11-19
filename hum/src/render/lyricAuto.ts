import type { AudioFrame, TrackAnalysis } from '../core/types';
import { hash } from '../scenes/board/kit';
import { LYRIC_FAMILIES } from './lyricFonts';

/**
 * Auto lyrics: the treatment follows what the song feels like.
 *
 *   tender      melancholic, tender, calm songs: light type, wide letter-spacing, each word fades
 *               in slowly and settles from a little below
 *   dreamy      spacious, dreamy, ambient songs: words blur in and float
 *   punchy      euphoric, energetic, driving songs: heavy capitals that slam in word by word and
 *               swell on the kick; drops switch to the newspaper cutouts
 *   aggressive  aggressive, heavy songs: condensed capitals that shake with the energy, with a
 *               ghost copy knocked off by the kick
 *
 * Inside a line, words that are held longer or sung over a louder moment are set bigger, and
 * drops get the strongest version of the treatment. Layout is fixed per line (sizes come from the
 * song data, not randomness), so nothing reflows while a line is up; only the motion changes.
 */

export type Treatment = 'tender' | 'dreamy' | 'punchy' | 'aggressive';

const WORDS: Record<Treatment, string[]> = {
  tender: ['melancholic', 'sad', 'tender', 'heartbroken', 'lonely', 'wistful', 'bittersweet', 'nostalgic', 'romantic', 'calm', 'gentle', 'longing', 'mournful', 'somber', 'sombre', 'grief', 'intimate', 'soft', 'sorrow', 'acoustic', 'slow'],
  dreamy: ['dreamy', 'spacious', 'ethereal', 'ambient', 'hypnotic', 'floaty', 'hazy', 'chill', 'lofi', 'lo-fi', 'serene', 'peaceful', 'atmospheric', 'mysterious', 'cinematic'],
  aggressive: ['aggressive', 'angry', 'intense', 'menacing', 'furious', 'raw', 'gritty', 'defiant', 'heavy', 'rage', 'brutal', 'dark', 'tense'],
  punchy: ['euphoric', 'energetic', 'driving', 'upbeat', 'happy', 'joyful', 'uplifting', 'bouncy', 'playful', 'fast', 'triumphant', 'party', 'confident', 'hype', 'fun', 'groovy', 'dance'],
};

const LABELS: Record<Treatment, string> = {
  tender: 'tender: soft fades, wide spacing',
  dreamy: 'dreamy: words blur in and float',
  punchy: 'punchy: words slam in on the beat',
  aggressive: 'aggressive: heavy type that shakes',
};

function match(word: string): Treatment | null {
  const w = word.toLowerCase();
  for (const k of Object.keys(WORDS) as Treatment[]) if (WORDS[k].some((x) => w.includes(x))) return k;
  return null;
}

/** which treatment fits this song: the heard mood first, then the mood tags, then the numbers */
export function treatmentFor(an: TrackAnalysis | null | undefined): { id: Treatment; label: string; from: string } {
  const pick = (id: Treatment, from: string) => ({ id, label: LABELS[id], from });
  if (!an) return pick('punchy', 'no analysis yet');
  const mood = an.character?.mood;
  if (mood) {
    const m = match(mood);
    if (m) return pick(m, `“${mood}”`);
  }
  for (const tag of an.tags ?? []) {
    const m = match(tag);
    if (m) return pick(m, `“${tag}”`);
  }
  const p = an.mood;
  if (p) {
    if (p.arousal > 0.66 && p.valence < 0.5) return pick('aggressive', 'loud and dark');
    if (p.arousal > 0.55) return pick('punchy', 'high energy');
    if (p.density < 0.4) return pick('dreamy', 'sparse');
    return pick('tender', 'low energy');
  }
  return pick('punchy', 'default');
}

/** a drop is happening: the live detector, a drop section, or the first bars after a mapped drop */
export function dropMoment(an: TrackAnalysis | null | undefined, t: number, a: AudioFrame): boolean {
  if (a.drop > 0.55) return true;
  if (!an) return false;
  for (const s of an.sections) if (t >= s.start && t < s.end) return s.label === 'drop';
  return an.drops.some((d) => t >= d && t < d + 8);
}

function curveAt(c: Float32Array | undefined, t: number, duration: number) {
  if (!c?.length || !(duration > 0)) return 0.5;
  const i = Math.min(c.length - 1, Math.max(0, Math.round((t / duration) * (c.length - 1))));
  return c[i];
}

interface AWord {
  text: string;
  t: number;
  end: number;
}

interface Placed {
  text: string;
  t: number;
  /** size multiplier from emphasis (held longer / sung louder) */
  k: number;
  x: number;
  y: number;
  w: number;
}

/** pixel box text is fitted into */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface AutoLayout {
  treatment: Treatment;
  style: Style;
  size: number;
  words: Placed[];
  cx: number;
  cy: number;
  /** each row's box (for plates and bands behind it) */
  rows: { x: number; y: number; w: number; h: number }[];
}

export interface Style {
  weight: number;
  family: string;
  track: number;
  upper: boolean;
  lower: boolean;
  italic?: boolean;
  /** base size as a share of min(H × 1.45, W) */
  base: number;
}

const SANS = LYRIC_FAMILIES.grotesk;
const STYLES: Record<Treatment, Style> = {
  tender: { weight: 300, family: SANS, track: 0.16, upper: false, lower: true, base: 0.058 },
  dreamy: { weight: 400, family: SANS, track: 0.08, upper: false, lower: true, base: 0.06 },
  punchy: { weight: 900, family: SANS, track: -0.01, upper: true, lower: false, base: 0.072 },
  aggressive: { weight: 400, family: 'Impact, Haettenschweiler, "Arial Narrow Bold", "Arial Black", sans-serif', track: 0.01, upper: true, lower: false, base: 0.08 },
};

/** the song's type family: one per song, so the whole video speaks with one voice (bundled fonts) */
export const FAMILY_FONTS: Record<string, string> = LYRIC_FAMILIES;

/**
 * The motion's style set in the song's family, varied a little per part (`variant` 0..1 from the
 * seed): a different weight, case or tracking, so parts differ but still belong together.
 */
export function styleFor(treatment: Treatment, family?: string, variant = 0.5): Style {
  const st = { ...STYLES[treatment] };
  if (!family || !FAMILY_FONTS[family]) return st;
  st.family = FAMILY_FONTS[family];
  const heavy = treatment === 'punchy' || treatment === 'aggressive';
  if (family === 'serif') {
    st.weight = heavy ? 700 : 400;
    st.italic = !heavy && variant > 0.45;
    st.track = heavy ? 0 : 0.03;
    st.upper = heavy && variant > 0.5;
    st.lower = !st.upper && treatment === 'tender' && variant < 0.3;
  } else if (family === 'condensed') {
    st.weight = heavy ? 800 : 600;
    st.upper = true;
    st.lower = false;
    st.track = heavy ? 0.01 : 0.06;
    st.base *= 1.12;
  } else if (family === 'mono') {
    st.weight = heavy ? 700 : 400;
    st.track = 0.02;
    st.upper = variant > 0.5;
    st.lower = !st.upper;
    st.base *= 0.9;
  } else if (family === 'rounded') {
    st.weight = heavy ? 800 : 500;
    st.track = heavy ? 0 : 0.04;
  } else if (family === 'hand') {
    // handwriting: never all caps, a little bigger (the x-height is small)
    st.weight = heavy ? 700 : 500;
    st.track = 0;
    st.upper = false;
    st.lower = false;
    st.base *= 1.18;
  } else if (family === 'typewriter') {
    st.weight = heavy ? 700 : 400;
    st.track = 0.03;
    st.upper = heavy;
    st.lower = !heavy;
    st.base *= 0.92;
  } else {
    // grotesk: weight wanders around the motion's own
    st.weight = Math.max(200, Math.min(900, st.weight + Math.round((variant - 0.5) * 4) * 100));
    if (!heavy) st.upper = variant > 0.8;
    if (st.upper) st.lower = false;
  }
  return st;
}

function font(st: Style, px: number) {
  return `${st.italic ? 'italic ' : ''}${st.weight} ${px.toFixed(1)}px ${st.family}`;
}

function caseOf(st: Style, s: string) {
  return st.upper ? s.toUpperCase() : st.lower ? s.toLowerCase() : s;
}

/**
 * Lay one line out: emphasis per word from how it's sung, wrapped and fitted (with room to swell)
 * into `box`, aligned left, centre or right. `scale` sizes the type (sparse lines smaller, giant
 * lines huge); `maxRows` caps the wrap; `boost` sets some words (the key words) bigger.
 */
export function buildAuto(
  g: CanvasRenderingContext2D,
  words: AWord[],
  timed: boolean,
  an: TrackAnalysis | null | undefined,
  W: number,
  H: number,
  treatment: Treatment,
  o: { style?: Style; box?: Box; align?: 'left' | 'center' | 'right'; scale?: number; maxRows?: number; boost?: { index: number[]; k: number } } = {},
): AutoLayout {
  const st = o.style ?? STYLES[treatment];
  const box = o.box ?? { x0: W * 0.1, y0: H * 0.19, x1: W * 0.9, y1: H * 0.81 };
  const align = o.align ?? 'center';
  const base = Math.min(H * 1.45, W) * st.base * (o.scale ?? 1);
  // emphasis: held longer than the line's typical word, and/or sung over a louder moment
  const durs = words.map((w) => Math.max(0.01, w.end - w.t));
  const med = [...durs].sort((a, b) => a - b)[Math.floor(durs.length / 2)] || 0.3;
  const loud = words.map((w) => curveAt(an?.energyCurve, (w.t + w.end) / 2, an?.duration ?? 0));
  const mean = loud.reduce((a, b) => a + b, 0) / Math.max(1, loud.length);
  const ks = words.map((_, i) => {
    const held = Math.min(1, Math.max(0, (durs[i] / med - 1) / 1.5));
    const lo = Math.min(1, Math.max(0, (loud[i] - mean) * 5 + 0.5));
    const e = (timed ? 0.6 : 0.25) * held + (timed ? 0.4 : 0.35) * lo;
    return words.length === 1 ? 1 : 0.88 + 0.5 * e;
  });
  // key words set bigger than the rest (the giant moment, sparse lines)
  if (o.boost) for (const i of o.boost.index) if (ks[i] !== undefined) ks[i] *= o.boost.k;

  g.letterSpacing = '0px';
  const measure = (text: string, px: number) => {
    g.font = font(st, px);
    g.letterSpacing = `${(px * st.track).toFixed(2)}px`;
    const w = g.measureText(text).width;
    g.letterSpacing = '0px';
    return w;
  };

  const maxW = box.x1 - box.x0;
  const maxH = box.y1 - box.y0;
  const maxRows = o.maxRows ?? 4;
  let scale = 1;
  for (let tries = 0; tries < 12; tries++) {
    const sz = base * scale;
    const space = sz * (0.3 + st.track);
    const items = words.map((w, i) => ({ text: caseOf(st, w.text), t: w.t, k: ks[i], w: measure(caseOf(st, w.text), sz * ks[i]) }));
    const rows: (typeof items)[] = [[]];
    let x = 0;
    for (const it of items) {
      const row = rows[rows.length - 1];
      if (row.length && x + space + it.w > maxW) {
        rows.push([it]);
        x = it.w;
      } else {
        row.push(it);
        x += (row.length > 1 ? space : 0) + it.w;
      }
    }
    const rowH = rows.map((r) => Math.max(...r.map((it) => it.k)) * sz * 1.12);
    const totalH = rowH.reduce((a, b) => a + b, 0);
    const widest = Math.max(...items.map((it) => it.w));
    if ((rows.length > maxRows || totalH > maxH || widest > maxW) && tries < 11) {
      scale *= 0.88;
      continue;
    }
    const out: Placed[] = [];
    const rowBoxes: AutoLayout['rows'] = [];
    let y = box.y0 + (maxH - totalH) / 2;
    rows.forEach((row, ri) => {
      const rw = row.reduce((a, it) => a + it.w, 0) + space * (row.length - 1);
      let rx = align === 'left' ? box.x0 : align === 'right' ? box.x1 - rw : box.x0 + (maxW - rw) / 2;
      const baseY = y + rowH[ri] * 0.8;
      rowBoxes.push({ x: rx, y: y + rowH[ri] * 0.08, w: rw, h: rowH[ri] * 0.86 });
      for (const it of row) {
        out.push({ text: it.text, t: it.t, k: it.k, x: rx, y: baseY, w: it.w });
        rx += it.w + space;
      }
      y += rowH[ri];
    });
    const cx = rowBoxes.length ? (Math.min(...rowBoxes.map((r) => r.x)) + Math.max(...rowBoxes.map((r) => r.x + r.w))) / 2 : W / 2;
    return { treatment, style: st, size: sz, words: out, cx, cy: box.y0 + maxH / 2, rows: rowBoxes };
  }
  return { treatment, style: st, size: base, words: [], cx: W / 2, cy: H / 2, rows: [] };
}

const ease = (x: number) => 1 - (1 - x) ** 3;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** colours to draw with: the guard's ink, the accent for the current word (only when it reads), the ghost */
export interface Inks {
  ink: string;
  accent: string;
  accent2: string;
  /** sets the glyph shadow (from the guard's backing) */
  shadow: (g: CanvasRenderingContext2D, size: number) => void;
}

/**
 * Draw a laid-out line at time t. `energy` is how hard the music is going right now (0..1),
 * `drop` whether a drop is happening; both push the treatment further.
 */
export function drawAuto(g: CanvasRenderingContext2D, L: AutoLayout, t: number, alpha: number, c: Inks, a: AudioFrame, energy: number, drop: boolean) {
  const st = L.style;
  const tr = L.treatment;
  const sz = L.size;
  // the whole line swells a little with the music (around the centre, no reflow)
  const swell = 1 + 0.06 * energy + (tr === 'punchy' ? a.kick * (drop ? 0.07 : 0.035) : 0) + (drop && tr !== 'punchy' ? 0.05 : 0);
  g.save();
  g.translate(L.cx, L.cy);
  g.scale(swell, swell);
  g.translate(-L.cx, -L.cy);
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  c.shadow(g, sz);

  let lastSung = -1;
  L.words.forEach((w, i) => {
    if (w.t <= t) lastSung = i;
  });
  const frame = Math.floor(t * 20);

  L.words.forEach((w, i) => {
    const age = t - w.t;
    if (age < 0) return;
    const px = sz * w.k;
    const current = i === lastSung;
    const loud = w.k > 1.08;
    g.font = font(st, px);
    g.letterSpacing = `${(px * st.track).toFixed(2)}px`;
    let color = c.ink;
    let op = alpha;
    let dx = 0;
    let dy = 0;
    let s = 1;

    if (tr === 'tender') {
      // slow fade, settling up from below; held or louder words warm to the accent on big moments
      const k = clamp01(age / (0.75 + (w.k - 0.88) * 0.8));
      op *= ease(k);
      dy = (1 - ease(k)) * px * 0.35;
      if (loud && (drop || energy > 0.6)) color = c.accent;
    } else if (tr === 'dreamy') {
      const k = clamp01(age / 0.65);
      op *= ease(k);
      dy = Math.sin(t * 0.9 + i * 1.7) * px * 0.06 - (1 - ease(k)) * px * 0.2;
      dx = Math.cos(t * 0.6 + i * 2.3) * px * 0.04;
      const blur = (1 - ease(k)) * px * 0.22;
      g.filter = blur > 0.3 ? `blur(${blur.toFixed(1)}px)` : 'none';
      if (current && (drop || energy > 0.65)) color = c.accent;
    } else if (tr === 'punchy') {
      const k = clamp01(age / 0.14);
      s = 1 + (drop ? 0.9 : 0.55) * (1 - k) ** 2;
      if (current) color = c.accent;
    } else {
      const k = clamp01(age / 0.1);
      s = 1 + 0.35 * (1 - k) ** 2;
      if (current || (drop && loud)) color = c.accent;
    }

    g.save();
    const cx = w.x + w.w / 2 + dx;
    const cy = w.y - px * 0.35 + dy;
    g.translate(cx, cy);
    g.scale(s, s);
    g.translate(-w.w / 2, px * 0.35);
    g.globalAlpha = op;

    if (tr === 'aggressive') {
      // shaking letters: a seeded jitter per letter that changes 20 times a second, harder on drops
      const shake = px * (0.02 + 0.05 * energy + 0.05 * a.kick) * (drop ? 1.4 : 1);
      // a ghost copy knocked sideways by the kick
      if (a.kick > 0.15 || drop) {
        g.save();
        g.shadowBlur = 0;
        g.globalAlpha = op * 0.45;
        g.fillStyle = c.accent2;
        g.fillText(w.text, px * (0.03 + a.kick * 0.06), -px * 0.02);
        g.restore();
      }
      g.fillStyle = color;
      let lx = 0;
      const chars = [...w.text];
      chars.forEach((ch, ci) => {
        const jx = (hash(frame, i * 31 + ci, 1) - 0.5) * 2 * shake;
        const jy = (hash(frame, i * 31 + ci, 2) - 0.5) * 2 * shake;
        g.fillText(ch, lx + jx, jy);
        lx += g.measureText(ch).width;
      });
    } else {
      g.fillStyle = color;
      g.fillText(w.text, 0, 0);
    }
    g.restore();
    g.filter = 'none';
  });
  g.letterSpacing = '0px';
  g.restore();
}
