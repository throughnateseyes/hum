/**
 * The shot's word set at several depths (prototype, see src/dev/shot.ts), so the camera travels
 * through layers of the same flat type: solid ink, solid paper, an outline, a palette colour, and one
 * big copy that ends up just in front of the lens, large and out of focus.
 *
 * The word is drawn once to a canvas and every layer is a quad showing it. Each layer slides up and
 * fades in as the travel brings it within reach of the plane in focus, softens the further it sits
 * from that plane (a cheap blur in the shader), and fades away once it has passed. All of it is worked
 * out from song time and travel, so the shot scrubs both ways.
 */
import * as THREE from 'three';
import { CAM_Z, inkOf, type Motif, type MotifFactory } from '../kit';
import { clamp01, easeOutExpo, smooth } from '../time';

const FONT = '800 SIZEpx "Archivo Variable", "Inter Variable", sans-serif';
const FONT_PX = 260;
/** a layer shows up once it is this close ahead of the plane in focus */
const APPEAR = -7;
/** how quickly layers go soft away from the plane in focus (world units of blur per unit of depth ratio) */
const BLUR_K = 0.1;
/** the blur never spreads further than this, as a fraction of the word's height; the quad leaves room for it */
const MAX_BLUR = 0.3;
const PAD = MAX_BLUR + 0.06;
/** the outline's reach, as a fraction of the word's height */
const STROKE = 0.022;

/** the word in white on a transparent canvas, sized to the text (a copy of textCanvas() in overlay.ts) */
function wordCanvas(text: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = FONT.replace('SIZE', String(FONT_PX));
  ctx.font = font;
  const pad = Math.round(FONT_PX * 0.08);
  canvas.width = Math.ceil(ctx.measureText(text).width) + pad * 2;
  canvas.height = Math.ceil(FONT_PX * 1.12);
  ctx.font = font;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, pad, Math.round(FONT_PX * 0.88));
  return canvas;
}

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
uniform vec3 uColor;
uniform float uMode;    // 0 solid, 1 outline
uniform float uAlpha;
uniform float uZ;       // resting z
uniform float uTravel;
uniform float uH;       // the word's height in world units
uniform float uAspect;  // the canvas's height over its width: turns a reach in heights into one in widths
uniform vec2 uPad;      // room round the word for the blur, in fractions of the word

float A(vec2 uv) {
  vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return texture2D(tText, uv).a * inside.x * inside.y;
}

// a soft disc of 24 taps on a spiral, so a blurred word smears evenly instead of doubling
float blurred(vec2 uv, vec2 r) {
  float s = 0.0;
  for (int i = 0; i < 24; i++) {
    float fi = float(i) + 0.5;
    float ang = fi * 2.39996323;
    s += A(uv + vec2(cos(ang), sin(ang)) * sqrt(fi / 24.0) * r);
  }
  return s / 24.0;
}

void main() {
  float zc = uZ + uTravel;
  if (zc > ${(CAM_Z - 0.3).toFixed(2)}) discard;
  // depth of field: sharp on the plane in focus, softer away from it, most of all near the lens
  float coc = abs(zc) / max(0.35, ${CAM_Z.toFixed(1)} - zc) * ${BLUR_K.toFixed(3)};
  float ry = min(coc / uH, ${MAX_BLUR.toFixed(2)});
  vec2 r = vec2(ry * uAspect, ry);
  vec2 uv = vUv * (1.0 + 2.0 * uPad) - uPad;
  float a = blurred(uv, r);
  if (uMode > 0.5) {
    // outline: the most ink among eight neighbours, minus the ink here
    vec2 o = vec2(${STROKE.toFixed(3)} * uAspect, ${STROKE.toFixed(3)}) + r * 0.5;
    vec2 q = o * 0.7071;
    float m = max(max(A(uv + vec2(o.x, 0.0)), A(uv - vec2(o.x, 0.0))), max(A(uv + vec2(0.0, o.y)), A(uv - vec2(0.0, o.y))));
    m = max(m, max(max(A(uv + q), A(uv - q)), max(A(uv + vec2(q.x, -q.y)), A(uv + vec2(-q.x, q.y)))));
    a = clamp(m - a, 0.0, 1.0);
  }
  // a blurred layer spreads its ink over more of the picture, so it gets fainter
  float blur = ry * 2.0;
  a *= uAlpha / (1.0 + blur * 1.5);
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
}
`;

interface Layer {
  mesh: THREE.Mesh;
  u: Record<string, THREE.IUniform>;
  z: number;
  y: number;
  /** song time the layer comes within reach of the plane in focus */
  arrive: number;
  front: boolean;
}

const EMPTY: () => Motif = () => ({ space: 'world', object: new THREE.Group(), update() {}, dispose() {} });

export const typeStack: MotifFactory = (ctx) => {
  if (!ctx.word) return EMPTY();
  const { halfW, halfH, palette, beat, start, end, depth } = ctx;
  const root = new THREE.Group();

  const canvas = wordCanvas(ctx.word);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  const aspect = canvas.height / canvas.width;
  const quad = new THREE.PlaneGeometry(1, 1);
  const materials: THREE.ShaderMaterial[] = [];

  // when the travel first brings resting z within reach, sampled once here so update() stays pure
  const steps = 240;
  const arrival = (z: number, i: number): number => {
    if (z + ctx.travel(start) >= APPEAR) return start + i * 0.25 * beat;
    for (let k = 1; k <= steps; k++) {
      const t = start + ((end - start) * k) / steps;
      if (z + ctx.travel(t) >= APPEAR) return t;
    }
    return Infinity;
  };

  // treatments: solid ink, solid paper, an ink outline, a palette colour
  const treatments: { color: THREE.Color; mode: number }[] = [
    { color: inkOf(palette, 'ink'), mode: 0 },
    { color: inkOf(palette, 'paper'), mode: 0 },
    { color: inkOf(palette, 'ink'), mode: 1 },
    { color: inkOf(palette, Math.floor(ctx.rnd() * 5)), mode: 0 },
  ];
  const first = Math.floor(ctx.rnd() * treatments.length);

  const layers: Layer[] = [];
  const make = (z: number, width: number, x: number, y: number, look: { color: THREE.Color; mode: number }, front: boolean, i: number) => {
    const h = width * aspect;
    const padX = PAD * aspect;
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tText: { value: tex },
        uColor: { value: look.color },
        uMode: { value: look.mode },
        uAlpha: { value: 0 },
        uZ: { value: z },
        uTravel: { value: 0 },
        uH: { value: h },
        uAspect: { value: aspect },
        uPad: { value: new THREE.Vector2(padX, PAD) },
      },
    });
    materials.push(mat);
    const mesh = new THREE.Mesh(quad, mat);
    mesh.scale.set(width * (1 + 2 * padX), h * (1 + 2 * PAD), 1);
    mesh.position.set(x, y, z);
    mesh.renderOrder = front ? 5 : 2;
    mesh.frustumCulled = false;
    mesh.visible = false;
    root.add(mesh);
    layers.push({ mesh, u: mat.uniforms, z, y, arrive: arrival(z, i), front });
  };

  const n = 3;
  const back = depth + 3;
  for (let i = 0; i < n; i++) {
    const z = -(back * i) / (n - 1);
    const width = (1.1 + ctx.rnd() * 0.6) * halfW;
    const x = (ctx.rnd() * 0.7 - 0.35) * halfW;
    const y = (ctx.rnd() * 0.45 - 0.12) * halfH;
    make(z, width, x, y, treatments[(first + i) % treatments.length], false, i);
  }
  // the big one: it ends the shot just in front of the lens and may overflow the frame
  make(2.5 - depth, 2.1 * halfW, (ctx.rnd() * 0.7 - 0.35) * halfW, (ctx.rnd() * 0.2 - 0.1) * halfH, { color: inkOf(palette, Math.floor(ctx.rnd() * 5)), mode: 0 }, true, n);

  const rise = 0.15 * halfH;
  return {
    space: 'world',
    object: root,
    update(f) {
      for (const l of layers) {
        const zc = l.z + f.travel;
        const age = f.t - l.arrive;
        const fadeIn = clamp01(age / (beat * 0.6));
        const passed = l.front ? 1 : 1 - smooth(1.2, 2.6, zc);
        // a shot that settles hands the picture back clean
        const out = ctx.leave === 'settle' ? 1 - smooth(end - beat * 2.4, end - beat * 0.6, f.t) : 1;
        const a = fadeIn * passed * out;
        l.mesh.visible = a > 0.003 && zc < CAM_Z - 0.3;
        if (!l.mesh.visible) continue;
        l.mesh.position.y = l.y - rise * (1 - easeOutExpo(clamp01(age / (beat * 0.9))));
        l.u.uAlpha.value = a;
        l.u.uTravel.value = f.travel;
      }
    },
    dispose() {
      tex.dispose();
      quad.dispose();
      for (const m of materials) m.dispose();
    },
  };
};
