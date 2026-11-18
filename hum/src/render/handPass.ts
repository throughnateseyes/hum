import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../core/glsl';
import { createFullscreenQuad } from '../core/sceneHelpers';
import type { HandStyle, ResolvedPalette } from '../core/types';

/**
 * Hand-drawn finish, the last pass over every frame. It makes digital scenes read as made by hand:
 *
 *   boil      every new drawing wobbles a little (lines are never traced twice the same way)
 *   inks      colours collapse into a few flat printing inks from the palette, grain-dithered where
 *             two inks meet (like a risograph), each ink slightly out of register
 *   paper     fibres and grain under everything, ink that isn't perfectly flat, tiny dropouts
 *   lines     a pencil outline where the picture has edges, drawn twice and not quite on top
 *
 * The stage holds each drawing for a few frames (on 2s/3s), which is the other half of the look.
 */
const HAND_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tMap;
uniform vec2 uRes;
uniform float uSeed, uWobble, uInks, uPaper, uMisprint, uLines;
uniform vec3 uInk0, uInk1, uInk2, uInk3, uInk4;

float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 ink(int k){ return k == 0 ? uInk0 : k == 1 ? uInk1 : k == 2 ? uInk2 : k == 3 ? uInk3 : uInk4; }

/* how far each drawing strays from the last, in pixels: a slow sway plus a finer squiggle */
vec2 boil(vec2 px, float s){
  vec2 o = vec2(h21(vec2(s, 1.7)), h21(vec2(s, 8.3))) * 97.0;
  vec2 p1 = px / (uRes.y / 5.0) + o;
  vec2 p2 = px / (uRes.y / 36.0) + o * 1.7;
  vec2 d = vec2(vnoise(p1), vnoise(p1 + 31.7)) - 0.5;
  d += (vec2(vnoise(p2), vnoise(p2 + 11.3)) - 0.5) * 0.55;
  return d * uWobble * uRes.y * 0.009;
}

/* which ink a pixel gets: the nearest palette ink, grain-dithered against the second nearest */
float dist(vec3 a, vec3 b){ vec3 d = a - b; return dot(d * d, vec3(0.3, 0.59, 0.11)) * 2.0 + pow(lum(a) - lum(b), 2.0) * 3.0; }
float inkAt(vec2 uv, vec2 px){
  // read a slightly softened picture: a hand doesn't copy hairlines and halftone dots one by one
  vec2 r = vec2(uRes.y / 520.0) / uRes;
  vec3 c = texture2D(tMap, uv).rgb * 0.4
    + (texture2D(tMap, uv + vec2(r.x, 0.0)).rgb + texture2D(tMap, uv - vec2(r.x, 0.0)).rgb
     + texture2D(tMap, uv + vec2(0.0, r.y)).rgb + texture2D(tMap, uv - vec2(0.0, r.y)).rgb) * 0.15;
  float d0 = 1e9, d1 = 1e9, i0 = 0.0, i1 = 0.0;
  for (int k = 0; k < 5; k++) {
    if (float(k) > uInks + 0.5) break;
    float dd = dist(c, ink(k));
    if (dd < d0) { d1 = d0; i1 = i0; d0 = dd; i0 = float(k); }
    else if (dd < d1) { d1 = dd; i1 = float(k); }
  }
  float t = d0 / (d0 + d1 + 1e-5);                       // 0 = clearly i0, 0.5 = halfway between
  // clumpy grain, like ink on rough paper, only where the colour really sits between two inks
  float cell = max(1.0, uRes.y / 420.0);
  float n = mix(h21(floor(px / cell) + floor(uSeed) * 7.13), vnoise(px / (cell * 2.5) + uSeed * 3.1), 0.55);
  return n < smoothstep(0.36, 0.5, t) * 0.5 ? i1 : i0;
}

float paperTex(vec2 px){
  float s = uRes.y / 1080.0;
  float fib = vnoise(px / (vec2(3.0, 16.0) * s)) * 0.6 + vnoise(px / (vec2(14.0, 2.5) * s) + 5.0) * 0.4;
  float tooth = vnoise(px / (55.0 * s)) ;
  return fib * 0.6 + tooth * 0.4;                          // 0..1, mostly ~0.5
}

float edge(vec2 uv, float stepPx){
  vec2 e = vec2(stepPx) / uRes;
  float l = lum(texture2D(tMap, uv - vec2(e.x, 0.0)).rgb), r = lum(texture2D(tMap, uv + vec2(e.x, 0.0)).rgb);
  float d = lum(texture2D(tMap, uv - vec2(0.0, e.y)).rgb), u = lum(texture2D(tMap, uv + vec2(0.0, e.y)).rgb);
  return length(vec2(r - l, u - d));
}

void main(){
  vec2 px = vUv * uRes;
  // the sheet itself shifts a hair between drawings, like paper on pegs
  vec2 sheet = px + (vec2(h21(vec2(uSeed, 3.1)), h21(vec2(uSeed, 6.7))) - 0.5) * 3.0 * uWobble;
  vec2 b = boil(px, uSeed);
  vec2 uv = vUv + b / uRes;

  float pt = paperTex(sheet);
  float grain = h21(floor(sheet) + fract(uSeed * 0.61) * 91.0) - 0.5;
  vec3 paper = uInk0 * (1.0 - (pt - 0.5) * 0.16 * uPaper) + grain * 0.035 * uPaper;
  vec3 col;

  if (uInks < 0.5) {
    // full colour: keep the scene's colours, just put them on paper
    col = texture2D(tMap, uv).rgb;
    col *= 1.0 - (pt - 0.5) * 0.14 * uPaper;
    col += grain * 0.04 * uPaper;
  } else {
    col = paper;
    float base = inkAt(uv, px);
    for (int k = 1; k < 5; k++) {
      if (float(k) > uInks + 0.5) break;
      float fk = float(k);
      // each ink sits slightly out of register: a fixed offset per ink plus a little drift per drawing
      vec2 off = (vec2(h21(vec2(fk, 2.3)), h21(vec2(fk, 7.9))) - 0.5) * 2.0;
      off += (vec2(h21(vec2(fk, uSeed)), h21(vec2(uSeed, fk))) - 0.5) * 0.6;
      off *= uMisprint * uRes.y * 0.0045;
      float here = uMisprint < 0.01 ? base : inkAt(uv + off / uRes, px + off);
      if (abs(here - fk) < 0.5) {
        // ink is never perfectly flat: a little blotchy, with the odd speck where it didn't take
        float blotch = vnoise(sheet / (uRes.y / 9.0) + fk * 13.0);
        vec3 c = mix(ink(k), paper, (blotch - 0.35) * 0.22 * uPaper);
        float speck = h21(floor(sheet / max(1.0, uRes.y / 480.0)) + fk * 3.3 + floor(uSeed) * 0.37);
        col = speck < 0.012 * uPaper ? paper : c;
      }
    }
  }

  // pencil: an outline wherever the picture has an edge, drawn twice, not quite on top of itself
  if (uLines > 0.001) {
    float st = max(1.0, uRes.y / 800.0);
    vec2 b2 = boil(px + 40.0, uSeed + 17.0);
    float e1 = edge(uv, st);
    float e2 = edge(vUv + b2 / uRes, st);
    float pressure = 0.55 + 0.45 * vnoise(px / (uRes.y / 14.0) + uSeed * 3.0);
    float line = max(smoothstep(0.07, 0.22, e1), smoothstep(0.09, 0.26, e2) * 0.6) * pressure;
    line *= 0.75 + 0.25 * h21(floor(px / st) + uSeed);    // graphite is grainy
    col = mix(col, uInk1, clamp(line * uLines, 0.0, 1.0) * 0.9);
  }

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

export class HandPass {
  private mat = new THREE.ShaderMaterial({
    uniforms: {
      tMap: { value: null },
      uRes: { value: new THREE.Vector2(2, 2) },
      uSeed: { value: 0 },
      uWobble: { value: 0.5 },
      uInks: { value: 0 },
      uPaper: { value: 0.5 },
      uMisprint: { value: 0.4 },
      uLines: { value: 0.3 },
      uInk0: { value: new THREE.Color() },
      uInk1: { value: new THREE.Color() },
      uInk2: { value: new THREE.Color() },
      uInk3: { value: new THREE.Color() },
      uInk4: { value: new THREE.Color() },
    },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: HAND_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  private quad = createFullscreenQuad(this.mat);

  /** draw `input` through the hand-drawn finish into `target`; `drawing` numbers each new drawing */
  render(r: THREE.WebGLRenderer, input: THREE.Texture, target: THREE.WebGLRenderTarget | null, o: { style: HandStyle; palette: ResolvedPalette; width: number; height: number; drawing: number }) {
    const u = this.mat.uniforms;
    u.tMap.value = input;
    u.uRes.value.set(o.width, o.height);
    u.uSeed.value = o.drawing % 997;
    u.uWobble.value = o.style.wobble;
    u.uInks.value = o.style.inks;
    u.uPaper.value = o.style.paper;
    u.uMisprint.value = o.style.misprint;
    u.uLines.value = o.style.lines;
    const c = o.palette.c;
    u.uInk0.value.copy(c.bg);
    u.uInk1.value.copy(c.fg);
    u.uInk2.value.copy(c.accent);
    u.uInk3.value.copy(c.accent2);
    u.uInk4.value.copy(c.muted);
    this.quad.render(r, target);
  }

  dispose() {
    this.mat.dispose();
    this.quad.dispose();
  }
}
