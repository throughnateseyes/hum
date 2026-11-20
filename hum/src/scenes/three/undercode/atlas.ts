import * as THREE from 'three';

/**
 * Undercode's glyph atlas: one canvas, 16 × 10 cells, drawn once (and again when the mono font has
 * loaded). White marks on black; shaders read the red channel as coverage.
 *
 *   0–47     the rain script: an invented machine script, each glyph a few square-capped strokes on a
 *            3 × 4 construction grid (a stem, a bar or diagonal, sometimes a tick or a dot), seeded so
 *            the set reads as one alphabet nobody can read
 *   48–57    mirrored numerals
 *   58–71    terminal punctuation  : = * + < > | " ¦ . - ^ ~ #
 *   72–97    A–Z      98–107  0–9      108–127  lyric punctuation
 *   128–159  more rain script (a second, denser hand: boxed and hooked forms)
 *
 * The rain draws from the script, the mirrored numerals and the punctuation; lyrics use the letters.
 */

export const ATLAS_COLS = 16;
export const ATLAS_ROWS = 10;
const CELL_W = 64;
const CELL_H = 80;

export const GLYPH_SCRIPT = 0; // 0..47
export const GLYPH_MIRROR = 48; // 48..57
export const GLYPH_PUNCT = 58; // 58..71
export const GLYPH_LETTERS = 72; // A..Z
export const GLYPH_DIGITS = 98; // 0..9
export const GLYPH_LYRIC_PUNCT = 108; // 108..127
export const GLYPH_SCRIPT2 = 128; // 128..159

const TERMINAL_PUNCT = [':', '=', '*', '+', '<', '>', '|', '"', '¦', '.', '-', '^', '~', '#'];
const LYRIC_PUNCT = ["'", ',', '.', '!', '?', '-', '&', ':', ';', '"', '(', ')', '/', '#', '%', '@', '+', '=', '*', '_'];

const MONO = `'JetBrains Mono Variable', 'IBM Plex Mono', ui-monospace, Menlo, monospace`;

/** atlas index for one character of a lyric, or -1 for a space / anything that has no glyph */
export function glyphFor(ch: string): number {
  if (ch === ' ' || ch === '\t') return -1;
  const c = ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  if (!c) return -1;
  const code = c.charCodeAt(0);
  if (code >= 65 && code <= 90) return GLYPH_LETTERS + code - 65;
  if (code >= 48 && code <= 57) return GLYPH_DIGITS + code - 48;
  const q = c === '’' || c === '‘' ? "'" : c === '“' || c === '”' ? '"' : c === '—' || c === '–' ? '-' : c === '…' ? '.' : c;
  const i = LYRIC_PUNCT.indexOf(q);
  return i >= 0 ? GLYPH_LYRIC_PUNCT + i : -1;
}

/* ───────── the invented script ───────── */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Stroke = [number, number, number, number]; // x0 y0 x1 y1 on the 3 × 4 grid (x 0..2, y 0..3)

/** one glyph of the rain script: a list of strokes and dots on the construction grid */
function scriptGlyph(r: () => number, dense: boolean): { lines: Stroke[]; dots: [number, number][] } {
  const lines: Stroke[] = [];
  const dots: [number, number][] = [];
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  // the stem: most glyphs stand on one, left, centre or right, full height or hanging from the top
  const stemX = pick([0, 1, 2, 2, 1]);
  const stemTop = r() < 0.75 ? 0 : 1;
  const stemBot = r() < 0.7 ? 3 : 2;
  if (r() < 0.86) lines.push([stemX, stemTop, stemX, stemBot]);
  // a head: a bar across the top, or a hook off the stem
  const head = r();
  if (head < 0.45) lines.push([0, 0, 2, 0]);
  else if (head < 0.7) lines.push([stemX, stemTop, stemX === 0 ? 2 : 0, stemTop]);
  else if (head < 0.85) lines.push([stemX === 2 ? 1 : stemX + 1, stemTop, stemX, stemTop + 1]);
  // the body: a mid bar, a diagonal or a second short stem
  const body = r();
  const midY = pick([1, 2, 2]);
  if (body < 0.35) lines.push([stemX === 2 ? 0 : stemX, midY, stemX === 0 ? 2 : stemX === 2 ? 2 : 2, midY]);
  else if (body < 0.6) lines.push([pick([0, 2]), pick([1, 2]), 1, 3]);
  else if (body < 0.8) {
    const x = stemX === 1 ? pick([0, 2]) : 1;
    lines.push([x, midY, x, 3]);
  } else lines.push([0, 3, 2, pick([1, 2])]);
  // a foot or a tick
  if (r() < 0.35) lines.push([stemX, 3, stemX === 2 ? 1 : stemX + 1, 3]);
  if (r() < 0.3) dots.push([pick([0, 2]), pick([0, 1, 2])]);
  if (dense) {
    // the second hand: boxed forms and extra crossbars
    if (r() < 0.5) {
      const y0 = pick([0, 1]);
      lines.push([0, y0, 2, y0], [0, y0 + 2, 2, y0 + 2], [0, y0, 0, y0 + 2], [2, y0, 2, y0 + 2]);
    } else lines.push([0, pick([1, 2]), 2, pick([1, 2])]);
    if (r() < 0.5) dots.push([1, pick([1, 2])]);
  }
  return { lines, dots };
}

function drawScript(g: CanvasRenderingContext2D, x: number, y: number, glyph: { lines: Stroke[]; dots: [number, number][] }) {
  // the glyph box inside the cell (padding keeps mip levels from bleeding into neighbours)
  const bw = CELL_W * 0.56;
  const bh = CELL_H * 0.66;
  const ox = x + (CELL_W - bw) / 2;
  const oy = y + (CELL_H - bh) / 2;
  const gx = (i: number) => ox + (i / 2) * bw;
  const gy = (j: number) => oy + (j / 3) * bh;
  g.lineWidth = CELL_H * 0.085;
  g.lineCap = 'square';
  g.lineJoin = 'miter';
  g.beginPath();
  for (const [x0, y0, x1, y1] of glyph.lines) {
    g.moveTo(gx(x0), gy(y0));
    g.lineTo(gx(x1), gy(y1));
  }
  g.stroke();
  const d = CELL_H * 0.1;
  for (const [i, j] of glyph.dots) g.fillRect(gx(i) - d / 2, gy(j) - d / 2, d, d);
}

function drawChar(g: CanvasRenderingContext2D, x: number, y: number, ch: string, mirror: boolean, weight = 500, em = 0.66) {
  g.save();
  g.translate(x + CELL_W / 2, y + CELL_H / 2);
  if (mirror) g.scale(-1, 1);
  g.font = `${weight} ${Math.round(CELL_H * em)}px ${MONO}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(ch, 0, CELL_H * 0.04);
  g.restore();
}

function paint(canvas: HTMLCanvasElement) {
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  const at = (i: number): [number, number] => [(i % ATLAS_COLS) * CELL_W, Math.floor(i / ATLAS_COLS) * CELL_H];
  // the script, deterministic: the same alphabet on every machine
  const r = rng(0x5eed);
  const seen = new Set<string>();
  const make = (dense: boolean) => {
    for (let tries = 0; tries < 40; tries++) {
      const gl = scriptGlyph(r, dense);
      const sig = JSON.stringify(gl);
      if (gl.lines.length >= 2 && !seen.has(sig)) {
        seen.add(sig);
        return gl;
      }
    }
    return scriptGlyph(r, dense);
  };
  for (let i = 0; i < 48; i++) drawScript(g, ...at(GLYPH_SCRIPT + i), make(false));
  for (let i = 0; i < 32; i++) drawScript(g, ...at(GLYPH_SCRIPT2 + i), make(true));
  for (let i = 0; i < 10; i++) drawChar(g, ...at(GLYPH_MIRROR + i), String(i), true);
  TERMINAL_PUNCT.forEach((c, i) => drawChar(g, ...at(GLYPH_PUNCT + i), c, false));
  // the lyric set is cut bigger: it has to read as words, not texture
  for (let i = 0; i < 26; i++) drawChar(g, ...at(GLYPH_LETTERS + i), String.fromCharCode(65 + i), false, 600, 0.84);
  for (let i = 0; i < 10; i++) drawChar(g, ...at(GLYPH_DIGITS + i), String(i), false, 600, 0.84);
  LYRIC_PUNCT.forEach((c, i) => drawChar(g, ...at(GLYPH_LYRIC_PUNCT + i), c, false, 600, 0.84));
}

let shared: THREE.CanvasTexture | null = null;
let users = 0;

/** the atlas texture, shared by every Undercode instance (released when the last one lets go) */
export function acquireAtlas(): THREE.CanvasTexture {
  users++;
  if (shared) return shared;
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLS * CELL_W;
  canvas.height = ATLAS_ROWS * CELL_H;
  paint(canvas);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 1;
  shared = tex;
  // the letters want the real mono face: repaint once it has loaded
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (fonts?.load) {
    Promise.all([fonts.load(`600 40px 'JetBrains Mono Variable'`), fonts.load(`500 40px 'JetBrains Mono Variable'`)])
      .then(() => {
        if (shared !== tex) return;
        paint(canvas);
        tex.needsUpdate = true;
      })
      .catch(() => undefined);
  }
  return tex;
}

export function releaseAtlas() {
  users = Math.max(0, users - 1);
  if (users === 0 && shared) {
    shared.dispose();
    shared = null;
  }
}

/** GLSL: read one atlas glyph's coverage at local cell uv (0..1, y up) with an explicit mip level */
export const GLSL_ATLAS = /* glsl */ `
uniform sampler2D uAtlas;
const vec2 UC_GRID = vec2(${ATLAS_COLS}.0, ${ATLAS_ROWS}.0);
const float UC_CELL_H = ${CELL_H}.0;
float ucGlyph(float gi, vec2 lu, float lod) {
  float cx = mod(gi, UC_GRID.x);
  float cy = floor(gi / UC_GRID.x);
  lu = clamp(lu, 0.02, 0.98);
  vec2 uv = vec2((cx + lu.x) / UC_GRID.x, 1.0 - (cy + 1.0 - lu.y) / UC_GRID.y);
  return texture2DLodEXT(uAtlas, uv, lod).r;
}
// a rain glyph from the pool: 0 mixed (script, mirrored numerals, punctuation), 1 script only, 2 hex
float ucPoolGlyph(float h, float pool) {
  if (pool > 1.5) {
    float k = floor(h * 22.0);
    return k < 10.0 ? ${GLYPH_DIGITS}.0 + k : k < 16.0 ? ${GLYPH_LETTERS}.0 + (k - 10.0) : ${GLYPH_PUNCT}.0 + (k - 16.0);
  }
  if (pool > 0.5) {
    float k = floor(h * 80.0);
    return k < 48.0 ? k : ${GLYPH_SCRIPT2}.0 + (k - 48.0);
  }
  float k = floor(h * 104.0);
  return k < 48.0 ? k : k < 80.0 ? ${GLYPH_SCRIPT2}.0 + (k - 48.0) : k < 92.0 ? ${GLYPH_MIRROR}.0 + mod(k - 80.0, 10.0) : ${GLYPH_PUNCT}.0 + (k - 92.0);
}
`;
