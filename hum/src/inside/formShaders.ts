/**
 * What the forms of an inside shot (forms.ts) are drawn with. Solid ones take their light from the clip:
 * the side of the frame that is bright is the side they are lit from, what they face they pick up, and far
 * off they fade into what is round them. Where the picture is painted in flat colours they are too, in
 * three tones. Ones lifted from the picture are marched through per pixel: the shape of the people, or the
 * marks on the ground, pulled into the third dimension.
 */
export const FORM_LIGHT = /* glsl */ `
vec3 around(vec2 at, float r) {
  vec3 s = vec3(0.0);
  for (int k = 0; k < 10; k++) {
    float t = float(k) * 2.399963;
    float q = sqrt((float(k) + 0.5) / 10.0) * r;
    s += texture2D(tFootage, clipUv(clamp(at + vec2(cos(t), sin(t)) * q, 0.01, 0.99))).rgb;
  }
  return s / 10.0;
}
/** where the light is: toward the brighter side of the frame, and from above */
vec3 sunDir() {
  float l = luma(around(vec2(0.15, 0.6), 0.16));
  float r = luma(around(vec2(0.85, 0.6), 0.16));
  float u = luma(around(vec2(0.5, 0.88), 0.12));
  float d = luma(around(vec2(0.5, 0.2), 0.16));
  return normalize(vec3((r - l) * 2.6, 0.75 + (u - d) * 0.8, 0.55));
}
`;

export const FORM_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vP;
varying float vW;
uniform float uPluck, uTime;
void main() {
  vec3 p = position;
  vec4 w = modelMatrix * vec4(p, 1.0);
  // a string plucked: it swings most in its middle
  if (uPluck > 0.0) {
    float m = sin(clamp(uv.y, 0.0, 1.0) * 3.14159);
    w.x += m * uPluck * sin(uTime * 34.0 + w.z * 3.1 + float(int(w.x * 7.0)));
  }
  vP = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
  vW = gl_Position.w;
}
`;

export const FORM_FRAG = (HIDE: string, CLIP: string) => /* glsl */ `
precision highp float;
${HIDE}
${CLIP}
${FORM_LIGHT}
varying vec3 vN;
varying vec3 vP;
uniform vec3 uEye, uColor, uLightC, uInk, uLamp;
uniform float uAlpha, uCel, uShine, uFog, uDim;
void main() {
  float show = showing();
  if (show * uAlpha < 0.01) discard;
  vec2 f = gl_FragCoord.xy / uRes;
  vec3 N = normalize(vN);
  vec3 V = normalize(vP - uEye);
  if (dot(N, V) > 0.0) N = -N;
  vec3 R = reflect(V, N);
  vec3 sun = sunDir();
  float lit = dot(N, sun) * 0.5 + 0.5;
  // what it faces, spread wide; and what it mirrors
  vec3 amb = around(0.5 + N.xy * 0.34, 0.2);
  vec3 mir = around(clamp(0.5 + R.xy / (abs(R.z) + 0.75) * 0.62, 0.02, 0.98), mix(0.09, 0.006, uShine));
  // at night there is no sky to light it: it is a lamp itself
  float dim = uDim;
  float fres = pow(1.0 - clamp(-dot(N, V), 0.0, 1.0), 4.0);
  // as light as the brightest of the place, not its average: a thing in the open catches the sky
  vec3 top = around(vec2(0.5, 0.82), 0.3);
  vec3 sky = max(amb, top);
  sky = mix(vec3(luma(sky)), sky, 0.75) / max(0.45, luma(sky)) * max(0.4, luma(sky));
  vec3 nat = uColor * (sky * 1.1 + 0.08) * mix(0.34, 1.55, lit * lit);
  nat = mix(nat, mir * mix(vec3(1.0), uColor * 1.4, 0.35), clamp(uShine * 0.85 + fres * 0.6, 0.0, 1.0));
  nat = mix(nat, uLamp * mix(0.62, 1.12, lit) + fres * 0.2, dim * 0.9 * (1.0 - uShine));
  // three tones, the picture's own when it is painted
  float tone = lit + (luma(amb) - 0.4) * 0.15;
  vec3 cel = tone > 0.72 ? uLightC : tone > 0.46 ? uColor : mix(uColor, uInk, 0.62);
  if (uShine > 0.5) cel = mix(cel, uLightC, step(0.62, luma(mir)));
  vec3 c = mix(nat, cel, uCel);
  float fog = (1.0 - exp(-vW / uFog)) * 0.4;
  c = mix(c, around(f, 0.07), fog * (1.0 - uCel * 0.75));
  float a = show * uAlpha;
  gl_FragColor = vec4(c * a, a);
}
`;

export const FORM_SHADOW_FRAG = (HIDE: string) => /* glsl */ `
precision highp float;
${HIDE}
varying vec3 vN;
varying vec3 vP;
uniform float uAlpha;
uniform vec3 uInk;
void main() {
  // on the ground itself a point is exactly as near as the picture there: a little give, or it would flicker
  float n = texture2D(tNear, gl_FragCoord.xy / uRes).r;
  float me = uZScale / vW;
  float a = uAlpha * (1.0 - smoothstep(me * 1.22, me * 1.45, n)) * smoothstep(me * 0.5, me * 0.72, n);
  if (a < 0.01) discard;
  gl_FragColor = vec4(uInk * 0.0, a);
}
`;

/** what stands in the shot, pulled back toward the vanishing point as a solid */
export const EXTRUDE_FRAG = (CLIP: string) => /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tNear;
uniform vec2 uRes;
uniform float uZScale;
${CLIP}
uniform vec2 uVp, uDrift;
uniform sampler2D tWho;
uniform vec3 uGround, uA, uB, uInk;
uniform float uCut, uDepth, uBands, uPhase, uAlpha, uCel, uTwist;
const int N = 110;
float standing(vec2 f) {
  if (f.x < 0.0 || f.x > 1.0 || f.y < 0.0 || f.y > 1.0 || texture2D(tWho, f).r < 0.4) return 0.0;
  float n = texture2D(tNear, f).r;
  float g = max(0.0, uGround.x * f.x + uGround.y * f.y + uGround.z);
  return (n > uCut && n > g * 1.14) ? n : 0.0;
}
vec2 back(float q) {
  float s = 1.0 + uDepth * q;
  vec2 asp = vec2(uRes.x / uRes.y, 1.0);
  float c = cos(uTwist * q), k = sin(uTwist * q);
  vec2 d = (vUv - uDrift * q - uVp) * asp;
  return uVp + mat2(c, k, -k, c) * d / asp * s;
}
void main() {
  float here = texture2D(tNear, vUv).r;
  if (standing(vUv) > 0.0) discard;
  float hit = 0.0, k = 0.0, was = 0.0;
  for (int i = 1; i <= N; i++) {
    float q = float(i) / float(N);
    q = q * (0.35 + 0.65 * q);
    float n = standing(back(q));
    float s = 1.0 + uDepth * q;
    bool on = n > 0.0 && here < n / s * 1.2 + 0.003;
    if (on && uBands > 0.5 && fract(q * uBands - uPhase) > 0.3) on = false;
    if (on) { hit = 1.0; k = q; break; }
    was = q;
  }
  if (hit < 0.5) discard;
  for (int i = 0; i < 6; i++) {
    float m = (was + k) * 0.5;
    if (standing(back(m)) > 0.0) k = m; else was = m;
  }
  vec2 at = back(k);
  vec2 e = 5.0 / uRes;
  vec2 g = vec2(standing(at + vec2(e.x, 0.0)) - standing(at - vec2(e.x, 0.0)), standing(at + vec2(0.0, e.y)) - standing(at - vec2(0.0, e.y)));
  vec2 nrm = length(g) > 1e-4 ? -normalize(g) : vec2(0.0, 0.4);
  float lit = 0.5 + 0.5 * dot(nrm, normalize(vec2(-0.5, 0.85)));
  // the side of it carries the colour at its edge, pulled along
  vec3 own = texture2D(tFootage, clipUv(mix(at, uVp, 0.0) - nrm * 6.0 / uRes)).rgb;
  vec3 far = texture2D(tFootage, clipUv(vUv)).rgb;
  vec3 nat = (own * 0.75 + uA * 0.22) * mix(0.45, 1.35, lit);
  nat = mix(nat, far, smoothstep(0.25, 1.0, k) * 0.75);
  vec3 cel = mix(uA, uB, smoothstep(0.0, 0.8, k));
  cel = lit > 0.62 ? cel : mix(cel, uInk, lit > 0.34 ? 0.3 : 0.6);
  vec3 c = mix(nat, cel, uCel);
  float a = uAlpha * (1.0 - smoothstep(0.8, 1.0, k) * (1.0 - uCel));
  gl_FragColor = vec4(c * a, a);
}
`;

/** the light marks on the ground (a crossing, lane lines, a reflection), raised as blocks */
export const RAISE_FRAG = (CLIP: string) => /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tNear;
uniform vec2 uRes;
uniform float uZScale, uEyeH, uHeight, uThr, uTime, uAlpha, uCel, uReach, uStart;
${CLIP}
uniform vec3 uE0, uE1;
uniform vec3 uGround, uTop, uSide, uInk;
const int N = 64;
vec2 down(vec2 xw) {
  // a point on the ground, across xw.x at distance xw.y, in the frame
  float nx = (uE0.x * xw.x + uE0.y * (-uEyeH)) / xw.y - uE0.z;
  float ny = (uE1.x * xw.x + uE1.y * (-uEyeH)) / xw.y - uE1.z;
  return vec2(nx, ny) * 0.5 + 0.5;
}
float mark(vec2 f) {
  if (f.x < 0.0 || f.x > 1.0 || f.y < 0.0 || f.y > 1.0) return 0.0;
  float n = texture2D(tNear, f).r;
  float g = uGround.x * f.x + uGround.y * f.y + uGround.z;
  if (g < 0.002 || abs(n / g - 1.0) > 0.2) return 0.0;
  return step(uThr, luma(texture2D(tFootage, clipUv(f)).rgb));
}
float tall(vec2 xw) {
  float wave = sin(xw.y * 0.55 - uTime * 2.2) * 0.5 + 0.5;
  return uHeight * (0.45 + 0.55 * wave) * smoothstep(uReach, uReach * 0.75, xw.y) * smoothstep(uStart, uStart * 1.35, xw.y);
}
void main() {
  float here = texture2D(tNear, vUv).r;
  vec2 nd = vUv * 2.0 - 1.0 + vec2(uE0.z, uE1.z);
  float d = uE0.x * uE1.y - uE0.y * uE1.x;
  float Xd = (nd.x * uE1.y - uE0.y * nd.y) / d;
  float Yd = (uE0.x * nd.y - uE1.x * nd.x) / d;
  float hit = 0.0, top = 0.0;
  vec2 at = vUv, xw = vec2(0.0);
  float H = 0.0, h = 0.0;
  for (int i = 0; i < N; i++) {
    h = uHeight * (1.0 - float(i) / float(N - 1));
    float w = (h - uEyeH) / (abs(Yd) < 1e-5 ? -1e-5 : Yd);
    if (w < 0.6 || w > uReach) continue;
    vec2 p = vec2(Xd * w, w);
    H = tall(p);
    if (h > H) continue;
    vec2 f = down(p);
    if (mark(f) < 0.5) continue;
    if (here > uZScale / w * 1.3 + 0.004) continue;
    hit = 1.0; at = f; xw = p;
    top = 1.0 - smoothstep(0.0, uHeight / float(N) * 1.6, H - h);
    break;
  }
  if (hit < 0.5) discard;
  vec3 own = texture2D(tFootage, clipUv(at)).rgb;
  float v = clamp(h / max(H, 1e-3), 0.0, 1.0);
  vec3 side = mix(uInk, uSide, 0.25 + 0.75 * v);
  side = mix(own * mix(0.16, 0.5, v), side, uCel);
  vec3 c = mix(side, mix(own * 1.06, uTop, uCel), top);
  gl_FragColor = vec4(c * uAlpha, uAlpha);
}
`;
