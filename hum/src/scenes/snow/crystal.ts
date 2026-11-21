import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../../core/glsl';
import { createFullscreenQuad, makeRenderTarget } from '../../core/sceneHelpers';
import type { FrameContext, ParamDef, SceneDef } from '../../core/types';
import { num, str } from '../../core/uniforms';
import { quality } from '../../render/quality';
import { DropTimer, TONEMAP_LIB, linColor } from '../nature/volume';
import { approach, makeMaterial, stepDt, syncMaterial } from '../three/common';
import { SNOW_LIB, isCoarse } from './common';

/**
 * Crystal: one snowflake crystallising live, grown by the song.
 *
 *   - a real growth model on the GPU: the Gravner–Griffeath snow crystal automaton on a hexagonal
 *     lattice (vapour diffuses, freezes onto the boundary, attaches by neighbour-count rules, melts back
 *     a little). Every site keeps four numbers: vapour, boundary water, crystal mass and the moment it
 *     froze. Because the conditions are the same in all six directions, the six arms grow alike
 *   - the song is the weather the flake falls through. Calm parts are dry, slow air: high attachment
 *     thresholds and little vapour, so the tips flatten into faceted plates. Loud parts are humid and
 *     fast: vapour piles up, the tips run out as dendrites. Each kick is a brief gust of supersaturation
 *     that sprouts a ring of side branches on every arm at once, and a build feeds the tips until they
 *     race. So the flake is a record of the song, ring by ring, and no two songs grow the same one
 *   - a drop releases the finished flake: it tumbles away past the lens while a new seed crystal
 *     sparks in the middle and grows in the chorus weather
 *   - drawn as a thin glass plate in 3D: the crystal mass is its thickness, so ridges and sectored
 *     plates show as relief, the backdrop refracts through it, edges catch thin-film colour and a
 *     bright refraction line, and freshly frozen edges glow for a moment as the flake builds out
 *   - soft out-of-focus snow falls behind it on the shared wind
 *
 * Palette roles: bg = backdrop (top), muted = backdrop (bottom, haze), fg = light (highlights, edges),
 * accent = the ice's cold tint, accent2 = the warm interference colour on edges.
 */

const params: ParamDef[] = [
  {
    id: 'backdrop',
    label: 'Backdrop',
    group: 'Shape',
    type: 'select',
    default: 'gradient',
    options: [
      { value: 'gradient', label: 'Studio gradient' },
      { value: 'black', label: 'Black' },
    ],
  },
  { id: 'growth', label: 'Growth speed', group: 'Motion', type: 'number', min: 0.3, max: 2, step: 0.01, default: 1, hint: 'How fast the crystal builds out' },
  { id: 'branching', label: 'Branching', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'Faceted plates (0) or feathery dendrites (1); the song moves it either way' },
  { id: 'imperfect', label: 'Imperfection', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.25, hint: 'Real flakes are never perfectly symmetric' },
  { id: 'relief', label: 'Relief', group: 'Color', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'Ridges and sectored plates in the ice' },
  { id: 'iridescence', label: 'Iridescence', group: 'Color', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.8 },
  { id: 'turn', label: '3D turn', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'How much the flake tilts and turns in space' },
  { id: 'snow', label: 'Falling snow', group: 'Shape', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.8, hint: 'Soft snow falling behind the crystal' },
  { id: 'grain', label: 'Film grain', group: 'Color', type: 'number', min: 0, max: 0.1, step: 0.002, default: 0.018 },
];

/* ───────────────────────── growth model ───────────────────────── */

const LATTICE = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tS;
uniform float uN;
vec4 S(vec2 o) { return texture2D(tS, vUv + o / uN); }
// lattice distance (cells) from the centre of the cell at texture index offset ij
float latR(vec2 ij) { return length(vec2(ij.x + ij.y * 0.5, ij.y * 0.8660254)); }
vec2 cellIJ() { return floor(vUv * uN) - floor(uN * 0.5); }
#define NB(k) S(k == 0 ? vec2(1.0, 0.0) : k == 1 ? vec2(-1.0, 0.0) : k == 2 ? vec2(0.0, 1.0) : k == 3 ? vec2(0.0, -1.0) : k == 4 ? vec2(-1.0, 1.0) : vec2(1.0, -1.0))
`;

/** sites: r = vapour d, g = boundary water b, b = crystal mass c, a = the moment it froze (0 = not frozen) */
const INIT_FRAG = /* glsl */ `
${LATTICE}
uniform float uRho;
void main() {
  vec2 ij = cellIJ();
  float r = latR(ij);
  // a tiny hexagonal seed
  gl_FragColor = r < 1.1 ? vec4(0.0, 0.0, 1.0 + 0.2 * step(r, 0.1), 0.001) : vec4(uRho, 0.0, 0.0, 0.0);
}
`;

/** step 1: diffusion (reflecting off the crystal), then freezing on the boundary */
const DIFFUSE_FRAG = /* glsl */ `
${LATTICE}
uniform sampler2D tRad;
uniform float uRho, uKappa, uInject, uSigma, uSeed, uRmax;
float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  vec4 s = S(vec2(0.0));
  if (s.a > 0.0) { gl_FragColor = s; return; }
  vec2 ij = cellIJ();
  float r = latR(ij);
  float rad = texture2D(tRad, vec2(0.5)).r;
  // past a ring a little outside the crystal the air is a reservoir at the ambient vapour density;
  // near the edge of the grid the supply runs dry, so a finished flake stays open instead of filling in
  float supply = 1.0 - smoothstep(uRmax * 0.84, uRmax * 0.95, rad);
  if (r > min(uRmax + 6.0, rad + 28.0)) { gl_FragColor = vec4(uRho * supply, 0.0, 0.0, 0.0); return; }
  float sum = s.r;
  float nA = 0.0;
  for (int k = 0; k < 6; k++) {
    vec4 n = NB(k);
    bool att = n.a > 0.0;
    sum += att ? s.r : n.r;
    nA += att ? 1.0 : 0.0;
  }
  float d = sum / 7.0;
  d += uInject * supply;
  d *= 1.0 + uSigma * (h21(ij * 1.37 + uSeed) - 0.5) * 2.0;
  if (nA > 0.0) {
    s.g += (1.0 - uKappa) * d;
    s.b += uKappa * d;
    s.r = 0.0;
  } else s.r = d;
  gl_FragColor = s;
}
`;

/** step 2: attachment by the number of frozen neighbours, then melting on the boundary */
const ATTACH_FRAG = /* glsl */ `
${LATTICE}
uniform float uBeta, uAlpha, uTheta, uMu, uGamma, uClock, uRmax;
void main() {
  vec4 s = S(vec2(0.0));
  if (s.a > 0.0) { gl_FragColor = s; return; }
  float nA = 0.0;
  float sumd = s.r;
  for (int k = 0; k < 6; k++) {
    vec4 n = NB(k);
    nA += n.a > 0.0 ? 1.0 : 0.0;
    sumd += n.r;
  }
  if (nA < 0.5) { gl_FragColor = s; return; }
  bool att = nA > 3.5 || (nA > 2.5 ? (s.g >= 1.0 || (sumd < uTheta && s.g >= uAlpha)) : s.g >= uBeta);
  if (latR(cellIJ()) > uRmax) att = false;
  if (att) {
    s.b += s.g;
    s.g = 0.0;
    s.a = uClock;
  } else {
    float mb = uMu * s.g;
    float mc = uGamma * s.b;
    s.g -= mb;
    s.b -= mc;
    s.r += mb + mc;
  }
  gl_FragColor = s;
}
`;

/** the crystal's radius (cells), measured along the six tip directions and between them; g = eased */
const RADIUS_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tS;
uniform sampler2D tPrev;
uniform float uN, uRmax, uReset;
void main() {
  float best = 0.0;
  for (int k = 0; k < 12; k++) {
    float a = float(k) * 0.5235988;
    vec2 dir = vec2(cos(a), sin(a));
    for (int i = 1; i < 300; i++) {
      float r = float(i);
      if (r > uRmax + 2.0) break;
      vec2 p = dir * r;
      float dj = p.y / 0.8660254;
      vec2 ij = floor(vec2(p.x - dj * 0.5, dj) + 0.5);
      float att = texture2D(tS, (ij + floor(uN * 0.5) + 0.5) / uN).a;
      if (att > 0.0) best = max(best, r);
    }
  }
  vec4 prev = texture2D(tPrev, vec2(0.5));
  float eased = uReset > 0.5 ? max(best, 1.0) : mix(prev.g, best, 0.04);
  gl_FragColor = vec4(best, eased, 0.0, 1.0);
}
`;

/** display bake: r = coverage (softened over the hexagon), g = thickness, b = freshly frozen glow, a = boundary frost */
const BAKE_FRAG = /* glsl */ `
${LATTICE}
uniform float uClock;
void main() {
  vec4 s = S(vec2(0.0));
  float self = s.a > 0.0 ? 1.0 : 0.0;
  float cov = 0.0;
  float th = s.a > 0.0 ? s.b : 0.0;
  float thN = 0.0;
  float wN = 0.0;
  float fresh = s.a > 0.0 ? exp(-(uClock - s.a) * 2.5) : 0.0;
  for (int k = 0; k < 6; k++) {
    vec4 n = NB(k);
    float a = n.a > 0.0 ? 1.0 : 0.0;
    cov += a;
    thN += a * n.b;
    wN += a;
  }
  cov = self * 0.55 + cov / 6.0 * 0.45;
  if (self < 0.5 && wN > 0.0) th = thN / wN;
  gl_FragColor = vec4(cov, th, fresh, s.g);
}
`;

/* ───────────────────────── the picture ───────────────────────── */

const RENDER_FRAG = /* glsl */ `
uniform sampler2D tCur, tOld, tRadCur, tRadOld;
uniform float uN, uZoomMin;
uniform mat3 uRotCur, uRotOld;
uniform vec3 uPosCur, uPosOld;
uniform float uAlphaCur, uAlphaOld;
uniform float uCamZ, uTanHalf;
uniform vec3 uLightDir;
uniform float uBackdrop, uRelief, uIrid, uSnowAmt, uGrain, uExposure, uGlow, uFlash, uSnowT, uSparkle;
uniform vec3 cBgTop, cBgBot, cLight, cIce, cWarm;
${TONEMAP_LIB}
${SNOW_LIB}

vec3 backdrop(vec2 uv) {
  // a soft studio gradient (diagonal, with a faint glow behind the flake), or near black
  float t = clamp(uv.y * 0.8 + (1.0 - uv.x) * 0.2, 0.0, 1.0);
  vec3 g = mix(cBgBot, cBgTop, smoothstep(0.0, 1.0, t));
  float halo = exp(-dot(uv - vec2(0.5, 0.55), uv - vec2(0.5, 0.55)) * 4.0);
  g *= 0.9 + 0.25 * halo;
  vec3 blk = mix(cBgBot, cBgTop, t) * (0.6 + 0.6 * halo);
  return mix(g, blk, uBackdrop);
}

// one lattice site of the bake (ij = whole-number offsets from the centre)
vec4 site(sampler2D tex, vec2 ij) { return texture2D(tex, (ij + floor(uN * 0.5) + 0.5) / uN); }
// the flake at cell position p (cells from the centre), interpolated across the lattice triangle it
// falls in (isotropic on a hexagonal grid, so facets stay straight in every direction)
vec4 flakeAt(sampler2D tex, vec2 p) {
  float dj = p.y / 0.8660254;
  vec2 q = vec2(p.x - dj * 0.5, dj);
  if (max(abs(q.x), abs(q.y)) > uN * 0.5 - 2.0) return vec4(0.0);
  vec2 b = floor(q);
  vec2 f = q - b;
  vec4 c10 = site(tex, b + vec2(1.0, 0.0));
  vec4 c01 = site(tex, b + vec2(0.0, 1.0));
  if (f.x + f.y < 1.0) return site(tex, b) * (1.0 - f.x - f.y) + c10 * f.x + c01 * f.y;
  return site(tex, b + 1.0) * (f.x + f.y - 1.0) + c01 * (1.0 - f.x) + c10 * (1.0 - f.y);
}

// shade one flake plate; returns premultiplied colour + coverage
vec4 shadeFlake(sampler2D tex, sampler2D radTex, mat3 R, vec3 F, vec3 ro, vec3 rd, vec2 suv, float alphaK, inout float depthHit) {
  if (alphaK <= 0.001) return vec4(0.0);
  vec3 nrm = R * vec3(0.0, 0.0, 1.0);
  float den = dot(rd, nrm);
  if (abs(den) < 1e-4) return vec4(0.0);
  float t = dot(F - ro, nrm) / den;
  if (t <= 0.0) return vec4(0.0);
  vec3 hit = ro + rd * t;
  vec3 lp = transpose(R) * (hit - F);
  float rad = texture2D(radTex, vec2(0.5)).g;
  float zoom = max(rad * 1.08, uZoomMin);
  vec2 p = lp.xy * zoom;
  vec4 c = flakeAt(tex, p);
  // a few taps for thickness slope (one cell apart) and a soft edge
  float fw = max(length(vec2(dFdx(p.x), dFdy(p.x))), 0.02);
  float e = clamp(fw * 1.5, 0.2, 0.9);
  vec4 cx1 = flakeAt(tex, p + vec2(e, 0.0));
  vec4 cx0 = flakeAt(tex, p - vec2(e, 0.0));
  vec4 cy1 = flakeAt(tex, p + vec2(0.0, e));
  vec4 cy0 = flakeAt(tex, p - vec2(0.0, e));
  // a sharp, antialiased outline at any zoom
  float aw = fwidth(c.r) * 0.8 + 0.01;
  float cov = smoothstep(0.42 - aw, 0.42 + aw, c.r);
  float frost = clamp(c.a * 0.4, 0.0, 0.25) * (1.0 - cov);
  if (cov <= 0.002 && frost <= 0.002) return vec4(0.0);

  vec2 gTh = vec2(cx1.g - cx0.g, cy1.g - cy0.g) / (2.0 * e);
  vec2 gCov = vec2(cx1.r - cx0.r, cy1.r - cy0.r) / (2.0 * e);
  // thickness, softly compressed so very heavy ice doesn't turn to milk
  float th = c.g / (1.0 + 0.25 * max(c.g - 1.0, 0.0));
  // thickness → a normal in the plate's frame (relief), then into the world
  vec3 nl = normalize(vec3(-gTh * 2.2 * uRelief - gCov * 0.6, 1.0));
  vec3 nw = normalize(R * nl);
  if (dot(nw, rd) > 0.0) nw = -nw;
  vec3 v = -rd;
  float cosv = clamp(dot(nw, v), 0.0, 1.0);
  float fres = 0.04 + 0.96 * pow(1.0 - cosv, 5.0);

  // refraction: the backdrop shows through, bent by the slope and thickness, a touch cooler and darker
  vec2 off = nw.xy * (0.01 + 0.028 * th) * (0.6 + uRelief);
  vec3 behind = backdrop(suv + off);
  vec3 col = behind * mix(vec3(0.9), cIce * 1.1, 0.2 + 0.15 * clamp(th - 1.0, 0.0, 1.0));
  // body: a faint sheen that grows with thickness (on black it is most of what you see)
  col += cIce * (0.015 + 0.07 * uBackdrop) * clamp(th, 0.0, 2.5);

  // relief: slopes facing the light glow, slopes facing away fall dark (the refraction lines of a macro shot)
  vec3 L = normalize(uLightDir);
  vec2 L2 = normalize(L.xy + vec2(1e-4));
  float lit = clamp(dot(nw.xy, L2) * 3.2 * uRelief, -1.0, 1.0);
  col += cLight * max(lit, 0.0) * (0.5 + 0.25 * uBackdrop);
  col *= 1.0 - max(-lit, 0.0) * 0.6;
  vec3 H = normalize(L + v);
  float spec = pow(max(dot(nw, H), 0.0), 50.0);
  float spec2 = pow(max(dot(nw, H), 0.0), 700.0);
  col += cLight * (spec * 0.3 + spec2 * (1.5 + 5.0 * uSparkle));

  // thin-film colour on edges and steps: thickness sets the interference order
  // the outline: one cell wide when cells are tiny on screen, a crisp line a few pixels wide in macro
  float line = 1.0 - smoothstep(0.0, aw * 2.5 + 0.02, abs(c.r - 0.42));
  float edge = mix(line, clamp(length(gCov) * 1.6, 0.0, 1.0), smoothstep(0.15, 0.6, fw));
  float step_ = clamp(length(gTh) * 1.2, 0.0, 1.0);
  float order = th * 1.7 + cosv * 0.9 + dot(lp.xy, vec2(0.5, 0.35)) + lit * 0.25;
  vec3 film = 0.5 + 0.5 * cos(6.2832 * (order + vec3(0.0, 0.33, 0.67)));
  film = mix(film, mix(cIce, cWarm, smoothstep(0.3, 0.7, film.r)), 0.6);
  col += film * (edge * 1.1 + step_ * 0.55 + fres * 0.4) * uIrid * 0.7;
  // a bright line right on every edge
  col += cLight * edge * edge * (0.3 + 0.3 * uBackdrop);
  // freshly frozen ice glows for a moment: you see it building out
  col += mix(cWarm, cLight, 0.5) * c.b * uGlow * (0.7 + 0.6 * uFlash);
  // reflected sky at grazing angles
  col = mix(col, cLight * 0.9, fres * 0.3);

  float a = clamp(cov + frost, 0.0, 1.0) * alphaK;
  depthHit = t;
  // composite as glass: the plate's colour replaces what is behind by its coverage
  return vec4(col * a, a);
}

void main() {
  vec2 suv = vUv;
  vec2 ndc = suv * 2.0 - 1.0;
  vec3 ro = vec3(0.0, 0.0, uCamZ);
  vec3 rd = normalize(vec3(ndc.x * uAspect * uTanHalf, ndc.y * uTanHalf, -1.0));

  vec3 col = backdrop(suv);
  // far snow (behind the crystal), soft and out of focus
  col = snowLayers(col, suv, uSnowT, 0.0, uSnowAmt, cLight, uAspect, uFeelWind);

  float dh = 0.0;
  vec4 cur = shadeFlake(tCur, tRadCur, uRotCur, uPosCur, ro, rd, suv, uAlphaCur, dh);
  vec4 old = shadeFlake(tOld, tRadOld, uRotOld, uPosOld, ro, rd, suv, uAlphaOld, dh);
  // the departing flake flies toward the lens, so it is in front
  col = col * (1.0 - cur.a) + cur.rgb;
  col = col * (1.0 - old.a) + old.rgb;
  // near snow (in front), big soft discs
  col = snowLayers(col, suv, uSnowT, 1.0, uSnowAmt, cLight, uAspect, uFeelWind);

  // vignette and a lift on the drop
  vec2 q = suv - 0.5;
  col *= 1.0 - dot(q, q) * 0.55;
  col *= 1.0 + 0.25 * uFlash;
  vec3 outc = ntToDisplay(col, uExposure);
  outc += (hash21(gl_FragCoord.xy + fract(uTime * 7.31) * 517.0) - 0.5) * uGrain;
  gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}
`;

/* ───────────────────────── CPU side ───────────────────────── */

interface Weather {
  rho: number;
  beta: number;
  alpha: number;
  theta: number;
  kappa: number;
  mu: number;
  gamma: number;
  inject: number;
}

/** the air a flake grows in, from the song: calm and dry → plates; loud and humid → dendrites */
function weatherFor(frame: FrameContext, branching: number, gust: number, out: Weather) {
  const f = frame.feel;
  const hum = Math.min(1, Math.max(0, 0.15 + 0.55 * f.intensity + 0.35 * f.tension + 0.4 * (branching - 0.5)));
  out.rho = 0.42 + 0.25 * hum;
  // high β: tips must gather a lot of water before they freeze, so facets win (plates)
  out.beta = 2.6 - 1.25 * hum - 0.9 * gust;
  // a high α in the wet keeps the gaps between side branches from filling in: open, fern-like dendrites
  const wet = Math.min(1, Math.max(0, (hum - 0.5) / 0.5));
  out.alpha = 0.18 + 0.12 * (1 - hum) + 0.24 * wet * wet * (3 - 2 * wet);
  out.theta = 0.02 + 0.03 * (1 - hum);
  out.kappa = 0.003 + 0.02 * (1 - hum);
  out.mu = 0.02 + 0.05 * (1 - hum);
  out.gamma = 0.0001;
  out.inject = 0.0003 * hum + 0.002 * gust;
}

const N_DESK = 512;
const N_PHONE = 384;

export const crystal: SceneDef = {
  id: 'snow-crystal',
  name: 'Crystal',
  description:
    'A single snowflake crystallising live in macro, grown by a real snow-crystal model: six arms building out ring by ring. Calm parts grow faceted plates, loud parts feathery dendrites, every kick sprouts a ring of side branches and a build sends the tips racing, so each song grows its own flake. The drop releases it tumbling past the lens and a new seed starts in the middle.',
  category: 'form',
  style: 'world',
  tags: ['dreamy', 'calm', 'tender', 'cold', 'winter', 'snow', 'crystalline', 'cinematic', 'ambient', 'piano', 'minimal', 'hypnotic', 'nature', 'organic', 'realistic', 'spacious'],
  params,
  handInks: 3,
  modulations: [],
  create(init) {
    const { renderer, shared } = init;
    const N = isCoarse() ? N_PHONE : N_DESK;
    const RMAX = Math.floor(N * 0.41);
    const floatOK = renderer.extensions.has('EXT_color_buffer_float');
    const simOpts = { type: floatOK ? THREE.FloatType : THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false };
    // three sim buffers: the growing flake ping-pongs between two, the departing one keeps the third
    const sims = [0, 1, 2].map(() => makeRenderTarget(N, N, simOpts));
    let curA = 0;
    let curB = 1;
    let oldI = 2;
    const bakes = [makeRenderTarget(N, N, { type: THREE.HalfFloatType }), makeRenderTarget(N, N, { type: THREE.HalfFloatType })];
    let bakeCur = 0;
    const radOpts = { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false };
    // radius ping-pong for the current flake, plus a frozen copy for the old one
    const rads = [0, 1, 2].map(() => makeRenderTarget(1, 1, floatOK ? radOpts : { ...radOpts, type: THREE.HalfFloatType }));
    let radCur = 0;
    let radOld = 2;

    const simU = (frag: string, extra: Record<string, THREE.IUniform>) => {
      const m = new THREE.ShaderMaterial({
        uniforms: { tS: { value: null }, uN: { value: N }, ...extra },
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: frag,
        depthTest: false,
        depthWrite: false,
      });
      return { m, q: createFullscreenQuad(m) };
    };
    const initP = simU(INIT_FRAG, { uRho: { value: 0.5 } });
    const diffP = simU(DIFFUSE_FRAG, {
      tRad: { value: null },
      uRho: { value: 0.5 },
      uKappa: { value: 0.005 },
      uInject: { value: 0 },
      uSigma: { value: 0 },
      uSeed: { value: 0 },
      uRmax: { value: RMAX },
    });
    const attP = simU(ATTACH_FRAG, {
      uBeta: { value: 1.6 },
      uAlpha: { value: 0.2 },
      uTheta: { value: 0.03 },
      uMu: { value: 0.03 },
      uGamma: { value: 0.0001 },
      uClock: { value: 0 },
      uRmax: { value: RMAX },
    });
    const radP = simU(RADIUS_FRAG, { tPrev: { value: null }, uRmax: { value: RMAX }, uReset: { value: 1 } });
    const bakeP = simU(BAKE_FRAG, { uClock: { value: 0 } });

    const rotCur = new THREE.Matrix3();
    const rotOld = new THREE.Matrix3();
    const renderMat = makeMaterial({
      params,
      shared,
      vertex: /* glsl */ `void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragment: RENDER_FRAG,
      extra: {
        tCur: { value: null },
        tOld: { value: null },
        tRadCur: { value: null },
        tRadOld: { value: null },
        uN: { value: N },
        uZoomMin: { value: 16 },
        uRotCur: { value: rotCur },
        uRotOld: { value: rotOld },
        uPosCur: { value: new THREE.Vector3() },
        uPosOld: { value: new THREE.Vector3() },
        uAlphaCur: { value: 1 },
        uAlphaOld: { value: 0 },
        uCamZ: { value: 4 },
        uTanHalf: { value: Math.tan((32 * Math.PI) / 360) },
        uLightDir: { value: new THREE.Vector3(-0.5, 0.7, 0.6) },
        uBackdrop: { value: 0 },
        uRelief: { value: 1 },
        uIrid: { value: 0.8 },
        uSnowAmt: { value: 0.8 },
        uGrain: { value: 0.02 },
        uExposure: { value: 1 },
        uGlow: { value: 0.6 },
        uFlash: { value: 0 },
        uSnowT: { value: 0 },
        uSparkle: { value: 0 },
        cBgTop: { value: new THREE.Vector3() },
        cBgBot: { value: new THREE.Vector3() },
        cLight: { value: new THREE.Vector3() },
        cIce: { value: new THREE.Vector3() },
        cWarm: { value: new THREE.Vector3() },
      },
      depthTest: false,
      depthWrite: false,
    });
    const renderQuad = createFullscreenQuad(renderMat);

    const drop = new DropTimer();
    const weather: Weather = { rho: 0.5, beta: 1.6, alpha: 0.2, theta: 0.03, kappa: 0.005, mu: 0.03, gamma: 0.0001, inject: 0 };
    let clock = 0.01;
    let flakeAge = 0;
    let stepAcc = 0;
    let gust = 0;
    let spin = Math.random() * Math.PI * 2;
    let spinV = 0.05;
    let wob = 0;
    let oldAge = 99;
    let oldSpin = 0;
    let oldTumble = 0;
    let snowT = 0;
    let flash = 0;
    let lastSection = -1;
    let seed = 1;
    let needInit = true;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const oldDrift = new THREE.Vector3();
    const tmpM4 = new THREE.Matrix4();
    const eul = new THREE.Euler();

    const pass = (p: { m: THREE.ShaderMaterial; q: ReturnType<typeof createFullscreenQuad> }, src: THREE.WebGLRenderTarget | null, dst: THREE.WebGLRenderTarget) => {
      p.m.uniforms.tS.value = src ? src.texture : null;
      p.q.render(renderer, dst);
    };

    // the crystal's size, read back now and then without stalling (float targets only): a flake that
    // has reached the edge of the grid is finished, and is let go rather than left to fill in
    let radNow = 0;
    let radGen = 0;
    let radPending = false;
    let radReadT = 0;
    let fullFor = 0;
    const radBuf = new Float32Array(4);
    const readRadius = () => {
      if (!floatOK || radPending) return;
      radPending = true;
      const gen = radGen;
      renderer
        .readRenderTargetPixelsAsync(rads[radCur], 0, 0, 1, 1, radBuf)
        .then(() => {
          if (gen === radGen) radNow = radBuf[0];
        })
        .catch(() => undefined)
        .finally(() => {
          radPending = false;
        });
    };

    const startFlake = (rho: number) => {
      initP.m.uniforms.uRho.value = rho;
      pass(initP, null, sims[curA]);
      const rNext = radCur === 0 ? 1 : 0;
      radP.m.uniforms.uReset.value = 1;
      radP.m.uniforms.tPrev.value = rads[radCur].texture;
      pass(radP, sims[curA], rads[rNext]);
      radCur = rNext;
      flakeAge = 0;
      radNow = 0;
      fullFor = 0;
      radGen++;
    };

    /** the current flake leaves (tumbling past the lens) and a new seed starts */
    const release = () => {
      // the growing flake's buffer becomes the old one; its radius buffer is copied to the old slot
      const t = oldI;
      oldI = curA;
      curA = t;
      shared.blit(rads[radCur].texture, rads[radOld]);
      // re-bake the old flake once more into the spare bake so it can be drawn while the new one grows
      bakeP.m.uniforms.uClock.value = clock + 30;
      pass(bakeP, sims[oldI], bakes[1 - bakeCur]);
      oldAge = 0;
      oldSpin = spin;
      oldTumble = 0;
      oldDrift.set((rnd() - 0.5) * 1.6, (rnd() - 0.2) * 1.0, 0);
      startFlake(weather.rho);
    };

    return {
      render(frame, target) {
        const dt = stepDt(frame);
        const p = frame.params;
        const pal = frame.palette.c;
        const f = frame.feel;
        const a = frame.audio;
        drop.step(frame);
        if (needInit) {
          needInit = false;
          seed = 1 + Math.floor((frame.analysis?.duration ?? 7.3) * 1000) % 99991;
          weatherFor(frame, num(p, 'branching', 0.5), 0, weather);
          startFlake(weather.rho);
        }

        // a drop releases the flake; so does a new part once it has grown a good while
        flakeAge += dt;
        const secChanged = f.sectionIndex !== lastSection;
        lastSection = f.sectionIndex;
        radReadT += dt;
        if (radReadT > 0.75) {
          radReadT = 0;
          readRadius();
        }
        fullFor = radNow > RMAX * 0.86 ? fullFor + dt : 0;
        if (drop.since === 0 && flakeAge > 3) release();
        else if (secChanged && (flakeAge > 40 || fullFor > 0)) release();
        else if ((flakeAge > 75 || fullFor > 5) && a.beat) release();

        // the weather: kicks are short gusts of supersaturation (a ring of side branches)
        if (a.kickHit) gust = Math.max(gust, 0.35 + 0.65 * a.kick);
        gust = approach(gust, 0, 7, dt);
        const branching = num(p, 'branching', 0.5);
        weatherFor(frame, branching, gust * (0.4 + 0.6 * f.intensity), weather);

        // how many growth steps this frame: slow in the quiet, fast when it's loud and building
        const rung = quality.current();
        const cap = rung.sceneScale < 0.7 ? 8 : rung.sceneScale < 1 ? 14 : 22;
        const rate = num(p, 'growth', 1) * (0.35 + 0.9 * f.intensity + 0.8 * f.tension + 0.6 * drop.env) * (frame.audio.playing ? 1 : 0.3);
        stepAcc += rate * dt * 60 * 0.8;
        let steps = Math.min(cap, Math.floor(stepAcc));
        stepAcc = Math.min(stepAcc - steps, 4);
        const imperfect = num(p, 'imperfect', 0.25);

        const dU = diffP.m.uniforms;
        const aU = attP.m.uniforms;
        dU.uRho.value = weather.rho;
        dU.uKappa.value = weather.kappa;
        dU.uInject.value = weather.inject;
        dU.uSigma.value = 0.00025 * imperfect * imperfect;
        dU.tRad.value = rads[radCur].texture;
        aU.uBeta.value = weather.beta;
        aU.uAlpha.value = weather.alpha;
        aU.uTheta.value = weather.theta;
        aU.uMu.value = weather.mu;
        aU.uGamma.value = weather.gamma;
        while (steps-- > 0) {
          clock += 1 / 240;
          dU.uSeed.value = rnd() * 97;
          pass(diffP, sims[curA], sims[curB]);
          aU.uClock.value = clock;
          pass(attP, sims[curB], sims[curA]);
        }
        // keep the crystal's clock moving even when no step ran, so the fresh glow fades in real time
        clock += dt * 0.6;

        // measure the radius (eased) and bake the display texture
        const rNext = radCur === 0 ? 1 : 0;
        radP.m.uniforms.uReset.value = 0;
        radP.m.uniforms.tPrev.value = rads[radCur].texture;
        pass(radP, sims[curA], rads[rNext]);
        radCur = rNext;
        bakeP.m.uniforms.uClock.value = clock;
        pass(bakeP, sims[curA], bakes[bakeCur]);

        // the flake's pose: facing us, slowly turning; tilts more with the song
        const turn = num(p, 'turn', 0.5);
        spinV = approach(spinV, (0.03 + 0.12 * f.intensity + 0.25 * f.tension) * (0.4 + turn), 1.5, dt);
        spin += spinV * dt;
        wob += dt * (0.25 + 0.3 * f.intensity);
        const tiltX = turn * (0.18 + 0.25 * f.intensity) * Math.sin(wob * 0.7) + 0.08 * turn * a.sway;
        const tiltY = turn * (0.22 + 0.2 * f.intensity) * Math.sin(wob * 0.53 + 1.3);
        eul.set(tiltX, tiltY, spin);
        rotCur.setFromMatrix4(tmpM4.makeRotationFromEuler(eul));

        // the old flake tumbles off toward the lens and fades
        oldAge += dt;
        const ou = renderMat.uniforms;
        if (oldAge < 4) {
          oldTumble += dt * (1.2 + 1.5 * f.intensity);
          oldSpin += dt * 0.8;
          eul.set(oldTumble * 0.9, oldTumble * 0.55, oldSpin);
          rotOld.setFromMatrix4(tmpM4.makeRotationFromEuler(eul));
          const k = oldAge * oldAge * 0.5 + oldAge * 0.6;
          (ou.uPosOld.value as THREE.Vector3).set(oldDrift.x * k, oldDrift.y * k + 0.02, k * 1.1);
          ou.uAlphaOld.value = Math.max(0, 1 - oldAge / 3.2);
          ou.tOld.value = bakes[1 - bakeCur].texture;
          ou.tRadOld.value = rads[radOld].texture;
        } else ou.uAlphaOld.value = 0;
        // the new seed fades in (a spark)
        ou.uAlphaCur.value = Math.min(1, 0.2 + flakeAge * 0.8);

        // framing: the flake fills about 85% of the short side; on a phone held upright it sits a touch higher
        const tanHalf = Math.tan((32 * Math.PI) / 360);
        const fit = Math.min(1, frame.aspect);
        ou.uCamZ.value = 1 / (0.82 * tanHalf * fit);
        ou.uTanHalf.value = tanHalf;
        (ou.uPosCur.value as THREE.Vector3).set(0, frame.aspect < 1 ? 0.12 : 0.04, 0);
        // the light comes from the shared sky
        const la = f.light;
        (ou.uLightDir.value as THREE.Vector3).set(Math.cos(la) * 0.7, 0.55 + Math.sin(la) * 0.35, 0.75);

        snowT += dt * (0.4 + 0.5 * f.intensity + 0.8 * f.gust);
        flash = Math.max(flash * Math.exp(-dt * 3), drop.since < 0.05 ? 1 : 0);

        syncMaterial(renderMat, frame, params);
        ou.tCur.value = bakes[bakeCur].texture;
        ou.tRadCur.value = rads[radCur].texture;
        ou.uBackdrop.value = str(p, 'backdrop', 'gradient') === 'black' ? 1 : 0;
        ou.uRelief.value = num(p, 'relief', 1);
        ou.uIrid.value = num(p, 'iridescence', 0.8) * (0.8 + 0.4 * f.warmth);
        ou.uSnowAmt.value = num(p, 'snow', 0.8);
        ou.uGrain.value = num(p, 'grain', 0.018);
        ou.uExposure.value = 1.0 + 0.15 * f.intensity;
        ou.uGlow.value = 0.45 + 0.3 * f.intensity;
        ou.uFlash.value = flash;
        ou.uSnowT.value = snowT;
        ou.uSparkle.value = a.hat * 0.8 + a.snare * 0.4;
        linColor(pal.bg, ou.cBgTop.value as THREE.Vector3);
        linColor(pal.muted, ou.cBgBot.value as THREE.Vector3);
        linColor(pal.fg, ou.cLight.value as THREE.Vector3);
        linColor(pal.accent, ou.cIce.value as THREE.Vector3);
        linColor(pal.accent2, ou.cWarm.value as THREE.Vector3);
        renderQuad.render(renderer, target);
      },
      dispose() {
        for (const s of sims) s.dispose();
        for (const b of bakes) b.dispose();
        for (const r of rads) r.dispose();
        for (const x of [initP, diffP, attP, radP, bakeP]) {
          x.m.dispose();
          x.q.dispose();
        }
        renderMat.dispose();
        renderQuad.dispose();
      },
    };
  },
};
