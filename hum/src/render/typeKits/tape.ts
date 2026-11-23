import type { Palette } from '../../core/types';
import type { Placed, Role, TypeLayout, Voice } from '../lyricAuto';
import { KIT_FACES } from './fonts';
import { arrival, clamp01, css, fromHsl, hexRGB, huesOf, mix, reach, roundRect, rowsBox, scratchCanvas, toHsl, wordFont, type KitLine, type RGB } from './common';

/**
 * Tape: lettering off a 1984 cassette sleeve or a computer's splash screen (references 12, 15, 16,
 * 17, 20), drawn before the tape finish so the VCR smears, jitters and rolls the words with the picture.
 *
 *   display, giant  a wide heavy logotype (Krona One, capitals), each word in its own phosphor colour
 *                   band, cut by thin horizontal stripes through its lower half, with a soft glow and
 *                   a chroma ghost either side. Above it a terminal line "> CHORUS  0:36  120 BPM",
 *                   under it a progress bar of the line being sung, all in a hairline frame
 *   subtitle        an LED sign: the words spelled in glowing dots (VT323 rasterized to a dot grid) on a
 *                   dark plate whose unlit dots show. Sung words light up full; the rest glow faintly
 *   sparse          a terminal prompt: "> " and the words in VT323 phosphor green, a block caret after
 *                   the newest word
 *
 * Palette rule: phosphor colours, the look's own hues pushed to full saturation and screen brightness
 * (the plate and the glow keep them readable); terminal lines in green, or amber when the look is warm.
 */

const WIDE = KIT_FACES.tapeWide;
const TERM = KIT_FACES.tapeTerm;

export function tapeVoice(role: Role | 'kicker', base: Voice): Voice {
  if (role === 'caption') return { ...base, family: TERM, weight: 400, stretch: undefined, widen: undefined, enter: undefined, italic: false, italicKey: false, typed: false, track: 0.08, case: 'upper', leading: 1.62, size: 0.062 };
  if (role === 'aside') return { ...base, family: TERM, weight: 400, stretch: undefined, widen: undefined, enter: undefined, italic: false, italicKey: false, typed: false, track: 0.01, case: 'asis', leading: 1.18, size: 0.06 };
  if (role === 'kicker') return { ...base, family: TERM, weight: 400, stretch: undefined, widen: undefined, enter: undefined, italic: false, italicKey: false, typed: false, track: 0.04, case: 'upper', leading: 1.3, size: 0.044 };
  if (role === 'giant') return { ...base, family: WIDE, weight: 400, stretch: undefined, widen: undefined, enter: undefined, italic: false, italicKey: false, typed: false, track: -0.02, case: 'upper', leading: 1, size: 0.22 };
  return { ...base, family: WIDE, weight: 400, stretch: undefined, widen: undefined, enter: undefined, italic: false, italicKey: false, typed: false, track: -0.01, case: 'upper', leading: 1.16, size: 0.07 };
}

/**
 * phosphor: a hue at full saturation and screen brightness, never darker than a lit phosphor reads
 * (blues and violets are lifted toward white), or deep, for light pictures
 */
const phosphor = (c: RGB, light: boolean): RGB => {
  const [h, s] = toHsl(c);
  const p = fromHsl(h, Math.max(0.78, s), light ? 0.6 : 0.36);
  return light ? reach(p, [235, 240, 255], 0.36) : reach(p, [0, 0, 0], 0, 0.12);
};

/** four band colours from the look's hues: its own, then the colours opposite them */
export function tapeBands(pal: Palette, light: boolean): RGB[] {
  const hs = huesOf(pal);
  const out: RGB[] = [];
  const hue = (c: RGB) => toHsl(c)[0];
  const sat = (c: RGB) => toHsl(c)[1];
  const seeds = hs.filter((c) => sat(c) > 0.25).slice(0, 2);
  if (!seeds.length) seeds.push([60, 120, 255]);
  const h0 = hue(seeds[0]);
  const h1 = seeds[1] ? hue(seeds[1]) : h0 + 110;
  // spread round the wheel so neighbouring words never share a colour
  for (const h of [h0, h1, h0 + 180, h1 + 180]) out.push(phosphor(fromHsl(h, 1, 0.5), light));
  return out;
}

/** terminal phosphor: amber when the look is warm, green otherwise */
export function termInk(pal: Palette, light: boolean): RGB {
  const h = toHsl(hexRGB(pal.accent))[0];
  const warm = h >= 18 && h <= 55;
  return light ? (warm ? [255, 184, 64] : [92, 255, 150]) : warm ? [150, 82, 0] : [10, 110, 56];
}

/* ───────────────────────── LED sign (subtitle) ───────────────────────── */

interface Led {
  x0: number;
  y0: number;
  w: number;
  h: number;
  p: number;
  off: HTMLCanvasElement;
  on: HTMLCanvasElement;
  /** each word's dot columns and rows (canvas px, relative to the plate) */
  spans: { x: number; y: number; w: number; h: number }[];
  key: string;
}
const leds = new WeakMap<TypeLayout, Led>();
let rasterCanvas: HTMLCanvasElement | null = null;

/** spell the line in dots once per line: a grid of unlit dots, and the lit ones with their glow */
function buildLed(L: TypeLayout, col: RGB, light: boolean): Led {
  const size = L.size;
  // about 10 dots to the em: VT323's capitals come out 6 dots tall, like a 5×7 sign, with dots big
  // enough to stay dots through the tape's smear
  const p = Math.max(3, size / 10);
  const box = rowsBox(L, 0);
  const pad = p * 2.6;
  const x0 = Math.floor(box.x0 - pad);
  const y0 = Math.floor(box.y0 - pad * 0.9);
  const cols = Math.ceil((box.x1 - box.x0 + pad * 2) / p);
  const rows = Math.ceil((box.y1 - box.y0 + pad * 1.6 + size * 0.2) / p);
  const w = Math.ceil(cols * p);
  const h = Math.ceil(rows * p);
  if (!rasterCanvas) rasterCanvas = document.createElement('canvas');
  rasterCanvas.width = cols;
  rasterCanvas.height = rows;
  const rg = rasterCanvas.getContext('2d', { willReadFrequently: true })!;
  rg.clearRect(0, 0, cols, rows);
  rg.fillStyle = '#fff';
  rg.textBaseline = 'alphabetic';
  const spans: Led['spans'] = [];
  for (const wd of L.words) {
    wordFont(rg, wd, wd.size / p);
    rg.fillText(wd.text, (wd.x - x0) / p, (wd.y - y0) / p);
    spans.push({ x: wd.x - x0 - p * 0.6, y: wd.y - y0 - wd.size * 0.95, w: wd.w + p * 1.2, h: wd.size * 1.35 });
  }
  rg.letterSpacing = '0px';
  const data = rg.getImageData(0, 0, cols, rows).data;
  // unlit dots: a faint grid over the whole plate, as on a real sign
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const og = off.getContext('2d')!;
  const tile = document.createElement('canvas');
  tile.width = tile.height = Math.max(2, Math.round(p));
  const tg = tile.getContext('2d')!;
  tg.fillStyle = css(mix([14, 14, 18], col, light ? 0.16 : 0.1));
  tg.beginPath();
  tg.arc(tile.width / 2, tile.height / 2, tile.width * 0.36, 0, Math.PI * 2);
  tg.fill();
  og.fillStyle = og.createPattern(tile, 'repeat')!;
  og.fillRect(0, 0, w, h);
  // lit dots: a hot core and a glow, from one sprite
  const on = document.createElement('canvas');
  on.width = w;
  on.height = h;
  const ng = on.getContext('2d')!;
  const sp = document.createElement('canvas');
  const ss = Math.ceil(p * 3);
  sp.width = sp.height = ss;
  const sg = sp.getContext('2d')!;
  const grad = sg.createRadialGradient(ss / 2, ss / 2, 0, ss / 2, ss / 2, ss / 2);
  grad.addColorStop(0, css(mix(col, [255, 255, 255], 0.55)));
  grad.addColorStop(0.2, css(col));
  grad.addColorStop(0.32, css(col, 0.55));
  grad.addColorStop(1, css(col, 0));
  sg.fillStyle = grad;
  sg.fillRect(0, 0, ss, ss);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (data[(y * cols + x) * 4 + 3] < 120) continue;
      ng.drawImage(sp, x * p + p / 2 - ss / 2, y * p + p / 2 - ss / 2);
    }
  }
  return { x0, y0, w, h, p, off, on, spans, key: css(col) };
}

function drawLed(k: KitLine, col: RGB) {
  const { g, L, t, alpha } = k;
  let led = leds.get(L);
  if (!led || led.key !== css(col)) {
    led = buildLed(L, col, k.light);
    leds.set(L, led);
  }
  const { x0, y0, w, h, p } = led;
  g.save();
  g.globalAlpha = alpha;
  // the plate: near black whatever the picture, so the dots always read; a hairline round it
  roundRect(g, x0, y0, w, h, p * 1.4);
  g.fillStyle = 'rgba(6,7,9,0.9)';
  g.fill();
  g.strokeStyle = css(col, 0.45);
  g.lineWidth = Math.max(1, p * 0.3);
  g.stroke();
  g.drawImage(led.off, x0, y0);
  L.words.forEach((wd, i) => {
    const a = arrival(L, wd, t);
    const s = led!.spans[i];
    if (!s) return;
    // unsung words glow faintly, sung ones full; the newest lights left to right
    g.globalAlpha = alpha * 0.26;
    drawPart(g, led!.on, s.x, s.y, s.w, s.h, x0, y0);
    if (a.p > 0) {
      g.globalAlpha = alpha;
      drawPart(g, led!.on, s.x, s.y, s.w * a.p, s.h, x0, y0);
    }
  });
  g.restore();
}

function drawPart(g: CanvasRenderingContext2D, src: HTMLCanvasElement, x: number, y: number, w: number, h: number, ox: number, oy: number) {
  const sx = Math.max(0, x);
  const sy = Math.max(0, y);
  const sw = Math.min(src.width - sx, w - (sx - x));
  const sh = Math.min(src.height - sy, h - (sy - y));
  if (sw <= 0.5 || sh <= 0.5) return;
  g.drawImage(src, sx, sy, sw, sh, ox + sx, oy + sy, sw, sh);
}

/* ───────────────────────── logotype (display, giant) ───────────────────────── */

const isTerm = (w: Placed) => w.voice.family === TERM;

function drawLogotype(k: KitLine) {
  const { g, L, t, alpha, W, H } = k;
  const bands = tapeBands(k.pal, k.light);
  const term = termInk(k.pal, k.light);
  const big = L.words.filter((w) => !isTerm(w));
  const size = big.length ? Math.max(...big.map((w) => w.size)) : L.size;
  const box = rowsBox(L, size * 0.5);
  const bw = Math.min(W, box.x1 - box.x0);
  const bh = Math.min(H, box.y1 - box.y0);
  const ox = box.x0;
  const oy = box.y0;
  // the letters, coloured and cut, on a scratch canvas: then glow, chroma ghosts and the crisp copy
  const s = scratchCanvas(0, bw + 4, bh + 4);
  s.translate(-ox, -oy);
  s.textBaseline = 'alphabetic';
  let any = false;
  big.forEach((wd, i) => {
    const a = arrival(L, wd, t);
    if (!a.on) return;
    any = true;
    const col = bands[(i + (k.seed % 4)) % 4];
    wordFont(s, wd);
    const top = wd.y - wd.size * 0.74;
    const gr = s.createLinearGradient(0, top, 0, wd.y);
    gr.addColorStop(0, css(mix(col, [255, 255, 255], k.light ? 0.4 : 0.1)));
    gr.addColorStop(0.55, css(col));
    gr.addColorStop(1, css(mix(col, [0, 0, 0], 0.18)));
    s.fillStyle = gr;
    s.globalAlpha = a.op;
    if (a.wipe < 1) {
      s.save();
      s.beginPath();
      s.rect(wd.x - wd.size * 0.1, top - wd.size * 0.4, (wd.w + wd.size * 0.2) * a.wipe, wd.size * 1.6);
      s.clip();
      s.fillText(wd.text, wd.x, wd.y + a.dy);
      s.restore();
    } else s.fillText(wd.text, wd.x, wd.y + a.dy);
  });
  s.globalAlpha = 1;
  s.letterSpacing = '0px';
  // the stripes: thin cuts through the lower half of every letter, like a sleeve logotype
  s.globalCompositeOperation = 'destination-out';
  s.fillStyle = '#000';
  for (const wd of big) {
    const cap = wd.size * 0.72;
    const th = Math.max(1, wd.size * 0.05);
    for (const f of [0.1, 0.3]) s.fillRect(wd.x - 4, wd.y - cap * f - th / 2, wd.w + 8, th);
  }
  s.globalCompositeOperation = 'source-over';
  s.setTransform(1, 0, 0, 1, 0, 0);
  const src = s.canvas;

  g.save();
  g.globalAlpha = alpha;
  // the hairline frame, the terminal line above and the progress bar under the line
  chrome(k, big, term, size);
  if (any) {
    if (k.light) {
      g.shadowColor = css(mix(bands[k.seed % 4], [255, 255, 255], 0.3), 0.7);
      g.shadowBlur = size * 0.4;
    }
    g.drawImage(src, 0, 0, bw, bh, ox, oy, bw, bh);
    g.shadowBlur = 0;
    g.shadowColor = 'transparent';
    // chroma: a faint ghost either side (the tape finish smears it further)
    const dx = Math.max(1.5, size * 0.035);
    g.globalCompositeOperation = k.light ? 'lighter' : 'multiply';
    g.globalAlpha = alpha * 0.28;
    g.drawImage(src, 0, 0, bw, bh, ox - dx, oy, bw, bh);
    g.drawImage(src, 0, 0, bw, bh, ox + dx, oy, bw, bh);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = alpha;
    g.drawImage(src, 0, 0, bw, bh, ox, oy, bw, bh);
  }
  // the kicker of a giant moment: terminal lines
  const kick = L.words.filter(isTerm);
  if (kick.length) drawTerm(k, kick, term, false);
  g.restore();
}

/** the small secondary lines round a display line: song facts, a bar for the line, a frame */
function chrome(k: KitLine, big: Placed[], term: RGB, size: number) {
  const { g, L, t, W, H, facts } = k;
  if (!big.length) return;
  // round every row (a giant moment's terminal kicker too), so the header never sits on a line
  const box = rowsBox(L, 0);
  // big enough to survive the tape's soft, smeared picture
  const fs = Math.max(15, Math.min(Math.max(size * 0.36, Math.min(W, H) * 0.032), Math.min(W, H) * 0.045));
  const pad = fs * 0.9;
  const x0 = box.x0 - pad;
  const x1 = box.x1 + pad;
  const y0 = box.y0 - fs * 2.1;
  const y1 = box.y1 + fs * 2.4;
  // drawn on over the line's first moment
  const on = clamp01((t - k.start) / 0.35);
  g.save();
  g.strokeStyle = css(term, 0.55 * on);
  g.lineWidth = Math.max(1, fs * 0.08);
  g.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0), Math.round(y1 - y0));
  g.font = `400 ${fs.toFixed(1)}px ${TERM}`;
  g.textBaseline = 'alphabetic';
  g.fillStyle = css(term, 0.92 * on);
  if (k.light) {
    g.shadowColor = css(term, 0.6);
    g.shadowBlur = fs * 0.5;
  }
  g.fillText(`> ${facts.part.toUpperCase()}  ${facts.time}${facts.bpm ? `  ${facts.bpm} BPM` : ''}`, x0 + fs * 0.5, y0 + fs * 1.3);
  // the line's progress: how many of its words have been sung
  const sung = L.words.filter((w) => w.t <= t).length / Math.max(1, L.words.length);
  const bx = x0 + fs * 0.5;
  const by = y1 - fs * 1.35;
  const bwid = Math.min(x1 - x0 - fs, Math.max(fs * 8, (x1 - x0) * 0.42));
  g.shadowBlur = 0;
  g.strokeStyle = css(term, 0.85 * on);
  g.strokeRect(Math.round(bx) + 0.5, Math.round(by) + 0.5, Math.round(bwid), Math.round(fs * 0.7));
  g.fillRect(bx + fs * 0.18, by + fs * 0.18, Math.max(0, (bwid - fs * 0.36) * sung), fs * 0.7 - fs * 0.36 + 1);
  g.textAlign = 'right';
  g.fillText(`${String(facts.line).padStart(2, '0')}/${String(facts.lines).padStart(2, '0')}`, x1 - fs * 0.5, by + fs * 0.66);
  g.textAlign = 'left';
  g.restore();
}

/* ───────────────────────── terminal (sparse) ───────────────────────── */

function drawTerm(k: KitLine, words: Placed[], col: RGB, caret: boolean) {
  const { g, L, t, alpha } = k;
  g.save();
  g.textBaseline = 'alphabetic';
  if (k.light) {
    g.shadowColor = css(col, 0.65);
    g.shadowBlur = L.size * 0.35;
  }
  g.fillStyle = css(col);
  // "> " before each row's first word
  const rowFirst = new Set<number>();
  let lastY = NaN;
  words.forEach((w, i) => {
    if (Math.abs(w.y - lastY) > 1) rowFirst.add(i);
    lastY = w.y;
  });
  let newest: Placed | null = null;
  words.forEach((w, i) => {
    const a = arrival(L, w, t);
    wordFont(g, w);
    if (rowFirst.has(i)) {
      g.globalAlpha = alpha * (i === 0 || a.on ? 0.9 : 0.4);
      g.letterSpacing = '0px';
      const pw = g.measureText('> ').width;
      g.fillText('> ', w.x - pw, w.y);
      wordFont(g, w);
    }
    if (!a.on) return;
    newest = w;
    g.globalAlpha = alpha * Math.min(1, a.op + 0.2);
    // terminal text types on: letters appear across the word as it's sung
    const n = Math.max(1, Math.ceil(w.text.length * clamp01((t - w.t) / Math.max(0.05, Math.min(0.35, w.end - w.t)))));
    g.fillText(w.text.slice(0, n), w.x, w.y);
  });
  const nw = newest as Placed | null;
  if (caret && nw && Math.floor(t * 2.4) % 2 === 0) {
    wordFont(g, nw);
    const cw = g.measureText(nw.text).width;
    g.shadowBlur = 0;
    g.globalAlpha = alpha * 0.9;
    g.fillRect(nw.x + cw + nw.size * 0.12, nw.y - nw.size * 0.62, nw.size * 0.42, nw.size * 0.7);
  }
  g.letterSpacing = '0px';
  g.restore();
}

/* ───────────────────────── entry ───────────────────────── */

export function drawTape(k: KitLine) {
  if (k.L.role === 'caption') {
    const bands = tapeBands(k.pal, true);
    drawLed(k, bands[k.seed % bands.length]);
    return;
  }
  if (k.L.role === 'aside') {
    if (!k.light) {
      // on a light or busy picture the dark phosphor colours vanish: the prompt gets its own little
      // terminal window instead, dark glass with a hairline, and glows as it does on a dark picture
      const box = rowsBox(k.L, k.L.size * 0.35);
      k.g.save();
      k.g.globalAlpha = k.alpha * clamp01((k.t - k.start + 0.2) / 0.2);
      k.g.fillStyle = 'rgba(10, 8, 16, 0.84)';
      k.g.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
      k.g.strokeStyle = css(termInk(k.pal, true), 0.6);
      k.g.lineWidth = Math.max(1, k.L.size * 0.04);
      k.g.strokeRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
      k.g.restore();
      drawTerm({ ...k, light: true }, k.L.words, termInk(k.pal, true), true);
      return;
    }
    drawTerm(k, k.L.words, termInk(k.pal, k.light), true);
    return;
  }
  drawLogotype(k);
}
