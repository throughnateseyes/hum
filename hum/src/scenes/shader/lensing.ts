import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../../core/glsl';
import { buildSceneFragment, createFullscreenQuad } from '../../core/sceneHelpers';
import type { ParamDef, SceneDef, SceneInit, SceneInstance } from '../../core/types';
import { createBaseUniforms, num, updateBaseUniforms, updateParamUniforms } from '../../core/uniforms';
import { Spring, approach, stepDt } from '../three/common';
import { HM_LIB } from './lib';

/**
 * Lensing: light falling past a mass. Dozens of clean gradient lines come down from the top of the
 * frame, and around a small glowing orb near the bottom they bend into nested U's and climb out the
 * other side, so the orb sits in a cradle of light like a weight on a stretched sheet.
 *
 * The lines are the level lines of one field, f(z) = Σ m · (z − c)^α per orb (the angle is measured
 * from straight down, so each orb's seam points up). Level lines of a harmonic field can never close
 * into loops or cross, so however the orbs move and grow the picture stays ordered: evenly spaced
 * strands, never a tangle. α is the fan: at ½ every strand falls straight down and wraps into a
 * parabola under the orb; towards 1 the arms tilt out and the field opens into a wide fan. The
 * companion field (the imaginary part) runs along each strand, which carries the colour gradient
 * (left arm → under the orb → right arm, through the palette) and the pulses of light that travel
 * down one arm and up the other.
 *
 * The music:
 *   bass and kicks are the orb's mass: it swells, and the innermost strands are pushed out and wrap
 *     tighter round it, so lines bend harder on every hit; a kick also sends a soft kink out along
 *     the field like a ripple through a sheet
 *   a build opens the fan (α climbs) and adds strands; the lines spread
 *   the drop flares the orb and whips the field outward: the fan overshoots wide and springs back
 *     while a big kink races out along every strand; loud parts bring one or two more orbs, and the
 *     strands weave round all of them
 *   breakdowns keep one orb with the lines gently breathing; in a break the orb can resolve into a
 *     slowly turning sphere of dots
 *
 * Palette roles: bg = the dark ground · accent = the left (incoming) end of each strand · muted =
 * the bottom of the U · accent2 = the right (outgoing) end · fg = the orb and the brightest light.
 * On a light palette the strands print as ink on paper instead of glowing.
 */

const MAX_ORBS = 3;

const params: ParamDef[] = [
  { id: 'lines', label: 'Lines', group: 'Shape', type: 'number', min: 8, max: 60, step: 1, default: 15, hint: 'Strands on each side of the orb; a build adds a few' },
  { id: 'weight', label: 'Line weight', group: 'Shape', type: 'number', min: 0.6, max: 12, step: 0.1, default: 5, hint: 'Stroke width in px of a 1080p frame' },
  { id: 'spread', label: 'Fan', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.25, hint: '0: strands fall straight down; 1: they fan wide around the orb' },
  { id: 'orbSize', label: 'Orb size', group: 'Shape', type: 'number', min: 0.4, max: 2, step: 0.01, default: 1 },
  { id: 'orbs', label: 'Extra orbs', group: 'Shape', type: 'number', min: 0, max: 2, step: 1, default: 2, hint: 'Companions that join in the loud parts; breakdowns always keep one' },
  { id: 'frame', label: 'Margin', group: 'Shape', type: 'number', min: 0, max: 0.2, step: 0.005, default: 0.06, hint: 'An inset frame where the strands stop, like a printed poster' },
  { id: 'bend', label: 'Mass', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'How much bass and kicks swell the orb and bend the strands round it' },
  { id: 'whip', label: 'Whip', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'Kinks sent out along the field by kicks, and the big whip on the drop' },
  { id: 'flow', label: 'Light flow', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'Pulses of light running down one arm and up the other' },
  { id: 'breath', label: 'Breathing', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'The slow rise and fall of the strands in quiet parts' },
  { id: 'sphere', label: 'Dot sphere', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 1, hint: 'In a break the orb resolves into a turning sphere of dots' },
  { id: 'glow', label: 'Glow', group: 'Color', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
  { id: 'grain', label: 'Grain', group: 'Color', type: 'number', min: 0, max: 0.1, step: 0.002, default: 0.018 },
];

const fragment = /* glsl */ `
${HM_LIB}
#define LN_ORBS ${MAX_ORBS}
uniform vec4 uOrb[LN_ORBS];   // xy centre (units: half the short side), z radius, w mass (0 = absent)
uniform float uBeta;          // radial exponent: 1 straight strands, more leans them in toward the mass
uniform float uSpacing;       // field units per strand (before the evenness curve)
uniform float uGamma;         // evenness curve: strands sit at integer (psi / spacing)^gamma
uniform float uFan;           // how far the strands open into rays above the orb
uniform vec4 uWhip;           // x radius of the whip front past the orb's rim, y push (units), z width
uniform float uFlowPh;        // phase of the travelling light
uniform float uFlowAmt;
uniform float uFlare;         // the drop's flash, 0..1+
uniform float uSphere;        // 0 disc .. 1 dot sphere
uniform float uSphereRot;
uniform vec2 uExt;            // half extents of the frame in units
uniform float uMargin;

const float LN_SEAM = 0.985;

// psi: level field (strands are its level lines) · phi: companion field running along each strand
// g: gradient of psi. Per orb: psi = m · rho^beta · f(cos(theta / 2)), with rho measured from the orb's rim
// and theta from straight down. With beta = 1 the strands fall straight and parallel either side of
// the orb and wrap beneath it in evenly spaced curves; beta above 1 leans them in toward the mass.
// Each term is eased flat in a narrow band at its seam (straight up), so no term creases where it
// meets another orb's field. The whole field is read through two smooth warps: a fan that squeezes x
// with height above the main orb, so the falling strands open into rays, and the whip, a ring that
// pushes the field outward from the main orb. Smooth invertible warps can never make strands cross.
void lnField(vec2 p, out float psi, out float phi, out vec2 g) {
  psi = 0.0; phi = 0.0;
  float b = uBeta;
  vec2 c0 = uOrb[0].xy;
  // the whip: radial push D(r) = A * 1.65 * x * exp(-x^2), x = (r - front) / width
  vec2 q0 = p - c0;
  float r0 = max(length(q0), 1e-4);
  vec2 e0 = q0 / r0;
  float rr0 = max(r0 - uOrb[0].z, 0.0);
  float xw = (rr0 - uWhip.x) / uWhip.z;
  float ew = exp(-xw * xw);
  float D = uWhip.y * 1.65 * xw * ew;
  float dD = uWhip.y * 1.65 * (1.0 - 2.0 * xw * xw) * ew / uWhip.z;
  vec2 pk = p - e0 * D;
  // fan warp: x' = x / s(y), s = 1 + fan * softplus(y - y0)
  float dy = pk.y - c0.y;
  float sp = log(1.0 + exp(dy * 3.0)) / 3.0;
  float sg = 1.0 / (1.0 + exp(-dy * 3.0));
  float sw = 1.0 + uFan * sp;
  vec2 pw = vec2(pk.x / sw, pk.y);
  vec2 gw = vec2(0.0);
  for (int i = 0; i < LN_ORBS; i++) {
    vec4 o = uOrb[i];
    if (o.w < 1e-4) continue;
    vec2 oc = i == 0 ? o.xy : vec2(o.x / (1.0 + uFan * log(1.0 + exp((o.y - c0.y) * 3.0)) / 3.0), o.y);
    vec2 q = pw - oc;
    float r = max(length(q), 1e-4);
    float rho = max(r - o.z * LN_SEAM, 1e-4);
    float th = atan(q.x, -q.y);
    float u = PI - abs(th);
    float e = exp(-u / 0.55);
    float ts = sign(th) * (PI - u * (1.0 - e));
    float dts = 1.0 - e + (u / 0.55) * e;
    float rb = pow(rho, b);
    float c = cos(0.5 * ts);
    float s = sin(0.5 * ts);
    // f(c) = c - c^2/2 halves the field straight below the orb, so the wraps there keep the same gaps
    // as the falling arms, and flattens the bottom of each U into a broad round arc
    float fc = c - 0.5 * c * c;
    psi += o.w * rb * fc;
    phi += o.w * rb * s;
    vec2 er = q / r;
    vec2 et = vec2(-er.y, er.x);
    gw += o.w * rb * (er * (b * fc / rho) - et * ((1.0 - c) * 0.5 * s * dts / r));
  }
  // back through the fan, then the whip (chain rule)
  vec2 gk = vec2(gw.x / sw, gw.y - gw.x * pk.x * uFan * sg / (sw * sw));
  vec2 t0 = vec2(-e0.y, e0.x);
  g = e0 * dot(gk, e0) * (1.0 - dD) + t0 * dot(gk, t0) * (1.0 - D / r0);
}

// the dot sphere: a lat-long lattice of dots on a turning ball (n = unit normal, view space)
float lnDots(vec3 n, float rot, float px, out float shade) {
  float ct = cos(0.42), st = sin(0.42);
  n = vec3(n.x, ct * n.y - st * n.z, st * n.y + ct * n.z);
  float cr = cos(rot), sr = sin(rot);
  n = vec3(cr * n.x + sr * n.z, n.y, -sr * n.x + cr * n.z);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(n.x, n.z);
  const float ROWS = 15.0;
  float step = PI / ROWS;
  float best = 1e3;
  for (int k = -1; k <= 1; k++) {
    float row = floor(lat / step + 0.5) + float(k);
    float la = row * step;
    if (abs(la) > PI * 0.5 + 1e-3) continue;
    float cnt = max(1.0, floor(cos(la) * 2.0 * ROWS + 0.5));
    float ls = TAU / cnt;
    float lo = (floor(lon / ls + 0.5)) * ls;
    vec3 d = vec3(cos(la) * sin(lo), sin(la), cos(la) * cos(lo));
    best = min(best, length(d - n));
  }
  shade = 0.0;
  float rad = step * 0.24;
  return clamp(0.5 - (best - rad) / px, 0.0, 1.0);
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  float unitPx = 0.5 * min(uResolution.x, uResolution.y);
  float px = 1.0 / unitPx;               // one pixel in field units
  float k1080 = unitPx / 540.0;          // stroke sizes are given in px of a 1080p frame
  vec2 p = (fc - 0.5 * uResolution) * px;
  bool light = hmIsLight() > 0.5;

  float psi, phi; vec2 g;
  lnField(p, psi, phi, g);

  vec4 o0 = uOrb[0];
  float r0 = length(p - o0.xy);
  float rr = max(r0 - o0.z, 0.0);

  // strands: integer values of L = (psi / spacing)^gamma, offset by a half so the seam sits between two
  float Lr = psi / uSpacing;
  float La = abs(Lr);
  float L = sign(Lr) * pow(La, uGamma);
  vec2 gL = g * (uGamma * pow(max(La, 1e-4), uGamma - 1.0) / uSpacing);
  float gl = max(length(gL), 1e-6);
  float f = fract(L) - 0.5;
  float idx = floor(L);
  float dPx = abs(f) / gl / px;           // px from the nearest strand
  float gapPx = 1.0 / gl / px;            // px between strands here

  float w = u_weight * k1080;
  float core = clamp(0.5 * w - dPx + 0.5, 0.0, 1.0);
  // crowded strands melt into their average instead of aliasing
  float crowd = smoothstep(2.2 * w + 2.0, 1.1 * w + 1.0, gapPx);
  core = mix(core, min(1.0, w / max(gapPx, 1e-3)) * 0.85, crowd);
  float glowR = (3.0 + 2.5 * u_glow) * k1080 + 0.35 * w;
  float halo = exp(-dPx / glowR) * (1.0 - crowd) * 0.32 * u_glow;

  // the open seam above each orb (negative levels) stays dark; the strands fade in from it
  float pos = smoothstep(-0.2, 0.6, L);
  // margin: strands stop at an inset frame with crisp ends
  vec2 inset = uExt - uMargin;
  float inFrame = clamp(0.5 - (max(abs(p.x) - inset.x, abs(p.y) - inset.y)) / px, 0.0, 1.0);
  float vis = pos * inFrame;

  // colour along the strand: left arm -> under the orb -> right arm, by the angle round the main orb
  float th0 = atan(p.x - o0.x, -(p.y - o0.y));
  float u = clamp(th0 / PI * 0.5 + 0.5, 0.0, 1.0);
  float lane = clamp(idx / max(u_lines, 1.0), 0.0, 1.0);
  vec3 cL = uAccent, cM = uMuted, cR = uAccent2;
  if (!light) {
    // keep dark-palette strands luminous even if a role is dim
    cM = mix(cM, mix(uAccent, uAccent2, 0.5), smoothstep(0.35, 0.05, luma(cM)));
  }
  float uu = clamp(u + (lane - 0.5) * 0.18, 0.0, 1.0);
  vec3 strand = uu < 0.5 ? mix(cL, cM, smoothstep(0.0, 0.5, uu)) : mix(cM, cR, smoothstep(0.5, 1.0, uu));
  // outer lanes drift toward the light colour a touch, so the fan reads as depth
  strand = mix(strand, uFg, 0.12 * lane * (1.0 - hmIsLight()));

  // light running along the strands: down one arm, round, up the other
  float along = phi / uSpacing;
  float ph = along * 0.42 - uFlowPh + hash11(idx * 7.31 + 3.1) * 6.0;
  float pulse = pow(0.5 + 0.5 * cos(ph), 14.0) * uFlowAmt;
  // strands near the orb catch more of its light
  float nearOrb = exp(-rr / (0.55 + 0.4 * uFlare));
  float bright = 0.82 + 0.5 * pulse + 0.35 * nearOrb * (0.6 + uFlare);

  vec3 col = uBg;
  // a breath of the orb's light in the ground behind it
  col += (light ? -0.04 : 0.06) * uFg * exp(-rr / 0.9) * (0.5 + uFlare);
  if (light) {
    vec3 ink = strand * (0.9 - 0.25 * pulse);
    col = mix(col, ink, core * vis);
    col = mix(col, ink, halo * vis * 0.35);
  } else {
    col += strand * bright * (core + halo) * vis;
  }

  // the orbs, drawn over the strands
  for (int i = 0; i < LN_ORBS; i++) {
    vec4 o = uOrb[i];
    if (o.w < 1e-4 || o.z < 1e-4) continue;
    vec2 q = p - o.xy;
    float r = length(q);
    float R = o.z;
    float isMain = i == 0 ? 1.0 : 0.0;
    float edge = clamp(0.5 - (r - R) / px, 0.0, 1.0);
    // halo: soft light round the body, a flare on the drop
    float hl = exp(-max(r - R, 0.0) / (R * (0.5 + 1.6 * uFlare * isMain))) * (0.22 + 0.9 * uFlare * isMain) * u_glow;
    if (light) col = mix(col, mix(uFg, uMuted, 0.4), hl * 0.25 * (1.0 - edge));
    else col += mix(uFg, uMuted, 0.35) * hl * (1.0 - edge);
    if (edge <= 0.0) continue;
    // body: a soft gradient lit from the upper left, with a thin bright rim
    vec2 qn = q / R;
    float lit = clamp(0.62 - 0.4 * dot(qn, vec2(0.62, -0.62)), 0.0, 1.0);
    vec3 tone = mix(uMuted, uFg, 0.25);
    vec3 body = mix(tone * 0.92, mix(tone, uFg, 0.75), lit);
    body = mix(body, mix(uAccent2, uFg, 0.45), 0.3 * smoothstep(0.3, 1.1, length(qn + vec2(0.35, 0.4))));
    body += uFlare * isMain * 0.5;
    // the dot sphere (main orb only): dark ball, a lattice of lit dots turning slowly
    if (uSphere > 0.001 && i == 0) {
      float zz = sqrt(max(0.0, 1.0 - dot(qn, qn)));
      vec3 n = vec3(qn, zz);
      float sh;
      float dots = lnDots(n, uSphereRot, px / R * 1.0, sh);
      float lam = clamp(dot(n, normalize(vec3(-0.45, 0.55, 0.7))), 0.0, 1.0);
      vec3 ball = mix(uBg, mix(uMuted, uAccent, 0.4), 0.12 + 0.12 * lam);
      if (light) ball = mix(uBg, uMuted, 0.25 + 0.2 * lam);
      vec3 dotC = mix(mix(uMuted, uFg, 0.5), uFg, 0.4 + 0.6 * lam) * (0.35 + 0.9 * lam);
      if (light) dotC = mix(uFg, uAccent, 0.3);
      ball = mix(ball, dotC, dots * (0.25 + 0.75 * smoothstep(0.0, 0.35, zz)));
      body = mix(body, ball, uSphere);
    }
    float rim = exp(-abs(r - R) / (1.6 * px * k1080)) * 0.5;
    body += (light ? -0.15 : 0.35) * rim * uFg * (1.0 - 0.6 * uSphere);
    col = mix(col, body, edge);
  }

  col += hmGrain(fc, uTime) * u_grain;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

interface OrbState {
  x: number;
  y: number;
  r: number;
  m: number;
}

function create(init: SceneInit): SceneInstance {
  const orbData = new Float32Array(MAX_ORBS * 4);
  const uniforms = {
    ...createBaseUniforms(init.shared, params),
    uOrb: { value: orbData },
    uBeta: { value: 1 },
    uSpacing: { value: 0.05 },
    uGamma: { value: 1 },
    uFan: { value: 0 },
    uWhip: { value: new THREE.Vector4(0, 0, 0.2, 0.3) },
    uFlowPh: { value: 0 },
    uFlowAmt: { value: 0.5 },
    uFlare: { value: 0 },
    uSphere: { value: 0 },
    uSphereRot: { value: 0 },
    uExt: { value: new THREE.Vector2(1, 1) },
    uMargin: { value: 0.06 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: buildSceneFragment(fragment, params),
    depthTest: false,
    depthWrite: false,
  });
  const quad = createFullscreenQuad(material);

  // the fan: underdamped so the drop's whip overshoots and rings out
  const fan = new Spring(26, 4.2, 0.6);
  // the main orb's size: kicks punch it, it rebounds once
  const swell = new Spring(260, 15, 0);
  const orbs: OrbState[] = [0, 1, 2].map((i) => ({ x: 0, y: 0, r: 0, m: i === 0 ? 1 : 0 }));
  let started = false;
  let spacing = 0.05;
  let flowPh = 0;
  let flowAmt = 0;
  let sinceKick = 100;
  let kickAmp = 0;
  let sinceDrop = 100;
  let prevDrop = 0;
  let breathPh = 0;
  let sphere = 0;
  let sphereRot = 0;
  let wander = 0;
  let extra = 0;
  let dense = 0;

  // the same field as the shader (psi only), to keep the strands filling the frame as things change
  const soft = (x: number) => Math.log(1 + Math.exp(x * 3)) / 3;
  const psiAt = (x: number, y: number, b: number, fanK: number) => {
    let s = 0;
    const y0 = orbs[0].y;
    const xw = x / (1 + fanK * soft(y - y0));
    for (let i = 0; i < MAX_ORBS; i++) {
      const o = orbs[i];
      if (o.m < 1e-4) continue;
      const ox = i === 0 ? o.x : o.x / (1 + fanK * soft(o.y - y0));
      const qx = xw - ox;
      const qy = y - o.y;
      const r = Math.max(Math.hypot(qx, qy), 1e-4);
      const rho = Math.max(r - o.r * 0.985, 1e-4);
      const th = Math.atan2(qx, -qy);
      const u = Math.PI - Math.abs(th);
      const ts = Math.sign(th) * (Math.PI - u * (1 - Math.exp(-u / 0.55)));
      const c = Math.cos(0.5 * ts);
      s += o.m * Math.pow(rho, b) * (c - 0.5 * c * c);
    }
    return s;
  };

  return {
    render(frame, target) {
      const dt = stepDt(frame);
      const P = frame.params;
      const a = frame.audio;
      const feel = frame.feel;
      const W = frame.width;
      const H = frame.height;
      const ex = W / Math.min(W, H);
      const ey = H / Math.min(W, H);
      const portrait = clamp01((ey - 1) / 0.78);
      const bend = num(P, 'bend', 1);
      const whipK = num(P, 'whip', 1);
      const orbSize = num(P, 'orbSize', 1);
      const maxExtra = Math.round(num(P, 'orbs', 2));
      const margin = num(P, 'frame', 0.06);

      // the song's state
      const sec = feel.section;
      const intensity = feel.intensity;
      const tension = Math.max(feel.tension, a.build);
      const quiet = sec === 'break' || (sec !== 'drop' && sec !== 'chorus' && intensity < 0.3);
      const dropEdge = a.drop > 0.6 && prevDrop <= 0.6;
      prevDrop = a.drop;
      if (dropEdge || (feel.sinceDrop < 0.05 && sinceDrop > 2)) sinceDrop = 0;
      else sinceDrop = Math.min(100, sinceDrop + dt);
      if (a.kickHit) {
        sinceKick = 0;
        kickAmp = Math.max(0.35, a.kick);
      } else sinceKick = Math.min(100, sinceKick + dt);

      // the fan: quiet parts fall nearly straight, builds open it, the drop whips it wide
      const base = 0.6 * num(P, 'spread', 0.25);
      const fanTarget = base * (0.8 + 0.3 * intensity) + 0.55 * tension - (quiet ? 0.08 : 0);
      if (!started) fan.value = fanTarget;
      if (sinceDrop === 0) fan.vel += 4.5 * whipK;
      const fanK = Math.max(-0.12, fan.step(fanTarget, dt));

      // the main orb: low and centred, a little higher in landscape; mass from bass, kicks punch it
      const R0 = 0.13 * orbSize * (1 + 0.15 * portrait);
      if (a.kickHit) swell.vel += 3.2 * kickAmp * bend;
      if (sinceDrop === 0) swell.vel += 6 * bend;
      const pump = swell.step(0, dt);
      // mass: the strands lean in toward the orb with the low end and on every hit
      const beta = 1 + bend * (0.06 * a.bass * intensity + 0.16 * Math.max(0, pump));
      sphere = approach(sphere, quiet && sec === 'break' ? num(P, 'sphere', 1) : 0, sphere < 0.5 ? 0.7 : 1.4, dt);
      const main = orbs[0];
      main.x = 0;
      main.y = -ey * (0.3 + 0.16 * portrait);
      main.r = R0 * (1 + 0.28 * bend * (0.6 * a.bass + 0.4 * a.sub) * (0.4 + 0.6 * intensity) + 0.22 * pump + 0.55 * sphere);
      main.m = 1;

      // companions: join in loud parts, drift slowly, never in a break
      wander += dt * (0.05 + 0.08 * intensity);
      // a build draws them back into the main orb; the drop throws them out again
      const loud = sec === 'drop' || sec === 'chorus' || intensity > 0.75;
      const wantExtra = quiet || !loud ? 0 : (smooth(0.55, 0.85, intensity) * maxExtra + (feel.sinceDrop < 8 ? 0.6 : 0)) * (1 - smooth(0.2, 0.6, tension));
      extra = approach(extra, Math.min(maxExtra, wantExtra), wantExtra > extra ? 0.6 : 0.9, dt);
      for (let i = 1; i < MAX_ORBS; i++) {
        const o = orbs[i];
        const side = i === 1 ? -1 : 1;
        const share = clamp01(extra - (i - 1));
        const m = smooth(0, 1, share);
        o.x = side * ex * (0.5 + 0.05 * Math.sin(wander * 1.3 + i)) * (1 - 0.3 * portrait);
        o.y = main.y + 0.32 + 0.35 * portrait + 0.08 * Math.sin(wander * 0.9 + i * 2.1);
        o.m = 0.4 * m;
        o.r = R0 * (0.55 + 0.25 * (i === 1 ? a.mid : a.highMid)) * m * (1 + 0.12 * pump);
      }

      // spacing: about `lines` strands per side cross the top of the frame whatever the orbs do (without
      // ever packing the wraps under the orb tighter than a third of that), breathing when quiet
      const gamma = 1;
      dense = approach(dense, tension * 0.35 + 0.1 * intensity, 1.5, dt);
      const nLines = num(P, 'lines', 15) * (1 + dense);
      let ptop = 0;
      let pall = 0;
      const ix = ex - margin;
      const iy = ey - margin;
      for (let k = 0; k < 16; k++) {
        const t = k / 15;
        const top = Math.max(psiAt(-ix + 2 * ix * t, iy, beta, fanK), psiAt(-ix, iy - 0.6 * iy * t, beta, fanK), psiAt(ix, iy - 0.6 * iy * t, beta, fanK));
        ptop = Math.max(ptop, top);
        pall = Math.max(pall, top, psiAt(-ix + 2 * ix * t, -iy, beta, fanK), psiAt(-ix, -iy + 2 * iy * t, beta, fanK), psiAt(ix, -iy + 2 * iy * t, beta, fanK));
      }
      const pmax = Math.max(ptop, pall / 2.6);
      breathPh += dt * (0.5 + 0.25 * intensity) * (a.bpm > 0 ? a.bpm / 120 : 1);
      const breathe = 1 + 0.05 * num(P, 'breath', 1) * (quiet ? 1 : 0.3) * Math.sin(breathPh * 0.5);
      const want = (pmax / Math.pow(Math.max(nLines, 2), 1 / gamma)) * breathe;
      spacing = started ? approach(spacing, want, 6, dt) : want;

      // light flow: faster with energy, a surge after kicks and the drop
      flowPh += dt * (0.6 + 2.2 * intensity + 1.5 * Math.exp(-sinceKick * 4) * kickAmp + 4 * Math.exp(-sinceDrop * 1.5)) * num(P, 'flow', 1);
      flowAmt = approach(flowAmt, (0.3 + 0.5 * intensity) * num(P, 'flow', 1), 2, dt);

      // the kink: the drop sends a big one racing out; kicks in loud parts send small ripples
      const wv = uniforms.uWhip.value;
      // (the push stays under 0.6 of what would fold the field, so it stays a clean S in every strand)
      if (sinceDrop < 3) {
        const wd = 0.16 + 0.22 * sinceDrop;
        wv.set(sinceDrop * 2.4 - 0.1, Math.min((0.6 * wd) / 1.65, 0.12 * whipK) * Math.exp(-sinceDrop * 0.9), wd, 0);
      } else {
        const wd = 0.1 + 0.12 * sinceKick;
        const amp = 0.035 * whipK * kickAmp * smooth(0.3, 0.7, intensity) * Math.exp(-sinceKick * 2.2);
        wv.set(sinceKick * 1.8 - 0.05, Math.min((0.6 * wd) / 1.65, amp), wd, 0);
      }

      sphereRot += dt * (0.12 + 0.1 * intensity);
      started = true;

      for (let i = 0; i < MAX_ORBS; i++) {
        const o = orbs[i];
        orbData[i * 4] = o.x;
        orbData[i * 4 + 1] = o.y;
        orbData[i * 4 + 2] = o.r;
        orbData[i * 4 + 3] = o.m;
      }
      updateBaseUniforms(uniforms, frame);
      updateParamUniforms(uniforms, params, P);
      uniforms.uBeta.value = beta;
      uniforms.uSpacing.value = spacing;
      uniforms.uGamma.value = gamma;
      uniforms.uFan.value = fanK;
      uniforms.uFlowPh.value = flowPh % 10000;
      uniforms.uFlowAmt.value = flowAmt;
      uniforms.uFlare.value = sinceDrop < 4 ? Math.exp(-sinceDrop * 1.6) * (1 - Math.exp(-sinceDrop * 30)) : 0;
      uniforms.uSphere.value = sphere;
      uniforms.uSphereRot.value = sphereRot % (Math.PI * 2000);
      uniforms.uExt.value.set(ex, ey);
      uniforms.uMargin.value = margin;
      quad.render(frame.renderer, target);
    },
    dispose() {
      material.dispose();
      quad.dispose();
    },
  };
}

export const lensing: SceneDef = {
  id: 'lensing',
  name: 'Lensing',
  description:
    'Clean gradient lines fall from the top of the frame and bend around a small glowing orb, wrapping beneath it in nested curves like light round a mass. The orb swells with the bass and every kick so the lines bend harder; builds fan them out, the drop flares the orb and whips the field outward, loud parts bring companion orbs, and in a break one orb holds while the lines breathe and it turns into a sphere of dots.',
  category: 'field',
  style: 'light',
  tags: ['electronic', 'cosmic', 'hypnotic', 'minimal', 'drops', 'spacious', 'dark', 'futuristic', 'euphoric', 'ambient', 'techno', 'edm'],
  params,
  modulations: [{ source: 'energy', param: 'glow', amount: 0.1 }],
  create,
};
