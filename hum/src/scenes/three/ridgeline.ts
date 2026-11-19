import * as THREE from 'three';
import { defineThreeScene } from '../../core/sceneHelpers';
import { num } from '../../core/uniforms';
import type { ParamDef } from '../../core/types';
import { dataGeometry, floatTexture, GLSL_RIBBON, makeMaterial, Spring, stepDt, syncMaterial } from './common';

const ROWS = 64;
const BINS = 128;

const params: ParamDef[] = [
  { id: 'speed', label: 'Rows / sec', group: 'Motion', type: 'number', min: 2, max: 60, step: 1, default: 20 },
  { id: 'height', label: 'Height', group: 'Shape', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
  { id: 'spacing', label: 'Row spacing', group: 'Shape', type: 'number', min: 0.3, max: 2.5, step: 0.01, default: 1 },
  { id: 'focus', label: 'Centre focus', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.65, hint: 'Tapers the edges, classic ridgeline silhouette' },
  { id: 'idle', label: 'Idle hills', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.35, hint: 'Gentle terrain that keeps silence alive' },
  { id: 'weight', label: 'Line weight', group: 'Style', type: 'number', min: 0.5, max: 4, step: 0.05, default: 1.3, hint: 'px at 1080p' },
  { id: 'tilt', label: 'Camera tilt', group: 'Style', type: 'number', min: 0, max: 1, step: 0.01, default: 0.4 },
  { id: 'accent', label: 'Accent hits', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Kick flash on the newest line + accent on peaks' },
];

const ROW_GLSL = /* glsl */ `
uniform sampler2D uHist;
uniform float uHead, uFrac, uTotal, uKickE;
const float ROWS = ${ROWS.toFixed(1)};
const float BINS = ${BINS.toFixed(1)};

float rowVal(float row, float bin) {
  bin = clamp(bin, 0.0, BINS - 1.0);
  float slot = mod(uHead - row + ROWS, ROWS);
  float v = texture2D(uHist, vec2((bin + 0.5) / BINS, (slot + 0.5) / ROWS)).r;
  float x = bin / (BINS - 1.0);
  float win = pow(max(sin(x * PI), 0.0), 1.6);
  float taper = mix(1.0, win, u_focus);
  float born = uTotal - row;
  float hill = snoise(vec2(x * 3.2 + 3.0, born * 0.035)) * 0.5 + 0.5;
  hill *= 0.55 + 0.45 * (snoise(vec2(x * 9.0 - 5.0, born * 0.07)) * 0.5 + 0.5);
  return (v * 1.3 + hill * hill * u_idle * 0.6) * taper;
}

vec3 rowPos(float row, float bin, float top) {
  float x = (bin / (BINS - 1.0) - 0.5) * 6.4;
  float age = row + uFrac;
  float z = -age * u_spacing * 0.11;
  float y = top > 0.5 ? rowVal(row, bin) * u_height * 0.9 : -0.35;
  return vec3(x, y, z);
}
`;

const FILL_VERT = /* glsl */ `
${ROW_GLSL}
void main() {
  vec3 p = rowPos(position.x, position.y, position.z);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;
const FILL_FRAG = /* glsl */ `
void main() { gl_FragColor = vec4(uBg, 1.0); }
`;

const LINE_VERT = /* glsl */ `
${ROW_GLSL}
${GLSL_RIBBON}
varying float vAge;
varying float vSide;
varying float vW;
varying float vCover;
varying float vVal;
void main() {
  float row = position.x;
  float bin = position.y;
  float side = position.z;
  mat4 mvp = projectionMatrix * modelViewMatrix;
  vec4 c0 = mvp * vec4(rowPos(row, bin, 1.0), 1.0);
  vec4 cp = mvp * vec4(rowPos(row, bin - 1.0, 1.0), 1.0);
  vec4 cn = mvp * vec4(rowPos(row, bin + 1.0, 1.0), 1.0);
  float age = row + uFrac;
  float fresh = 1.0 - smoothstep(0.0, 2.5, age);
  float w = u_weight * uResolution.y / 1080.0 * (1.0 + fresh * uKickE * u_accent * 1.8);
  float wpx = max(w, 1.0);
  vCover = min(w, 1.0);
  vW = wpx;
  vSide = side;
  vAge = age;
  vVal = rowVal(row, bin);
  gl_Position = ribbonExtrude(cp, c0, cn, side, wpx + 1.0);
}
`;
const LINE_FRAG = /* glsl */ `
uniform float uKickE;
varying float vAge;
varying float vSide;
varying float vW;
varying float vCover;
varying float vVal;
void main() {
  float dpx = abs(vSide) * (vW + 1.0) * 0.5;
  float a = clamp(vW * 0.5 + 0.5 - dpx, 0.0, 1.0) * vCover;
  float fresh = 1.0 - smoothstep(0.0, 2.5, vAge);
  float peak = smoothstep(0.35, 0.9, vVal);
  vec3 col = mix(uFg, uAccent, clamp(peak * u_accent * 0.7 + fresh * uKickE * u_accent, 0.0, 1.0));
  float fog = smoothstep(${ROWS}.0 * 0.3, ${ROWS}.0 - 1.0, vAge);
  col = mix(col, uBg, fog * 0.92);
  a *= smoothstep(0.0, 0.7, vAge);
  gl_FragColor = vec4(col, a);
}
`;

function buildGeometry() {
  const n = ROWS * BINS * 2;
  const data = new Float32Array(n * 3);
  const index: number[] = [];
  let k = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let b = 0; b < BINS; b++) {
      // v0 = top/+side, v1 = bottom/-side
      data.set([r, b, 1], k * 3);
      data.set([r, b, 0], (k + 1) * 3);
      if (b < BINS - 1) {
        const a0 = k;
        const a1 = k + 1;
        const b0 = k + 2;
        const b1 = k + 3;
        index.push(a0, a1, b0, a1, b1, b0);
      }
      k += 2;
    }
  }
  return { data, index };
}

export const ridgeline = defineThreeScene({
  id: 'ridgeline',
  name: 'Ridgeline',
  description:
    'Stacked spectrum lines over time seen in perspective, newest line at the front, each one filled with the background so it hides the lines behind it (the classic ridgeline look). Kicks flash the newest line.',
  category: 'form',
  style: 'data',
  tags: ['minimal', 'editorial', 'melancholic', 'post-punk', 'ambient', 'calm', 'technical', 'monochrome'],
  light: true,
  params,
  modulations: [
    { source: 'energy', param: 'speed', amount: 0.2 },
    { source: 'build', param: 'height', amount: 0.15 },
  ],
  build(init) {
    const scene = new THREE.Scene();
    const bg = new THREE.Color();
    scene.background = bg;
    const camera = new THREE.PerspectiveCamera(30, init.width / Math.max(1, init.height), 0.1, 100);

    const hist = new Float32Array(BINS * ROWS);
    const histTex = floatTexture(hist, BINS, ROWS);
    const histUniforms = () => ({
      uHist: { value: histTex },
      uHead: { value: 0 },
      uFrac: { value: 0 },
      uTotal: { value: 0 },
      uKickE: { value: 0 },
    });

    const fillG = buildGeometry();
    // fill: z flag = top (1) / bottom (0)
    const fillGeo = dataGeometry(fillG.data, fillG.index);
    // line: z = side (+1 / -1)
    const lineData = new Float32Array(fillG.data);
    for (let i = 2; i < lineData.length; i += 3) lineData[i] = lineData[i] > 0.5 ? 1 : -1;
    const lineGeo = dataGeometry(lineData, fillG.index);

    const fillMat = makeMaterial({
      params,
      shared: init.shared,
      vertex: FILL_VERT,
      fragment: FILL_FRAG,
      extra: histUniforms(),
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 2,
    });
    const lineMat = makeMaterial({
      params,
      shared: init.shared,
      vertex: LINE_VERT,
      fragment: LINE_FRAG,
      extra: histUniforms(),
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
    });
    const fill = new THREE.Mesh(fillGeo, fillMat);
    const lines = new THREE.Mesh(lineGeo, lineMat);
    fill.frustumCulled = false;
    lines.frustumCulled = false;
    fill.renderOrder = 0;
    lines.renderOrder = 1;
    scene.add(fill, lines);

    let head = 0;
    let total = 0;
    let acc = 0;
    const kick = new Spring(180, 16);
    let camX = 0;

    return {
      scene,
      camera,
      update(frame) {
        const dt = stepDt(frame);
        const a = frame.audio;
        const p = frame.params;
        syncMaterial(fillMat, frame, params);
        syncMaterial(lineMat, frame, params);
        bg.copy(frame.palette.c.bg);

        acc += dt * num(p, 'speed', 20) * (frame.audio.playing ? 1 : 0.4);
        let pushed = false;
        while (acc >= 1) {
          acc -= 1;
          head = (head + 1) % ROWS;
          total += 1;
          hist.set(a.spectrum.subarray(0, BINS), head * BINS);
          pushed = true;
        }
        if (pushed) histTex.needsUpdate = true;
        kick.step(a.kick, dt);

        for (const m of [fillMat, lineMat]) {
          m.uniforms.uHead.value = head;
          m.uniforms.uFrac.value = acc;
          m.uniforms.uTotal.value = total;
          m.uniforms.uKickE.value = Math.max(0, kick.value);
        }

        const tilt = num(p, 'tilt', 0.4);
        const depth = ROWS * num(p, 'spacing', 1) * 0.11;
        const fit = Math.max(1, 1.7 / Math.max(0.3, frame.aspect));
        camX += (a.sway * 0.35 - camX) * Math.min(1, dt * 2);
        const dist = 7.2 * fit;
        camera.position.set(camX, 0.6 + tilt * 4.2 * fit, dist - tilt * 1.5);
        camera.lookAt(0, 0.25, -depth * 0.45);
      },
      dispose() {
        histTex.dispose();
      },
    };
  },
});
