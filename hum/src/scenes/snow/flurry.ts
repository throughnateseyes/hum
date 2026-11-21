import * as THREE from 'three';
import type { ParamDef, SceneDef } from '../../core/types';
import { num } from '../../core/uniforms';
import { quality } from '../../render/quality';
import { DropTimer } from '../nature/volume';
import { BACKDROP_VERT, approach, makeBackdrop, makeMaterial, stepDt, syncMaterial } from '../three/common';
import { FLAKE_LIB, isCoarse } from './common';

/**
 * Flurry: thousands of snowflakes tumbling in 3D, every one a crystal.
 *
 *   - the designs are grown procedurally (FLAKE_LIB) into an atlas of 64 at a time, from sectored
 *     plates to fern dendrites; the atlas is re-grown through the song (a row a frame, then a cross
 *     fade), and the song's weather picks the kinds: plates in calm parts, big dendrites when it's
 *     loud. A flake gets a new design every time it comes round again, so nothing repeats for long
 *   - each flake is a real oriented plate tumbling on its own axis: it foreshortens, turns edge on,
 *     and flashes when its face catches the light, with a thin-film colour in the glint
 *   - depth of field: flakes away from the focus soften into hexagonal bokeh. In the quiet the focus
 *     is a macro: one hero crystal, drawn exactly (no atlas), slowly turning close to the lens with
 *     the rest of the snow a blur behind it. As the song grows the hero steps back, the focus pulls
 *     out and the camera flies forward through the fall
 *   - a build hangs the snow in the air and draws it in; the drop lets go: a gust, and the flakes
 *     whirl round the lens in a vortex. Kicks set a scatter of flakes flashing, hats sparkle
 *
 * Palette roles: bg = night sky (top), muted = the glow low down, fg = snow, accent = the cold
 * light in the glints, accent2 = the warm light (distant lamps, the other side of the glint).
 */

const params: ParamDef[] = [
  { id: 'amount', label: 'Snow', group: 'Shape', type: 'number', min: 0.2, max: 1.5, step: 0.01, default: 1, hint: 'How many flakes at full song' },
  { id: 'size', label: 'Flake size', group: 'Shape', type: 'number', min: 0.5, max: 2, step: 0.01, default: 1 },
  { id: 'hero', label: 'Hero crystal', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 1, hint: 'One crystal in macro during the quiet' },
  { id: 'speed', label: 'Flight', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'How fast the camera flies through the snow' },
  { id: 'tumble', label: 'Tumble', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
  { id: 'vortex', label: 'Drop vortex', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'The drop whirls the flakes round the lens' },
  { id: 'focus', label: 'Depth of field', group: 'Color', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1 },
  { id: 'glints', label: 'Glints', group: 'Color', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'Flakes flash as they turn to the light' },
  { id: 'lights', label: 'Distant lights', group: 'Color', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.7 },
];

const CELLS = 8;
/** the kinds that hold up in macro: plate with branched arms, stellar dendrite, fern, sectored plate, stellar plate */
const HERO_TYPES = [4, 2, 5, 4, 1, 2, 0]; // atlas is CELLS × CELLS designs

const ATLAS_FRAG = /* glsl */ `
uniform float uGen, uBias, uCellPx;
${FLAKE_LIB}
void main() {
  vec2 cell = floor(vUv * ${CELLS}.0);
  vec2 lp = (fract(vUv * ${CELLS}.0) * 2.0 - 1.0) * 1.08;
  float sd = cell.y * ${CELLS}.0 + cell.x + uGen * 64.0;
  // the weather picks the kinds, with some spread
  float bias = clamp(uBias + (hash11(sd * 3.1) - 0.5) * 0.5, 0.0, 1.0);
  vec2 f = flakeSDF(lp, sd, bias, -1.0);
  float px = 2.16 / uCellPx;
  float cov = smoothstep(px, -px, f.x);
  float h = clamp(-f.x * 22.0, 0.0, 1.0) * 0.45 + f.y * 0.55;
  float edge = 1.0 - smoothstep(0.0, 2.2 * px, abs(f.x));
  gl_FragColor = vec4(cov, h * cov, edge, 1.0);
}
`;

const FLAKE_VERT = /* glsl */ `
attribute vec4 aSeed;
attribute vec4 aSpin;
attribute vec3 aSize;
uniform vec3 uBox, uDrift;
uniform float uSpinT, uSwirl, uPull, uFocus, uAperture, uFlutterT, uDensity, uSizeK, uKickSeed, uKickK, uHatK;
varying vec2 vLocal;
varying float vCell, vCoc, vFade, vGrow, vFlash, vSpark, vSide;
varying vec3 vN;
mat3 axisAngle(vec3 a, float an) {
  float c = cos(an), s = sin(an), t = 1.0 - c;
  return mat3(t * a.x * a.x + c, t * a.x * a.y + s * a.z, t * a.x * a.z - s * a.y,
              t * a.x * a.y - s * a.z, t * a.y * a.y + c, t * a.y * a.z + s * a.x,
              t * a.x * a.z + s * a.y, t * a.y * a.z - s * a.x, t * a.z * a.z + c);
}
void main() {
  float rank = aSize.z;
  float vis = clamp((uDensity - rank) * 12.0, 0.0, 1.0);
  vec3 p = aSeed.xyz * uBox + vec3(uDrift.x, -uDrift.y, uDrift.z) * (0.75 + 0.5 * aSpin.w);
  p.x += sin(uFlutterT * (0.6 + aSpin.w) + aSize.y * 6.28) * 0.12;
  p.y += cos(uFlutterT * (0.5 + aSpin.w * 0.7) + aSize.y * 4.0) * 0.06;
  vec3 wrapN = floor(p / uBox);
  p -= wrapN * uBox;
  p -= vec3(uBox.x * 0.5, uBox.y * 0.5, uBox.z - 0.6);
  float wraps = wrapN.x * 3.0 + wrapN.y * 7.0 + wrapN.z * 13.0;
  // the vortex round the lens, and a build drawing the snow in
  float rr = length(p.xy);
  p.xy = rot2(uSwirl * 1.5 / (0.45 + rr)) * p.xy * (1.0 - uPull * 0.3);
  // tumbling on its own axis
  vec3 ax = normalize(aSpin.xyz - 0.5 + vec3(0.0, 0.0, 1e-3));
  mat3 R = axisAngle(ax, uSpinT * (0.35 + aSpin.w * 1.5) + aSeed.w * 6.2832);
  float depthGuess = max(0.05, -(viewMatrix * vec4(p, 1.0)).z);
  float coc = uAperture * abs(depthGuess - uFocus) / depthGuess;
  vGrow = 1.0 + min(coc, 6.0) * 0.22;
  float size = aSize.x * uSizeK * vis;
  vec3 corner = R * vec3(position.xy * size * vGrow, 0.0);
  vec4 mv = viewMatrix * vec4(p + corner, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = -mv.z;
  vCoc = coc;
  vFade = smoothstep(0.08, 0.6, depth) * (1.0 - smoothstep(uBox.z * 0.7, uBox.z - 0.7, depth));
  vLocal = position.xy;
  vCell = floor(fract(aSeed.w * 13.71 + wraps * 0.618034) * 64.0);
  vN = normalize(mat3(viewMatrix) * (R * vec3(0.0, 0.0, 1.0)));
  vSide = sign(vN.z);
  // a kick sets a random scatter of flakes flashing; hats sparkle the small ones
  float pick = fract(aSeed.w * 91.7 + uKickSeed);
  vFlash = uKickK * step(pick, 0.18);
  vSpark = uHatK * step(fract(aSeed.w * 53.3 + uKickSeed * 1.7), 0.12);
}
`;

const FLAKE_FRAG = /* glsl */ `
uniform sampler2D uAtlasA, uAtlasB;
uniform float uMix, uGlints;
uniform vec3 uLightDir, cSnow, cCold, cWarm;
varying vec2 vLocal;
varying float vCell, vCoc, vFade, vGrow, vFlash, vSpark, vSide;
varying vec3 vN;
void main() {
  vec2 lp = vLocal * vGrow;
  vec2 cell = vec2(mod(vCell, ${CELLS}.0), floor(vCell / ${CELLS}.0));
  float inside = step(max(abs(lp.x), abs(lp.y)), 1.06);
  vec2 uv = (cell + 0.5 + clamp(lp, -1.06, 1.06) / 1.08 * 0.5) / ${CELLS}.0;
  float bias = clamp(vCoc * 1.4, 0.0, 4.0);
  vec4 t = texture2D(uAtlasA, uv, bias);
  if (uMix < 0.999) t = mix(texture2D(uAtlasB, uv, bias), t, uMix);
  t *= inside;
  // far out of focus: a soft hexagonal disc instead of the shape
  vec2 ad = abs(lp);
  float hx = max(ad.x * 0.866 + ad.y * 0.5, ad.y);
  float disc = 1.0 - smoothstep(0.45, 0.6 + 0.12 * vCoc, hx / vGrow * 1.0);
  float k = smoothstep(1.2, 3.5, vCoc);
  float cov = mix(t.r, disc * 0.35, k);
  float h = mix(t.g, disc * 0.2, k);
  // light: the face toward the light glints (both faces of a thin plate)
  vec3 N = vN * vSide;
  vec3 L = normalize(uLightDir);
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float nh = abs(dot(vN, H));
  float glint = pow(nh, 28.0) * uGlints;
  float film = 0.5 + 0.5 * cos(6.2832 * (nh * 2.5 + vec3(0.0, 0.33, 0.67)).x);
  vec3 filmC = mix(cCold, cWarm, film);
  vec3 col = cSnow * (0.32 + 0.68 * h) * cov;
  col += cSnow * t.b * 0.35 * (1.0 - k);
  col += mix(cSnow, filmC, 0.6) * (glint * 2.2 + vFlash * 1.6 + vSpark * 2.5) * (cov * 0.7 + t.b * 0.6);
  // light spreads as it blurs (the same light over a bigger disc)
  col *= vFade / (1.0 + vCoc * vCoc * 0.18);
  gl_FragColor = vec4(col, 1.0);
}
`;

const HERO_VERT = /* glsl */ `
varying vec2 vLocal;
varying vec3 vNrm;
void main() {
  vLocal = position.xy;
  vNrm = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const HERO_FRAG = /* glsl */ `
uniform float uSeed, uType, uAlpha, uGlints, uFlash;
uniform vec3 uLightDir, cSnow, cCold, cWarm;
varying vec2 vLocal;
varying vec3 vNrm;
${FLAKE_LIB}
void main() {
  vec2 lp = vLocal * 1.06;
  vec2 f = flakeSDF(lp, uSeed, 0.5, uType);
  // seen this close the crystal needs a little more body
  f.x -= 0.008;
  float px = max(fwidth(f.x), 1e-4);
  float cov = smoothstep(px, -px, f.x);
  float edge = 1.0 - smoothstep(0.0, 2.0 * px, abs(f.x));
  if (cov + edge < 0.002) discard;
  float h = clamp(-f.x * 22.0, 0.0, 1.0) * 0.45 + f.y * 0.55;
  // relief from the height's slope (screen space), tipped by the plate's own turn
  vec2 g = vec2(dFdx(h), dFdy(h)) / max(px * 40.0, 1e-3);
  vec3 N = normalize(vNrm + vec3(-g * 0.6, 0.0));
  vec3 L = normalize(uLightDir);
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float nh = abs(dot(N, H));
  float lit = clamp(dot(-g, normalize(L.xy)) * 0.8, -1.0, 1.0);
  float order = h * 1.8 + nh * 1.2 + length(lp) * 0.6;
  vec3 film = 0.5 + 0.5 * cos(6.2832 * (order + vec3(0.0, 0.33, 0.67)));
  film = mix(film, mix(cCold, cWarm, smoothstep(0.3, 0.7, film.r)), 0.55);
  vec3 col = cSnow * (0.12 + 0.45 * h + 0.3 * max(lit, 0.0)) * cov;
  col += mix(cSnow, film, 0.55) * edge * 0.7;
  col += film * f.y * cov * 0.22;
  col += mix(cSnow, film, 0.4) * (pow(nh, 40.0) * 1.2 * uGlints + uFlash * 0.4) * (cov * 0.6 + edge);
  gl_FragColor = vec4(col * uAlpha, 1.0);
}
`;

const BACK_FRAG = /* glsl */ `
uniform vec3 cTop, cLow, cWarm, cCold;
uniform float uLights, uExposure, uTimeL;
void main() {
  vec2 uv = vUv;
  vec3 col = mix(cLow, cTop, smoothstep(0.0, 0.95, uv.y));
  col *= 0.75 + 0.35 * exp(-pow((uv.y - 0.3) * 2.4, 2.0));
  // distant lights, far out of focus, mostly up and to the sides (the middle stays calm for the words)
  vec2 p = vec2(uv.x * uAspect, uv.y);
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    vec2 c = vec2(hash11(fi * 3.1 + 0.2) * uAspect, 0.35 + 0.7 * hash11(fi * 7.7 + 1.0));
    c.x += sin(uTimeL * 0.05 + fi) * 0.04;
    float r = 0.06 + 0.1 * hash11(fi * 5.3);
    float d = length(p - c) / r;
    float o = (1.0 - smoothstep(0.75, 1.0, d)) * (0.75 + 0.25 * smoothstep(0.5, 0.95, d));
    float side = smoothstep(0.15, 0.4, abs(uv.x - 0.5)) * 0.7 + 0.3;
    col += mix(cWarm, cCold, step(0.6, hash11(fi * 9.1))) * o * 0.06 * uLights * side;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export const flurry: SceneDef = {
  id: 'snow-flurry',
  name: 'Flurry',
  description:
    'Thousands of unique snowflakes tumbling in 3D, each a different crystal that flashes as it turns to the light, with real depth of field. The quiet is one crystal slowly turning in macro with the snow a blur behind it; as the song grows the camera flies forward through the fall, a build hangs the snow in the air, and the drop whirls it round the lens in a vortex. Calm parts fall as plates, loud parts as big dendrites.',
  category: 'form',
  style: 'particles',
  tags: ['dreamy', 'cinematic', 'cold', 'winter', 'snow', 'crystalline', 'hypnotic', 'spacious', 'euphoric', 'tender', 'ambient', 'electronic', 'piano', 'nature', 'magical'],
  params,
  handInks: 3,
  modulations: [],
  create(init) {
    const { renderer, shared } = init;
    const coarse = isCoarse();
    const N = coarse ? 700 : 1600;
    const ATLAS = coarse ? 1024 : 2048;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, init.width / Math.max(1, init.height), 0.05, 40);
    camera.position.set(0, 0, 0);

    // atlas pair: the new designs grow into one while the other still shows
    const atlasOpts = {
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      depthBuffer: false,
    };
    const atlases = [new THREE.WebGLRenderTarget(ATLAS, ATLAS, atlasOpts), new THREE.WebGLRenderTarget(ATLAS, ATLAS, atlasOpts)];
    for (const a of atlases) a.texture.colorSpace = THREE.NoColorSpace;
    let atlasNew = 0;
    let genRow = -1; // row being grown (−1 = idle)
    let gen = 0;
    let mix = 1;
    const genMat = makeMaterial({
      params,
      shared,
      vertex: BACKDROP_VERT,
      fragment: ATLAS_FRAG,
      extra: { uGen: { value: 0 }, uBias: { value: 0.5 }, uCellPx: { value: ATLAS / CELLS } },
      depthTest: false,
      depthWrite: false,
    });
    const genScene = new THREE.Scene();
    const genQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), genMat);
    genQuad.frustumCulled = false;
    genScene.add(genQuad);
    const genCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const growRow = (row: number, all = false) => {
      const rt = atlases[atlasNew];
      const h = ATLAS / CELLS;
      rt.scissor.set(0, all ? 0 : row * h, ATLAS, all ? ATLAS : h);
      rt.scissorTest = true;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      if (all || row === 0) {
        renderer.setClearColor(0x000000, 1);
      }
      renderer.render(genScene, genCam);
      renderer.setRenderTarget(prev);
      rt.scissorTest = false;
    };

    // flakes
    const quad = new THREE.PlaneGeometry(2, 2);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    const seedA = new Float32Array(N * 4);
    const spinA = new Float32Array(N * 4);
    const sizeA = new Float32Array(N * 3);
    let s = 7;
    const rnd = () => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };
    for (let i = 0; i < N; i++) {
      seedA.set([rnd(), rnd(), rnd(), rnd()], i * 4);
      spinA.set([rnd(), rnd(), rnd(), rnd()], i * 4);
      // mostly small, a few big ones
      const sz = 0.026 + 0.085 * Math.pow(rnd(), 2.2);
      sizeA.set([sz, rnd(), i / N], i * 3);
    }
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seedA, 4));
    geo.setAttribute('aSpin', new THREE.InstancedBufferAttribute(spinA, 4));
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizeA, 3));
    geo.instanceCount = N;
    const flakeMat = makeMaterial({
      params,
      shared,
      vertex: FLAKE_VERT,
      fragment: FLAKE_FRAG,
      extra: {
        uBox: { value: new THREE.Vector3(5, 4, 10) },
        uDrift: { value: new THREE.Vector3() },
        uSpinT: { value: 0 },
        uSwirl: { value: 0 },
        uPull: { value: 0 },
        uFocus: { value: 2 },
        uAperture: { value: 1 },
        uFlutterT: { value: 0 },
        uDensity: { value: 1 },
        uSizeK: { value: 1 },
        uKickSeed: { value: 0 },
        uKickK: { value: 0 },
        uHatK: { value: 0 },
        uAtlasA: { value: atlases[0].texture },
        uAtlasB: { value: atlases[1].texture },
        uMix: { value: 1 },
        uGlints: { value: 1 },
        uLightDir: { value: new THREE.Vector3(-0.5, 0.6, 0.6) },
        cSnow: { value: new THREE.Vector3(1, 1, 1) },
        cCold: { value: new THREE.Vector3() },
        cWarm: { value: new THREE.Vector3() },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    const flakes = new THREE.Mesh(geo, flakeMat);
    flakes.frustumCulled = false;
    scene.add(flakes);

    // the hero crystal
    const heroMat = makeMaterial({
      params,
      shared,
      vertex: HERO_VERT,
      fragment: HERO_FRAG,
      extra: {
        uSeed: { value: 3 },
        uType: { value: 2 },
        uAlpha: { value: 1 },
        uGlints: { value: 1 },
        uFlash: { value: 0 },
        uLightDir: flakeMat.uniforms.uLightDir,
        cSnow: flakeMat.uniforms.cSnow,
        cCold: flakeMat.uniforms.cCold,
        cWarm: flakeMat.uniforms.cWarm,
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const hero = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), heroMat);
    hero.frustumCulled = false;
    hero.renderOrder = 2;
    scene.add(hero);

    const backMat = makeMaterial({
      params,
      shared,
      vertex: BACKDROP_VERT,
      fragment: BACK_FRAG,
      extra: {
        cTop: { value: new THREE.Vector3() },
        cLow: { value: new THREE.Vector3() },
        cWarm: flakeMat.uniforms.cWarm,
        cCold: flakeMat.uniforms.cCold,
        uLights: { value: 0.7 },
        uExposure: { value: 1 },
        uTimeL: { value: 0 },
      },
    });
    const back = makeBackdrop(backMat);
    scene.add(back);

    const drop = new DropTimer();
    const drift = flakeMat.uniforms.uDrift.value as THREE.Vector3;
    let travelV = 0.3;
    let fallV = 0.25;
    let swirl = 0;
    let swirlV = 0;
    let spinT = 0;
    let flutterT = 0;
    let focus = 1.8;
    let aperture = 1.6;
    let heroVis = 1;
    let heroYaw = 0.4;
    let heroFly = 99;
    let heroSeed = 7;
    let flash = 0;
    let kick = 0;
    let sinceGen = 0;
    let lastSection = -2;
    let started = false;
    let timeL = 0;
    const tmpC = new THREE.Color();

    const startGen = (bias: number) => {
      atlasNew = 1 - atlasNew;
      gen++;
      genMat.uniforms.uGen.value = gen + Math.floor(rnd() * 1000);
      genMat.uniforms.uBias.value = bias;
      genRow = 0;
      sinceGen = 0;
    };

    return {
      render(frame, target) {
        const dt = stepDt(frame);
        const p = frame.params;
        const f = frame.feel;
        const a = frame.audio;
        const pal = frame.palette.c;
        drop.step(frame);
        const I = f.intensity;
        const T = f.tension;

        // grow the first atlas whole, then re-grow it through the song a row a frame
        const bias = Math.min(1, Math.max(0, 0.15 + 0.75 * I + 0.25 * T));
        syncMaterial(genMat, frame, params);
        if (!started) {
          // the first set grows whole into both buffers
          started = true;
          genMat.uniforms.uGen.value = 1;
          genMat.uniforms.uBias.value = bias;
          atlasNew = 1;
          growRow(0, true);
          atlasNew = 0;
          growRow(0, true);
          mix = 1;
        }
        sinceGen += dt;
        const sec = f.sectionIndex;
        if (genRow < 0 && mix >= 1 && ((sec !== lastSection && sinceGen > 6) || sinceGen > 24)) startGen(bias);
        lastSection = sec;
        if (genRow >= 0) {
          growRow(genRow);
          genRow++;
          if (genRow >= CELLS) {
            genRow = -1;
            mix = 0;
          }
        }
        if (genRow < 0 && mix < 1) mix = Math.min(1, mix + dt / 2.0);
        const fu = flakeMat.uniforms;
        fu.uAtlasA.value = atlases[atlasNew].texture;
        fu.uAtlasB.value = atlases[1 - atlasNew].texture;
        fu.uMix.value = genRow >= 0 ? 0 : mix;

        // motion: the camera flies forward with the song; a build hangs the snow, the drop lets it go
        const sp = num(p, 'speed', 1);
        const hang = 1 - 0.75 * T;
        const gustK = drop.env;
        travelV = approach(travelV, sp * (0.15 + 1.5 * I * I + 4.5 * gustK) * hang * (a.playing ? 1 : 0.3), 2.5, dt);
        fallV = approach(fallV, (0.18 + 0.35 * I) * hang + 0.6 * gustK, 2, dt);
        drift.z += travelV * dt;
        drift.y += fallV * dt;
        drift.x += f.windX * (0.1 + 0.9 * f.gust) * dt;
        if (drop.since === 0) swirlV += 3.2 * num(p, 'vortex', 1);
        swirlV = approach(swirlV, 0.08 * I * num(p, 'vortex', 1), 0.9, dt);
        swirl += swirlV * dt;
        spinT += dt * num(p, 'tumble', 1) * (0.5 + 0.8 * I + 1.5 * gustK) * hang;
        flutterT += dt * (0.6 + 0.6 * I);
        fu.uSwirl.value = swirl;
        fu.uPull.value = T;
        fu.uSpinT.value = spinT;
        fu.uFlutterT.value = flutterT;

        // focus: a macro on the hero in the quiet, pulled out as the song grows
        const loud = THREE.MathUtils.smoothstep(I, 0.25, 0.65);
        const dof = num(p, 'focus', 1);
        focus = approach(focus, 1.75 + 2.6 * loud, 1.2, dt);
        aperture = approach(aperture, (0.5 + 1.1 * (1 - loud)) * dof, 1.2, dt);
        fu.uFocus.value = focus;
        fu.uAperture.value = aperture;
        const rung = quality.current();
        const amt = num(p, 'amount', 1) * (rung.sceneScale < 0.7 ? 0.55 : 1);
        const dens = Math.min(1, amt * (0.3 + 0.7 * THREE.MathUtils.smoothstep(I, 0.1, 0.75) + 0.3 * gustK));
        fu.uDensity.value = dens;
        geo.instanceCount = Math.min(N, Math.ceil(N * Math.min(1, dens + 0.1)));
        fu.uSizeK.value = num(p, 'size', 1);
        if (a.kickHit) {
          fu.uKickSeed.value = rnd();
          kick = 1;
        }
        kick = approach(kick, 0, 6, dt);
        fu.uKickK.value = kick * (0.4 + 0.6 * I);
        fu.uHatK.value = a.hat;
        fu.uGlints.value = num(p, 'glints', 1) * (0.7 + 0.6 * I);

        // the light comes from the shared sky, low and to one side
        const la = f.light;
        (fu.uLightDir.value as THREE.Vector3).set(Math.cos(la) * 0.8, 0.45 + 0.4 * Math.sin(la), 0.7);

        // the hero: close in the quiet, slowly turning in space; the drop flings it past the lens
        const heroK = num(p, 'hero', 1);
        if (drop.since === 0 && heroVis > 0.2) heroFly = 0;
        heroFly += dt;
        const want = heroK * (1 - loud) * (heroFly > 6 ? 1 : 0);
        if (heroVis < 0.02 && want > 0.5) {
          heroSeed = 7 + Math.floor(rnd() * 9000);
        }
        heroVis = approach(heroVis, want, want > heroVis ? 0.5 : 1.2, dt);
        heroYaw += dt * (0.18 + 0.4 * I + 0.6 * T);
        const fly = heroFly < 3 ? heroFly : 0;
        hero.visible = heroVis > 0.004 || fly > 0;
        hero.position.set(0.25 * Math.sin(heroYaw * 0.3), (frame.aspect < 1 ? 0.22 : 0.08) + 0.04 * Math.sin(heroYaw * 0.5), -1.85 + fly * fly * 1.2);
        // it turns in space (never quite edge on, where a thin plate vanishes) and spins on its axis
        hero.rotation.set(0.4 * Math.sin(heroYaw * 0.6) + fly * 2.5, 0.85 * Math.sin(heroYaw * 0.45), heroYaw * 0.5 + fly);
        const hs = (frame.aspect < 1 ? 0.55 : 0.68) * (1 + 0.04 * f.release);
        hero.scale.setScalar(hs);
        const hu = heroMat.uniforms;
        hu.uSeed.value = heroSeed;
        hu.uType.value = HERO_TYPES[heroSeed % HERO_TYPES.length];
        hu.uAlpha.value = fly > 0 ? Math.max(0, 1 - fly / 1.6) : heroVis;
        hu.uGlints.value = num(p, 'glints', 1);
        flash = Math.max(flash * Math.exp(-dt * 4), kick * 0.3);
        hu.uFlash.value = flash;

        // a slow drift of the camera itself
        camera.rotation.set(0.04 * Math.sin(flutterT * 0.21), 0.05 * Math.sin(flutterT * 0.17) + 0.15 * swirlV * 0.1, 0.03 * Math.sin(flutterT * 0.13) + swirl * 0.02);

        // colours (linear)
        // colours: the backdrop is drawn straight in display values, so the snow adds onto it in the same
        (fu.cSnow.value as THREE.Vector3).set(pal.fg.r, pal.fg.g, pal.fg.b).multiplyScalar(0.85 + 0.3 * I);
        (fu.cCold.value as THREE.Vector3).set(pal.accent.r, pal.accent.g, pal.accent.b);
        (fu.cWarm.value as THREE.Vector3).set(pal.accent2.r, pal.accent2.g, pal.accent2.b);
        tmpC.copy(pal.bg);
        (backMat.uniforms.cTop.value as THREE.Vector3).set(tmpC.r, tmpC.g, tmpC.b);
        tmpC.copy(pal.muted);
        (backMat.uniforms.cLow.value as THREE.Vector3).set(tmpC.r, tmpC.g, tmpC.b);
        timeL += dt;
        backMat.uniforms.uTimeL.value = timeL;
        backMat.uniforms.uLights.value = num(p, 'lights', 0.7) * (1.0 + 0.6 * I);

        syncMaterial(flakeMat, frame, params);
        syncMaterial(heroMat, frame, params);
        syncMaterial(backMat, frame, params);
        if (Math.abs(camera.aspect - frame.aspect) > 1e-4) {
          camera.aspect = frame.aspect;
          camera.updateProjectionMatrix();
        }
        // a phone held upright sees less across: widen the box so the sides aren't empty
        (fu.uBox.value as THREE.Vector3).set(frame.aspect < 1 ? 3.6 : 5.5, frame.aspect < 1 ? 5.5 : 3.8, 10);
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
      },
      dispose() {
        for (const at of atlases) at.dispose();
        genMat.dispose();
        genQuad.geometry.dispose();
        quad.dispose();
        geo.dispose();
        flakeMat.dispose();
        heroMat.dispose();
        hero.geometry.dispose();
        backMat.dispose();
        back.geometry.dispose();
      },
    };
  },
};
