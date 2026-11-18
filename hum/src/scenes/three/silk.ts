import * as THREE from 'three';
import { defineThreeScene } from '../../core/sceneHelpers';
import { num } from '../../core/uniforms';
import type { ParamDef } from '../../core/types';
import { approach, isLightPalette, makeMaterial, Spring, stepDt, syncMaterial } from './common';

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
];

const VERT = /* glsl */ `
uniform float uT, uAmp;
varying vec3 vWPos;
varying vec3 vN;
varying vec3 vTan;
varying float vH;

float H(vec2 p) {
  vec2 q = p * 0.36 * u_scale;
  float w = snoise(vec3(q * 0.45, uT * 0.05)) * 1.3;
  float h = sin(q.x * 1.25 + q.y * 0.35 + uT * 0.55 + w) * 0.55;
  h += sin(q.x * -0.62 + q.y * 1.05 - uT * 0.41 + w * 0.7) * 0.36;
  h += fbm3(vec3(q * 1.3, uT * 0.11), 3) * 0.42;
  return h * uAmp;
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
    'A large sheet of silk drifting in slow layered folds with an anisotropic sheen. Mids swell the folds, air makes it glitter, energy speeds the drift. Made for sad, ambient and romantic tracks.',
  category: 'form',
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
    const mat = makeMaterial({
      params,
      shared: init.shared,
      vertex: VERT,
      fragment: FRAG,
      side: THREE.DoubleSide,
      extra: {
        uT: { value: 0 },
        uAmp: { value: 0.5 },
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
    let glit = 0;
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

        t += dt * (0.15 + num(p, 'speed', 0.25) * 1.6) * (0.7 + a.energy * 1.6);
        swell.step(a.mid * 0.8 + a.lowMid * 0.3, dt);
        glit = approach(glit, a.air * 0.8 + a.hat * 0.6, 8, dt);

        const u = mat.uniforms;
        u.uT.value = t;
        u.uAmp.value = (0.3 + num(p, 'fold', 0.55) * 0.95) * (1 + Math.max(0, swell.value) * num(p, 'swell', 0.6) * 0.9);
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
    };
  },
});
