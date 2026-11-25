/**
 * The footage bed of a shot.
 *
 *   Footage      one video clip, kept on whichever second the shot's time curve asks for
 *   FootagePass  draws it: cropped to fit, pushed in, smeared by speed, and printed in the shot's
 *                colours. The frame has up to three regions (the frame itself, and the red and green
 *                of a mask a style draws), each with its own box, push-in and tone, so a style can show
 *                the clip clean inside a word and flat outside it, or as three panels at three crops.
 */
import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../core/glsl';
import { FrameSource } from './frameSource';
import type { Bed } from './kit';
import type { Scheme } from './palette';

/** which source frame a clip is showing: the second it starts at, and how long it lasts (s) */
export interface FrameMark {
  at: number;
  lasts: number;
}

/** how far ahead of the picture a clip shown in slow motion has to run (slowmo.ts) */
export interface Ahead {
  /** seconds of clip */
  lead: number;
  /** the frame on screen is kept already */
  begun: boolean;
  /** and so is the one after it */
  ready: boolean;
  /** the second of a frame it went past without showing, when the picture needs it */
  missing: number | null;
}

let made = 0;

export class Footage {
  /** tells its frames from another player's */
  readonly id = ++made;
  /** a new frame has come on screen since this was last cleared */
  fresh = true;
  /** how long one frame lasts, as last seen (s) */
  lasts = 1 / 30;
  private shown = -1;
  private shownGap = 0;
  private frameCall = 0;
  readonly video: HTMLVideoElement;
  readonly texture: THREE.VideoTexture;
  duration = 0;
  aspect = 16 / 9;

  constructor() {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    this.video = v;
    this.texture = new THREE.VideoTexture(v);
    this.texture.colorSpace = THREE.NoColorSpace;
    this.listen();
  }

  /** hear about each frame as it comes on screen, and which one it is */
  private listen() {
    const v = this.video;
    if (!('requestVideoFrameCallback' in v)) return;
    this.frameCall = v.requestVideoFrameCallback((_now, meta) => {
      this.fresh = true;
      const gap = meta.mediaTime - this.shown;
      if (gap > 0.004 && gap < 0.1) this.shownGap = this.shownGap ? Math.min(this.shownGap, gap) : gap;
      this.shown = meta.mediaTime;
      this.listen();
    });
  }

  /**
   * Which source frame the clip is showing right now. The browser's own word for it where it has one
   * (a VideoFrame carries its time), else the last frame it announced; null when there is no telling.
   */
  mark(): FrameMark | null {
    const v = this.video;
    if (this.picture) {
      this.lasts = this.picture.lasts;
      return { at: this.picture.at, lasts: this.picture.lasts };
    }
    if (v.readyState < 2) return null;
    let at = this.shown;
    let lasts = this.shownGap;
    if (typeof VideoFrame !== 'undefined') {
      try {
        const frame = new VideoFrame(v);
        at = frame.timestamp / 1e6;
        lasts = (frame.duration ?? 0) / 1e6 || lasts;
        frame.close();
      } catch {
        /* not this clip, or not yet: what was announced will do */
      }
    }
    if (at < 0 || Math.abs(at - v.currentTime) > 0.6) return null;
    if (lasts < 1 / 250 || lasts > 0.5) lasts = this.lasts;
    this.lasts = lasts;
    return { at, lasts };
  }

  /** settles once the clip has opened (or failed to) */
  whenLoaded: Promise<void> = Promise.resolve();

  load(src: string, file?: Blob): Promise<void> {
    this.file = file ?? null;
    this.whenLoaded = this.open(src);
    return this.whenLoaded;
  }

  /* ───────── frame by frame (a render) ───────── */

  private file: Blob | null = null;
  /** the clip decoded in order, when it gives what the player would; null: not (yet), the player is put on each second */
  private frames: FrameSource | null = null;
  private stepped = false;
  private opening: Promise<void> | null = null;
  /** it is being found out */
  private asking = false;
  /** the decoded picture being shown, and which one it is */
  private picture: (FrameMark & { frame: VideoFrame; second: number }) | null = null;

  /** a render asks for this clip frame by frame from here on: have it decoded in order, if that gives the very same pictures */
  byFrame() {
    this.stepped = true;
  }

  /** (found out when the clip is first asked for: one that isn't on screen costs nothing) */
  private ready(): Promise<void> {
    if (this.opening) return this.opening;
    this.asking = true;
    this.opening = this.ask()
      .catch(() => undefined)
      .finally(() => (this.asking = false));
    return this.opening;
  }

  private async ask() {
    await this.whenLoaded.catch(() => undefined);
    if (!this.file || !this.duration) return;
    const src = await FrameSource.open(this.file);
    if (!src) return;
    const v = this.video;
    const ok = await src.proves({ duration: this.duration, show: async (t) => ((await this.put(t)) ? new VideoFrame(v) : null) });
    if (ok && this.duration) this.frames = src;
    else src.close();
  }

  /** the second of the clip on screen: of a render's decoded picture, else the player's */
  get now(): number {
    return this.picture ? this.picture.second : this.video.currentTime;
  }

  /** show the decoded picture of a second; false when the player has to */
  private async decoded(second: number): Promise<boolean> {
    await this.ready();
    if (!this.frames) return false;
    try {
      const frame = await this.frames.at(second);
      if (!this.frames) {
        frame.close();
        return false;
      }
      const was = this.picture;
      this.picture = { frame, second, at: frame.timestamp / 1e6, lasts: (frame.duration ?? 0) / 1e6 || this.lasts };
      this.texture.image = this.picture.frame as unknown as HTMLVideoElement;
      this.texture.needsUpdate = true;
      this.fresh = true;
      was?.frame.close();
      return true;
    } catch (err) {
      if (this.duration) console.warn('[hum] a clip could not be decoded in order; it is seeked instead', err);
      this.unframe();
      return false;
    }
  }

  /** back to the player */
  private unframe() {
    this.frames?.close();
    this.frames = null;
    this.texture.image = this.video;
    this.texture.needsUpdate = true;
    this.picture?.frame.close();
    this.picture = null;
  }

  /** put the player on a second and wait for the frame; false if it didn't come */
  private put(t: number): Promise<boolean> {
    const v = this.video;
    v.pause();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        v.removeEventListener('seeked', done);
        resolve(false);
      }, 1500);
      v.addEventListener('seeked', done, { once: true });
      v.currentTime = t;
    });
  }

  /** let go of the clip and its texture */
  close() {
    if (this.frameCall) this.video.cancelVideoFrameCallback(this.frameCall);
    this.frameCall = 0;
    this.duration = 0;
    this.unframe();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.texture.dispose();
  }

  private open(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const v = this.video;
      const done = () => {
        this.duration = v.duration;
        this.aspect = v.videoWidth / Math.max(1, v.videoHeight);
        resolve();
      };
      v.addEventListener('loadeddata', done, { once: true });
      v.addEventListener('error', () => reject(new Error('That clip could not be opened.')), { once: true });
      v.src = src;
      v.load();
    });
  }

  /** who last steered the clip live, and when (performance.now) */
  private boss = 0;
  private bossAt = -1e9;

  /**
   * One player can be shared by two pictures of the same look on one renderer (the outgoing and the
   * incoming look of a transition). The newer one (the larger `who`) steers it; an older one only gets
   * it back once the newer one has stopped asking for a quarter of a second.
   */
  private mine(who: number): boolean {
    const now = performance.now();
    if (who >= this.boss || now - this.bossAt > 250) {
      this.boss = who;
      this.bossAt = now;
      return true;
    }
    return false;
  }

  /**
   * Live: keep the clip on `target` (clip seconds) while the shot plays. The clip runs at the curve's
   * speed and is nudged when it drifts; a real jump (the cut on the hit, or `snap`: the clip's motion
   * jumped, however short the jump) seeks. A clip running backwards (rate below zero) can't play, so
   * it is put on each frame's second in turn.
   *
   * In slow motion (`ahead`) the picture is drawn from frames kept as the clip showed them, so the clip
   * itself runs a little ahead and how evenly it runs is not seen: it plays up to where it is wanted and
   * waits there, and never has to seek to creep along. Paused, it plays on just until the frame after
   * the one on screen is in.
   */
  follow(target: number, rate: number, playing: boolean, who = 0, snap = false, ahead: Ahead | null = null) {
    const v = this.video;
    if (!this.duration || !this.mine(who)) return;
    // (a look's warm-up draw in a render: the next frame it is shown on puts the clip where it belongs)
    if (this.frames || this.asking) return;
    if (ahead) {
      this.run(target, rate, playing, ahead);
      return;
    }
    const off = target - v.currentTime;
    if (!playing || rate < 0.07) {
      if (!v.paused) v.pause();
      if (Math.abs(off) > 1 / 50 && !v.seeking) v.currentTime = target;
      return;
    }
    // a real jump: seek, aiming a little ahead so the clip lands where the curve will be by then
    if ((Math.abs(off) > 0.45 || (snap && Math.abs(off) > 1 / 30)) && !v.seeking) v.currentTime = target + rate * (snap ? 0.04 : 0.08);
    v.playbackRate = Math.min(8, Math.max(0.0625, rate * (1 + Math.max(-0.35, Math.min(0.35, off * 2)))));
    if (v.paused) void v.play().catch(() => {});
  }

  /** the second a frame that was missed was last fetched from */
  private fetched = -1;

  private run(want: number, rate: number, playing: boolean, ahead: Ahead) {
    const v = this.video;
    const target = Math.min(want, Math.max(0, this.duration - 0.05));
    const play = (speed: number) => {
      v.playbackRate = Math.min(8, Math.max(0.0625, speed));
      if (v.paused) void v.play().catch(() => {});
    };
    const off = target + ahead.lead - v.currentTime;
    const away = Math.abs(target - v.currentTime);
    if (!playing) {
      const past = v.currentTime - target;
      // it went past a frame the picture needs: back to that one, once
      if (ahead.missing !== null && this.fetched !== ahead.missing && !v.seeking) {
        this.fetched = ahead.missing;
        if (!v.paused) v.pause();
        v.currentTime = ahead.missing;
        return;
      }
      if (v.seeking) return;
      if (ahead.ready && past > -1 / 50) {
        if (!v.paused) v.pause();
      } else if (ahead.begun && past > -1 / 50 && past < 0.35) play(0.5);
      else {
        if (!v.paused) v.pause();
        if (away > 1 / 50) {
          v.currentTime = target;
          this.fetched = -1;
        }
      }
      return;
    }
    this.fetched = -1;
    if (away > 0.45 && !v.seeking) v.currentTime = target + rate * 0.02;
    // how far off it is closes in about a fifth of a second; well ahead, it waits
    const speed = rate + off * 5;
    if (v.paused ? off > 0.004 || speed > 0.15 : speed > 0.0625 || off > -0.03) play(speed);
    else if (!v.paused) v.pause();
  }

  /** put the clip on the frame showing at a second and wait for it; false if it didn't come */
  async land(target: number): Promise<boolean> {
    const v = this.video;
    if (!this.duration) return false;
    v.pause();
    const want = Math.min(Math.max(0, target), Math.max(0, this.duration - 0.001));
    if (this.stepped) {
      if (this.picture && Math.abs(this.picture.second - want) < 1e-6) return true;
      if (await this.decoded(want)) return true;
      if (!this.duration) return false;
    }
    const word = typeof VideoFrame === 'undefined' && 'requestVideoFrameCallback' in v;
    if (Math.abs(v.currentTime - want) < 1e-6 && !v.seeking) return true;
    const announced = word ? new Promise<void>((r) => v.requestVideoFrameCallback(() => r())) : null;
    const came = await new Promise<boolean>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        v.removeEventListener('seeked', done);
        resolve(false);
      }, 1500);
      v.addEventListener('seeked', done, { once: true });
      v.currentTime = want;
    });
    // without a frame's own time the picture follows the seek by a moment, and says so
    if (came && announced) await Promise.race([announced, new Promise<void>((r) => setTimeout(r, 120))]);
    this.fresh = true;
    this.texture.needsUpdate = true;
    return came;
  }

  /**
   * Live: the clip is off screen. It stops where it is, so the next shot on it carries on from there
   * (and an idle clip doesn't keep decoding). Left alone while a newer picture steers it.
   */
  rest(who = 0) {
    if (this.video.paused || (who < this.boss && performance.now() - this.bossAt <= 250)) return;
    this.video.pause();
  }

  /** Stills: put the clip on exactly this second and wait for the frame */
  async seek(target: number): Promise<void> {
    const v = this.video;
    if (!this.duration) return;
    v.pause();
    if (this.stepped) {
      // (a millisecond off what is on screen already is the same picture, as it is for the player below)
      if (this.picture && Math.abs(this.picture.second - target) < 1e-3) return;
      if (await this.decoded(Math.min(Math.max(0, target), Math.max(0, this.duration - 0.05)))) return;
      if (!this.duration) return;
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.texture.needsUpdate = true;
        resolve();
      };
      if (Math.abs(v.currentTime - target) < 1e-3 && !v.seeking) return finish();
      v.addEventListener('seeked', finish, { once: true });
      v.currentTime = Math.min(Math.max(0, target), Math.max(0, this.duration - 0.05));
      setTimeout(finish, 1500);
    });
  }
}

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tFootage;
uniform sampler2D tMask;
uniform float uHasMask;
uniform float uFootageAspect, uAspect;
uniform sampler2D tAlt;
uniform float uAltAspect;
uniform vec3 uSrc;
uniform vec4 uRect0, uRect1, uRect2;
uniform vec3 uZoom, uTone;
uniform vec3 uInk, uPaper, uAccent, uMid;
uniform vec2 uCuts;
uniform vec2 uFocus, uTexel;
uniform float uTreat, uBlur, uPunch, uFlash, uFlip;
// a treated shot: the bed goes to the treatment with alpha saying where the picture shows (uAlphaOut),
// and the treatments that recolour the picture themselves want it unprinted (uRaw)
uniform float uAlphaOut, uRaw;
// the shot's framing: the part's push-in, and a still's slow drift and push (uv, and a scale)
uniform float uZoomAll, uGrow;
uniform vec2 uDrift;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// which clip the region being drawn shows: 0 the shot's own, 1 the second one (Split)
float gSrc = 0.0;

// the clip cropped to fill a box of this aspect; p is -0.5..0.5 across the box
vec3 footage(vec2 p, float aspect) {
  float fa = gSrc > 0.5 ? uAltAspect : uFootageAspect;
  if (aspect > fa) p.y *= fa / aspect;
  else p.x *= aspect / fa;
  p.x = mix(p.x, -p.x, uFlip * (1.0 - gSrc));
  vec2 uv = clamp(p + 0.5, 0.001, 0.999);
  return gSrc > 0.5 ? texture2D(tAlt, uv).rgb : texture2D(tFootage, uv).rgb;
}

// a hard edge between two levels, as soft as one pixel
float cut(float l, float at) {
  float w = max(fwidth(l), 0.004);
  return smoothstep(at - w, at + w, l);
}

vec3 solid(float mode) {
  return mode < 4.5 ? uPaper : mode < 5.5 ? uInk : uAccent;
}

// 1 where a region shows the picture, 0 where it is a flat field (once the shot has taken its colours)
float isPicture(float mode) {
  return (mode > 3.5 && mode < 6.5) ? 1.0 - uTreat : 1.0;
}

// one region: the clip inside its box, pushed in on the focus, smeared by speed, printed in its tone
vec3 region(vec4 box, float zoom, float mode) {
  bool plain = mode > 3.5 && mode < 6.5;
  if (plain && uTreat > 0.999) return solid(mode);
  vec2 local = (vUv - box.xy) / box.zw;
  float aspect = uAspect * box.z / box.w;
  vec2 f = clamp((uFocus - box.xy) / box.zw, 0.0, 1.0);
  vec2 uv = f + (local - f) / (zoom * uZoomAll * uGrow * (1.0 + uPunch)) + uDrift;
  vec3 col = vec3(0.0);
  float j = hash(gl_FragCoord.xy);
  // the smear takes ten taps; a still shot (most of every shot) needs one
  float taps = uBlur > 0.01 ? 10.0 : 1.0;
  for (int i = 0; i < 10; i++) {
    if (float(i) >= taps) break;
    float s = (float(i) + j) / 10.0;
    col += footage(f + (uv - f) * (1.0 - uBlur * 0.24 * s) - 0.5, aspect);
  }
  col /= taps;
  if (mode < 0.5) return col;
  if (uRaw > 0.5 && !plain) return col;
  if (plain) return mix(col, solid(mode), uTreat);
  // brightness, read a little soft so flat bands have clean edges instead of speckle
  vec2 tx = uTexel / (zoom * box.zw);
  vec3 soft = col * 0.4;
  soft += footage(uv + tx * vec2(1.6, 0.7) - 0.5, aspect) * 0.15 + footage(uv + tx * vec2(-1.6, -0.7) - 0.5, aspect) * 0.15;
  soft += footage(uv + tx * vec2(-0.7, 1.6) - 0.5, aspect) * 0.15 + footage(uv + tx * vec2(0.7, -1.6) - 0.5, aspect) * 0.15;
  float l = luma(mix(soft, col, uBlur));
  // spread the clip's own range over the print, so a dim clip and a bright one both use all of it
  float lo = uCuts.x * 0.5;
  float hi = uCuts.y + (1.0 - uCuts.y) * 0.5;
  float k = smoothstep(0.0, 1.0, clamp((l - lo) / max(0.05, hi - lo), 0.0, 1.0));
  vec3 toned;
  if (mode < 1.5) toned = mix(uInk, uPaper, k);
  else if (mode < 2.5) toned = mix(uInk, uAccent, k);
  else if (mode < 3.5) toned = mix(mix(uInk, uMid, cut(l, uCuts.x)), uPaper, cut(l, uCuts.y));
  else toned = mix(uInk, uPaper, cut(l, (uCuts.x + uCuts.y) * 0.5));
  return mix(col, toned, uTreat);
}

void main() {
  vec2 m = uHasMask > 0.5 ? texture2D(tMask, vUv).rg : vec2(0.0);
  float wa = m.r;
  float wb = m.g;
  float w0 = clamp(1.0 - wa - wb, 0.0, 1.0);
  vec3 col = vec3(0.0);
  // how much of this pixel is picture (not a flat field the style laid), for a treatment
  float pic = 0.0;
  if (w0 > 0.002) { gSrc = uSrc.x; col += region(uRect0, uZoom.x, uTone.x) * w0; pic += isPicture(uTone.x) * w0; }
  if (wa > 0.002) { gSrc = uSrc.y; col += region(uRect1, uZoom.y, uTone.y) * wa; pic += isPicture(uTone.y) * wa; }
  if (wb > 0.002) { gSrc = uSrc.z; col += region(uRect2, uZoom.z, uTone.z) * wb; pic += isPicture(uTone.z) * wb; }
  float sum = max(0.001, w0 + wa + wb);
  col /= sum;
  gl_FragColor = vec4(mix(col, uPaper, uFlash), uAlphaOut > 0.5 ? pic / sum : 1.0);
}
`;

export interface FootageState {
  /** 0 clean footage … 1 every region fully in its tone */
  treat: number;
  /** 0..1 smear from speed */
  blur: number;
  /** push-in, as a fraction of the frame */
  punch: number;
  /** 0..1 white-out (to the paper) */
  flash: number;
  flip: boolean;
  /** a still's slow push (1: none) and drift (uv) */
  grow: number;
  drift: [number, number];
}

/** how the bed is drawn: the part's push-in, and for a treated shot alpha and an unprinted picture */
export interface BedOptions {
  zoom: number;
  alpha: boolean;
  raw: boolean;
}

export class FootagePass {
  private readonly material: THREE.ShaderMaterial;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tFootage: { value: null },
        tMask: { value: null },
        uHasMask: { value: 0 },
        uFootageAspect: { value: 16 / 9 },
        tAlt: { value: null },
        uAltAspect: { value: 16 / 9 },
        uSrc: { value: new THREE.Vector3(0, 0, 0) },
        uAspect: { value: 16 / 9 },
        uRect0: { value: new THREE.Vector4(0, 0, 1, 1) },
        uRect1: { value: new THREE.Vector4(0, 0, 1, 1) },
        uRect2: { value: new THREE.Vector4(0, 0, 1, 1) },
        uZoom: { value: new THREE.Vector3(1, 1, 1) },
        uTone: { value: new THREE.Vector3(0, 0, 0) },
        uInk: { value: new THREE.Color('#111111') },
        uPaper: { value: new THREE.Color('#ffffff') },
        uAccent: { value: new THREE.Color('#ff4d1f') },
        uMid: { value: new THREE.Color('#888888') },
        uCuts: { value: new THREE.Vector2(0.33, 0.66) },
        uFocus: { value: new THREE.Vector2(0.5, 0.5) },
        uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
        uTreat: { value: 0 },
        uBlur: { value: 0 },
        uPunch: { value: 0 },
        uFlash: { value: 0 },
        uFlip: { value: 0 },
        uAlphaOut: { value: 0 },
        uRaw: { value: 0 },
        uZoomAll: { value: 1 },
        uGrow: { value: 1 },
        uDrift: { value: new THREE.Vector2(0, 0) },
      },
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  setSource(texture: THREE.Texture, aspect: number) {
    this.material.uniforms.tFootage.value = texture;
    this.material.uniforms.uFootageAspect.value = aspect;
  }

  /** the second clip some regions show (Split); null: every region shows the shot's own clip */
  setAlt(texture: THREE.Texture | null, aspect: number) {
    this.material.uniforms.tAlt.value = texture;
    this.material.uniforms.uAltAspect.value = aspect;
  }

  setScheme(s: Scheme) {
    const u = this.material.uniforms;
    (u.uInk.value as THREE.Color).set(s.ink);
    (u.uPaper.value as THREE.Color).set(s.paper);
    (u.uAccent.value as THREE.Color).set(s.accent);
    (u.uMid.value as THREE.Color).set(s.mid);
    (u.uCuts.value as THREE.Vector2).set(s.cuts[0], s.cuts[1]);
  }

  /** `focus` is 0..1 from the bottom-left: the point the picture pushes in on. `mask` holds the style's windows, if any. */
  render(renderer: THREE.WebGLRenderer, w: number, h: number, focus: { x: number; y: number }, s: FootageState, bed: Bed, mask: THREE.Texture | null, o: BedOptions = { zoom: 1, alpha: false, raw: false }) {
    const u = this.material.uniforms;
    u.uZoomAll.value = o.zoom;
    u.uAlphaOut.value = o.alpha ? 1 : 0;
    u.uRaw.value = o.raw ? 1 : 0;
    u.uGrow.value = s.grow;
    (u.uDrift.value as THREE.Vector2).set(s.drift[0], s.drift[1]);
    u.tMask.value = mask;
    u.uHasMask.value = mask ? 1 : 0;
    u.uAspect.value = w / h;
    (u.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    (u.uFocus.value as THREE.Vector2).set(focus.x, focus.y);
    (u.uRect0.value as THREE.Vector4).copy(bed.rect[0]);
    (u.uRect1.value as THREE.Vector4).copy(bed.rect[1]);
    (u.uRect2.value as THREE.Vector4).copy(bed.rect[2]);
    (u.uZoom.value as THREE.Vector3).set(bed.zoom[0], bed.zoom[1], bed.zoom[2]);
    (u.uTone.value as THREE.Vector3).set(bed.tone[0], bed.tone[1], bed.tone[2]);
    const alt = u.tAlt.value ? 1 : 0;
    (u.uSrc.value as THREE.Vector3).set(bed.src[0] * alt, bed.src[1] * alt, bed.src[2] * alt);
    u.uTreat.value = s.treat;
    u.uBlur.value = s.blur;
    u.uPunch.value = s.punch;
    u.uFlash.value = s.flash;
    u.uFlip.value = s.flip ? 1 : 0;
    renderer.render(this.scene, this.camera);
  }
}