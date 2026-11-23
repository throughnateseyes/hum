/**
 * The glyph atlas the treatments draw text and character cells from: drawn to one canvas once, in the
 * mono face the app ships (JetBrains Mono), 16 slots across and 8 down.
 *
 * Text glyphs come from the font; the block characters (full, three shades, halves) are drawn as
 * plain rectangles and dither patterns, so they are exact whatever the font has.
 *
 * In GLSL, ATLAS_GLSL gives `atlas(index, local)`: the coverage (0..1) of glyph `index` at `local`
 * (0..1 across its square slot, y up). A line of text is a row of a small data texture holding glyph
 * indices (see TextLines below).
 */
import * as THREE from 'three';

const COLS = 16;
const ROWS = 8;
const SLOT = 64;

/** the characters drawn from the font, in slot order from 1 (slot 0 is empty) */
const TEXT = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.:\'"-+=*/\\|_#%<>()·°';

/** where the block characters live */
export const BLOCK = { full: 64, dark: 65, mid: 66, light: 67, upper: 68, lower: 69, left: 70, right: 71, dots: 72 } as const;

/** a character's slot (0 for anything the atlas doesn't have: drawn as empty) */
export function glyphOf(ch: string): number {
  const i = TEXT.indexOf(ch.toUpperCase());
  return i < 0 ? 0 : i + 1;
}

let canvas: HTMLCanvasElement | null = null;
let texture: THREE.CanvasTexture | null = null;

function draw(c: HTMLCanvasElement) {
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.font = '500 50px "JetBrains Mono Variable", "IBM Plex Mono", ui-monospace, monospace';
  Array.from(TEXT).forEach((ch, i) => {
    const s = i + 1;
    const x = (s % COLS) * SLOT;
    const y = Math.floor(s / COLS) * SLOT;
    g.fillText(ch, x + SLOT / 2, y + SLOT * 0.77);
  });
  const at = (s: number) => [(s % COLS) * SLOT, Math.floor(s / COLS) * SLOT] as const;
  const rect = (s: number, x0: number, y0: number, x1: number, y1: number) => {
    const [x, y] = at(s);
    g.fillRect(x + x0 * SLOT, y + y0 * SLOT, (x1 - x0) * SLOT, (y1 - y0) * SLOT);
  };
  rect(BLOCK.full, 0, 0, 1, 1);
  rect(BLOCK.upper, 0, 0, 1, 0.5);
  rect(BLOCK.lower, 0, 0.5, 1, 1);
  rect(BLOCK.left, 0, 0, 0.5, 1);
  rect(BLOCK.right, 0.5, 0, 1, 1);
  // shades: an 8 x 8 dither in each slot, like the shade characters of an old terminal
  const dither = (s: number, keep: (i: number, j: number) => boolean) => {
    const [x, y] = at(s);
    const d = SLOT / 8;
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) if (keep(i, j)) g.fillRect(x + i * d, y + j * d, d, d);
  };
  dither(BLOCK.dark, (i, j) => !(i % 2 === 0 && j % 2 === 0));
  dither(BLOCK.mid, (i, j) => (i + j) % 2 === 0);
  dither(BLOCK.light, (i, j) => i % 2 === 0 && j % 2 === 0);
  dither(BLOCK.dots, (i, j) => i % 4 === 1 && j % 4 === 1);
}

/** the atlas texture, shared by every treatment on every renderer (each uploads its own copy) */
export function atlasTexture(): THREE.CanvasTexture {
  if (texture) return texture;
  canvas = document.createElement('canvas');
  canvas.width = COLS * SLOT;
  canvas.height = ROWS * SLOT;
  draw(canvas);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  texture = t;
  // the font may still be loading on the first frame: draw again once it is here
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  void fonts?.load('500 50px "JetBrains Mono Variable"').then(() => {
    if (!canvas) return;
    draw(canvas);
    t.needsUpdate = true;
  });
  return t;
}

export const ATLAS_GLSL = /* glsl */ `
uniform sampler2D tAtlas;
float atlas(float index, vec2 local) {
  if (index < 0.5) return 0.0;
  float gx = mod(index, ${COLS}.0);
  float gy = floor(index / ${COLS}.0);
  vec2 l = clamp(local, 0.02, 0.98);
  vec2 uv = vec2((gx + l.x) / ${COLS}.0, 1.0 - (gy + 1.0 - l.y) / ${ROWS}.0);
  return texture2D(tAtlas, uv).a;
}
`;

/* ───────── lines of text, drawn in a shader ───────── */

export const MAX_LINES = 8;
export const LINE_CHARS = 40;

/**
 * Up to eight lines of text a treatment sets over its picture: glyph indices in a small data texture
 * (one row per line), and for each line its place, letter size, colour and an optional box behind it.
 */
export class TextLines {
  readonly data: Uint8Array;
  readonly texture: THREE.DataTexture;
  /** x, y of the bottom-left (px from the bottom-left of the frame), letter width and height (px) */
  readonly place: THREE.Vector4[];
  readonly color: THREE.Vector4[];
  /** the box behind a line: rgb, and alpha (0: none) */
  readonly back: THREE.Vector4[];
  count = 0;
  private dirty = true;

  /** `max` lines at most (the shader must be made with the same number: textGlsl(max)) */
  constructor(readonly max = MAX_LINES) {
    this.data = new Uint8Array(LINE_CHARS * max * 4);
    this.place = Array.from({ length: max }, () => new THREE.Vector4(0, 0, 0, 0));
    this.color = Array.from({ length: max }, () => new THREE.Vector4(1, 1, 1, 1));
    this.back = Array.from({ length: max }, () => new THREE.Vector4(0, 0, 0, 0));
    this.texture = new THREE.DataTexture(this.data, LINE_CHARS, max, THREE.RGBAFormat);
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;
  }

  clear() {
    this.count = 0;
  }

  /** add a line: `x`, `y` its bottom-left in px; `h` its letter height, `w` letter width (default mono, 0.62 h) */
  add(text: string, x: number, y: number, h: number, color: THREE.Color, back: THREE.Color | null = null, w = h * 0.62) {
    if (this.count >= this.max) return;
    const i = this.count++;
    for (let c = 0; c < LINE_CHARS; c++) {
      const v = c < text.length ? glyphOf(text[c]) : 0;
      const k = (i * LINE_CHARS + c) * 4;
      if (this.data[k] !== v) {
        this.data[k] = v;
        this.dirty = true;
      }
    }
    this.place[i].set(x, y, w, h);
    this.color[i].set(color.r, color.g, color.b, 1);
    this.back[i].set(back?.r ?? 0, back?.g ?? 0, back?.b ?? 0, back ? 1 : 0);
  }

  /** call once the lines for this frame are set */
  commit() {
    if (this.dirty) this.texture.needsUpdate = true;
    this.dirty = false;
  }

  uniforms() {
    return {
      tText: { value: this.texture },
      uLinePlace: { value: this.place },
      uLineColor: { value: this.color },
      uLineBack: { value: this.back },
      uLines: { value: 0 },
    };
  }
}

/** `textOver(px, col)` lays the lines over a colour (`max` as the TextLines it reads was made with) */
export const textGlsl = (max: number) => /* glsl */ `
uniform sampler2D tText;
uniform vec4 uLinePlace[${max}];
uniform vec4 uLineColor[${max}];
uniform vec4 uLineBack[${max}];
uniform float uLines;
vec3 textOver(vec2 px, vec3 col) {
  for (int i = 0; i < ${max}; i++) {
    if (float(i) >= uLines) break;
    vec4 pl = uLinePlace[i];
    vec2 q = (px - pl.xy) / pl.zw;
    if (q.y < -0.25 || q.y > 1.25 || q.x < -0.3 || q.x > ${LINE_CHARS}.0) continue;
    float ci = floor(q.x);
    float g = ci >= 0.0 ? texture2D(tText, vec2((ci + 0.5) / ${LINE_CHARS}.0, (float(i) + 0.5) / ${max}.0)).r * 255.0 : 0.0;
    // the box behind the line runs under every letter that is set, with a little room round them
    float filled = g > 0.5 ? 1.0 : 0.0;
    if (uLineBack[i].a > 0.5 && (filled > 0.5 || (ci < 0.0 && q.x > -0.3))) col = uLineBack[i].rgb;
    if (filled < 0.5 || q.y < 0.0 || q.y > 1.0) continue;
    // the line's height covers 0.8 of a square slot (0.12..0.92, descender to accent); a letter's
    // width is the same share of it, taken from the middle of the slot
    vec2 local = vec2(0.5 + (fract(q.x) - 0.5) * 0.8 * pl.z / pl.w, 0.12 + q.y * 0.8);
    col = mix(col, uLineColor[i].rgb, atlas(g, local));
  }
  return col;
}
`;

export const TEXT_GLSL = textGlsl(MAX_LINES);
