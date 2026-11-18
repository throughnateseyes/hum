import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../core/glsl';
import { createFullscreenQuad } from '../core/sceneHelpers';
import { TRANSITION_IDS, type TransitionId } from '../core/transitionList';

/**
 * One pass that blends the outgoing look (tA) into the incoming one (tB). Every kind is exactly tA at
 * uP = 0 and exactly tB at uP = 1 (masks use `reveal`, motion and glows scale with `bell`), so a
 * transition never pops at its start or end, and none of them blanks the picture: the fades dip to
 * the colour but keep a trace of the image.
 */
const TRANSITION_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tA;
uniform sampler2D tB;
uniform float uP, uKind, uSeed, uAspect, uTime, uKick, uBass;
uniform vec2 uDir, uRes, uCenter;
uniform vec3 uBg, uAccent, uHot;

float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21) + uSeed * 0.1371); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vn(p); p = p * 2.03 + 17.1; a *= 0.5; } return s / 0.96875; }
/** fbm stretched so its values cover 0..1 evenly-ish */
float field(vec2 p){ return clamp((fbm(p) - 0.5) * 2.1 + 0.5, 0.0, 1.0); }
float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
/** 0 at both ends, 1 in the middle (never negative, so pow() stays defined) */
float bell(float p){ return max(0.0, sin(3.14159265 * clamp(p, 0.0, 1.0))); }
float ease(float p){ p = clamp(p, 0.0, 1.0); return p * p * (3.0 - 2.0 * p); }
float easeIO(float p){ p = clamp(p, 0.0, 1.0); return p < 0.5 ? 4.0 * p * p * p : 1.0 - pow(-2.0 * p + 2.0, 3.0) * 0.5; }
/** threshold mask over a field f in 0..1 with feather w: exactly 0 at p = 0 and 1 at p = 1 */
float reveal(float f, float p, float w){ return smoothstep(0.0, 1.0, (p * (1.0 + w) - clamp(f, 0.0, 1.0)) / w); }
vec3 A(vec2 uv){ return texture2D(tA, uv).rgb; }
vec3 B(vec2 uv){ return texture2D(tB, uv).rgb; }

void main(){
  float p = clamp(uP, 0.0, 1.0);
  float k = uKind;
  vec2 uv = vUv;
  vec2 q = (uv - 0.5) * vec2(uAspect, 1.0);
  vec3 col;

  if (k < 0.5) {                                   // cut
    col = p < 0.5 ? A(uv) : B(uv);
  } else if (k < 1.5) {                            // crossfade
    col = mix(A(uv), B(uv), easeIO(p));
  } else if (k < 3.5) {                            // fade through the background colour / black
    vec3 c = mix(A(uv), B(uv), ease(smoothstep(0.2, 0.8, p)));
    vec3 tint = k < 2.5 ? uBg : vec3(0.0);
    col = mix(c, tint, pow(bell(p), 1.4) * 0.78);
  } else if (k < 4.5) {                            // luminance dissolve: the new look's bright parts first
    vec3 b = B(uv);
    float f = 0.78 * (1.0 - smoothstep(0.02, 0.9, lum(b))) + 0.22 * field(q * 3.0 + uSeed);
    col = mix(A(uv), b, reveal(f, p, 0.24));
  } else if (k < 5.5) {                            // grainy cloud dissolve
    float f = field(q * 2.6 + uSeed + vec2(uTime * 0.03, 0.0)) + (h21(floor(gl_FragCoord.xy / 2.0)) - 0.5) * 0.08;
    col = mix(A(uv), B(uv), reveal(f, p, 0.12));
  } else if (k < 6.5) {                            // film burn
    vec2 o = (vec2(h21(vec2(uSeed, 1.0)), h21(vec2(2.0, uSeed))) - 0.5) * vec2(uAspect, 1.0) * 0.8;
    float d = length(q - o) / (0.75 * length(vec2(uAspect, 1.0)));
    float f = 0.55 * field(q * 2.2 + uSeed) + 0.45 * d;
    float m = reveal(f, p, 0.05);
    float g = clamp(reveal(f, p, 0.26) - m, 0.0, 1.0);   // the glowing band ahead of the front
    vec3 a = A(uv) * (1.0 + 1.6 * g) + uHot * g * 1.1 + vec3(1.0, 0.92, 0.8) * pow(g, 3.0) * 0.8;
    col = mix(a, B(uv), m);
  } else if (k < 7.5) {                            // ink blots
    float d = 9.0;
    for (int i = 0; i < 4; i++) {
      vec2 c = (vec2(h21(vec2(float(i), uSeed + 3.0)), h21(vec2(uSeed + 5.0, float(i)))) - 0.5) * vec2(uAspect, 1.0) * 0.9;
      d = min(d, length(q - c));
    }
    float f = clamp(d / (0.55 * length(vec2(uAspect, 1.0))) + 0.32 * (field(q * 3.5 + uSeed) - 0.5), 0.0, 1.0);
    float m = reveal(f, p, 0.04);
    float g = clamp(reveal(f, p, 0.14) - m, 0.0, 1.0);
    vec3 ink = mix(vec3(0.02), uAccent * 0.25, 0.3);
    col = mix(mix(A(uv), ink, g * 0.88), B(uv), m);
  } else if (k < 8.5) {                            // soft directional wipe
    vec2 dir = normalize(uDir);
    float range = (abs(dir.x) * uAspect + abs(dir.y)) * 0.5;
    float along = dot(q, vec2(-dir.y, dir.x));
    float f = clamp(dot(q, dir) / range * 0.5 + 0.5 + (vn(vec2(along * 5.0, uTime * 0.6)) - 0.5) * 0.07, 0.0, 1.0);
    float e = ease(p);
    float m = reveal(f, e, 0.2);
    vec2 sh = dir / vec2(uAspect, 1.0) * 0.04;
    vec3 c = mix(A(uv - sh * e), B(uv + sh * (1.0 - e)), m);
    col = c + vec3(4.0 * m * (1.0 - m) * 0.08);
  } else if (k < 9.5) {                            // iris
    vec2 c = (uCenter - 0.5) * vec2(uAspect, 1.0);
    float maxd = length(vec2(uAspect, 1.0)) * 0.5 + length(c);
    float ang = atan(q.y - c.y, q.x - c.x);
    float f = length(q - c) / maxd * (1.0 + 0.08 * (vn(vec2(ang * 2.0 + 7.0, uTime * 0.8)) - 0.5));
    float e = ease(p);
    float m = reveal(f, e, 0.1);
    float rim = clamp(reveal(f, e, 0.22) - m, 0.0, 1.0);
    col = mix(A(uv), B(uv), m) + uAccent * rim * 0.35;
  } else if (k < 10.5) {                           // ripple
    vec2 c = (uCenter - 0.5) * vec2(uAspect, 1.0);
    vec2 r = q - c;
    float d = length(r);
    float maxd = length(vec2(uAspect, 1.0)) * 0.5 + length(c);
    float amp = bell(p) * (0.011 + 0.012 * uKick);
    vec2 off = normalize(r + 1e-4) / vec2(uAspect, 1.0) * sin(d * 46.0 - p * 26.0) * amp;
    float m = reveal(d / maxd, ease(p), 0.38);
    col = mix(A(uv + off), B(uv - off), m);
  } else if (k < 11.5) {                           // mosaic
    float bp = bell(p);
    // whole-pixel blocks, so the picture is untouched until the blocks are really there
    float size = max(1.0, floor(1.0 + bp * bp * (uRes.y / 13.0) * (1.0 + 0.25 * uKick)));
    vec2 cell = (floor(gl_FragCoord.xy / size) + 0.5) * size / uRes;
    vec2 coarse = floor(vec2(uv.x * uAspect, uv.y) * 12.0);
    float m = reveal(h21(coarse), p, 0.12);
    col = mix(A(cell), B(cell), m);
  } else if (k < 12.5) {                           // glyphs
    float cs = max(6.0, uRes.y / 34.0);
    vec2 cell = floor(gl_FragCoord.xy / cs);
    vec2 l = fract(gl_FragCoord.xy / cs);
    vec2 bitc = floor(vec2(l.x * 5.0, l.y * 7.0));
    float bit = step(0.5, h21(cell * 7.13 + bitc * 0.71 + floor(uTime * 14.0) * 1.37));
    float inside = step(0.12, l.x) * step(l.x, 0.88) * step(0.08, l.y) * step(l.y, 0.92);
    float f = 0.65 * h21(cell) + 0.35 * vn(cell * 0.12 + uSeed);
    float m = reveal(f, p, 0.12);
    vec3 b = B(uv);
    vec3 c = mix(A(uv), b, step(0.5, m) * 0.6 + m * 0.4);
    float g = 4.0 * m * (1.0 - m) * bit * inside;
    col = mix(c, uAccent * (0.45 + 0.75 * lum(b)), g * 0.9);
  } else if (k < 13.5) {                           // zoom-blur push
    float e = easeIO(p);
    float bp = bell(p);
    float zA = 1.0 + 0.45 * e * e;
    float zB = 1.0 + 0.3 * (1.0 - e) * (1.0 - e);
    float m = ease((p - 0.32) / 0.36);
    vec2 cA = (uv - 0.5) / zA;
    vec2 cB = (uv - 0.5) / zB;
    float s = bp * (0.09 + 0.04 * uKick);
    vec3 a = vec3(0.0), b = vec3(0.0);
    for (int i = 0; i < 10; i++) {
      float t = float(i) / 9.0;
      a += A(cA * (1.0 - s * t) + 0.5);
      b += B(cB * (1.0 - s * t) + 0.5);
    }
    col = mix(a, b, m) / 10.0 * (1.0 + 0.18 * pow(bp, 4.0));
  } else {                                         // slit-scan band shuffle
    bool horiz = abs(uDir.x) >= abs(uDir.y);
    float n = 14.0 + floor(h21(vec2(uSeed, 9.0)) * 12.0);
    float across = horiz ? uv.y : uv.x;
    float alongC = horiz ? uv.x : uv.y;
    float band = floor(across * n);
    float delay = h21(vec2(band, uSeed + 11.0)) * 0.55;
    float e = easeIO((p - delay) / 0.45);
    float sgn = h21(vec2(uSeed + 2.0, band)) < 0.5 ? -1.0 : 1.0;
    float b = sgn > 0.0 ? alongC : 1.0 - alongC;             // 0 where the new band enters
    float inB = smoothstep(e + 0.004, e - 0.004, b);
    float bA = b - e;                                          // old band pushed ahead
    float bB = b + (1.0 - e);                                  // new band trails in behind it
    float sA = sgn > 0.0 ? bA : 1.0 - bA;
    float sB = sgn > 0.0 ? bB : 1.0 - bB;
    vec2 uvA = horiz ? vec2(sA, uv.y) : vec2(uv.x, sA);
    vec2 uvB = horiz ? vec2(sB, uv.y) : vec2(uv.x, sB);
    col = mix(A(uvA), B(uvB), e >= 1.0 ? 1.0 : e <= 0.0 ? 0.0 : inB);
  }
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}`;

export interface TransitionUniforms {
  /** 0..1 */
  p: number;
  seed: number;
  time: number;
  kick: number;
  bass: number;
  aspect: number;
  width: number;
  height: number;
  /** wipe and slit direction */
  dir: [number, number];
  /** iris and ripple centre, 0..1 */
  center: [number, number];
  bg: THREE.Color;
  accent: THREE.Color;
}

const HOT = new THREE.Color(1.0, 0.5, 0.16);

export class TransitionPass {
  private mat: THREE.ShaderMaterial;
  private quad: ReturnType<typeof createFullscreenQuad>;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tA: { value: null },
        tB: { value: null },
        uP: { value: 0 },
        uKind: { value: 1 },
        uSeed: { value: 0 },
        uAspect: { value: 1 },
        uTime: { value: 0 },
        uKick: { value: 0 },
        uBass: { value: 0 },
        uDir: { value: new THREE.Vector2(1, 0) },
        uRes: { value: new THREE.Vector2(2, 2) },
        uCenter: { value: new THREE.Vector2(0.5, 0.5) },
        uBg: { value: new THREE.Color() },
        uAccent: { value: new THREE.Color() },
        uHot: { value: new THREE.Color() },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: TRANSITION_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = createFullscreenQuad(this.mat);
  }

  render(renderer: THREE.WebGLRenderer, id: TransitionId, a: THREE.Texture, b: THREE.Texture, target: THREE.WebGLRenderTarget, o: TransitionUniforms) {
    const u = this.mat.uniforms;
    u.tA.value = a;
    u.tB.value = b;
    u.uP.value = o.p;
    u.uKind.value = Math.max(0, TRANSITION_IDS.indexOf(id));
    u.uSeed.value = o.seed;
    u.uAspect.value = o.aspect;
    u.uTime.value = o.time;
    u.uKick.value = o.kick;
    u.uBass.value = o.bass;
    (u.uDir.value as THREE.Vector2).set(o.dir[0], o.dir[1]);
    (u.uRes.value as THREE.Vector2).set(o.width, o.height);
    (u.uCenter.value as THREE.Vector2).set(o.center[0], o.center[1]);
    (u.uBg.value as THREE.Color).copy(o.bg);
    (u.uAccent.value as THREE.Color).copy(o.accent);
    (u.uHot.value as THREE.Color).copy(HOT).lerp(o.accent, 0.3);
    this.quad.render(renderer, target);
  }

  dispose() {
    this.mat.dispose();
    this.quad.dispose();
  }
}
