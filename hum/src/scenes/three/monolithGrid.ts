import * as THREE from 'three';
import { defineThreeScene } from '../../core/sceneHelpers';
import { num } from '../../core/uniforms';
import type { ParamDef } from '../../core/types';
import { approach, floatTexture, makeMaterial, stepDt, syncMaterial } from './common';

const N = 48;
const HIST = 128;

const params: ParamDef[] = [
  { id: 'amp', label: 'Height', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.55 },
  { id: 'ripple', label: 'Ripple speed', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'How fast sound travels out from the centre' },
  { id: 'mix', label: 'Spectrum mix', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.45, hint: '0 = loudness ripple, 1 = spectrum by radius' },
  { id: 'shock', label: 'Kick shockwave', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7 },
  { id: 'invert', label: 'Snare invert', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.8 },
  { id: 'gap', label: 'Gap', group: 'Shape', type: 'number', min: 0, max: 0.6, step: 0.01, default: 0.16 },
  { id: 'edges', label: 'Edge lines', group: 'Style', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7 },
  { id: 'accent', label: 'Accent tops', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
  { id: 'zoom', label: 'Zoom', group: 'Style', type: 'number', min: 0.6, max: 2, step: 0.01, default: 1 },
];

const VERT = /* glsl */ `
attribute vec2 aCell;
uniform sampler2D uHist;
uniform float uHead;
uniform vec4 uShockT, uShockA;
uniform vec3 uInvRow, uInvAmt;
varying vec3 vNrm;
varying float vH;
varying float vInv;
varying vec3 vBox;   // box-local 0..1 coords
varying vec3 vSize;  // box size in world units

const float NH = ${(N / 2).toFixed(1)};
const float HIST = ${HIST.toFixed(1)};

float histAt(float delay) {
  float d0 = floor(delay);
  float f = delay - d0;
  float s0 = mod(uHead - d0 + HIST, HIST);
  float s1 = mod(uHead - d0 - 1.0 + HIST, HIST);
  float a = texture2D(uHist, vec2((s0 + 0.5) / HIST, 0.5)).r;
  float b = texture2D(uHist, vec2((s1 + 0.5) / HIST, 0.5)).r;
  return mix(a, b, f);
}

void main() {
  float d = length(aCell) / (NH * 1.4142);
  float maxDelay = mix(HIST - 2.0, 24.0, u_ripple);
  float hHist = histAt(clamp(d * maxDelay, 0.0, HIST - 2.0));
  float hSpec = spectrum(d * 0.85 + 0.02);
  float h = mix(hHist, hSpec, u_mix);
  // idle swell so silence still breathes
  float idle = (0.5 + 0.5 * sin(d * 13.0 - uTime * 0.9)) * (0.6 + 0.4 * snoise(aCell * 0.07 + uTime * 0.04));
  h += idle * 0.1;
  for (int i = 0; i < 4; i++) {
    float t = uShockT[i];
    float r = t * mix(0.35, 1.1, u_ripple);
    float x = (d - r) / 0.045;
    h += uShockA[i] * u_shock * exp(-x * x) * exp(-t * 1.4) * 0.9;
  }
  float height = 0.12 + max(h, 0.0) * u_amp * 9.0;
  vH = h;

  float inv = 0.0;
  for (int i = 0; i < 3; i++) inv += uInvAmt[i] * (1.0 - step(0.5, abs(aCell.y - uInvRow[i])));
  vInv = clamp(inv * u_invert, 0.0, 1.0);

  float foot = 1.0 - u_gap;
  vec3 p = position;
  vBox = p + 0.5;
  vSize = vec3(foot, height, foot);
  p.xz *= foot;
  p.y = (p.y + 0.5) * height;
  p.xz += aCell;
  vNrm = normal;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */ `
varying vec3 vNrm;
varying float vH;
varying float vInv;
varying vec3 vBox;
varying vec3 vSize;

void main() {
  vec3 n = normalize(vNrm);
  // pick the two in-face coordinates (in world units) for edge lines
  vec2 f;
  vec2 sz;
  if (abs(n.y) > 0.5) { f = vBox.xz; sz = vSize.xz; }
  else if (abs(n.x) > 0.5) { f = vBox.zy; sz = vSize.zy; }
  else { f = vBox.xy; sz = vSize.xy; }
  vec2 e = min(f, 1.0 - f) * sz;          // distance to face edge, world units
  vec2 w = fwidth(f * sz);
  vec2 g = e / max(w, vec2(1e-5));
  float edge = 1.0 - smoothstep(0.4, 1.4, min(g.x, g.y));

  vec3 paper = mix(uBg, uFg, vInv);
  vec3 ink = mix(uFg, uBg, vInv);
  float top = step(0.5, n.y);
  float shade = top > 0.5 ? 1.0 : (abs(n.x) > 0.5 ? 0.9 : 0.8);
  vec3 face = paper * shade;
  face = mix(face, mix(paper, uMuted, 0.6) * shade, (1.0 - top) * 0.35);
  float hot = smoothstep(0.25, 0.85, vH) * u_accent * (1.0 - vInv);
  face = mix(face, uAccent * mix(1.0, shade, 0.6), hot * mix(0.5, 1.0, top));
  vec3 col = mix(face, ink, edge * u_edges);
  gl_FragColor = vec4(col, 1.0);
}
`;

export const monolithGrid = defineThreeScene({
  id: 'monolith-grid',
  name: 'Monolith Grid',
  description:
    'A 48×48 field of hairline-edged boxes in isometric view. Heights ripple out from the centre (loudness history and spectrum by radius), kicks send a shockwave ring, snares invert a random row.',
  category: 'form',
  tags: ['architectural', 'minimal', 'editorial', 'techno', 'precise', 'rhythmic', 'clean'],
  light: true,
  params,
  modulations: [
    { source: 'energy', param: 'amp', amount: 0.2 },
    { source: 'build', param: 'ripple', amount: 0.3 },
  ],
  build(init) {
    const scene = new THREE.Scene();
    const bg = new THREE.Color();
    scene.background = bg;
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);

    const box = new THREE.BoxGeometry(1, 1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(box.getIndex());
    geo.setAttribute('position', box.getAttribute('position'));
    geo.setAttribute('normal', box.getAttribute('normal'));
    const cells = new Float32Array(N * N * 2);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        cells[(y * N + x) * 2] = x - (N - 1) / 2;
        cells[(y * N + x) * 2 + 1] = y - (N - 1) / 2;
      }
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
    geo.instanceCount = N * N;

    const hist = new Float32Array(HIST);
    const histTex = floatTexture(hist, HIST, 1);

    const mat = makeMaterial({
      params,
      shared: init.shared,
      vertex: VERT,
      fragment: FRAG,
      extra: {
        uHist: { value: histTex },
        uHead: { value: 0 },
        uShockT: { value: new THREE.Vector4(99, 99, 99, 99) },
        uShockA: { value: new THREE.Vector4(0, 0, 0, 0) },
        uInvRow: { value: new THREE.Vector3(-999, -999, -999) },
        uInvAmt: { value: new THREE.Vector3(0, 0, 0) },
      },
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    const group = new THREE.Group();
    group.add(mesh);
    scene.add(group);

    let head = 0;
    let acc = 0;
    let level = 0;
    let shockI = 0;
    let invI = 0;
    const shockT = mat.uniforms.uShockT.value as THREE.Vector4;
    const shockA = mat.uniforms.uShockA.value as THREE.Vector4;
    const invRow = mat.uniforms.uInvRow.value as THREE.Vector3;
    const invAmt = mat.uniforms.uInvAmt.value as THREE.Vector3;
    const ISO = new THREE.Vector3(1, 0.82, 1).normalize();

    return {
      scene,
      camera,
      update(frame) {
        const dt = stepDt(frame);
        const a = frame.audio;
        const p = frame.params;
        syncMaterial(mat, frame, params);
        bg.copy(frame.palette.c.bg);

        // loudness history at a fixed 60 Hz
        level = approach(level, a.bass * 0.55 + a.level * 0.35 + a.sub * 0.2, 18, dt);
        acc += dt * 60;
        let pushed = false;
        while (acc >= 1) {
          acc -= 1;
          head = (head + 1) % HIST;
          hist[head] = level;
          pushed = true;
        }
        if (pushed) histTex.needsUpdate = true;
        mat.uniforms.uHead.value = head;

        // shockwaves
        for (let i = 0; i < 4; i++) shockT.setComponent(i, shockT.getComponent(i) + dt);
        if (a.kickHit) {
          shockT.setComponent(shockI, 0);
          shockA.setComponent(shockI, 0.5 + a.kick * 0.5);
          shockI = (shockI + 1) % 4;
        }
        // snare row inversions
        for (let i = 0; i < 3; i++) invAmt.setComponent(i, invAmt.getComponent(i) * Math.exp(-dt * 2.2));
        if (a.snareHit) {
          invRow.setComponent(invI, Math.floor(Math.random() * N) - (N - 1) / 2);
          invAmt.setComponent(invI, 1);
          invI = (invI + 1) % 3;
        }

        // isometric ortho camera
        const zoom = num(p, 'zoom', 1);
        const halfH = 26 / zoom;
        camera.left = -halfH * frame.aspect;
        camera.right = halfH * frame.aspect;
        camera.top = halfH;
        camera.bottom = -halfH;
        camera.position.copy(ISO).multiplyScalar(120);
        camera.lookAt(0, 3, 0);
        camera.updateProjectionMatrix();
        group.rotation.y = a.sway * 0.04 + Math.sin(frame.time * 0.05) * 0.03;
      },
      dispose() {
        histTex.dispose();
        box.dispose();
      },
    };
  },
});
