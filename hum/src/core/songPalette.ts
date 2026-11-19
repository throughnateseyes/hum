/**
 * Song palette: one colour family for a whole video.
 *
 * Every look brings its own palette, so a video cut from four looks has four unrelated sets of
 * colours. `harmonize` pulls a look's colours toward the hues of a key palette (the video's main
 * look) while keeping what makes the look work: how light or dark each colour is, and so its
 * contrast, its paper-or-night background and its readable type. Only hue moves (and chroma a
 * little), measured in OKLCH, where equal steps look equal.
 *
 * Pure colour maths, no three.js: it runs in the planner and in node.
 */
import type { Palette } from './types';

type Role = 'bg' | 'fg' | 'accent' | 'accent2' | 'muted';
const ROLES: Role[] = ['bg', 'fg', 'accent', 'accent2', 'muted'];

export interface Lch {
  /** lightness 0..1 */
  l: number;
  /** chroma, 0 grey … about 0.3 vivid */
  c: number;
  /** hue in degrees */
  h: number;
}

/** below this a colour reads as a grey, and its hue means nothing */
const GREY = 0.04;

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const toGamma = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

export function hexToLch(hex: string): Lch {
  const n = parseInt(hex.replace('#', ''), 16) || 0;
  const r = toLinear(((n >> 16) & 255) / 255);
  const g = toLinear(((n >> 8) & 255) / 255);
  const b = toLinear((n & 255) / 255);
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

function lchToRgb({ l, c, h }: Lch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_, -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_, -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_];
}

/** to hex; a colour the screen can't show keeps its lightness and hue and gives up chroma */
export function lchToHex(col: Lch): string {
  const fits = (rgb: number[]) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);
  let rgb = lchToRgb(col);
  if (!fits(rgb)) {
    let lo = 0;
    let hi = col.c;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (fits(lchToRgb({ ...col, c: mid }))) lo = mid;
      else hi = mid;
    }
    rgb = lchToRgb({ ...col, c: lo });
  }
  const to8 = (v: number) => Math.round(Math.min(1, Math.max(0, toGamma(Math.min(1, Math.max(0, v))))) * 255);
  return `#${rgb.map((v) => to8(v).toString(16).padStart(2, '0')).join('')}`;
}

/** signed shortest way round the hue circle from `from` to `to`, -180..180 */
const hueDelta = (to: number, from: number) => ((to - from + 540) % 360) - 180;

interface Anchor {
  h: number;
  c: number;
}

/**
 * The hues a key palette stands for: its accents first, then a coloured ground, ink or muted tone.
 * Near-duplicates collapse, so a two-colour palette gives two anchors and a black-and-white one none.
 */
export function keyHues(key: Palette): Anchor[] {
  const order: Role[] = ['accent', 'accent2', 'bg', 'muted', 'fg'];
  const out: Anchor[] = [];
  for (const role of order) {
    const col = hexToLch(key[role]);
    if (col.c < GREY + 0.01) continue;
    if (out.some((a) => Math.abs(hueDelta(col.h, a.h)) < 22)) continue;
    out.push({ h: col.h, c: col.c });
    if (out.length === 3) break;
  }
  return out;
}

/**
 * Pull `look` toward `key`'s colour family. `strength` 0 leaves it alone, about 0.55 leans it
 * (colours meet halfway), 1 puts every colour on the key's hues. Lightness never changes.
 */
export function harmonize(look: Palette, key: Palette, strength: number): Palette {
  const s = Math.min(1, Math.max(0, strength));
  if (s <= 0.001) return look;
  const anchors = keyHues(key);
  const cols = ROLES.map((role) => ({ role, lch: hexToLch(look[role]) }));
  const out: Record<Role, string> = { bg: look.bg, fg: look.fg, accent: look.accent, accent2: look.accent2, muted: look.muted };

  // a key with no colour in it (black and white) drains the look instead
  if (!anchors.length) {
    for (const { role, lch } of cols) out[role] = lchToHex({ ...lch, c: lch.c * (1 - 0.88 * s) });
    return { ...look, ...out };
  }

  // greys take a breath of the key's ground colour, so blacks and papers sit in the same family too
  const keyBg = hexToLch(key.bg);
  const ground = keyBg.c >= GREY ? keyBg.h : anchors[0].h;

  // the look's most colourful inks choose first, each taking the nearest hue nobody has taken yet,
  // so two accents stay two colours whenever the key has two to give
  const free = anchors.map((_, i) => i);
  const coloured = cols.filter((c) => c.lch.c >= GREY).sort((a, b) => b.lch.c - a.lch.c);
  for (const { role, lch } of coloured) {
    const pool = free.length ? free : anchors.map((_, i) => i);
    let best = pool[0];
    for (const i of pool) if (Math.abs(hueDelta(lch.h, anchors[i].h)) < Math.abs(hueDelta(lch.h, anchors[best].h))) best = i;
    if (free.length) free.splice(free.indexOf(best), 1);
    const a = anchors[best];
    const delta = hueDelta(lch.h, a.h);
    // at full strength a colour keeps a few degrees of its own lean, or everything goes flat
    const lean = Math.max(-14, Math.min(14, delta)) * 0.5;
    // a colour far round the wheel commits to the key's hue: stopping halfway from red to green is mud
    const far = Math.min(1, Math.max(0, (Math.abs(delta) - 70) / 60));
    const sh = s + (1 - s) * far * far * (3 - 2 * far);
    const h = (a.h + (1 - sh) * delta + sh * lean + 360) % 360;
    const c = lch.c * (1 + s * 0.6 * (Math.min(1.35, Math.max(0.65, a.c / lch.c)) - 1));
    out[role] = lchToHex({ l: lch.l, c, h });
  }
  for (const { role, lch } of cols) {
    if (lch.c >= GREY) continue;
    out[role] = lchToHex({ l: lch.l, c: Math.max(lch.c, 0.011 * s), h: lch.c > 0.012 ? lch.h + hueDelta(ground, lch.h) * s : ground });
  }
  return { ...look, ...out };
}
