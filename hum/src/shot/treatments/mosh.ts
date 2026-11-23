/**
 * Mosh: a datamosh (reference: a portrait melting in soft blocks dragged along the motion, painterly,
 * with a few hard square artefacts).
 *
 * How a datamosh works: a video codec stores most frames as "move these blocks of the last frame
 * this way". Drop the frames that refresh the picture and the blocks keep being dragged along by
 * whatever moves next, smearing the old picture into the new motion.
 *
 * Here the same rule is kept as a field of where each point of the picture has been dragged from
 * (the drag field, D): every tick (1/30 s of song time) each 16 px block gets a motion vector, and
 * the field is carried along it, D(p) = D(p − mv) + mv, exactly what copying the last frame along
 * the vectors would do. The picture is then read at p − D, with a short smear along the drag and the
 * blocks that were dragged furthest flattened to their own colour (the codec's blocks). A few blocks
 * now and then are hard squares.
 *
 * The motion: the shot's own drift, a slow swirl that grows with loudness, and on every kick whole
 * bands of blocks shoved sideways. Blocks refresh (go clean) a few at a time, more in quiet passages.
 * On a cut, the incoming picture is pushed by the outgoing shot's motion for a few beats, its blocks
 * refreshing only afterwards, so it lands smeared and then resolves.
 *
 * Seeking: the field is a function of song time only. It is cleared on fixed points (every two bars
 * of a shot, or where a shot starts after something that is not moshed) and worked forward from the
 * last one tick by tick, so a seek, a frame-by-frame render and playback all reach the same field.
 * Playback only adds the ticks since the last frame.
 */
import * as THREE from 'three';
import { HEAD_GLSL, TAIL_GLSL, headUniforms, hitsBefore, makeMaterial, unit, type Quad, type TreatFrame } from './common';

/** ticks per second of song time */
export const RATE = 30;
/** beats from one clean point to the next inside a shot */
const GOP_BEATS = 8;
/** beats the outgoing motion pushes the incoming picture after a cut */
const PUSH_BEATS = 3;
/** ticks worked forward at most in one frame (a seek past this starts from the nearest clean point) */
const MAX_TICKS = 600;

/** one stretch of the timeline the drag field knows about: a shot, or the shot before the part */
export interface MoshSegment {
  start: number;
  end: number;
  layout: number;
  /** the field is carried through it (a moshed shot); a segment that isn't only lends its motion */
  mosh: boolean;
  /** the shot's speed (1 = real time) */
  speed(t: number): number;
}

export interface MoshPlan {
  segments: MoshSegment[];
  beat: number;
  kicks: number[];
  /** loudness at song time t, 0..1 */
  loud(t: number): number;
}

const TICK = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tD;
uniform vec2 uDRes, uRes;
uniform float uSeedT, uBlock;
uniform vec2 uDrift, uPush;
uniform float uSwirl, uStill, uRefresh;
uniform float uShove, uShoveSeed;
float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  // motion vectors per block, in frame pixels per tick
  vec2 fpx = vUv * uRes;
  vec2 blk = floor(fpx / uBlock);
  vec2 bc = (blk + 0.5) * uBlock / uRes;
  float hb = hash(blk + 0.37);
  vec2 mv = uDrift * (0.55 + 0.9 * hb);
  float ang = vnoise(bc * vec2(2.3, 2.3 * uRes.y / uRes.x) + uSeedT * 0.03) * 12.566;
  mv += vec2(cos(ang), sin(ang)) * uSwirl * (0.4 + hash(blk + 7.1));
  mv += uPush * (0.6 + 0.8 * hash(blk + 3.3));
  // a quarter of the blocks hold still: the tears between moving and still blocks are the mosh
  mv *= step(0.22, hash(blk + 11.0)) ;
  mv += uPush * 0.4 * (1.0 - step(0.22, hash(blk + 11.0)));
  // a kick shoves whole bands of block rows one way or the other
  float bandH = uBlock * (2.0 + floor(hash(vec2(uShoveSeed, 1.0)) * 4.0));
  float band = floor(fpx.y / bandH);
  float side = hash(vec2(band, uShoveSeed)) < 0.5 ? -1.0 : 1.0;
  float moves = step(0.35, hash(vec2(band * 1.7, uShoveSeed + 2.0)));
  mv.x += side * moves * uShove * (0.6 + 0.8 * hash(vec2(band, uShoveSeed + 5.0)));
  vec2 duv = mv / uRes;
  vec2 d = texture2D(tD, vUv - duv).xy + duv;
  // a few blocks refresh: the picture is clean there again
  if (hash(blk * 1.13 + vec2(uSeedT * 0.731, uSeedT * 0.193)) < uRefresh) d = vec2(0.0);
  gl_FragColor = vec4(d, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
${HEAD_GLSL}
${TAIL_GLSL}
uniform sampler2D tD;
uniform float uBlock, uSeed, uBeatN, uSquares, uFlow;

void main() {
  vec2 px = vUv * uRes;
  vec4 b = bed(vUv);
  vec2 d = texture2D(tD, vUv).xy;
  float m = length(d * uRes);
  // a slow flow along the picture's own edges (stills: what moves when nothing in it moves)
  vec2 e = vec2(6.0) / uRes;
  float gx = luma(bed(vUv + vec2(e.x, 0.0)).rgb) - luma(bed(vUv - vec2(e.x, 0.0)).rgb);
  float gy = luma(bed(vUv + vec2(0.0, e.y)).rgb) - luma(bed(vUv - vec2(0.0, e.y)).rgb);
  vec2 along = vec2(-gy, gx);
  vec2 src = vUv - d - along * uFlow / uRes * 40.0;
  // the picture read where it was dragged from, smeared back along the drag
  vec3 col = bed(src).rgb * 0.4;
  vec2 tail = normalize(d + 1e-6) * min(m, 40.0) / uRes;
  for (int i = 1; i < 6; i++) col += bed(src + tail * float(i) * 0.12).rgb * 0.12;
  // the blocks dragged furthest flatten to one colour each, like a codec's coarse blocks
  vec2 blk = floor(px / uBlock);
  vec2 bc = (blk + 0.5) * uBlock / uRes;
  vec2 bd = texture2D(tD, bc).xy;
  vec3 flat_ = (bed(bc - bd).rgb * 2.0 + bed(bc - bd + vec2(uBlock * 0.3, 0.0) / uRes).rgb + bed(bc - bd - vec2(0.0, uBlock * 0.3) / uRes).rgb) * 0.25;
  float flatten = smoothstep(18.0, 70.0, m) * step(0.45, hash(blk + 0.7));
  col = mix(col, flat_, flatten * 0.85);
  // a few hard squares: a block that took the wrong vectors, changing on the beat
  vec2 sq = floor(px / uBlock);
  float hs = hash(sq + floor(uBeatN) * 1.618 + uSeed);
  if (hs < uSquares * smoothstep(10.0, 40.0, m)) {
    vec2 jump = (vec2(hash(sq + 1.1), hash(sq + 2.3)) - 0.5) * 0.25;
    col = bed((sq + 0.5) * uBlock / uRes + jump).rgb;
  }
  // and the odd small pale square, the stuck block every mosh has
  vec2 sm = floor(px / (uBlock * 0.5));
  if (hash(sm * 0.71 + floor(uBeatN) * 0.37) > 1.0 - uSquares * 0.6) col = mix(col, vec3(0.96, 0.94, 0.92), 0.9);
  gl_FragColor = finish(col, b);
}
`;

const CLEAR = /* glsl */ `precision highp float; void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); }`;

export class Mosh {
  readonly material: THREE.ShaderMaterial;
  readonly tick: THREE.ShaderMaterial;
  private readonly clear: THREE.ShaderMaterial;
  private a: THREE.WebGLRenderTarget | null = null;
  private b: THREE.WebGLRenderTarget | null = null;
  /** the tick the field holds, and the clean point it was worked from (-1: nothing yet) */
  private simTick = -1;
  private fromTick = -1;
  private plan: MoshPlan | null = null;
  private planKey = '';
  /** how many ticks the last frame worked (for checks) */
  lastTicks = 0;

  constructor() {
    this.material = makeMaterial(FRAG, { ...headUniforms(), tD: { value: null }, uBlock: { value: 16 }, uSeed: { value: 0 }, uBeatN: { value: 0 }, uSquares: { value: 0.01 }, uFlow: { value: 0 } });
    this.tick = makeMaterial(TICK, {
      tD: { value: null },
      uDRes: { value: new THREE.Vector2(1, 1) },
      uRes: { value: new THREE.Vector2(1, 1) },
      uSeedT: { value: 0 },
      uBlock: { value: 16 },
      uDrift: { value: new THREE.Vector2() },
      uPush: { value: new THREE.Vector2() },
      uSwirl: { value: 0 },
      uStill: { value: 0 },
      uRefresh: { value: 0 },
      uShove: { value: 0 },
      uShoveSeed: { value: 0 },
    });
    this.clear = makeMaterial(CLEAR, {});
  }

  /** the timeline the field is worked along; a new one starts the field again */
  setPlan(plan: MoshPlan, key: string) {
    if (key === this.planKey) return;
    this.plan = plan;
    this.planKey = key;
    this.simTick = -1;
    this.fromTick = -1;
  }

  private targets(w: number, h: number) {
    const dw = Math.max(16, Math.round(w / 2));
    const dh = Math.max(16, Math.round(h / 2));
    if (this.a && this.a.width === dw && this.a.height === dh) return;
    this.a?.dispose();
    this.b?.dispose();
    const make = () => new THREE.WebGLRenderTarget(dw, dh, { depthBuffer: false, type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
    this.a = make();
    this.b = make();
    this.simTick = -1;
  }

  private segAt(t: number): MoshSegment | null {
    const segs = this.plan?.segments ?? [];
    for (let i = segs.length - 1; i >= 0; i--) if (t >= segs[i].start - 1e-6) return t < segs[i].end + 1e-6 ? segs[i] : null;
    return null;
  }

  private prevOf(seg: MoshSegment): MoshSegment | null {
    const segs = this.plan?.segments ?? [];
    const i = segs.indexOf(seg);
    const p = i > 0 ? segs[i - 1] : null;
    return p && Math.abs(p.end - seg.start) < 0.05 ? p : null;
  }

  /** the clean point at or before song time t: where the field is worked from */
  private cleanAt(t: number): number {
    const plan = this.plan!;
    const gop = GOP_BEATS * plan.beat;
    const seg = this.segAt(t);
    if (!seg) return t;
    const k = Math.floor((t - seg.start) / gop + 1e-6);
    if (k >= 1) return seg.start + k * gop;
    // the first stretch of a shot carries on from the moshed shot before it
    const prev = this.prevOf(seg);
    if (!prev?.mosh) return seg.start;
    const kp = Math.floor((prev.end - 1e-3 - prev.start) / gop);
    return prev.start + Math.max(0, kp) * gop;
  }

  /** set the tick shader for the tick at song time tt */
  private setTick(tt: number, w: number, h: number) {
    const plan = this.plan!;
    const u = this.tick.uniforms;
    const seg = this.segAt(tt);
    const short = Math.min(w, h);
    const px = short / 720;
    const loud = plan.loud(tt);
    const dirOf = (layout: number) => {
      const a = unit(layout, 5) * Math.PI * 2;
      return new THREE.Vector2(Math.cos(a), Math.sin(a) * 0.6);
    };
    const drift = new THREE.Vector2();
    const push = new THREE.Vector2();
    let refresh = 0;
    let swirl = 0;
    if (seg) {
      const speed = seg.speed(tt);
      drift.copy(dirOf(seg.layout)).multiplyScalar(px * (0.5 + 0.9 * loud) * (0.6 + speed * 0.7));
      swirl = px * (0.4 + 2.6 * loud * loud) * (0.7 + 0.3 * Math.min(3, speed));
      refresh = seg.mosh ? 0.004 + 0.035 * (1 - loud) ** 2 : 1;
      const into = tt - seg.start;
      const prev = this.prevOf(seg);
      if (prev && into < PUSH_BEATS * plan.beat) {
        // the cut: the incoming picture is carried by the outgoing shot's motion, and holds on to it
        const k = 1 - into / (PUSH_BEATS * plan.beat);
        push.copy(dirOf(prev.layout)).multiplyScalar(px * 7 * k * k);
        refresh *= 1 - k;
      }
    }
    const kick = hitsBefore(plan.kicks, tt);
    (u.uDrift.value as THREE.Vector2).copy(drift);
    (u.uPush.value as THREE.Vector2).copy(push);
    u.uSwirl.value = swirl;
    u.uRefresh.value = refresh;
    u.uShove.value = px * 16 * Math.exp(-kick.since / 0.07) * (0.5 + loud);
    u.uShoveSeed.value = kick.n * 1.37 + 0.5;
    u.uSeedT.value = Math.round(tt * RATE);
    u.uBlock.value = Math.max(8, Math.round(16 * px));
    (u.uRes.value as THREE.Vector2).set(w, h);
    (u.uDRes.value as THREE.Vector2).set(this.a!.width, this.a!.height);
  }

  /** bring the field to song time t: from the clean point when the time jumped, else tick by tick */
  advance(renderer: THREE.WebGLRenderer, quad: Quad, t: number, w: number, h: number) {
    this.targets(w, h);
    this.lastTicks = 0;
    if (!this.plan) return;
    const target = Math.floor(t * RATE + 1e-6);
    const from = Math.ceil(this.cleanAt(target / RATE) * RATE - 1e-6);
    if (this.simTick < 0 || this.fromTick !== from || target < this.simTick || target - this.simTick > MAX_TICKS) {
      quad.draw(renderer, this.clear, this.a);
      this.simTick = from;
      this.fromTick = from;
    }
    const steps = Math.min(MAX_TICKS, target - this.simTick);
    for (let i = 0; i < steps; i++) {
      const n = this.simTick + 1;
      this.setTick(n / RATE, w, h);
      this.tick.uniforms.tD.value = this.a!.texture;
      quad.draw(renderer, this.tick, this.b);
      [this.a, this.b] = [this.b, this.a];
      this.simTick = n;
    }
    this.lastTicks = steps;
  }

  update(f: TreatFrame, w: number, h: number, still: boolean) {
    const u = this.material.uniforms;
    u.tD.value = this.a?.texture ?? null;
    const px = Math.min(w, h) / 720;
    u.uBlock.value = Math.max(8, Math.round(16 * px));
    u.uSeed.value = (f.layout % 911) * 0.29;
    u.uBeatN.value = Math.floor((f.t - f.shotStart) / f.beat + 1e-4);
    const kick = hitsBefore(f.kicks, f.t, f.shotStart).since;
    u.uSquares.value = 0.0012 + 0.002 * f.loud + 0.012 * Math.exp(-kick / 0.18);
    // stills flow along their own edges, a little further every beat of the shot
    u.uFlow.value = still ? Math.min(1, 0.25 + (f.tau / f.beat) * 0.08) * px : 0;
  }

  dispose() {
    this.material.dispose();
    this.tick.dispose();
    this.clear.dispose();
    this.a?.dispose();
    this.b?.dispose();
  }
}
