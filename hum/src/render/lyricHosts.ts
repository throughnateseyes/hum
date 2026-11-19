import type { AudioFrame, Palette } from '../core/types';
import { FACES } from './lyricFonts';
import { hexRGB, lumOf, type RGB, type Rect } from './legibility';
import { measureWord, voiceFor, type Treatment, type Voice } from './lyricAuto';

/**
 * Words inside the world: a scene can host the sung line itself, so it reads as part of the place
 * instead of type laid over it. A host is keyed by scene id and draws into the lyric layer's
 * canvas with the scene's own light and logic:
 *
 *   night-windows   a neon sign in the city: tubes sit dark until each word is sung, then flicker
 *                   on and buzz with the kick
 *   still-water     the words float on the pool like the leaves: each lands as it's sung, casts a
 *                   shadow on the pebbles below and wobbles with the rings
 *
 * Adding one: write a `LyricHost` (where the line lives for each frame shape, and `build`, which
 * lays a line out once and returns how to draw it at any time), and add it to HOSTS. Hosts look
 * after their own legibility (the guard stands back for them), so keep the ink bright on a dark
 * world or give it a shadow. Ideas waiting: condensation written on Night Train's window, a
 * woodblock title printed into Willow, the sung line on a card in Flip Cards' deck.
 */

export interface HostWord {
  text: string;
  t: number;
  end: number;
}

export interface HostCtx {
  W: number;
  H: number;
  pal: Palette;
  family?: string;
  treatment: Treatment;
  /** the drop moment: the host may make it bigger */
  big: boolean;
  /** seed for the line's small variations */
  seed: number;
}

export interface HostLine {
  /** normalized box around the line (for the chip and checks) */
  rect: Rect;
  /** draw the line at song time t (alpha: the line's own fade) */
  draw(g: CanvasRenderingContext2D, t: number, alpha: number, a: AudioFrame): void;
  /** does it change at time t? (if not, the layer keeps the last drawing) */
  moving(t: number): boolean;
}

export interface LyricHost {
  /** said in the lyrics chip: "the look hosts the words: …" */
  name: string;
  scenes: string[];
  build(g: CanvasRenderingContext2D, words: HostWord[], c: HostCtx): HostLine;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const hsh = (a: number, b: number) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const rgb = (c: RGB, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a.toFixed(3)})`;
const mixC = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

/** greedy rows balanced to an even rag, at most maxRows */
function rowsOf(widths: number[], space: number, maxW: number, maxRows: number): number[][] | null {
  const total = widths.reduce((a, b) => a + b, 0) + space * Math.max(0, widths.length - 1);
  const n = Math.max(1, Math.ceil(total / maxW));
  if (n > maxRows || Math.max(0, ...widths) > maxW) return null;
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
  // balance the rag: wrap at an even share of the line, widening until it takes no more rows than it must
  let rows = wrapAt(maxW);
  for (let f = 1.04; n > 1 && f < 2; f += 0.06) {
    const r = wrapAt(Math.min(maxW, Math.max(Math.max(...widths), (total / n) * f)));
    if (r.length <= n) {
      rows = r;
      break;
    }
  }
  return rows.length > maxRows ? null : rows;
}

interface Set_ {
  words: { text: string; t: number; end: number; x: number; y: number; w: number }[];
  size: number;
  box: { x0: number; y0: number; x1: number; y1: number };
}

/** fit words into a pixel box, rows centred or left-aligned, vertically centred */
function setIn(g: CanvasRenderingContext2D, words: HostWord[], texts: string[], v: Voice, px: number, box: Set_['box'], maxRows: number, align: 'left' | 'center', italic = !!v.italic): Set_ {
  const bw = box.x1 - box.x0;
  const bh = box.y1 - box.y0;
  let size = px;
  for (let k = 0; k < 16; k++) {
    const widths = texts.map((s) => measureWord(g, s, v, size, italic));
    const space = measureWord(g, ' ', v, size, false) + size * v.track;
    const rows = rowsOf(widths, space, bw, maxRows);
    const lh = size * v.leading;
    if ((!rows || rows.length * lh > bh) && k < 15) {
      size *= 0.92;
      continue;
    }
    const rr = rows ?? [widths.map((_, i) => i)];
    const top = box.y0 + (bh - rr.length * lh) / 2;
    const out: Set_['words'] = [];
    rr.forEach((row, ri) => {
      const rw = row.reduce((a, i) => a + widths[i], 0) + space * (row.length - 1);
      let x = align === 'left' ? box.x0 : box.x0 + (bw - rw) / 2;
      const y = top + ri * lh + size * (0.5 * (v.leading - 1) + 0.8);
      for (const i of row) {
        out.push({ text: texts[i], t: words[i].t, end: words[i].end, x, y, w: widths[i] });
        x += widths[i] + space;
      }
    });
    const minX = Math.min(...out.map((w) => w.x));
    const maxX = Math.max(...out.map((w) => w.x + w.w));
    return { words: out, size, box: { x0: minX, y0: top, x1: maxX, y1: top + rr.length * lh } };
  }
  return { words: [], size, box };
}

const trimEnd = (s: string) => s.replace(/(?<!\.)[,;.]$/u, '') || s;

/* ───────────────────────── Night Windows: a neon sign ───────────────────────── */

/** the most neon-able colour of the look: its most saturated warm or cool light, pushed vivid */
function neonOf(pal: Palette): RGB {
  const cands = [pal.accent, pal.accent2, pal.fg].map(hexRGB);
  const sat = (c: RGB) => (Math.max(...c) - Math.min(...c)) / Math.max(1, Math.max(...c));
  const best = cands.reduce((a, b) => (sat(b) > sat(a) + 0.08 ? b : a));
  const mx = Math.max(...best, 1);
  // full brightness, a touch more saturation
  const lifted: RGB = [best[0] * (255 / mx), best[1] * (255 / mx), best[2] * (255 / mx)];
  const grey = (lifted[0] + lifted[1] + lifted[2]) / 3;
  return lifted.map((v) => Math.max(0, Math.min(255, grey + (v - grey) * 1.25))) as RGB;
}

const neonSign: LyricHost = {
  name: 'a neon sign in the city',
  scenes: ['night-windows'],
  build(g, words, c) {
    const { W, H } = c;
    const portrait = H > W * 1.2;
    const unit = Math.min(W, H);
    // tube capitals for loud or cold songs, a script sign otherwise
    const caps = c.family === 'condensed' || c.family === 'mono' || c.treatment === 'aggressive';
    const v: Voice = caps
      ? { family: FACES.archivo, stretch: 'semi-condensed', weight: 250, track: 0.12, case: 'upper', leading: 1.15, size: 0.08 }
      : { family: FACES.hand, weight: 500, track: 0.01, case: 'asis', leading: 0.98, size: 0.12 };
    const texts = words.map((w, i) => {
      const s = i === words.length - 1 ? trimEnd(w.text) : w.text;
      return caps ? s.toUpperCase() : s;
    });
    // over the dark mid-city beside the tower (landscape), or at street level in front of it (portrait)
    const box = portrait
      ? { x0: W * 0.1, y0: H * 0.56, x1: W * 0.9, y1: H * 0.72 }
      : { x0: W * 0.04, y0: H * 0.5, x1: W * 0.33, y1: H * 0.76 };
    const set = setIn(g, words, texts, v, v.size * unit * (c.big ? 1.25 : 1), box, 3, 'center');
    const neon = neonOf(c.pal);
    const core = mixC(neon, [255, 252, 246], 0.72);
    const glass = mixC(neon, [40, 40, 52], 0.7);
    const sz = set.size;
    const font = `${v.weight} ${sz.toFixed(1)}px ${v.family}`;
    // each word's flicker-on: a seeded little stutter over ~0.22 s
    const flick = set.words.map((_, i) => [0.03 + hsh(c.seed, i) * 0.03, 0.07 + hsh(c.seed, i + 9) * 0.05, 0.12 + hsh(c.seed, i + 17) * 0.06]);
    const lit = (i: number, age: number) => {
      if (age < 0) return 0;
      const [a, b, d] = flick[i];
      if (age < a) return 0.9;
      if (age < b) return 0.12;
      if (age < d) return 0.75;
      return 1;
    };
    const pad = sz * 0.5;
    const rect: Rect = { x0: (set.box.x0 - pad) / W, y0: (set.box.y0 - pad) / H, x1: (set.box.x1 + pad) / W, y1: (set.box.y1 + pad) / H };
    return {
      rect,
      // the tubes hum, so a lit sign is always moving a little
      moving: () => true,
      draw(gg, t, alpha, a) {
        gg.save();
        gg.font = font;
        gg.fontStretch = v.stretch ?? 'normal';
        gg.letterSpacing = `${(sz * v.track).toFixed(2)}px`;
        gg.textBaseline = 'alphabetic';
        gg.lineJoin = 'round';
        // the sign's mounting: two thin wires up from its top corners
        gg.globalAlpha = alpha * 0.5;
        gg.strokeStyle = 'rgba(20,20,28,0.9)';
        gg.lineWidth = Math.max(1, sz * 0.025);
        const top = set.box.y0 - sz * 0.05;
        for (const fx of [0.18, 0.82]) {
          const x = set.box.x0 + (set.box.x1 - set.box.x0) * fx;
          gg.beginPath();
          gg.moveTo(x, top);
          gg.lineTo(x, top - sz * 1.6);
          gg.stroke();
        }
        // a buzz: the whole sign breathes a little with the kick and the mains hum
        const hum = 0.93 + 0.05 * Math.sin(t * 120) * 0.5 + 0.07 * a.kick;
        const anyLit = set.words.reduce((m, w, i) => Math.max(m, lit(i, t - w.t)), 0);
        // light spilling on the wall behind it
        if (anyLit > 0) {
          const cx = (set.box.x0 + set.box.x1) / 2;
          const cy = (set.box.y0 + set.box.y1) / 2;
          const rr = Math.max(set.box.x1 - set.box.x0, set.box.y1 - set.box.y0) * 0.75;
          const grd = gg.createRadialGradient(cx, cy, rr * 0.1, cx, cy, rr);
          grd.addColorStop(0, rgb(neon, 0.16 * anyLit * hum));
          grd.addColorStop(1, rgb(neon, 0));
          gg.globalAlpha = alpha;
          gg.fillStyle = grd;
          gg.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
        }
        set.words.forEach((w, i) => {
          const L = lit(i, t - w.t);
          // the unlit tube: glass catching a little light
          gg.shadowBlur = 0;
          gg.globalAlpha = alpha * (1 - L) * 0.55;
          gg.strokeStyle = rgb(glass);
          gg.lineWidth = Math.max(1, sz * 0.035);
          gg.strokeText(w.text, w.x, w.y);
          if (L <= 0) return;
          const k = L * hum;
          gg.globalAlpha = alpha * Math.min(1, k);
          // wide glow, tight glow, then the hot core of the tube
          gg.shadowColor = rgb(neon, 0.9);
          gg.shadowBlur = sz * 0.55 * k;
          gg.fillStyle = rgb(neon, 0.85);
          gg.fillText(w.text, w.x, w.y);
          gg.shadowBlur = sz * 0.14;
          gg.fillText(w.text, w.x, w.y);
          gg.shadowBlur = sz * 0.04;
          gg.shadowColor = rgb(neon, 1);
          gg.fillStyle = rgb(core);
          gg.fillText(w.text, w.x, w.y);
        });
        gg.restore();
        gg.letterSpacing = '0px';
        gg.fontStretch = 'normal';
      },
    };
  },
};

/* ───────────────────────── Still Water: words floating on the pool ───────────────────────── */

const floating: LyricHost = {
  name: 'words floating on the water',
  scenes: ['still-water'],
  build(g, words, c) {
    const { W, H } = c;
    const portrait = H > W * 1.2;
    const unit = Math.min(W, H);
    const base = voiceFor('display', c.family, c.treatment, 0.5);
    // floating type is light: the serif in italic, the others a book weight
    const v: Voice = { ...base, weight: Math.min(base.weight, base.family === FACES.archivo ? 500 : 450), enter: undefined, widen: undefined, typed: false, italicKey: false };
    const italic = base.family === FACES.instrument || base.family === FACES.fraunces;
    const texts = words.map((w, i) => {
      const s = i === words.length - 1 ? trimEnd(w.text) : w.text;
      return v.case === 'upper' ? s.toUpperCase() : v.case === 'lower' ? s.toLowerCase() : s;
    });
    const box = portrait ? { x0: W * 0.08, y0: H * 0.42, x1: W * 0.92, y1: H * 0.72 } : { x0: W * 0.07, y0: H * 0.42, x1: W * 0.6, y1: H * 0.8 };
    const set = setIn(g, words, texts, v, v.size * unit * (c.big ? 1.5 : 1.05), box, 3, 'left', italic);
    const sz = set.size;
    const font = `${italic ? 'italic ' : ''}${v.weight} ${sz.toFixed(1)}px ${v.family}`;
    const water = hexRGB(c.pal.bg);
    const deep = hexRGB(c.pal.muted);
    // the shadow on the pebbles: the pool's deep colour, darker
    const shade = mixC(lumOf(deep) < lumOf(water) ? deep : water, [0, 0, 0], 0.55);
    const ink: RGB = [252, 250, 242];
    const off = document.createElement('canvas');
    const pad = sz * 0.9;
    const bx = Math.max(0, Math.floor(set.box.x0 - pad));
    const by = Math.max(0, Math.floor(set.box.y0 - pad));
    off.width = Math.min(W, Math.ceil(set.box.x1 + pad * 1.4)) - bx;
    off.height = Math.min(H, Math.ceil(set.box.y1 + pad * 1.6)) - by;
    const og = off.getContext('2d')!;
    const LAND = 0.5;
    const rect: Rect = { x0: bx / W, y0: by / H, x1: (bx + off.width) / W, y1: (by + off.height) / H };
    return {
      rect,
      moving: () => true,
      draw(gg, t, alpha, a) {
        og.clearRect(0, 0, off.width, off.height);
        og.font = font;
        og.fontStretch = v.stretch ?? 'normal';
        og.letterSpacing = `${(sz * v.track).toFixed(2)}px`;
        og.textBaseline = 'alphabetic';
        const pos = set.words.map((w, i) => {
          const age = t - w.t;
          const k = clamp01(age / LAND);
          const e = 1 - (1 - k) ** 3;
          // a slow drift on the surface, different per word
          const dx = Math.sin(t * 0.35 + i * 1.9) * sz * 0.05;
          const dy = Math.cos(t * 0.3 + i * 2.7) * sz * 0.04;
          return { w, age, e, x: w.x - bx + dx, y: w.y - by + dy };
        });
        // shadows first: far and soft while the word falls, close and crisp once it floats
        for (const p of pos) {
          if (p.age < 0) continue;
          const far = 1 - p.e;
          og.globalAlpha = 0.66 * Math.min(1, p.age / 0.15);
          og.fillStyle = rgb(shade);
          og.filter = `blur(${(sz * (0.05 + 0.25 * far)).toFixed(1)}px)`;
          og.fillText(p.w.text, p.x + sz * (0.14 + 0.4 * far), p.y + sz * (0.26 + 0.6 * far));
        }
        og.filter = 'none';
        for (const p of pos) {
          if (p.age < 0) continue;
          og.globalAlpha = Math.min(1, p.age / 0.12);
          og.fillStyle = rgb(ink);
          og.fillText(p.w.text, p.x, p.y);
        }
        og.letterSpacing = '0px';
        // copy onto the frame in thin strips, each nudged by the ripples (a ring when a word lands
        // and on every kick)
        const landing = pos.reduce((m, p) => (p.age >= 0 && p.age < 1 ? Math.max(m, 1 - p.age) : m), 0);
        const amp = sz * (0.008 + 0.018 * a.kick + 0.022 * landing);
        const strip = Math.max(2, Math.round(sz * 0.06));
        gg.save();
        gg.globalAlpha = alpha;
        for (let y = 0; y < off.height; y += strip) {
          const dx = Math.sin(y * (6 / sz) + t * 2.4) * amp + Math.sin(y * (2.3 / sz) - t * 1.3) * amp * 0.6;
          gg.drawImage(off, 0, y, off.width, strip, bx + dx, by + y, off.width, strip);
        }
        gg.restore();
      },
    };
  },
};

const HOSTS: LyricHost[] = [neonSign, floating];

/** the host for a scene, if it has one */
export function hostFor(sceneId: string | null | undefined): LyricHost | null {
  if (!sceneId) return null;
  return HOSTS.find((h) => h.scenes.includes(sceneId)) ?? null;
}
