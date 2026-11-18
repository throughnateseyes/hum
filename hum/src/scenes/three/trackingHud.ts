/**
 * Tracking HUD — a glowing body of blue-white light (a few swirling clusters, a tilted ring and
 * loose dust) watched by a computer-vision overlay: thin red boxes lock onto the bright clusters,
 * green centroid dots, dashed motion arrows and live "x: 411 y: 590" labels. Loud parts lock more
 * boxes, and a drop blows the body apart and re-targets everything.
 *
 * Cluster centres move on the CPU (the particles follow them in the vertex shader), so the
 * overlay knows exactly where the bright parts are. The overlay is one fullscreen shader pass;
 * its text comes from a small glyph atlas drawn once on a canvas.
 */
import * as THREE from 'three';
import { defineThreeScene } from '../../core/sceneHelpers';
import { num, str } from '../../core/uniforms';
import type { ParamDef } from '../../core/types';
import { approach, isLightPalette, makeMaterial, setAdaptiveBlending, Spring, stepDt, syncMaterial } from './common';

const COUNT = 90_000;
const K = 8;
const GLYPHS = '0123456789xy:';
/** which clusters lock first: big and small hot ones interleaved */
const LOCK_ORDER = [0, 3, 1, 4, 2, 5, 6, 7];

const params: ParamDef[] = [
  { id: 'density', label: 'Density', group: 'Body', type: 'number', min: 0.1, max: 1, step: 0.01, default: 0.75 },
  { id: 'size', label: 'Point size', group: 'Body', type: 'number', min: 0.3, max: 3, step: 0.01, default: 1 },
  { id: 'swirl', label: 'Swirl', group: 'Body', type: 'number', min: 0, max: 1, step: 0.01, default: 0.45 },
  { id: 'halo', label: 'Halo', group: 'Body', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Soft glow around the bright clusters (a cheap built-in bloom)' },
  { id: 'ring', label: 'Ring', group: 'Body', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'The tilted ring of light around the body' },
  { id: 'wander', label: 'Wander', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.45, hint: 'How far the bright clusters roam' },
  { id: 'burst', label: 'Kick burst', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.55 },
  { id: 'explode', label: 'Drop explode', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.8 },
  { id: 'locks', label: 'Tracking', group: 'HUD', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'How many boxes lock on (more in loud parts)' },
  { id: 'labels', label: 'Coordinates', group: 'HUD', type: 'number', min: 0, max: 1, step: 0.01, default: 1, hint: 'Opacity of the x / y labels' },
  { id: 'arrows', label: 'Motion arrows', group: 'HUD', type: 'number', min: 0, max: 1, step: 0.01, default: 0.8 },
  {
    id: 'hud',
    label: 'HUD style',
    group: 'HUD',
    type: 'select',
    options: [
      { value: 'cv', label: 'Red boxes, green dots' },
      { value: 'palette', label: 'Palette colours' },
      { value: 'mono', label: 'White only' },
    ],
    default: 'cv',
  },
];

const VERT = /* glsl */ `
attribute vec4 aSeed;
attribute float aC;
uniform vec3 uC[${K}];
uniform float uR[${K}];
uniform float uSwirlT, uKickE, uDropE, uPx, uRingR, uRingT, uSpread;
uniform vec3 uRingC;
varying float vA;
varying float vT;
void main() {
  vec3 p;
  float bright = 1.0;
  vec3 o = position;
  float l = length(o);
  if (aC >= 0.0) {
    int ci = int(aC + 0.5);
    float r = uR[ci];
    // differential swirl: inner points turn faster, so clusters read as little vortices
    float sw = uSwirlT * (1.6 / (0.35 + l)) * (aSeed.x > 0.5 ? 1.0 : -0.7);
    o.xz = rot2(sw) * o.xz;
    o.xy = rot2(sw * 0.37) * o.xy;
    p = uC[ci] + o * r * (1.0 + uKickE * 0.45 * aSeed.y);
    bright = 0.55 + 1.6 * exp(-l * 1.4);
  } else if (aC > -1.5) {
    // the ring: a tilted ellipse with a fuzzy cross-section
    float ang = aSeed.x * TAU + uRingT * (0.6 + 0.4 * aSeed.y);
    vec3 rp = vec3(cos(ang) * uRingR, sin(ang) * uRingR * 1.35, 0.0);
    rp.xz = rot2(0.9) * rp.xz;
    rp.yz = rot2(0.35) * rp.yz;
    p = uRingC + rp + o * 0.06 * (1.0 + uKickE * 0.8);
    bright = 0.9;
  } else {
    // dust: sparse, faint, slowly sinking
    p = (aSeed.xyz - 0.5) * vec3(9.0, 7.0, 4.0);
    p.y = mod(p.y - uSwirlT * 0.05 * (0.5 + aSeed.w) + 3.5, 7.0) - 3.5;
    bright = 0.07;
  }
  // drop: blow apart along each point's own direction, then re-form as the envelope decays
  if (uDropE > 0.001) {
    vec3 dir = normalize(o + (aSeed.xyz - 0.5) * 0.5 + 1e-3);
    p += dir * uDropE * (0.6 + aSeed.z * 3.2);
    bright *= 1.0 + uDropE * 0.6;
  }
  vec4 mv = modelViewMatrix * vec4(p * uSpread, 1.0);
  gl_Position = projectionMatrix * mv;
  float sz = u_size * (0.9 + aSeed.w * 1.8) * (1.0 + uKickE * 0.4);
  gl_PointSize = clamp(sz * uPx * 16.0 / max(-mv.z, 0.1), 1.0, 32.0);
  vA = bright;
  vT = aSeed.w;
}
`;

const FRAG = /* glsl */ `
uniform float uGain;
varying float vA;
varying float vT;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.1, length(c)) * vA;
  if (a < 0.003) discard;
  vec3 col = mix(uAccent, uAccent2, smoothstep(0.55, 1.0, vT));
  col = mix(col, uFg, smoothstep(0.85, 1.0, vT) * 0.6);
  gl_FragColor = vec4(col, a * uGain);
}
`;

const HUD_VERT = /* glsl */ `
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const HUD_FRAG = /* glsl */ `
uniform vec4 uBox[${K}];
uniform vec4 uMv[${K}];   // xy = centroid px, zw = arrow vector px
uniform vec4 uInfo[${K}]; // x = lock 0..1, y = shown x, z = shown y, w = flicker
uniform sampler2D uAtlas;
uniform vec2 uAtlasGrid;  // glyph count, cell aspect (w/h)
uniform float uPx, uLabelA, uArrowA, uLight, uHaloK;
uniform vec3 uBoxCol, uDotCol, uTxtCol;

float glyph(float idx, vec2 lc) {
  // lc in 0..1 inside the glyph cell (y up)
  if (idx < 0.0 || lc.x < 0.0 || lc.x > 1.0 || lc.y < 0.0 || lc.y > 1.0) return 0.0;
  vec2 uv = vec2((idx + lc.x) / uAtlasGrid.x, lc.y);
  return texture2D(uAtlas, uv).r;
}

float digitAt(float v, float place) {
  // place: 0 = hundreds, 1 = tens, 2 = ones; leading zeros blank
  float d = mod(floor(v / pow(10.0, 2.0 - place) + 0.0001), 10.0);
  if (place < 0.5 && v < 100.0) return -1.0;
  if (place < 1.5 && v < 10.0) return -1.0;
  return d;
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  float lw = max(1.0, floor(uPx * 1.8 + 0.5));
  float boxA = 0.0;
  float dotA = 0.0;
  float txtA = 0.0;
  float arrA = 0.0;
  float chH = 21.0 * uPx;
  float chW = chH * uAtlasGrid.y;
  // soft halo around every cluster, locked or not
  float halo = 0.0;
  for (int i = 0; i < ${K}; i++) {
    vec4 b = uBox[i];
    float r = max(8.0, (b.z - b.x)) * 0.9;
    vec2 q = (fc - uMv[i].xy) / r;
    halo += exp(-dot(q, q) * 1.6) * (i < 3 ? 0.55 : 0.8);
  }
  halo *= u_halo * uHaloK;
  for (int i = 0; i < ${K}; i++) {
    vec4 info = uInfo[i];
    if (info.x <= 0.001) continue;
    vec4 b = uBox[i];
    vec2 c = uMv[i].xy;
    // lock-on: the box snaps in from 1.5x size
    float k = info.x;
    float grow = 1.0 + (1.0 - smoothstep(0.0, 1.0, k)) * 0.5;
    vec2 bc = (b.xy + b.zw) * 0.5;
    vec2 bh = (b.zw - b.xy) * 0.5 * grow;
    vec2 d = abs(fc - bc) - bh;
    float outline = step(max(d.x, d.y), 0.0) * step(-lw, max(d.x, d.y));
    boxA = max(boxA, outline * min(1.0, k * 2.0) * info.w);

    // centroid dot
    float dd = length(fc - c);
    dotA = max(dotA, smoothstep(3.2 * uPx, 2.0 * uPx, dd) * step(0.4, k));

    // dashed motion arrow from the centroid
    vec2 av = uMv[i].zw;
    float al = length(av);
    if (al > 4.0 && uArrowA > 0.0) {
      vec2 ad = av / al;
      vec2 rel = fc - c;
      float t = dot(rel, ad);
      float s = abs(dot(rel, vec2(-ad.y, ad.x)));
      float dash = step(0.45, fract(t / (7.0 * uPx)));
      float shaft = step(s, lw * 0.6) * step(5.0 * uPx, t) * step(t, al) * dash;
      // chevron head
      vec2 hr = fc - (c + av);
      float hx = dot(hr, ad);
      float hy = abs(dot(hr, vec2(-ad.y, ad.x)));
      float head = step(-7.0 * uPx, hx) * step(hx, 0.0) * step(abs(hy + hx), lw * 0.9);
      arrA = max(arrA, max(shaft, head) * smoothstep(0.5, 1.0, k));
    }

    // label above the box: "x: 411  y: 590"
    // even boxes label above-left, odd ones to the right, so neighbours don't overprint
    vec2 lo = mod(float(i), 2.0) < 0.5 ? vec2(b.x, b.w + 5.0 * uPx) : vec2(b.z + 6.0 * uPx, b.w - chH);
    vec2 lp = fc - lo;
    if (lp.y >= 0.0 && lp.y < chH && lp.x >= 0.0 && lp.x < chW * 14.0 && uLabelA > 0.0) {
      float ci = floor(lp.x / chW);
      vec2 lc = vec2(fract(lp.x / chW), lp.y / chH);
      float idx = -1.0;
      if (ci < 0.5) idx = 10.0;
      else if (ci < 1.5) idx = 12.0;
      else if (ci < 2.5) idx = -1.0;
      else if (ci < 5.5) idx = digitAt(info.y, ci - 3.0);
      else if (ci < 7.5) idx = -1.0;
      else if (ci < 8.5) idx = 11.0;
      else if (ci < 9.5) idx = 12.0;
      else if (ci < 10.5) idx = -1.0;
      else idx = digitAt(info.z, ci - 11.0);
      // type-on as it locks
      float typed = step(ci, k * 16.0);
      txtA = max(txtA, glyph(idx, lc) * typed);
    }
  }
  vec3 col = vec3(0.0);
  float a = 0.0;
  if (uLight < 0.5) {
    float h = clamp(halo * 0.35, 0.0, 0.6);
    col = mix(uAccent, uAccent2, 0.5) * h;
    a = h;
  }
  // layer: arrows (dim text colour) < text < box < dot
  col = mix(col, uTxtCol, arrA * uArrowA * 0.7); a = max(a, arrA * uArrowA * 0.7);
  col = mix(col, uTxtCol, txtA * uLabelA); a = max(a, txtA * uLabelA);
  col = mix(col, uBoxCol, boxA * 0.9); a = max(a, boxA * 0.9);
  col = mix(col, uDotCol, dotA); a = max(a, dotA);
  if (a < 0.002) discard;
  // col was built premultiplied (mixed from black); the material blends straight alpha
  gl_FragColor = vec4(col / a, a);
}
`;

function makeAtlas() {
  const cw = 34;
  const ch = 64;
  const c = document.createElement('canvas');
  c.width = cw * GLYPHS.length;
  c.height = ch;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#fff';
  g.font = `500 ${Math.round(ch * 0.72)}px 'Inter Variable', Inter, 'Helvetica Neue', Arial, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  for (let i = 0; i < GLYPHS.length; i++) g.fillText(GLYPHS[i], cw * i + cw / 2, ch * 0.8);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return { tex, aspect: cw / ch, canvas: c };
}

interface Cl {
  /** orbit parameters */
  ax: number;
  ay: number;
  az: number;
  fx: number;
  fy: number;
  fz: number;
  ph: number;
  r: number;
  pos: THREE.Vector3;
  prevPx: THREE.Vector2;
  vel: THREE.Vector2;
  lock: number;
  /** seconds until this one is allowed to lock (staggered re-targeting) */
  wait: number;
  shown: THREE.Vector2;
}

export const trackingHud = defineThreeScene({
  id: 'tracking-hud',
  name: 'Tracking HUD',
  description:
    'A swirling body of blue-white light watched by a computer-vision overlay: thin red boxes lock onto the bright clusters, green centroid dots, dashed motion arrows and live x / y coordinates. Loud parts lock on more boxes, kicks punch the clusters, and a drop blows the body apart and re-targets everything.',
  category: 'form',
  tags: ['electronic', 'futuristic', 'cinematic', 'techno', 'dark', 'cosmic', 'energetic', 'glitch', 'experimental'],
  params,
  modulations: [
    { source: 'energy', param: 'locks', amount: 0.25 },
    { source: 'mid', param: 'swirl', amount: 0.15 },
  ],
  build(init) {
    const scene = new THREE.Scene();
    const bg = new THREE.Color();
    scene.background = bg;
    const camera = new THREE.PerspectiveCamera(40, init.width / Math.max(1, init.height), 0.1, 100);
    camera.position.set(0, 0, 9);
    camera.lookAt(0, 0, 0);

    // ── particles ──
    const pos = new Float32Array(COUNT * 3);
    const seed = new Float32Array(COUNT * 4);
    const cid = new Float32Array(COUNT);
    const gauss = () => {
      const u = Math.max(1e-6, Math.random());
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(Math.PI * 2 * Math.random());
    };
    // weights: big clusters 0–2, small hot ones 3–7, ring, dust
    const weights = [0.2, 0.14, 0.12, 0.05, 0.05, 0.04, 0.04, 0.04];
    for (let i = 0; i < COUNT; i++) {
      // shuffle order so lowering density thins everything evenly
      const r = Math.random();
      let c = -1;
      if (r < 0.68) {
        let acc = 0;
        const rr = r / 0.68;
        const tot = weights.reduce((s, w) => s + w, 0);
        for (let k = 0; k < K; k++) {
          acc += weights[k] / tot;
          if (rr <= acc) {
            c = k;
            break;
          }
        }
        if (c < 0) c = 0;
      } else if (r < 0.86) c = -1;
      else c = -2;
      cid[i] = c;
      pos.set([gauss() * 0.5, gauss() * 0.5, gauss() * 0.5], i * 3);
      seed.set([Math.random(), Math.random(), Math.random(), Math.random()], i * 4);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    geo.setAttribute('aC', new THREE.BufferAttribute(cid, 1));
    const C = Array.from({ length: K }, () => new THREE.Vector3());
    const R = new Float32Array(K);
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
        uC: { value: C },
        uR: { value: R },
        uSwirlT: { value: 0 },
        uKickE: { value: 0 },
        uDropE: { value: 0 },
        uPx: { value: 1 },
        uRingR: { value: 1.2 },
        uRingT: { value: 0 },
        uRingC: { value: new THREE.Vector3() },
        uSpread: { value: 1 },
        uGain: { value: 0.3 },
      },
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    scene.add(points);

    // ── HUD overlay ──
    const atlas = makeAtlas();
    const box = Array.from({ length: K }, () => new THREE.Vector4());
    const mv = Array.from({ length: K }, () => new THREE.Vector4());
    const info = Array.from({ length: K }, () => new THREE.Vector4());
    const hudMat = makeMaterial({
      params,
      shared: init.shared,
      vertex: HUD_VERT,
      fragment: HUD_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      extra: {
        uBox: { value: box },
        uMv: { value: mv },
        uInfo: { value: info },
        uAtlas: { value: atlas.tex },
        uAtlasGrid: { value: new THREE.Vector2(GLYPHS.length, atlas.aspect) },
        uPx: { value: 1 },
        uLabelA: { value: 1 },
        uArrowA: { value: 1 },
        uLight: { value: 0 },
        uHaloK: { value: 1 },
        uBoxCol: { value: new THREE.Color('#ff2b2b') },
        uDotCol: { value: new THREE.Color('#33ff66') },
        uTxtCol: { value: new THREE.Color('#ffffff') },
      },
    });
    const hud = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), hudMat);
    hud.frustumCulled = false;
    hud.renderOrder = 10;
    scene.add(hud);

    // ── clusters ──
    const cls: Cl[] = [];
    const deal = (first: boolean) => {
      for (let k = 0; k < K; k++) {
        const big = k < 3;
        const c: Cl = cls[k] ?? {
          ax: 0, ay: 0, az: 0, fx: 0, fy: 0, fz: 0, ph: 0, r: 0,
          pos: new THREE.Vector3(), prevPx: new THREE.Vector2(), vel: new THREE.Vector2(), lock: 0, wait: 0, shown: new THREE.Vector2(),
        };
        c.ax = (big ? 0.5 : 1.1) * (0.5 + Math.random());
        c.ay = (big ? 0.7 : 1.3) * (0.5 + Math.random());
        c.az = 0.6 * Math.random();
        c.fx = 0.2 + Math.random() * 0.5;
        c.fy = 0.15 + Math.random() * 0.45;
        c.fz = 0.1 + Math.random() * 0.3;
        c.ph = Math.random() * 10;
        c.r = big ? 0.75 + Math.random() * 0.45 : 0.16 + Math.random() * 0.14;
        if (!first) {
          c.lock = 0;
          c.wait = 0.25 + k * 0.12 + Math.random() * 0.3;
        }
        cls[k] = c;
      }
    };
    deal(true);

    const kick = new Spring(260, 13);
    let swirlT = 0;
    let wanderT = 0;
    let ringT = 0;
    let drop = 0;
    let prevDrop = 0;
    let labelClock = 0;
    let spread = 1;
    const v3 = new THREE.Vector3();
    const v3b = new THREE.Vector3();
    const camRight = new THREE.Vector3(1, 0, 0);
    const boxCol = new THREE.Color();
    const dotCol = new THREE.Color();
    const txtCol = new THREE.Color();

    return {
      scene,
      camera,
      update(frame) {
        const dt = stepDt(frame);
        const a = frame.audio;
        const p = frame.params;
        const light = isLightPalette(frame.palette);
        syncMaterial(mat, frame, params);
        syncMaterial(hudMat, frame, params);
        bg.copy(frame.palette.c.bg);
        setAdaptiveBlending(mat, light);
        const W = frame.width;
        const H = frame.height;
        const px = H / 1080;

        if (a.drop > 0.6 && prevDrop <= 0.6) deal(false);
        prevDrop = a.drop;
        drop = a.drop > drop ? approach(drop, a.drop, 30, dt) : approach(drop, a.drop, 1.4, dt);
        kick.step(a.kick, dt);

        swirlT += dt * (0.2 + num(p, 'swirl', 0.45) * 1.8) * (0.5 + a.energy * 0.8 + a.mid * 0.4 + drop);
        wanderT += dt * (0.15 + num(p, 'wander', 0.45) * 0.9) * (0.5 + a.energy * 0.7);
        ringT += dt * (0.25 + a.energy * 0.6 + a.hat * 0.3);
        spread = approach(spread, 0.9 + a.energy * 0.2 + Math.max(0, a.sub) * 0.08, 2, dt);
        const wander = 0.4 + num(p, 'wander', 0.45) * 1.2;

        // cluster centres: lissajous orbits around the body
        for (let k = 0; k < K; k++) {
          const c = cls[k];
          const t = wanderT + c.ph;
          c.pos.set(Math.sin(t * c.fx * 2.1) * c.ax * wander, Math.sin(t * c.fy * 1.7 + 1.3) * c.ay * wander * 0.8, Math.cos(t * c.fz * 2.0) * c.az);
          if (k >= 3) c.pos.add(cls[k % 3].pos).multiplyScalar(0.75); // small ones ride near a big one
          C[k].copy(c.pos);
          R[k] = c.r * (1 + Math.max(0, kick.value) * num(p, 'burst', 0.55) * 0.5);
        }

        const density = num(p, 'density', 0.75);
        geo.setDrawRange(0, Math.floor(COUNT * Math.min(1, Math.max(0.05, density))));
        const u = mat.uniforms;
        u.uSwirlT.value = swirlT % 1000;
        u.uKickE.value = Math.max(0, kick.value) * num(p, 'burst', 0.55) * 1.6;
        u.uDropE.value = drop * num(p, 'explode', 0.8) * 1.5;
        u.uPx.value = px;
        u.uRingR.value = 1.15 * num(p, 'ring', 0.6) * 1.6 * (1 + Math.max(0, kick.value) * 0.1);
        u.uRingT.value = ringT % 1000;
        (u.uRingC.value as THREE.Vector3).copy(cls[0].pos).multiplyScalar(0.6);
        u.uSpread.value = spread;
        u.uGain.value = (light ? 0.45 : 0.5) / Math.sqrt(Math.max(0.1, density));

        camera.position.set(a.sway * 0.25, 0.1, 9);
        camera.lookAt(0, 0, 0);
        camera.updateMatrixWorld();
        camRight.setFromMatrixColumn(camera.matrixWorld, 0);

        // ── tracking: how many boxes, where ──
        const want = Math.min(K, Math.round(1 + num(p, 'locks', 0.6) * (0.5 + a.level * 5 + a.energy * 4 + drop * 4)));
        labelClock += dt;
        const refreshLabels = labelClock > 1 / 12;
        if (refreshLabels) labelClock = 0;
        // rank: big clusters first, then the small hot ones
        for (let k = 0; k < K; k++) {
          const c = cls[k];
          v3.copy(c.pos).multiplyScalar(spread).project(camera);
          const cx = (v3.x * 0.5 + 0.5) * W;
          const cy = (v3.y * 0.5 + 0.5) * H;
          v3b.copy(c.pos).multiplyScalar(spread).addScaledVector(camRight, R[k] * (k < 3 ? 0.55 : 0.8)).project(camera);
          const rp = Math.max(8 * px, Math.abs(((v3b.x - v3.x) * W) / 2));
          const vx = (cx - c.prevPx.x) / Math.max(dt, 1e-3);
          const vy = (cy - c.prevPx.y) / Math.max(dt, 1e-3);
          c.vel.x = approach(c.vel.x, vx, 4, dt);
          c.vel.y = approach(c.vel.y, vy, 4, dt);
          c.prevPx.set(cx, cy);

          c.wait = Math.max(0, c.wait - dt);
          const on = LOCK_ORDER.indexOf(k) < want && c.wait <= 0 && drop < 0.85;
          c.lock = on ? Math.min(1, c.lock + dt * 3.2) : Math.max(0, c.lock - dt * 4);
          if (a.kickHit && on && Math.random() < 0.25) c.lock = 0.35; // re-acquire flicker
          // readouts in a 1000-wide frame, y counted from the top like image coordinates
          if (refreshLabels || c.shown.x === 0) c.shown.set(Math.round((cx / W) * 999), Math.round(((H - cy) / W) * 999));

          const aspectBox = k < 3 ? 1.15 : 0.7;
          box[k].set(cx - rp, cy - rp * aspectBox, cx + rp, cy + rp * aspectBox);
          const vl = Math.hypot(c.vel.x, c.vel.y);
          const al = Math.min(110 * px, vl * 0.35);
          mv[k].set(cx, cy, vl > 1e-3 ? (c.vel.x / vl) * al : 0, vl > 1e-3 ? (c.vel.y / vl) * al : 0);
          const flicker = c.lock < 1 ? (Math.sin(frame.time * 60 + k) > -0.2 ? 1 : 0.3) : 1;
          info[k].set(c.lock, Math.max(0, Math.min(999, c.shown.x)), Math.max(0, Math.min(999, c.shown.y)), flicker);
        }

        const mode = str(p, 'hud', 'cv');
        const pal = frame.palette.c;
        if (mode === 'palette') {
          boxCol.copy(pal.accent);
          dotCol.copy(pal.accent2);
          txtCol.copy(pal.fg);
        } else if (mode === 'mono') {
          boxCol.copy(pal.fg);
          dotCol.copy(pal.fg);
          txtCol.copy(pal.fg);
        } else {
          boxCol.set(light ? '#e0201a' : '#ff2b2b');
          dotCol.set(light ? '#14a63c' : '#33ff66');
          txtCol.copy(pal.fg);
        }
        const hu = hudMat.uniforms;
        (hu.uBoxCol.value as THREE.Color).copy(boxCol);
        (hu.uDotCol.value as THREE.Color).copy(dotCol);
        (hu.uTxtCol.value as THREE.Color).copy(txtCol);
        hu.uPx.value = px;
        hu.uLabelA.value = num(p, 'labels', 1);
        hu.uArrowA.value = num(p, 'arrows', 0.8);
        hu.uLight.value = light ? 1 : 0;
        hu.uHaloK.value = 0.8 + a.energy * 0.4 + Math.max(0, kick.value) * 0.6 + drop * 0.8;
      },
      dispose() {
        atlas.tex.dispose();
      },
    };
  },
});
