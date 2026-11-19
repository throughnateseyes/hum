/**
 * Particle Columns — a spectrum made of noise. Vertical columns of fine stippled dots rise and
 * fall with their frequency band (sprung on the CPU, so kicks overshoot), a soft horizontal haze
 * band drifts behind them, dark slots cut through the haze, and hits bloom the whole field.
 * One fullscreen shader pass; the dither is a per-cell hash, re-rolled ~24 times a second.
 */
import * as THREE from 'three';
import { defineThreeScene } from '../../core/sceneHelpers';
import { num } from '../../core/uniforms';
import type { ParamDef } from '../../core/types';
import { approach, makeMaterial, Spring, stepDt, syncMaterial, isLightPalette } from './common';

const MAX = 28;

const params: ParamDef[] = [
  { id: 'columns', label: 'Columns', group: 'Shape', type: 'number', min: 4, max: MAX, step: 1, default: 14 },
  { id: 'width', label: 'Column width', group: 'Shape', type: 'number', min: 0.2, max: 1.5, step: 0.01, default: 1 },
  { id: 'grain', label: 'Dot size', group: 'Shape', type: 'number', min: 1, max: 5, step: 0.1, default: 2, hint: 'Stipple cell size in px (at 1080p)' },
  { id: 'haze', label: 'Haze band', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, hint: 'The soft horizontal cloud behind the columns' },
  { id: 'dark', label: 'Dark slots', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.35, hint: 'Share of columns that cut the haze instead of glowing' },
  { id: 'rise', label: 'Band response', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.85, hint: 'How far columns rise with their band' },
  { id: 'kick', label: 'Kick jump', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.55 },
  { id: 'glow', label: 'Glow', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Bloom around the columns, flaring on hits' },
  { id: 'flow', label: 'Particle flow', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.4, hint: 'Noise drifting up through the columns' },
  { id: 'white', label: 'White core', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Dense areas burn toward the foreground colour' },
];

const VERT = /* glsl */ `
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform float uX[${MAX}];
uniform float uW[${MAX}];
uniform float uH[${MAX}];
uniform float uB[${MAX}];
uniform float uKind[${MAX}];
uniform float uN, uFlowT, uSeedT, uKickE, uFlash, uLight, uHazeY;

void main() {
  vec2 fc = gl_FragCoord.xy;
  float px = uResolution.y / 1080.0;
  float cell = max(1.0, floor(u_grain * px + 0.5));
  vec2 ci = floor(fc / cell);
  vec2 uv = (ci + 0.5) * cell / uResolution;
  float x = uv.x;
  float y = uv.y;

  // ── haze band ──
  float hy = uHazeY + 0.03 * sin(x * 3.1 + uFlowT * 0.21);
  float th = 0.055 + 0.05 * uBass + 0.03 * uEnergy;
  float hd = (y - hy) / th;
  float hn = abs(hd) < 3.0 ? fbm(vec2(x * 2.6 - uFlowT * 0.05, y * 4.0 + uFlowT * 0.03), 3) * 0.5 + 0.5 : 0.0;
  // clumpy cloud masses rather than an even fog
  float dens = exp(-hd * hd) * smoothstep(0.3, 0.75, hn) * 1.1 * u_haze * (0.6 + 0.5 * uEnergy);
  // a fainter, broken second band lower down
  float hd2 = (y - hy + 0.34) / (th * 1.2);
  if (abs(hd2) < 3.0) dens += exp(-hd2 * hd2) * smoothstep(0.45, 0.85, vnoise(vec2(x * 5.0 + uFlowT * 0.07, y * 4.0))) * u_haze * 0.5;

  float glow = 0.0;
  for (int i = 0; i < ${MAX}; i++) {
    if (float(i) >= uN) break;
    float cx = uX[i];
    float hw = uW[i] * 0.5;
    float dx = (x - cx) / max(hw, 1e-4);
    // nothing to do far from this column (its halo dies out within ~0.06 of the screen)
    if (abs(x - cx) > hw + 0.07) continue;
    float top = uB[i] + uH[i];
    float bot = uB[i];
    float inY = smoothstep(bot - 0.02, bot + 0.05, y) * (1.0 - smoothstep(top - 0.2 * uH[i] - 0.02, top + 0.015, y));
    float inX = 1.0 - smoothstep(0.75, 1.0, abs(dx));
    float m = inX * inY;
    if (uKind[i] > 0.5) {
      // dark slot: cuts the haze
      dens *= 1.0 - m * 0.92;
    } else {
      // bright column: lit along one side, a hot tip near the top, noise rising through it
      float side = smoothstep(-1.0, 1.0, dx * (mod(float(i), 2.0) * 2.0 - 1.0));
      float tip = exp(-pow((y - top + 0.03) / 0.05, 2.0));
      // two octaves of value noise rising through the column (cheaper than fbm, same look once dithered)
      vec2 nq = vec2(x * 40.0 + float(i) * 7.0, y * 7.0 - uFlowT * (0.6 + 0.4 * hash11(float(i))));
      float n = m > 0.0 ? vnoise(nq) * 0.65 + vnoise(nq * 2.3 + 5.1) * 0.35 : 0.5;
      float vert = mix(0.5, 1.0, smoothstep(bot, top, y));
      // a bright core stripe near the lit side gives each column a crisp vertical edge
      float sgn = mod(float(i), 2.0) * 2.0 - 1.0;
      float core = exp(-pow((dx * sgn - 0.45) / 0.28, 2.0));
      float d = m * (0.22 + 0.35 * side + 0.35 * tip + 0.45 * core) * vert * (0.45 + 0.8 * n);
      dens = max(dens, d) + d * 0.15;
      // soft bloom halo (not dithered)
      float gx = abs(dx) * hw;
      float gy = max(0.0, y - top) + max(0.0, bot - y);
      glow += exp(-gx * gx / (0.0009 + 0.0025 * uKickE)) * exp(-gy * 9.0) * (0.35 + uH[i]);
    }
  }
  dens = clamp(dens * (1.0 + 0.6 * uFlash), 0.0, 1.0);

  // ── stipple: one dot per cell, lit when its hash is under the density ──
  float h = hash21(ci + floor(uSeedT) * vec2(17.0, 31.0));
  float lit = step(h, dens * 0.95);
  vec2 inCell = fract(fc / cell);
  float dotShape = cell >= 2.0 ? step(max(abs(inCell.x - 0.5), abs(inCell.y - 0.5)), 0.38) : 1.0;
  float dotsA = lit * dotShape;

  vec3 cyan = uAccent;
  vec3 dotCol = mix(cyan, uFg, smoothstep(0.45, 1.0, dens) * u_white);
  float g = glow * u_glow * (0.18 + 0.5 * uKickE + 0.5 * uFlash);
  vec3 col;
  if (uLight > 0.5) {
    col = mix(uBg, mix(uAccent2, uFg, dens), dotsA);
    col = mix(col, uAccent, clamp(g, 0.0, 0.4));
  } else {
    col = uBg + cyan * g * 0.6;
    col = mix(col, dotCol, dotsA);
    col += cyan * dens * dens * 0.12 * u_glow;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export const particleColumns = defineThreeScene({
  id: 'particle-columns',
  name: 'Particle Columns',
  description:
    'A spectrum made of noise: columns of fine stippled, glowing dots rise and fall with their frequency band, a soft haze band drifts behind them and dark slots cut through it. Kicks make the columns jump and bloom, snares flash the field, and a drop re-deals the columns.',
  category: 'field',
  style: 'particles',
  tags: ['electronic', 'cosmic', 'hypnotic', 'techno', 'ambient', 'dark', 'cold', 'energetic', 'dreamy'],
  params,
  modulations: [
    { source: 'energy', param: 'haze', amount: 0.15 },
    { source: 'air', param: 'flow', amount: 0.15 },
  ],
  build(init) {
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const X = new Float32Array(MAX);
    const Wd = new Float32Array(MAX);
    const H = new Float32Array(MAX);
    const B = new Float32Array(MAX);
    const K = new Float32Array(MAX);
    const mat = makeMaterial({
      params,
      shared: init.shared,
      vertex: VERT,
      fragment: FRAG,
      depthTest: false,
      depthWrite: false,
      extra: {
        uX: { value: X },
        uW: { value: Wd },
        uH: { value: H },
        uB: { value: B },
        uKind: { value: K },
        uN: { value: 14 },
        uFlowT: { value: 0 },
        uSeedT: { value: 0 },
        uKickE: { value: 0 },
        uFlash: { value: 0 },
        uLight: { value: 0 },
        uHazeY: { value: 0.5 },
      },
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    scene.add(quad);

    const springs = Array.from({ length: MAX }, () => new Spring(90, 9, 0.2));
    const bins = new Int32Array(MAX);
    const base = new Float32Array(MAX);
    const wjit = new Float32Array(MAX);
    const xjit = new Float32Array(MAX);
    const r = new Float32Array(MAX);
    let deal = 0;
    const redeal = () => {
      deal++;
      for (let i = 0; i < MAX; i++) {
        xjit[i] = Math.random() - 0.5;
        wjit[i] = 0.5 + Math.random() * 0.8;
        r[i] = Math.random();
        // most columns stand on the floor, a few float
        base[i] = Math.random() < 0.22 ? 0.25 + Math.random() * 0.4 : -0.05;
      }
      // spectrum bins in a shuffled order so neighbours don't form a staircase
      const order = Array.from({ length: MAX }, (_, i) => i);
      for (let i = MAX - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      for (let i = 0; i < MAX; i++) bins[i] = order[i];
    };
    redeal();

    let flowT = 0;
    let seedT = 0;
    let flash = 0;
    let kickE = 0;
    let prevDrop = 0;
    let hazeY = 0.5;

    return {
      scene,
      camera,
      update(frame) {
        const dt = stepDt(frame);
        const a = frame.audio;
        const p = frame.params;
        syncMaterial(mat, frame, params);
        const n = Math.round(num(p, 'columns', 14));
        const rise = num(p, 'rise', 0.85);
        const kickAmt = num(p, 'kick', 0.55);
        const dark = num(p, 'dark', 0.35);
        const width = num(p, 'width', 0.75);

        if (a.drop > 0.6 && prevDrop <= 0.6) {
          redeal();
          flash = 1;
          for (const s of springs) s.vel += 6;
        }
        prevDrop = a.drop;
        if (a.kickHit) {
          kickE = 1;
          for (let i = 0; i < n; i++) if (bins[i] % 3 === 0 || r[i] < 0.4) springs[i].vel += kickAmt * (2 + 3 * a.kick);
        }
        if (a.snareHit) flash = Math.max(flash, 0.55);
        kickE = approach(kickE, 0, 6, dt);
        flash = approach(flash, 0, 4, dt);

        const sp = a.spectrum;
        for (let i = 0; i < MAX; i++) {
          // each column listens to a slice of the (log-spaced) spectrum
          const slice = Math.max(1, Math.floor(110 / n));
          const b0 = Math.min(118, (bins[i] % n) * slice + 2);
          let v = 0;
          for (let k = 0; k < slice; k++) v += sp[b0 + k] ?? 0;
          v /= slice;
          const tilt = 1 + (b0 / 128) * 0.9; // highs read quieter, lift them
          // the spectrum is gain-controlled (mostly 0.3–0.9), so stretch it for contrast
          const vv = Math.max(0, Math.min(1, (v * tilt - 0.25) / 0.7));
          const target = 0.06 + vv * vv * 0.95 * (0.55 + 0.45 * wjit[i] / 1.25) * rise * (base[i] > 0 ? 0.5 : 1) + (a.playing ? 0 : 0.25 + 0.15 * Math.sin(frame.time * 0.7 + i));
          springs[i].step(target, dt);
          H[i] = Math.max(0.02, springs[i].value);
          X[i] = (i + 0.5 + xjit[i] * 0.7) / n;
          Wd[i] = (wjit[i] * width) / n;
          B[i] = base[i];
          K[i] = r[i] < dark ? 1 : 0;
        }

        flowT += dt * (0.3 + num(p, 'flow', 0.4) * 2.2) * (0.6 + a.energy * 0.8 + a.hat * 0.4);
        // dither re-rolls ~24/s, faster with hats
        seedT += dt * (16 + 30 * a.hat + 10 * a.energy);
        hazeY = approach(hazeY, 0.52 + a.sway * 0.04 + (deal % 2 ? 0.06 : -0.02), 0.8, dt);

        const u = mat.uniforms;
        u.uN.value = n;
        u.uFlowT.value = flowT % 1000;
        u.uSeedT.value = seedT % 4096;
        u.uKickE.value = kickE;
        u.uFlash.value = flash;
        u.uLight.value = isLightPalette(frame.palette) ? 1 : 0;
        u.uHazeY.value = hazeY;
      },
    };
  },
});
