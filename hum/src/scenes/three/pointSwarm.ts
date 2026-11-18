import * as THREE from 'three';
import { defineThreeScene } from '../../core/sceneHelpers';
import { num } from '../../core/uniforms';
import type { ParamDef } from '../../core/types';
import { approach, isLightPalette, makeMaterial, setAdaptiveBlending, Spring, stepDt, syncMaterial } from './common';

const COUNT = 110_000;

const params: ParamDef[] = [
  { id: 'density', label: 'Density', group: 'Shape', type: 'number', min: 0.1, max: 1, step: 0.01, default: 0.75, hint: 'Share of the 110k points drawn' },
  { id: 'size', label: 'Point size', group: 'Shape', type: 'number', min: 0.3, max: 3, step: 0.01, default: 1 },
  { id: 'spread', label: 'Spread', group: 'Shape', type: 'number', min: 0.3, max: 2, step: 0.01, default: 1 },
  { id: 'flow', label: 'Flow speed', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.35 },
  { id: 'curl', label: 'Curl', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'Field frequency / tangle' },
  { id: 'burst', label: 'Kick burst', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.65 },
  { id: 'explode', label: 'Drop explode', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.85 },
  { id: 'shock', label: 'Kick shockwave', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, hint: 'A bright shell that tears outward through the cloud on each kick' },
  { id: 'twist', label: 'Snare twist', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'Snares wring the swarm into a corkscrew that springs back' },
  { id: 'spectrum', label: 'Spectrum shape', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'Bands push the cloud out by latitude: bass bulges the equator, highs the poles' },
  { id: 'tension', label: 'Build tension', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Build-ups crush the swarm into a tight, spinning, trembling core' },
  { id: 'heave', label: 'Sub swell', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.45, hint: 'Sub slowly breathes the whole cloud in and out' },
  { id: 'hue', label: 'Accent mix', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.45 },
  { id: 'orbit', label: 'Camera orbit', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.25 },
];

const VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uFlowT, uKickE, uDropE, uSpreadE, uPx, uLight;
uniform float uSnareE, uTension, uTrem, uSpecAmt;
uniform vec4 uShockT, uShockA;
varying float vAlpha;
varying float vHue;
varying float vSpeed;
varying float vHot;

// divergence-free ABC flow, slowly phase-shifted over time
vec3 field(vec3 p, float t) {
  return vec3(
    sin(p.z + t * 0.31) + 0.62 * cos(p.y - t * 0.23),
    0.78 * sin(p.x + t * 0.17) + cos(p.z - t * 0.11),
    0.62 * sin(p.y + t * 0.29) + 0.78 * cos(p.x + t * 0.13)
  );
}

void main() {
  float rate = 0.05 + 0.05 * aSeed.w;
  float lt = uFlowT * rate + aSeed.w * 17.0;
  float life = fract(lt);
  float cycle = floor(lt);
  // respawn somewhere new each cycle
  float ang = hash11(cycle * 1.37 + aSeed.x * 91.0) * TAU;
  vec3 p = position;
  p.xz = rot2(ang) * p.xz;
  p *= 1.7 * uSpreadE;

  float freq = mix(0.45, 1.4, u_curl);
  float h = life * 2.6 / 6.0;
  vec3 v = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    v = field(p * freq, uFlowT * 0.25);
    p += v * h;
  }
  // organic wobble
  vec3 q = p * 0.7 + uTime * 0.05;
  p += vec3(snoise(q), snoise(q + 19.1), snoise(q + 37.7)) * 0.12;

  // keep the swarm in a soft ball (build-ups crush it smaller)
  float R = 2.4 * uSpreadE * (1.0 - uTension * 0.6);
  float len = length(p) + 1e-4;
  p *= R * (1.0 - exp(-len / R)) / len;

  vec3 dir = p / (length(p) + 1e-4);
  float rr = length(p);

  // spectrum by latitude: equator = bass … poles = highs
  if (uSpecAmt > 0.001) {
    float bin = abs(dir.y) * 0.85 + 0.03;
    float sp = (spectrum(bin - 0.02) + spectrum(bin) + spectrum(bin + 0.02)) / 3.0;
    p *= 1.0 + sp * uSpecAmt * (0.25 + 0.75 * aSeed.x) * 0.7;
  }

  // build: tremble
  if (uTension > 0.001) {
    vec3 j = vec3(sin(uTrem * 1.7 + aSeed.x * 40.0), sin(uTrem * 2.3 + aSeed.y * 40.0), sin(uTrem * 1.9 + aSeed.z * 40.0));
    p += j * uTension * 0.05;
  }

  // snare: corkscrew twist around the vertical axis, springs back
  p.xz = rot2(uSnareE * u_twist * p.y * 0.55) * p.xz;

  // kick: radial punch (spring overshoot makes it inhale after)
  p *= 1.0 + uKickE * u_burst * (0.25 + 0.75 * aSeed.x) * 0.85;

  // kick shockwaves: a shell that shoves points outward as it passes
  float hot = 0.0;
  for (int i = 0; i < 4; i++) {
    float t = uShockT[i];
    if (t < 2.5) {
      float rs = t * 7.0;
      float x = (rr - rs) / 0.45;
      float w = exp(-x * x) * exp(-t * 2.2) * uShockA[i] * u_shock;
      p += dir * w * 0.95;
      hot += w;
    }
  }

  // drop: blow apart — radial plus each point's own direction, swirling as it flies
  if (uDropE > 0.001) {
    vec3 own = normalize(vec3(aSeed.x, aSeed.y, aSeed.z) - 0.5 + 1e-3);
    vec3 fly = normalize(dir * 1.4 + own);
    float dist = uDropE * u_explode * (1.0 + aSeed.y * 4.2);
    p += fly * dist;
    p.xz = rot2(uDropE * u_explode * (0.9 + 0.6 * aSeed.z) * 1.6 / (1.0 + rr)) * p.xz;
    hot += uDropE * u_explode * 0.45;
  }

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float sz = u_size * (1.2 + aSeed.z * 2.4) * (1.0 + uKickE * 0.5 * aSeed.x + hot * 1.4);
  gl_PointSize = clamp(sz * uPx * 7.0 / max(-mv.z, 0.1), 1.0, 64.0);

  vAlpha = pow(max(sin(life * PI), 0.0), 0.6) * (1.0 + hot * 1.2);
  vHue = aSeed.y;
  vSpeed = clamp(length(v) / 2.2, 0.0, 1.0);
  vHot = clamp(hot, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform float uGain;
varying float vAlpha;
varying float vHue;
varying float vSpeed;
varying float vHot;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a = smoothstep(0.5, 0.15, d) * vAlpha;
  if (a < 0.003) discard;
  vec3 base = uFg;
  vec3 acc = mix(uAccent, uAccent2, smoothstep(0.3, 1.0, vSpeed));
  vec3 col = mix(base, acc, step(1.0 - u_hue, vHue) * 0.85 + vSpeed * 0.15 * u_hue);
  col = mix(col, uAccent, vHot * 0.5);
  gl_FragColor = vec4(col, a * uGain);
}
`;

export const pointSwarm = defineThreeScene({
  id: 'point-swarm',
  name: 'Point Swarm',
  description:
    '110k GPU points streaming through a divergence-free flow field. Kicks punch the cloud outward and send a bright shockwave shell through it, snares wring it into a corkscrew, the spectrum sculpts its silhouette, builds crush it into a spinning core and a drop blows it apart before it re-forms. Glows additively on dark palettes.',
  category: 'form',
  tags: ['ethereal', 'flowing', 'cosmic', 'electronic', 'hypnotic', 'energetic', 'dreamy'],
  params,
  modulations: [
    { source: 'energy', param: 'flow', amount: 0.2 },
    { source: 'air', param: 'size', amount: 0.12 },
    { source: 'build', param: 'curl', amount: 0.15 },
  ],
  build(init) {
    const scene = new THREE.Scene();
    const bg = new THREE.Color();
    scene.background = bg;
    const camera = new THREE.PerspectiveCamera(45, init.width / Math.max(1, init.height), 0.1, 100);

    const pos = new Float32Array(COUNT * 3);
    const seed = new Float32Array(COUNT * 4);
    for (let i = 0; i < COUNT; i++) {
      // uniform in the unit ball
      let x = 0;
      let y = 0;
      let z = 0;
      do {
        x = Math.random() * 2 - 1;
        y = Math.random() * 2 - 1;
        z = Math.random() * 2 - 1;
      } while (x * x + y * y + z * z > 1);
      pos.set([x, y, z], i * 3);
      seed.set([Math.random(), Math.random(), Math.random(), Math.random()], i * 4);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));

    const mat = makeMaterial({
      params,
      shared: init.shared,
      vertex: VERT,
      fragment: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      extra: {
        uFlowT: { value: 0 },
        uKickE: { value: 0 },
        uDropE: { value: 0 },
        uSnareE: { value: 0 },
        uTension: { value: 0 },
        uTrem: { value: 0 },
        uSpecAmt: { value: 0 },
        uShockT: { value: new THREE.Vector4(99, 99, 99, 99) },
        uShockA: { value: new THREE.Vector4(0, 0, 0, 0) },
        uSpreadE: { value: 1 },
        uPx: { value: 1 },
        uLight: { value: 0 },
        uGain: { value: 0.3 },
      },
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    scene.add(points);

    const kick = new Spring(260, 13);
    const snare = new Spring(140, 7);
    const sub = new Spring(8, 4);
    let flowT = 0;
    let spread = 1;
    let drop = 0;
    let orbit = 0;
    let tension = 0;
    let trem = 0;
    let spin = 0;
    let shockI = 0;
    const shockT = mat.uniforms.uShockT.value as THREE.Vector4;
    const shockA = mat.uniforms.uShockA.value as THREE.Vector4;

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

        const tens = num(p, 'tension', 0.6);
        tension = approach(tension, a.build * (1 - a.drop) * tens, 2.5, dt);
        // integrated flow: calm in silence, faster in builds, a rush on the drop
        flowT += dt * (0.25 + num(p, 'flow', 0.35) * 3.0) * (0.5 + a.energy * 0.8 + a.mid * 0.25 + tension * 1.2 + drop * 1.5);
        kick.step(a.kick, dt);
        snare.step(a.snare, dt);
        sub.step(a.sub, dt);
        const swell = 1 + Math.max(-0.1, sub.value) * num(p, 'heave', 0.45) * 0.35;
        spread = approach(spread, num(p, 'spread', 1) * (0.85 + a.energy * 0.4) * swell, 2.5, dt);
        drop = a.drop > drop ? approach(drop, a.drop, 30, dt) : approach(drop, a.drop, 1.6, dt);
        trem += dt * (4 + tension * 30);
        // build: the swarm starts to spin (integrated rotation, eases off after)
        spin += dt * (tension * 2.2 + drop * 1.2);
        points.rotation.y = spin;

        for (let i = 0; i < 4; i++) shockT.setComponent(i, Math.min(99, shockT.getComponent(i) + dt));
        if (a.kickHit) {
          shockT.setComponent(shockI, 0);
          shockA.setComponent(shockI, 0.55 + Math.min(1, a.kick) * 0.45);
          shockI = (shockI + 1) % 4;
        }

        const density = num(p, 'density', 0.75);
        geo.setDrawRange(0, Math.floor(COUNT * Math.min(1, Math.max(0.05, density))));

        const u = mat.uniforms;
        u.uFlowT.value = flowT;
        u.uKickE.value = Math.max(0, kick.value);
        u.uDropE.value = drop;
        u.uSnareE.value = snare.value;
        u.uTension.value = tension;
        u.uTrem.value = trem % (Math.PI * 200); // 20π-periodic for every multiplier used in the shader
        u.uSpecAmt.value = num(p, 'spectrum', 0.5);
        u.uSpreadE.value = spread;
        u.uPx.value = frame.height / 1080;
        u.uLight.value = light ? 1 : 0;
        // keep overall brightness sane as density changes
        u.uGain.value = (light ? 0.5 : 0.32) / Math.sqrt(Math.max(0.1, density));

        orbit += dt * (0.02 + num(p, 'orbit', 0.25) * 0.35);
        const r = 7.5 + a.sway * 0.25;
        camera.position.set(Math.sin(orbit) * r, 1.2 + Math.sin(orbit * 0.6) * 1.2 + a.sway * 0.4, Math.cos(orbit) * r);
        camera.lookAt(0, 0, 0);
        camera.rotateZ(a.sway * 0.05);
      },
    };
  },
});
