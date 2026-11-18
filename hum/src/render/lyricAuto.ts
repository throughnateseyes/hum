import type { AudioFrame, Palette, TrackAnalysis } from '../core/types';
import { hash } from '../scenes/board/kit';

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
  punchy: 'punchy: words slam in, cutouts on the drop',
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

export interface AutoLayout {
  treatment: Treatment;
  size: number;
  words: Placed[];
  cx: number;
  cy: number;
}

interface Style {
  weight: number;
  family: string;
  track: number;
  upper: boolean;
  lower: boolean;
  /** base size as a share of min(H × 1.45, W) */
  base: number;
}

const SANS = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const STYLES: Record<Treatment, Style> = {
  tender: { weight: 300, family: SANS, track: 0.16, upper: false, lower: true, base: 0.058 },
  dreamy: { weight: 400, family: SANS, track: 0.08, upper: false, lower: true, base: 0.06 },
  punchy: { weight: 900, family: SANS, track: -0.01, upper: true, lower: false, base: 0.072 },
  aggressive: { weight: 400, family: 'Impact, Haettenschweiler, "Arial Narrow Bold", "Arial Black", sans-serif', track: 0.01, upper: true, lower: false, base: 0.08 },
};

function font(st: Style, px: number) {
  return `${st.weight} ${px.toFixed(1)}px ${st.family}`;
}

function caseOf(st: Style, s: string) {
  return st.upper ? s.toUpperCase() : st.lower ? s.toLowerCase() : s;
}

/** lay one line out: emphasis per word from how it's sung, wrapped and fitted (with room to swell) */
export function buildAuto(g: CanvasRenderingContext2D, words: AWord[], timed: boolean, an: TrackAnalysis | null | undefined, W: number, H: number, treatment: Treatment): AutoLayout {
  const st = STYLES[treatment];
  const base = Math.min(H * 1.45, W) * st.base;
  // emphasis: held longer than the line's typical word, and/or sung over a louder moment
  const durs = words.map((w) => Math.max(0.01, w.end - w.t));
  const med = [...durs].sort((a, b) => a - b)[Math.floor(durs.length / 2)] || 0.3;
  const loud = words.map((w) => curveAt(an?.energyCurve, (w.t + w.end) / 2, an?.duration ?? 0));
  const mean = loud.reduce((a, b) => a + b, 0) / Math.max(1, loud.length);
  const ks = words.map((_, i) => {
    const held = Math.min(1, Math.max(0, (durs[i] / med - 1) / 1.5));
    const lo = Math.min(1, Math.max(0, (loud[i] - mean) * 5 + 0.5));
    const e = (timed ? 0.6 : 0.25) * held + (timed ? 0.4 : 0.35) * lo;
    return 0.88 + 0.5 * e;
  });

  g.letterSpacing = '0px';
  const measure = (text: string, px: number) => {
    g.font = font(st, px);
    g.letterSpacing = `${(px * st.track).toFixed(2)}px`;
    const w = g.measureText(text).width;
    g.letterSpacing = '0px';
    return w;
  };

  let scale = 1;
  for (let tries = 0; tries < 8; tries++) {
    const sz = base * scale;
    const space = sz * (0.3 + st.track);
    const maxW = W * 0.8;
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
    if ((rows.length > 4 || totalH > H * 0.62 || widest > maxW) && tries < 7) {
      scale *= 0.87;
      continue;
    }
    const out: Placed[] = [];
    let y = (H - totalH) / 2;
    rows.forEach((row, ri) => {
      const rw = row.reduce((a, it) => a + it.w, 0) + space * (row.length - 1);
      let rx = (W - rw) / 2;
      const baseY = y + rowH[ri] * 0.8;
      for (const it of row) {
        out.push({ text: it.text, t: it.t, k: it.k, x: rx, y: baseY, w: it.w });
        rx += it.w + space;
      }
      y += rowH[ri];
    });
    return { treatment, size: sz, words: out, cx: W / 2, cy: H / 2 };
  }
  return { treatment, size: base, words: [], cx: W / 2, cy: H / 2 };
}

const ease = (x: number) => 1 - (1 - x) ** 3;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (hex: string, a: number) => {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};

/**
 * Draw a laid-out line at time t. `energy` is how hard the music is going right now (0..1),
 * `drop` whether a drop is happening; both push the treatment further.
 */
export function drawAuto(g: CanvasRenderingContext2D, L: AutoLayout, t: number, alpha: number, pal: Palette, a: AudioFrame, energy: number, drop: boolean) {
  const st = STYLES[L.treatment];
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
  // the same legibility as the big style: a soft shadow in the scene's background colour
  g.shadowColor = rgba(pal.bg, 0.55);
  g.shadowBlur = sz * 0.5;

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
    let color = pal.fg;
    let op = alpha;
    let dx = 0;
    let dy = 0;
    let s = 1;

    if (tr === 'tender') {
      // slow fade, settling up from below; held or louder words warm to the accent on big moments
      const k = clamp01(age / (0.75 + (w.k - 0.88) * 0.8));
      op *= ease(k);
      dy = (1 - ease(k)) * px * 0.35;
      if (loud && (drop || energy > 0.6)) color = pal.accent;
    } else if (tr === 'dreamy') {
      const k = clamp01(age / 0.65);
      op *= ease(k);
      dy = Math.sin(t * 0.9 + i * 1.7) * px * 0.06 - (1 - ease(k)) * px * 0.2;
      dx = Math.cos(t * 0.6 + i * 2.3) * px * 0.04;
      const blur = (1 - ease(k)) * px * 0.22;
      g.filter = blur > 0.3 ? `blur(${blur.toFixed(1)}px)` : 'none';
      if (current && (drop || energy > 0.65)) color = pal.accent;
    } else if (tr === 'punchy') {
      const k = clamp01(age / 0.14);
      s = 1 + (drop ? 0.9 : 0.55) * (1 - k) ** 2;
      if (current) color = pal.accent;
    } else {
      const k = clamp01(age / 0.1);
      s = 1 + 0.35 * (1 - k) ** 2;
      if (current || (drop && loud)) color = pal.accent;
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
        g.fillStyle = pal.accent2;
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
