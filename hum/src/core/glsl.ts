/**
 * Shared GLSL. Every shader scene and every effect gets, prepended automatically:
 *
 *   varying vec2 vUv;                      // 0..1, origin bottom-left
 *   uniform vec2  uResolution;             // target size in px
 *   uniform float uTime;                   // seconds
 *   uniform float uAspect;                 // width / height
 *   // audio layers (0..1)
 *   uniform float uLevel, uSub, uBass, uLowMid, uMid, uHighMid, uAir;
 *   uniform float uKick, uSnare, uHat, uEnergy, uBrightness, uFlux;
 *   uniform float uBeatPhase, uBuild, uDrop, uSway;   // uSway is -1..1
 *   uniform float uBeat;                   // 1.0 on the frame of a beat, else 0.0
 *   uniform float uBeatCount;              // integer count of beats so far
 *   uniform float uBpm;
 *   uniform sampler2D uSpectrum;           // 128×1, .r = 0..1   → spectrum(x)
 *   uniform sampler2D uWaveform;           // 512×1, .r = 0..1   → waveform(x) returns -1..1
 *   // palette
 *   uniform vec3 uBg, uFg, uAccent, uAccent2, uMuted;
 *   // feel: the song's emotional state and the shared world (see core/feel.ts)
 *   uniform float uFeelIntensity, uFeelTension, uFeelRelease, uFeelWarmth;   // 0..1
 *   uniform float uFeelToDrop, uFeelSinceDrop;     // seconds (99 = none)
 *   uniform float uFeelSectionT, uFeelSongT;       // 0..1 through the part / the song
 *   uniform vec2  uFeelWind;                       // unit wind direction, shared by every look
 *   uniform float uFeelGust, uFeelWindPhase;       // wind strength 0..1, and its travel (integrated)
 *   uniform float uFeelDay, uFeelLight;            // time of day 0..1 (0.5 = noon), light angle (radians)
 *   // + one uniform per param:  u_<paramId>  (number/bool/select-index → float, color → vec3)
 *
 * Effects additionally get:  uniform sampler2D tInput;  uniform sampler2D tPrev;
 * Shader scenes additionally get:
 *   uniform sampler2D uImage;  uniform vec2 uImageSize;    // current photo
 *   uniform sampler2D uImage2; uniform vec2 uImage2Size;   // next photo
 *   uniform float uPhotoIndex;                              // advances over time
 *   uniform sampler2D tPrev;                                // previous frame (if feedback: true)
 *
 * Common library functions (do NOT redefine these):
 *   float hash11(float), hash21(vec2); vec2 hash22(vec2);
 *   float vnoise(vec2);              // value noise 0..1
 *   float snoise(vec2); float snoise(vec3);   // simplex noise -1..1
 *   float fbm(vec2 p, int oct);  float fbm3(vec3 p, int oct);   // ~ -1..1
 *   // the same from the shared noise texture: one texture read each, several times cheaper. Use these
 *   // for clouds, water, smoke, grain and anything with many octaves; keep snoise for a few hero calls.
 *   float tnoise(vec2);  float tnoise3(vec3);          // smooth value noise 0..1 (repeats every 256 units)
 *   vec4  tnoise4(vec2);                               // four independent channels at once
 *   float tfbm(vec2 p, int oct);  float tfbm3(vec3 p, int oct);   // ~ -1..1, oct <= 8
 *   float luma(vec3);
 *   mat2  rot2(float a);
 *   vec3  cosPalette(float t, vec3 a, vec3 b, vec3 c, vec3 d);
 *   vec3  paletteRamp(float t);      // uBg → uAccent → uAccent2 → uFg
 *   float spectrum(float x);         // 0..1 at x in 0..1 (low → high)
 *   float waveform(float x);         // -1..1
 *   vec2  coverUv(vec2 uv, vec2 texSize, float aspect);  // object-fit: cover
 *   vec2  containUv(vec2 uv, vec2 texSize, float aspect);
 *   float sdBox(vec2 p, vec2 b); float sdCircle(vec2 p, float r);
 *   float bayer8(vec2 fragCoord);     // ordered-dither threshold 0..1
 *   const float PI, TAU
 */

export const AUDIO_UNIFORM_NAMES = [
  'uLevel',
  'uSub',
  'uBass',
  'uLowMid',
  'uMid',
  'uHighMid',
  'uAir',
  'uKick',
  'uSnare',
  'uHat',
  'uEnergy',
  'uBrightness',
  'uFlux',
  'uBeatPhase',
  'uBuild',
  'uDrop',
  'uSway',
  'uBeat',
  'uBeatCount',
  'uBpm',
] as const;

export const GLSL_HEADER = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform float uTime;
uniform float uAspect;
uniform float uLevel, uSub, uBass, uLowMid, uMid, uHighMid, uAir;
uniform float uKick, uSnare, uHat, uEnergy, uBrightness, uFlux;
uniform float uBeatPhase, uBuild, uDrop, uSway, uBeat, uBeatCount, uBpm;
uniform sampler2D uSpectrum;
uniform sampler2D uWaveform;
uniform sampler2D uNoiseTex;
uniform vec3 uBg, uFg, uAccent, uAccent2, uMuted;
uniform float uFeelIntensity, uFeelTension, uFeelRelease, uFeelWarmth;
uniform float uFeelToDrop, uFeelSinceDrop, uFeelSectionT, uFeelSongT;
uniform float uFeelGust, uFeelWindPhase, uFeelDay, uFeelLight;
uniform vec2 uFeelWind;
`;

export const GLSL_COMMON = /* glsl */ `
#define PI 3.14159265359
#define TAU 6.28318530718

float hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }

float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}

vec3 _mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 _mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 _mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 _permute(vec3 x) { return _mod289(((x * 34.0) + 1.0) * x); }
vec4 _permute(vec4 x) { return _mod289(((x * 34.0) + 1.0) * x); }
vec4 _taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = _mod289(i);
  vec3 p = _permute(_permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = _mod289(i);
  vec4 p = _permute(_permute(_permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = _taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

float fbm(vec2 p, int oct) {
  float a = 0.5; float s = 0.0;
  for (int i = 0; i < 8; i++) { if (i >= oct) break; s += a * snoise(p); p = p * 2.02 + 17.1; a *= 0.5; }
  return s;
}
float fbm3(vec3 p, int oct) {
  float a = 0.5; float s = 0.0;
  for (int i = 0; i < 8; i++) { if (i >= oct) break; s += a * snoise(p); p = p * 2.02 + 17.1; a *= 0.5; }
  return s;
}

mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

float tnoise(vec2 x) {
  vec2 i = floor(x); vec2 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return texture2D(uNoiseTex, (i + f + 0.5) / 256.0).r;
}
vec4 tnoise4(vec2 x) {
  vec2 i = floor(x); vec2 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return texture2D(uNoiseTex, (i + f + 0.5) / 256.0);
}
float tnoise3(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  vec2 rg = texture2D(uNoiseTex, (i.xy + vec2(37.0, 17.0) * i.z + f.xy + 0.5) / 256.0).rg;
  return mix(rg.x, rg.y, f.z);
}
float tfbm(vec2 p, int oct) {
  float a = 0.5; float s = 0.0;
  for (int i = 0; i < 8; i++) { if (i >= oct) break; s += a * (tnoise(p) * 2.0 - 1.0); p = rot2(0.6) * p * 2.02 + 17.1; a *= 0.5; }
  return s;
}
float tfbm3(vec3 p, int oct) {
  float a = 0.5; float s = 0.0;
  for (int i = 0; i < 8; i++) { if (i >= oct) break; s += a * (tnoise3(p) * 2.0 - 1.0); p = p * 2.02 + vec3(17.1, 9.2, 5.3); a *= 0.5; }
  return s;
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 cosPalette(float t, vec3 a, vec3 b, vec3 c, vec3 d) { return a + b * cos(TAU * (c * t + d)); }
vec3 paletteRamp(float t) {
  t = clamp(t, 0.0, 1.0);
  if (t < 0.33) return mix(uBg, uAccent, t / 0.33);
  if (t < 0.66) return mix(uAccent, uAccent2, (t - 0.33) / 0.33);
  return mix(uAccent2, uFg, (t - 0.66) / 0.34);
}
float spectrum(float x) { return texture2D(uSpectrum, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }
float waveform(float x) { return texture2D(uWaveform, vec2(clamp(x, 0.0, 1.0), 0.5)).r * 2.0 - 1.0; }
vec2 coverUv(vec2 uv, vec2 texSize, float aspect) {
  float ta = texSize.x / max(texSize.y, 1.0);
  vec2 s = aspect > ta ? vec2(1.0, ta / aspect) : vec2(aspect / ta, 1.0);
  return (uv - 0.5) * s + 0.5;
}
vec2 containUv(vec2 uv, vec2 texSize, float aspect) {
  float ta = texSize.x / max(texSize.y, 1.0);
  vec2 s = aspect > ta ? vec2(aspect / ta, 1.0) : vec2(1.0, ta / aspect);
  return (uv - 0.5) * s + 0.5;
}
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float sdCircle(vec2 p, float r) { return length(p) - r; }
float bayer8(vec2 fc) {
  vec2 p = mod(floor(fc), 8.0);
  float v = 0.0;
  float s = 1.0;
  // recursive 2x2 bayer, 3 levels
  for (int i = 0; i < 3; i++) {
    vec2 q = mod(floor(p / s), 2.0);
    v = v * 4.0 + (q.x == 0.0 ? (q.y == 0.0 ? 0.0 : 2.0) : (q.y == 0.0 ? 3.0 : 1.0));
    s *= 2.0;
  }
  // bit-reversed order is fine for a threshold map
  return (v + 0.5) / 64.0;
}
`;

export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

import type { ParamDef } from './types';

/** GLSL uniform declarations for a param list (u_<id>). */
export function paramUniformDecls(params: ParamDef[]): string {
  return params
    .map((p) => (p.type === 'color' ? `uniform vec3 u_${p.id};` : `uniform float u_${p.id};`))
    .join('\n');
}
