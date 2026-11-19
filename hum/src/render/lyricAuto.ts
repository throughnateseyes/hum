import type { AudioFrame, TrackAnalysis } from '../core/types';
import { FACES, LYRIC_FAMILIES } from './lyricFonts';

/**
 * Lyric type, set the way a motion designer would set it: a few real treatments in the bundled
 * faces, one line at a time, placed on the picture's composition, revealed as the voice sings.
 *
 * Roles (what a line is doing on screen):
 *   caption   a quiet subtitle: Inter (or the song's serif / mono) at a reading size, sentence case.
 *             The whole line is up at low opacity; each word brightens with a wipe as it's sung.
 *   display   the line large: Playfair with tight tracking and a true italic for the key word, Inter
 *             set tight, Oswald in tracked capitals (one line, never stacked blocks), or mono typed
 *             out. Words appear only as they're sung, rising out of a mask at their baseline.
 *   aside     the line small and quiet in a margin (builds, intros, breaks).
 *   giant     the one-off drop moment: the key word huge on a third, the rest of the line as a small
 *             tracked kicker above it.
 *
 * Motion (one per song, from its mood) only changes timing and how a word arrives, never wobbles:
 *   tender      slow masked rise (0.55 s), tracking opens on held notes
 *   dreamy      soft fade with the tracking settling in, opens on held notes
 *   punchy      quick masked rise (0.16 s), the weight settles as the word lands
 *   aggressive  words cut on (no fade), the weight settles hard; on a drop it leans on the kick
 *
 * Layout is fixed per line (rows are balanced, nothing reflows while a line is up); only the
 * reveal moves. Sizes are shares of the frame's short side, so 16:9, 1:1 and 9:16 read the same.
 */

export type Treatment = 'tender' | 'dreamy' | 'punchy' | 'aggressive';
export type Role = 'caption' | 'display' | 'aside' | 'giant';

const WORDS: Record<Treatment, string[]> = {
  tender: ['melancholic', 'sad', 'tender', 'heartbroken', 'lonely', 'wistful', 'bittersweet', 'nostalgic', 'romantic', 'calm', 'gentle', 'longing', 'mournful', 'somber', 'sombre', 'grief', 'intimate', 'soft', 'sorrow', 'acoustic', 'slow'],
  dreamy: ['dreamy', 'spacious', 'ethereal', 'ambient', 'hypnotic', 'floaty', 'hazy', 'chill', 'lofi', 'lo-fi', 'serene', 'peaceful', 'atmospheric', 'mysterious', 'cinematic'],
  aggressive: ['aggressive', 'angry', 'intense', 'menacing', 'furious', 'raw', 'gritty', 'defiant', 'heavy', 'rage', 'brutal', 'dark', 'tense'],
  punchy: ['euphoric', 'energetic', 'driving', 'upbeat', 'happy', 'joyful', 'uplifting', 'bouncy', 'playful', 'fast', 'triumphant', 'party', 'confident', 'hype', 'fun', 'groovy', 'dance'],
};

const LABELS: Record<Treatment, string> = {
  tender: 'tender: slow reveals, tracking opens on held notes',
  dreamy: 'dreamy: soft fades, tracking settles in',
  punchy: 'punchy: quick reveals, weight settles on the beat',
  aggressive: 'aggressive: words cut on, heavy weight that settles',
};

function match(word: string): Treatment | null {
  const w = word.toLowerCase();
  for (const k of Object.keys(WORDS) as Treatment[]) if (WORDS[k].some((x) => w.includes(x))) return k;
  return null;
}

/** which motion fits this song: the heard mood first, then the mood tags, then the numbers */
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

/** pixel box text is fitted into */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** the song's type family → its CSS stack. 'rounded' and 'typewriter' (older plans) map to bundled faces. */
export const FAMILY_FONTS: Record<string, string> = {
  ...LYRIC_FAMILIES,
  rounded: LYRIC_FAMILIES.grotesk,
  typewriter: LYRIC_FAMILIES.typewriter,
};

/** which voice table a family uses */
function familyKind(family: string | undefined): 'serif' | 'grotesk' | 'condensed' | 'mono' | 'hand' {
  if (family === 'serif' || family === 'condensed' || family === 'mono' || family === 'hand') return family;
  if (family === 'typewriter') return 'mono';
  return 'grotesk';
}

/** one setting of type */
export interface Voice {
  family: string;
  weight: number;
  /** width (Archivo's width axis, through the canvas fontStretch) */
  stretch?: CanvasFontStretch;
  /** held notes widen through these widths (Archivo), as the tracking opens */
  widen?: CanvasFontStretch[];
  /** weight a word arrives at before settling to `weight` (none: arrives as it rests) */
  enter?: number;
  italic?: boolean;
  /** tracking in em */
  track: number;
  case: 'asis' | 'lower' | 'upper';
  /** line height, in sizes */
  leading: number;
  /** size as a share of the frame's short side */
  size: number;
  /** the key word of a line set in its face's true italic (Instrument Serif, Fraunces) */
  italicKey?: boolean;
  /** mono: characters type on, with a caret */
  typed?: boolean;
}

/**
 * The voice for a role in the song's family. `variant` (0..1, from the part's seed) nudges weight a
 * little so parts differ but belong together.
 *
 *   serif      Instrument Serif for tender and dreamy display lines (key word in its true italic) and
 *              the giant word; Fraunces for heavier serif lines and for captions (its optical sizes
 *              keep small text sturdy)
 *   grotesk    Inter Tight throughout: set tight for display, at a reading weight for captions
 *   condensed  Archivo narrowed on its width axis, in capitals; held notes widen it as the tracking
 *              opens. Captions stay in Inter Tight so they read
 *   mono       JetBrains Mono typed out for display, IBM Plex Mono for captions
 *   hand       Caveat (only when picked in the lyrics panel)
 */
export function voiceFor(role: Role | 'kicker', family: string | undefined, tr: Treatment, variant = 0.5): Voice {
  const kind = familyKind(family);
  const heavy = tr === 'punchy' || tr === 'aggressive';
  if (role === 'caption') {
    if (kind === 'serif') return { family: FACES.fraunces, weight: 420, track: 0, case: 'asis', leading: 1.3, size: 0.043 };
    if (kind === 'mono') return { family: FACES.plex, weight: 400, track: 0, case: 'lower', leading: 1.35, size: 0.035 };
    if (kind === 'hand') return { family: FACES.hand, weight: 600, track: 0, case: 'asis', leading: 1.15, size: 0.06 };
    return { family: FACES.tight, weight: 500, track: 0.008, case: 'asis', leading: 1.3, size: 0.042 };
  }
  if (role === 'aside') {
    if (kind === 'serif') return { family: FACES.instrument, weight: 400, italic: true, track: 0.01, case: 'lower', leading: 1.12, size: 0.066 };
    if (kind === 'mono') return { family: FACES.plex, weight: 400, track: 0.02, case: 'lower', leading: 1.4, size: 0.038 };
    if (kind === 'condensed') return { family: FACES.archivo, stretch: 'semi-condensed', weight: 500, track: 0.16, case: 'upper', leading: 1.45, size: 0.036 };
    if (kind === 'hand') return { family: FACES.hand, weight: 500, track: 0, case: 'asis', leading: 1.15, size: 0.058 };
    return { family: FACES.tight, weight: 400, track: 0.01, case: 'lower', leading: 1.28, size: 0.05 };
  }
  if (role === 'kicker') {
    if (kind === 'serif') return { family: FACES.instrument, weight: 400, italic: true, track: 0.01, case: 'asis', leading: 1.1, size: 0.064 };
    if (kind === 'mono') return { family: FACES.plex, weight: 500, track: 0.08, case: 'upper', leading: 1.4, size: 0.032 };
    if (kind === 'hand') return { family: FACES.hand, weight: 500, track: 0, case: 'asis', leading: 1.15, size: 0.055 };
    if (kind === 'condensed') return { family: FACES.archivo, stretch: 'semi-condensed', weight: 600, track: 0.2, case: 'upper', leading: 1.5, size: 0.034 };
    return { family: FACES.tight, weight: 600, track: 0.14, case: 'upper', leading: 1.5, size: 0.031 };
  }
  if (role === 'giant') {
    if (kind === 'serif') return { family: FACES.instrument, weight: 400, italic: true, track: -0.02, case: 'asis', leading: 1, size: 0.36 };
    if (kind === 'condensed') return { family: FACES.archivo, stretch: 'extra-condensed', weight: 800, enter: 400, track: 0, case: 'upper', leading: 1, size: 0.36 };
    if (kind === 'mono') return { family: FACES.mono, weight: 600, track: -0.04, case: 'lower', leading: 1, size: 0.24, typed: true };
    if (kind === 'hand') return { family: FACES.hand, weight: 700, track: 0, case: 'asis', leading: 1, size: 0.34 };
    return { family: FACES.tight, weight: 700, enter: heavy ? 900 : undefined, track: -0.035, case: 'asis', leading: 1, size: 0.3 };
  }
  // display
  const nudge = Math.round((variant - 0.5) * 2) * 50;
  if (kind === 'serif') {
    if (heavy) return { family: FACES.fraunces, weight: 560 + nudge, enter: tr === 'aggressive' ? 800 : undefined, track: -0.02, case: 'asis', leading: 1.04, size: 0.082, italicKey: true };
    return { family: FACES.instrument, weight: 400, track: -0.005, case: 'asis', leading: 1.0, size: 0.104, italicKey: true };
  }
  if (kind === 'condensed') {
    const w = (heavy ? 720 : 600) + nudge;
    return { family: FACES.archivo, stretch: 'condensed', widen: ['condensed', 'semi-condensed'], weight: w, enter: heavy ? 900 : undefined, track: 0.01, case: 'upper', leading: 1.0, size: 0.086 };
  }
  if (kind === 'mono') return { family: FACES.mono, weight: heavy ? 500 : 400, track: -0.02, case: 'lower', leading: 1.22, size: 0.056, typed: true };
  if (kind === 'hand') return { family: FACES.hand, weight: 600, track: 0, case: 'asis', leading: 1.05, size: 0.11 };
  const w = tr === 'aggressive' ? 700 : tr === 'punchy' ? 620 : 480;
  return { family: FACES.tight, weight: w + nudge, enter: heavy ? w + nudge + 220 : undefined, track: -0.018, case: 'asis', leading: 1.02, size: 0.084 };
}

export interface Placed {
  text: string;
  t: number;
  end: number;
  x: number;
  /** baseline */
  y: number;
  /** width at rest */
  w: number;
  size: number;
  voice: Voice;
  italic: boolean;
  /** this word is the giant one / part of the kicker */
  part: 'word' | 'giant' | 'kicker';
  /** held long enough for its tracking to open */
  held: boolean;
}

export interface TypeLayout {
  role: Role;
  treatment: Treatment;
  /** the reading size (for shadows and backings) */
  size: number;
  words: Placed[];
  /** each row's box (for scrims behind it) */
  rows: { x: number; y: number; w: number; h: number }[];
}

/** colours to draw with: the guard's ink and the accent (only when it reads) */
export interface Inks {
  ink: string;
  accent: string;
  accent2: string;
  /** sets the glyph shadow (from the guard's backing) */
  shadow: (g: CanvasRenderingContext2D, size: number) => void;
}

interface AWord {
  text: string;
  t: number;
  end: number;
}

const fontOf = (v: Voice, px: number, italic: boolean, weight = v.weight) => `${italic ? 'italic ' : ''}${Math.round(weight)} ${px.toFixed(1)}px ${v.family}`;

/** a line that arrived in capitals is set in sentence case unless the voice wants capitals */
function caseLine(words: AWord[], v: Voice): string[] {
  const raw = words.map((w) => w.text);
  if (v.case === 'upper') return raw.map((s) => s.toUpperCase());
  if (v.case === 'lower') return raw.map((s) => (s === 'I' || s.startsWith("I'") ? s : s.toLowerCase()));
  const letters = raw.join('').replace(/[^\p{L}]/gu, '');
  if (letters.length > 3 && letters === letters.toUpperCase()) {
    return raw.map((s, i) => {
      const l = s.toLowerCase();
      if (l === 'i' || l.startsWith("i'")) return 'I' + l.slice(1);
      return i === 0 ? l.charAt(0).toUpperCase() + l.slice(1) : l;
    });
  }
  return raw;
}

/** lyric lines end without their comma or full stop (questions and exclamations keep theirs) */
const trimEnd = (s: string) => s.replace(/(?<!\.)[,;.]$/u, '') || s;

/** set a voice's font on a canvas (the font shorthand resets the width, so it's set after) */
export function setFont(g: CanvasRenderingContext2D, v: Voice, px: number, italic: boolean, weight = v.weight, stretch: CanvasFontStretch | undefined = v.stretch) {
  g.font = fontOf(v, px, italic, weight);
  g.fontStretch = stretch ?? 'normal';
}

export function measureWord(g: CanvasRenderingContext2D, text: string, v: Voice, px: number, italic: boolean, track = v.track, weight = v.weight, stretch: CanvasFontStretch | undefined = v.stretch): number {
  setFont(g, v, px, italic, weight, stretch);
  g.letterSpacing = `${(px * track).toFixed(2)}px`;
  // letter-spacing is added after the last letter too: leave it off the width
  const w = g.measureText(text).width - px * track;
  g.letterSpacing = '0px';
  g.fontStretch = 'normal';
  return w;
}

export interface LayoutOpts {
  role: Role;
  voice: Voice;
  treatment: Treatment;
  box: Box;
  align: 'left' | 'center' | 'right';
  /** where the block sits in its box vertically */
  anchor: 'bottom' | 'center';
  maxRows: number;
  /** the frame's short side in canvas pixels (sizes are shares of it) */
  unit: number;
  /** indices of the key words: italic in a serif display line; the giant word in a giant moment */
  key?: number[];
  /** giant moments: the kicker's voice */
  kicker?: Voice;
}

/**
 * Lay one line out: case and trailing punctuation set, rows balanced so the rag is even (no lone
 * word on the last row), fitted inside `box`, aligned on its edge.
 */
export function layoutLine(g: CanvasRenderingContext2D, words: AWord[], o: LayoutOpts): TypeLayout {
  const v = o.voice;
  const texts = caseLine(words, v);
  if (texts.length) texts[texts.length - 1] = trimEnd(texts[texts.length - 1]);
  const keys = new Set(o.key ?? []);
  const boxW = o.box.x1 - o.box.x0;
  const boxH = o.box.y1 - o.box.y0;

  if (o.role === 'giant' && o.kicker && keys.size) {
    return layoutGiant(g, words, texts, keys, o);
  }

  const italicAt = (i: number) => !!v.italic || (!!v.italicKey && keys.has(i));
  // held words open their tracking: room is kept for that (the words after are not up yet)
  const holdOpen = o.role === 'display' || o.role === 'aside';
  const heldAt = (i: number) => holdOpen && !v.typed && words[i].end - words[i].t > 0.7;
  let size = v.size * o.unit;
  for (let tries = 0; tries < 14; tries++) {
    // a held word keeps room for its widest width and its opened tracking
    const widths = texts.map((s, i) => measureWord(g, s, v, size, italicAt(i), v.track + (heldAt(i) ? OPEN : 0), v.weight, heldAt(i) ? (v.widen?.[v.widen.length - 1] ?? v.stretch) : v.stretch));
    const space = measureWord(g, ' ', v, size, false) + size * v.track;
    const total = widths.reduce((a, b) => a + b, 0) + space * Math.max(0, widths.length - 1);
    const widest = Math.max(0, ...widths);
    const n = Math.max(1, Math.ceil(total / boxW));
    const lh = size * v.leading;
    if ((n > o.maxRows || widest > boxW || n * lh > boxH) && tries < 13) {
      size *= 0.92;
      continue;
    }
    // balance the rag: wrap at an even share of the line, widening until it takes no more rows than it must
    const wrapAt = (target: number) => {
      const rows: number[][] = [[]];
      let x = 0;
      widths.forEach((w, i) => {
        const row = rows[rows.length - 1];
        if (row.length && x + space + w > target + 0.5) {
          rows.push([i]);
          x = w;
        } else {
          row.push(i);
          x += (row.length > 1 ? space : 0) + w;
        }
      });
      return rows;
    };
    let rows = wrapAt(boxW);
    for (let f = 1.04; n > 1 && f < 2; f += 0.06) {
      const r = wrapAt(Math.min(boxW, Math.max(widest, (total / n) * f)));
      if (r.length <= n) {
        rows = r;
        break;
      }
    }
    if ((rows.length > o.maxRows || rows.length * lh > boxH) && tries < 13) {
      size *= 0.92;
      continue;
    }
    const blockH = rows.length * lh;
    const top = o.anchor === 'bottom' ? o.box.y1 - blockH : o.box.y0 + (boxH - blockH) / 2;
    const out: Placed[] = [];
    const rowBoxes: TypeLayout['rows'] = [];
    rows.forEach((row, ri) => {
      const rw = row.reduce((a, i) => a + widths[i], 0) + space * (row.length - 1);
      let rx = o.align === 'left' ? o.box.x0 : o.align === 'right' ? o.box.x1 - rw : o.box.x0 + (boxW - rw) / 2;
      const base = top + ri * lh + size * (0.5 * (v.leading - 1) + 0.8);
      rowBoxes.push({ x: rx, y: base - size * 0.78, w: rw, h: size * 1.0 });
      for (const i of row) {
        out.push({ text: texts[i], t: words[i].t, end: words[i].end, x: rx, y: base, w: widths[i], size, voice: v, italic: italicAt(i), part: 'word', held: heldAt(i) });
        rx += widths[i] + space;
      }
    });
    return { role: o.role, treatment: o.treatment, size, words: out, rows: rowBoxes };
  }
  return { role: o.role, treatment: o.treatment, size, words: [], rows: [] };
}

/** tracking a held word opens by (em) */
const OPEN = 0.06;
/** tracking the giant word arrives with before it tightens (em) */
const GIANT_OPEN = 0.14;

function layoutGiant(g: CanvasRenderingContext2D, words: AWord[], texts: string[], keys: Set<number>, o: LayoutOpts): TypeLayout {
  const v = o.voice;
  const kv = o.kicker!;
  const ki = [...keys][0];
  const boxW = o.box.x1 - o.box.x0;
  const boxH = o.box.y1 - o.box.y0;
  // the giant word: as big as fits (with room for the wider tracking it arrives with)
  let gs = v.size * o.unit;
  for (let k = 0; k < 20 && measureWord(g, texts[ki], v, gs, !!v.italic, v.track + GIANT_OPEN) > boxW; k++) gs *= 0.92;
  gs = Math.min(gs, boxH * 0.62);
  const gw = measureWord(g, texts[ki], v, gs, !!v.italic);
  // the kicker: the rest of the line, small, on one or two rows above
  const ks = kv.size * o.unit;
  const kIdx = texts.map((_, i) => i).filter((i) => i !== ki);
  // the kicker is set in its own case (small capitals over a lower-case giant word, say)
  const ktexts = caseLine(words, kv).map((s, i) => (i === words.length - 1 ? trimEnd(s) : s));
  const kw = kIdx.map((i) => measureWord(g, ktexts[i], kv, ks, !!kv.italic));
  const kspace = measureWord(g, ' ', kv, ks, false) + ks * kv.track;
  const kmax = Math.max(gw, boxW * 0.55);
  const krows: number[][] = [[]];
  let x = 0;
  kIdx.forEach((i, j) => {
    const row = krows[krows.length - 1];
    if (row.length && x + kspace + kw[j] > kmax) {
      krows.push([j]);
      x = kw[j];
    } else {
      row.push(j);
      x += (row.length > 1 ? kspace : 0) + kw[j];
    }
  });
  const klh = ks * kv.leading;
  const kH = kIdx.length ? krows.length * klh + ks * 0.5 : 0;
  // italic serif overhangs: the giant baseline sits so descenders stay in the box
  const gBase = o.box.y1 - gs * 0.2;
  const gTop = gBase - gs * 0.74;
  const out: Placed[] = [];
  const rows: TypeLayout['rows'] = [];
  const alignX = (w: number) => (o.align === 'left' ? o.box.x0 : o.align === 'right' ? o.box.x1 - w : o.box.x0 + (boxW - w) / 2);
  krows.forEach((row, ri) => {
    if (!row.length) return;
    const rw = row.reduce((a, j) => a + kw[j], 0) + kspace * (row.length - 1);
    let rx = alignX(rw) + (o.align === 'left' ? gs * 0.04 : 0);
    const base = gTop - kH + ks * 0.9 + ri * klh;
    rows.push({ x: rx, y: base - ks * 0.8, w: rw, h: ks });
    for (const j of row) {
      const i = kIdx[j];
      out.push({ text: ktexts[i], t: words[i].t, end: words[i].end, x: rx, y: base, w: kw[j], size: ks, voice: kv, italic: !!kv.italic, part: 'kicker', held: false });
      rx += kw[j] + kspace;
    }
  });
  const gx = alignX(gw);
  rows.push({ x: gx, y: gBase - gs * 0.74, w: gw, h: gs * 0.9 });
  out.push({ text: texts[ki], t: words[ki].t, end: words[ki].end, x: gx, y: gBase, w: gw, size: gs, voice: v, italic: !!v.italic, part: 'giant', held: false });
  out.sort((a, b) => a.t - b.t);
  return { role: 'giant', treatment: o.treatment, size: ks * 1.6, words: out, rows };
}

/* ───────────────────────── motion ───────────────────────── */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (x: number) => 1 - (1 - x) ** 3;
const expoOut = (x: number) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x));

/** how long a word takes to arrive, per motion */
const REVEAL: Record<Treatment, number> = { tender: 0.55, dreamy: 0.7, punchy: 0.16, aggressive: 0.07 };
/** how long the arrival weight takes to settle */
const SETTLE: Record<Treatment, number> = { tender: 0.5, dreamy: 0.6, punchy: 0.28, aggressive: 0.22 };
/** how long a caption word's brightening wipe takes at most */
const WIPE_MAX = 0.45;

/**
 * Is anything still moving at time t? (When not, the layer can keep the last drawing.)
 * Mono lines blink their caret, so they keep moving while up.
 */
export function moving(L: TypeLayout, t: number, drop: boolean): boolean {
  for (const w of L.words) {
    const age = t - w.t;
    if (age < -0.05) continue;
    if (w.voice.typed) return true;
    if (L.role === 'caption') {
      if (age < Math.min(WIPE_MAX, Math.max(0.12, w.end - w.t)) + 0.05) return true;
      continue;
    }
    if (w.part === 'giant' && age < 1.3) return true;
    if (age < Math.max(REVEAL[L.treatment], w.voice.enter ? SETTLE[L.treatment] : 0) + 0.05) return true;
    if (w.held && t < w.end + 0.05) return true;
  }
  return drop && L.treatment === 'aggressive' && L.role !== 'caption';
}

/**
 * Draw a laid-out line at time t. `alpha` is the line's own fade; `drop` / `a.kick` let an
 * aggressive line lean its weight on the kick during a drop (never a bounce).
 */
export function drawLine(g: CanvasRenderingContext2D, L: TypeLayout, t: number, alpha: number, c: Inks, a: AudioFrame, drop: boolean) {
  const tr = L.treatment;
  g.save();
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  let lastSung = -1;
  L.words.forEach((w, i) => {
    if (w.t <= t) lastSung = i;
  });

  L.words.forEach((w, i) => {
    const v = w.voice;
    const age = t - w.t;
    // shadows scale with reading size, not with a giant word
    c.shadow(g, Math.min(w.size, L.size * 1.4));
    g.fillStyle = c.ink;

    if (L.role === 'caption') {
      // the whole line is up, quiet; each word brightens with a wipe as it's sung
      setFont(g, v, w.size, w.italic);
      g.letterSpacing = `${(w.size * v.track).toFixed(2)}px`;
      const p = age <= 0 ? 0 : easeOut(clamp01(age / Math.min(WIPE_MAX, Math.max(0.12, w.end - w.t))));
      if (p < 1) {
        g.globalAlpha = alpha * 0.42;
        g.fillText(w.text, w.x, w.y);
      }
      if (p > 0) {
        g.save();
        g.beginPath();
        g.rect(w.x - w.size * 0.1, w.y - w.size * 1.2, (w.w + w.size * 0.2) * p, w.size * 1.6);
        g.clip();
        g.globalAlpha = alpha;
        g.fillText(w.text, w.x, w.y);
        g.restore();
      }
      return;
    }

    if (age < 0) return;
    const rd = REVEAL[tr];
    let track = v.track;
    let weight = v.weight;
    // held notes: the tracking opens (and on Archivo the width steps out, crossfading between widths)
    const hold = w.held ? easeOut(clamp01((t - w.t) / Math.max(0.3, w.end - w.t))) : 0;
    track += OPEN * hold;
    let widths: [CanvasFontStretch | undefined, number][] = [[v.stretch, 1]];
    if (w.held && v.widen && v.widen.length > 1) {
      const q = hold * (v.widen.length - 1);
      const i0 = Math.min(v.widen.length - 2, Math.floor(q));
      const f = q - i0;
      const k = f < 0.35 ? 0 : f > 0.65 ? 1 : ((f - 0.35) / 0.3) ** 2 * (3 - 2 * ((f - 0.35) / 0.3));
      widths = [
        [v.widen[i0], 1 - k],
        [v.widen[i0 + 1], k],
      ];
    }
    if (v.enter) weight = v.enter + (v.weight - v.enter) * expoOut(clamp01(age / SETTLE[tr]));
    if (tr === 'aggressive' && drop && i === lastSung && v.enter) weight = Math.min(900, weight + 120 * a.kick);
    let dy = 0;
    let op = alpha;
    let clipP = 1;

    if (w.part === 'giant') {
      // the giant word wipes on left to right and its tracking tightens as it lands
      clipP = expoOut(clamp01(age / 0.32));
      track = v.track + GIANT_OPEN * (1 - expoOut(clamp01(age / 1.2)));
      if (c.accent !== c.ink) g.fillStyle = c.accent;
    } else if (tr === 'dreamy') {
      const k = clamp01(age / rd);
      op *= easeOut(k);
      track += 0.05 * (1 - easeOut(k));
    } else if (tr === 'aggressive') {
      op *= clamp01(age / rd);
    } else {
      // masked rise: the word comes up out of a line at its baseline
      const k = clamp01(age / rd);
      dy = (1 - expoOut(k)) * w.size * 0.95;
      op *= 0.35 + 0.65 * easeOut(k);
    }
    if (w.part === 'kicker') op *= 0.86;

    setFont(g, v, w.size, w.italic, weight);
    g.letterSpacing = `${(w.size * track).toFixed(2)}px`;
    g.globalAlpha = op;
    let text = w.text;
    if (v.typed) {
      // mono: letters type on across the word as it's sung; a caret sits after the newest letter
      const span = Math.max(0.035 * text.length, Math.min(0.5, w.end - w.t));
      const n = Math.max(1, Math.ceil(text.length * clamp01(age / span)));
      text = text.slice(0, n);
      dy = 0;
      g.globalAlpha = alpha;
    }
    const masked = !v.typed && (dy > 0.5 || clipP < 1);
    if (masked) {
      g.save();
      g.beginPath();
      const over = w.size * 0.25;
      g.rect(w.x - over, w.y - w.size * 1.15, (w.w + over * 2 + w.size * track * text.length) * clipP, w.size * 1.45);
      g.clip();
    }
    for (const [stretch, a] of widths) {
      if (a <= 0.01) continue;
      g.fontStretch = stretch ?? 'normal';
      g.globalAlpha = (v.typed ? alpha : op) * a;
      g.fillText(text, w.x, w.y + dy);
    }
    if (masked) g.restore();
    if (v.typed && i === lastSung && Math.floor(t * 2.2) % 2 === 0) {
      const cw = g.measureText(text).width;
      g.shadowBlur = 0;
      g.fillRect(w.x + cw + w.size * 0.04, w.y - w.size * 0.72, w.size * 0.5, w.size * 0.86);
    }
  });
  g.letterSpacing = '0px';
  g.fontStretch = 'normal';
  g.globalAlpha = 1;
  g.shadowBlur = 0;
  g.restore();
}
