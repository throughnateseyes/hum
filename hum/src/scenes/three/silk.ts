import * as THREE from 'three';
import { defineThreeScene } from '../../core/sceneHelpers';
import { num } from '../../core/uniforms';
import type { ParamDef } from '../../core/types';
import { approach, isLightPalette, makeMaterial, Spring, stepDt, syncMaterial } from './common';

// spectrum history carried across the sheet (rows flow from the near edge to the far edge)
const SROWS = 48;
const SBINS = 16;
const SRATE = 12; // rows / sec
const KSLOTS = 4;

const params: ParamDef[] = [
  { id: 'fold', label: 'Folds', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.55 },
  { id: 'scale', label: 'Scale', group: 'Shape', type: 'number', min: 0.4, max: 2, step: 0.01, default: 1 },
  { id: 'speed', label: 'Drift', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.25 },
  { id: 'swell', label: 'Mid swell', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6 },
  { id: 'sheen', label: 'Sheen', group: 'Surface', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, hint: 'Anisotropic silk highlight' },
  { id: 'glitter', label: 'Air glitter', group: 'Surface', type: 'number', min: 0, max: 1, step: 0.01, default: 0.4 },
  { id: 'tint', label: 'Colour depth', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.65, hint: 'Pearl → saturated accent' },
  { id: 'tilt', label: 'View tilt', group: 'Style', type: 'number', min: 0, max: 1, step: 0.01, default: 0.45 },
  { id: 'light', label: 'Light angle', group: 'Style', type: 'number', min: 0, max: 1, step: 0.01, default: 0.35 },
  { id: 'billow', label: 'Kick billow', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Each kick snaps a soft bump up through the cloth' },
  { id: 'ripple', label: 'Kick ripple', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.55, hint: 'Rings that travel out across the sheet from each kick' },
  { id: 'gust', label: 'Drop gust', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.75, hint: 'A big wave rolls through the silk when the drop hits' },
  { id: 'spectrum', label: 'Spectrum flow', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.45, hint: 'The spectrum rides across the sheet as soft ridges (bass in the middle)' },
  { id: 'tension', label: 'Build tension', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Build-ups pull the silk taut into fine trembling creases' },
  { id: 'heave', label: 'Sub heave', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'Sub lifts the whole sheet in slow heavy swells' },
];

const VERT = /* glsl */ `
uniform float uT, uAmp, uTrem, uTension, uHeave, uGustY, uGustA, uSpecAmt;
uniform vec4 uKX, uKY, uKAge, uKAmp;
uniform sampler2D uSpecHist;
uniform float uSpecHead, uSpecFrac;
varying vec3 vWPos;
varying vec3 vN;
varying vec3 vTan;
varying float vH;

const float SROWS = ${SROWS.toFixed(1)};
const float SBINS = ${SBINS.toFixed(1)};

// smooth (C1) sample of the spectrum history: hides the bilinear kinks the sheen would show
float specHist(vec2 xy) {
  float bin = clamp(abs(xy.x) / 8.0, 0.0, 1.0) * (SBINS - 1.0);
  // spatial row (1 = newest, at the near edge); +frac keeps the flow continuous between pushes
  float row = 1.0 + clamp((xy.y + 6.0) / 12.0, 0.0, 1.0) * (SROWS - 2.0);
  float slot = uSpecHead + uSpecFrac - row;
  vec2 c = vec2(bin + 0.5, slot + 0.5);
  vec2 i = floor(c - 0.5);
  vec2 f = c - 0.5 - i;
  f = f * f * (3.0 - 2.0 * f);
  vec2 uv = (i + 0.5 + f) / vec2(SBINS, SROWS);
  return texture2D(uSpecHist, uv).r;
}

// impulse response of a plucked sheet: snaps up fast, overshoots below, settles
float snap(float age) {
  return (1.0 - exp(-age * 40.0)) * exp(-age * 3.5) * cos(age * 7.0);
}

float H(vec2 p) {
  vec2 q = p * 0.36 * u_scale;
  float w = snoise(vec3(q * 0.45, uT * 0.05)) * 1.3;
  float h = sin(q.x * 1.25 + q.y * 0.35 + uT * 0.55 + w) * 0.55;
  h += sin(q.x * -0.62 + q.y * 1.05 - uT * 0.41 + w * 0.7) * 0.36;
  h += fbm3(vec3(q * 1.3, uT * 0.11), 3) * 0.42;
  h *= uAmp;

  // build tension: fine parallel creases that tremble faster as the build climbs
  if (uTension > 0.001) {
    float cr = sin(q.x * 9.0 + q.y * 2.2 + uTrem) * 0.6 + sin(q.x * -5.5 + q.y * 7.0 - uTrem * 1.3) * 0.4;
    h += cr * uTension * 0.12;
  }

  // sub heave: a slow broad swell lifting the middle of the sheet
  h += uHeave * (0.55 + 0.45 * sin(p.x * 0.22 - uT * 0.3)) * exp(-dot(p, p) * 0.02);

  // spectrum riding across the sheet
  if (uSpecAmt > 0.001) {
    float edge = 1.0 - smoothstep(4.0, 9.0, abs(p.x));
    h += specHist(p) * uSpecAmt * edge;
  }

  // kicks: a snapping bump at the hit point + a ring that travels outward
  for (int i = 0; i < ${KSLOTS}; i++) {
    float age = uKAge[i];
    if (age < 3.0) {
      vec2 d = p - vec2(uKX[i], uKY[i]);
      float r2 = dot(d, d);
      h += uKAmp[i] * u_billow * 1.6 * snap(age) * exp(-r2 * 0.16);
      float front = sqrt(r2) - age * 4.2;
      h += uKAmp[i] * u_ripple * 0.5 * sin(front * 3.4) * exp(-front * front * 0.9) * exp(-age * 1.3);
    }
  }

  // drop gust: one big wave rolls from the near edge to the far edge
  if (uGustA > 0.001) {
    float g = p.y - uGustY;
    float crest = exp(-g * g * 0.28) * (1.0 + 0.35 * sin(p.x * 0.7 + uT));
    float wake = sin(g * 2.6) * exp(-max(-g, 0.0) * 0.5) * step(g, 0.0) * 0.28;
    h += uGustA * (crest * 1.6 + wake);
  }
  return h;
}

void main() {
  vUv = uv;
  vec2 xy = position.xy;
  float e = 0.03;
  float h = H(xy);
  float hx = H(xy + vec2(e, 0.0));
  float hy = H(xy + vec2(0.0, e));
  vec3 n = normalize(vec3(-(hx - h) / e, -(hy - h) / e, 1.0));
  vec3 tg = normalize(vec3(1.0, 0.0, (hx - h) / e));
  vH = h;
  vec4 wp = modelMatrix * vec4(xy, h, 1.0);
  vWPos = wp.xyz;
  vN = normalize(mat3(modelMatrix) * n);
  vTan = normalize(mat3(modelMatrix) * tg);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uBase, uShade, uSheenCol, uLightDir;
uniform float uGlit;
varying vec3 vWPos;
varying vec3 vN;
varying vec3 vTan;
varying float vH;

void main() {
  vec3 n = normalize(vN);
  vec3 V = normalize(cameraPosition - vWPos);
  if (dot(n, V) < 0.0) n = -n;
  vec3 T = normalize(vTan - n * dot(vTan, n));
  vec3 L = normalize(uLightDir);
  vec3 H = normalize(L + V);

  float wrap = 0.6;
  float diff = clamp((dot(n, L) + wrap) / (1.0 + wrap), 0.0, 1.0);
  diff = pow(diff, 1.4);
  vec3 col = mix(uShade, uBase, diff);

  // Kajiya-Kay anisotropic sheen along the threads
  float th = dot(T, H);
  float sinTH = sqrt(max(1.0 - th * th, 0.0));
  float dirAtten = smoothstep(-0.6, 0.3, dot(n, L));
  float sharp = pow(sinTH, 90.0);
  float broad = pow(sinTH, 10.0);
  col += uSheenCol * (sharp * 0.65 + broad * 0.22) * u_sheen * dirAtten;
  // velvet edge
  float fres = pow(1.0 - max(dot(n, V), 0.0), 2.5);
  col = mix(col, uSheenCol, fres * 0.22 * u_sheen);

  // glitter: tiny cells that wink where the sheen catches
  vec2 cell = floor(vUv * vec2(900.0, 600.0));
  float r = hash21(cell);
  float tw = 0.5 + 0.5 * sin(uTime * (3.0 + r * 5.0) + r * 60.0);
  float g = step(1.0 - uGlit * 0.05 - 0.0015, r) * tw * (0.3 + 0.7 * broad);
  vec2 sub = fract(vUv * vec2(900.0, 600.0)) - 0.5;
  g *= smoothstep(0.5, 0.0, length(sub));
  col += mix(uSheenCol, vec3(1.0), 0.4) * g * (0.6 + 0.6 * u_glitter);

  // soft fade to the backdrop at the far edges + depth haze
  float edge = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x) * smoothstep(0.0, 0.2, vUv.y) * smoothstep(1.0, 0.7, vUv.y);
  float haze = smoothstep(6.0, 15.0, length(cameraPosition - vWPos));
  col = mix(col, uBg, clamp((1.0 - edge) + haze * 0.6, 0.0, 1.0));
  col += (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`;

export const silk = defineThreeScene({
  id: 'silk',
  name: 'Silk',
  description:
    'A large sheet of silk drifting in slow layered folds with an anisotropic sheen. Kicks snap the cloth up and send rings across it, the spectrum rides over the sheet as soft ridges, sub heaves it, builds pull it taut and a drop sends a great wave rolling through. Made for sad, ambient and romantic tracks.',
  category: 'form',
  style: 'light',
  tags: ['sad', 'ambient', 'romantic', 'dreamy', 'slow', 'elegant', 'emotional', 'soft', 'luxurious'],
  params,
  modulations: [
    { source: 'lowMid', param: 'fold', amount: 0.15 },
    { source: 'brightness', param: 'sheen', amount: 0.2 },
  ],
  build(init) {
    const scene = new THREE.Scene();
    const bg = new THREE.Color();
    scene.background = bg;
    const camera = new THREE.PerspectiveCamera(34, init.width / Math.max(1, init.height), 0.1, 100);

    const geo = new THREE.PlaneGeometry(18, 12, 360, 240);

    // 8-bit so linear filtering is always available; rows wrap (ring buffer)
    const specData = new Uint8Array(SBINS * SROWS);
    const specTex = new THREE.DataTexture(specData, SBINS, SROWS, THREE.RedFormat, THREE.UnsignedByteType);
    specTex.minFilter = THREE.LinearFilter;
    specTex.magFilter = THREE.LinearFilter;
    specTex.wrapS = THREE.ClampToEdgeWrapping;
    specTex.wrapT = THREE.RepeatWrapping;
    specTex.colorSpace = THREE.NoColorSpace;
    specTex.generateMipmaps = false;
    specTex.unpackAlignment = 1;
    specTex.needsUpdate = true;
    const mat = makeMaterial({
      params,
      shared: init.shared,
      vertex: VERT,
      fragment: FRAG,
      side: THREE.DoubleSide,
      extra: {
        uT: { value: 0 },
        uAmp: { value: 0.5 },
        uTrem: { value: 0 },
        uTension: { value: 0 },
        uHeave: { value: 0 },
        uGustY: { value: -20 },
        uGustA: { value: 0 },
        uSpecAmt: { value: 0 },
        uKX: { value: new THREE.Vector4() },
        uKY: { value: new THREE.Vector4() },
        uKAge: { value: new THREE.Vector4(99, 99, 99, 99) },
        uKAmp: { value: new THREE.Vector4() },
        uSpecHist: { value: specTex },
        uSpecHead: { value: 0 },
        uSpecFrac: { value: 0 },
        uBase: { value: new THREE.Color() },
        uShade: { value: new THREE.Color() },
        uSheenCol: { value: new THREE.Color() },
        uLightDir: { value: new THREE.Vector3(-0.4, 0.8, 0.5) },
        uGlit: { value: 0 },
        uLight: { value: 0 },
      },
    });
    const cloth = new THREE.Mesh(geo, mat);
    cloth.frustumCulled = false;
    scene.add(cloth);

    let t = 0;
    const swell = new Spring(10, 5);
    const heave = new Spring(9, 4.5);
    let glit = 0;
    let trem = 0;
    let tension = 0;
    let gustT = 99;
    let gustPeak = 0;
    let dropPrev = 0;
    let kSlot = 0;
    let specHead = 0;
    let specAcc = 0;
    const specSmooth = new Float32Array(SBINS);
    const kX = new THREE.Vector4();
    const kY = new THREE.Vector4();
    const kAge = new THREE.Vector4(99, 99, 99, 99);
    const kAmp = new THREE.Vector4();
    const tmp = new THREE.Color();
    const WHITE = new THREE.Color(1, 1, 1);

    return {
      scene,
      camera,
      update(frame) {
        const dt = stepDt(frame);
        const a = frame.audio;
        const p = frame.params;
        const pal = frame.palette.c;
        const light = isLightPalette(frame.palette);
        syncMaterial(mat, frame, params);
        bg.copy(pal.bg);

        // drift: integrated, calm in silence; the drop adds a short rush
        t += dt * (0.15 + num(p, 'speed', 0.25) * 1.6) * (0.6 + a.energy * 1.2 + a.drop * 1.5);
        swell.step(a.mid * 0.8 + a.lowMid * 0.3, dt);
        heave.step(a.sub * 0.8 + a.bass * 0.25, dt);
        glit = approach(glit, a.air * 0.8 + a.hat * 0.6, 8, dt);
        tension = approach(tension, a.build * (1 - a.drop), 3, dt);
        trem += dt * (1.5 + tension * 14);

        // kicks: spawn a bump + travelling ring somewhere in the visible middle of the sheet
        for (let i = 0; i < KSLOTS; i++) kAge.setComponent(i, Math.min(99, kAge.getComponent(i) + dt));
        if (a.kickHit) {
          kX.setComponent(kSlot, (Math.random() * 2 - 1) * 4.2);
          kY.setComponent(kSlot, (Math.random() * 2 - 1) * 2.4 - 0.6);
          kAge.setComponent(kSlot, 0);
          kAmp.setComponent(kSlot, 0.55 + Math.min(1, a.kick) * 0.45);
          kSlot = (kSlot + 1) % KSLOTS;
        }

        // drop: one gust rolls from the near edge (y = -6) to the far edge
        if (a.drop > 0.6 && dropPrev <= 0.6) {
          gustT = 0;
          gustPeak = a.drop;
        }
        dropPrev = a.drop;
        gustT = Math.min(gustT + dt, 99);
        const gustA = gustT < 3.5 ? gustPeak * Math.exp(-gustT * 0.45) : 0;

        // spectrum history (fixed rate, bins averaged down to SBINS)
        const spec = a.spectrum;
        const per = Math.max(1, Math.floor(spec.length / SBINS));
        for (let b = 0; b < SBINS; b++) {
          let sum = 0;
          for (let k = 0; k < per; k++) sum += spec[b * per + k] ?? 0;
          specSmooth[b] = approach(specSmooth[b], sum / per, 14, dt);
        }
        specAcc += dt * SRATE * (a.playing ? 1 : 0.35);
        let pushed = false;
        while (specAcc >= 1) {
          specAcc -= 1;
          specHead = (specHead + 1) % SROWS;
          for (let b = 0; b < SBINS; b++) specData[specHead * SBINS + b] = Math.round(Math.min(1, Math.max(0, specSmooth[b])) * 255);
          pushed = true;
        }
        if (pushed) specTex.needsUpdate = true;

        const u = mat.uniforms;
        u.uT.value = t;
        // build pulls the big folds flatter (taut) while the fine creases take over
        const taut = 1 - tension * num(p, 'tension', 0.6) * 0.45;
        u.uAmp.value = (0.3 + num(p, 'fold', 0.55) * 0.95) * (1 + Math.max(0, swell.value) * num(p, 'swell', 0.6) * 0.9) * taut * (1 + a.drop * 0.5);
        u.uTrem.value = trem % (Math.PI * 200); // 20π-periodic for every multiplier used in the shader
        u.uTension.value = tension * num(p, 'tension', 0.6);
        u.uHeave.value = Math.max(-0.2, heave.value) * num(p, 'heave', 0.5) * 1.6;
        u.uGustY.value = -8 + gustT * 7.5;
        u.uGustA.value = gustA * num(p, 'gust', 0.75);
        u.uSpecAmt.value = num(p, 'spectrum', 0.45) * 1.1;
        (u.uKX.value as THREE.Vector4).copy(kX);
        (u.uKY.value as THREE.Vector4).copy(kY);
        (u.uKAge.value as THREE.Vector4).copy(kAge);
        (u.uKAmp.value as THREE.Vector4).copy(kAmp);
        u.uSpecHead.value = specHead;
        u.uSpecFrac.value = specAcc;
        u.uGlit.value = Math.min(1, 0.05 + glit * num(p, 'glitter', 0.4) * 1.5);
        u.uLight.value = light ? 1 : 0;

        // colours
        const tint = num(p, 'tint', 0.65);
        const pearl = light ? tmp.copy(pal.bg).lerp(pal.muted, 0.5) : tmp.copy(pal.muted).lerp(pal.fg, 0.25);
        const base = u.uBase.value as THREE.Color;
        base.copy(pearl).lerp(pal.accent, tint);
        const shade = u.uShade.value as THREE.Color;
        shade.copy(base).multiplyScalar(light ? 0.42 : 0.22);
        if (light) shade.lerp(pal.fg, 0.12);
        const sheen = u.uSheenCol.value as THREE.Color;
        sheen.copy(pal.accent2).lerp(light ? WHITE : pal.fg, 0.45);

        const la = (num(p, 'light', 0.35) - 0.5) * Math.PI * 1.4;
        (u.uLightDir.value as THREE.Vector3).set(Math.sin(la) * 0.8, 0.75, Math.cos(la) * 0.6 + 0.2);

        // framing: tilt the sheet, drift the camera with the bar
        const tilt = num(p, 'tilt', 0.45);
        cloth.rotation.set(-(0.55 + tilt * 0.75), 0, 0.12 + a.sway * 0.02);
        const fit = Math.max(1, 1.6 / Math.max(0.3, frame.aspect));
        camera.position.set(a.sway * 0.25, 0.3, 7.2 * fit);
        camera.lookAt(0, -0.2, 0);
      },
      dispose() {
        specTex.dispose();
      },
    };
  },
});
