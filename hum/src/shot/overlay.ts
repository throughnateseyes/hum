/**
 * What sits on top of a shot's footage (prototype, see src/dev/shot.ts): bare shapes and type in a
 * little 3D space in front of the picture, with no frames or windows round them.
 *
 * Before the hit there is almost nothing: two guide lines draw through the focus point and one thin
 * ring closes in on it as the footage speeds up. On the hit the ring breaks into arcs, a burst of
 * small shapes flies out toward the camera, bars slide in on every kick and the word rises letter by
 * letter. Everything is placed from the shot's score and is a pure function of song time.
 */
import * as THREE from 'three';
import type { ShotPalette } from './palette';
import { LEAD_BEATS, RAMP_BEATS, TAIL_BEATS, clamp01, dice, easeInCubic, easeInExpo, easeOutBack, easeOutCubic, easeOutExpo, smooth, type ShotScore } from './time';

const FOV = 35;
const CAM_Z = 6;
const TAU = Math.PI * 2;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** a ring, or a stretch of one: radius and width are fractions of the quad's half size */
const ARC_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec3 uColor;
uniform float uR, uW, uA0, uSweep, uAlpha;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float aa = fwidth(r);
  float ring = smoothstep(uW * 0.5 + aa, uW * 0.5 - aa, abs(r - uR));
  float d = mod(atan(p.y, p.x) - uA0, 6.2831853) * r;
  float ends = smoothstep(0.0, aa * 1.5, d) * smoothstep(uSweep * r + aa, uSweep * r - aa, d);
  float a = ring * mix(ends, 1.0, step(6.2, uSweep)) * uAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
}
`;

/** type from a canvas, where every letter can sit below its line (hidden), on it, or above it (gone) */
const WORD_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tText;
uniform float uEdges[16];
uniform float uReveal[16];
uniform vec3 uColor;
void main() {
  float rv = uReveal[0];
  for (int i = 1; i < 16; i++) if (vUv.x >= uEdges[i]) rv = uReveal[i];
  vec2 uv = vec2(vUv.x, vUv.y + 1.0 - rv);
  float a = texture2D(tText, uv).a * step(0.0, uv.y) * step(uv.y, 1.0);
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
}
`;

const MAX_LETTERS = 16;

interface Bar {
  mesh: THREE.Mesh;
  at: number;
  life: number;
  rest: number;
  from: number;
}
interface Arc {
  mesh: THREE.Mesh;
  u: Record<string, THREE.IUniform>;
  r: number;
  sweep: number;
  a0: number;
  turn: number;
  delay: number;
}
interface Bit {
  to: THREE.Vector3;
  drift: THREE.Vector3;
  axis: THREE.Vector3;
  phase: number;
  spin: number;
  size: number;
  delay: number;
}

function textCanvas(text: string, font: string, size: number): { canvas: HTMLCanvasElement; edges: number[] } {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = `${font.replace('SIZE', String(size))}`;
  const pad = Math.round(size * 0.08);
  const width = Math.ceil(ctx.measureText(text).width) + pad * 2;
  canvas.width = width;
  canvas.height = Math.ceil(size * 1.12);
  ctx.font = `${font.replace('SIZE', String(size))}`;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, pad, Math.round(size * 0.88));
  // where each letter starts, as a fraction of the width (kerning included: measured as prefixes)
  const edges = Array.from(text, (_, i) => (pad + ctx.measureText(text.slice(0, i)).width - (i ? size * 0.01 : pad)) / width);
  return { canvas, edges };
}

export interface OverlayInput {
  score: ShotScore;
  palette: ShotPalette;
  aspect: number;
  /** the big word (at most 16 letters) and the small line under it */
  word: string;
  caption: string;
  /** frames held on the hit (s) */
  freeze: number;
}

export class Overlay {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.1, 50);
  private input: OverlayInput | null = null;
  private halfW = 1;
  private halfH = 1;
  private bars: Bar[] = [];
  private arcs: Arc[] = [];
  private charge: Arc | null = null;
  private lines: THREE.Mesh[] = [];
  private bitMeshes: THREE.InstancedMesh[] = [];
  private bits: Bit[][] = [];
  private word: { mesh: THREE.Mesh; reveal: number[]; count: number } | null = null;
  private caption: THREE.Mesh | null = null;
  private ticks: THREE.Mesh[] = [];
  private playhead: THREE.Mesh | null = null;
  private readonly group = new THREE.Group();
  private readonly dummy = new THREE.Object3D();

  constructor() {
    this.scene.add(this.group);
  }

  build(input: OverlayInput) {
    this.dispose();
    this.input = input;
    const { score, palette } = input;
    this.camera.aspect = input.aspect;
    this.camera.updateProjectionMatrix();
    this.halfH = CAM_Z * Math.tan(((FOV / 2) * Math.PI) / 180);
    this.halfW = this.halfH * input.aspect;
    const { halfW, halfH } = this;
    const rnd = dice(Math.round(score.hit * 1000) + 11);
    const flat = (i: number) => palette.flats[((i % 5) + 5) % 5];
    const basic = (color: string, opacity = 1, order = 1) => {
      const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });
      return { m, order };
    };
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, order: number) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = order;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      return mesh;
    };
    const unit = new THREE.PlaneGeometry(1, 1);

    // bars: one for every kick after the hit, in lanes that leave the word and the focus clear
    const lanes = [0.84, 0.66, 0.48, 0.3, -0.34, -0.52];
    score.kicks.slice(0, 28).forEach((at, j) => {
      const lane = lanes[Math.floor(rnd() * lanes.length)];
      const thin = rnd() < 0.3;
      const h = halfH * (thin ? 0.012 : [0.05, 0.09, 0.16][Math.floor(rnd() * 3)]);
      const w = halfW * (thin ? 0.7 + rnd() * 0.9 : 0.35 + rnd() * 0.8);
      const side = j % 2 ? 1 : -1;
      // the lower lanes stay on the right: the word owns the lower left
      const rest = lane < 0 ? halfW * (0.3 + rnd() * 0.5) : halfW * (rnd() * 1.3 - 0.65);
      const { m } = basic(thin ? palette.ink : j % 4 === 3 ? palette.paper : flat(j * 2 + 1), 0.94);
      if (!thin && j % 3 === 1) {
        // some bars tint the footage instead of covering it
        m.blending = THREE.MultiplyBlending;
        m.premultipliedAlpha = true;
        m.opacity = 1;
      }
      const mesh = add(unit, m, 1);
      mesh.scale.set(w, h, 1);
      mesh.position.set(0, lane * halfH, -1.1 + rnd() * 2);
      this.bars.push({ mesh, at, life: (2 + Math.floor(rnd() * 3)) * score.beat, rest, from: side });
    });

    // the ring that closes in before the hit, and the arcs it breaks into
    const arcQuad = new THREE.PlaneGeometry(2, 2);
    const size = halfW * 1.25;
    const arc = (color: string, r: number, w: number, sweep: number, a0: number, turn: number, delay: number, order: number): Arc => {
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: ARC_FRAG,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        uniforms: { uColor: { value: new THREE.Color(color) }, uR: { value: r }, uW: { value: w }, uA0: { value: a0 }, uSweep: { value: sweep }, uAlpha: { value: 1 } },
      });
      const mesh = add(arcQuad, mat, order);
      mesh.scale.setScalar(size);
      return { mesh, u: mat.uniforms, r, sweep, a0, turn, delay };
    };
    this.charge = arc(palette.ink, 0.8, 0.005, TAU, 0, 0, 0, 2);
    const radii = [0.15, 0.24, 0.35, 0.49, 0.65, 0.83];
    const widths = [0.034, 0.005, 0.05, 0.004, 0.02, 0.007];
    const sweeps = [4.2, 5.5, 2.1, 5.9, 1.4, 3.3];
    const turns = [0.5, -0.3, 0.22, -0.15, 0.35, -0.1];
    const cols = [flat(0), palette.ink, flat(3), palette.ink, palette.paper, flat(1)];
    this.arcs = radii.map((r, i) => arc(cols[i], r, widths[i], sweeps[i], rnd() * TAU, turns[i], i * 0.06, 2));

    // guide lines through the focus, wider than the frame
    for (const upright of [false, true]) {
      const { m } = basic(palette.ink, 0.75);
      const mesh = add(unit, m, 2);
      mesh.userData.upright = upright;
      this.lines.push(mesh);
    }

    // the burst: small squares, discs and triangles, each with a place to fly to
    const shapes = [unit, new THREE.CircleGeometry(0.5, 28), new THREE.CircleGeometry(0.58, 3)];
    const tint = new THREE.Color();
    shapes.forEach((geo, s) => {
      const n = 52;
      const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
      const mesh = new THREE.InstancedMesh(geo, mat, n);
      mesh.renderOrder = 3;
      mesh.frustumCulled = false;
      const list: Bit[] = [];
      for (let i = 0; i < n; i++) {
        list.push({
          to: new THREE.Vector3((rnd() * 2 - 1) * halfW * 1.25, (rnd() * 2 - 1) * halfH * 1.2, -1.6 + rnd() * 4.6),
          drift: new THREE.Vector3(rnd() - 0.5, rnd() - 0.3, rnd() - 0.2),
          axis: new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(),
          phase: rnd() * TAU,
          spin: (rnd() < 0.5 ? -1 : 1) * (2 + rnd() * 5),
          size: 0.05 + rnd() * rnd() * 0.24,
          delay: rnd() * 0.12,
        });
        const pick = rnd();
        mesh.setColorAt(i, tint.set(pick < 0.12 ? palette.ink : pick < 0.26 ? palette.paper : flat(i + s)));
      }
      this.group.add(mesh);
      this.bitMeshes.push(mesh);
      this.bits.push(list);
    });

    // the word, lower left, and the small line under it
    const word = input.word.slice(0, MAX_LETTERS);
    if (word) {
      const { canvas, edges } = textCanvas(word, '800 SIZEpx "Archivo Variable", "Inter Variable", sans-serif', 300);
      const tex = new THREE.CanvasTexture(canvas);
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.anisotropy = 4;
      const reveal = new Array<number>(MAX_LETTERS).fill(0);
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: WORD_FRAG,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          tText: { value: tex },
          uEdges: { value: Array.from({ length: MAX_LETTERS }, (_, i) => (i < edges.length ? edges[i] : 2)) },
          uReveal: { value: reveal },
          uColor: { value: new THREE.Color(palette.ink) },
        },
      });
      const mesh = add(unit, mat, 4);
      // as tall as 0.46 of the frame's half height, but never wider than 1.5 half widths
      let h = halfH * 0.46;
      let w = (h * canvas.width) / canvas.height;
      if (w > halfW * 1.5) {
        w = halfW * 1.5;
        h = (w * canvas.height) / canvas.width;
      }
      mesh.scale.set(w, h, 1);
      mesh.position.set(-halfW * 0.9 + w / 2, -halfH * 0.66 + h / 2, 0.5);
      this.word = { mesh, reveal, count: word.length };

      if (input.caption) {
        const cap = textCanvas(input.caption.toUpperCase(), '500 SIZEpx "JetBrains Mono Variable", "IBM Plex Mono", monospace', 44);
        const ctex = new THREE.CanvasTexture(cap.canvas);
        const cm = new THREE.MeshBasicMaterial({ map: ctex, color: palette.ink, transparent: true, depthTest: false, depthWrite: false });
        const cmesh = add(unit, cm, 4);
        const ch = halfH * 0.05;
        const cw = (ch * cap.canvas.width) / cap.canvas.height;
        cmesh.scale.set(cw, ch, 1);
        cmesh.position.set(-halfW * 0.9 + cw / 2 + h * 0.03, -halfH * 0.66 - ch * 0.9, 0.5);
        this.caption = cmesh;
      }
    }

    // a row of ticks, one per beat of the shot, with the hit's tick standing taller: the shot's ruler
    const beats = LEAD_BEATS + TAIL_BEATS;
    for (let i = 0; i <= beats; i++) {
      const { m } = basic(palette.ink, 0.85);
      const mesh = add(unit, m, 4);
      const x = halfW * (0.28 + (0.62 * i) / beats);
      mesh.position.set(x, -halfH * 0.86, 0.5);
      mesh.userData.x = x;
      this.ticks.push(mesh);
    }
    const dot = basic(palette.ink, 1);
    this.playhead = add(new THREE.CircleGeometry(0.5, 24), dot.m, 4);
  }

  /** `focus` is 0..1 from the bottom-left of the frame */
  update(t: number, focus: { x: number; y: number }) {
    const input = this.input;
    if (!input) return;
    const { score } = input;
    const { halfW, halfH } = this;
    const { hit, start, end, beat } = score;
    const tau = t - hit;
    const fx = (focus.x * 2 - 1) * halfW;
    const fy = (focus.y * 2 - 1) * halfH;
    const ramp = clamp01((t - (hit - RAMP_BEATS * beat)) / (RAMP_BEATS * beat));
    const out = smooth(end - beat * 2, end - beat * 0.4, t);

    // the camera pushes in as the footage speeds up, snaps back on the hit and settles
    const cam = this.camera;
    cam.position.set(0.12 * Math.sin(t * 0.5), 0.07 * Math.sin(t * 0.37 + 1), tau < 0 ? CAM_Z - 0.8 * easeInCubic(ramp) : CAM_Z + 0.55 * Math.exp(-tau / 0.28));
    cam.lookAt(0, 0, 0);

    // bars
    for (const b of this.bars) {
      const age = t - b.at;
      const leave = (age - b.life) / (beat * 0.8);
      const show = age >= 0 && leave < 1;
      b.mesh.visible = show;
      if (!show) continue;
      const far = halfW * 2.4;
      const x = b.rest + b.from * far * (1 - easeOutExpo(clamp01(age / (beat * 0.9)))) - b.from * far * easeInExpo(clamp01(leave));
      b.mesh.position.x = x;
    }

    // the charge ring: draws on through the wait, then closes in on the focus with the ramp
    if (this.charge) {
      const c = this.charge;
      const wait = clamp01((t - start) / Math.max(0.01, (LEAD_BEATS - RAMP_BEATS) * beat));
      c.mesh.visible = tau < 0;
      c.mesh.position.set(fx, fy, 0);
      c.u.uSweep.value = TAU * easeOutCubic(wait) + (wait >= 1 ? 0.1 : 0);
      c.u.uA0.value = Math.PI / 2 - t * 0.25;
      c.u.uR.value = 0.62 - 0.6 * easeInCubic(ramp);
      c.u.uW.value = 0.005 + 0.012 * ramp;
    }
    // each snare knocks the arcs round by a notch
    const { snares } = score;
    let notch = 0;
    for (const s of snares) {
      if (s > t) break;
      notch += easeOutExpo(clamp01((t - s) / (beat * 0.5)));
    }
    for (const a of this.arcs) {
      const age = tau - input.freeze - a.delay * beat;
      a.mesh.visible = age > 0 && out < 1;
      if (!a.mesh.visible) continue;
      a.mesh.position.set(fx, fy, 0);
      a.u.uR.value = a.r * easeOutBack(clamp01(age / (beat * 0.9)), 1.3);
      a.u.uSweep.value = a.sweep * easeOutCubic(clamp01(age / (beat * 1.4))) * (1 - out);
      a.u.uA0.value = a.a0 + a.turn * age + Math.sign(a.turn) * notch * 0.35;
    }

    // guide lines
    const drawn = easeOutCubic(clamp01((t - start) / (beat * 3)));
    for (const line of this.lines) {
      const upright = line.userData.upright as boolean;
      const len = (upright ? halfH : halfW) * 3 * drawn * (1 - out);
      line.visible = len > 0.001;
      line.position.set(fx, fy, 0);
      if (upright) line.scale.set(0.008, len, 1);
      else line.scale.set(len, 0.008, 1);
    }

    // the burst
    const d = this.dummy;
    this.bitMeshes.forEach((mesh, s) => {
      const list = this.bits[s];
      mesh.visible = tau > input.freeze * 0.5;
      if (!mesh.visible) return;
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        const age = tau - input.freeze * 0.5 - b.delay;
        if (age <= 0) {
          d.scale.setScalar(0);
        } else {
          const k = 1 - Math.exp(-age / 0.32);
          d.position.set(fx + (b.to.x - fx) * k + b.drift.x * age * 0.06, fy + (b.to.y - fy) * k + b.drift.y * age * 0.06, -1 + (b.to.z + 1) * k + b.drift.z * age * 0.06);
          d.quaternion.setFromAxisAngle(b.axis, b.phase + b.spin * (1.2 * (1 - Math.exp(-age / 0.5)) + 0.12 * age));
          d.scale.setScalar(b.size * easeOutBack(clamp01(age / 0.22)) * (1 - out));
        }
        d.updateMatrix();
        mesh.setMatrixAt(i, d.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    });

    // the word: each letter rises onto its line just after the hit, and off the top at the end
    if (this.word) {
      const w = this.word;
      w.mesh.visible = tau > 0;
      for (let i = 0; i < w.count; i++) {
        const rise = easeOutExpo(clamp01((tau - input.freeze - i * 0.05 * beat) / (beat * 0.8)));
        const gone = easeInCubic(clamp01((t - (end - beat * 1.8) - i * 0.04 * beat) / (beat * 0.6)));
        w.reveal[i] = rise + gone;
      }
      for (let i = w.count; i < MAX_LETTERS; i++) w.reveal[i] = w.reveal[w.count - 1];
    }
    if (this.caption) {
      const a = smooth(input.freeze + beat * 0.6, input.freeze + beat * 1.4, tau) * (1 - out);
      this.caption.visible = a > 0.01;
      (this.caption.material as THREE.MeshBasicMaterial).opacity = a;
    }

    // the ruler
    const now = (t - start) / beat;
    this.ticks.forEach((tick, i) => {
      const isHit = i === LEAD_BEATS;
      const passed = smooth(i - 0.15, i + 0.15, now);
      tick.scale.set(0.007, halfH * (isHit ? 0.075 : 0.022 + 0.014 * passed), 1);
      (tick.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.55 * passed;
    });
    if (this.playhead && this.ticks.length) {
      const first = this.ticks[0].userData.x as number;
      const last = this.ticks[this.ticks.length - 1].userData.x as number;
      const x = first + (last - first) * clamp01(now / (LEAD_BEATS + TAIL_BEATS));
      this.playhead.position.set(x, -halfH * 0.86 + halfH * 0.07, 0.5);
      this.playhead.scale.setScalar(halfH * 0.022);
    }
  }

  render(renderer: THREE.WebGLRenderer) {
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }

  private dispose() {
    for (const child of [...this.group.children]) {
      const mesh = child as THREE.Mesh;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const map = (m as THREE.MeshBasicMaterial).map ?? ((m as THREE.ShaderMaterial).uniforms?.tText?.value as THREE.Texture | undefined);
        map?.dispose();
        m.dispose();
      }
      this.group.remove(child);
    }
    this.bars = [];
    this.arcs = [];
    this.charge = null;
    this.lines = [];
    this.bitMeshes = [];
    this.bits = [];
    this.word = null;
    this.caption = null;
    this.ticks = [];
    this.playhead = null;
  }
}
