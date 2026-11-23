/**
 * The footage bed of a shot (prototype, see src/dev/shot.ts).
 *
 *   Footage      one video clip, kept on whichever second the shot's time curve asks for
 *   FootagePass  draws it full frame: cropped to fit, pushed in, blurred by speed, and with bands of
 *                its brightness swapped for the shot's flat colours
 */
import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../core/glsl';
import type { ShotPalette } from './palette';
import { RAMP_BEATS, clamp01, easeInCubic, easeOutCubic, smooth, type ShotScore, type TimeCurve } from './time';

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

  load(src: string): Promise<void> {
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

  /**
   * Live: keep the clip on `target` (clip seconds) while the shot plays. The clip runs at the curve's
   * speed and is nudged when it drifts; a real jump (the cut on the hit) seeks.
   */
  follow(target: number, rate: number, playing: boolean) {
    const v = this.video;
    if (!this.duration) return;
    const off = target - v.currentTime;
    if (!playing || rate < 0.07) {
      if (!v.paused) v.pause();
      if (Math.abs(off) > 1 / 50 && !v.seeking) v.currentTime = target;
      return;
    }
    if (Math.abs(off) > 0.3 && !v.seeking) v.currentTime = target;
    v.playbackRate = Math.min(8, Math.max(0.0625, rate * (1 + Math.max(-0.35, Math.min(0.35, off * 2)))));
    if (v.paused) void v.play().catch(() => {});
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
uniform float uFootageAspect, uAspect;
uniform vec3 uFlats[5];
uniform float uKeep[5];
uniform float uCuts[4];
uniform vec3 uPaper;
uniform vec2 uFocus, uTexel;
uniform float uTreat, uShift, uBlur, uPunch, uFlash, uFlip;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

// crop the clip to fill the frame
vec3 footage(vec2 uv) {
  vec2 p = uv - 0.5;
  if (uAspect > uFootageAspect) p.y *= uFootageAspect / uAspect;
  else p.x *= uAspect / uFootageAspect;
  p.x = mix(p.x, -p.x, uFlip);
  return texture2D(tFootage, p + 0.5).rgb;
}

vec3 flatAt(float band) {
  int i = int(mod(band, 5.0));
  return uFlats[i];
}

// where this brightness sits in the clip's five bands: 0..5, the whole number is the band
float bandPos(float l) {
  float band = 0.0;
  float lo = 0.0;
  float hi = uCuts[0];
  for (int i = 0; i < 4; i++) {
    if (l >= uCuts[i]) {
      band = float(i + 1);
      lo = uCuts[i];
      hi = i < 3 ? uCuts[i + 1] : 1.0;
    }
  }
  return band + clamp((l - lo) / max(0.0001, hi - lo), 0.0, 0.999);
}

void main() {
  vec2 uv = uFocus + (vUv - uFocus) / (1.0 + uPunch);

  // speed: smear the picture toward the point it is rushing at
  vec3 col = vec3(0.0);
  float j = hash(gl_FragCoord.xy);
  for (int i = 0; i < 14; i++) {
    float s = (float(i) + j) / 14.0;
    col += footage(uFocus + (uv - uFocus) * (1.0 - uBlur * 0.24 * s));
  }
  col /= 14.0;

  // brightness, read a little soft so the bands have clean edges instead of speckle
  vec3 soft = col * 0.4;
  soft += footage(uv + uTexel * vec2(1.6, 0.7)) * 0.15 + footage(uv + uTexel * vec2(-1.6, -0.7)) * 0.15;
  soft += footage(uv + uTexel * vec2(-0.7, 1.6)) * 0.15 + footage(uv + uTexel * vec2(0.7, -1.6)) * 0.15;
  float l = dot(mix(soft, col, uBlur), vec3(0.2126, 0.7152, 0.0722));

  // five bands, shadows to highlights. Each is either left as footage or swapped for a flat colour;
  // uShift walks the colours round the bands (on the beat)
  float x = bandPos(l);
  float band = floor(x);
  float edge = smoothstep(1.0 - fwidth(x) * 1.2, 1.0, fract(x));
  float next = min(band + 1.0, 4.0);
  float sh = floor(uShift);
  float sf = fract(uShift);
  vec3 a = mix(flatAt(band + sh), flatAt(band + sh + 1.0), sf);
  vec3 b = mix(flatAt(next + sh), flatAt(next + sh + 1.0), sf);
  // the brightest band goes to paper: skies and glare open up into white
  a = mix(a, uPaper, step(3.5, band) * 0.85);
  b = mix(b, uPaper, step(3.5, next) * 0.85);
  vec3 flatCol = mix(a, b, edge);
  float keep = mix(uKeep[int(band)], uKeep[int(next)], edge);

  vec3 photo = mix(col, vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), 0.12) * 1.03 + 0.015;
  vec3 outCol = mix(col, mix(photo, flatCol, keep), uTreat);
  outCol = mix(outCol, vec3(1.0), uFlash);
  gl_FragColor = vec4(outCol, 1.0);
}
`;

export interface FootageState {
  /** 0 clean footage … 1 the colour treatment fully on */
  treat: number;
  /** how far the colours have walked round the bands (whole numbers between steps) */
  shift: number;
  /** 0..1 smear from speed */
  blur: number;
  /** push-in, as a fraction of the frame */
  punch: number;
  /** 0..1 white-out */
  flash: number;
  flip: boolean;
  /** how flat each band is, shadows to highlights: 0 footage … 1 flat colour */
  keep: number[];
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
        uFootageAspect: { value: 16 / 9 },
        uAspect: { value: 16 / 9 },
        uFlats: { value: Array.from({ length: 5 }, () => new THREE.Color()) },
        uKeep: { value: [1, 0, 0, 0, 1] },
        uCuts: { value: [0.2, 0.4, 0.6, 0.8] },
        uPaper: { value: new THREE.Color('#ffffff') },
        uFocus: { value: new THREE.Vector2(0.5, 0.5) },
        uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
        uTreat: { value: 0 },
        uShift: { value: 0 },
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

  setPalette(p: ShotPalette) {
    const u = this.material.uniforms;
    (u.uFlats.value as THREE.Color[]).forEach((c, i) => c.set(p.flats[i]));
    (u.uPaper.value as THREE.Color).set(p.paper);
    u.uCuts.value = p.cuts;
  }

  /** `focus` is 0..1 from the bottom-left: the point the picture pushes in on */
  render(renderer: THREE.WebGLRenderer, w: number, h: number, focus: { x: number; y: number }, s: FootageState) {
    const u = this.material.uniforms;
    u.uAspect.value = w / h;
    (u.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    (u.uFocus.value as THREE.Vector2).set(focus.x, focus.y);
    u.uTreat.value = s.treat;
    u.uShift.value = s.shift;
    u.uBlur.value = s.blur;
    u.uPunch.value = s.punch;
    u.uFlash.value = s.flash;
    u.uFlip.value = s.flip ? 1 : 0;
    u.uKeep.value = s.keep;
    renderer.render(this.scene, this.camera);
  }
}

const BURST = [1, 0.2, 0, 0.25, 1];

/**
 * How the footage looks at song time t: clean while it waits and winds up, the colours on within a few
 * frames of the hit and walking round on the beat, two bars where the whole picture goes flat (the
 * breather), then back to clean footage as the shot ends.
 */
export function footageStateAt(t: number, score: ShotScore, curve: TimeCurve): FootageState {
  const { hit, end, beat } = score;
  const tau = t - hit;
  const u = tau / beat;
  const ramp = clamp01((t - (hit - RAMP_BEATS * beat)) / (RAMP_BEATS * beat));

  // the colours step once a beat for the first bar, then every other beat
  const base = u < 4 ? u : 4 + (u - 4) / 2;
  const n = Math.floor(base);
  const sinceStep = (base - n) * (u < 4 ? 1 : 2);
  const shift = tau < 0 ? 0 : n - 1 + easeOutCubic(clamp01(sinceStep / 0.22));

  const breather = smooth(7.6, 8.4, u) * (1 - smooth(11.6, 12.4, u));
  return {
    treat: tau < 0 ? 0 : smooth(0, 0.18, tau) * (1 - smooth(end - beat * 2, end - beat * 0.5, t)),
    shift,
    blur: clamp01((curve.speed(t) - 1.2) / 2.2),
    punch: tau < 0 ? 0.12 * easeInCubic(ramp) : 0.16 * Math.exp(-tau / 0.35),
    flash: tau < 0 ? 0 : tau < 1 / 30 ? 1 : 0.55 * Math.exp(-(tau - 1 / 30) / 0.06),
    flip: curve.flip && tau >= 0,
    keep: BURST.map((k) => k + (1 - k) * breather),
  };
}
