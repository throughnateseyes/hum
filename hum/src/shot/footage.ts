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
import type { Bed } from './kit';
import type { Scheme } from './palette';

export class Footage {
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
  }

  /** settles once the clip has opened (or failed to) */
  whenLoaded: Promise<void> = Promise.resolve();

  load(src: string): Promise<void> {
    this.whenLoaded = this.open(src);
    return this.whenLoaded;
  }

  /** let go of the clip and its texture */
  close() {
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.texture.dispose();
    this.duration = 0;
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
   * speed and is nudged when it drifts; a real jump (the cut on the hit) seeks.
   */
  follow(target: number, rate: number, playing: boolean, who = 0) {
    const v = this.video;
    if (!this.duration || !this.mine(who)) return;
    const off = target - v.currentTime;
    if (!playing || rate < 0.07) {
      if (!v.paused) v.pause();
      if (Math.abs(off) > 1 / 50 && !v.seeking) v.currentTime = target;
      return;
    }
    // a real jump: seek, aiming a little ahead so the clip lands where the curve will be by then
    if (Math.abs(off) > 0.45 && !v.seeking) v.currentTime = target + rate * 0.08;
    v.playbackRate = Math.min(8, Math.max(0.0625, rate * (1 + Math.max(-0.35, Math.min(0.35, off * 2)))));
    if (v.paused) void v.play().catch(() => {});
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
  seek(target: number): Promise<void> {
    const v = this.video;
    if (!this.duration) return Promise.resolve();
    v.pause();
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

// one region: the clip inside its box, pushed in on the focus, smeared by speed, printed in its tone
vec3 region(vec4 box, float zoom, float mode) {
  bool plain = mode > 3.5 && mode < 6.5;
  if (plain && uTreat > 0.999) return solid(mode);
  vec2 local = (vUv - box.xy) / box.zw;
  float aspect = uAspect * box.z / box.w;
  vec2 f = clamp((uFocus - box.xy) / box.zw, 0.0, 1.0);
  vec2 uv = f + (local - f) / (zoom * (1.0 + uPunch));
  vec3 col = vec3(0.0);
  float j = hash(gl_FragCoord.xy);
  for (int i = 0; i < 10; i++) {
    float s = (float(i) + j) / 10.0;
    col += footage(f + (uv - f) * (1.0 - uBlur * 0.24 * s) - 0.5, aspect);
  }
  col /= 10.0;
  if (mode < 0.5) return col;
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
  if (w0 > 0.002) { gSrc = uSrc.x; col += region(uRect0, uZoom.x, uTone.x) * w0; }
  if (wa > 0.002) { gSrc = uSrc.y; col += region(uRect1, uZoom.y, uTone.y) * wa; }
  if (wb > 0.002) { gSrc = uSrc.z; col += region(uRect2, uZoom.z, uTone.z) * wb; }
  col /= max(0.001, w0 + wa + wb);
  gl_FragColor = vec4(mix(col, uPaper, uFlash), 1.0);
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
  render(renderer: THREE.WebGLRenderer, w: number, h: number, focus: { x: number; y: number }, s: FootageState, bed: Bed, mask: THREE.Texture | null) {
    const u = this.material.uniforms;
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