/**
 * A ring of a clip's own recent frames, for the motions that show several moments of it at once
 * (motion.ts: Echo and Slices).
 *
 * The ring is kept by song time, not by what happened to be on screen: slot `tick` holds the clip at
 * the second the shot's curve puts on screen at song time tick / RATE. A render fills every slot it
 * needs by seeking the clip (fill), so a frame is the same however the render got there; live, each
 * frame copies the playing clip into the slot of the tick it is on (capture), which is the same curve
 * as near as playback follows it. A slot the ring doesn't have yet (just after a seek) borrows the
 * newest one it has, else the clip as it is.
 *
 * compose() draws the clip with its motion into one texture at the clip's own size and shape, which
 * the footage pass then crops, tones and treats exactly as it would the clip itself.
 */
import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../core/glsl';
import type { MotionId } from './motion';
import { clamp01, since } from './time';
import { unit } from './treatments/common';

/** slots per second of song time, and how many are kept */
export const RATE = 30;
export const SLOTS = 16;
/** the longest side a slot is kept at */
const MAX_SIDE = 960;
/** ghosts behind the picture in Echo */
const GHOSTS = 4;
/** the most strips Slices cuts */
const STRIPS = 12;

const ECHO = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tNow, tG0, tG1, tG2, tG3;
uniform vec4 uFade;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 ghost(vec3 col, vec3 now, sampler2D g, float fade) {
  vec3 c = texture2D(g, vUv).rgb;
  // a ghost shows where the picture has moved away from it, lighter or darker, and fades with age
  float d = smoothstep(0.05, 0.22, abs(luma(c) - luma(now)) + length(c - now) * 0.35);
  return mix(col, c, d * fade);
}
void main() {
  vec3 now = texture2D(tNow, vUv).rgb;
  vec3 col = now;
  // oldest first, so the newer ghosts sit on the older ones
  col = ghost(col, now, tG3, uFade.w);
  col = ghost(col, now, tG2, uFade.z);
  col = ghost(col, now, tG1, uFade.y);
  col = ghost(col, now, tG0, uFade.x);
  // the picture itself stays the clearest thing
  gl_FragColor = vec4(mix(col, now, 0.35), 1.0);
}
`;

const STRIP = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec4 uBox;
uniform vec2 uEdge;
void main() {
  // one strip: inside its box the clip at its own moment, with a dark hairline down its leading edge
  if (vUv.x < uBox.x || vUv.x > uBox.z || vUv.y < uBox.y || vUv.y > uBox.w) discard;
  vec3 col = texture2D(tSrc, vUv).rgb;
  float edge = uEdge.x > 0.0 ? step(vUv.x, uBox.x + uEdge.x) : step(vUv.y, uBox.y + uEdge.y);
  gl_FragColor = vec4(mix(col, col * 0.25, edge), 1.0);
}
`;

const COPY = /* glsl */ `precision highp float; varying vec2 vUv; uniform sampler2D tMap; void main() { gl_FragColor = vec4(texture2D(tMap, vUv).rgb, 1.0); }`;

interface Slot {
  rt: THREE.WebGLRenderTarget;
  /** the tick it holds (-1: nothing), and which shot it belongs to */
  tick: number;
  key: string;
}

/** what compose needs from the shot this frame */
export interface RingFrame {
  t: number;
  beat: number;
  kicks: number[];
  /** how loud the song is at t, 0..1 */
  loud: number;
  layout: number;
  /** the clip's and the frame's shape, and the push-in, so the strips divide what is seen */
  clipAspect: number;
  frameAspect: number;
  zoom: number;
}

export class FrameRing {
  private slots: Slot[] = [];
  private out: THREE.WebGLRenderTarget | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mesh: THREE.Mesh;
  private readonly copyMat: THREE.ShaderMaterial;
  private readonly echoMat: THREE.ShaderMaterial;
  private readonly stripMat: THREE.ShaderMaterial;
  private w = 0;
  private h = 0;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    const mat = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) => new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false });
    this.copyMat = mat(COPY, { tMap: { value: null } });
    this.echoMat = mat(ECHO, { tNow: { value: null }, tG0: { value: null }, tG1: { value: null }, tG2: { value: null }, tG3: { value: null }, uFade: { value: new THREE.Vector4() } });
    this.stripMat = mat(STRIP, { tSrc: { value: null }, uBox: { value: new THREE.Vector4() }, uEdge: { value: new THREE.Vector2() } });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.copyMat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  /** the composed picture (the clip with its motion), at the clip's shape */
  get texture(): THREE.Texture | null {
    return this.out?.texture ?? null;
  }

  /** size the slots for a clip of this shape; a new shape empties the ring */
  fit(aspect: number, side = MAX_SIDE) {
    const w = Math.max(2, Math.round(aspect >= 1 ? side : side * aspect));
    const h = Math.max(2, Math.round(aspect >= 1 ? side / aspect : side));
    if (w === this.w && h === this.h) return;
    this.dispose();
    this.w = w;
    this.h = h;
    const make = () => new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    this.slots = Array.from({ length: SLOTS }, () => ({ rt: make(), tick: -1, key: '' }));
    this.out = make();
  }

  private draw(m: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget) {
    this.mesh.material = m;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  has(tick: number, key: string): boolean {
    const s = this.slots[((tick % SLOTS) + SLOTS) % SLOTS];
    return !!s && s.tick === tick && s.key === key;
  }

  /** put the clip as it is now into the slot of `tick` */
  capture(tex: THREE.Texture, tick: number, key: string) {
    if (!this.slots.length) return;
    const s = this.slots[((tick % SLOTS) + SLOTS) % SLOTS];
    const was = this.renderer.getRenderTarget();
    this.copyMat.uniforms.tMap.value = tex;
    this.draw(this.copyMat, s.rt);
    this.renderer.setRenderTarget(was);
    s.tick = tick;
    s.key = key;
  }

  /** the slot holding `tick`, else the newest one at or before it, else null (use the clip) */
  private at(tick: number, key: string, newest: number): THREE.Texture | null {
    for (let k = tick; k <= newest; k++) if (this.has(k, key)) return this.slots[((k % SLOTS) + SLOTS) % SLOTS].rt.texture;
    return null;
  }

  /** the ticks a frame at song time t reads (the newest first), for a render to fill them */
  static needs(motion: MotionId, f: RingFrame): number[] {
    const now = Math.floor(f.t * RATE + 1e-4);
    return offsets(motion, f).map((o) => now - o);
  }

  /** draw the clip with its motion; `now` is the clip as it is on this frame */
  compose(motion: MotionId, f: RingFrame, now: THREE.Texture, key: string): THREE.Texture | null {
    if (!this.out) return null;
    const was = this.renderer.getRenderTarget();
    const tick = Math.floor(f.t * RATE + 1e-4);
    const offs = offsets(motion, f);
    if (motion === 'echo') {
      const u = this.echoMat.uniforms;
      u.tNow.value = now;
      const fades = [0.8, 0.6, 0.42, 0.26];
      ['tG0', 'tG1', 'tG2', 'tG3'].forEach((name, i) => {
        u[name].value = this.at(tick - offs[i + 1], key, tick) ?? now;
      });
      (u.uFade.value as THREE.Vector4).set(fades[0], fades[1], fades[2], fades[3]);
      this.draw(this.echoMat, this.out);
    } else {
      // the strips, side by side across the part of the clip the frame shows
      const n = offs.length;
      const across = stripsAcross(f);
      const seen = seenShare(f.clipAspect, f.frameAspect, across, f.zoom);
      const lo = 0.5 - seen / 2;
      const u = this.stripMat.uniforms;
      const edge = u.uEdge.value as THREE.Vector2;
      this.renderer.setRenderTarget(this.out);
      for (let i = 0; i < n; i++) {
        u.tSrc.value = i === 0 ? now : (this.at(tick - offs[i], key, tick) ?? now);
        const a = i === 0 ? 0 : lo + (seen * i) / n;
        const b = i === n - 1 ? 1 : lo + (seen * (i + 1)) / n;
        (u.uBox.value as THREE.Vector4).set(across ? a : 0, across ? 0 : a, across ? b : 1, across ? 1 : b);
        edge.set(across && i > 0 ? 1.5 / this.w : 0, !across && i > 0 ? 1.5 / this.h : 0);
        this.draw(this.stripMat, this.out);
      }
    }
    this.renderer.setRenderTarget(was);
    return this.out.texture;
  }

  /** draw every material once (compiles them ahead of the first cut) */
  warm(tex: THREE.Texture) {
    this.fit(16 / 9, 32);
    const f: RingFrame = { t: 1, beat: 0.5, kicks: [], loud: 0.5, layout: 1, clipAspect: 16 / 9, frameAspect: 9 / 16, zoom: 1 };
    this.capture(tex, 30, 'warm');
    this.compose('echo', f, tex, 'warm');
    this.compose('slices', f, tex, 'warm');
  }

  dispose() {
    for (const s of this.slots) s.rt.dispose();
    this.slots = [];
    this.out?.dispose();
    this.out = null;
    this.w = this.h = 0;
  }

  release() {
    this.dispose();
    this.copyMat.dispose();
    this.echoMat.dispose();
    this.stripMat.dispose();
    this.mesh.geometry.dispose();
  }
}

/**
 * How many ticks back each layer reads. Echo: the picture, then four ghosts, further apart when the
 * song is loud and just after a kick. Slices: one per strip, the spread breathing with the loudness,
 * a slow swell over two bars and a jump on every kick.
 */
function offsets(motion: MotionId, f: RingFrame): number[] {
  const kick = Math.exp(-since(f.kicks, f.t) / 0.16);
  if (motion === 'echo') {
    const step = Math.min(3.6, 2 + 1.2 * f.loud + 1.2 * kick);
    return [0, ...Array.from({ length: GHOSTS }, (_, i) => Math.min(SLOTS - 1, Math.round(step * (i + 1))))];
  }
  const n = 6 + Math.floor(unit(f.layout, 43) * (STRIPS - 5));
  const swell = 0.5 + 0.5 * Math.sin((f.t / (f.beat * 8)) * Math.PI * 2);
  const spread = Math.min((SLOTS - 1) / (n - 1), (0.35 + 1.1 * f.loud) * (0.7 + 0.5 * swell) * (1 + 0.9 * kick));
  return Array.from({ length: n }, (_, i) => Math.min(SLOTS - 1, Math.round(i * spread)));
}

/** strips side by side (cut across the width) in a tall frame mostly, stacked in a wide one mostly */
function stripsAcross(f: RingFrame): boolean {
  return unit(f.layout, 41) < (f.frameAspect < 1 ? 0.75 : 0.35);
}

/** what share of the clip's width (strips across) or height the frame shows, once cropped to fill it */
function seenShare(clipAspect: number, frameAspect: number, across: boolean, zoom: number): number {
  const s = across ? Math.min(1, frameAspect / clipAspect) : Math.min(1, clipAspect / frameAspect);
  return clamp01(s / Math.max(1, zoom));
}
