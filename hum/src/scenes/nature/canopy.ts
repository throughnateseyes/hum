import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../../core/glsl';
import { createFullscreenQuad, makeRenderTarget } from '../../core/sceneHelpers';
import type { ParamDef, SceneDef } from '../../core/types';
import { num } from '../../core/uniforms';
import { approach, makeMaterial, stepDt, syncMaterial } from '../three/common';
import { DropTimer, TONEMAP_LIB, linColor, tempoRate } from './volume';

/**
 * Canopy: lying on the forest floor looking straight up through the trees at a blue sky.
 *
 *   - real 3D trees (seeded): tapered trunks rising from the frame edges, limbs, branches, twigs
 *   - ~18k backlit leaves (instanced quads, procedural blade + veins, alpha-to-coverage on an
 *     MSAA buffer), lit by light passing through them: the ones around the gap glow lime, the
 *     deep ones are dark silhouettes
 *   - a sky dome with drifting cumulus and the sun at the edge of the gap
 *   - post: god rays streaming through the leaves (radial blur of the bright sky), lens flare
 *     ghosts while the sun peeks through, ACES
 *
 * Audio: the mids sway the branches, the hats make the leaves flutter (the sun winks through the
 * gaps), snares and highs flare the sun, a build draws the canopy in a little and the drop parts
 * it, opening the sky and flooding the frame with light.
 *
 * Palette roles: bg = sky, accent2 = sunlight and cloud, accent = lit leaves, muted = deep
 * leaves, fg = bark and shadow.
 */
const params: ParamDef[] = [
  { id: 'gap', label: 'Sky opening', group: 'Shape', type: 'number', min: 0.15, max: 0.6, step: 0.01, default: 0.34, hint: 'How much sky shows through the middle' },
  { id: 'clouds', label: 'Clouds', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.45 },
  { id: 'speed', label: 'Cloud drift', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 0.6, hint: 'Follows the tempo' },
  { id: 'sway', label: 'Branch sway', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'The mids sway the branches' },
  { id: 'flutter', label: 'Leaf flutter', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'The hats make the leaves flutter' },
  { id: 'flare', label: 'Sun flare', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'Snares and highs flare the sun through the gaps' },
  { id: 'rays', label: 'Light rays', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
  { id: 'part', label: 'Drop parting', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'The drop parts the canopy' },
  { id: 'grain', label: 'Film grain', group: 'Color', type: 'number', min: 0, max: 0.1, step: 0.002, default: 0.025 },
];

const EYE = 1.6;
const MAX_LEAVES = 40000;

/* ───────────────────────── GLSL ───────────────────────── */

const SWAY = /* glsl */ `
uniform float uSwayT, uSwayAmp, uFlutterT, uFlutterAmp, uPart;
uniform vec2 uWindDir;
vec3 cpSway(vec3 p, float flex) {
  float f = flex * flex;
  vec2 q = p.xz * 0.11;
  float n1 = vnoise(q + vec2(uSwayT * 0.35, 0.0)) - 0.5;
  float n2 = vnoise(q * 1.7 + vec2(3.1, uSwayT * 0.47)) - 0.5;
  float gust = sin(uSwayT * 0.8 + p.x * 0.06 + p.z * 0.04) * 0.5 + 0.5;
  vec3 d = vec3(uWindDir.x, 0.0, uWindDir.y) * (0.3 + 0.7 * gust) + vec3(n1, 0.0, n2) * 1.4;
  d *= f * uSwayAmp;
  // parting: push outward from the opening (the camera's axis)
  vec2 r = p.xz;
  float rl = max(length(r), 0.001);
  d.xz += (r / rl) * uPart * f * 3.8;
  return d;
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
varying vec3 vDir;
uniform vec3 uZenith, uSkyEdge, uSunDir, uSunCol, uCloudCol, uCloudShade;
uniform vec2 uCloudOff;
uniform float uCloudCov;
float cpFbm(vec2 p) {
  float s = 0.0, a = 0.5;
  mat2 m = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 6; i++) { s += a * vnoise(p); p = m * p * 2.02 + 3.7; a *= 0.5; }
  return s;
}
void main() {
  vec3 d = normalize(vDir);
  float y = max(d.y, 0.0);
  vec3 sky = mix(uSkyEdge, uZenith, smoothstep(0.35, 1.0, y));
  float mu = dot(d, uSunDir);
  // cumulus bellies on a plane overhead
  vec2 uv = d.xz / max(d.y, 0.12) * 1.6 + uCloudOff;
  float n = cpFbm(uv) + 0.06 * (vnoise(uv * 9.0 + uCloudOff * 3.0) - 0.5);
  float th = 0.8 - uCloudCov * 0.36;
  float cov = smoothstep(th - 0.06, th + 0.16, n);
  float thick = smoothstep(th, th + 0.38, n);
  vec3 cloud = mix(uCloudCol, uCloudShade, thick * 0.75);
  // thin edges light up near the sun
  cloud += uSunCol * (1.0 - thick) * 0.06 * pow(max(mu, 0.0), 14.0);
  sky = mix(sky, cloud, cov);
  // sun: disc, tight glow, wide glow (dimmed behind cloud)
  float open = 1.0 - 0.75 * cov;
  sky += uSunCol * (0.5 * pow(max(mu, 0.0), 900.0) + 0.05 * pow(max(mu, 0.0), 60.0) + 0.012 * pow(max(mu, 0.0), 6.0)) * open;
  sky += uSunCol * 40.0 * smoothstep(0.99986, 0.99992, mu) * (1.0 - 0.9 * cov);
  gl_FragColor = vec4(sky, 1.0);
}
`;

const BARK_VERT = /* glsl */ `
attribute float aFlex;
varying vec3 vN;
varying vec3 vW;
${SWAY}
void main() {
  vec3 p = position + cpSway(position, aFlex);
  vN = normal;
  vW = p;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const BARK_FRAG = /* glsl */ `
varying vec3 vN;
varying vec3 vW;
uniform vec3 uBark, uSunDir, uSunCol, uAmb;
void main() {
  vec3 n = normalize(vN);
  float tex = 0.75 + 0.5 * vnoise(vec2(vW.y * 6.0, atan(n.z, n.x) * 3.0 + vW.x));
  // seen from below, bark is mostly in shade: a little sky fill, a rim where it faces the sun
  float sky = 0.35 + 0.65 * max(-n.y, 0.0);
  float rim = pow(max(dot(n, uSunDir), 0.0), 3.0);
  vec3 col = uBark * tex * (uAmb * sky + uSunCol * 0.05 * rim);
  gl_FragColor = vec4(col, 1.0);
}
`;

const LEAF_VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aRot;
attribute vec4 aInfo; // size, flex, light, random
varying vec2 vLeaf;
varying vec3 vDir;
varying float vSunN;
varying float vLight;
varying float vRnd;
uniform vec3 uSunDir;
${SWAY}
vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
void main() {
  float size = aInfo.x;
  float r = aInfo.w;
  // flutter: the blade twists about its stem
  float a = uFlutterAmp * sin(uFlutterT * (5.0 + 4.0 * fract(r * 13.7)) + r * 60.0);
  float lx = position.x * 0.62;
  float ly = position.y + 0.5;
  vec3 local = vec3(lx * cos(a), ly, lx * sin(a) + ly * ly * 0.12) * size;
  vec3 nrm = qrot(aRot, vec3(-sin(a), 0.0, cos(a)));
  vec3 p = aPos + qrot(aRot, local) + cpSway(aPos, aInfo.y);
  vLeaf = vec2(position.x * 2.0, ly);
  vDir = p - cameraPosition;
  vSunN = 0.35 + 0.65 * abs(dot(nrm, uSunDir));
  vLight = aInfo.z;
  vRnd = r;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const LEAF_FRAG = /* glsl */ `
varying vec2 vLeaf;
varying vec3 vDir;
varying float vSunN;
varying float vLight;
varying float vRnd;
uniform vec3 uSunDir, uSunCol, uLeafLit, uLeafDeep, uLeafDark, uAmb;
uniform float uTransK;
void main() {
  float x = vLeaf.x;
  float y = vLeaf.y;
  // ovate blade with a drawn-out tip and a fine serration
  float w = 0.5 * pow(sin(3.14159 * pow(clamp(y, 0.0, 1.0), 0.75)), 0.85) * (1.0 + 0.05 * sin(y * 70.0));
  float edge = w - abs(x);
  float aa = fwidth(edge) * 0.8 + 1e-4;
  float alpha = smoothstep(-aa, aa, edge);
  if (alpha < 0.02) discard;
  float rel = abs(x) / max(w, 0.02);
  // veins read darker against the light
  float mid = 1.0 - smoothstep(0.0, 0.035 + fwidth(x), abs(x));
  float sv = abs(fract((y - abs(x) * 0.8) * 7.0) - 0.5);
  float sec = (1.0 - smoothstep(0.0, 0.07 + fwidth(y) * 3.0, sv)) * (1.0 - smoothstep(0.2, 1.0, rel));
  float vein = max(mid, sec * 0.6);
  float mott = 0.82 + 0.36 * vnoise(vLeaf * vec2(7.0, 11.0) + vRnd * 91.0);
  vec3 tint = mix(uLeafLit, uLeafDeep, smoothstep(0.2, 1.0, fract(vRnd * 7.31)) * 0.55);
  // light passing through: strongest when the leaf sits in front of the sun
  float mu = dot(normalize(vDir), uSunDir);
  float fwd = 0.45 + 2.2 * pow(max(mu, 0.0), 10.0) + 6.0 * pow(max(mu, 0.0), 120.0);
  float thin = 1.0 + 0.35 * (1.0 - smoothstep(0.0, 0.12, edge));
  vec3 trans = uSunCol * tint * (1.0 - 0.45 * vein) * mott * thin * vSunN * fwd * uTransK;
  vec3 col = trans * vLight + uLeafDark * uAmb * (0.6 + 0.4 * mott);
  gl_FragColor = vec4(col, alpha);
}
`;

const BRIGHT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform vec2 uTexel, uSunUv;
uniform float uAspect, uThr;
void main() {
  vec3 c = texture2D(tScene, vUv + uTexel * vec2(-0.5, -0.5)).rgb;
  c += texture2D(tScene, vUv + uTexel * vec2(0.5, -0.5)).rgb;
  c += texture2D(tScene, vUv + uTexel * vec2(-0.5, 0.5)).rgb;
  c += texture2D(tScene, vUv + uTexel * vec2(0.5, 0.5)).rgb;
  c *= 0.25;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec2 d = (vUv - uSunUv) * vec2(uAspect, 1.0);
  float m = exp(-dot(d, d) * 3.0);
  vec3 b = c * smoothstep(uThr, uThr * 2.5, l) * m;
  gl_FragColor = vec4(min(b, vec3(60.0)), 1.0);
}
`;

const RAYS_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tBright;
uniform vec2 uSunUv;
uniform float uLen;
float rh(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  const int N = 40;
  vec2 dlt = (uSunUv - vUv) * uLen / float(N);
  vec2 p = vUv + dlt * rh(gl_FragCoord.xy);
  vec3 acc = vec3(0.0);
  float w = 1.0;
  for (int i = 0; i < N; i++) {
    acc += texture2D(tBright, p).rgb * w;
    w *= 0.955;
    p += dlt;
  }
  gl_FragColor = vec4(acc / 18.0, 1.0);
}
`;

const COMP_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene, tRays, tBright;
uniform vec2 uSunUv;
uniform float uAspect, uRayK, uFlareK, uExposure, uGrain, uTime, uSat;
uniform vec3 uFlareTint;
${TONEMAP_LIB}
float ch21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float ghost(vec2 uv, vec2 c, float r) {
  vec2 d = (uv - c) * vec2(uAspect, 1.0);
  float l = length(d);
  return smoothstep(r, r * 0.55, l) * (0.6 + 0.4 * smoothstep(r * 0.5, r, l));
}
void main() {
  vec3 col = texture2D(tScene, vUv).rgb;
  vec3 rays = texture2D(tRays, vUv).rgb;
  col += rays * uRayK;
  // how much of the sun is showing (its disc in the bright buffer)
  vec3 sv = texture2D(tBright, uSunUv).rgb;
  float vis = clamp(dot(sv, vec3(0.333)) / 25.0, 0.0, 1.0);
  vec2 axis = vec2(0.5) - uSunUv;
  vec3 fl = vec3(0.0);
  fl += vec3(1.0, 0.85, 0.6) * ghost(vUv, uSunUv + axis * 0.55, 0.035) * 0.5;
  fl += vec3(0.6, 1.0, 0.7) * ghost(vUv, uSunUv + axis * 1.25, 0.06) * 0.3;
  fl += vec3(0.7, 0.8, 1.0) * ghost(vUv, uSunUv + axis * 1.6, 0.11) * 0.18;
  fl += vec3(1.0, 0.7, 0.5) * ghost(vUv, uSunUv + axis * 2.15, 0.025) * 0.5;
  // soft halo and a faint streak through the sun
  vec2 ds = (vUv - uSunUv) * vec2(uAspect, 1.0);
  float r = length(ds);
  fl += vec3(1.0, 0.9, 0.75) * (exp(-r * 9.0) * 0.6 + exp(-abs(ds.y) * 120.0) * exp(-abs(ds.x) * 4.0) * 0.35);
  col += fl * uFlareTint * vis * uFlareK;
  vec3 o = ntToDisplay(col, uExposure);
  float l = dot(o, vec3(0.2126, 0.7152, 0.0722));
  o = mix(vec3(l), o, uSat);
  o += (ch21(gl_FragCoord.xy + fract(uTime * 7.31) * 517.0) - 0.5) * uGrain;
  gl_FragColor = vec4(clamp(o, 0.0, 1.0), 1.0);
}
`;

/* ───────────────────────── forest generation ───────────────────────── */

interface Arrays {
  pos: number[];
  nor: number[];
  flex: number[];
  idx: number[];
}

interface Leaves {
  pos: number[];
  rot: number[];
  info: number[];
  n: number;
}

const _a = new THREE.Vector3();
const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _Y = new THREE.Vector3(0, 1, 0);
const _X = new THREE.Vector3(1, 0, 0);

/** A tapered cylinder from a to b, appended to the bark arrays. */
function addSegment(g: Arrays, a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number, fa: number, fb: number, sides: number) {
  _a.subVectors(b, a).normalize();
  _u.crossVectors(_a, Math.abs(_a.y) < 0.95 ? _Y : _X).normalize();
  _v.crossVectors(_a, _u);
  const base = g.pos.length / 3;
  for (let ring = 0; ring < 2; ring++) {
    const c = ring ? b : a;
    const r = ring ? rb : ra;
    const f = ring ? fb : fa;
    for (let j = 0; j < sides; j++) {
      const t = (j / sides) * Math.PI * 2;
      _n.copy(_u).multiplyScalar(Math.cos(t)).addScaledVector(_v, Math.sin(t));
      g.pos.push(c.x + _n.x * r, c.y + _n.y * r, c.z + _n.z * r);
      g.nor.push(_n.x, _n.y, _n.z);
      g.flex.push(f);
    }
  }
  for (let j = 0; j < sides; j++) {
    const j2 = (j + 1) % sides;
    g.idx.push(base + j, base + j2, base + sides + j, base + j2, base + sides + j2, base + sides + j);
  }
}

function buildForest(seed: number, gap: number, sunDir: THREE.Vector3) {
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const range = (a: number, b: number) => a + (b - a) * rnd();
  const bark: Arrays = { pos: [], nor: [], flex: [], idx: [] };
  const leaves: Leaves = { pos: [], rot: [], info: [], n: 0 };
  const q = new THREE.Quaternion();
  const qa = new THREE.Quaternion();
  const e = new THREE.Euler();

  /** tan-angle from the view axis, and how far outside the opening a point sits */
  const gapR = (x: number, z: number) => {
    const th = Math.atan2(z, x);
    return gap * (1 + 0.22 * Math.sin(3 * th + 1.3) + 0.14 * Math.sin(5 * th + 0.4) + 0.08 * Math.sin(9 * th + 2.0));
  };
  const viewR = (p: THREE.Vector3) => Math.hypot(p.x, p.z) / Math.max(p.y - EYE, 0.3);

  const leafCluster = (c: THREE.Vector3, rad: number, count: number, flex: number, size: number) => {
    const gr = gapR(c.x, c.z);
    const vr = viewR(c);
    for (let i = 0; i < count && leaves.n < MAX_LEAVES; i++) {
      const ox = (rnd() * 2 - 1) * rad;
      const oy = (rnd() * 2 - 1) * rad * 0.6;
      const oz = (rnd() * 2 - 1) * rad;
      if (ox * ox + oy * oy * 2 + oz * oz > rad * rad) continue;
      const px = c.x + ox;
      const py = c.y + oy;
      const pz = c.z + oz;
      const pr = Math.hypot(px, pz) / Math.max(py - EYE, 0.3);
      if (pr < gapR(px, pz) * (0.92 + 0.16 * rnd())) continue; // crown shyness: keep the opening
      // light reaching this leaf: the sun side of the cluster and the rim of the opening glow,
      // the deep canopy is shade
      const side = (ox * sunDir.x + oy * sunDir.y + oz * sunDir.z) / rad;
      const rim = 1 - THREE.MathUtils.smoothstep(vr / gr, 1.0, 2.1);
      const l0 = (0.12 + 0.3 * (side * 0.5 + 0.5) + 0.6 * rim) * (0.5 + 0.7 * rnd()) * (rnd() < 0.22 ? 0.25 : 1);
      const light = THREE.MathUtils.clamp(Math.pow(l0, 1.5), 0.02, 1.3);
      // blades mostly face the sky, tilted every which way
      e.set(-Math.PI / 2 + range(-1.1, 1.1), 0, range(-0.6, 0.6));
      q.setFromEuler(e);
      qa.setFromAxisAngle(_Y, rnd() * Math.PI * 2);
      q.premultiply(qa);
      leaves.pos.push(px, py, pz);
      leaves.rot.push(q.x, q.y, q.z, q.w);
      leaves.info.push(size * range(0.75, 1.25), flex + rnd() * 0.05, light, rnd());
      leaves.n++;
    }
  };

  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  /** a bent branch as a polyline; returns the points and flex along it */
  const branch = (start: THREE.Vector3, d0: THREE.Vector3, len: number, r0: number, r1: number, f0: number, segs: number, sides: number, sag: number, stiff = 9) => {
    const pts: THREE.Vector3[] = [start.clone()];
    const fl: number[] = [f0];
    dir.copy(d0).normalize();
    p0.copy(start);
    for (let i = 1; i <= segs; i++) {
      tmp.set(range(-1, 1), range(-1, 1), range(-1, 1)).multiplyScalar(0.28);
      dir.add(tmp);
      dir.y -= sag;
      dir.normalize();
      p1.copy(p0).addScaledVector(dir, len / segs);
      // keep the middle of the opening clear: limbs stop short of it
      if (stiff < 50 && viewR(p1) < gapR(p1.x, p1.z) * 0.62) break;
      const f = f0 + (len * i) / segs / stiff;
      addSegment(bark, p0, p1, r0 + ((r1 - r0) * (i - 1)) / segs, r0 + ((r1 - r0) * i) / segs, fl[i - 1], f, sides);
      pts.push(p1.clone());
      fl.push(f);
      p0.copy(p1);
    }
    return { pts, fl, dir: dir.clone() };
  };

  const tree = (bx: number, bz: number, height: number, crown: number, leafSize: number, density: number) => {
    const out = new THREE.Vector3(bx, 0, bz).normalize();
    // trunk, leaning a touch toward the light in the middle
    const trunk = branch(new THREE.Vector3(bx, -2, bz), new THREE.Vector3(-out.x * 0.08, 1, -out.z * 0.08), height + 2, 0.32 * crown + 0.12, 0.09, 0, 6, 9, 0, 100);
    const limbs = 5 + Math.floor(rnd() * 3);
    for (let l = 0; l < limbs; l++) {
      const t = 0.5 + 0.5 * (l / limbs) + range(-0.04, 0.04);
      const k = Math.min(trunk.pts.length - 1, Math.max(1, Math.round(t * (trunk.pts.length - 1))));
      const at = trunk.pts[k];
      const az = Math.atan2(out.z, out.x) + range(-2.2, 2.2);
      const el = range(0.35, 0.95);
      const d = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
      const limb = branch(at, d, crown * range(3.2, 5.5), 0.13 * crown, 0.035, trunk.fl[k], 3, 6, 0.04);
      for (let sIdx = 1; sIdx < limb.pts.length; sIdx++) {
        const nSec = 2 + Math.floor(rnd() * 2);
        for (let m = 0; m < nSec; m++) {
          const sd = limb.dir.clone().add(tmp.set(range(-1, 1), range(-0.2, 0.8), range(-1, 1))).normalize();
          const sec = branch(limb.pts[sIdx], sd, crown * range(1.3, 2.6), 0.035, 0.012, limb.fl[sIdx], 2, 5, 0.06);
          leafCluster(sec.pts[sec.pts.length - 1], crown * 0.9, Math.round(density * 26), sec.fl[sec.fl.length - 1], leafSize);
          for (let tIdx = 1; tIdx < sec.pts.length; tIdx++) {
            const nTw = 2 + Math.floor(rnd() * 2);
            for (let w = 0; w < nTw; w++) {
              const td = sec.dir.clone().add(tmp.set(range(-1, 1), range(-0.5, 0.6), range(-1, 1))).normalize();
              const tip = sec.pts[tIdx].clone().addScaledVector(td, crown * range(0.5, 1.0));
              if (viewR(tip) < gapR(tip.x, tip.z) * 0.8) continue;
              const tf = sec.fl[tIdx] + 0.08;
              addSegment(bark, sec.pts[tIdx], tip, 0.012, 0.006, sec.fl[tIdx], tf, 4);
              leafCluster(tip, crown * range(0.8, 1.15), Math.round(density * range(28, 44)), tf, leafSize);
            }
          }
        }
      }
    }
  };

  // the canopy: tall trees ringing the view, their crowns meeting overhead around an opening
  const nTrees = 7;
  for (let i = 0; i < nTrees; i++) {
    const th = (i / nTrees) * Math.PI * 2 + range(-0.25, 0.25);
    const d = range(6.5, 10.5);
    tree(Math.cos(th) * d, Math.sin(th) * d, range(13, 18), range(1.0, 1.3), 0.32, 1);
  }
  // an understory sapling close by, top left: big near leaves for depth
  tree(-3.2, 2.8, 5.5, 0.55, 0.19, 0.8);

  return { bark, leaves };
}

/* ───────────────────────── scene ───────────────────────── */

export const canopy: SceneDef = {
  id: 'canopy',
  name: 'Canopy',
  description:
    'Lying on the forest floor looking straight up through backlit leaves at a blue sky with white clouds. The mids sway the branches, the hats flutter the leaves so the sun winks through the gaps, snares and highs flare the sun and its rays, a build draws the canopy in and the drop parts it to flood the frame with light. The open sky in the middle keeps lyrics readable.',
  category: 'form',
  style: 'world',
  tags: ['dreamy', 'calm', 'hopeful', 'uplifting', 'tender', 'nostalgic', 'acoustic', 'indie', 'folk', 'nature', 'organic', 'realistic', 'warm', 'bright'],
  light: true,
  params,
  modulations: [],
  create(init) {
    const { shared } = init;
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 1200);
    camera.position.set(0, EYE, 0);
    camera.up.set(0, 0, 1); // screen right = +X, screen up = +Z
    camera.lookAt(0, 100, 0);
    const sunDir = new THREE.Vector3(0.3, 1, 0.36).normalize();

    const swayU = {
      uSwayT: { value: 0 },
      uSwayAmp: { value: 0.3 },
      uFlutterT: { value: 0 },
      uFlutterAmp: { value: 0.2 },
      uPart: { value: 0 },
      uWindDir: { value: new THREE.Vector2(0.8, 0.6) },
      uSunDir: { value: sunDir },
      uSunCol: { value: new THREE.Vector3(8, 7.5, 6.5) },
      uAmb: { value: new THREE.Vector3(0.3, 0.4, 0.55) },
    };

    const skyMat = makeMaterial({
      params,
      shared,
      vertex: SKY_VERT,
      fragment: SKY_FRAG,
      extra: {
        ...swayU,
        uZenith: { value: new THREE.Vector3() },
        uSkyEdge: { value: new THREE.Vector3() },
        uCloudCol: { value: new THREE.Vector3() },
        uCloudShade: { value: new THREE.Vector3() },
        uCloudOff: { value: new THREE.Vector2() },
        uCloudCov: { value: 0.45 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    });
    const skyGeo = new THREE.SphereGeometry(500, 48, 24);
    const sky = new THREE.Mesh(skyGeo, skyMat);
    sky.renderOrder = -1;
    sky.frustumCulled = false;

    const barkMat = makeMaterial({
      params,
      shared,
      vertex: BARK_VERT,
      fragment: BARK_FRAG,
      extra: { ...swayU, uBark: { value: new THREE.Vector3() } },
    });
    const leafMat = makeMaterial({
      params,
      shared,
      vertex: LEAF_VERT,
      fragment: LEAF_FRAG,
      extra: {
        ...swayU,
        uLeafLit: { value: new THREE.Vector3() },
        uLeafDeep: { value: new THREE.Vector3() },
        uLeafDark: { value: new THREE.Vector3() },
        uTransK: { value: 0.5 },
      },
      side: THREE.DoubleSide,
    });
    leafMat.alphaToCoverage = true;

    const scene = new THREE.Scene();
    scene.add(sky);
    let barkMesh: THREE.Mesh | null = null;
    let leafMesh: THREE.Mesh | null = null;
    let builtGap = -1;
    const build = (gap: number) => {
      if (barkMesh) {
        scene.remove(barkMesh);
        barkMesh.geometry.dispose();
      }
      if (leafMesh) {
        scene.remove(leafMesh);
        leafMesh.geometry.dispose();
      }
      const f = buildForest(20250611, gap, sunDir);
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.Float32BufferAttribute(f.bark.pos, 3));
      bg.setAttribute('normal', new THREE.Float32BufferAttribute(f.bark.nor, 3));
      bg.setAttribute('aFlex', new THREE.Float32BufferAttribute(f.bark.flex, 1));
      bg.setIndex(f.bark.idx);
      barkMesh = new THREE.Mesh(bg, barkMat);
      barkMesh.frustumCulled = false;
      const plane = new THREE.PlaneGeometry(1, 1);
      const lg = new THREE.InstancedBufferGeometry();
      lg.index = plane.index;
      lg.setAttribute('position', plane.getAttribute('position'));
      lg.setAttribute('uv', plane.getAttribute('uv'));
      lg.setAttribute('aPos', new THREE.InstancedBufferAttribute(new Float32Array(f.leaves.pos), 3));
      lg.setAttribute('aRot', new THREE.InstancedBufferAttribute(new Float32Array(f.leaves.rot), 4));
      lg.setAttribute('aInfo', new THREE.InstancedBufferAttribute(new Float32Array(f.leaves.info), 4));
      lg.instanceCount = f.leaves.n;
      leafMesh = new THREE.Mesh(lg, leafMat);
      leafMesh.frustumCulled = false;
      scene.add(barkMesh, leafMesh);
      builtGap = gap;
    };

    // post
    let sceneRT: THREE.WebGLRenderTarget | null = null;
    let brightRT: THREE.WebGLRenderTarget | null = null;
    let raysRT: THREE.WebGLRenderTarget | null = null;
    const sunUv = new THREE.Vector2(0.7, 0.75);
    const brightMat = new THREE.ShaderMaterial({
      uniforms: { tScene: { value: null }, uTexel: { value: new THREE.Vector2() }, uSunUv: { value: sunUv }, uAspect: { value: 1 }, uThr: { value: 1.2 } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BRIGHT_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const raysMat = new THREE.ShaderMaterial({
      uniforms: { tBright: { value: null }, uSunUv: { value: sunUv }, uLen: { value: 0.8 } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: RAYS_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const compMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tRays: { value: null },
        tBright: { value: null },
        uSunUv: { value: sunUv },
        uAspect: { value: 1 },
        uRayK: { value: 1 },
        uFlareK: { value: 1 },
        uExposure: { value: 1 },
        uGrain: { value: 0.025 },
        uTime: { value: 0 },
        uSat: { value: 1 },
        uFlareTint: { value: new THREE.Vector3(1, 1, 1) },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COMP_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const brightQuad = createFullscreenQuad(brightMat);
    const raysQuad = createFullscreenQuad(raysMat);
    const compQuad = createFullscreenQuad(compMat);

    const drop = new DropTimer();
    let swayT = 0;
    let flutterT = 0;
    let swayAmp = 0.3;
    let flutterAmp = 0.2;
    let flareS = 0;
    let part = 0;
    const cloudOff = new THREE.Vector2();
    const sunP = new THREE.Vector3();
    const col = new THREE.Color();

    return {
      render(frame, target) {
        const dt = stepDt(frame);
        const a = frame.audio;
        const p = frame.params;
        const pal = frame.palette.c;
        const gap = num(p, 'gap', 0.34);
        if (Math.abs(gap - builtGap) > 0.004) build(gap);
        drop.step(frame);
        const dEnv = drop.env;
        const buildV = Math.min(1, Math.max(0, a.build));

        // camera: straight up; tall frames widen the view so the width never gets too narrow
        const tanY0 = Math.tan((62 * Math.PI) / 360);
        const ty = Math.max(tanY0, tanY0 / Math.max(frame.aspect, 0.1));
        camera.fov = (Math.atan(Math.min(ty, 1.6)) * 360) / Math.PI;
        camera.aspect = frame.aspect;
        camera.updateProjectionMatrix();

        // motion
        const rate = tempoRate(frame);
        swayAmp = approach(swayAmp, (0.18 + 1.0 * a.mid + 0.3 * a.lowMid) * num(p, 'sway', 1), 3, dt);
        flutterAmp = approach(flutterAmp, (0.12 + 0.9 * a.hat + 0.4 * a.air) * num(p, 'flutter', 1), 10, dt);
        swayT += dt * rate * (0.5 + 0.6 * a.energy);
        flutterT += dt * (1 + 1.5 * a.hat);
        flareS = Math.max(flareS * Math.exp(-dt * 5), a.snare * 1.0 + a.hat * 0.5 + a.highMid * 0.3);
        part = approach(part, dEnv * num(p, 'part', 1) - 0.12 * buildV, 6, dt);
        cloudOff.x += dt * num(p, 'speed', 0.6) * rate * 0.012;
        cloudOff.y += dt * num(p, 'speed', 0.6) * rate * 0.007;
        swayU.uSwayT.value = swayT;
        swayU.uSwayAmp.value = swayAmp;
        swayU.uFlutterT.value = flutterT;
        swayU.uFlutterAmp.value = flutterAmp;
        swayU.uPart.value = part;

        // light and colour from the palette (linear)
        const sunI = 7 * (1 + 0.6 * dEnv + 0.25 * buildV);
        linColor(pal.accent2, swayU.uSunCol.value).multiplyScalar(sunI);
        col.copy(pal.bg).lerp(pal.fg, 0.05);
        linColor(col, swayU.uAmb.value).multiplyScalar(0.5);
        const su = skyMat.uniforms;
        col.copy(pal.bg).multiplyScalar(0.82);
        linColor(col, su.uZenith.value as THREE.Vector3).multiplyScalar(1.1);
        col.copy(pal.bg).lerp(pal.accent2, 0.3);
        linColor(col, su.uSkyEdge.value as THREE.Vector3).multiplyScalar(1.25);
        linColor(pal.accent2, su.uCloudCol.value as THREE.Vector3).multiplyScalar(1.4);
        col.copy(pal.accent2).lerp(pal.bg, 0.45);
        linColor(col, su.uCloudShade.value as THREE.Vector3).multiplyScalar(0.75);
        (su.uCloudOff.value as THREE.Vector2).copy(cloudOff);
        su.uCloudCov.value = num(p, 'clouds', 0.45);
        col.copy(pal.fg).lerp(pal.bg, 0.15);
        linColor(col, barkMat.uniforms.uBark.value as THREE.Vector3).multiplyScalar(0.6);
        const lu = leafMat.uniforms;
        linColor(pal.accent, lu.uLeafLit.value as THREE.Vector3);
        linColor(pal.muted, lu.uLeafDeep.value as THREE.Vector3);
        linColor(pal.fg, lu.uLeafDark.value as THREE.Vector3).multiplyScalar(0.6);
        lu.uTransK.value = 0.35;
        syncMaterial(skyMat, frame, params);
        syncMaterial(barkMat, frame, params);
        syncMaterial(leafMat, frame, params);

        // targets
        const w = frame.width;
        const h = frame.height;
        const hw = Math.max(2, Math.round(w / 2));
        const hh = Math.max(2, Math.round(h / 2));
        if (!sceneRT || sceneRT.width !== w || sceneRT.height !== h) {
          sceneRT?.dispose();
          brightRT?.dispose();
          raysRT?.dispose();
          sceneRT = makeRenderTarget(w, h, { samples: 4, depthBuffer: true });
          brightRT = makeRenderTarget(hw, hh);
          raysRT = makeRenderTarget(hw, hh);
        }
        const r = frame.renderer;
        r.setRenderTarget(sceneRT);
        r.setClearColor(0x000000, 1);
        r.clear();
        r.render(scene, camera);

        // where the sun is on screen
        sunP.copy(sunDir).multiplyScalar(300).add(camera.position).project(camera);
        sunUv.set(sunP.x * 0.5 + 0.5, sunP.y * 0.5 + 0.5);

        const bu = brightMat.uniforms;
        bu.tScene.value = sceneRT.texture;
        (bu.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
        bu.uAspect.value = frame.aspect;
        bu.uThr.value = 1.0;
        brightQuad.render(r, brightRT);
        raysMat.uniforms.tBright.value = brightRT!.texture;
        raysMat.uniforms.uLen.value = 0.85;
        raysQuad.render(r, raysRT);

        const cu = compMat.uniforms;
        cu.tScene.value = sceneRT.texture;
        cu.tRays.value = raysRT!.texture;
        cu.tBright.value = brightRT!.texture;
        cu.uAspect.value = frame.aspect;
        cu.uRayK.value = num(p, 'rays', 1) * 0.35 * (1 + 0.8 * flareS + 0.8 * buildV + 1.5 * dEnv);
        cu.uFlareK.value = num(p, 'flare', 1) * 0.5 * (0.4 + 1.6 * flareS + 1.2 * dEnv);
        cu.uExposure.value = 0.8 * (1 + 0.12 * dEnv);
        cu.uGrain.value = num(p, 'grain', 0.025);
        cu.uTime.value = frame.time;
        cu.uSat.value = 1.08;
        linColor(pal.accent2, cu.uFlareTint.value as THREE.Vector3);
        compQuad.render(r, target);
      },
      dispose() {
        sceneRT?.dispose();
        brightRT?.dispose();
        raysRT?.dispose();
        barkMesh?.geometry.dispose();
        leafMesh?.geometry.dispose();
        skyGeo.dispose();
        skyMat.dispose();
        barkMat.dispose();
        leafMat.dispose();
        brightMat.dispose();
        raysMat.dispose();
        compMat.dispose();
        brightQuad.dispose();
        raysQuad.dispose();
        compQuad.dispose();
      },
    };
  },
};
