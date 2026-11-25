/**
 * Forms: geometry that stands in the place an inside shot shows. Metres: the eye is EYE above the ground,
 * ahead is -z. Everything is a function of song time.
 *
 *   rings     two rings round a person, half of each behind them
 *   frames    square frames one behind the other down the way ahead, turning on the beat
 *   blocks    tall blocks standing where there is bare ground, rising out of it
 *   crossing  the light marks on the ground, raised as blocks
 *
 * Solid ones are meshes lit by the clip (formShaders.ts); the crossing is marched through per pixel, from
 * the picture itself.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { EYE, type ClipScene } from '../depth/types';
import { clamp01, dice, since } from '../shot/time';
import { groundNear } from './pass';
import type { FormId } from './formIds';
import type { Spot } from './spot';
import type { InsidePalette } from './palettes';
import { unproject, type Lens } from './place';
import { CLIP, FULLSCREEN_VERT, HIDE } from './shaders';
import { FORM_FRAG, FORM_SHADOW_FRAG, FORM_VERT, RAISE_FRAG } from './formShaders';

export interface FormSpec {
  form: FormId;
  /** 0..1: how much of it there is (a song's later big moments have more) */
  level: number;
}
interface Place {
  scene: ClipScene | null;
  span: number;
  layout: number;
  start: number;
  end: number;
  beat: number;
  kicks: number[];
  aspect: number;
  /** a lens early in the shot, to lay things out by */
  lens: Lens;
  /** where there is room, at the shot's start and its end */
  spot: Spot;
  late: Spot;
  /** how dark the clip is, 0..1: settled once, so a form doesn't flicker as people pass */
  dim: number;
  /** words stand in the shot */
  words: boolean;
  /** metres the camera goes ahead in the shot */
  travel: number;
}
type Mat = (v: string, f: string, u: Record<string, THREE.IUniform>, extra?: Partial<THREE.ShaderMaterialParameters>) => THREE.ShaderMaterial;
interface Piece {
  mesh: THREE.Mesh;
  shadow: THREE.Mesh | null;
  r: number[];
  i: number;
}
const lum = (h: string) => {
  const c = new THREE.Color(h);
  const f = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
const contrast = (x: string, y: string) => {
  const [a, b] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (a + 0.05) / (b + 0.05);
};
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const outBack = (x: number) => {
  const k = clamp01(x) - 1;
  return 1 + 2.2 * k * k * k + 1.2 * k * k;
};

export class Forms {
  readonly group = new THREE.Group();
  private readonly pieces: Piece[] = [];
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.ShaderMaterial[] = [];
  private screen: THREE.ShaderMaterial | null = null;
  private readonly rnd: () => number;
  private readonly lit: THREE.ShaderMaterial;
  private readonly lit2: THREE.ShaderMaterial;
  private readonly shade: THREE.ShaderMaterial;

  constructor(
    private readonly spec: FormSpec,
    private readonly p: Place,
    private readonly mat: Mat,
  ) {
    this.rnd = dice(p.layout + 211);
    const solid = () => this.keep(mat(FORM_VERT, FORM_FRAG(HIDE, CLIP), { uEye: { value: new THREE.Vector3() }, uColor: { value: new THREE.Color() }, uLightC: { value: new THREE.Color() }, uLamp: { value: new THREE.Color() }, uInk: { value: new THREE.Color() }, uAlpha: { value: 1 }, uCel: { value: 0 }, uShine: { value: spec.form === 'rings' ? 0.9 : 0.12 }, uDim: { value: p.dim }, uFog: { value: p.spot.open * 2.6 } }, { depthWrite: true }));
    this.lit = solid();
    this.lit2 = solid();
    // shade lies in one layer however many parts of the form throw it
    this.shade = this.keep(mat(FORM_VERT, FORM_SHADOW_FRAG(HIDE), { uAlpha: { value: 0.5 }, uInk: { value: new THREE.Color() } }, { depthWrite: false, depthTest: false, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor }));
    this.build();
  }

  private keep(m: THREE.ShaderMaterial) {
    this.mats.push(m);
    return m;
  }
  private geo<G extends THREE.BufferGeometry>(g: G): G {
    this.geos.push(g);
    return g;
  }
  private add(g: THREE.BufferGeometry, m: THREE.ShaderMaterial, i: number, shadow = true): Piece {
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    let sh: THREE.Mesh | null = null;
    if (shadow) {
      sh = new THREE.Mesh(g, this.shade);
      sh.frustumCulled = false;
      sh.matrixAutoUpdate = false;
      sh.renderOrder = 0;
      this.group.add(sh);
    }
    this.group.add(mesh);
    const piece = { mesh, shadow: sh, r: Array.from({ length: 6 }, () => this.rnd()), i };
    this.pieces.push(piece);
    return piece;
  }

  private build() {
    const S = this.p.span;
    const f = this.spec.form;
    if (f === 'blocks') {
      this.seat();
      const g = this.geo(new RoundedBoxGeometry(1, 1, 1, 2, 0.02).translate(0, 0.5, 0) as THREE.BufferGeometry);
      for (let i = 0; i < this.seats.length; i++) this.add(g, i % 4 === 1 ? this.lit2 : this.lit, i);
    } else if (f === 'frames') {
      const bar = 0.03;
      const part = (w: number, h: number, x: number, y: number) => new THREE.BoxGeometry(w, h, 0.05).translate(x, y, 0);
      const g = this.geo(merge([part(1, bar, 0, 0.5 - bar / 2), part(1, bar, 0, -0.5 + bar / 2), part(bar, 1 - bar * 2, -0.5 + bar / 2, 0), part(bar, 1 - bar * 2, 0.5 - bar / 2, 0)]));
      for (let i = 0; i < 4 + Math.round(2 * this.spec.level); i++) this.add(g, i % 3 === 2 ? this.lit2 : this.lit, i, false);
    } else if (f === 'rings') {
      const g = this.geo(new THREE.TorusGeometry(1, 0.06, 24, 200));
      this.add(g, this.lit, 0);
      if (this.spec.level > 0.34) this.add(g, this.lit2, 1);
    } else {
      const v3 = () => ({ value: new THREE.Vector3() });
      const col = () => ({ value: new THREE.Color() });
      this.screen = this.keep(
        this.mat(
          FULLSCREEN_VERT,
          RAISE_FRAG(CLIP),
          { uE0: v3(), uE1: v3(), uGround: v3(), uTop: col(), uSide: col(), uInk: col(), uEyeH: { value: EYE }, uHeight: { value: 0 }, uThr: { value: 0.5 }, uTime: { value: 0 }, uAlpha: { value: 1 }, uCel: { value: 0 }, uReach: { value: S * 2.2 }, uStart: { value: 3 } },
          { depthTest: false },
        ),
      );
      const m = new THREE.Mesh(this.geo(new THREE.PlaneGeometry(2, 2)), this.screen);
      m.frustumCulled = false;
      m.renderOrder = 0;
      this.group.add(m);
    }
  }

  private get reach() {
    return Math.max(8, this.p.spot.open);
  }
  /** how many metres one frame height covers at distance w */
  private tall(w: number) {
    const a = unproject(this.p.lens, 0.5, 0, w);
    const b = unproject(this.p.lens, 0.5, 1, w);
    return Math.hypot(b.x - a.x, b.y - a.y);
  }
  /** where blocks can stand: bare ground, most of the height above it not already taken by something nearer */
  private readonly seats: { x: number; z: number; tall: number; wide: number }[] = [];
  private seat() {
    const { p } = this;
    const z = p.scene?.zScale ?? 1;
    const R = this.reach;
    const tried: { x: number; z: number; tall: number; wide: number; fx: number; w: number; good: number }[] = [];
    for (let k = 0; k < 160; k++) {
      const fx = 0.06 + 0.88 * this.rnd();
      // the camera may travel toward them: never so near that one fills the frame
      const w = p.travel + R * (0.4 + 0.9 * this.rnd());
      const c = unproject(p.lens, fx, p.lens.vp.y, w);
      const foot = this.foot(c.x, c.z);
      if (foot === null) continue;
      const share = 0.2 + 0.5 * this.rnd();
      const tall = this.tall(w) * share;
      let seen = 0;
      for (let q = 0; q < 10; q++) {
        const fy = foot + (share * (q + 0.5)) / 10;
        if (fy < 1 && p.spot.near(fx, fy) < (z / w) * 1.1) seen++;
      }
      tried.push({ x: c.x, z: c.z, tall, wide: Math.min(this.tall(w) * 0.085, tall * (0.14 + 0.16 * this.rnd())), fx, w, good: seen / 10 - Math.abs(fx - 0.5) * 0.1 });
    }
    tried.sort((a, b) => b.good - a.good);
    for (const t of tried) {
      if (this.seats.length >= 4 + Math.round(5 * this.spec.level) || t.good < 0.45) break;
      if (this.seats.some((o) => Math.hypot(o.x - t.x, (o.z - t.z) * 0.4) < t.wide + o.wide)) continue;
      this.seats.push(t);
    }
  }
  private foot(x: number, z: number): number | null {
    const e = this.p.lens.matrix.elements;
    const w = -(z + this.p.lens.ahead);
    if (w < 1) return null;
    return ((e[1] * x + e[5] * -EYE) / w - e[9]) * 0.5 + 0.5;
  }

  /** `cel` how far the picture is painted flat, `thr` the brightness that counts as a light mark */
  update(t: number, l: Lens, o: { cel: number; now: { field: string; light: string; word: string }; palette: InsidePalette; thr: number; gone: number }) {
    const { p } = this;
    const tau = t - p.start;
    const beats = tau / p.beat;
    const kick = Math.exp(-since(p.kicks, t) / (p.beat * 0.4));
    const pal = o.palette;
    // never the field it stands on; and where words stand, never near their colour: they have to read over it
    const L = (h: string) => new THREE.Color(h).getHSL({ h: 0, s: 0, l: 0 }).l;
    const word = o.cel < 0.5 ? pal.paper : o.now.word;
    const apart = (c: string) => Math.abs(L(c) - L(o.now.field)) > 0.12 || contrast(c, o.now.field) > 1.6;
    const fromWord = (c: string) => contrast(c, word);
    let others = pal.accents.filter((c) => apart(c) && c !== o.now.word);
    if (p.words) others = [...pal.accents, pal.ink, pal.paper].filter((c) => c !== word && (o.cel < 0.5 || apart(c)) && fromWord(c) >= 2.2);
    if (!others.length) others = [fromWord(pal.ink) > fromWord(pal.paper) ? pal.ink : pal.paper];
    const a = others[0];
    // one colour and its shade where words stand, two where the shot is the form's own
    const b = p.words ? `#${new THREE.Color(a).multiplyScalar(0.62).getHexString()}` : (others.find((c) => c !== a) ?? pal.paper);
    const paper = p.words ? a : pal.paper;
    const eye = new THREE.Vector3(0, EYE, -l.ahead);
    for (const [m, c, light] of [
      [this.lit, a, paper],
      [this.lit2, b, paper],
    ] as const) {
      const u = m.uniforms;
      u.uEye.value.copy(eye);
      // on the plain picture a form is a bare thing of the place: near grey, warm or cool as the light is
      u.uColor.value.set(o.cel > 0.5 || p.words ? c : m === this.lit ? '#dcdad4' : a);
      u.uLamp.value.set(p.words ? c : m === this.lit ? '#fff3e2' : a);
      u.uLightC.value.set(light).lerp(new THREE.Color(c), 0.35);
      u.uInk.value.set(pal.ink);
      u.uCel.value = o.cel;
      u.uAlpha.value = 1 - o.gone;
    }
    this.shade.uniforms.uAlpha.value = 0.46 * (1 - o.gone);
    const f = this.spec.form;
    const hop = kick * 0.5;
    for (const x of this.pieces) {
      const m = x.mesh;
      const [r0, , r2, r3] = x.r;
      const n = this.pieces.length;
      if (f === 'blocks') {
        const at = this.seats[x.i];
        const up = at ? outBack((beats - x.i * 0.35) / 1.8) : 0;
        m.visible = up > 0.01;
        if (!at) continue;
        m.position.set(at.x, -0.02, at.z);
        m.rotation.y = (r3 - 0.5) * 0.7;
        m.scale.set(at.wide, Math.max(1e-3, at.tall * up * (1 + 0.05 * hop * r2)), at.wide * (0.6 + 0.8 * r0));
      } else if (f === 'frames') {
        // down the way ahead: the nearest is about as tall as the frame
        const w = this.reach * 0.3 * 1.5 ** x.i;
        const c = unproject(p.lens, clamp(p.lens.vp.x, 0.3, 0.7), clamp(p.lens.vp.y + 0.12, 0.4, 0.6), w);
        const turned = Math.floor(beats) + outBack((beats % 1) / 0.5);
        m.position.set(c.x, c.y, c.z - l.ahead);
        m.rotation.set(0, 0, (0.08 + 0.03 * turned) * x.i * (p.layout % 2 ? 1 : -1));
        const size = this.tall(this.reach * 0.3) * 1.02;
        m.scale.set(size * Math.min(1.5, p.aspect * 0.9), size, size).multiplyScalar(Math.max(1e-3, outBack((beats - (n - 1 - x.i) * 0.18) / 1.2)) * (1 + 0.02 * hop));
        m.visible = beats > (n - 1 - x.i) * 0.18;
      } else if (f === 'rings') {
        const bd = p.spot.body;
        const w = bd ? bd.w : this.reach * 0.55;
        const fx = bd ? (bd.x0 + bd.x1) / 2 : clamp(p.lens.vp.x, 0.35, 0.65);
        const fy = bd ? bd.y0 + (bd.y1 - bd.y0) * (x.i ? 0.82 : 0.5) : clamp(p.lens.vp.y + 0.1, 0.42, 0.62);
        const to = p.late.body;
        const k = clamp01(tau / Math.max(0.1, p.end - p.start));
        const fx2 = to && bd && Math.abs(to.w / bd.w - 1) < 0.5 ? (to.x0 + to.x1) / 2 : fx;
        const c = unproject(p.lens, fx + (fx2 - fx) * k, fy, w);
        const size = this.tall(w) * Math.min(p.aspect * 0.4, bd ? clamp((bd.y1 - bd.y0) * (x.i ? 0.42 : 0.58), 0.16, 0.42) : x.i ? 0.22 : 0.3);
        m.position.set(c.x, c.y, c.z - l.ahead);
        m.rotation.set(1.28 + 0.16 * Math.sin(tau * 0.9 + x.i * 2.4), (x.i ? -0.3 : 0.22) + 0.2 * Math.sin(tau * 0.6 + x.i), tau * 0.2);
        m.scale.setScalar(Math.max(1e-3, size * outBack((beats - x.i * 0.8) / 1.8) * (1 + 0.05 * hop)));
        m.visible = beats > x.i * 0.8;
      }
      m.updateMatrix();
      m.matrixWorld.copy(m.matrix);
      if (x.shadow) {
        x.shadow.visible = m.visible && !!p.scene && p.scene.ground > 0.06;
        // thrown onto the ground away from the light, which is above and a little to one side
        const k = 0.55 * (p.layout % 2 ? 1 : -1);
        const flat = new THREE.Matrix4().set(1, -k, 0, 0, 0, 0.0001, 0, 0.012, 0, -0.25, 1, 0, 0, 0, 0, 1);
        x.shadow.matrix.multiplyMatrices(flat, m.matrix);
      }
    }
    if (this.screen) {
      const u = this.screen.uniforms;
      const g = (fx: number, fy: number) => groundNear(l, fx, fy, p.scene?.zScale ?? 1);
      const g0 = g(0, 0);
      u.uGround.value.set(g(1, 0) - g0, g(0, 1) - g0, g0);
      u.uAlpha.value = 1 - o.gone;
      u.uCel.value = o.cel;
      u.uInk.value.set(pal.ink);
      const e = l.matrix.elements;
      u.uE0.value.set(e[0], e[4], e[8]);
      u.uE1.value.set(e[1], e[5], e[9]);
      u.uHeight.value = 0.4 * outBack(beats / 1.5) * (1 + 0.35 * hop);
      u.uThr.value = o.thr;
      u.uTime.value = beats;
      u.uStart.value = clamp((l.matrix.elements[5] * -EYE) / Math.min(-0.05, 2 * 0.04 - 1 + l.matrix.elements[9]), 1, 12) * 1.05;
      u.uReach.value = this.reach * 1.4;
      u.uTop.value.set(pal.paper);
      u.uSide.value.set(a);
    }
  }

  /** how many pieces it has */
  get count() {
    return this.pieces.length;
  }

  dispose() {
    for (const g of this.geos) g.dispose();
  }
}

/** a few geometries as one */
function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  for (const raw of list) {
    const g = raw.toNonIndexed();
    pos.push(...(g.getAttribute('position').array as Float32Array));
    nor.push(...(g.getAttribute('normal').array as Float32Array));
    uv.push(...(g.getAttribute('uv').array as Float32Array));
    raw.dispose();
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return out;
}
