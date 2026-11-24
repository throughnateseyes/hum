/**
 * The pictures an inside shot is made of, back to front:
 *
 *   NEARNESS  how near everything in the frame is, at full size: the clip's small depth map laid over
 *             the frame and pulled to the picture's own edges, with thin dark things against the sky
 *             (cables, branches, poles) put back, which a small map loses
 *   BED       the clip, with layers of it turned into flat fields that keep the light's own shapes
 *   (the words and shapes are drawn over it by the materials below, each point tested against NEARNESS)
 *   FINISH    the whole picture, smeared toward the vanishing point when it jumps, with the flash
 */
import { FULLSCREEN_VERT } from '../core/glsl';

export { FULLSCREEN_VERT };

const CLIP = /* glsl */ `
uniform sampler2D tFootage;
uniform vec4 uCrop;
vec2 clipUv(vec2 f) { return uCrop.xy + (f - 0.5) * uCrop.zw; }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

export const NEARNESS = /* glsl */ `
precision highp float;
varying vec2 vUv;
${CLIP}
uniform sampler2D tMapA, tMapB;
uniform float uMapMix, uHasMap;
uniform vec2 uMapSize, uClipTexel;
float mapAt(vec2 q) {
  float b = mix(texture2D(tMapA, q).r, texture2D(tMapB, q).r, uMapMix);
  return b * b;
}
void main() {
  if (uHasMap < 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 uv = clipUv(vUv);
  vec3 c = texture2D(tFootage, uv).rgb;
  vec2 px = 1.0 / uMapSize;
  vec2 home = (floor(uv * uMapSize) + 0.5) * px;
  float ns[25];
  vec3 cs[25];
  float sum = 0.0, ws = 0.0, sky = 0.0, all = 25.0;
  vec3 skyC = vec3(0.0);
  for (int j = 0; j < 5; j++) for (int i = 0; i < 5; i++) {
    vec2 q = home + vec2(float(i - 2), float(j - 2)) * px;
    float m = mapAt(q);
    vec3 s = texture2D(tFootage, q).rgb;
    vec3 d = s - c;
    vec2 off = (q - uv) * uMapSize;
    float w = exp(-dot(d, d) * 55.0) * exp(-dot(off, off) * 0.32) + 1e-5;
    sum += m * w;
    ws += w;
    float k = step(m, 0.0035);
    sky += k;
    skyC += s * k;
    ns[j * 5 + i] = m;
    cs[j * 5 + i] = s;
  }
  float n = sum / ws;
  // where the small map has both sky and something in front of it, the picture's own colours say which
  // this point is: the sky's, or those of the thing least like the sky
  if (sky > 2.5 && sky < 24.5) {
    skyC /= sky;
    float most = 0.0, m = 0.0, mw = 0.0;
    vec3 thing = skyC;
    for (int k = 0; k < 25; k++) {
      if (ns[k] <= 0.0035) continue;
      vec3 d = cs[k] - skyC;
      float e = dot(d, d);
      m += ns[k] * e;
      mw += e;
      if (e > most) { most = e; thing = cs[k]; }
    }
    vec3 d = thing - skyC;
    float a = dot(c - skyC, d) / max(most, 1e-4);
    n = mix(n, (mw > 0.0 ? m / mw : n) * smoothstep(0.3, 0.6, a), smoothstep(0.006, 0.02, most));
  }
  // something thin and dark against the sky: darker than what is on both sides of it, a little way off
  if (sky > all * 0.3 && n < 0.02) {
    float l = luma(c);
    float thin = 0.0;
    for (int k = 0; k < 8; k++) {
      float a = float(k) * 0.3927;
      vec2 d = vec2(cos(a), sin(a)) * uClipTexel;
      for (int r = 0; r < 2; r++) {
        vec2 o = d * (r == 0 ? 4.5 : 9.0);
        float b = min(luma(texture2D(tFootage, uv + o).rgb), luma(texture2D(tFootage, uv - o).rgb));
        thin = max(thin, smoothstep(0.2, 0.34, (b - l) / (b + 0.08)));
      }
    }
    n = max(n, 0.02 * thin);
  }
  gl_FragColor = vec4(n, 0.0, 0.0, 1.0);
}
`;

export const BED = /* glsl */ `
precision highp float;
varying vec2 vUv;
${CLIP}
uniform sampler2D tNear;
uniform vec2 uTexel, uClipTexel;
uniform vec2 uCuts;
uniform vec3 uField0, uLight0, uField1, uLight1, uFigure, uLine, uInk;
// the depth the new colour has swept to (0 sky .. 1 nearest, as the square root of nearness), and its edge
uniform float uFront, uEdge;
// how far each layer is painted: what is beyond uFarCut, between the cuts, and what is in front
uniform vec3 uPaint;
uniform float uFarCut, uNearCut;
uniform float uFigureK, uGroundK, uGrade, uLineK;
uniform vec3 uGround;
float near(vec2 f) { return texture2D(tNear, f).r; }
void main() {
  vec2 uv = clipUv(vUv);
  vec3 f = texture2D(tFootage, uv).rgb;
  float n = near(vUv);
  float q = sqrt(n);
  float l = luma(f);
  // the light, softened a little so the flat tones have clean edges
  float bl = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7854;
    bl += luma(texture2D(tFootage, uv + vec2(cos(a), sin(a)) * uClipTexel * 2.6).rgb);
    bl += luma(texture2D(tFootage, uv + vec2(cos(a + 0.39), sin(a + 0.39)) * uClipTexel * 5.0).rgb);
  }
  bl = mix(l, bl / 16.0, 0.82);
  float aa = max(fwidth(bl), 0.006);
  float hi = smoothstep(uCuts.y - aa, uCuts.y + aa, bl);
  float lo = smoothstep(uCuts.x + aa, uCuts.x - aa, bl);
  float fw = max(fwidth(q), 0.004);
  float swept = smoothstep(uFront + fw, uFront - fw, q);
  vec3 field = mix(uField0, uField1, swept);
  vec3 light = mix(uLight0, uLight1, swept);
  vec3 flatC = mix(field, light, hi);
  flatC = mix(flatC, mix(field * 0.62, uInk, 0.25), lo);
  // the picture as it is, held back when it is quiet
  vec3 nat = mix(f, f * f * (3.0 - 2.0 * f), 0.4);
  vec3 dim = mix(nat, vec3(l) * vec3(0.86, 0.95, 1.1), 0.45) * 0.5;
  nat = mix(nat, dim, uGrade);
  float far = 1.0 - smoothstep(uFarCut * 0.92, uFarCut * 1.08, q);
  float front = smoothstep(uNearCut * 0.94, uNearCut * 1.06, q);
  float mid = clamp(1.0 - far - front, 0.0, 1.0);
  // what stands in front of the far field is the same colour a step darker, so the layers part
  float down = mix(0.42, 0.68, luma(field));
  vec3 deepF = mix(field, uInk, down), deepL = mix(field, uInk, down * 0.5);
  vec3 midC = mix(deepF, deepL, hi);
  midC = mix(midC, mix(field * 0.3, uInk, 0.6), lo);
  vec3 c = mix(nat, flatC, clamp(far * uPaint.x, 0.0, 1.0));
  c = mix(c, midC, clamp(mid * uPaint.y + front * uPaint.z, 0.0, 1.0));
  // things close by as one flat shape
  c = mix(c, mix(uFigure, uFigure * 0.72, lo), front * uFigureK);
  // the ground: where the picture is as near as flat ground would be there
  float g = uGround.x * vUv.x + uGround.y * vUv.y + uGround.z;
  float on = step(0.0005, g) * (1.0 - smoothstep(0.16, 0.3, abs(n / max(g, 1e-4) - 1.0))) * smoothstep(0.05, 0.13, l);
  vec3 gt = mix(field, uField1, 0.5);
  c = mix(c, gt * (0.32 + l * 1.5), on * uGroundK * (1.0 - front * uFigureK));
  // a line along the edges of things, on a hit
  if (uLineK > 0.001) {
    vec2 d = uTexel * 1.4;
    float e0 = sqrt(near(vUv + vec2(d.x, 0.0))) - sqrt(near(vUv - vec2(d.x, 0.0)));
    float e1 = sqrt(near(vUv + vec2(0.0, d.y))) - sqrt(near(vUv - vec2(0.0, d.y)));
    float e = smoothstep(0.035, 0.09, length(vec2(e0, e1)) / max(0.25, q + 0.12));
    c = mix(c, uLine, e * uLineK);
  }
  // the edge of the sweep, a thin bright front running through the place
  c = mix(c, uLine, uEdge * (1.0 - smoothstep(0.0, 0.016 + fw, abs(q - uFront))) * step(0.0, uFront));
  gl_FragColor = vec4(c, 1.0);
}
`;

/** put into every material drawn in the place: is the point behind something in the picture? */
const HIDE = /* glsl */ `
uniform sampler2D tNear;
uniform vec2 uRes;
uniform float uZScale;
varying float vW;
float showing() {
  float n = texture2D(tNear, gl_FragCoord.xy / uRes).r;
  float me = uZScale / vW;
  return 1.0 - smoothstep(me + max(0.0025, 0.05 * me), me + max(0.0055, 0.15 * me), n);
}
`;

const PLACE_VERT = /* glsl */ `
varying vec2 vUv;
varying float vW;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vW = gl_Position.w;
}
`;

export const MAX_LETTERS = 28;

export const WORD_VERT = PLACE_VERT;
export const WORD_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
${HIDE}
${CLIP}
uniform sampler2D tText;
uniform vec3 uColor;
uniform float uAlpha, uShade, uBleed, uBleedX;
uniform float uEdges[${MAX_LETTERS}];
uniform float uShow[${MAX_LETTERS}];
uniform float uHide;
void main() {
  float x = (vUv.x - uBleedX) / (1.0 - 2.0 * uBleedX);
  float s = uShow[0];
  for (int i = 1; i < ${MAX_LETTERS}; i++) if (x > uEdges[i - 1]) s = uShow[i];
  // a letter rises from behind its own baseline
  vec2 q = vec2(vUv.x, vUv.y + (1.0 - s) * 0.9);
  float cut = step(uBleed * 0.4, vUv.y) + step(0.999, s);
  float a = texture2D(tText, q).a * step(q.y, 1.0) * min(cut, 1.0) * uAlpha;
  a *= mix(1.0, showing(), uHide);
  if (a < 0.004) discard;
  vec3 c = uColor;
  if (uShade > 0.001) {
    float l = luma(texture2D(tFootage, clipUv(gl_FragCoord.xy / uRes)).rgb);
    c *= mix(1.0, clamp(0.5 + l * 1.35, 0.35, 1.12), uShade);
    a *= mix(1.0, smoothstep(0.03, 0.12, l), uShade * 0.8);
  }
  gl_FragColor = vec4(c * a, a);
}
`;

export const FLAT_VERT = PLACE_VERT;
export const FLAT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
${HIDE}
uniform vec3 uColor;
uniform float uAlpha;
void main() {
  float a = showing() * uAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor * a, a);
}
`;

export const RIBBON_VERT = /* glsl */ `
attribute vec3 aSide;
attribute float aAlong;
uniform float uWidth, uSlide;
varying float vAlong;
varying float vW;
void main() {
  vAlong = aAlong;
  vec3 p = position + aSide * uWidth;
  p.z += uSlide;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  vW = gl_Position.w;
}
`;
export const RIBBON_FRAG = /* glsl */ `
precision highp float;
${HIDE}
varying float vAlong;
uniform vec3 uColor;
uniform float uHead, uTail;
void main() {
  if (vAlong < uHead || vAlong > uTail) discard;
  float a = showing();
  if (a < 0.01) discard;
  vec3 c = gl_FrontFacing ? uColor : uColor * 0.8;
  gl_FragColor = vec4(c * a, a);
}
`;

export const RAYS_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tNear;
uniform vec2 uFrom;
uniform float uAspect, uReach, uTurn, uSeed, uCut;
uniform vec3 uA, uB;
float h(float n) { return fract(sin(n * 91.7 + uSeed * 7.1) * 4375.5); }
void main() {
  vec2 p = (vUv - uFrom) * vec2(uAspect, 1.0);
  float r = length(p);
  float n = 22.0;
  float x = (atan(p.y, p.x) + uTurn) / 6.2831853 * n;
  float i = mod(floor(x), n);
  float f = fract(x);
  float w = 0.16 + 0.5 * h(i);
  float px = n / (6.2831853 * max(r, 1e-3)) * 0.0014;
  float k = smoothstep(0.0, px, f - 0.5 + w * 0.5) * smoothstep(0.0, px, 0.5 + w * 0.5 - f);
  float len = uReach * 2.2 * (0.5 + 0.8 * h(i + 40.0));
  k *= smoothstep(len, len - 0.004, r) * smoothstep(0.05, 0.053, r) * step(0.2, h(i + 9.0));
  k *= 1.0 - smoothstep(uCut, uCut + max(0.002, uCut * 0.2), texture2D(tNear, vUv).r);
  if (k < 0.004) discard;
  gl_FragColor = vec4(mix(uA, uB, step(0.62, h(i + 3.0))) * k, k);
}
`;

export const OVER = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tBed, tOver;
void main() {
  vec4 o = texture2D(tOver, vUv);
  gl_FragColor = vec4(texture2D(tBed, vUv).rgb * (1.0 - o.a) + o.rgb, 1.0);
}
`;

export const FINISH = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tPicture;
uniform vec2 uVp;
uniform float uSmear, uZoom, uFlash;
uniform vec3 uFlashC;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec3 c = vec3(0.0);
  vec2 base = uVp + (vUv - uVp) / uZoom;
  if (uSmear > 0.002) {
    float j = hash(gl_FragCoord.xy);
    for (int i = 0; i < 12; i++) {
      float k = (float(i) + j) / 12.0;
      c += texture2D(tPicture, uVp + (base - uVp) * (1.0 - uSmear * k)).rgb;
    }
    c /= 12.0;
  } else c = texture2D(tPicture, base).rgb;
  gl_FragColor = vec4(mix(c, uFlashC, uFlash), 1.0);
}
`;
