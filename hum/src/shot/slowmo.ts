/**
 * Smooth slow motion: a clip that runs slowly is shown at the moment its curve asks for, not at the
 * nearest source frame, so it glides instead of holding every frame and stepping.
 *
 *   frames      the source frames a clip has shown lately, copied off it as they come, each kept by the
 *               second it really starts at (which the browser says). Shared by every stage on a renderer.
 *   pair        the frame at or before the wanted second and the next one. A clip often holds the same
 *               picture for two or three frames (25 a second saved as 30, 24 as 60): the copies are spotted
 *               and the pair is the two different pictures either side, or the picture would stop and go.
 *   texture     the picture at a second: exactly the source frame on a source frame, else drawn between
 *               the two (flow.ts) at the clip's own shape
 *
 * In a render the clip is put on both frames first (settle), so the picture is a pure function of the
 * second asked for. Live, the player runs a little ahead of the picture (footage.ts, follow) so that the
 * later frame is there when it's wanted; until it is, the nearest frame there is stands in.
 */
import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../core/glsl';
import { LADDER, quality } from '../render/quality';
import { FlowPass, canFlow, type Pair } from './flow';
import type { Ahead, Footage } from './footage';
import { smooth } from './time';

/** the switch: off, slow clips step from frame to frame as they always did */
export const slowMotion = { on: true };

/** slower than this (against real time) a clip is smoothed */
export const SLOW = 0.9;
/** between these the picture eases from gliding to stepping, so going from one to the other is not seen */
const EASE: [number, number] = [0.8, SLOW];
/** the longest side a frame is kept at */
const MAX_SIDE = 1920;
/** frames kept, over all the clips on a renderer */
const KEPT = 12;
/** the longest gap between two frames that is still drawn across, s of clip */
const MAX_GAP = 0.16;
/** copies of a picture in a row before the clip counts as standing still */
const COPIES = 4;
/** the small picture two frames are compared on */
const SMALL_W = 96;
const SMALL_H = 54;
/** what nobody has used for this long is let go (ms) */
const IDLE = 15000;
/** the real time, also while a render has its own clock (render/timeline.ts) */
const now = performance.now.bind(performance);

/** 0: the picture glides between source frames, 1: it steps from one to the next as the clip itself does */
export const stepping = (rate: number) => smooth(EASE[0], EASE[1], rate);

const SMALL = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tMap;
uniform vec2 uStep;
void main() {
  vec3 c = vec3(0.0);
  for (int j = 0; j < 6; j++) for (int i = 0; i < 6; i++) c += texture2D(tMap, vUv + ((vec2(float(i), float(j)) + 0.5) / 6.0 - 0.5) * uStep).rgb;
  gl_FragColor = vec4(c / 36.0, 1.0);
}
`;

interface Frame {
  clip: number;
  /** the second of the clip it starts at, and how long it lasts */
  at: number;
  lasts: number;
  rt: THREE.WebGLRenderTarget;
  small: THREE.WebGLRenderTarget;
  /** the small picture's pixels, once read back */
  pixels: Uint8Array | null;
  reading: boolean;
  used: number;
  /** in use by a settle under way: not to be reused */
  held: number;
}

/** the two frames either side of a second; `end` is null when there is nothing to draw towards */
interface Span {
  start: Frame;
  end: Frame | null;
}

export class SlowMotion {
  private readonly flow: FlowPass;
  private readonly smallMat: THREE.ShaderMaterial;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mesh: THREE.Mesh;
  private frames: Frame[] = [];
  private clock = 0;
  private lastUse = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly able: boolean;
  /** clips whose frames could not be copied */
  private readonly bad = new Set<number>();
  /** what a render put ready: the frames either side of each second asked for lately */
  private readonly put = new Map<string, Span>();
  /** renders wait their turn on a player */
  private readonly turns = new Map<number, Promise<unknown>>();
  /** the pair coming up, to be worked out ahead of its turn */
  private next: Pair | null = null;
  /** the clips shown holding copies of their own pictures */
  private readonly copies = new Set<number>();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.able = canFlow(renderer);
    this.flow = new FlowPass(renderer);
    this.smallMat = new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VERT, fragmentShader: SMALL, uniforms: { tMap: { value: null }, uStep: { value: new THREE.Vector2(1 / SMALL_W, 1 / SMALL_H) } }, depthTest: false, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.smallMat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  /** can this clip be smoothed here? */
  works(f: Footage): boolean {
    return slowMotion.on && this.able && !this.bad.has(f.id) && f.duration > 0;
  }

  /* ───────── the frames ───────── */

  private of(clip: number): Frame[] {
    return this.frames.filter((x) => x.clip === clip && x.at >= 0).sort((x, y) => x.at - y.at);
  }

  private slot(w: number, h: number): Frame {
    const free = this.frames.filter((x) => !x.held);
    let s: Frame | undefined;
    if (this.frames.length >= KEPT && free.length) s = free.reduce((x, y) => (x.used < y.used ? x : y));
    if (s && (s.rt.width !== w || s.rt.height !== h)) {
      this.forget(s);
      s = undefined;
    }
    if (!s) {
      const target = (a: number, b: number) => new THREE.WebGLRenderTarget(a, b, { depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      s = { clip: 0, at: -1, lasts: 0, rt: target(w, h), small: target(SMALL_W, SMALL_H), pixels: null, reading: false, used: 0, held: 0 };
      this.frames.push(s);
    }
    return s;
  }

  private forget(s: Frame) {
    this.frames.splice(this.frames.indexOf(s), 1);
    s.at = -1;
    s.rt.dispose();
    s.small.dispose();
  }

  /** copy the frame the clip is showing, if it isn't kept yet; null when it can't be told which it is */
  private take(f: Footage): Frame | null {
    this.touch();
    for (let tries = 0; tries < 3; tries++) {
      const mark = f.mark();
      if (!mark) return null;
      const had = this.frames.find((x) => x.clip === f.id && Math.abs(x.at - mark.at) < 1e-3);
      if (had) {
        had.used = ++this.clock;
        return had;
      }
      const v = f.video;
      const k = Math.min(1, MAX_SIDE / Math.max(v.videoWidth, v.videoHeight, 1));
      const s = this.slot(Math.max(2, Math.round(v.videoWidth * k)), Math.max(2, Math.round(v.videoHeight * k)));
      const was = this.renderer.getRenderTarget();
      try {
        f.texture.needsUpdate = true;
        this.flow.copy(f.texture, s.rt);
      } catch {
        // a clip the browser won't let be read
        this.bad.add(f.id);
        this.renderer.setRenderTarget(was);
        this.forget(s);
        return null;
      }
      s.at = -1;
      s.pixels = null;
      s.reading = false;
      // the clip may have moved on between being asked and being copied
      const after = f.mark();
      if (!after || Math.abs(after.at - mark.at) > 1e-3) {
        this.renderer.setRenderTarget(was);
        continue;
      }
      this.smallMat.uniforms.tMap.value = s.rt.texture;
      this.mesh.material = this.smallMat;
      this.renderer.setRenderTarget(s.small);
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(was);
      s.clip = f.id;
      s.at = mark.at;
      s.lasts = mark.lasts;
      s.used = ++this.clock;
      return s;
    }
    return null;
  }

  /** read a frame's small picture back: at once in a render, in its own time live */
  private read(s: Frame, now: boolean) {
    if (s.pixels || (s.reading && !now)) return;
    const n = SMALL_W * SMALL_H * 4;
    if (now) {
      s.pixels = new Uint8Array(n);
      this.renderer.readRenderTargetPixels(s.small, 0, 0, SMALL_W, SMALL_H, s.pixels);
      return;
    }
    s.reading = true;
    const { clip, at } = s;
    const buf = new Uint8Array(n);
    this.renderer.readRenderTargetPixelsAsync(s.small, 0, 0, SMALL_W, SMALL_H, buf).then(
      () => {
        if (s.clip === clip && s.at === at && s.reading) s.pixels = buf;
      },
      () => undefined,
    );
  }

  /** do two frames show the same picture (one is a copy of the other)? */
  private same(a: Frame, b: Frame): boolean {
    if (!a.pixels || !b.pixels) return false;
    let some = 0;
    let most = 0;
    const n = SMALL_W * SMALL_H;
    for (let i = 0; i < n * 4; i += 4) {
      const d = Math.abs(a.pixels[i] - b.pixels[i]) * 0.3 + Math.abs(a.pixels[i + 1] - b.pixels[i + 1]) * 0.59 + Math.abs(a.pixels[i + 2] - b.pixels[i + 2]) * 0.11;
      if (d > 6) most++;
      if (d > 2.5) some++;
    }
    // a copy differs by a little coding noise; anything moving in the picture changes far more than this
    const copy = most < n * 0.001 && some < n * 0.006;
    if (copy) this.copies.add(a.clip);
    return copy;
  }

  /* ───────── a render: put the clip on both frames ───────── */

  /** the frame showing at second `t`, seeking the clip to it if it isn't kept */
  private async frameAt(f: Footage, t: number): Promise<Frame | null> {
    const had = this.of(f.id).find((x) => t >= x.at - 1e-4 && t < x.at + x.lasts - 1e-4);
    if (had && had.lasts > 0) {
      had.used = ++this.clock;
      this.read(had, true);
      return had;
    }
    if (!(await f.land(t))) return null;
    const got = this.take(f);
    if (got) this.read(got, true);
    return got;
  }

  /**
   * Put the clip on the frames either side of second `t` and keep them. False: it can't be done here
   * (draw the clip as it is). The same frames whichever way it is reached.
   */
  settle(f: Footage, t: number): Promise<boolean> {
    const before = this.turns.get(f.id) ?? Promise.resolve();
    const mine = before.then(() => this.find(f, t)).catch(() => false);
    this.turns.set(f.id, mine);
    return mine;
  }

  private async find(f: Footage, t: number): Promise<boolean> {
    if (!this.works(f)) return false;
    this.touch();
    const held: Frame[] = [];
    const hold = (x: Frame | null) => {
      if (x) {
        x.held++;
        held.push(x);
      }
      return x;
    };
    const at = Math.min(Math.max(0, t), Math.max(0, f.duration - 0.05));
    try {
      const here = hold(await this.frameAt(f, at));
      if (!here || here.at > at + 0.02 || at - here.at > 1) return false;
      // back to the first copy of this picture
      let start = here;
      let n = 1;
      while (n < COPIES && start.at > 0.004) {
        const b = hold(await this.frameAt(f, start.at - Math.min(0.004, start.lasts * 0.25)));
        if (!b || b.at >= start.at || !this.same(b, start)) break;
        start = b;
        n++;
      }
      // it has stood still for a while: only the last copy leads on
      if (n >= COPIES) start = here;
      // on to the first different one
      let end: Frame | null = null;
      let last = here;
      while (n < COPIES + 1) {
        const b = hold(await this.after(f, last));
        if (!b) break;
        if (!this.same(last, b)) {
          end = b;
          break;
        }
        last = b;
        n++;
      }
      if (end && end.at - start.at > MAX_GAP) end = null;
      this.put.set(this.placeOf(f, t), { start: end ? start : here, end });
      for (const k of [...this.put.keys()].slice(0, Math.max(0, this.put.size - 6))) this.put.delete(k);
      start.used = ++this.clock;
      if (end) end.used = ++this.clock;
      here.used = ++this.clock;
      return true;
    } finally {
      for (const x of held) x.held--;
    }
  }

  /** the frame after one, or null at the clip's end */
  private async after(f: Footage, x: Frame): Promise<Frame | null> {
    for (let k = 1; k < 5; k++) {
      const t = x.at + x.lasts * (k + 0.3);
      if (t >= f.duration) return null;
      const got = await this.frameAt(f, t);
      if (!got) return null;
      if (got.at > x.at + 1e-4) return got;
    }
    return null;
  }

  /* ───────── live ───────── */

  /** copy the clip's newest frame, when it has one (call it every drawn frame the clip is followed slowly) */
  watch(f: Footage) {
    if (!this.works(f) || !f.fresh || f.video.seeking) return;
    f.fresh = false;
    const got = this.take(f);
    if (got) this.read(got, false);
  }

  /** the frames kept either side of second `t`, whatever there is */
  private around(f: Footage, t: number): Span | null {
    const list = this.of(f.id);
    let i = -1;
    while (i + 1 < list.length && list[i + 1].at <= t + 1e-4) i++;
    if (i < 0) {
      // nothing before it: the first one just after, when it is near
      const first = list[0];
      return first && first.at - t < 0.1 ? { start: first, end: null } : null;
    }
    const here = list[i];
    let n = 1;
    let start = here;
    for (let b = i - 1; b >= 0 && n < COPIES && start.at - list[b].at < MAX_GAP && this.same(list[b], start); b--, n++) start = list[b];
    if (n >= COPIES) start = here;
    let j = i + 1;
    for (; j < list.length && n < COPIES + 1 && list[j].at - list[j - 1].at < MAX_GAP && this.same(list[j - 1], list[j]); j++) n++;
    const end = list[j] ?? null;
    if (end && end.at - start.at <= MAX_GAP) return { start, end };
    return t - here.at < Math.max(0.1, here.lasts * 1.5) ? { start: here, end: null } : null;
  }

  /**
   * How the player should run so that second `t` can be drawn (Footage.follow). A clip `waiting` for its
   * cut takes two pictures more, so the shot has something to glide on while the player gets going.
   */
  ahead(f: Footage, t: number, rate: number, slow: boolean, waiting = false): Ahead {
    const list = this.of(f.id);
    const here = list.find((x) => t >= x.at - 1e-4 && t < x.at + Math.max(x.lasts, 0.01) + 1e-3);
    const gap = here?.lasts || f.lasts;
    const span = this.around(f, t);
    const done = t > f.duration - gap * 1.5;
    const more: Frame[] = [];
    let full = true;
    // a frame the player went past without showing, between this one and the next kept
    let missing: number | null = null;
    if (here && span?.end) for (let i = list.indexOf(here); list[i] && list[i].at < span.end.at && missing === null; i++) if (list[i].lasts > 0 && list[i + 1].at - list[i].at > list[i].lasts * 1.6) missing = list[i].at + list[i].lasts * 1.3;
    for (let x = span?.end; waiting && x && more.length < 2 && x.at < f.duration - gap * 1.5; ) {
      x = this.around(f, x.at + 1e-3)?.end;
      if (x) more.push(x);
      else full = false;
    }
    // frames a clip is waiting on for its cut are kept while another clip's go by
    for (const x of [here, span?.start, span?.end, ...more]) if (x) x.used = ++this.clock;
    return {
      // the next frame, a picture held twice, and the time it takes to come, be copied and be worked out
      lead: done || !slow ? 0 : gap * (this.copies.has(f.id) ? 2.3 : 1.3) + 0.1 * Math.max(0, rate),
      begun: !!here,
      ready: done || (!!here && !!span?.end && full),
      missing,
    };
  }

  /** is second `t` one of the frames kept (the player is ahead of the picture still)? */
  holds(f: Footage, t: number): boolean {
    return this.of(f.id).some((x) => t >= x.at - 1e-4 && t < x.at + x.lasts + 1e-3);
  }

  /* ───────── the picture ───────── */

  /**
   * The clip at second `t`; `step` 0 to 1 eases it from gliding to stepping from frame to frame. Null:
   * draw the clip as it is. A render (not `live`) only has what was settled for this very second.
   */
  texture(f: Footage, t: number, step: number, live: boolean): THREE.Texture | null {
    if (!this.works(f)) return null;
    this.touch();
    const put = this.put.get(this.placeOf(f, t));
    const ready = put && put.start.clip === f.id && put.start.at >= 0 && (!put.end || put.end.at > put.start.at) ? put : null;
    const span = ready ?? (live ? this.around(f, t) : null);
    if (!span) return null;
    if (!span.end && !ready) {
      // only a frame near by: the clip itself, if that is nearer
      const off = Math.max(span.start.at - t, t - span.start.at - span.start.lasts);
      if (off > 0 && Math.abs(f.video.currentTime - t) < off) return null;
    }
    span.start.used = ++this.clock;
    if (!span.end) return span.start.rt.texture;
    span.end.used = ++this.clock;
    const k0 = Math.min(1, Math.max(0, (t - span.start.at) / (span.end.at - span.start.at)));
    const k = step >= 0.999 ? (k0 >= 1 ? 1 : 0) : Math.max(0, (k0 - step) / (1 - step));
    if (!ready) this.cue(f, span);
    if (k < 0.004) return span.start.rt.texture;
    if (k > 0.996) return span.end.rt.texture;
    const lowest = !quality.isFrozen && quality.current() === LADDER[LADDER.length - 1];
    return this.flow.between(this.pairOf(span.start, span.end), k, lowest);
  }

  private placeOf(f: Footage, t: number): string {
    return `${f.id}|${t.toFixed(6)}`;
  }

  private pairOf(a: Frame, b: Frame): Pair {
    return { key: `${a.clip}|${a.at.toFixed(5)}|${b.at.toFixed(5)}`, a: a.rt.texture, b: b.rt.texture, w: a.rt.width, h: a.rt.height, fast: a.lasts > 0 && a.lasts < 1 / 45 };
  }

  /** the pair after this one, to be worked out before its turn comes */
  private cue(f: Footage, span: Span) {
    if (!span.end) return;
    const after = this.around(f, span.end.at + 1e-3);
    this.next = after?.end && after.start === span.end ? this.pairOf(after.start, after.end) : null;
  }

  /** a clip waiting for its cut: have the pair it opens on worked out */
  opening(f: Footage, t: number) {
    const span = this.around(f, t);
    if (span?.end && !this.next) this.next = this.pairOf(span.start, span.end);
  }

  /** a piece of the work coming up (once a drawn frame, live) */
  work() {
    const p = this.next;
    this.next = null;
    if (p && slowMotion.on && quality.current() !== LADDER[LADDER.length - 1]) this.flow.ahead(p);
  }

  /* ───────── keeping and letting go ───────── */

  private touch() {
    this.lastUse = now();
    this.timer ??= setInterval(() => {
      if (now() - this.lastUse > IDLE && !this.frames.some((x) => x.held)) this.free();
    }, IDLE / 2);
  }

  /** let every frame and target go (the shaders stay compiled) */
  free() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const s of [...this.frames]) this.forget(s);
    this.put.clear();
    this.next = null;
    this.flow.free();
  }

  /** draw every material once (compiles them ahead of the first slow shot), on tiny frames */
  warm(tex: THREE.Texture) {
    if (!this.able) return;
    const was = this.renderer.getRenderTarget();
    const a = new THREE.WebGLRenderTarget(32, 18, { depthBuffer: false });
    this.flow.copy(tex, a);
    this.smallMat.uniforms.tMap.value = a.texture;
    this.mesh.material = this.smallMat;
    this.renderer.setRenderTarget(a);
    this.renderer.render(this.scene, this.camera);
    this.flow.between({ key: 'warm', a: a.texture, b: a.texture, w: 32, h: 18, fast: false }, 0.5);
    this.renderer.setRenderTarget(was);
    a.dispose();
    this.flow.free();
  }
}

/* ───────── one per renderer ───────── */

const made = new WeakMap<THREE.WebGLRenderer, { slow: SlowMotion; users: number }>();

/** the renderer's slow motion (its shaders live as long as the renderer does) */
export function slowMotionOf(renderer: THREE.WebGLRenderer): SlowMotion {
  let e = made.get(renderer);
  if (!e) made.set(renderer, (e = { slow: new SlowMotion(renderer), users: 0 }));
  return e.slow;
}

/** a stage begins (1) or stops (-1) using it: the last one out lets the frames go */
export function slowMotionUsers(renderer: THREE.WebGLRenderer, by: 1 | -1) {
  slowMotionOf(renderer);
  const e = made.get(renderer)!;
  e.users = Math.max(0, e.users + by);
  if (!e.users) e.slow.free();
}
