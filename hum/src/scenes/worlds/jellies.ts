import * as THREE from 'three';
import { defineThreeScene } from '../../core/sceneHelpers';
import { num } from '../../core/uniforms';
import type { FrameContext, ParamDef } from '../../core/types';
import { BACKDROP_VERT, approach, isLightPalette, makeBackdrop, makeMaterial, Spring, stepDt, syncMaterial } from '../three/common';
import { dropEdge } from '../three/songInfo';

/*
 * Jellies: a dark tank of moon jellyfish swimming to the song. The feeling is calm, weightless and
 * tender: a slow heartbeat you can see.
 *
 * Jellyfish swim by pulsing, so here they are the drummers. Every body squeezes its bell, jets along
 * its own axis, then coasts, sinks a little and reopens; its tentacles and frilly arms trail the jet
 * and snap after it on a delay. Most bodies pulse on the beat, each offset by whole or half beats so
 * the tank pulses in a slow canon; the few big near ones pulse on the kick, a few small ones on the
 * snare. Quiet parts show three or four in dark water on slow half-time pulses; a chorus fills the
 * tank and brightens it. A build turns them all the same way and lifts them together, pulsing twice
 * as often. The drop sends a pressure wave of light out through the water: every jelly it reaches
 * contracts hard and jets outward, and for a few seconds after (feel.release) the rims flare in the
 * second accent, bioluminescent.
 *
 * How it is drawn: one instanced quad per body (46 of them, four depth layers, sorted far to near),
 * simulated on the CPU. Each quad is shaded procedurally in its own frame: a side view of a dome
 * whose profile follows the contraction (narrower, taller, the margin tucking in), a fresnel-like
 * thickness term so the rim is the brightest part, sixteen radial canals on the front and the back
 * surface (seen through each other), four horseshoes at the centre, four frilly oral arms and a
 * fringe of hair-fine tentacles. Tentacles are found by inverting their sway: the pixel is mapped
 * back to the point on the rim it hangs from, so a few hundred hairs cost one asin. Bodies blend
 * premultiplied (mostly emission, a little occlusion), so overlaps add softly and far ones read
 * behind near ones without blowing out. A second body type draws the microscope look: top views of
 * baby jellyfish (ephyrae), grey-white stars with eight forked arms and a glowing clover centre.
 *
 * The water is a backdrop quad: a deep gradient lit from the side the shared light comes from,
 * soft god-rays slanting with it, drifting specks that ride the shared current and twinkle on hats.
 *
 * Palette roles: bg = deep water, fg = the white of the bell rims and the central horseshoes,
 * accent = the body glow (cyan in the reference), accent2 = the bioluminescent flare after a drop,
 * muted = far water: distant bodies fade into it.
 */

const N_LAYERS = [16, 14, 11, 5]; // far → near
const DEPTHS = [0.06, 0.34, 0.66, 1.0];
const SIZES = [0.07, 0.11, 0.17, 0.3]; // bell radius, in screen half-heights
const SPEEDS = [0.5, 0.7, 0.85, 1.0]; // parallax on the current

const params: ParamDef[] = [
  {
    id: 'body',
    label: 'Body',
    group: 'Shape',
    type: 'select',
    options: [
      { value: 'moon', label: 'Moon jellies' },
      { value: 'ephyra', label: 'Microscope (baby stars)' },
    ],
    default: 'moon',
  },
  { id: 'count', label: 'Tank fullness', group: 'Shape', type: 'number', min: 0.2, max: 1, step: 0.01, default: 0.8, hint: 'How many bodies a full chorus shows; quiet parts always thin out to a few' },
  { id: 'size', label: 'Size', group: 'Shape', type: 'number', min: 0.6, max: 1.6, step: 0.01, default: 1 },
  { id: 'tentacles', label: 'Tentacle length', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.65 },
  { id: 'swim', label: 'Swim strength', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.55, hint: 'How far each pulse jets a body' },
  { id: 'current', label: 'Current', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'How strongly the shared current carries and leans them' },
  { id: 'pulse', label: 'Pulse depth', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, hint: 'How hard a bell squeezes on its beat' },
  { id: 'dropBurst', label: 'Drop wave', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.85, hint: 'The pressure wave of light on a drop, and the flare after it' },
  { id: 'glow', label: 'Glow', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6 },
  { id: 'water', label: 'Rays & specks', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'God-rays and drifting plankton in the water' },
];

/* ───────────────────────── the water ───────────────────────── */

const WATER_FRAG = /* glsl */ `
uniform float uWaveR, uWaveA, uHatN, uFlowX, uFlowY, uSink;

void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float lightBg = step(0.5, luma(uBg));
  vec2 Ld = vec2(cos(uFeelLight), sin(uFeelLight));
  float inten = uFeelIntensity;

  // depth gradient: a glow of the surface above, deep water below
  vec3 deep = mix(uBg, uBg * 0.55, 1.0 - lightBg);
  vec3 high = mix(uBg, mix(uMuted, uAccent, 0.35), (0.28 + 0.2 * inten) * (0.3 + 0.7 * min(1.0, u_water * 2.0)));
  vec3 col = mix(deep, high, smoothstep(-0.55, 0.65, p.y));
  // the light comes in from one side
  float sideL = smoothstep(-0.9, 0.9, dot(p, Ld) / max(uAspect * 0.5, 0.5));
  col += mix(uMuted, uAccent, 0.5) * sideL * (0.05 + 0.05 * inten) * (1.0 - lightBg);
  // build: the water closes in and darkens at the edges
  col *= 1.0 - 0.25 * uFeelTension * smoothstep(0.2, 0.9, length(p * vec2(1.0 / max(uAspect, 0.6), 1.0)));

  // god-rays: soft bands slanting down from the lit side, fading with depth
  vec2 rd = normalize(vec2(-Ld.x * 0.45, -1.0));
  float across = dot(p, vec2(-rd.y, rd.x));
  float along = dot(p, rd);
  float rn = tfbm(vec2(across * 5.0 + uFeelWindPhase * 0.05, along * 0.35 + uTime * 0.02), 3);
  float rays = smoothstep(0.0, 0.55, rn) * smoothstep(-0.6, 0.6, p.y);
  col += mix(uAccent, uFg, 0.35) * rays * u_water * (0.06 + 0.1 * inten) * (1.0 - 0.6 * lightBg);

  // drifting specks: three depths riding the shared current, slowly sinking; hats make some twinkle
  float pxw = 2.0 / uResolution.y * max(1.0, uResolution.y / 1080.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float sc = 7.0 + fi * 5.0;
    vec2 g = p * sc + vec2(uFlowX, uFlowY - uSink) * (0.6 + 0.4 * fi) * sc * 0.25 + fi * 17.3;
    vec2 cell = floor(g);
    vec2 h = hash22(cell + fi * 31.0);
    vec2 f = fract(g) - 0.1 - 0.8 * h;
    float rad = (0.8 + 1.2 * h.x * h.x + fi * 0.3) * pxw * sc;
    float dot0 = 1.0 - smoothstep(rad * 0.3, rad, length(f));
    float tw = step(0.72, hash21(cell + vec2(uHatN, fi))) * uHat;
    float on = step(0.62, hash21(cell * 1.31 + fi)) * (0.35 + 0.65 * h.y);
    col += mix(uMuted, uFg, 0.45 + 0.2 * fi) * dot0 * on * u_water * (0.12 + 0.1 * fi + tw * 0.9) * (1.0 - 0.7 * lightBg);
  }

  // the drop: a pressure wave of light through the water
  float r = length(p - vec2(0.0, 0.1));
  float wx = (r - uWaveR) / (0.1 + 0.08 * uWaveR);
  col += mix(uAccent, uAccent2, 0.55) * exp(-wx * wx) * uWaveA * 0.35;
  col += mix(uAccent, uAccent2, 0.4) * uWaveA * (0.08 * exp(-r * 1.5) + 0.07 * (1.0 - smoothstep(0.0, uWaveR + 0.01, r)));
  // the afterglow: the water itself stays faintly lit
  col += uAccent2 * uFeelRelease * 0.035 * smoothstep(-0.6, 0.6, p.y) * (1.0 - lightBg);

  col += (hash21(gl_FragCoord.xy + fract(uTime) * 100.0) - 0.5) * 0.012;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/* ───────────────────────── the bodies ───────────────────────── */

const BODY_VERT = /* glsl */ `
attribute vec4 iA; // x, y, size, angle
attribute vec4 iB; // contraction, trailing contraction, tentacle sway, depth
attribute vec4 iC; // seed, gain, flare, tilt
varying vec2 vL;
varying vec4 vB;
varying vec4 vC;
varying vec2 vLd;

void main() {
  vec2 q = position.xy;
  vec2 l;
  if (u_body < 0.5) {
    float bottom = -max(1.45, 0.75 + 2.2 * u_tentacles);
    l = vec2(q.x * 1.25, mix(bottom, 0.85, q.y * 0.5 + 0.5));
  } else {
    l = q * 1.15;
  }
  vL = l;
  vB = iB;
  vC = iC;
  float ca = cos(iA.w), sa = sin(iA.w);
  vec2 w = vec2(l.x * ca - l.y * sa, l.x * sa + l.y * ca) * iA.z + iA.xy;
  if (iC.y < 0.002) w = vec2(9.0); // hidden: push off screen
  gl_Position = vec4(w.x / uAspect, w.y, 0.0, 1.0);
  vec2 Ld = vec2(cos(uFeelLight), sin(uFeelLight));
  vLd = vec2(Ld.x * ca + Ld.y * sa, -Ld.x * sa + Ld.y * ca);
}
`;

const BODY_FRAG = /* glsl */ `
uniform float uMidE;
varying vec2 vL;
varying vec4 vB;
varying vec4 vC;
varying vec2 vLd;

// weights of each part, filled by the body functions
float wShell, wEdge, wRim, wCanal, wGon, wArm, wTent, wCov;

// a thin line at every whole k, anti-aliased, faded out where the lines crowd below a pixel
float jlLine(float k, float w) {
  float fw = fwidth(k);
  float dd = abs(fract(k + 0.5) - 0.5);
  return (1.0 - smoothstep(w, w + fw * 1.3, dd)) * (1.0 - smoothstep(0.22, 0.5, fw));
}
float jlSeg(vec2 p, vec2 a, vec2 b, float r1, float r2) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - mix(r1, r2, h);
}
float jlSmin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// side view of a moon jelly, bell radius 1, apex up
void jlMoon(vec2 p, float c, float trail, float sway, float seed, float tilt) {
  float W = 1.0 - 0.3 * c;
  float H = 0.46 + 0.3 * c;
  float rimY = -0.05 - 0.14 * c;          // the margin hangs below the widest point …
  float Wr = W * (0.97 - 0.26 * c);       // … and tucks in as the bell squeezes
  float er = Wr * tilt;                   // the rim seen as an ellipse

  // outline: dome above 0, the tucked margin down to the rim, the rim ellipse below
  float ell = length(vec2(p.x / Wr, (p.y - rimY) / er));
  float rho = W;
  float f;
  if (p.y >= 0.0) {
    f = length(vec2(p.x / W, p.y / H)) - 1.0;
    rho = W * sqrt(max(1.0 - p.y * p.y / (H * H), 0.0));
  } else if (p.y >= rimY) {
    float t = p.y / rimY;
    rho = mix(W, Wr, t * t);
    f = abs(p.x) / rho - 1.0;
  } else {
    f = ell - 1.0;
  }
  float cov = clamp(0.5 - f / max(fwidth(f), 1e-4), 0.0, 1.0);
  float rr = clamp(f + 1.0, 0.0, 1.0);
  wCov = cov;
  // the jelly is mostly clear; its skin is seen edge-on at the silhouette, so the rim glows
  float fres = min(1.0 / sqrt(max(1.0 - rr * rr, 0.02)) - 1.0, 4.0);
  wShell = cov * (0.25 + 0.16 * (1.0 - rr) + 0.25 * exp(-length(vec2(p.x, p.y - H * 0.55)) * 3.0)) * (p.y < rimY ? 0.6 : 1.0);
  wEdge = cov * (pow(rr, 10.0) * 0.6 + fres * 0.1);
  // the rim: front half bright, back half seen through the bell
  float rl = abs(ell - 1.0);
  float rimL = 1.0 - smoothstep(0.04, 0.04 + fwidth(rl) * 1.4, rl);
  wRim = rimL * (p.y < rimY ? 1.0 : 0.45);

  // sixteen radial canals, on the front and (fainter) the back surface
  if (p.y >= rimY && cov > 0.0) {
    float phi = asin(clamp(p.x / max(rho, 1e-3), -1.0, 1.0));
    float kF = phi * 16.0 / TAU + seed * 3.0;
    float kB = (PI - phi) * 16.0 / TAU + seed * 3.0;
    wCanal = cov * (jlLine(kF, 0.035) * 0.75 + jlLine(kB, 0.03) * 0.35) * smoothstep(0.0, 0.25, H - p.y);
  }

  // four horseshoes on the roof of the bell
  float Rg = 0.36 * W;
  float yg = 0.36 * H;
  float tl = max(tilt, 0.22);
  for (int k = 0; k < 4; k++) {
    float th = float(k) * PI * 0.5 + 0.785 + seed * 6.28;
    vec2 dir = vec2(cos(th), sin(th));
    vec2 q = vec2(p.x - Rg * dir.x, (p.y - yg - Rg * tl * dir.y) / tl);
    float rh = 0.15 * W;
    float lq = length(q);
    float lr = abs(lq - rh);
    float ring = 1.0 - smoothstep(0.03, 0.03 + fwidth(lr) * 1.4, lr);
    float gap = smoothstep(0.45, 0.85, dot(q / max(lq, 1e-4), -dir));
    float fill = exp(-lq * lq / (rh * rh)) * 0.35;
    wGon += (ring * (1.0 - gap) + fill) * (0.8 - 0.25 * dir.y);
  }
  wGon *= cov;

  // four frilly oral arms trailing from the centre
  float y0 = rimY + 0.12;
  float armLen = 0.95 + 0.55 * u_tentacles;
  float sA = (y0 - p.y) / armLen;
  if (sA > 0.0 && sA < 1.0) {
    for (int k = 0; k < 4; k++) {
      float fk = float(k);
      float bend = sway * sA * sA * 0.8 + 0.05 * sin(sA * 5.0 - uTime * 1.1 + seed * 9.0 + fk) * sA;
      float xc = (fk - 1.5) * 0.12 * (1.0 - 0.45 * trail) * (1.0 + 0.6 * sA) + bend;
      float hw = 0.085 * (1.0 - 0.6 * sA) * (0.75 + 0.4 * sin(sA * 26.0 + fk * 2.1 + uTime * 0.9 + seed * 4.0));
      float dx = abs(p.x - xc);
      float aw = fwidth(p.x);
      float rib = 1.0 - smoothstep(hw - aw, hw + aw, dx);
      float edge = rib * smoothstep(hw * 0.35, hw, dx);
      wArm += (rib * 0.22 + edge * 0.45) * pow(1.0 - sA, 1.2) * smoothstep(0.0, 0.1, sA);
    }
  }

  // hair-fine tentacles: map the pixel back to the point on the rim its hair hangs from
  float L = mix(0.5, 2.3, u_tentacles);
  float s = (rimY - p.y) / L;
  if (s > 0.0 && s < 1.0) {
    float pinch = 0.12 + 0.45 * trail;
    float bend = sway * pow(s, 1.5) + 0.05 * sin(s * 8.0 - uTime * 1.6 + seed * 7.0) * s;
    float x0 = (p.x - bend) / (1.0 - pinch * s);
    float sn = x0 / Wr;
    if (abs(sn) < 1.0) {
      float k = asin(sn) * 30.0 / PI + seed * 5.0;
      float lenH = 0.45 + 0.55 * hash11(floor(k + 0.5) * 1.7 + seed * 13.0);
      float fade = (1.0 - smoothstep(lenH * 0.5, lenH, s)) * smoothstep(0.0, 0.03, s);
      wTent = (jlLine(k, 0.05) * 0.6 + 0.05 * (1.0 - sn * sn)) * fade;
    }
  }
}

// top view of a baby jellyfish (ephyra): a star with eight forked arms and a clover centre
void jlEphyra(vec2 p, float c, float seed, float tilt) {
  p = rot2(seed * 6.28 + uTime * 0.04 * (seed - 0.5)) * p;
  p.y /= 0.7 + tilt * 0.75;
  float r = length(p);
  float th = atan(p.y, p.x);
  float sec = TAU / 8.0;
  float a = mod(th + sec * 0.5, sec) - sec * 0.5;
  vec2 q = r * vec2(cos(a), sin(a));
  float L = 0.98 - 0.3 * c;                // arms fold in as it squeezes
  float body = r - (0.42 - 0.05 * c);
  float arm = jlSeg(q, vec2(0.25, 0.0), vec2(L - 0.12, 0.0), 0.16 - 0.03 * c, 0.1);
  float lap = min(length(q - vec2(L - 0.08, 0.07)) - 0.075, length(q - vec2(L - 0.08, -0.07)) - 0.075);
  arm = min(arm, lap);
  arm = max(arm, -(length(q - vec2(L + 0.01, 0.0)) - 0.05));
  float sd = jlSmin(body, arm, 0.12);
  float cov = clamp(0.5 - sd / max(fwidth(sd), 1e-4), 0.0, 1.0);
  wCov = cov;
  float grain = tnoise(p * 60.0 + seed * 40.0);
  wShell = cov * (0.12 + 0.14 * grain * grain + 0.08 * smoothstep(0.5, 0.0, r));
  wEdge = cov * exp(-abs(sd) / 0.02) * 0.7;
  wCanal = cov * exp(-abs(q.y) / 0.014) * smoothstep(0.12, 0.3, r) * (1.0 - smoothstep(L - 0.2, L - 0.05, r)) * 0.5;
  float cl = r / (0.08 + 0.07 * abs(cos(2.0 * th + 0.785)));
  wGon = ((1.0 - smoothstep(0.7, 1.0, cl)) * (0.5 + 0.5 * tnoise(p * 30.0)) + exp(-abs(cl - 1.0) * 6.0) * 0.4) * cov;
  float rh = length(q - vec2(L - 0.05, 0.0));
  wRim = exp(-rh * rh / 0.0003) * 0.9;
}

void main() {
  float c = vB.x, trail = vB.y, sway = vB.z, dep = vB.w;
  float seed = vC.x, gain = vC.y, flare = vC.z, tilt = vC.w;
  wShell = 0.0; wEdge = 0.0; wRim = 0.0; wCanal = 0.0; wGon = 0.0; wArm = 0.0; wTent = 0.0; wCov = 0.0;
  vec2 p = vL;
  vec2 nrm;
  if (u_body < 0.5) {
    jlMoon(p, c, trail, sway, seed, tilt);
    nrm = normalize(vec2(p.x, max(p.y, -0.1) * 1.8) + 1e-4);
  } else {
    jlEphyra(p, c, seed, tilt);
    nrm = normalize(p + 1e-4);
  }
  float total = wShell + wEdge + wRim + wCanal + wGon + wArm + wTent;
  if (total < 0.002) discard;

  // near bodies glow in the accent, far ones fade toward the far-water colour
  vec3 tint = mix(uMuted, uAccent, 0.3 + 0.7 * dep);
  vec3 rimC = mix(tint, uFg, 0.35 + 0.5 * dep);
  vec3 gonC = mix(uFg, uAccent, 0.3);
  if (u_body > 0.5) { tint = mix(uMuted, uFg, 0.35 + 0.4 * dep); rimC = uFg; gonC = mix(uFg, uAccent, 0.2); }
  // the bioluminescent flare takes over the rims and the horseshoes
  float fl = clamp(flare, 0.0, 1.0);
  rimC = mix(rimC, uAccent2, fl * 0.9) * (1.0 - 0.3 * fl);
  gonC = mix(gonC, uAccent2, fl * 0.45);
  float lit = 0.55 + 0.65 * max(dot(nrm, vLd), 0.0);
  vec3 E = tint * (wShell * 0.6 + wCanal * 0.4 + wArm * 0.6 + wTent * 0.75) * lit
         + rimC * (wRim * 0.85 + wEdge * 0.55) * lit
         + gonC * wGon * (0.4 + 0.75 * uMidE);
  E += uAccent2 * flare * (wRim * 0.6 + wEdge * 0.4 + wTent * 0.4 + wCanal * 0.3);

  float lightBg = step(0.5, luma(uBg));
  if (lightBg > 0.5) {
    // on a pale ground the body is drawn in ink instead of light
    float a = clamp(total * 0.9, 0.0, 0.85) * gain;
    vec3 ink = E / max(total, 1e-3);
    gl_FragColor = vec4(ink * a, a);
  } else {
    float occl = clamp(wCov * 0.3 + wArm * 0.2, 0.0, 0.6) * (0.3 + 0.7 * dep);
    gl_FragColor = vec4(E * gain, occl * min(gain, 1.0));
  }
}
`;

/* ───────────────────────── simulation ───────────────────────── */

interface Jelly {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ang: number;
  angV: number;
  size: number;
  layer: number;
  depth: number;
  seed: number;
  tilt: number;
  rank: number;
  /** 0 = on the beat, 1 = on the kick, 2 = on the snare */
  src: number;
  /** offset of its pulse, in beats (whole or half) */
  off: number;
  beatIdx: number;
  /** time since its last pulse began */
  pt: number;
  amp: number;
  thrust: number;
  c: number;
  trail: number;
  sway: Spring;
  vis: number;
  flare: number;
  /** how strongly it still points away from the drop */
  out: number;
  waveHit: boolean;
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function makeTank(aspect: number): Jelly[] {
  const rnd = mulberry(0x5eed1e5);
  const out: Jelly[] = [];
  const A = Math.max(aspect, 0.5);
  N_LAYERS.forEach((n, layer) => {
    for (let i = 0; i < n; i++) {
      // stratified across the frame so every layer covers it
      const cx = ((i + 0.2 + 0.6 * rnd()) / n) * 2 - 1;
      const x = cx * A * 1.05;
      const y = (rnd() * 2 - 1) * 0.95 + 0.12;
      const src = layer === 3 ? 1 : layer === 1 && i % 5 === 2 ? 2 : 0;
      out.push({
        x,
        y,
        vx: 0,
        vy: 0,
        ang: (rnd() - 0.5) * 0.8,
        angV: 0,
        size: SIZES[layer] * (0.8 + 0.4 * rnd()),
        layer,
        depth: DEPTHS[layer] + (rnd() - 0.5) * 0.08,
        seed: rnd(),
        tilt: 0.18 + 0.22 * rnd(),
        rank: 0,
        src,
        off: Math.floor(rnd() * 4) * 0.5,
        beatIdx: NaN,
        pt: 9,
        amp: 0,
        thrust: 0,
        c: 0,
        trail: 0,
        sway: new Spring(26, 4.5),
        vis: 0,
        flare: 0,
        out: 0,
        waveHit: true,
      });
    }
  });
  // who shows up first when the tank is nearly empty: one near body and a few in the middle distance,
  // spread across the frame; then everything else in a seeded shuffle
  const near = out.filter((j) => j.layer === 3);
  const mid = out.filter((j) => j.layer === 2);
  const midFar = out.filter((j) => j.layer === 1);
  const first = [near[1], mid[2], mid[7], midFar[4], near[3], mid[5]];
  const rest = out.filter((j) => !first.includes(j));
  for (let i = rest.length - 1; i > 0; i--) {
    const k = Math.floor(rnd() * (i + 1));
    [rest[i], rest[k]] = [rest[k], rest[i]];
  }
  [...first, ...rest].forEach((j, i) => (j.rank = i));
  // the quiet ones get good places: away from the bottom third
  first.slice(0, 4).forEach((j, i) => {
    j.y = [0.25, 0.45, -0.05, 0.6][i];
    j.x = [-0.35, 0.55, 0.15, -0.8][i] * A;
  });
  // draw far → near
  out.sort((a, b) => a.depth - b.depth);
  return out;
}

export const jellies = defineThreeScene({
  id: 'jellies',
  name: 'Jellies',
  description:
    'A dark tank of translucent moon jellyfish that swim by pulsing to the song: most squeeze on the beat in a slow canon, the big near ones on the kick, a few small ones on the snare, each bell jetting forward while its tentacles trail and snap behind. Quiet parts leave a few in dark water, a chorus fills the tank, a build lines them up and lifts them together, and the drop sends a wave of light through the water that makes every jelly jet outward and glow. A second body type shows baby jellyfish under a microscope.',
  category: 'form',
  style: 'world',
  tags: ['calm', 'tender', 'dreamy', 'ambient', 'spacious', 'organic', 'nature', 'hypnotic', 'slow', 'melancholic', 'cinematic', 'electronic'],
  params,
  modulations: [
    { source: 'bass', param: 'pulse', amount: 0.15 },
    { source: 'air', param: 'water', amount: 0.2 },
    { source: 'energy', param: 'glow', amount: 0.12 },
  ],
  build(init) {
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const water = makeMaterial({
      params,
      shared: init.shared,
      vertex: BACKDROP_VERT,
      fragment: WATER_FRAG,
      extra: {
        uWaveR: { value: 0 },
        uWaveA: { value: 0 },
        uHatN: { value: 0 },
        uFlowX: { value: 0 },
        uFlowY: { value: 0 },
        uSink: { value: 0 },
      },
    });
    scene.add(makeBackdrop(water));

    let tank = makeTank(init.width / Math.max(1, init.height));
    const N = tank.length;
    const quad = new THREE.PlaneGeometry(2, 2);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    const bufA = new Float32Array(N * 4);
    const bufB = new Float32Array(N * 4);
    const bufC = new Float32Array(N * 4);
    const attA = new THREE.InstancedBufferAttribute(bufA, 4).setUsage(THREE.DynamicDrawUsage);
    const attB = new THREE.InstancedBufferAttribute(bufB, 4).setUsage(THREE.DynamicDrawUsage);
    const attC = new THREE.InstancedBufferAttribute(bufC, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iA', attA);
    geo.setAttribute('iB', attB);
    geo.setAttribute('iC', attC);
    geo.instanceCount = N;

    const bodyMat = makeMaterial({
      params,
      shared: init.shared,
      vertex: BODY_VERT,
      fragment: BODY_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      extra: { uMidE: { value: 0 } },
    });
    const bodies = new THREE.Mesh(geo, bodyMat);
    bodies.frustumCulled = false;
    scene.add(bodies);

    const isDrop = dropEdge();
    const bass = new Spring(40, 9);
    let midE = 0;
    let beatN = 0;
    let prevPhase = 0;
    let lastKick = -9;
    let lastSnare = -9;
    let dropT = 99;
    let dropK = 0;
    let prevSince = 99;
    let hatN = 0;
    let flowX = 0;
    let flowY = 0;
    let sink = 0;
    let first = true;
    let lastAspect = init.width / Math.max(1, init.height);

    function pulse(j: Jelly, amp: number, thrust: number) {
      j.pt = 0;
      j.amp = Math.min(1.35, amp);
      j.thrust = thrust;
    }

    return {
      scene,
      camera,
      update(frame: FrameContext) {
        const dt = stepDt(frame);
        const a = frame.audio;
        const f = frame.feel;
        const p = frame.params;
        const t = frame.time;
        syncMaterial(water, frame, params);
        syncMaterial(bodyMat, frame, params);
        const light = isLightPalette(frame.palette);

        // a new shape of frame (say, landscape → portrait): lay the tank out again
        if (Math.abs(frame.aspect - lastAspect) > 0.2) {
          lastAspect = frame.aspect;
          tank = makeTank(frame.aspect);
          first = true;
        }

        const swimK = 0.3 + 1.5 * num(p, 'swim', 0.55);
        const current = num(p, 'current', 0.5);
        const pulseK = num(p, 'pulse', 0.7);
        const burst = num(p, 'dropBurst', 0.85);
        const sizeK = num(p, 'size', 1) * Math.min(1, 0.55 + 0.45 * frame.aspect);
        const ephyra = num(p, 'body', 0) > 0.5;
        const inten = f.intensity;
        const tension = f.tension;

        bass.step(a.bass, dt);
        midE = approach(midE, a.mid, 6, dt);
        if (a.hatHit) hatN = (hatN + 1) % 997;

        // the beat clock: whole beats counted on each wrap of the phase
        if (a.beatPhase < prevPhase - 0.5) beatN++;
        prevPhase = a.beatPhase;
        const hasTempo = a.bpm > 0;
        const beatPos = hasTempo ? beatN + a.beatPhase : t * 1.6;
        const beatLen = hasTempo ? 60 / a.bpm : 0.62;
        if (a.kickHit) lastKick = t;
        if (a.snareHit) lastSnare = t;

        // the drop: a pressure wave runs out from the middle; each jelly it reaches squeezes hard
        const edge = isDrop(frame) || (f.sinceDrop < 0.15 && prevSince > 1);
        prevSince = f.sinceDrop;
        if (edge && dropT > 2) {
          dropT = 0;
          dropK = burst;
          for (const j of tank) j.waveHit = false;
        }
        dropT = Math.min(99, dropT + dt);
        const waveR = dropT * 2.6;
        const waveA = dropK * Math.exp(-dropT * 0.9) * (dropT < 4 ? 1 : 0);

        // how full the tank is: a few in quiet water, all of them in a chorus
        const full = num(p, 'count', 0.8) * (0.075 + 0.925 * Math.min(1, Math.max(0, (inten - 0.12) / 0.7)));
        const shown = Math.max(3, Math.round(full * N));

        // pulse period, in beats: slow half-time when quiet, quicker small ones in a chorus, doubled in a build
        const quiet = inten < 0.3;
        const A = Math.max(frame.aspect, 0.4);

        // shared current: specks and bodies drift on it
        const drift = current * (0.03 + 0.14 * f.gust);
        flowX += f.windX * drift * dt;
        flowY += f.windY * drift * dt * 0.5;
        sink += dt * 0.012;

        // the big bodies keep a little room between them, so they overlap without piling up
        for (let i = 0; i < tank.length; i++) {
          const ji = tank[i];
          if (ji.layer < 2 || ji.vis < 0.05) continue;
          for (let k = i + 1; k < tank.length; k++) {
            const jk = tank[k];
            if (jk.layer < 2 || jk.vis < 0.05) continue;
            const dx = jk.x - ji.x;
            const dy = jk.y - ji.y;
            const rr = (ji.size + jk.size) * sizeK * 1.3;
            const d2 = dx * dx + dy * dy;
            if (d2 < rr * rr && d2 > 1e-8) {
              const d = Math.sqrt(d2);
              const push = ((rr - d) / rr) * 0.5 * dt;
              ji.vx -= (dx / d) * push;
              ji.vy -= (dy / d) * push;
              jk.vx += (dx / d) * push;
              jk.vy += (dy / d) * push;
            }
          }
        }

        for (let i = 0; i < tank.length; i++) {
          const j = tank[i];
          const big = j.layer >= 2;
          let P = big ? 2 : j.layer === 0 ? 2 : inten > 0.65 ? 1 : 2;
          if (quiet) P *= 2;
          if (tension > 0.4) P = Math.max(1, P / 2);
          const ampBase = (0.45 + 0.5 * pulseK) * (0.8 + 0.3 * inten) + 0.15 * bass.value;

          // pulse triggers
          let fromBeat = j.src === 0 || (j.src === 1 && t - lastKick > 1.5) || (j.src === 2 && t - lastSnare > 1.5);
          if (j.src === 1 && tension > 0.5) fromBeat = true; // the kick drops out in a build: follow the beat
          const idx = Math.floor((beatPos - j.off) / P);
          if (fromBeat) {
            if (!Number.isNaN(j.beatIdx) && idx !== j.beatIdx && j.pt > 0.42 * P * beatLen) pulse(j, ampBase, 1);
          } else if (j.src === 1 && a.kickHit && j.pt > 0.9) {
            pulse(j, ampBase * (0.85 + 0.3 * Math.min(1, a.kick)), 1.1);
          } else if (j.src === 2 && a.snareHit && j.pt > 0.55) {
            pulse(j, ampBase * 0.9, 1);
          }
          j.beatIdx = idx;
          if (!j.waveHit) {
            const dist = Math.hypot(j.x, j.y - 0.1);
            if (dist < waveR) {
              j.waveHit = true;
              pulse(j, 1.0 + 0.35 * dropK, 1 + 0.8 * dropK);
              j.flare = Math.max(j.flare, dropK);
              j.out = dropK;
            }
          }

          // contraction: a quick squeeze, then a slow reopening
          j.pt += dt;
          const tSq = Math.min(0.2, Math.max(0.1, 0.3 * beatLen));
          const ax = -Math.sin(j.ang);
          const ay = Math.cos(j.ang);
          if (j.pt < tSq) {
            j.c = approach(j.c, j.amp, 24, dt);
            const acc = (0.65 * j.size * swimK * j.amp * j.thrust) / tSq;
            j.vx += ax * acc * dt;
            j.vy += ay * acc * dt;
          } else {
            j.c = approach(j.c, 0, 2.6 / (0.7 + j.size * 2.5), dt);
          }
          j.trail = approach(j.trail, j.c, 4.5, dt);

          // coast: water drag toward the current, a slight sink (a build lifts them all together)
          const par = SPEEDS[j.layer];
          const dvx = f.windX * drift * par * 1.2;
          const dvy = f.windY * drift * par * 0.6 - j.size * (0.4 * (1 - tension)) + j.size * 0.3 * tension;
          const drag = 1 - Math.exp(-1.6 * dt);
          j.vx += (dvx - j.vx) * drag;
          j.vy += (dvy - j.vy) * drag;
          // and the big ones are held softly inside the frame (the drop can throw them, not lose them)
          if (j.layer >= 2) {
            const k = (j.layer === 3 ? 2.2 : 1.2) * dt;
            if (j.y > 0.45) j.vy -= (j.y - 0.45) * k;
            else if (j.y < -0.6) j.vy -= (j.y + 0.6) * k;
          }
          j.x += j.vx * dt;
          j.y += j.vy * dt;

          // heading: each wanders on its own; the current leans them; a build lines them all up;
          // the drop points every one away from the wave
          const wander = 0.5 * Math.sin(f.windPhase * 0.06 + j.seed * 6.28) + 0.25 * Math.sin(t * 0.09 + j.seed * 21);
          const lean = -f.windX * (0.15 + 0.35 * f.gust) * current;
          let target = (wander * (1 - tension) + -0.1 * f.windX * tension) + lean;
          // the big ones turn back before they leave the top or the bottom (the current carries them across)
          if (j.layer >= 2) {
            const ey = Math.max(0, j.y - 0.3, -0.5 - j.y) / 0.4;
            const home = Math.min(1, ey) * (1 - 0.6 * tension) * (j.layer === 3 ? 1 : 0.6);
            if (home > 0) target += wrapAngle(Math.atan2(j.x, -(j.y - 0.15)) - target) * home;
          }
          target = Math.max(-0.95, Math.min(0.95, target));
          if (j.out > 0.01) {
            const outA = Math.atan2(-j.x, j.y - 0.1);
            target = target + wrapAngle(outA - target) * Math.min(1, j.out * 1.3);
            j.out *= Math.exp(-dt * 0.9);
          }
          const angK = 5 + 14 * j.out + (j.layer === 3 ? 4 : 0);
          j.angV += (angK * wrapAngle(target - j.ang) - 3.2 * j.angV) * dt;
          j.ang = wrapAngle(j.ang + j.angV * dt);

          // tentacles lag the turn and the sideways drift, then snap back
          const latV = (j.vx * Math.cos(j.ang) + j.vy * Math.sin(j.ang)) / Math.max(j.size, 0.01);
          j.sway.step(Math.max(-0.6, Math.min(0.6, -latV * 0.35 - j.angV * 0.25)), dt);

          // the tank wraps round, out of sight
          const m = j.size * sizeK * 3.2;
          const X = A + m;
          const Y = 1 + m;
          if (j.x > X) j.x -= 2 * X;
          else if (j.x < -X) j.x += 2 * X;
          if (j.y > Y) j.y -= 2 * Y;
          else if (j.y < -Y) j.y += 2 * Y;

          const visT = j.rank < shown ? 1 : 0;
          j.vis = first ? visT : approach(j.vis, visT, 0.5, dt);
          // flare: lit by the drop wave, then a slow bioluminescent afterglow
          j.flare *= Math.exp(-dt * 0.8);
          const glowAfter = f.release * burst * (0.45 + 0.35 * Math.sin(t * 1.3 + j.seed * 9));
          const flare = Math.min(1.2, Math.max(j.flare, glowAfter));

          const size = j.size * sizeK * (ephyra ? 0.95 : 1) * (1 + 0.06 * Math.max(0, bass.value) + 0.03 * inten);
          const lower = 0.72 + 0.28 * Math.min(1, Math.max(0, (j.y + 1) / 0.6)); // the lower third stays calmer
          const glow = (0.35 + 1.1 * num(p, 'glow', 0.6)) * (0.6 + 0.55 * inten + 0.15 * f.release);
          const gain = j.vis * (0.3 + 0.7 * j.depth) * glow * lower * (light ? 1.2 : 1);

          const o = i * 4;
          bufA[o] = j.x;
          bufA[o + 1] = j.y;
          bufA[o + 2] = size;
          bufA[o + 3] = j.ang;
          bufB[o] = j.c;
          bufB[o + 1] = j.trail;
          bufB[o + 2] = j.sway.value;
          bufB[o + 3] = Math.min(1, Math.max(0, j.depth));
          bufC[o] = j.seed;
          bufC[o + 1] = gain;
          bufC[o + 2] = flare;
          bufC[o + 3] = j.tilt;
        }
        first = false;
        attA.needsUpdate = true;
        attB.needsUpdate = true;
        attC.needsUpdate = true;

        bodyMat.uniforms.uMidE.value = midE;
        const u = water.uniforms;
        u.uWaveR.value = waveR;
        u.uWaveA.value = waveA;
        u.uHatN.value = hatN;
        u.uFlowX.value = flowX % 256;
        u.uFlowY.value = flowY % 256;
        u.uSink.value = sink % 256;
      },
      dispose() {
        quad.dispose();
      },
    };
  },
});
