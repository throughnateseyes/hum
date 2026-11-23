/**
 * What every shape over a shot is built on (prototype, see src/dev/shot.ts).
 *
 * A shot's graphics are motifs: small pieces (a burst of shapes, bars on the kicks, ribbons, a word)
 * that each own some three.js objects and place them from song time alone. Motifs live in one of two
 * spaces:
 *
 *   'world'  a 3D space the shot travels through. The camera stands still at z = CAM_Z looking down
 *            -z; the world slides toward it as the footage runs (faster on a speed ramp), so shapes
 *            come up out of the distance, pass the lens and leave. z = 0 is the plane in focus.
 *   'frame'  pinned to the picture, on the plane in focus: type, rulers, anything that must stay put.
 *
 * ShapeCloud is the shared way to draw flat shapes with depth: each shape goes soft as it leaves the
 * plane in focus (large and blurred close to the lens), casts a soft shadow on the picture behind it,
 * and can be a window onto a live picture instead of a flat colour.
 */
import * as THREE from 'three';
import type { ShotPalette } from './palette';

export const FOV = 35;
/** the camera's distance from the plane in focus */
export const CAM_Z = 6;

/** half the height and width of the picture on the plane in focus, in world units */
export function frameSize(aspect: number): { halfW: number; halfH: number } {
  const halfH = CAM_Z * Math.tan(((FOV / 2) * Math.PI) / 180);
  return { halfW: halfH * aspect, halfH };
}

export interface MotifContext {
  halfW: number;
  halfH: number;
  /** picture size in px */
  width: number;
  height: number;
  palette: ShotPalette;
  /** seconds per felt beat */
  beat: number;
  /** the shot's stretch of the song (s), and the drum hits that fall in it */
  start: number;
  end: number;
  kicks: number[];
  snares: number[];
  /** how far the world has slid toward the camera at song time t (world units, 0 at the shot's start) */
  travel(t: number): number;
  /** the same at the shot's end: shapes placed between z = -depth and 0 all come past the plane in focus */
  depth: number;
  /** dice that roll the same every run: never use Math.random */
  rnd(): number;
  /** a live picture (one of Hum's looks) that shapes can be windows onto; null when there is none */
  fill: THREE.Texture | null;
  /** the big word of this shot ('' for none) and a small line to go with it */
  word: string;
  caption: string;
  /** how the shot arrives and leaves (see Shot in sequence.ts), and the frames it holds still on a hit (s) */
  arrive: 'hit' | 'cold';
  leave: 'ramp' | 'settle' | 'cut';
  freeze: number;
  /** the whole run of shots this one belongs to (song s): its start, its main hit and its end */
  run: { start: number; hit: number; end: number };
}

export interface MotifFrame {
  /** song time (s) */
  t: number;
  /** how far the world has slid by now (same as ctx.travel(t)) */
  travel: number;
  /** 0..1: how hard the picture is rushing (the speed ramp) */
  rush: number;
  /** the focus point on the plane in focus, in world units */
  focusX: number;
  focusY: number;
  camera: THREE.PerspectiveCamera;
}

export interface Motif {
  space: 'world' | 'frame';
  /** added to the scene for its space; a world motif's children sit at their resting z and the stage slides the whole space */
  object: THREE.Object3D;
  update(f: MotifFrame): void;
  dispose(): void;
}

export type MotifFactory = (ctx: MotifContext) => Motif;

/* ───────── ShapeCloud ───────── */

export const SHAPE = { rect: 0, disc: 1, triangle: 2, ring: 3 } as const;
export type ShapeId = (typeof SHAPE)[keyof typeof SHAPE];

const CLOUD_VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aQuat;
attribute vec2 aSize;
attribute vec3 aColor;
attribute vec4 aParams; // shape, alpha, soft, window
uniform float uShadow;  // 0 the shape itself, 1 its shadow
varying vec2 vP;
varying vec3 vColor;
varying vec4 vParams;
varying vec2 vSize;
vec3 turn(vec3 v, vec4 q) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
void main() {
  float soft = aParams.z + uShadow * 0.5;
  // room round the shape for its soft edge
  float grow = 1.0 + soft * 2.2;
  vec3 local = vec3(position.xy * aSize * grow, 0.0);
  vec3 world = aPos + turn(local, aQuat);
  // a shadow lands lower and further off the higher the shape floats above the picture
  float lift = clamp(aPos.z + 3.0, 0.0, 8.0);
  world.xy += uShadow * vec2(0.035, -0.06) * (0.6 + lift);
  world.z -= uShadow * 0.02;
  vP = position.xy * 2.0 * grow;
  vColor = aColor;
  vParams = vec4(aParams.x, aParams.y, soft, aParams.w);
  vSize = aSize;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
}
`;

const CLOUD_FRAG = /* glsl */ `
precision highp float;
uniform float uShadow;
uniform vec3 uShadowColor;
uniform sampler2D tFill;
uniform vec2 uRes;
uniform float uHasFill;
varying vec2 vP;        // -1..1 across the shape, beyond that in the soft margin
varying vec3 vColor;
varying vec4 vParams;
varying vec2 vSize;

// distance to the shape's edge, in units of the shape's smaller half size (negative inside).
// p spans -1..1 across the shape.
float edge(vec2 p, float shape) {
  if (shape < 0.5) {
    // measured in real units, so a long bar's edge is as soft along it as across it
    vec2 hs = vSize * 0.5;
    vec2 d = abs(p * hs) - hs;
    return (length(max(d, 0.0)) + min(max(d.x, d.y), 0.0)) / min(hs.x, hs.y);
  }
  if (shape < 1.5) return length(p) - 1.0;
  if (shape < 2.5) {
    // an upright triangle
    p.y += 0.3;
    const float k = 1.7320508;
    p.x = abs(p.x) - 1.0;
    p.y = p.y + 1.0 / k;
    if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
    p.x -= clamp(p.x, -2.0, 0.0);
    return -length(p) * sign(p.y);
  }
  return abs(length(p) - 0.82) - 0.18;
}

void main() {
  float d = edge(vP, vParams.x);
  float soft = vParams.z;
  float aa = fwidth(d) * 0.75;
  float cover = 1.0 - smoothstep(-soft - aa, soft + aa, d);
  // a blurred shape spreads its ink over more of the picture, so it gets fainter
  float a = cover * vParams.y / (1.0 + soft * 1.6);
  if (a < 0.004) discard;
  vec3 col = vColor;
  if (vParams.w > 0.5 && uHasFill > 0.5) col = texture2D(tFill, gl_FragCoord.xy / uRes).rgb;
  if (uShadow > 0.5) {
    col = uShadowColor;
    a *= 0.26;
  }
  gl_FragColor = vec4(col, a);
}
`;

const IDENTITY = new THREE.Quaternion();

/**
 * Up to `max` flat shapes drawn in one go. Each frame: call begin(), add() every shape that is on
 * screen, then commit(). Shapes are sorted far to near, so they can overlap softly.
 */
export class ShapeCloud {
  readonly object = new THREE.Group();
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly pos: Float32Array;
  private readonly quat: Float32Array;
  private readonly size: Float32Array;
  private readonly color: Float32Array;
  private readonly params: Float32Array;
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly items: { z: number; data: Float32Array }[] = [];
  private count = 0;
  /** how quickly shapes go soft away from the plane in focus (0 = everything sharp) */
  blur = 1;

  constructor(
    private readonly max: number,
    opts: { shadows?: boolean; shadowColor?: string; fill?: THREE.Texture | null; width?: number; height?: number; order?: number } = {},
  ) {
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    const attr = (name: string, n: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(max * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
      return a.array as Float32Array;
    };
    this.pos = attr('aPos', 3);
    this.quat = attr('aQuat', 4);
    this.size = attr('aSize', 2);
    this.color = attr('aColor', 3);
    this.params = attr('aParams', 4);
    this.geo = geo;
    for (let i = 0; i < max; i++) this.items.push({ z: 0, data: new Float32Array(16) });

    const make = (shadow: boolean) => {
      const m = new THREE.ShaderMaterial({
        vertexShader: CLOUD_VERT,
        fragmentShader: CLOUD_FRAG,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
          uShadow: { value: shadow ? 1 : 0 },
          uShadowColor: { value: new THREE.Color(opts.shadowColor ?? '#101020') },
          tFill: { value: opts.fill ?? null },
          uHasFill: { value: opts.fill ? 1 : 0 },
          uRes: { value: new THREE.Vector2(opts.width ?? 1280, opts.height ?? 720) },
        },
      });
      const mesh = new THREE.Mesh(geo, m);
      mesh.frustumCulled = false;
      mesh.renderOrder = (opts.order ?? 3) + (shadow ? -0.5 : 0);
      this.materials.push(m);
      this.object.add(mesh);
    };
    if (opts.shadows !== false) make(true);
    make(false);
  }

  begin() {
    this.count = 0;
  }

  /**
   * One shape. `x, y, z` is its centre in this cloud's space, `w, h` its full size, `soft` extra blur
   * on top of what its depth gives it (0 for none), `window` true to show the live picture through it.
   */
  add(shape: ShapeId, x: number, y: number, z: number, w: number, h: number, color: THREE.Color, alpha = 1, quat: THREE.Quaternion = IDENTITY, soft = 0, window = false) {
    if (this.count >= this.max || alpha <= 0.003 || w <= 0 || h <= 0) return;
    const d = this.items[this.count++].data;
    d[0] = x;
    d[1] = y;
    d[2] = z;
    d[3] = quat.x;
    d[4] = quat.y;
    d[5] = quat.z;
    d[6] = quat.w;
    d[7] = w;
    d[8] = h;
    d[9] = color.r;
    d[10] = color.g;
    d[11] = color.b;
    d[12] = shape;
    d[13] = alpha;
    d[14] = soft;
    d[15] = window ? 1 : 0;
  }

  /** `travel` is how far this cloud's space has slid toward the camera (0 for a cloud pinned to the frame) */
  commit(travel = 0) {
    const n = this.count;
    const list = this.items;
    for (let i = 0; i < n; i++) list[i].z = list[i].data[2];
    // far to near; the unused tail stays where it is
    const used = list.slice(0, n).sort((a, b) => a.z - b.z);
    for (let i = 0; i < n; i++) {
      const d = used[i].data;
      this.pos.set([d[0], d[1], d[2]], i * 3);
      this.quat.set([d[3], d[4], d[5], d[6]], i * 4);
      this.size.set([d[7], d[8]], i * 2);
      this.color.set([d[9], d[10], d[11]], i * 3);
      // depth of field: sharp on the plane in focus, softer the further from it, most of all near the lens
      const zc = d[2] + travel;
      const lens = Math.max(0.35, CAM_Z - zc);
      const coc = (Math.abs(zc) / lens) * 0.11 * this.blur;
      const reach = Math.max(0.02, Math.min(d[7], d[8]) * 0.5);
      this.params.set([d[12], d[13], d[14] + Math.min(1.6, coc / reach), d[15]], i * 4);
    }
    for (let i = 0; i < n; i++) list[i] = used[i];
    this.geo.instanceCount = n;
    for (const name of ['aPos', 'aQuat', 'aSize', 'aColor', 'aParams']) (this.geo.getAttribute(name) as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  /** true when a point in this cloud's space is still in front of the lens after `travel` */
  static ahead(z: number, travel: number): boolean {
    return z + travel < CAM_Z - 0.3;
  }

  dispose() {
    this.geo.dispose();
    for (const m of this.materials) m.dispose();
  }
}

/** a colour from the shot's palette as a THREE.Color: 0..4 the flats, 'ink', 'paper' */
export function inkOf(palette: ShotPalette, which: number | 'ink' | 'paper'): THREE.Color {
  return new THREE.Color(which === 'ink' ? palette.ink : which === 'paper' ? palette.paper : palette.flats[((which % 5) + 5) % 5]);
}
