import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { defineThreeScene } from '../../core/sceneHelpers';
import { num } from '../../core/uniforms';
import type { ParamDef } from '../../core/types';
import {
  BACKDROP_VERT,
  isLightPalette,
  makeBackdrop,
  makeMaterial,
  Spring,
  approach,
  stepDt,
  syncMaterial,
} from './common';

const params: ParamDef[] = [
  { id: 'size', label: 'Size', group: 'Shape', type: 'number', min: 0.5, max: 1.4, step: 0.01, default: 1 },
  { id: 'blob', label: 'Blobbiness', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.45, hint: 'Low-frequency lumpiness' },
  { id: 'inflate', label: 'Sub inflate', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.55 },
  { id: 'dent', label: 'Kick dent', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6 },
  { id: 'ripple', label: 'Mid ripple', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
  { id: 'grain', label: 'Air grain', group: 'Surface', type: 'number', min: 0, max: 1, step: 0.01, default: 0.35 },
  { id: 'spike', label: 'Drop shatter', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7 },
  { id: 'spin', label: 'Spin', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.25 },
  { id: 'tint', label: 'Accent tint', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.25 },
  { id: 'glaze', label: 'Glaze', group: 'Surface', type: 'number', min: 0, max: 1, step: 0.01, default: 0.2, hint: 'Matte clay → glazed ceramic' },
];

const VERT = /* glsl */ `
uniform float uT, uInfl, uPunch, uDent, uRip, uSpike;
uniform vec3 uDentDir;
varying vec3 vN;
varying vec3 vWPos;
varying vec3 vDir;
varying float vCav;

// 3D cellular F1 → conical spikes at cell centres
float spikes(vec3 p) {
  vec3 q = p * 3.4;
  vec3 i = floor(q);
  vec3 f = fract(q);
  float d = 8.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 h = i + o;
    vec3 r = vec3(hash21(h.xy + h.z * 17.0), hash21(h.yz + h.x * 31.0), hash21(h.zx + h.y * 7.0));
    d = min(d, length(o + r - f));
  }
  return pow(max(1.0 - d * 1.7, 0.0), 1.6);
}

// local (non-global) displacement → used for cavities / AO
float localDisp(vec3 p) {
  float d = fbm3(p * 1.15 + vec3(0.0, uT * 0.11, uT * 0.05), 3) * (0.06 + 0.3 * u_blob);
  float a = acos(clamp(dot(p, uDentDir), -1.0, 1.0));
  d -= uDent * u_dent * 0.42 * exp(-a * a * 5.0);
  // ripples radiating from the dent site + a slow band ripple driven by mids
  d += sin(a * 17.0 - uT * 6.0) * exp(-a * 0.9) * uRip * u_ripple * 0.05;
  d += sin(dot(p, normalize(vec3(0.3, 1.0, 0.2))) * 13.0 + uT * 3.0) * uRip * u_ripple * 0.022;
  if (uSpike > 0.002) d += uSpike * u_spike * spikes(p) * 0.85;
  return d;
}
float globalDisp() { return uInfl * u_inflate * 0.26 + uPunch * u_dent * 0.06; }

vec3 surf(vec3 p) { return p * (1.0 + globalDisp() + localDisp(p)); }

void main() {
  vec3 p = normalize(position);
  vec3 up = abs(p.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t = normalize(cross(up, p));
  vec3 b = cross(p, t);
  float e = 0.012;
  float ld = localDisp(p);
  vec3 p0 = p * (1.0 + globalDisp() + ld);
  vec3 p1 = surf(normalize(p + t * e));
  vec3 p2 = surf(normalize(p + b * e));
  vec3 n = normalize(cross(p1 - p0, p2 - p0));
  vCav = ld;
  vDir = p;
  vN = normalize(mat3(modelMatrix) * n);
  vec4 wp = modelMatrix * vec4(p0, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uClay, uShadow, uLightCol, uRimCol;
uniform float uGrainAmt;
varying vec3 vN;
varying vec3 vWPos;
varying vec3 vDir;
varying float vCav;

void main() {
  vec3 n = normalize(vN);
  // fine grain: tiny normal perturbation pinned to the surface
  vec3 g = vec3(snoise(vDir * 95.0), snoise(vDir * 95.0 + 17.0), snoise(vDir * 95.0 + 41.0));
  vec3 g2 = vec3(snoise(vDir * 260.0 + 3.0), snoise(vDir * 260.0 + 9.0), snoise(vDir * 260.0 + 27.0));
  n = normalize(n + (g * 0.6 + g2 * 0.4) * uGrainAmt);

  vec3 V = normalize(cameraPosition - vWPos);
  vec3 L = normalize(vec3(-0.55, 0.85, 0.65));
  float w = 0.55;
  float diff = clamp((dot(n, L) + w) / (1.0 + w), 0.0, 1.0);
  diff = diff * diff * (3.0 - 2.0 * diff);
  float hemi = 0.5 + 0.5 * n.y;
  float ao = clamp(0.72 + vCav * 2.2, 0.35, 1.0);
  ao *= mix(0.78, 1.0, smoothstep(-0.9, 0.2, n.y)); // underside occlusion near floor

  vec3 col = mix(uShadow, uClay, diff);
  col *= mix(0.86, 1.04, hemi);
  col *= ao;
  // bounce from the backdrop + rim
  float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  col += uRimCol * fres * 0.28 * (0.4 + 0.6 * hemi);
  // glaze
  vec3 H = normalize(L + V);
  float shin = mix(10.0, 120.0, u_glaze);
  float spec = pow(max(dot(n, H), 0.0), shin) * (0.06 + u_glaze * 0.7);
  col += uLightCol * spec;
  col += (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`;

const BG_FRAG = /* glsl */ `
uniform vec3 uShadowCol;
uniform vec3 uShadowP; // x, y (centred, aspect units), width
uniform float uShadowA;
void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  vec3 top = uBg * 1.02;
  vec3 floorC = mix(uBg, uMuted, 0.18);
  vec3 col = mix(floorC, top, smoothstep(-0.55, 0.45, p.y));
  col *= 1.0 - 0.1 * dot(p, p);
  vec2 s = (p - uShadowP.xy) / vec2(uShadowP.z, uShadowP.z * 0.16);
  float sh = exp(-dot(s, s)) * uShadowA;
  vec2 s2 = (p - uShadowP.xy) / vec2(uShadowP.z * 1.9, uShadowP.z * 0.45);
  sh += exp(-dot(s2, s2)) * uShadowA * 0.35;
  col = mix(col, uShadowCol, clamp(sh, 0.0, 1.0));
  col += (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`;

export const clayOrb = defineThreeScene({
  id: 'clay-orb',
  name: 'Clay Orb',
  description:
    'A matte clay blob on a studio backdrop. Sub slowly inflates it, kicks punch dents that ring out as ripples, mids ripple the skin, air adds fine grain and a drop briefly shatters it into spikes.',
  category: 'form',
  tags: ['calm', 'organic', 'soft', 'minimal', 'warm', 'bouncy', 'playful', 'tactile'],
  light: true,
  params,
  modulations: [
    { source: 'bass', param: 'blob', amount: 0.2 },
    { source: 'brightness', param: 'glaze', amount: 0.3 },
    { source: 'energy', param: 'spin', amount: 0.25 },
  ],
  build(init) {
    const scene = new THREE.Scene();
    const bg = new THREE.Color();
    scene.background = bg;
    const camera = new THREE.PerspectiveCamera(30, init.width / Math.max(1, init.height), 0.1, 50);
    camera.position.set(0, 0.35, 5.8);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();

    // indexed icosphere (~64k shared verts) so the displacement runs once per vertex
    const ico = new THREE.IcosahedronGeometry(1, 80);
    ico.deleteAttribute('normal');
    ico.deleteAttribute('uv');
    const geo = mergeVertices(ico);
    ico.dispose();
    const mat = makeMaterial({
      params,
      shared: init.shared,
      vertex: VERT,
      fragment: FRAG,
      extra: {
        uT: { value: 0 },
        uInfl: { value: 0 },
        uPunch: { value: 0 },
        uDent: { value: 0 },
        uRip: { value: 0 },
        uSpike: { value: 0 },
        uDentDir: { value: new THREE.Vector3(0, 0, 1) },
        uClay: { value: new THREE.Color() },
        uShadow: { value: new THREE.Color() },
        uLightCol: { value: new THREE.Color() },
        uRimCol: { value: new THREE.Color() },
        uGrainAmt: { value: 0 },
      },
    });
    const orb = new THREE.Mesh(geo, mat);
    orb.frustumCulled = false;
    scene.add(orb);

    const bgMat = makeMaterial({
      params,
      shared: init.shared,
      vertex: BACKDROP_VERT,
      fragment: BG_FRAG,
      extra: {
        uShadowCol: { value: new THREE.Color() },
        uShadowP: { value: new THREE.Vector3(0, -0.4, 0.3) },
        uShadowA: { value: 0.3 },
      },
    });
    scene.add(makeBackdrop(bgMat));

    const infl = new Spring(30, 7);
    const dent = new Spring(140, 9);
    const punch = new Spring(220, 14);
    let rip = 0;
    let spike = 0;
    let air = 0;
    let t = 0;
    let bob = 0;
    const dirWorld = new THREE.Vector3();
    const invQ = new THREE.Quaternion();
    const tmp = new THREE.Color();
    const proj = new THREE.Vector3();
    const WHITE = new THREE.Color(1, 1, 1);
    const BLACK = new THREE.Color(0, 0, 0);

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
        syncMaterial(bgMat, frame, params);
        bg.copy(pal.bg);

        t += dt * (0.55 + a.energy * 1.1 + a.flux * 0.4);
        infl.step(a.sub, dt);
        dent.step(a.kick, dt);
        punch.step(a.kick * a.kick, dt);
        rip = approach(rip, a.mid + a.lowMid * 0.4, 6, dt);
        spike = a.drop > spike ? approach(spike, a.drop, 25, dt) : approach(spike, a.drop, 3, dt);
        air = approach(air, a.air + a.hat * 0.5, 10, dt);

        // new dent direction on each kick, biased toward the camera so it reads
        if (a.kickHit) {
          dirWorld.set(Math.random() * 2 - 1, Math.random() * 1.6 - 0.6, 1.3 + Math.random()).normalize();
          invQ.copy(orb.quaternion).invert();
          (mat.uniforms.uDentDir.value as THREE.Vector3).copy(dirWorld).applyQuaternion(invQ).normalize();
        }

        const u = mat.uniforms;
        u.uT.value = t;
        u.uInfl.value = Math.max(0, infl.value);
        u.uPunch.value = punch.value;
        u.uDent.value = dent.value;
        u.uRip.value = rip + 0.12; // tiny idle ripple
        u.uSpike.value = spike;
        u.uGrainAmt.value = num(p, 'grain', 0.35) * (0.05 + air * 0.35);

        // colours: clay is built from the "paper" side of the palette
        const paper = light ? pal.bg : pal.fg;
        const clay = u.uClay.value as THREE.Color;
        clay.copy(paper).lerp(pal.muted, 0.3).lerp(pal.accent, num(p, 'tint', 0.25) * 0.85);
        tmp.copy(light ? pal.fg : pal.bg);
        (u.uShadow.value as THREE.Color).copy(clay).multiplyScalar(0.5).lerp(tmp, 0.12).lerp(pal.accent, 0.06);
        (u.uLightCol.value as THREE.Color).copy(paper).lerp(WHITE, 0.5);
        (u.uRimCol.value as THREE.Color).copy(pal.bg).lerp(pal.accent2, 0.25);

        // object motion
        const size = num(p, 'size', 1);
        orb.scale.setScalar(size);
        orb.rotation.y += dt * (0.05 + num(p, 'spin', 0.25) * 0.7);
        orb.rotation.x = a.sway * 0.12;
        bob = Math.sin(frame.time * 0.7) * 0.05 + a.sway * 0.03;
        orb.position.y = bob;

        // contact shadow under the orb
        const r = size * (1 + infl.value * num(p, 'inflate', 0.55) * 0.26);
        proj.set(0, -r * 1.06, 0).project(camera);
        const sy = proj.y * 0.5;
        proj.set(r * 0.9, 0, 0).project(camera);
        const sw = proj.x * 0.5 * frame.aspect;
        const sp = bgMat.uniforms.uShadowP.value as THREE.Vector3;
        sp.set(0, sy - 0.01, sw);
        bgMat.uniforms.uShadowA.value = (light ? 0.36 : 0.6) * (1 - bob * 2.5);
        (bgMat.uniforms.uShadowCol.value as THREE.Color).copy(pal.bg).lerp(light ? pal.fg : BLACK, 0.55);
      },
    };
  },
});
