import * as THREE from 'three';
import type { ParamDef, SceneDef } from '../../core/types';
import { num, str } from '../../core/uniforms';
import { quality } from '../../render/quality';
import { DropTimer } from '../nature/volume';
import { BACKDROP_VERT, approach, makeBackdrop, makeMaterial, stepDt, syncMaterial } from '../three/common';
import { isCoarse } from './common';

/**
 * Snowfall: walking down a snowy street at night (or a road through the woods at dusk) while it snows.
 *
 *   - a small 3D world: a snow-covered road with tyre tracks, bare trees with snow along the tops of
 *     their branches and snow-laden pines (drawn once on a canvas, stood up as cards), a row of street
 *     lamps; fog that thickens when the snow gets heavy
 *   - thousands of flakes in 3D falling on the shared wind; every flake is lit by the lamps it passes,
 *     so the snow glows in the cones of light and goes dark between them, with soft bokeh close to
 *     the lens. Lamps light the snow on the branches and pool on the road
 *   - the song is the weather: the quiet is a few big lazy flakes in still air and one lamp on; the
 *     lamps come on one per beat down the street as the verse starts; a build picks up the wind and
 *     the snow streams sideways; the drop is a gust, a white-out and every lamp flaring; a breakdown
 *     goes still, the flakes hang in the air. The walk quickens with the song
 *
 * Palette roles: bg = night sky, muted = fog and the glow on the horizon, fg = snow, accent = lamp
 * light, accent2 = the cold sky light on the snow (and the dusk glow in the woods).
 */

const params: ParamDef[] = [
  {
    id: 'setting',
    label: 'Setting',
    group: 'Shape',
    type: 'select',
    default: 'street',
    options: [
      { value: 'street', label: 'Night street' },
      { value: 'woods', label: 'Woods at dusk' },
    ],
  },
  { id: 'snow', label: 'Snowfall', group: 'Shape', type: 'number', min: 0.2, max: 1.6, step: 0.01, default: 1, hint: 'How heavy the snow gets at full song' },
  { id: 'flake', label: 'Flake size', group: 'Shape', type: 'number', min: 0.5, max: 2, step: 0.01, default: 1 },
  { id: 'wind', label: 'Wind', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'Gusts on the builds, stillness in the breaks' },
  { id: 'walk', label: 'Walk', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
  { id: 'lamps', label: 'Lamp light', group: 'Color', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
  { id: 'fog', label: 'Fog', group: 'Color', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
  { id: 'focus', label: 'Bokeh', group: 'Color', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Flakes close to the lens soften into discs of light' },
];

const LAMP_SP = 13; // m between lamps on one side
const LAMP_H = 4.3;
const NL = 9; // lamps drawn per side
const TREE_LEN = 96; // trees repeat every this many metres
/** a number as a GLSL float literal */
const F = (v: number) => v.toFixed(3);

/** lamps, light and fog, shared by every part of the world */
const WORLD_LIB = /* glsl */ `
uniform float uWalk, uLampReach, uLampK, uLampsOn, uFogK, uFlare;
uniform vec3 cLamp, cFog, cSky, cSnow, cCold, cWood;
float sfLampOn(float ahead) {
  return uLampsOn * smoothstep(uLampReach + 1.0, uLampReach - 1.0, ahead);
}
float sfLampZ0(float side) { return mod(uWalk, ${F(LAMP_SP)}) - (side > 0.0 ? 0.0 : ${F(LAMP_SP / 2)}); }
// light from the two nearest lamps on each side of the road
vec3 sfLampLight(vec3 wp, float spread) {
  if (uLampsOn <= 0.0) return vec3(0.0);
  float acc = 0.0;
  for (int s = 0; s < 2; s++) {
    float side = s == 0 ? 1.0 : -1.0;
    float zo = sfLampZ0(side);
    float k0 = floor((zo - wp.z) / ${F(LAMP_SP)});
    for (int j = 0; j < 2; j++) {
      float k = k0 + float(j);
      vec3 L = vec3(side > 0.0 ? 3.45 : -3.75, ${F(LAMP_H)} - 0.1, zo - k * ${F(LAMP_SP)});
      vec3 v = L - wp;
      float d2 = dot(v, v);
      float down = v.y / sqrt(d2 + 1e-4);
      float cone = mix(0.12, 1.0, smoothstep(0.45, 0.85, down));
      acc += sfLampOn(-L.z) * mix(cone, 1.0, spread) * (1.0 / (1.0 + d2 * 0.15) + 0.05 / (1.0 + d2 * 0.05));
    }
  }
  return cLamp * acc * uLampK * (1.0 + uFlare);
}
vec3 sfFog(vec3 col, float depth) {
  return mix(col, cFog, 1.0 - exp(-depth * uFogK));
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 cTop, cHor, cGlow;
uniform float uWoods, uGlowK, uHaze;
void main() {
  vec2 uv = vUv;
  float hor = 0.53;
  float t = smoothstep(hor - 0.05, 1.0, uv.y);
  vec3 col = mix(cHor, cTop, pow(t, 0.6));
  // the glow at the end of the road: city light at night, the last of the day in the woods
  vec2 g = (uv - vec2(0.5, hor + 0.02)) * vec2(uAspect, 1.0);
  col += cGlow * exp(-dot(g, g) * mix(9.0, 4.0, uWoods)) * uGlowK;
  // snow haze in the air: slow streaks of falling snow far away
  float n = tnoise(vec2(uv.x * 40.0, uv.y * 7.0 + uTime * 0.6)) * tnoise(vec2(uv.x * 13.0 + 3.0, uv.y * 3.0 + uTime * 0.25));
  col += cGlow * n * 0.05 * uHaze;
  gl_FragColor = vec4(col, 1.0);
}
`;

const GROUND_VERT = /* glsl */ `
varying vec3 vWp;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWp = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const GROUND_FRAG = /* glsl */ `
${WORLD_LIB}
uniform float uSparkle, uWoods;
varying vec3 vWp;
void main() {
  vec3 wp = vWp;
  float zr = wp.z - uWalk; // road coordinate (moves with the walk)
  float ax = abs(wp.x);
  // snow, lightly uneven, banked up at the road's edges
  float n = tnoise(vec2(wp.x * 2.0, zr * 0.8)) * 0.6 + tnoise(vec2(wp.x * 9.0, zr * 4.0)) * 0.4;
  float bank = smoothstep(2.8, 3.4, ax) * (1.0 - smoothstep(4.2, 6.0, ax));
  float alb = 0.72 + 0.12 * n + 0.12 * bank;
  // tyre tracks: two pairs of grooves, trodden darker and bluer
  float wob = 0.08 * sin(zr * 0.07) + 0.05 * sin(zr * 0.19 + 1.3);
  float tr = 0.0;
  for (int i = 0; i < 2; i++) {
    float cx = (i == 0 ? -0.75 : 0.75) + wob;
    tr = max(tr, 1.0 - smoothstep(0.06, 0.3, abs(wp.x - cx)));
  }
  tr *= (1.0 - bank) * (0.5 + 0.5 * tnoise(vec2(wp.x * 30.0, zr * 2.0))) * (1.0 - uWoods * 0.5);
  alb *= 1.0 - 0.2 * tr;
  vec3 light = cSky * (0.3 + 0.25 * uWoods) + cCold * 0.08 + sfLampLight(wp, 0.0) * 1.8;
  vec3 col = cSnow * alb * light;
  col = mix(col, col * cCold * 1.4, tr * 0.5);
  // glitter where the light catches crystals in the snow
  vec2 gc = floor(vec2(wp.x, zr) * 40.0);
  float gl = step(0.996, hash21(gc + floor(uTime * 3.0 + hash21(gc) * 3.0)));
  col += cSnow * gl * (0.25 + 1.2 * uSparkle) * (0.15 + length(sfLampLight(wp, 0.0))) * smoothstep(30.0, 4.0, -wp.z);
  float depth = length(wp - cameraPosition);
  gl_FragColor = vec4(sfFog(col, depth), 1.0);
}
`;

const CARD_VERT = /* glsl */ `
${WORLD_LIB}
attribute vec4 aCard; // x, z (0..1 along the repeat, or lamp slot), height, atlas cell
uniform float uRepeat, uIsLamp;
varying vec2 vUv2;
varying vec3 vWp;
varying float vCell;
void main() {
  float z;
  float x = aCard.x;
  if (uIsLamp > 0.5) {
    float side = x > 0.0 ? 1.0 : -1.0;
    z = mod(uWalk, ${F(LAMP_SP)}) - (side > 0.0 ? 0.0 : ${F(LAMP_SP / 2)}) - aCard.y * ${F(LAMP_SP)};
  } else z = mod(aCard.y * uRepeat + uWalk, uRepeat) - uRepeat + 4.0;
  float h = aCard.z;
  // cards stand upright and turn to face the camera about their trunk
  vec3 toCam = cameraPosition - vec3(x, 0.0, z);
  vec2 f = normalize(toCam.xz + vec2(1e-4));
  vec3 right = vec3(f.y, 0.0, -f.x);
  vec3 wp = vec3(x, 0.0, z) + right * position.x * h * 0.5 + vec3(0.0, (position.y * 0.5 + 0.5) * h - 0.05, 0.0);
  vWp = wp;
  vUv2 = position.xy * 0.5 + 0.5;
  vCell = aCard.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const CARD_FRAG = /* glsl */ `
${WORLD_LIB}
uniform sampler2D tCards;
varying vec2 vUv2;
varying vec3 vWp;
varying float vCell;
void main() {
  // canvas row 0 (cells 0–3) is the top of the texture
  vec2 cell = vec2(mod(vCell, 4.0), 1.0 - floor(vCell / 4.0));
  vec4 t = texture2D(tCards, (cell + vUv2) / vec2(4.0, 2.0));
  float a = max(t.r, t.g);
  if (a < 0.45) discard;
  vec3 light = cSky * 0.6 + cCold * 0.1 + sfLampLight(vWp + vec3(0.0, 0.0, 0.0), 0.35) * 1.6;
  float snow = smoothstep(0.2, 0.8, t.g);
  vec3 col = mix(cWood * (0.6 + 0.6 * length(light)), cSnow * light * 0.95, snow);
  // the lantern glass glows (lamp card, blue channel)
  col += cLamp * t.b * 3.0 * (1.0 + uFlare) * sfLampOn(-vWp.z);
  float depth = length(vWp - cameraPosition);
  gl_FragColor = vec4(sfFog(col, depth), 1.0);
}
`;

/** lamp heads: a glow halo and the cone of light (additive) */
const GLOW_VERT = /* glsl */ `
${WORLD_LIB}
attribute vec4 aCard;
uniform float uCone;
varying vec2 vQ;
varying float vOn, vDepth;
void main() {
  float side = aCard.x > 0.0 ? 1.0 : -1.0;
  float z = mod(uWalk, ${F(LAMP_SP)}) - (side > 0.0 ? 0.0 : ${F(LAMP_SP / 2)}) - aCard.y * ${F(LAMP_SP)};
  vec3 head = vec3(side > 0.0 ? 3.45 : -3.75, ${F(LAMP_H)} - 0.1, z);
  vec3 toCam = cameraPosition - head;
  vec2 f = normalize(toCam.xz + vec2(1e-4));
  vec3 right = vec3(f.y, 0.0, -f.x);
  vec3 wp;
  if (uCone > 0.5) {
    // a trapezoid from the lantern down to the snow
    float yy = position.y * 0.5 + 0.5; // 1 at the top
    float w = mix(2.6, 0.25, yy);
    wp = vec3(head.x, 0.0, head.z) + right * position.x * w + vec3(0.0, yy * head.y, 0.0);
  } else {
    wp = head + (right * position.x + vec3(0.0, position.y, 0.0)) * 1.6;
  }
  vQ = position.xy;
  vOn = sfLampOn(-z);
  vDepth = length(wp - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const GLOW_FRAG = /* glsl */ `
${WORLD_LIB}
uniform float uCone, uSnowAmt;
varying vec2 vQ;
varying float vOn, vDepth;
void main() {
  float a;
  if (uCone > 0.5) {
    float yy = vQ.y * 0.5 + 0.5;
    a = (1.0 - smoothstep(0.3, 1.0, abs(vQ.x))) * smoothstep(1.0, 0.75, yy) * (0.25 + 0.75 * yy) * 0.11 * (0.4 + 0.9 * uSnowAmt);
  } else {
    float r = length(vQ);
    a = exp(-r * r * 9.0) * 0.9 + exp(-r * 3.5) * 0.18;
    a *= 1.0 - smoothstep(0.8, 1.0, r);
  }
  float fog = exp(-vDepth * uFogK * 0.6);
  vec3 col = cLamp * a * vOn * uLampK * (1.0 + uFlare * 1.5) * fog;
  gl_FragColor = vec4(col, 1.0);
}
`;

const SNOW_VERT = /* glsl */ `
${WORLD_LIB}
attribute vec4 aSeed;
uniform vec3 uBox, uDrift;
uniform float uFlutter, uDensity, uPointK, uFocus, uAper, uSizeK, uStreak;
varying vec3 vCol;
varying float vSoft, vA;
void main() {
  float rank = fract(aSeed.w * 7.31);
  float vis = clamp((uDensity - rank) * 14.0, 0.0, 1.0);
  vec3 p = aSeed.xyz * uBox + vec3(uDrift.x * (0.8 + 0.4 * aSeed.w), -uDrift.y * (0.8 + 0.4 * aSeed.w), uDrift.z);
  p.x += sin(uFlutter * (0.7 + aSeed.w) + aSeed.y * 40.0) * 0.18;
  p.z += cos(uFlutter * (0.5 + aSeed.w * 0.6) + aSeed.x * 30.0) * 0.12;
  p = mod(p, uBox);
  p -= vec3(uBox.x * 0.5, 0.0, uBox.z - 1.2);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float depth = max(0.05, -mv.z);
  gl_Position = projectionMatrix * mv;
  float size = (0.03 + 0.05 * aSeed.w * aSeed.w) * uSizeK;
  float px = size * uPointK / depth;
  float coc = uAper * abs(depth - uFocus) / depth * 26.0;
  float ps = clamp(max(px, 1.2) + coc, 1.0, 110.0);
  gl_PointSize = ps;
  // lit by the sky and the lamps it is passing
  vec3 light = cSky * 0.28 + cCold * 0.1 + sfLampLight(p, 0.1) * 2.2;
  float energy = min(1.0, (px * px + 1.0) / (ps * ps));
  vCol = cSnow * light * energy * vis * 1.6;
  vCol = sfFog(vCol, depth) * smoothstep(0.15, 0.6, depth);
  // the fog itself doesn't add light to a flake
  vCol = max(vCol - cFog * (1.0 - exp(-depth * uFogK)) * 0.0, 0.0);
  vSoft = smoothstep(2.0, 12.0, coc);
  vA = vis;
}
`;

const SNOW_FRAG = /* glsl */ `
varying vec3 vCol;
varying float vSoft, vA;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d = length(q);
  float a = 1.0 - smoothstep(mix(0.35, 0.7, vSoft), 1.0, d);
  a *= mix(1.0, 0.75 + 0.35 * smoothstep(0.5, 0.95, d), vSoft);
  if (a <= 0.002) discard;
  gl_FragColor = vec4(vCol * a, 1.0);
}
`;

/* ───────────────────────── the cards (trees, lamp) drawn once ───────────────────────── */

function drawCards(cell: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = cell * 4;
  c.height = cell * 2;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  let sd = 11;
  const rnd = () => {
    sd = (sd * 16807) % 2147483647;
    return sd / 2147483647;
  };
  const WOOD = 'rgb(255,0,0)';
  const SNOW = 'rgb(0,255,0)';
  const LIGHT = 'rgb(0,0,255)';

  const bare = (cx: number, by: number) => {
    const s = cell;
    const branch = (x: number, y: number, len: number, ang: number, w: number, depth: number) => {
      const bend = (rnd() - 0.5) * 0.35;
      const mx = x + Math.cos(ang + bend) * len * 0.5;
      const my = y - Math.sin(ang + bend) * len * 0.5;
      const x2 = x + Math.cos(ang) * len;
      const y2 = y - Math.sin(ang) * len;
      g.globalCompositeOperation = 'source-over';
      g.strokeStyle = WOOD;
      g.lineWidth = Math.max(0.8, w);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(mx, my, x2, y2);
      g.stroke();
      // snow lies along the top of the branches that lean over
      const flat = Math.abs(Math.cos(ang));
      if (depth < 7 && flat > 0.25 && w > 1.2) {
        g.globalCompositeOperation = 'lighter';
        g.strokeStyle = SNOW;
        g.lineWidth = Math.max(0.8, w * 0.75 * flat);
        g.beginPath();
        g.moveTo(x, y - w * 0.45);
        g.quadraticCurveTo(mx, my - w * 0.5, x2, y2 - w * 0.4);
        g.stroke();
      }
      if (depth <= 0 || len < 3) return;
      const n = rnd() < 0.3 ? 3 : 2;
      for (let k = 0; k < n; k++) {
        const spread = (k - (n - 1) / 2) * (0.45 + rnd() * 0.25);
        const na = ang + spread + (rnd() - 0.5) * 0.35 + (Math.PI / 2 - ang) * 0.12;
        branch(x2, y2, len * (0.66 + rnd() * 0.16), na, w * 0.66, depth - 1);
      }
    };
    branch(cx, by, s * (0.24 + rnd() * 0.06), Math.PI / 2 + (rnd() - 0.5) * 0.15, s * 0.04, 8);
    // a little snow at the foot
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = SNOW;
    g.beginPath();
    g.ellipse(cx, by, s * 0.08, s * 0.02, 0, 0, Math.PI * 2);
    g.fill();
  };

  const pine = (cx: number, by: number) => {
    const s = cell;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = WOOD;
    g.fillRect(cx - s * 0.012, by - s * 0.12, s * 0.024, s * 0.12);
    const top = by - s * (0.86 + rnd() * 0.1);
    const bot = by - s * 0.07;
    // the trunk runs up the middle
    g.strokeStyle = WOOD;
    g.lineWidth = s * 0.016;
    g.beginPath();
    g.moveTo(cx, by);
    g.lineTo(cx, top);
    g.stroke();
    // the dark mass of the crown: ragged drooping tiers
    g.fillStyle = WOOD;
    const tiers = 9 + Math.floor(rnd() * 3);
    for (let i = 0; i < tiers; i++) {
      const t = i / (tiers - 1);
      const yb = bot + (top - bot) * t;
      const w = (s * 0.3 * Math.pow(1 - t, 1.05) + s * 0.02) * (0.85 + rnd() * 0.25);
      const hgt = s * (0.12 - 0.05 * t);
      g.beginPath();
      g.moveTo(cx, yb - hgt * 1.3);
      for (let k = 0; k <= 12; k++) {
        const u = k / 12;
        g.lineTo(cx + w * u, yb - hgt * (1 - u) * 1.1 + (k % 2 ? hgt * 0.25 * rnd() : -hgt * 0.1 * rnd()));
      }
      g.lineTo(cx, yb - hgt * 0.2);
      for (let k = 12; k >= 0; k--) {
        const u = k / 12;
        g.lineTo(cx - w * u, yb - hgt * (1 - u) * 1.1 + (k % 2 ? hgt * 0.25 * rnd() : -hgt * 0.1 * rnd()));
      }
      g.closePath();
      g.fill();
      // snow lying along the top of the tier: a ragged band of small lumps that follows the bough
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = SNOW;
      for (const side of [-1, 1]) {
        const lumps = 34 + Math.floor(rnd() * 16);
        for (let k = 0; k < lumps; k++) {
          const u = Math.pow(rnd(), 0.9) * 0.92;
          if (rnd() < 0.18) continue; // gaps where the dark needles show through
          const px = cx + side * w * u;
          const py = yb - hgt * (1 - u) * 1.1 + hgt * (0.05 + 0.12 * rnd());
          const rr = s * (0.0035 + 0.0065 * rnd()) * (1 - t * 0.4) * (1.15 - u * 0.5);
          g.beginPath();
          g.arc(px, py, rr, 0, Math.PI * 2);
          g.fill();
        }
      }
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = WOOD;
    }
    // a cap of snow on the top
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = SNOW;
    g.beginPath();
    g.ellipse(cx, top + s * 0.02, s * 0.01, s * 0.02, 0, 0, Math.PI * 2);
    g.fill();
  };

  const lamp = (cx: number, by: number) => {
    const s = cell;
    // a classic street lamp: post with a collar, a lantern with a snow cap
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = WOOD;
    g.fillRect(cx - s * 0.012, by - s * 0.86, s * 0.024, s * 0.86);
    g.fillRect(cx - s * 0.03, by - s * 0.06, s * 0.06, s * 0.06);
    g.fillRect(cx - s * 0.02, by - s * 0.5, s * 0.04, s * 0.02);
    // lantern
    const ly = by - s * 0.965;
    g.beginPath();
    g.moveTo(cx - s * 0.045, ly - s * 0.02);
    g.lineTo(cx + s * 0.045, ly - s * 0.02);
    g.lineTo(cx + s * 0.03, ly + s * 0.08);
    g.lineTo(cx - s * 0.03, ly + s * 0.08);
    g.closePath();
    g.fill();
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = LIGHT;
    g.fillRect(cx - s * 0.03, ly, s * 0.06, s * 0.065);
    g.fillStyle = SNOW;
    g.beginPath();
    g.ellipse(cx, ly - s * 0.024, s * 0.05, s * 0.012, 0, 0, Math.PI * 2);
    g.fill();
  };

  for (let i = 0; i < 8; i++) {
    const cx = (i % 4) * cell + cell / 2;
    const by = Math.floor(i / 4) * cell + cell * 0.995;
    g.save();
    g.beginPath();
    g.rect((i % 4) * cell, Math.floor(i / 4) * cell, cell, cell);
    g.clip();
    if (i < 4) bare(cx, by);
    else if (i < 7) pine(cx, by);
    else lamp(cx, by);
    g.restore();
  }
  return c;
}

/* ───────────────────────── the scene ───────────────────────── */

export const snowfall: SceneDef = {
  id: 'snowfall',
  name: 'Snowfall',
  description:
    'Walking down a snowy street at night while it snows: flakes in 3D glowing in the cones of the street lamps, snow along the tops of bare branches, tyre tracks in the road, soft bokeh close to the lens. The quiet is still air and one lamp; lamps come on one per beat down the street, a build picks up the wind until the snow streams sideways, the drop is a white-out gust with every lamp flaring, and breakdowns go still with flakes hanging in the air. Or the same snow on a road through the woods at dusk.',
  category: 'form',
  style: 'world',
  tags: ['calm', 'melancholic', 'nostalgic', 'tender', 'cold', 'winter', 'snow', 'night', 'cinematic', 'lofi', 'acoustic', 'piano', 'indie', 'ambient', 'slow', 'nature', 'city', 'realistic'],
  params,
  handInks: 3,
  modulations: [],
  create(init) {
    const { renderer, shared } = init;
    const coarse = isCoarse();
    const NSNOW = coarse ? 6000 : 16000;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(52, init.width / Math.max(1, init.height), 0.05, 200);
    camera.position.set(0, 1.6, 0);

    const world = {
      uWalk: { value: 0 },
      uLampReach: { value: 8 },
      uLampK: { value: 1 },
      uLampsOn: { value: 1 },
      uFogK: { value: 0.03 },
      uFlare: { value: 0 },
      cLamp: { value: new THREE.Vector3(1, 0.8, 0.5) },
      cFog: { value: new THREE.Vector3(0.2, 0.2, 0.25) },
      cSky: { value: new THREE.Vector3(0.2, 0.2, 0.3) },
      cSnow: { value: new THREE.Vector3(1, 1, 1) },
      cCold: { value: new THREE.Vector3(0.5, 0.6, 0.9) },
      cWood: { value: new THREE.Vector3(0.05, 0.05, 0.06) },
    };

    // sky
    const skyMat = makeMaterial({
      params,
      shared,
      vertex: BACKDROP_VERT,
      fragment: SKY_FRAG,
      extra: { cTop: { value: new THREE.Vector3() }, cHor: { value: new THREE.Vector3() }, cGlow: { value: new THREE.Vector3() }, uWoods: { value: 0 }, uGlowK: { value: 0.5 }, uHaze: { value: 1 } },
    });
    scene.add(makeBackdrop(skyMat));

    // ground
    const groundMat = makeMaterial({ params, shared, vertex: GROUND_VERT, fragment: GROUND_FRAG, extra: { ...world, uSparkle: { value: 0 }, uWoods: { value: 0 } } });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 160), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, 0, -70);
    ground.frustumCulled = false;
    scene.add(ground);

    // cards
    const cardCanvas = drawCards(coarse ? 256 : 512);
    const cardTex = new THREE.CanvasTexture(cardCanvas);
    cardTex.colorSpace = THREE.NoColorSpace;
    cardTex.generateMipmaps = true;
    cardTex.minFilter = THREE.LinearMipmapLinearFilter;
    const quad = new THREE.PlaneGeometry(2, 2);
    const cardGeo = (data: Float32Array) => {
      const gg = new THREE.InstancedBufferGeometry();
      gg.index = quad.index;
      gg.setAttribute('position', quad.getAttribute('position'));
      gg.setAttribute('aCard', new THREE.InstancedBufferAttribute(data, 4));
      gg.instanceCount = data.length / 4;
      return gg;
    };
    // trees on both sides, at a few depths back from the road (pines are cells 4–6)
    const treeData: number[] = [];
    let sd = 5;
    const rnd = () => {
      sd = (sd * 16807) % 2147483647;
      return sd / 2147483647;
    };
    const NT = coarse ? 70 : 120;
    for (let i = 0; i < NT; i++) {
      const side = i % 2 ? 1 : -1;
      const row = rnd();
      const x = side * (5.6 + row * row * 16);
      treeData.push(x, rnd(), 6.5 + rnd() * 5 + row * 4, row);
    }
    const treeArr = new Float32Array(treeData);
    const treeRow = Array.from({ length: NT }, (_, i) => treeArr[i * 4 + 3]);
    const treeGeo = cardGeo(treeArr);
    const cardMat = (isLamp: boolean) =>
      makeMaterial({
        params,
        shared,
        vertex: CARD_VERT,
        fragment: CARD_FRAG,
        extra: { ...world, tCards: { value: cardTex }, uRepeat: { value: TREE_LEN }, uIsLamp: { value: isLamp ? 1 : 0 } },
      });
    const treeMat = cardMat(false);
    const trees = new THREE.Mesh(treeGeo, treeMat);
    trees.frustumCulled = false;
    scene.add(trees);
    // lamps: slot k on each side
    const lampData: number[] = [];
    for (let k = -1; k < NL; k++) {
      lampData.push(3.45, k, LAMP_H + 0.25, 7);
      lampData.push(-3.75, k, LAMP_H + 0.25, 7);
    }
    const lampArr = new Float32Array(lampData);
    const lampMat = cardMat(true);
    const lamps = new THREE.Mesh(cardGeo(lampArr), lampMat);
    lamps.frustumCulled = false;
    scene.add(lamps);
    const glowMat = (cone: boolean) =>
      makeMaterial({
        params,
        shared,
        vertex: GLOW_VERT,
        fragment: GLOW_FRAG,
        extra: { ...world, uCone: { value: cone ? 1 : 0 }, uSnowAmt: { value: 0.5 } },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
    const coneMat = glowMat(true);
    const haloMat = glowMat(false);
    const cones = new THREE.Mesh(cardGeo(lampArr), coneMat);
    const halos = new THREE.Mesh(cardGeo(lampArr), haloMat);
    cones.frustumCulled = halos.frustumCulled = false;
    cones.renderOrder = 3;
    halos.renderOrder = 4;
    scene.add(cones, halos);

    // snow
    const seedArr = new Float32Array(NSNOW * 4);
    for (let i = 0; i < seedArr.length; i++) seedArr[i] = rnd();
    const snowGeo = new THREE.BufferGeometry();
    snowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NSNOW * 3), 3));
    snowGeo.setAttribute('aSeed', new THREE.BufferAttribute(seedArr, 4));
    const snowMat = makeMaterial({
      params,
      shared,
      vertex: SNOW_VERT,
      fragment: SNOW_FRAG,
      extra: {
        ...world,
        uBox: { value: new THREE.Vector3(14, 8, 26) },
        uDrift: { value: new THREE.Vector3() },
        uFlutter: { value: 0 },
        uDensity: { value: 0.5 },
        uPointK: { value: 600 },
        uFocus: { value: 6 },
        uAper: { value: 0.5 },
        uSizeK: { value: 1 },
        uStreak: { value: 0 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const snow = new THREE.Points(snowGeo, snowMat);
    snow.frustumCulled = false;
    snow.renderOrder = 5;
    scene.add(snow);

    const mats = [skyMat, groundMat, treeMat, lampMat, coneMat, haloMat, snowMat];
    const drop = new DropTimer();
    const drift = snowMat.uniforms.uDrift.value as THREE.Vector3;
    let walk = 0;
    let walkV = 0.6;
    let fallV = 0.6;
    let windV = 0;
    let flutter = 0;
    let reach = 14;
    let flare = 0;
    let dens = 0.3;
    let fog = 0.03;
    let lastWoods = -1;
    const tc = new THREE.Color();
    const setV = (u: THREE.IUniform, c: THREE.Color, k = 1) => (u.value as THREE.Vector3).set(c.r * k, c.g * k, c.b * k);

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
        const woods = str(p, 'setting', 'street') === 'woods';
        if ((woods ? 1 : 0) !== lastWoods) {
          lastWoods = woods ? 1 : 0;
          // the woods: pines and a few bare trees, no lamps; the street: bare trees and lamps
          for (let i = 0; i < NT; i++) {
            const row = treeRow[i];
            const pine = woods ? rnd() < 0.72 : row > 0.6 && rnd() < 0.3;
            treeArr[i * 4 + 3] = pine ? 4 + Math.floor(rnd() * 3) : Math.floor(rnd() * 4);
          }
          (treeGeo.getAttribute('aCard') as THREE.InstancedBufferAttribute).needsUpdate = true;
          lamps.visible = cones.visible = halos.visible = !woods;
        }

        // weather: the quiet is still air, a build picks up the wind, the drop gusts, a break hangs
        const breakdown = f.section === 'break' ? 1 : 0;
        const still = Math.max(breakdown * (1 - I), 1 - THREE.MathUtils.smoothstep(I, 0.08, 0.3)) * (1 - T);
        const windK = num(p, 'wind', 1);
        const windTarget = f.windX * windK * (0.15 + 1.4 * f.gust * (1 - still) + 3.5 * T * T + 4.0 * drop.env);
        windV = approach(windV, windTarget, 1.6, dt);
        fallV = approach(fallV, (0.35 + 0.6 * I) * (1 - 0.65 * still * breakdown) + 1.2 * drop.env, 1.5, dt);
        drift.x += windV * dt;
        drift.y += fallV * dt;
        flutter += dt * (0.5 + 0.8 * I + 1.2 * T);
        walkV = approach(walkV, num(p, 'walk', 1) * (0.35 + 1.1 * I + 0.8 * drop.env) * (a.playing ? 1 : 0.3), 0.8, dt);
        walk += walkV * dt;
        drift.z = walk;
        const su = snowMat.uniforms;
        su.uFlutter.value = flutter;
        dens = approach(dens, Math.min(1, num(p, 'snow', 1) * (0.18 + 0.7 * I + 0.25 * T + 0.5 * drop.env)), 1.2, dt);
        const rung = quality.current();
        su.uDensity.value = dens * (rung.sceneScale < 0.7 ? 0.6 : 1);
        su.uSizeK.value = num(p, 'flake', 1) * (1.25 - 0.35 * I);
        su.uPointK.value = frame.height / (2 * Math.tan((camera.fov * Math.PI) / 360));
        su.uFocus.value = 3 + 4 * I;
        su.uAper.value = 0.06 * num(p, 'focus', 1) * (frame.height / 720);

        // lamps come on one per beat down the street; the drop flares them all
        const want = 14 + 110 * THREE.MathUtils.smoothstep(I, 0.2, 0.7);
        if (a.beat && reach < want) reach = Math.min(want, Math.ceil((reach + 0.01) / (LAMP_SP / 2)) * (LAMP_SP / 2) + 0.5);
        if (reach > want + 8) reach = approach(reach, want, 0.15, dt);
        if (drop.since === 0) reach = 200;
        flare = Math.max(flare * Math.exp(-dt * 1.2), drop.since < 0.05 ? 1.2 : 0, a.kick * 0.12 * I);
        // fog thickens with the snow, white-out on the drop
        fog = approach(fog, (0.022 + 0.03 * dens + 0.12 * drop.env * drop.env) * num(p, 'fog', 1), 2, dt);

        // the camera walks, with a little sway
        camera.position.set(0.25 * Math.sin(walk * 0.05), 1.6 + 0.02 * Math.sin(walk * 1.7), 0);
        camera.rotation.set(-0.035 + 0.008 * Math.sin(flutter * 0.4) + 0.03 * T, 0.03 * Math.sin(walk * 0.03) + 0.01 * Math.sin(flutter * 0.3), 0.004 * Math.sin(flutter * 0.25));
        if (Math.abs(camera.aspect - frame.aspect) > 1e-4) {
          camera.aspect = frame.aspect;
          // upright phones: a wider field so the road and lamps still fit
          camera.fov = frame.aspect < 1 ? 68 : 52;
          camera.updateProjectionMatrix();
        }

        // colours (display values straight through)
        const lampK = num(p, 'lamps', 1);
        for (const m of mats) {
          syncMaterial(m, frame, params);
          const u = m.uniforms;
          if (!u.uWalk) continue;
          u.uWalk.value = walk;
          u.uLampReach.value = reach;
          u.uLampK.value = lampK * (0.85 + 0.25 * I);
          u.uLampsOn.value = woods ? 0 : 1;
          u.uFogK.value = fog;
          u.uFlare.value = flare;
          setV(u.cLamp, pal.accent, 1);
          tc.copy(pal.muted).lerp(pal.fg, 0.08 + 0.35 * drop.env);
          setV(u.cFog, tc);
          tc.copy(pal.bg).lerp(pal.accent2, woods ? 0.45 : 0.25).lerp(pal.muted, 0.3);
          setV(u.cSky, tc, woods ? 1.6 : 1.1);
          setV(u.cSnow, pal.fg);
          setV(u.cCold, pal.accent2);
          tc.copy(pal.bg).multiplyScalar(0.45);
          setV(u.cWood, tc);
        }
        const sk = skyMat.uniforms;
        setV(sk.cTop, pal.bg);
        tc.copy(pal.muted).lerp(pal.fg, 0.1 * drop.env);
        setV(sk.cHor, tc);
        tc.copy(woods ? pal.accent2 : pal.accent).lerp(pal.muted, 0.4);
        setV(sk.cGlow, tc);
        sk.uWoods.value = woods ? 1 : 0;
        sk.uGlowK.value = woods ? 0.8 : 0.35 + 0.3 * flare;
        sk.uHaze.value = dens;
        groundMat.uniforms.uSparkle.value = a.hat;
        groundMat.uniforms.uWoods.value = woods ? 1 : 0;
        coneMat.uniforms.uSnowAmt.value = dens;

        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
      },
      dispose() {
        cardTex.dispose();
        quad.dispose();
        for (const m of mats) m.dispose();
        scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.());
      },
    };
  },
};
