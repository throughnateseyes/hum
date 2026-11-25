/**
 * Type for footage shots: a line of text drawn once to a canvas and shown on a plane where every
 * letter can sit below its line (hidden), on it, or above it (gone), so a word rises letter by letter.
 *
 * Canvases are kept by text, font and size (the same title and captions come back in every part of
 * the song, and drawing a large word costs more than the rest of a cut), and placeLine() sets a line
 * by its cap height and baseline so type lines up with the grid.
 *
 * A line set straight on the picture (over()) keeps itself readable there: its shader reads the ground
 * under it (ground.ts) and, where the line's own colour doesn't clear its contrast, draws a keyline and
 * a soft glow in the scheme's other ink round the letters. Over a picture it already reads on, nothing.
 */
import * as THREE from 'three';

export const MAX_LETTERS = 24;
export const DISPLAY_FONT = '800 SIZEpx "Archivo Variable", "Inter Variable", sans-serif';
export const MONO_FONT = '500 SIZEpx "JetBrains Mono Variable", "IBM Plex Mono", monospace';

/** box height of a line, and where its baseline and cap line sit in it (fractions of the box) */
const BOX = 1.12;
const BASE = 0.88;
const PAD = 0.08;
const CAP = { display: 0.72, mono: 0.73 };

/** what every line over the picture reads: the shrunken ground, the picture's size, and whether there is one */
export const GROUND = {
  tGround: { value: null as THREE.Texture | null },
  uSize: { value: new THREE.Vector2(1, 1) },
  uGround: { value: 0 },
  /** 1 when a finish (film, tape, a print, a drawing) is worked over the picture */
  uFinish: { value: 0 },
};
/** room round the type's box for the keyline and glow (box heights) */
const MARGIN = 0.13;

const VERT = /* glsl */ `
varying vec2 vUv;
uniform vec2 uMargin;
void main() {
  // a guarded line's plane is a little bigger than its box, for what goes round the letters
  vUv = (uv - 0.5) * (1.0 + 2.0 * uMargin) + 0.5;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy * (1.0 + 2.0 * uMargin), position.z, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tText;
uniform float uEdges[${MAX_LETTERS}];
uniform float uReveal[${MAX_LETTERS}];
uniform vec3 uColor;
uniform float uAlpha;
// the contrast the line must clear (0: not guarded), what goes round it, and its box's width over height
uniform float uGuard;
uniform vec3 uAround;
uniform float uRatio;
uniform sampler2D tGround;
uniform vec2 uSize;
uniform float uGround;
uniform float uFinish;

float ink(vec2 uv) {
  vec2 in01 = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return texture2D(tText, uv).a * in01.x * in01.y;
}
float lum(vec3 c) {
  return dot(pow(c, vec3(2.2)), vec3(0.2126, 0.7152, 0.0722));
}
float contrast(float a, float b) {
  return (max(a, b) + 0.05) / (min(a, b) + 0.05);
}
/** how much the line needs its keyline here: the worst of the ground round this pixel */
float need() {
  if (uGround < 0.5) return 0.85;
  vec2 at = gl_FragCoord.xy / uSize;
  vec2 d = vec2(0.016 * uSize.y / uSize.x, 0.016);
  float L = lum(uColor);
  float worst = 21.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) worst = min(worst, contrast(L, lum(texture2D(tGround, at + vec2(float(i), float(j)) * d).rgb)));
  return 1.0 - smoothstep(uGuard * 1.05, uGuard * 1.9, worst);
}

/** the same of the whole line: the worst of five places along it (the ground is blurred enough for that) */
float needLine() {
  if (uGround < 0.5) return 1.0;
  vec2 gx = dFdx(vUv), gy = dFdy(vUv);
  float det = gx.x * gy.y - gy.x * gx.y;
  if (abs(det) < 1e-12) return 0.0;
  float L = lum(uColor);
  float worst = 21.0;
  for (int i = 0; i < 5; i++) {
    vec2 d = vec2(0.04 + 0.23 * float(i), 0.5) - vUv;
    vec2 at = gl_FragCoord.xy + vec2(gy.y * d.x - gy.x * d.y, gx.x * d.y - gx.y * d.x) / det;
    worst = min(worst, contrast(L, lum(texture2D(tGround, at / uSize).rgb)));
  }
  return 1.0 - smoothstep(uGuard * 1.05, uGuard * 1.6, worst);
}

void main() {
  float rv = uReveal[0];
  for (int i = 1; i < ${MAX_LETTERS}; i++) if (vUv.x >= uEdges[i]) rv = uReveal[i];
  vec2 uv = vec2(vUv.x, vUv.y + 1.0 - rv);
  float a = ink(uv);
  vec3 color = uColor;
  float px = fwidth(vUv.y);
  // small type under a finish: grain, tape and brush marks eat thin strokes and middling colours, so its
  // strokes are fattened a little and its colour taken toward black or white
  float sturdy = uFinish * smoothstep(14.0, 20.0, px * min(uSize.x, uSize.y));
  if (sturdy > 0.0) {
    vec2 o = vec2(1.0 / uRatio, 1.0) * max(0.028, 0.75 * px);
    a = mix(a, max(a, max(max(ink(uv + vec2(o.x, 0.0)), ink(uv - vec2(o.x, 0.0))), max(ink(uv + vec2(0.0, o.y)), ink(uv - vec2(0.0, o.y))))), sturdy);
    color = mix(color, vec3(lum(color) > 0.3 ? 1.0 : 0.0), 0.65 * sturdy);
  }
  float around = 0.0;
  if (uGuard > 0.0) {
    // the keyline's reach: a tenth of small type, about a hundredth of the frame on huge type, never under two pixels
    float r = max(2.2 * px, min(0.1, 0.011 * min(uSize.x, uSize.y) * px));
    float near = 0.0;
    float far = 0.0;
    for (int i = 0; i < 12; i++) {
      float th = float(i) * 0.5235988;
      vec2 o = vec2(cos(th) / uRatio, sin(th)) * r;
      near = max(near, ink(uv + o * 0.6));
      far += ink(uv + o * 1.25);
    }
    around = max(near, smoothstep(0.0, 6.0, far) * 0.75) * need();
    // a keyline this thin doesn't live through a finish either: the line goes on a strip instead
    if (sturdy > 0.0) {
      vec2 inStrip = step(vec2(-0.12 / uRatio, 0.03), vUv) * step(vUv, vec2(1.0 + 0.12 / uRatio, 0.97));
      around = max(around, inStrip.x * inStrip.y * clamp(rv, 0.0, 1.0) * clamp(2.0 - rv, 0.0, 1.0) * sturdy * needLine());
    }
  }
  float all = a + around * (1.0 - a);
  if (all * uAlpha < 0.003) discard;
  gl_FragColor = vec4((color * a + uAround * around * (1.0 - a)) / all, all * uAlpha);
}
`;

interface Drawn {
  texture: THREE.CanvasTexture;
  edges: number[];
  ratio: number;
}

/** canvases already drawn, oldest first; a texture is shared by every line showing that text */
const drawn = new Map<string, Drawn>();
const KEEP = 48;

function draw(text: string, font: string, size: number): Drawn {
  const key = `${font}|${size}|${text}`;
  const had = drawn.get(key);
  if (had) {
    drawn.delete(key);
    drawn.set(key, had);
    return had;
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const css = font.replace('SIZE', String(size));
  ctx.font = css;
  const pad = Math.round(size * PAD);
  const width = Math.ceil(ctx.measureText(text).width) + pad * 2;
  canvas.width = Math.max(1, width);
  canvas.height = Math.ceil(size * BOX);
  ctx.font = css;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, pad, Math.round(size * BASE));
  // measured as prefixes, so kerning is counted
  const edges = Array.from(text, (_, i) => (i ? pad + ctx.measureText(text.slice(0, i)).width - size * 0.01 : 0) / width);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = 4;
  const d = { texture, edges, ratio: canvas.width / canvas.height };
  drawn.set(key, d);
  // let go of the oldest; a line still showing one keeps its own reference to the texture's image
  while (drawn.size > KEEP) {
    const [oldKey, old] = drawn.entries().next().value as [string, Drawn];
    drawn.delete(oldKey);
    old.texture.dispose();
  }
  return d;
}

export interface TypeLine {
  mesh: THREE.Mesh;
  /** one value per letter: 0 below the line, 1 on it, 2 gone above. Write into it, then nothing else to do. */
  reveal: number[];
  count: number;
  /** width / height of the type's box */
  ratio: number;
  /** cap height as a fraction of the box height */
  cap: number;
  setAlpha(a: number): void;
  setColor(c: THREE.Color | string): void;
  /** this line stands straight on the picture: `around` goes round it where it must, to clear `target` contrast */
  over(around: string, target: number): void;
  /** every letter on its line (1), below it (0) or anywhere between */
  show(v: number): void;
  dispose(): void;
}

const unit = new THREE.PlaneGeometry(1, 1);

/** one line of type as a 1 × 1 plane: scale it to (height × ratio, height), or use placeLine() */
export function typeLine(text: string, color: THREE.Color | string, font = DISPLAY_FONT, size = 300): TypeLine {
  const word = text.slice(0, MAX_LETTERS);
  const d = draw(word, font, size);
  const reveal = new Array<number>(MAX_LETTERS).fill(1);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tText: { value: d.texture },
      uEdges: { value: Array.from({ length: MAX_LETTERS }, (_, i) => (i < d.edges.length ? d.edges[i] : 2)) },
      uReveal: { value: reveal },
      uColor: { value: new THREE.Color(color) },
      uAlpha: { value: 1 },
      uMargin: { value: new THREE.Vector2(0, 0) },
      uGuard: { value: 0 },
      uAround: { value: new THREE.Color(0) },
      uRatio: { value: d.ratio },
      ...GROUND,
    },
  });
  const mesh = new THREE.Mesh(unit, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  return {
    mesh,
    reveal,
    count: word.length,
    ratio: d.ratio,
    cap: (font === MONO_FONT ? CAP.mono : CAP.display) / BOX,
    setAlpha: (a) => {
      mat.uniforms.uAlpha.value = a;
    },
    setColor: (c) => {
      (mat.uniforms.uColor.value as THREE.Color).set(c);
    },
    over: (around, target) => {
      (mat.uniforms.uAround.value as THREE.Color).set(around);
      mat.uniforms.uGuard.value = target;
      (mat.uniforms.uMargin.value as THREE.Vector2).set(MARGIN / d.ratio, MARGIN);
    },
    show: (v) => reveal.fill(v),
    // the texture belongs to the shared cache
    dispose: () => mat.dispose(),
  };
}

/**
 * Set a line by its cap height, with its left (or right) edge on `x` and its baseline on `y`.
 * Returns its width.
 */
export function placeLine(line: TypeLine, x: number, y: number, cap: number, align: 'left' | 'right' = 'left'): number {
  const h = cap / line.cap;
  const w = h * line.ratio;
  const pad = (PAD / BOX) * h;
  const left = align === 'left' ? x - pad : x - w + pad;
  line.mesh.rotation.z = 0;
  line.mesh.scale.set(w, h, 1);
  line.mesh.position.set(left + w / 2, y - (1 - BASE / BOX) * h + h / 2, 0);
  return w - pad * 2;
}

/** is this mesh a line of type? (and one over the picture) */
export const isType = (o: THREE.Object3D): o is THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> => !!((o as THREE.Mesh).material as THREE.ShaderMaterial | undefined)?.uniforms?.uReveal;
export const isOverPicture = (o: THREE.Object3D) => isType(o) && (o.material.uniforms.uGuard.value as number) > 0;

/** where a placed line's letters are, in world units (the padding round them in their box left out) */
export function inkBox(mesh: THREE.Mesh): { x0: number; y0: number; x1: number; y1: number } {
  const w = mesh.scale.x;
  const h = mesh.scale.y;
  const pad = (PAD / BOX) * h;
  let box = { x0: -w / 2 + pad, x1: w / 2 - pad, y0: h * (0.5 - BASE / BOX), y1: h * (0.5 - (BASE - 0.74) / BOX) };
  // (a line turned a quarter reads up the frame)
  if (Math.abs(mesh.rotation.z) > 1) box = { x0: -box.y1, x1: -box.y0, y0: box.x0, y1: box.x1 };
  const { x, y } = mesh.position;
  return { x0: box.x0 + x, x1: box.x1 + x, y0: box.y0 + y, y1: box.y1 + y };
}

/** the width the ink of a line takes at this cap height */
export const lineWidth = (line: TypeLine, cap: number) => (cap / line.cap) * line.ratio * (1 - (2 * PAD) / (line.ratio * BOX));

/** letters rise onto their line from `from`, one after another, all of them in `over` seconds */
export function riseLetters(line: TypeLine, t: number, from: number, over = 0.2) {
  const n = Math.max(1, line.count);
  const each = over * 0.6;
  const stagger = n > 1 ? (over - each) / (n - 1) : 0;
  for (let i = 0; i < line.count; i++) {
    const x = Math.min(1, Math.max(0, (t - from - i * stagger) / each));
    line.reveal[i] = x >= 1 ? 1 : 1 - 2 ** (-10 * x);
  }
}
