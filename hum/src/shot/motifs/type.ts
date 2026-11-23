/**
 * Type for shots (prototype): a word drawn once to a canvas, shown on a plane where every letter can
 * sit below its line (hidden), on it, or above it (gone), so a word rises letter by letter and leaves
 * the same way.
 */
import * as THREE from 'three';

export const MAX_LETTERS = 24;
export const DISPLAY_FONT = '800 SIZEpx "Archivo Variable", "Inter Variable", sans-serif';
export const MONO_FONT = '500 SIZEpx "JetBrains Mono Variable", "IBM Plex Mono", monospace';

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

/** white type on a clear canvas, with where each letter starts (0..1 across the canvas) */
export function textCanvas(text: string, font: string, size: number): { canvas: HTMLCanvasElement; edges: number[] } {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const css = font.replace('SIZE', String(size));
  ctx.font = css;
  const pad = Math.round(size * 0.08);
  const width = Math.ceil(ctx.measureText(text).width) + pad * 2;
  canvas.width = width;
  canvas.height = Math.ceil(size * 1.12);
  ctx.font = css;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, pad, Math.round(size * 0.88));
  // measured as prefixes, so kerning is counted
  const edges = Array.from(text, (_, i) => (i ? pad + ctx.measureText(text.slice(0, i)).width - size * 0.01 : 0) / width);
  return { canvas, edges };
}

export interface TypeLine {
  mesh: THREE.Mesh;
  /** one value per letter: 0 below the line, 1 on it, 2 gone above. Write into it, then nothing else to do. */
  reveal: number[];
  count: number;
  /** width / height of the type's box */
  ratio: number;
  setAlpha(a: number): void;
  dispose(): void;
}

const unit = new THREE.PlaneGeometry(1, 1);

/** one line of display type as a 1 × 1 plane: scale it to (height × ratio, height) */
export function typeLine(text: string, color: THREE.Color, font = DISPLAY_FONT, size = 300): TypeLine {
  const word = text.slice(0, MAX_LETTERS);
  const { canvas, edges } = textCanvas(word, font, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  const reveal = new Array<number>(MAX_LETTERS).fill(0);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tText: { value: tex },
      uEdges: { value: Array.from({ length: MAX_LETTERS }, (_, i) => (i < edges.length ? edges[i] : 2)) },
      uReveal: { value: reveal },
      uColor: { value: color.clone() },
      uAlpha: { value: 1 },
    },
  });
  const mesh = new THREE.Mesh(unit, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  return {
    mesh,
    reveal,
    count: word.length,
    ratio: canvas.width / canvas.height,
    setAlpha: (a) => {
      mat.uniforms.uAlpha.value = a;
    },
    dispose: () => {
      tex.dispose();
      mat.dispose();
    },
  };
}
