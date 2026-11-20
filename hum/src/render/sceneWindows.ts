import * as THREE from 'three';
import { resolvePalette } from '../core/palettes';
import { createFullscreenQuad, makeRenderTarget } from '../core/sceneHelpers';
import { lookStyle, sceneStyle } from '../core/styles';
import type { EffectDef, EffectInstance, FrameContext, ParamValues, Preset, ResolvedPalette, SceneDef, SceneInstance } from '../core/types';
import { getEffect } from '../fx';
import { presetToLook, type LookState } from '../presets/apply';
import { getScene } from '../scenes';
import { lum, makeInk, rgba, setFont, MONO } from '../scenes/board/kit';
import type { Ink } from '../scenes/board/kit';
import { resolveParams } from '../state/modulation';
import { allLooks, findLook, relatedLooks, sectionIndexAt, songTinted } from '../state/plan';
import type { WindowKind } from '../state/store';
import { FxChain } from './fxChain';
import { glide, keepCost, newGlide, toPx, toRect, type Glide, type PxBox } from './keepClear';
import { NO_KEEP_OUT, type KeepOut, type Rect } from './legibility';
import { paperInk } from './popups';
import { dryRun } from './warmup';

/**
 * Scene windows: framed windows over the picture that each play ANOTHER look live, so looks stack up
 * like a desktop full of programs. The sibling of the instrument pop-ups (popups.ts): they open on
 * section changes, drops and some phrase starts, bump on kicks, stamp a cascade of copies on snares,
 * huddle and tremble while a build winds up, and all snap shut on a drop so the hit reads clean, then
 * burst back open. Each window renders its look at exactly its on-screen size into its own target,
 * and one small shader draws the picture with its frame, so it is in recordings too. They keep clear
 * of the sung line like the pop-ups do (keepClear.ts): open away from it, glide out of its way.
 */

/** how busy each kind of window gets for a pop level L (0..3) and the "Windows show" setting */
export function windowLevels(L: number, kind: WindowKind, board: boolean): { instruments: number; looks: number } {
  const l = Math.max(0, Math.min(3, Math.round(L)));
  const looks = kind === 'looks' ? [0, 1, 2, 3][l] : kind === 'both' ? [0, 1, 1, 2][l] : 0;
  // a board look is already busy: keep it to the odd window
  return { instruments: kind === 'looks' ? 0 : l, looks: board ? Math.min(1, looks) : looks };
}

type FrameKind = 'window' | 'card' | 'round';

interface Spec {
  /** box size (device px), chrome included */
  w: number;
  h: number;
  /** where the picture sits inside the box (px from its top-left) */
  cx: number;
  cy: number;
  cw: number;
  ch: number;
  frame: FrameKind;
  radius: number;
  /** frame line width, paper mat inside it, title bar height (0 without one), shadow offset, cascade step */
  bw: number;
  mat: number;
  bar: number;
  shadow: number;
  step: number;
  /** title bar: 0 paper, 1 accent */
  barStyle: number;
}

/** a look rendering into its own target (an open window, or the one warmed up for the next) */
interface Slot {
  lookId: string;
  name: string;
  sceneId: string;
  def: SceneDef;
  inst: SceneInstance;
  look: LookState;
  pal: ResolvedPalette;
  rt: THREE.WebGLRenderTarget;
  fx: FxChain;
  fxParams: Map<string, ParamValues>;
  params: ParamValues;
  spec: Spec;
  /** what goes in the window this frame (the target, or the effect chain's last buffer) */
  tex: THREE.Texture;
  failed: boolean;
}

interface Win {
  slot: Slot;
  x: number;
  y: number;
  born: number;
  until: number;
  closing: number;
  /** kick bump, decaying back to 0 */
  bump: number;
  /** cascade copies: k steps away, fading from `born` */
  stamps: { born: number; k: number }[];
  stampN: number;
  /** which way the cascade runs (away from the middle sideways, towards it up or down) */
  dir: [number, number];
  title: { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; key: string } | null;
  /** keeping clear of the lyrics: where it's gliding to, and a little shrink when there's no room */
  g: Glide;
}

const IN_STEP = 0.045;
const IN_SCALES = [0.35, 1.14, 0.95, 1];
const OUT_TIME = 0.16;
const PHRASE_CHANCE = [0, 0.35, 0.55, 0.75];
const ASPECTS = [4 / 3, 1, 3 / 4, 16 / 9];
const MAX_STAMPS = 7;

const VERT = /* glsl */ `
uniform vec4 uBox;   // centre x, y (px, y down) and unscaled width, height
uniform vec2 uScale;
uniform vec2 uRes;
uniform float uPad;
varying vec2 vP;     // px from the box's top-left, before scaling
void main(){
  vec2 halfSize = uBox.zw * 0.5 + uPad;
  vec2 lc = vec2(position.x, -position.y) * halfSize;
  vP = lc + uBox.zw * 0.5;
  vec2 px = uBox.xy + lc * uScale;
  gl_Position = vec4(px.x / uRes.x * 2.0 - 1.0, 1.0 - px.y / uRes.y * 2.0, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vP;
uniform sampler2D tMap;
uniform sampler2D tBar;
uniform vec4 uBox;
uniform vec4 uContent;
uniform float uRound, uRadius, uBw, uMat, uShadow, uBar, uAlpha, uFlash;
uniform vec3 uInk, uPaper, uFlashCol;
float sdBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main(){
  vec2 sz = uBox.zw;
  vec2 c = vP - sz * 0.5;
  float r = uRound > 0.5 ? uRadius : 0.0;
  float aa = 0.7;
  float body = 1.0 - smoothstep(-aa, aa, sdBox(c, sz * 0.5, r));
  float shadow = 1.0 - smoothstep(-aa, aa, sdBox(c - vec2(uShadow), sz * 0.5, r));
  vec2 uv = (vP - uContent.xy) / uContent.zw;
  vec3 pic = texture2D(tMap, vec2(uv.x, 1.0 - uv.y)).rgb;
  vec3 col;
  if (uRound > 0.5) {
    // a cut-out: the picture to the edge, a paper rim and a thin ink outline
    float d = sdBox(c, sz * 0.5, r);
    col = mix(pic, uPaper, smoothstep(-uBw - uMat - aa, -uBw - uMat + aa, d));
    col = mix(col, uInk, smoothstep(-uBw - aa, -uBw + aa, d));
  } else {
    col = uInk;
    vec2 inP = step(vec2(uBw), vP) * step(vP, sz - uBw);
    // paper inside the ink line, except for the line under the title bar
    if (inP.x * inP.y > 0.5 && (uBar <= 0.0 || vP.y >= 2.0 * uBw + uBar)) col = uPaper;
    if (uBar > 0.0 && vP.y >= uBw && vP.y < uBw + uBar && vP.x >= uBw && vP.x < sz.x - uBw)
      col = texture2D(tBar, vec2((vP.x - uBw) / (sz.x - 2.0 * uBw), 1.0 - (vP.y - uBw) / uBar)).rgb;
    vec2 inC = step(uContent.xy, vP) * step(vP, uContent.xy + uContent.zw);
    col = mix(col, pic, inC.x * inC.y);
  }
  col = mix(col, uFlashCol, uFlash);
  // the body over its hard shadow
  float a = body + shadow * (1.0 - body);
  vec3 o = (col * body + uInk * shadow * (1.0 - body)) / max(a, 1e-4);
  gl_FragColor = vec4(o, a * uAlpha);
}`;

/** a small integer hash → 0..1 (repeatable, unlike Math.random) */
function hash(n: number): number {
  let x = n | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const tmpColor = new THREE.Color();

export class SceneWindows {
  /** set by the quality governor (src/render/quality.ts): most windows open at once, and whether they run effects */
  cap = 3;
  effects = true;
  private wins: Win[] = [];
  /** the next window's look, created and drawn once ahead of time so opening it doesn't stall on a compile */
  private warm: Slot | null = null;
  private queue: { at: number; trail: boolean }[] = [];
  private lastSec = -1;
  private lastBar = -1;
  private lastDrop = 0;
  private lastT = 0;
  private lastSince = 99;
  private lastDropAt = -99;
  private size = '';
  private rBeat = -1;
  private rN = 0;
  /** from the main look, so two looks on the same song don't open windows on the same bars */
  private seed = 0;
  private seedKey = '';
  private recent: string[] = [];
  /** where the lyrics are this frame (lyricLayer.keepOut()) */
  private keep: KeepOut = NO_KEEP_OUT;
  private lastTime = -1;
  private blank = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  private mat = new THREE.ShaderMaterial({
    uniforms: {
      tMap: { value: null as THREE.Texture | null },
      tBar: { value: null as THREE.Texture | null },
      uBox: { value: new THREE.Vector4() },
      uContent: { value: new THREE.Vector4() },
      uScale: { value: new THREE.Vector2(1, 1) },
      uRes: { value: new THREE.Vector2(1, 1) },
      uPad: { value: 0 },
      uRound: { value: 0 },
      uRadius: { value: 0 },
      uBw: { value: 2 },
      uMat: { value: 3 },
      uShadow: { value: 4 },
      uBar: { value: 0 },
      uAlpha: { value: 1 },
      uFlash: { value: 0 },
      uInk: { value: new THREE.Vector3() },
      uPaper: { value: new THREE.Vector3() },
      uFlashCol: { value: new THREE.Vector3() },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  private quad = createFullscreenQuad(this.mat);

  constructor() {
    this.blank.needsUpdate = true;
  }

  /** `keep`: where the lyrics are (lyricLayer.keepOut()), for the windows to keep clear of */
  render(r: THREE.WebGLRenderer, base: Omit<FrameContext, 'params'>, opts: { level: number; mainPresetId: string | null; mainSceneId: string; target?: THREE.WebGLRenderTarget | null; keep?: KeepOut }) {
    const W = base.width;
    const H = base.height;
    const t = base.time;
    const a = base.audio;
    const spb = 60 / (a.bpm > 30 ? a.bpm : 110);
    const level = Math.max(0, Math.min(3, this.cap, Math.round(opts.level)));
    const sk = `${opts.mainPresetId ?? ''}|${opts.mainSceneId}`;
    if (sk !== this.seedKey) {
      this.seedKey = sk;
      this.seed = [...sk].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619), 2166136261) & 0xffff;
    }
    if (a.beatCount !== this.rBeat) {
      this.rBeat = a.beatCount;
      this.rN = 0;
    }
    const key = `${W}x${H}`;
    if (key !== this.size) {
      // sizes are in device px: a new frame size starts over
      this.size = key;
      for (const w of this.wins) this.freeWin(w);
      this.wins.length = 0;
      this.freeWarm();
    }
    if (this.warm && !this.allowed(this.warm.sceneId, opts.mainSceneId)) this.freeWarm();
    this.keep = opts.keep ?? NO_KEEP_OUT;

    // while a build winds up the open windows hold on (trembling) until the drop slams them shut
    if (base.feel.tension > 0.4) for (const w of this.wins) if (w.closing < 0) w.until = Math.max(w.until, t + 0.5);
    for (const w of this.wins) if (w.closing < 0 && (t >= w.until || level === 0 || w.slot.failed || w.slot.sceneId === opts.mainSceneId)) w.closing = t;
    const busy = this.schedule(r, base, opts, level, spb);
    this.wins = this.wins.filter((w) => {
      const done = w.closing >= 0 && t - w.closing >= OUT_TIME;
      if (done) this.freeWin(w);
      return !done;
    });
    // open windows glide out of the sung line's way
    const gdt = this.lastTime < 0 ? 0 : Math.min(0.25, Math.max(0, t - this.lastTime));
    this.lastTime = t;
    const words = toPx(this.keep.now, W, H, Math.min(W, H) * 0.02);
    for (const w of this.wins) {
      if (w.closing >= 0) continue;
      const others = this.wins.filter((o) => o !== w && o.closing < 0).map((o) => this.goalBox(o));
      glide(w, w.g, w.slot.spec.w, w.slot.spec.h, words, W, H, Math.min(W, H) * 0.04, others, gdt);
    }
    // warm the next look on a frame where nothing opens, so the compile never lands on a beat
    if (level > 0 && !busy && !this.warm) {
      const slot = (this.warm = this.makeSlot(r, base, opts));
      // compiled in the background (warmup.ts): a render that draws nothing, so no frame waits for it
      if (slot) void dryRun(r, () => this.renderSlot(r, base, slot));
    }
    if (!this.wins.length) return;

    // the music: kicks bump, snares stamp a cascade copy of the newest window
    const dt = Math.min(0.1, Math.max(0, base.dt));
    let newest: Win | null = null;
    for (const w of this.wins) {
      if (a.kickHit && w.closing < 0) w.bump = 0.03;
      else w.bump *= Math.exp(-dt * 10);
      w.stamps = w.stamps.filter((s) => t - s.born < spb * 2);
      if (w.closing < 0 && (!newest || w.born >= newest.born)) newest = w;
    }
    if (a.snareHit && level >= 2 && newest && t - newest.born > IN_STEP * IN_SCALES.length) {
      if (!newest.stamps.length) newest.stampN = 0;
      const k = (newest.stampN++ % MAX_STAMPS) + 1;
      newest.stamps = newest.stamps.filter((s) => s.k !== k);
      newest.stamps.push({ born: t, k });
    }

    const clear = r.getClearColor(tmpColor).getHex();
    const clearA = r.getClearAlpha();
    for (const w of this.wins) {
      // the stamped-on flash frame hides the picture, and a window squashed to a line doesn't need one
      const age = t - w.born;
      if (w.closing < 0 && age < IN_STEP) continue;
      this.renderSlot(r, base, w.slot);
    }
    r.setClearColor(clear, clearA);
    this.composite(r, base, opts.target ?? null);
  }

  /** where a window is heading, at the size it's heading for (px) */
  private goalBox(w: Win): PxBox {
    const sp = w.slot.spec;
    const f = w.g.fitTo;
    return { x: w.g.gx + (sp.w * (1 - f)) / 2, y: w.g.gy + (sp.h * (1 - f)) / 2, w: sp.w * f, h: sp.h * f };
  }

  /** the open windows (normalized, where they're heading), so lyrics over one get the halo */
  occupied(): Rect[] {
    const [W, H] = this.size.split('x').map(Number);
    if (!W || !H) return [];
    return this.wins.filter((w) => w.closing < 0).map((w) => toRect(this.goalBox(w), W, H));
  }

  /** decide when windows open: section changes, drops, some phrase starts. Returns true when this frame is taken */
  private schedule(r: THREE.WebGLRenderer, base: Omit<FrameContext, 'params'>, opts: { mainPresetId: string | null; mainSceneId: string }, level: number, spb: number): boolean {
    const a = base.audio;
    const t = base.time;
    const secs = base.analysis?.sections ?? [];
    const si = secs.length ? sectionIndexAt(secs, a.time) : -1;
    const bar = Math.floor(Math.max(0, a.beatCount) / 4);
    // the live drop detector, playback crossing one of the song map's drops, or Feel landing one
    const crossed = a.time > this.lastT && a.time - this.lastT < 0.5 && !!base.analysis?.drops.some((d) => d > this.lastT && d <= a.time);
    let dropEdge = (a.drop > 0.6 && this.lastDrop <= 0.6) || crossed || (base.feel.sinceDrop < 0.2 && this.lastSince >= 0.2);
    if (dropEdge) {
      if (t - this.lastDropAt < 1) dropEdge = false;
      else this.lastDropAt = t;
    }
    this.lastDrop = a.drop;
    this.lastT = a.time;
    this.lastSince = base.feel.sinceDrop;
    if (level <= 0 || !a.playing) {
      this.queue.length = 0;
      this.lastSec = si;
      this.lastBar = bar;
      return false;
    }
    if (si !== this.lastSec) {
      if (this.lastSec !== -1 || a.time > 1) for (let k = 0; k < level; k++) this.queue.push({ at: t + k * spb, trail: false });
      this.lastSec = si;
    }
    if (bar !== this.lastBar) {
      this.lastBar = bar;
      if (bar % 4 === 0 && this.rand() < PHRASE_CHANCE[level]) this.queue.push({ at: t, trail: false });
    }
    if (dropEdge) {
      // every window snaps shut on the hit (no close animation), so the drop frame is the main look alone;
      // half a beat and a beat later new ones burst open with a full cascade behind them
      for (const w of this.wins) this.freeWin(w);
      this.wins.length = 0;
      this.queue.length = 0;
      for (let k = 0; k < Math.min(2, level); k++) this.queue.push({ at: t + (k + 1) * spb * 0.5, trail: true });
      return true;
    }
    // winding up: nothing new opens until it lets go
    if (base.feel.tension > 0.4) this.queue = this.queue.filter((q) => q.trail);
    this.queue = this.queue.filter((q) => q.at > t - spb * 2);
    this.queue.sort((x, y) => x.at - y.at);
    if (this.queue.length > 8) this.queue.splice(0, this.queue.length - 8);
    if (!this.queue.length || this.queue[0].at > t) return false;
    const q = this.queue.shift()!;
    const open = this.wins.filter((w) => w.closing < 0);
    if (open.length >= level) {
      // full: retire the oldest so the newest still lands on the beat
      open[0].closing = t;
    }
    this.spawn(r, base, opts, spb, q.trail);
    return true;
  }

  private spawn(r: THREE.WebGLRenderer, base: Omit<FrameContext, 'params'>, opts: { mainPresetId: string | null; mainSceneId: string }, spb: number, trail: boolean) {
    const t = base.time;
    let slot = this.warm;
    this.warm = null;
    if (slot && !this.allowed(slot.sceneId, opts.mainSceneId)) {
      this.freeSlot(slot);
      slot = null;
    }
    slot ??= this.makeSlot(r, base, opts);
    if (!slot) return;
    const { x, y, dir } = this.place(slot.spec, base.width, base.height);
    const bars = 2 + Math.floor(this.rand() * 3);
    const w: Win = { slot, x, y, dir, born: t, until: t + Math.min(11, Math.max(3, bars * 4 * spb)), closing: -1, bump: 0, stamps: [], stampN: 0, title: null, g: newGlide(x, y) };
    if (trail) {
      for (let k = 1; k <= MAX_STAMPS; k++) w.stamps.push({ born: t, k });
      w.stampN = MAX_STAMPS;
    }
    this.wins.push(w);
    this.recent.push(slot.lookId);
    if (this.recent.length > 6) this.recent.shift();
  }

  /** a scene may open when it isn't the main look's and isn't already up in another window */
  private allowed(sceneId: string, mainSceneId: string): boolean {
    return sceneId !== mainSceneId && !this.wins.some((w) => w.closing < 0 && w.slot.sceneId === sceneId);
  }

  /** looks related to the main one when the song map knows it, else the same style family, then anything */
  private pickLook(base: Omit<FrameContext, 'params'>, opts: { mainPresetId: string | null; mainSceneId: string }): Preset | null {
    const ok = (p: Preset) => {
      const d = getScene(p.sceneId);
      return !!d && d.category !== 'board' && !d.showsLyrics && p.id !== opts.mainPresetId && this.allowed(p.sceneId, opts.mainSceneId);
    };
    const main = findLook(opts.mainPresetId);
    const related = main && base.analysis ? relatedLooks(main.id, base.analysis).map((id) => findLook(id)).filter((p): p is Preset => !!p && ok(p)) : [];
    const fam = main ? lookStyle(main) : sceneStyle(getScene(opts.mainSceneId));
    const rest = allLooks().filter((p) => !p.custom && ok(p) && !related.includes(p));
    const tiers = [related, rest.filter((p) => lookStyle(p) === fam), rest.filter((p) => lookStyle(p) !== fam)];
    // a look shown in the last few windows waits its turn, unless nothing else is left
    const fresh = tiers.map((ps) => ps.filter((p) => !this.recent.includes(p.id)));
    const tier = fresh.find((ps) => ps.length) ?? tiers.find((ps) => ps.length);
    if (!tier) return null;
    return tier[Math.floor(this.rand() * tier.length)];
  }

  private makeSpec(W: number, H: number): Spec {
    const s = Math.min(W, H) / 1080;
    const f = this.rand();
    const frame: FrameKind = f < 0.5 ? 'window' : f < 0.75 ? 'card' : 'round';
    let aspect = ASPECTS[Math.floor(this.rand() * ASPECTS.length)];
    const circle = frame === 'round' && this.rand() < 0.5;
    if (circle) aspect = 1;
    const U = Math.min(W, H) * (0.4 + this.rand() * 0.08);
    let w = U * Math.sqrt(aspect);
    let h = U / Math.sqrt(aspect);
    const k = Math.min(1, (W * 0.45) / w, (H * 0.45) / h);
    w = Math.max(16, Math.round(w * k));
    h = Math.max(16, Math.round(h * k));
    if (circle) w = h = Math.min(w, h);
    const bw = Math.max(2, Math.round(2 * s));
    // a thin paper mat between the ink line and the picture, so a frame reads on any picture (and so do its cascade copies)
    const mat = Math.max(2, Math.round(4 * s));
    const bar = frame === 'window' ? Math.round(Math.max(14, 22 * s)) : 0;
    const e = bw + mat;
    const box = frame === 'window' ? { cx: e, cy: bw * 2 + bar + mat, cw: w - e * 2, ch: h - bw * 3 - bar - mat * 2 } : frame === 'card' ? { cx: e, cy: e, cw: w - e * 2, ch: h - e * 2 } : { cx: 0, cy: 0, cw: w, ch: h };
    return {
      w,
      h,
      ...box,
      frame,
      radius: circle ? w / 2 : Math.round(Math.min(w, h) * 0.12),
      bw,
      mat,
      bar,
      shadow: Math.round(Math.max(3, 7 * s)),
      step: Math.round(Math.max(6, 18 * s)),
      barStyle: this.rand() < 0.5 ? 0 : 1,
    };
  }

  /** somewhere that keeps the middle of the picture clear, the cascade inside the frame, and other windows mostly uncovered */
  private place(spec: Spec, W: number, H: number): { x: number; y: number; dir: [number, number] } {
    const m = Math.min(W, H) * 0.04;
    const trail = spec.step * MAX_STAMPS;
    const mid = { x: W * 0.3, y: H * 0.3, w: W * 0.4, h: H * 0.4 };
    const overlap = (ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number) =>
      Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx)) * Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
    let best: { x: number; y: number; dir: [number, number]; cost: number } | null = null;
    for (let k = 0; k < 24; k++) {
      const x = m + this.rand() * Math.max(1, W - spec.w - 2 * m);
      const y = m + this.rand() * Math.max(1, H - spec.h - 2 * m);
      const dir: [number, number] = [x + spec.w / 2 < W / 2 ? -1 : 1, y + spec.h / 2 < H / 2 ? 1 : -1];
      // the box and its cascade together
      const fx = Math.min(x, x + dir[0] * trail);
      const fy = Math.min(y, y + dir[1] * trail);
      const fw = spec.w + trail;
      const fh = spec.h + trail;
      let cost = overlap(x, y, spec.w, spec.h, mid.x, mid.y, mid.w, mid.h) * 8 + overlap(fx, fy, fw, fh, mid.x, mid.y, mid.w, mid.h) * 2;
      // and the lyrics: the line now, and where the next will land
      cost += keepCost({ x, y, w: spec.w, h: spec.h }, this.keep, W, H, Math.min(W, H) * 0.02);
      cost += (fw * fh - overlap(fx, fy, fw, fh, 0, 0, W, H)) * 0.5;
      for (const o of this.wins) {
        if (o.closing >= 0) continue;
        const os = o.slot.spec;
        const ot = os.step * MAX_STAMPS;
        cost += overlap(x, y, spec.w, spec.h, o.x, o.y, os.w, os.h) * 3;
        // and keep the two cascades from piling into each other
        cost += overlap(fx, fy, fw, fh, Math.min(o.x, o.x + o.dir[0] * ot), Math.min(o.y, o.y + o.dir[1] * ot), os.w + ot, os.h + ot) * 1.5;
      }
      if (!best || cost < best.cost) best = { x, y, dir, cost };
    }
    return { x: Math.round(best!.x), y: Math.round(best!.y), dir: best!.dir };
  }

  private makeSlot(r: THREE.WebGLRenderer, base: Omit<FrameContext, 'params'>, opts: { mainPresetId: string | null; mainSceneId: string }): Slot | null {
    const p = this.pickLook(base, opts);
    const def = p ? getScene(p.sceneId) : undefined;
    if (!p || !def) return null;
    const spec = this.makeSpec(base.width, base.height);
    // in a video, a window wears the song's colours like the main picture does
    const look = presetToLook(songTinted(p));
    const rt = makeRenderTarget(spec.cw, spec.ch, { depthBuffer: true, samples: 0 });
    let inst: SceneInstance;
    try {
      inst = def.create({ renderer: r, width: spec.cw, height: spec.ch, shared: base.shared });
    } catch (e) {
      console.warn('[hum] scene window failed', e);
      rt.dispose();
      this.recent.push(p.id);
      return null;
    }
    const fx = new FxChain(base.shared);
    fx.setSize(spec.cw, spec.ch);
    return { lookId: p.id, name: p.name, sceneId: p.sceneId, def, inst, look, pal: resolvePalette(look.palette), rt, fx, fxParams: new Map(), params: {}, spec, tex: rt.texture, failed: false };
  }

  /** draw a window's look into its own target, effects and all */
  private renderSlot(r: THREE.WebGLRenderer, base: Omit<FrameContext, 'params'>, slot: Slot) {
    const { cw, ch } = slot.spec;
    const a = base.audio;
    const params = resolveParams(slot.def.params, slot.look.sceneParams, slot.look.modulations, 'scene', a.layers, slot.params);
    r.setRenderTarget(slot.rt);
    r.setClearColor(slot.pal.c.bg, 1);
    r.clear(true, true, false);
    try {
      slot.inst.render({ ...base, width: cw, height: ch, aspect: cw / ch, palette: slot.pal, params }, slot.rt);
    } catch (e) {
      console.warn('[hum] scene window failed', e);
      slot.failed = true;
    }
    const chain: { inst: EffectInstance; def: EffectDef; params: ParamValues }[] = [];
    // the quality governor can leave a window's effects out (an empty chain hands back the plain picture)
    if (this.effects) for (const inst of slot.look.effects) {
      const def = getEffect(inst.effectId);
      if (!def) continue;
      let p = slot.fxParams.get(inst.instanceId);
      if (!p) slot.fxParams.set(inst.instanceId, (p = {}));
      resolveParams(def.params, inst.params, slot.look.modulations, `fx.${inst.instanceId}`, a.layers, p);
      chain.push({ inst, def, params: p });
    }
    slot.tex = slot.fx.run(r, slot.rt.texture, chain, { width: cw, height: ch, time: base.time, audio: a, feel: base.feel, palette: slot.pal });
  }

  /** the title bar, drawn once per window (and again if the main look's colours change) */
  private titleBar(w: Win, ink: Ink): THREE.Texture {
    const sp = w.slot.spec;
    const bw = Math.max(1, sp.w - sp.bw * 2);
    if (w.title?.key === ink.key) return w.title.tex;
    if (!w.title) {
      const canvas = document.createElement('canvas');
      const tex = new THREE.CanvasTexture(canvas);
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      w.title = { canvas, tex, key: '' };
    }
    const { canvas, tex } = w.title;
    canvas.width = bw;
    canvas.height = sp.bar;
    const g = canvas.getContext('2d')!;
    const bg = sp.barStyle === 1 ? ink.ac : ink.bg;
    const fg = sp.barStyle === 1 ? (lum(ink.ac) > 0.55 ? ink.fg : ink.bg) : ink.fg;
    g.fillStyle = rgba(bg);
    g.fillRect(0, 0, bw, sp.bar);
    const b = Math.round(sp.bar * 0.42);
    const gap = Math.round(sp.bar * 0.22);
    const lw = Math.max(1, Math.round(sp.bar / 16));
    // three small square buttons on the right, the first filled
    g.strokeStyle = g.fillStyle = rgba(fg);
    g.lineWidth = lw;
    const by = Math.round((sp.bar - b) / 2);
    for (let k = 0; k < 3; k++) {
      const bx = bw - gap * 1.4 - (k + 1) * b - k * gap;
      if (k === 2) g.fillRect(Math.round(bx), by, b, b);
      else g.strokeRect(Math.round(bx) + lw / 2, by + lw / 2, b - lw, b - lw);
    }
    // the look's name in small caps
    setFont(g, sp.bar * 0.5, 700, MONO, 0.12);
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    const room = bw - gap * 3 - 3 * (b + gap) - sp.bar * 0.45;
    let title = w.slot.name.toUpperCase();
    while (title.length > 2 && g.measureText(title).width > room) title = `${title.slice(0, -2).trimEnd()}…`;
    g.fillText(title, Math.round(sp.bar * 0.45), sp.bar / 2 + 1);
    tex.needsUpdate = true;
    w.title.key = ink.key;
    return tex;
  }

  private composite(r: THREE.WebGLRenderer, base: Omit<FrameContext, 'params'>, target: THREE.WebGLRenderTarget | null) {
    const W = base.width;
    const H = base.height;
    const t = base.time;
    const spb = 60 / (base.audio.bpm > 30 ? base.audio.bpm : 110);
    const ink = paperInk(makeInk(base.palette, 0.95));
    const u = this.mat.uniforms;
    u.uRes.value.set(W, H);
    u.uInk.value.set(ink.fg[0] / 255, ink.fg[1] / 255, ink.fg[2] / 255);
    u.uPaper.value.set(ink.bg[0] / 255, ink.bg[1] / 255, ink.bg[2] / 255);
    u.uFlashCol.value.set(ink.ac[0] / 255, ink.ac[1] / 255, ink.ac[2] / 255);
    // winding up: windows huddle towards the middle, shrink and tremble
    const tense = smooth(0.4, 1, base.feel.tension);
    const s = Math.min(W, H) / 1080;
    const ac = r.autoClear;
    r.autoClear = false;
    this.wins.forEach((w, i) => {
      const sp = w.slot.spec;
      const age = t - w.born;
      let sx = 1;
      let sy = 1;
      if (w.closing >= 0) {
        // snap shut: squash to a line, then pinch to a dot
        const k = (t - w.closing) / OUT_TIME;
        if (k < 0.6) sy = Math.max(0.02, 1 - k / 0.6);
        else {
          sy = 0.02;
          sx = Math.max(0, 1 - (k - 0.6) / 0.4);
        }
      } else sx = sy = IN_SCALES[Math.min(IN_SCALES.length - 1, Math.floor(age / IN_STEP))];
      if (sx <= 0.001) return;
      const k = w.closing < 0 ? tense : 0;
      const g = (1 + w.bump) * (1 - 0.15 * k) * w.g.fit;
      sx *= g;
      sy *= g;
      const jx = k > 0 ? (hash(base.frame * 31 + i * 7) - 0.5) * 4 * s * k : 0;
      const jy = k > 0 ? (hash(base.frame * 31 + i * 7 + 3) - 0.5) * 4 * s * k : 0;
      const cx0 = w.x + sp.w / 2;
      const cy0 = w.y + sp.h / 2;
      const cx = cx0 + (W / 2 - cx0) * 0.2 * k + jx;
      const cy = cy0 + (H / 2 - cy0) * 0.2 * k + jy;

      u.tMap.value = w.slot.tex;
      u.tBar.value = sp.frame === 'window' ? this.titleBar(w, ink) : this.blank;
      u.uContent.value.set(sp.cx, sp.cy, sp.cw, sp.ch);
      u.uScale.value.set(sx, sy);
      u.uPad.value = sp.shadow + 2;
      u.uRound.value = sp.frame === 'round' ? 1 : 0;
      u.uRadius.value = sp.radius;
      u.uBw.value = sp.bw;
      u.uMat.value = sp.mat;
      u.uShadow.value = sp.shadow;
      u.uBar.value = sp.bar;
      // the cascade, furthest copy first, all behind the window
      const stamps = [...w.stamps].sort((p, q) => q.k - p.k);
      for (const st of stamps) {
        const life = (t - st.born) / (spb * 2);
        u.uAlpha.value = 1 - smooth(0.25, 1, life);
        u.uFlash.value = 0;
        u.uBox.value.set(cx + w.dir[0] * st.k * sp.step * sx, cy + w.dir[1] * st.k * sp.step * sy, sp.w, sp.h);
        this.quad.render(r, target);
      }
      u.uAlpha.value = 1;
      // first frame: a solid flash of accent, like a window being stamped on
      u.uFlash.value = w.closing < 0 && age < IN_STEP ? 1 : 0;
      u.uBox.value.set(cx, cy, sp.w, sp.h);
      this.quad.render(r, target);
    });
    r.autoClear = ac;
  }

  private rand(): number {
    // stepped from the beat count, so the same song plays out the same way every time
    return hash(this.rBeat * 1013 + this.rN++ * 7 + this.seed * 7919);
  }

  private freeSlot(s: Slot) {
    s.inst.dispose();
    s.rt.dispose();
    s.fx.dispose();
  }

  private freeWin(w: Win) {
    this.freeSlot(w.slot);
    w.title?.tex.dispose();
  }

  private freeWarm() {
    if (this.warm) this.freeSlot(this.warm);
    this.warm = null;
  }

  dispose() {
    for (const w of this.wins) this.freeWin(w);
    this.wins.length = 0;
    this.freeWarm();
    this.blank.dispose();
    this.mat.dispose();
    this.quad.dispose();
  }
}
