import * as THREE from 'three';
import { defineThreeScene } from '../../core/sceneHelpers';
import { num } from '../../core/uniforms';
import type { ParamDef } from '../../core/types';
import {
  approach,
  beatsPerSecond,
  dataGeometry,
  floatTexture,
  GLSL_RIBBON,
  isLightPalette,
  makeMaterial,
  setAdaptiveBlending,
  Spring,
  stepDt,
  syncMaterial,
} from './common';

const K = 56; // rings alive
const SEG = 256; // segments per ring
const SW = SEG / 2 + 1; // shape samples (mirrored → closed loop)
const SPACING = 0.55;

const params: ParamDef[] = [
  { id: 'speed', label: 'Rings / beat', group: 'Motion', type: 'number', min: 0.25, max: 4, step: 0.05, default: 2 },
  { id: 'radius', label: 'Radius', group: 'Shape', type: 'number', min: 0.4, max: 2, step: 0.01, default: 1 },
  { id: 'wave', label: 'Waveform', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'How much the waveform shapes each ring' },
  { id: 'spectrum', label: 'Spectrum', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.45 },
  { id: 'weight', label: 'Line weight', group: 'Style', type: 'number', min: 0.5, max: 5, step: 0.05, default: 1.4, hint: 'px at 1080p' },
  { id: 'curve', label: 'Tunnel bend', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.4 },
  { id: 'twist', label: 'Twist', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.3 },
  { id: 'roll', label: 'Camera roll', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
  { id: 'flash', label: 'Kick flash', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.8 },
  { id: 'surge', label: 'Kick surge', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Each kick lurches you forward through the tunnel' },
  { id: 'pulse', label: 'Kick pulse', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.65, hint: 'Kicks dilate the rings around you and send a bulge down the tunnel' },
  { id: 'squeeze', label: 'Snare squeeze', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'Snares pinch the tunnel into an ellipse that springs back' },
  { id: 'warp', label: 'Drop warp', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.75, hint: 'The drop blasts the tunnel open and hurls you forward' },
  { id: 'dropRoll', label: 'Drop roll', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Barrel roll on each drop' },
  { id: 'tension', label: 'Build tension', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Build-ups narrow the tunnel, quicken the rings and make them tremble' },
  { id: 'heave', label: 'Sub breathe', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.45, hint: 'Sub slowly swells the tunnel walls' },
];

const VERT = /* glsl */ `
${GLSL_RIBBON}
uniform sampler2D uShape;
uniform float uHead, uFrac, uTotal, uKickE, uCamBorn;
uniform float uPulseE, uSnareE, uSqAng, uRadMul, uStretch, uTrem, uShake;
uniform vec4 uShockD, uShockA;
const float K = ${K.toFixed(1)};
const float SPACING = ${SPACING.toFixed(3)};
varying float vSide;
varying float vW;
varying float vCover;
varying float vAge;
varying float vBirthKick;

vec2 center(float born) {
  return vec2(sin(born * 0.051) + 0.5 * sin(born * 0.113 + 1.3),
              cos(born * 0.043) + 0.5 * cos(born * 0.097 + 0.4)) * u_curve * 1.2;
}

vec4 shapeAt(float slot, float s) {
  float i = floor(s * ${(SW - 1).toFixed(1)} + 0.5);
  return texture2D(uShape, vec2((i + 0.5) / ${SW.toFixed(1)}, (slot + 0.5) / K));
}

vec3 ringPos(float slot, float rowAge, float t) {
  t = fract(t);
  float s = 1.0 - abs(2.0 * t - 1.0);
  vec4 sh = shapeAt(slot, s);
  float born = uTotal - rowAge;
  float theta = t * TAU + born * 0.06 * u_twist + PI * 0.5;
  vec2 cs = vec2(cos(t * TAU), sin(t * TAU));
  float wob = (0.035 + uShake * 0.09) * snoise(cs * 1.3 + vec2(born * 0.21 + uTrem, uTrem * 0.7));
  float rad = u_radius * (1.0 + u_wave * 0.5 * sh.r + u_spectrum * 0.55 * sh.g + wob);
  float age = rowAge + uFrac;
  float dist = (K - age) * SPACING; // distance in front of the camera
  // global swell: build contraction, sub breathing, drop blast
  rad *= uRadMul;
  // kick: rings near you dilate, and a bulge travels away down the tunnel
  float bump = uPulseE * u_pulse * 0.38 * exp(-dist / 9.0);
  for (int i = 0; i < 4; i++) {
    float x = (dist - uShockD[i]) / 2.4;
    bump += uShockA[i] * u_pulse * 0.5 * exp(-x * x);
  }
  rad *= 1.0 + bump;
  // snare: pinch into an ellipse along a random axis
  rad *= 1.0 + uSnareE * u_squeeze * 0.3 * cos(2.0 * (theta - uSqAng));
  vec2 c = center(born) - center(uCamBorn);
  float z = -dist * uStretch;
  return vec3(cos(theta) * rad + c.x, sin(theta) * rad + c.y, z);
}

void main() {
  float slot = position.x;
  float t = position.y / ${SEG.toFixed(1)};
  float side = position.z;
  float rowAge = mod(uHead - slot + K, K);
  float dt = 1.0 / ${SEG.toFixed(1)};
  mat4 mvp = projectionMatrix * modelViewMatrix;
  vec4 c0 = mvp * vec4(ringPos(slot, rowAge, t), 1.0);
  vec4 cp = mvp * vec4(ringPos(slot, rowAge, t - dt), 1.0);
  vec4 cn = mvp * vec4(ringPos(slot, rowAge, t + dt), 1.0);
  float age = rowAge + uFrac;
  float bk = shapeAt(slot, 0.0).b;
  float fresh = 1.0 - smoothstep(0.0, 2.0, age);
  float w = u_weight * uResolution.y / 1080.0 * (1.0 + bk * u_flash * 1.2 + fresh * uKickE * u_flash * 2.5);
  float wpx = max(w, 1.0);
  vCover = min(w, 1.0);
  vW = wpx;
  vSide = side;
  vAge = age;
  vBirthKick = bk;
  gl_Position = ribbonExtrude(cp, c0, cn, side, wpx + 1.0);
}
`;

const FRAG = /* glsl */ `
uniform float uKickE, uLight;
const float K = ${K.toFixed(1)};
varying float vSide;
varying float vW;
varying float vCover;
varying float vAge;
varying float vBirthKick;
void main() {
  float dpx = abs(vSide) * (vW + 1.0) * 0.5;
  float a = clamp(vW * 0.5 + 0.5 - dpx, 0.0, 1.0) * vCover;
  float fresh = 1.0 - smoothstep(0.0, 2.0, vAge);
  float depth = 1.0 - vAge / K; // 1 = far
  vec3 col = mix(uFg, uAccent2, depth * 0.55);
  col = mix(col, uAccent, clamp(vBirthKick * u_flash * 0.9 + fresh * uKickE * u_flash, 0.0, 1.0));
  a *= smoothstep(0.0, 7.0, vAge);          // fade in far away
  a *= 1.0 - smoothstep(K - 3.0, K - 0.3, vAge); // fade before hitting the lens
  a *= mix(1.0, 0.75, uLight);
  gl_FragColor = vec4(col, a);
}
`;

export const ringTunnel = defineThreeScene({
  id: 'ring-tunnel',
  name: 'Ring Tunnel',
  description:
    'Hairline rings fly toward the camera, each one shaped by the waveform and spectrum at the moment it was born, spawned in time with the tempo. Kicks lurch you forward and send a bulge down the tunnel, snares pinch it, builds narrow and quicken it, and a drop blasts it open with a barrel roll.',
  category: 'form',
  tags: ['hypnotic', 'driving', 'techno', 'trance', 'dark', 'futuristic', 'tunnel', 'energetic'],
  params,
  modulations: [
    { source: 'energy', param: 'speed', amount: 0.1 },
    { source: 'build', param: 'twist', amount: 0.4 },
  ],
  build(init) {
    const scene = new THREE.Scene();
    const bg = new THREE.Color();
    scene.background = bg;
    const camera = new THREE.PerspectiveCamera(68, init.width / Math.max(1, init.height), 0.05, 100);

    const shape = new Float32Array(SW * K * 4);
    const shapeTex = floatTexture(shape, SW, K, THREE.RGBAFormat);

    const vcount = K * (SEG + 1) * 2;
    const data = new Float32Array(vcount * 3);
    const index = new Uint32Array(K * SEG * 6);
    let v = 0;
    let ii = 0;
    for (let r = 0; r < K; r++) {
      for (let s = 0; s <= SEG; s++) {
        data.set([r, s, 1], v * 3);
        data.set([r, s, -1], (v + 1) * 3);
        if (s < SEG) {
          index.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], ii);
          ii += 6;
        }
        v += 2;
      }
    }
    const geo = dataGeometry(data, index);
    const mat = makeMaterial({
      params,
      shared: init.shared,
      vertex: VERT,
      fragment: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      extra: {
        uShape: { value: shapeTex },
        uHead: { value: 0 },
        uFrac: { value: 0 },
        uTotal: { value: 0 },
        uKickE: { value: 0 },
        uCamBorn: { value: 0 },
        uLight: { value: 0 },
        uPulseE: { value: 0 },
        uSnareE: { value: 0 },
        uSqAng: { value: 0 },
        uRadMul: { value: 1 },
        uStretch: { value: 1 },
        uTrem: { value: 0 },
        uShake: { value: 0 },
        uShockD: { value: new THREE.Vector4(999, 999, 999, 999) },
        uShockA: { value: new THREE.Vector4(0, 0, 0, 0) },
      },
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);

    let head = 0;
    let total = K; // pretend the tunnel is already full at start
    let clock = 0;
    const kick = new Spring(200, 14);
    const roll = new Spring(8, 4);
    const pulse = new Spring(240, 12);
    const snare = new Spring(160, 8);
    const sub = new Spring(8, 4);
    const radMul = new Spring(30, 7, 1);
    let tension = 0;
    let trem = 0;
    let dropRoll = 0;
    let rollDir = 1;
    let dropPrev = 0;
    let shockI = 0;
    const shockAge = new Float32Array([99, 99, 99, 99]);
    const shockAmp = new Float32Array(4);

    const writeRing = (slot: number, wave: Float32Array, spec: Float32Array, kickV: number, level: number) => {
      const base = slot * SW * 4;
      const wl = wave.length;
      for (let j = 0; j < SW; j++) {
        const wi = Math.min(wl - 2, Math.max(1, j * 2));
        const w = (wave[wi - 1] + wave[wi] * 2 + wave[wi + 1]) * 0.25;
        const sp = spec[Math.min(spec.length - 1, j)] ?? 0;
        shape[base + j * 4] = w;
        shape[base + j * 4 + 1] = sp;
        shape[base + j * 4 + 2] = kickV;
        shape[base + j * 4 + 3] = level;
      }
    };

    return {
      scene,
      camera,
      update(frame) {
        const dt = stepDt(frame);
        const a = frame.audio;
        const p = frame.params;
        const light = isLightPalette(frame.palette);
        syncMaterial(mat, frame, params);
        bg.copy(frame.palette.c.bg);
        setAdaptiveBlending(mat, light);

        // travel: integrated, so kicks / builds / the drop read as real lurches through space
        tension = approach(tension, a.build * (1 - a.drop) * num(p, 'tension', 0.6), 2.5, dt);
        const warp = num(p, 'warp', 0.75);
        const travel = 1 + a.kick * num(p, 'surge', 0.6) * 3 + a.drop * warp * 3 + tension * 1.2;
        clock += dt * beatsPerSecond(frame) * num(p, 'speed', 2) * travel;
        let wrote = false;
        while (clock >= 1) {
          clock -= 1;
          head = (head + 1) % K;
          total += 1;
          writeRing(head, a.waveform, a.spectrum, a.kick, a.level);
          wrote = true;
        }
        if (wrote) shapeTex.needsUpdate = true;
        kick.step(a.kick, dt);
        pulse.step(a.kick, dt);
        snare.step(a.snare, dt);
        sub.step(a.sub, dt);
        trem += dt * (0.3 + tension * 9);
        radMul.step((1 - tension * 0.38) * (1 + Math.max(0, sub.value) * num(p, 'heave', 0.45) * 0.25) * (1 + a.drop * warp * 0.45), dt);

        // kick shockwave travelling away from the camera
        for (let i = 0; i < 4; i++) {
          shockAge[i] = Math.min(99, shockAge[i] + dt);
        }
        if (a.kickHit) {
          shockAge[shockI] = 0;
          shockAmp[shockI] = 0.55 + Math.min(1, a.kick) * 0.45;
          shockI = (shockI + 1) % 4;
        }
        const sd = mat.uniforms.uShockD.value as THREE.Vector4;
        const sa = mat.uniforms.uShockA.value as THREE.Vector4;
        for (let i = 0; i < 4; i++) {
          const t = shockAge[i];
          sd.setComponent(i, t * 24);
          sa.setComponent(i, t < 3 ? shockAmp[i] * Math.exp(-t * 1.3) * Math.min(1, t * 12) : 0);
        }
        if (a.snareHit) mat.uniforms.uSqAng.value = Math.random() * Math.PI;

        // drop: barrel roll (alternating direction), integrated so it eases out
        if (a.drop > 0.6 && dropPrev <= 0.6) rollDir = -rollDir;
        dropPrev = a.drop;
        dropRoll += dt * a.drop * num(p, 'dropRoll', 0.6) * 2.8 * rollDir;

        const u = mat.uniforms;
        u.uPulseE.value = pulse.value;
        u.uSnareE.value = snare.value;
        u.uRadMul.value = radMul.value;
        u.uStretch.value = 1 + a.drop * warp * 0.5;
        u.uTrem.value = trem % 1000;
        u.uShake.value = tension;
        u.uHead.value = head;
        u.uFrac.value = clock;
        u.uTotal.value = total;
        u.uKickE.value = Math.max(0, kick.value);
        u.uCamBorn.value = total + clock - K + 3;
        u.uLight.value = light ? 1 : 0;

        const r = num(p, 'roll', 0.5);
        roll.step(a.sway * r * 0.45 + Math.sin(frame.time * 0.09) * r * 0.25, dt);
        camera.rotation.set(0, 0, roll.value + dropRoll);
      },
      dispose() {
        shapeTex.dispose();
      },
    };
  },
});
