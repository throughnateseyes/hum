import * as THREE from 'three';
import { audioEngine } from '../audio/engine';
import { resolvePalette } from '../core/palettes';
import { createFullscreenQuad, makeRenderTarget } from '../core/sceneHelpers';
import { lookStyle, sceneStyle } from '../core/styles';
import type { EffectDef, EffectInstance, FrameContext, ParamValues, Preset, ResolvedPalette, SceneDef, SceneInstance, TrackAnalysis } from '../core/types';
import { getEffect } from '../fx';
import { presetToLook, type LookState } from '../presets/apply';
import { getScene } from '../scenes';
import { lum, makeInk, rgba, setFont, MONO } from '../scenes/board/kit';
import type { Ink } from '../scenes/board/kit';
import { resolveParams } from '../state/modulation';
import { allLooks, findLook, planShots, playingMood, relatedLooks, shotIndexAt, songTinted, validPlan } from '../state/plan';
import { popDealsVersion } from '../state/popSeed';
import { useStudio, type WindowKind } from '../state/store';
import { withTweak } from '../state/tweaks';
import { moodFilter } from '../presets/moods';
import { FxChain } from './fxChain';
import { newGlide, overlap, toPx, toRect, type Glide, type PxBox } from './keepClear';
import { NO_KEEP_OUT, type KeepOut, type Rect } from './legibility';
import { barsIn, dealer, dropsIn, hash01, keepGlide, lastAt, paperInk, popPartAt, prevPopPart, refSize, songGrid, type PopLevel, type PopPart } from './popups';
import { dryRun } from './warmup';

/**
 * Scene windows: framed windows over the picture that each play ANOTHER look live, so looks stack up
 * like a desktop full of programs. The sibling of the instrument pop-ups (popups.ts): they open on
 * section changes, drops and some phrase starts, bump on kicks, stamp a cascade of copies on snares,
 * huddle and tremble while a build winds up, and all snap shut on a drop so the hit reads clean, then
 * burst back open. Each window renders its look at exactly its on-screen size into its own target,
 * and one small shader draws the picture with its frame, so it is in recordings too. They keep clear
 * of the sung line like the pop-ups do (keepClear.ts): step out of its way when they show, glide while up.
 *
 * The same every time, like the pop-ups (popups.ts): each part deals its windows up front from its
 * seed (popSeed.ts) and the song map (beat grid, drops, the plan's looks), so which look opens where
 * and when is a matter of where in the song we are, not of how we got there. Kicks and snares come
 * from the song map's drum hits too, so a seek or a render shows the same bumps and cascades.
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

/** one dealt window: everything about it that's decided up front */
interface WDealt {
  id: number;
  lookId: string;
  sceneId: string;
  /** its shape's dice, and the box they make at the reference size (where it was placed) */
  shape: Shape;
  spec: Spec;
  x: number;
  y: number;
  /** which way the cascade runs (away from the middle sideways, towards it up or down) */
  dir: [number, number];
  born: number;
  until: number;
  /** shut by a drop: gone on the hit, no close animation */
  snap: boolean;
  /** bursts open after a drop with a full cascade behind it */
  trail: boolean;
}

interface WDeal {
  key: string;
  level: number;
  wins: WDealt[];
}

/** the dice behind a window's shape: frame kind, aspect, round or not, size, title bar */
interface Shape {
  f: number;
  aspect: number;
  circle: number;
  size: number;
  bar: number;
}

/** a dealt window on screen */
interface Win {
  d: WDealt;
  /** where its deal put it, in this frame's pixels */
  home: { x: number; y: number };
  slot: Slot;
  x: number;
  y: number;
  born: number;
  /** when it started closing (-1 while open) */
  closing: number;
  /** kick bump, decaying back to 0 */
  bump: number;
  /** cascade copies: k steps away, fading from `born` */
  stamps: { born: number; k: number }[];
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
/** deals kept (the part playing, the one before and a few recent), so moving around doesn't re-deal */
const KEEP_DEALS = 6;

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

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const tmpColor = new THREE.Color();

/** what the windows are opened over: the look on screen (the plan's look at each moment, when a plan plays) */
interface MainLook {
  mainPresetId: string | null;
  mainSceneId: string;
}

export interface WindowOpts extends MainLook {
  /** how busy each part is: one level for the whole song, or a level for each moment */
  level: PopLevel;
  /** the most windows drawn right now (fewer over a busy board look, none over footage); the deal stays */
  show?: number;
  target?: THREE.WebGLRenderTarget | null;
  keep?: KeepOut;
}

/** the look on screen at song time `t`: the plan's shot then, or the look on screen now when no plan plays */
function mainAt(t: number, now: MainLook): MainLook {
  const s = useStudio.getState();
  if (!s.planOn || audioEngine.kind !== 'file' || !validPlan(s.plan, s.analysis)) return now;
  const shots = planShots(s.plan, s.analysis!, s.pace, s.lyrics);
  if (!shots.length) return now;
  const p = findLook(shots[shotIndexAt(shots, t)].lookId);
  return p ? { mainPresetId: p.id, mainSceneId: p.sceneId } : now;
}

/** what the deal for a part depends on besides its seed: the looks it opens over */
function mainsKey(part: PopPart, now: MainLook): string {
  const s = useStudio.getState();
  if (!s.planOn || audioEngine.kind !== 'file' || !validPlan(s.plan, s.analysis)) return `${now.mainPresetId}|${now.mainSceneId}|${playingMood() ?? ''}`;
  const shots = planShots(s.plan, s.analysis!, s.pace, s.lyrics);
  const ids: string[] = [];
  for (let k = Math.max(0, shotIndexAt(shots, part.start)); k < shots.length && shots[k].t < part.end; k++) ids.push(shots[k].lookId);
  return `${ids.join(',')}|${s.plan!.mood ?? ''}`;
}

export class SceneWindows {
  /** set by the quality governor (src/render/quality.ts): most windows drawn at once, and whether they run effects */
  cap = 3;
  effects = true;
  private deals = new Map<string, WDeal>();
  /** windows on screen, by deal key and window id */
  private live = new Map<string, Win>();
  /** this frame's windows, oldest first */
  private wins: Win[] = [];
  /** the next window's look, created and drawn once ahead of time so opening it doesn't stall on a compile */
  private warm: { key: string; slot: Slot } | null = null;
  private size = '';
  /** where the lyrics are this frame (lyricLayer.keepOut()) */
  private keep: KeepOut = NO_KEEP_OUT;
  private lastSong = -1;
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
  render(r: THREE.WebGLRenderer, base: Omit<FrameContext, 'params'>, opts: WindowOpts) {
    const W = base.width;
    const H = base.height;
    const a = base.audio;
    const song = a.time;
    const an = base.analysis;
    const grid = songGrid(an, a.bpm);
    const spb = grid.spb;
    const key = `${W}x${H}`;
    if (key !== this.size) {
      // sizes are in device px: a new frame size deals again
      this.size = key;
      for (const w of this.live.values()) this.freeWin(w);
      this.live.clear();
      this.deals.clear();
      this.freeWarm();
    }
    this.keep = opts.keep ?? NO_KEEP_OUT;
    const levelAt = typeof opts.level === 'number' ? (() => opts.level) as () => number : opts.level;
    const now: MainLook = { mainPresetId: opts.mainPresetId, mainSceneId: opts.mainSceneId };
    const ref = refSize(W, H);

    // the windows open at this moment of the song: this part's, and the last part's still closing
    const part = popPartAt(an, song);
    const prev = prevPopPart(an, part);
    const deal = this.dealFor(r, part, levelAt(part.start + 0.001), base, now, grid);
    const want: { key: string; d: WDealt }[] = [];
    const parts = prev && song - part.start < OUT_TIME ? [this.dealFor(r, prev, levelAt(prev.start + 0.001), base, now, grid), deal] : [deal];
    for (const dl of parts) for (const d of dl.wins) if (d.born <= song && song < d.until + (d.snap ? 0 : OUT_TIME)) want.push({ key: `${dl.key}#${d.id}`, d });
    // most windows drawn: the newest open ones; never the look that's on screen itself
    let room = Math.max(0, Math.min(this.cap, opts.show ?? 3));
    for (let k = want.length - 1; k >= 0; k--) {
      const d = want[k].d;
      if (d.sceneId === opts.mainSceneId) want.splice(k, 1);
      else if (d.until > song) {
        if (room > 0) room--;
        else want.splice(k, 1);
      }
    }

    const seeked = this.lastSong < 0 || song < this.lastSong - 1e-3 || song - this.lastSong > 0.5;
    this.lastSong = song;
    const gdt = this.lastTime < 0 ? 0 : Math.min(0.25, Math.max(0, base.time - this.lastTime));
    this.lastTime = base.time;
    let busy = false;
    const next = new Map<string, Win>();
    const wins: Win[] = [];
    const fresh = new Set<Win>();
    for (const { key: k, d } of want) {
      let w = this.live.get(k);
      if (!w) {
        let slot: Slot | null = null;
        if (this.warm?.key === k) {
          slot = this.warm.slot;
          this.warm = null;
        } else {
          slot = this.makeSlot(r, base, d);
          busy = true;
        }
        if (!slot) continue;
        const x = Math.round(d.x * ref.k);
        const y = Math.round(d.y * ref.k);
        w = { d, home: { x, y }, slot, x, y, dir: d.dir, born: d.born, closing: -1, bump: 0, stamps: [], title: null, g: newGlide(x, y) };
        fresh.add(w);
      }
      if (w.slot.failed) continue;
      w.closing = song >= d.until ? d.until : -1;
      next.set(k, w);
      wins.push(w);
    }
    for (const [k, w] of this.live) if (!next.has(k)) this.freeWin(w);
    this.live = next;
    this.wins = wins;

    // open windows step out of the sung line's way
    const words = toPx(this.keep.now, W, H, Math.min(W, H) * 0.02);
    for (const w of wins) {
      if (w.closing >= 0) continue;
      const others = wins.filter((o) => o !== w && o.closing < 0).map((o) => this.goalBox(o));
      keepGlide(w, w.home, w.g, w.slot.spec.w, w.slot.spec.h, words, W, H, Math.min(W, H) * 0.04, others, gdt, seeked || fresh.has(w));
    }
    // warm the next window's look on a frame where nothing opens, so the compile never lands on a beat
    if (!busy) this.warmNext(r, base, deal, song);
    if (!wins.length) return;

    // the music, from the song map so it's the same every time: kicks bump, snares stamp a cascade copy of the newest window
    const L = an?.layers;
    const ki = L ? lastAt(L.kick, song) : -1;
    const sinceKick = ki >= 0 ? song - L!.kick[ki] : 99;
    for (const w of wins) {
      w.bump = w.closing < 0 && ki >= 0 && L!.kick[ki] >= w.born ? 0.03 * Math.exp(-sinceKick * 10) : 0;
      w.stamps = w.d.trail && song - w.born < spb * 2 ? Array.from({ length: MAX_STAMPS }, (_, k) => ({ born: w.born, k: k + 1 })) : [];
    }
    if (L && deal.level >= 2) this.stampSnares(L.snare, deal, song, spb);

    const clear = r.getClearColor(tmpColor).getHex();
    const clearA = r.getClearAlpha();
    for (const w of wins) {
      // the stamped-on flash frame hides the picture
      const age = song - w.born;
      if (w.closing < 0 && age < IN_STEP) continue;
      this.renderSlot(r, base, w.slot);
    }
    r.setClearColor(clear, clearA);
    this.composite(r, base, opts.target ?? null, spb);
  }

  /**
   * Snares stamp a cascade copy of the window that was newest when they hit (once it has landed), the
   * copies stepping out one by one and fading over two beats: worked out from the song map's snares
   * for this moment, so a seek or a render shows the same cascade.
   */
  private stampSnares(snares: number[], deal: WDeal, song: number, spb: number) {
    const hi = lastAt(snares, song);
    for (let j = hi; j >= 0 && snares[j] > song - spb * 2; j--) {
      const s = snares[j];
      let newest: WDealt | null = null;
      for (const d of deal.wins) if (d.born <= s && s < d.until && (!newest || d.born >= newest.born)) newest = d;
      if (!newest || s - newest.born <= IN_STEP * IN_SCALES.length) continue;
      const w = this.wins.find((x) => x.d === newest);
      if (!w) continue;
      const first = lastAt(snares, newest.born + IN_STEP * IN_SCALES.length) + 1;
      const k = ((j - first) % MAX_STAMPS) + 1;
      if (!w.stamps.some((st) => st.k === k)) w.stamps.push({ born: s, k });
    }
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

  /** dev: the windows on screen this frame (normalized boxes), to check they repeat */
  debugList(): { look: string; born: number; until: number; deal: string; x: number; y: number; w: number; h: number; frame: string }[] {
    const [W, H] = this.size.split('x').map(Number);
    const { RW, RH } = refSize(W, H);
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    // `deal`: the dealt box (exact across sizes of one shape); x, y: where it is now (after keeping clear of the words)
    return this.wins.map((w) => ({ look: w.slot.lookId, born: r3(w.born), until: r3(w.d.until), deal: `${w.d.x / RW},${w.d.y / RH},${w.d.spec.w / RW},${w.d.spec.h / RH}`, x: r3(w.x / W), y: r3(w.y / H), w: r3(w.slot.spec.w / W), h: r3(w.slot.spec.h / H), frame: w.slot.spec.frame }));
  }

  /** the part's deal (kept while nothing it was dealt from changes) */
  private dealFor(r: THREE.WebGLRenderer, part: PopPart, level: number, base: Omit<FrameContext, 'params'>, now: MainLook, grid: { spb: number; off: number }): WDeal {
    void r;
    const lv = Math.max(0, Math.min(3, Math.round(level)));
    const { RW, RH } = refSize(base.width, base.height);
    const key = `${part.seed}|${part.start.toFixed(3)}|${part.end.toFixed(3)}|${lv}|${RW}x${RH}|${grid.spb.toFixed(5)}|${grid.off.toFixed(4)}|${mainsKey(part, now)}|${popDealsVersion()}`;
    let deal = this.deals.get(key);
    if (deal) {
      this.deals.delete(key);
      this.deals.set(key, deal);
      return deal;
    }
    deal = { key, level: lv, wins: dealWindows(part, lv, base, RW, RH, now, grid) };
    this.deals.set(key, deal);
    while (this.deals.size > KEEP_DEALS) this.deals.delete(this.deals.keys().next().value!);
    return deal;
  }

  /** create the next window's look ahead of time (compiled in the background by a render that draws nothing) */
  private warmNext(r: THREE.WebGLRenderer, base: Omit<FrameContext, 'params'>, deal: WDeal, song: number) {
    const d = deal.wins.find((x) => x.born > song && !this.live.has(`${deal.key}#${x.id}`));
    const key = d ? `${deal.key}#${d.id}` : '';
    if (this.warm?.key === key) return;
    this.freeWarm();
    if (!d) return;
    const slot = this.makeSlot(r, base, d);
    if (!slot) return;
    this.warm = { key, slot };
    // (warmup.ts) so no frame waits for the compile
    void dryRun(r, () => this.renderSlot(r, base, slot));
  }

  private makeSlot(r: THREE.WebGLRenderer, base: Omit<FrameContext, 'params'>, d: WDealt): Slot | null {
    const p = findLook(d.lookId);
    const def = p ? getScene(p.sceneId) : undefined;
    if (!p || !def) return null;
    const spec = specOf(d.shape, base.width, base.height);
    // in a video, a window wears the song's colours like the main picture does
    const look = presetToLook(songTinted(withTweak(p, useStudio.getState().tweaks[p.id])));
    const rt = makeRenderTarget(spec.cw, spec.ch, { depthBuffer: true, samples: 0 });
    let inst: SceneInstance;
    try {
      inst = def.create({ renderer: r, width: spec.cw, height: spec.ch, shared: base.shared });
    } catch (e) {
      console.warn('[hum] scene window failed', e);
      rt.dispose();
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

  private composite(r: THREE.WebGLRenderer, base: Omit<FrameContext, 'params'>, target: THREE.WebGLRenderTarget | null, spb: number) {
    const W = base.width;
    const H = base.height;
    const t = base.audio.time;
    const ink = paperInk(makeInk(base.palette, 0.95));
    const u = this.mat.uniforms;
    u.uRes.value.set(W, H);
    u.uInk.value.set(ink.fg[0] / 255, ink.fg[1] / 255, ink.fg[2] / 255);
    u.uPaper.value.set(ink.bg[0] / 255, ink.bg[1] / 255, ink.bg[2] / 255);
    u.uFlashCol.value.set(ink.ac[0] / 255, ink.ac[1] / 255, ink.ac[2] / 255);
    // winding up: windows huddle towards the middle, shrink and tremble
    const tense = smooth(0.4, 1, base.feel.tension);
    const s = Math.min(W, H) / 1080;
    // the tremble steps 60 times a song-second (not per drawn frame, so a render trembles the same way)
    const shake = Math.floor(t * 60);
    const words = toPx(this.keep.now, W, H, Math.min(W, H) * 0.01);
    const ac = r.autoClear;
    r.autoClear = false;
    this.wins.forEach((w) => {
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
      const i = w.d.id;
      const jx = k > 0 ? (hash01(shake * 31 + i * 7) - 0.5) * 4 * s * k : 0;
      const jy = k > 0 ? (hash01(shake * 31 + i * 7 + 3) - 0.5) * 4 * s * k : 0;
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
        const bx = cx + w.dir[0] * st.k * sp.step * sx;
        const by = cy + w.dir[1] * st.k * sp.step * sy;
        // never a copy on the words
        if (words && overlap({ x: bx - (sp.w * sx) / 2, y: by - (sp.h * sy) / 2, w: sp.w * sx, h: sp.h * sy }, words) > 0) continue;
        u.uBox.value.set(bx, by, sp.w, sp.h);
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
    if (this.warm) this.freeSlot(this.warm.slot);
    this.warm = null;
  }

  dispose() {
    for (const w of this.live.values()) this.freeWin(w);
    this.live.clear();
    this.wins.length = 0;
    this.deals.clear();
    this.freeWarm();
    this.blank.dispose();
    this.mat.dispose();
    this.quad.dispose();
  }
}

/* ───────── dealing a part's windows ───────── */

/**
 * Deal a part's windows: they open on the part's first beats and on some phrase starts; each drop
 * slams every window shut (no close animation, so the hit is the main look alone) and half a beat and
 * a beat later new ones burst open with a full cascade behind them. In the two bars winding up to a
 * drop nothing new opens, and a window due to close in the four bars before it holds on until the hit.
 * Two sets of dice from the part's seed: one for which phrases get a window, one for the windows.
 */
function dealWindows(part: PopPart, level: number, base: Omit<FrameContext, 'params'>, W: number, H: number, now: MainLook, grid: { spb: number; off: number }): WDealt[] {
  if (level <= 0) return [];
  const { spb, off } = grid;
  const when = dealer(part.seed ^ 0x27d4eb2f);
  const pick = dealer(part.seed ^ 0x165667b1);
  const drops = dropsIn(base.analysis, part.start, part.end);
  type Step = { at: number; drop: boolean; trail: boolean };
  const steps: Step[] = [];
  if (part.opens) for (let k = 0; k < level; k++) steps.push({ at: part.start + k * spb, drop: false, trail: false });
  for (const b of barsIn(part.start, part.end, spb, off)) {
    if (b.n % 4 !== 0) continue;
    if (when() < PHRASE_CHANCE[level]) steps.push({ at: b.t, drop: false, trail: false });
  }
  for (const d of drops) {
    steps.push({ at: d, drop: true, trail: false });
    for (let k = 0; k < Math.min(2, level); k++) steps.push({ at: d + (k + 1) * spb * 0.5, drop: false, trail: true });
  }
  // a drop goes before anything else at the same moment
  steps.sort((x, y) => x.at - y.at || +y.drop - +x.drop);

  const out: WDealt[] = [];
  const recent: string[] = [];
  let quietUntil = -1;
  for (const st of steps) {
    const open = out.filter((o) => o.until > st.at);
    if (st.drop) {
      for (const o of open) {
        o.until = st.at;
        o.snap = true;
      }
      // what was waiting to open is dropped with them; only the burst after the hit opens
      quietUntil = st.at + spb * 2;
      continue;
    }
    if (st.at < part.start || st.at > part.end - 0.25) continue;
    if (!st.trail) {
      if (st.at < quietUntil) continue;
      // winding up to a drop: nothing new opens
      const nextDrop = drops.find((d) => d > st.at);
      if (nextDrop !== undefined && nextDrop - st.at < spb * 8) continue;
    }
    if (open.length >= level) {
      // full: retire the oldest so the newest still lands on the beat
      open[0].until = st.at;
      open.shift();
    }
    const main = mainAt(st.at + 0.05, now);
    const p = pickLook(base.analysis, main, open, recent, pick);
    if (!p) continue;
    const shape: Shape = { f: pick(), aspect: pick(), circle: pick(), size: pick(), bar: pick() };
    const spec = specOf(shape, W, H);
    const { x, y, dir } = place(spec, W, H, open, pick);
    const bars = 2 + Math.floor(pick() * 3);
    let until = Math.min(part.end, st.at + Math.min(11, Math.max(3, bars * 4 * spb)));
    // a window due to close just before a drop holds on (trembling) until the drop slams it shut
    const nextDrop = drops.find((d) => d > st.at);
    if (nextDrop !== undefined && until < nextDrop && nextDrop - until < spb * 16) until = nextDrop;
    out.push({ id: out.length, lookId: p.id, sceneId: p.sceneId, shape, spec, x, y, dir, born: st.at, until, snap: false, trail: st.trail });
    recent.push(p.id);
    if (recent.length > 6) recent.shift();
  }
  return out;
}

/** looks related to the main one when the song map knows it, else the same style family, then anything */
function pickLook(a: TrackAnalysis | null | undefined, main: MainLook, open: WDealt[], recent: string[], roll: () => number): Preset | null {
  // a video planned in a mood keeps its windows in that world too
  const inMood = moodFilter(playingMood());
  const ok = (p: Preset) => {
    const d = getScene(p.sceneId);
    // (not the footage looks: a window would open another set of video players, and a render can't wait for theirs)
    return !!d && d.category !== 'board' && !d.showsLyrics && !d.usesClips && !d.usesDrawings && !d.usesFigures && p.id !== main.mainPresetId && p.sceneId !== main.mainSceneId && !open.some((o) => o.sceneId === p.sceneId) && (!inMood || inMood(p));
  };
  const m = findLook(main.mainPresetId);
  const related = m && a ? relatedLooks(m.id, a, [], undefined, undefined, inMood).map((id) => findLook(id)).filter((p): p is Preset => !!p && ok(p)) : [];
  const fam = m ? lookStyle(m) : sceneStyle(getScene(main.mainSceneId));
  const rest = allLooks().filter((p) => !p.custom && ok(p) && !related.includes(p));
  const tiers = [related, rest.filter((p) => lookStyle(p) === fam), rest.filter((p) => lookStyle(p) !== fam)];
  // a look shown in the last few windows waits its turn, unless nothing else is left
  const fresh = tiers.map((ps) => ps.filter((p) => !recent.includes(p.id)));
  const tier = fresh.find((ps) => ps.length) ?? tiers.find((ps) => ps.length);
  if (!tier) return null;
  return tier[Math.floor(roll() * tier.length)];
}

/** a window's box at frame size W×H, from its shape's dice */
function specOf(sh: Shape, W: number, H: number): Spec {
  const s = Math.min(W, H) / 1080;
  const frame: FrameKind = sh.f < 0.5 ? 'window' : sh.f < 0.75 ? 'card' : 'round';
  let aspect = ASPECTS[Math.floor(sh.aspect * ASPECTS.length)];
  const circle = frame === 'round' && sh.circle < 0.5;
  if (circle) aspect = 1;
  const U = Math.min(W, H) * (0.4 + sh.size * 0.08);
  let w = U * Math.sqrt(aspect);
  let h = U / Math.sqrt(aspect);
  const k = Math.min(1, (W * 0.42) / w, (H * 0.4) / h);
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
    barStyle: sh.bar < 0.5 ? 0 : 1,
  };
}

/**
 * Somewhere that keeps the middle of the picture clear, the cascade inside the frame, and other
 * windows mostly uncovered. (The words aren't known this far ahead: a window steps out of their way
 * when it shows, keepGlide in popups.ts.)
 */
function place(spec: Spec, W: number, H: number, open: WDealt[], roll: () => number): { x: number; y: number; dir: [number, number] } {
  const m = Math.min(W, H) * 0.04;
  const trail = spec.step * MAX_STAMPS;
  const mid = { x: W * 0.3, y: H * 0.3, w: W * 0.4, h: H * 0.4 };
  const overlap = (ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number) =>
    Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx)) * Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
  let best: { x: number; y: number; dir: [number, number]; cost: number } | null = null;
  for (let k = 0; k < 24; k++) {
    const x = m + roll() * Math.max(1, W - spec.w - 2 * m);
    const y = m + roll() * Math.max(1, H - spec.h - 2 * m);
    const dir: [number, number] = [x + spec.w / 2 < W / 2 ? -1 : 1, y + spec.h / 2 < H / 2 ? 1 : -1];
    // the box and its cascade together
    const fx = Math.min(x, x + dir[0] * trail);
    const fy = Math.min(y, y + dir[1] * trail);
    const fw = spec.w + trail;
    const fh = spec.h + trail;
    let cost = overlap(x, y, spec.w, spec.h, mid.x, mid.y, mid.w, mid.h) * 8 + overlap(fx, fy, fw, fh, mid.x, mid.y, mid.w, mid.h) * 2;
    cost += (fw * fh - overlap(fx, fy, fw, fh, 0, 0, W, H)) * 0.5;
    for (const o of open) {
      const os = o.spec;
      const ot = os.step * MAX_STAMPS;
      cost += overlap(x, y, spec.w, spec.h, o.x, o.y, os.w, os.h) * 3;
      // and keep the two cascades from piling into each other
      cost += overlap(fx, fy, fw, fh, Math.min(o.x, o.x + o.dir[0] * ot), Math.min(o.y, o.y + o.dir[1] * ot), os.w + ot, os.h + ot) * 1.5;
    }
    if (!best || cost < best.cost) best = { x, y, dir, cost };
  }
  return { x: Math.round(best!.x), y: Math.round(best!.y), dir: best!.dir };
}
