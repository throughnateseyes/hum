/**
 * Type for footage shots: a line of text drawn once to a canvas and shown on a plane where every
 * letter can sit below its line (hidden), on it, or above it (gone), so a word rises letter by letter.
 *
 * Canvases are kept by text, font and size (the same title and captions come back in every part of
 * the song, and drawing a large word costs more than the rest of a cut), and placeLine() sets a line
 * by its cap height and baseline so type lines up with the grid.
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

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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
void main() {
  float rv = uReveal[0];
  for (int i = 1; i < ${MAX_LETTERS}; i++) if (vUv.x >= uEdges[i]) rv = uReveal[i];
  vec2 uv = vec2(vUv.x, vUv.y + 1.0 - rv);
  float a = texture2D(tText, uv).a * step(0.0, uv.y) * step(uv.y, 1.0) * uAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
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
