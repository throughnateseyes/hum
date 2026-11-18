import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../../core/glsl';
import { buildSceneFragment, createFullscreenQuad, createPhotoClock } from '../../core/sceneHelpers';
import { createBaseUniforms, num, updateBaseUniforms, updateParamUniforms } from '../../core/uniforms';
import type { ParamDef, SceneDef } from '../../core/types';

const NRIP = 10;

const params: ParamDef[] = [
  { id: 'margin', label: 'Paper margin', type: 'number', min: 0, max: 0.2, step: 0.005, default: 0.06, group: 'Frame', hint: '0 = full bleed' },
  { id: 'strength', label: 'Ripple strength', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, group: 'Ripples' },
  { id: 'speed', label: 'Ripple speed', type: 'number', min: 0.1, max: 1.5, step: 0.01, default: 0.45, group: 'Ripples' },
  { id: 'freq', label: 'Ring frequency', type: 'number', min: 15, max: 120, step: 1, default: 55, group: 'Ripples' },
  { id: 'decay', label: 'Decay', type: 'number', min: 0.2, max: 3, step: 0.01, default: 0.9, group: 'Ripples' },
  { id: 'chroma', label: 'Chroma split', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, group: 'Optics' },
  { id: 'refraction', label: 'Refraction', type: 'number', min: 0, max: 1, step: 0.01, default: 0.3, group: 'Optics', hint: 'Slow liquid warp, deepened by mids' },
  { id: 'gloss', label: 'Gloss', type: 'number', min: 0, max: 1, step: 0.01, default: 0.4, group: 'Optics' },
  { id: 'impact', label: 'Kick impact', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, group: 'Reactivity', hint: 'How hard each kick splashes: a crater plus a tall first wave' },
  { id: 'shatter', label: 'Drop shatter', type: 'number', min: 0, max: 1, step: 0.01, default: 0.75, group: 'Reactivity', hint: 'A drop breaks the print into floating shards that drift back together' },
  { id: 'cymatics', label: 'Spectrum rings', type: 'number', min: 0, max: 1, step: 0.01, default: 0.4, group: 'Reactivity', hint: 'Standing rings from the centre, each radius driven by one frequency' },
  { id: 'tension', label: 'Build tension', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, group: 'Reactivity', hint: 'Build-ups chop the surface and crack the print' },
];

const fragment = /* glsl */ `
#define NRIP ${NRIP}
uniform vec4 uRip[NRIP]; // xy = centre (aspect space), z = birth time, w = strength

vec3 photoAt(vec2 q, vec2 hb, float mixB) {
  vec2 l = (q + hb) / (2.0 * hb);
  float ra = hb.x / hb.y;
  vec3 a = texture2D(uImage, coverUv(l, uImageSize, ra)).rgb;
  vec3 b = texture2D(uImage2, coverUv(l, uImage2Size, ra)).rgb;
  return mix(a, b, mixB);
}

// voronoi shards (q space): id, centre, distance to the nearest edge
void shardCell(vec2 q, float sc, out vec2 cid, out vec2 cpt, out float edge) {
  vec2 p = q * sc;
  vec2 ip = floor(p);
  vec2 fp = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  cid = vec2(0.0);
  vec2 bp = vec2(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 id = ip + g;
      vec2 o = 0.5 + (hash22(id + 7.3) - 0.5) * 0.85;
      vec2 r = g + o - fp;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; cid = id; bp = id + o; }
      else if (d < d2) { d2 = d; }
    }
  }
  cpt = bp / sc;
  edge = (sqrt(d2) - sqrt(d1)) / sc;
}

void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float px = 1.0 / uResolution.y;
  float m = clamp(u_margin, 0.0, 0.3);
  vec2 hb = max(vec2(uAspect * 0.5 - m, 0.5 - m), vec2(0.05));
  float hasMargin = step(0.001, m);
  float t = uTime;
  vec2 q = p;
  float tens = uBuild * u_tension;

  // slow refraction (always on a little, mids deepen it)
  vec2 disp = vec2(fbm(q * 1.8 + vec2(t * 0.04, 1.7), 3), fbm(q * 1.8 + vec2(-3.1, t * 0.035), 3));
  disp *= 0.003 + u_refraction * (0.008 + uMid * 0.03 + uLowMid * 0.01);

  // build-up: the surface starts to chop
  disp += vec2(snoise(q * 22.0 + t * 3.0), snoise(q * 22.0 - t * 3.0 + 9.0)) * tens * tens * 0.006;

  // travelling ripple packets; a kick lands as a crater with a tall first wave
  float front = 0.0;
  float slope = 0.0;
  float dent = 0.0;
  for (int i = 0; i < NRIP; i++) {
    vec4 rp = uRip[i];
    float age = t - rp.z;
    if (rp.w <= 0.0 || age < 0.0 || age > 14.0) continue;
    vec2 dv = q - rp.xy;
    float d = length(dv);
    vec2 dir = dv / max(d, 1e-4);
    float x = d - age * u_speed;
    float k = 140.0 / (1.0 + age * 1.5);
    float env = exp(-x * x * k) * exp(-age * u_decay) * rp.w * smoothstep(0.0, 0.04, d);
    float ph = x * u_freq;
    float w = sin(ph) * env;
    float imp = u_impact * exp(-age * 5.0);
    disp += dir * w * (0.018 * u_strength + 0.045 * imp);
    front += abs(w) * (1.0 + imp * 2.0);
    slope += cos(ph) * env * (1.0 + imp * 2.5);
    // the crater: the surface punches in at the impact point, then springs back
    float cr = exp(-d * d * 70.0) * exp(-age * 7.0) * min(rp.w, 1.1) * u_impact;
    disp += dv * cr * 0.9;
    dent += cr;
  }

  // spectrum rings (cymatics): standing rings out of the centre, each radius driven by a frequency
  float dc = length(q);
  float spc = spectrum(0.03 + clamp(dc / length(hb), 0.0, 1.0) * 0.75);
  spc *= spc;
  float cph = dc * 120.0 - t * 3.0;
  disp += (q / max(dc, 1e-4)) * sin(cph) * spc * 0.008 * u_cymatics;
  slope += cos(cph) * spc * u_cymatics * 1.2;

  // next photo is revealed inside an expanding liquid front from the centre
  float tt = smoothstep(0.72, 1.0, fract(uPhotoIndex));
  float hasT = step(0.0001, tt);
  float R = tt * (length(hb) + 0.15);
  float dd = length(q) + fbm(q * 3.0 + t * 0.1, 2) * 0.05;
  float mixB = (1.0 - smoothstep(R - 0.04, R, dd)) * hasT;
  float xr = (dd - R) * 18.0;
  float tf = exp(-xr * xr) * hasT * (1.0 - tt * 0.7);
  disp += (q / max(length(q), 1e-4)) * tf * 0.012;
  front += tf * 0.8;

  // drop: the print breaks into shards that drift apart on the water, tilt, and float back
  // together as the drop decays; build-ups already crack it a little
  float crack = max(tens * 0.2, uDrop * u_shatter);
  float shardGap = 0.0;
  float shardTilt = 0.0;
  if (crack > 0.003) {
    vec2 cid, cpt;
    float ce;
    shardCell(q, 4.5, cid, cpt, ce);
    vec2 h = hash22(cid + 3.1);
    vec2 away = cpt / max(length(cpt), 1e-3);
    vec2 off = (away * (0.3 + 0.7 * h.x) * 0.09 + (h - 0.5) * 0.04) * crack;
    off += vec2(sin(t * 1.3 + h.x * TAU), cos(t * 1.1 + h.y * TAU)) * 0.006 * crack;
    float ra = (h.y - 0.5) * 0.6 * crack;
    vec2 loc = rot2(ra) * (q - cpt - off);
    disp += (cpt + loc) - q;
    float gw = 0.002 + crack * 0.022 * (0.6 + 0.4 * h.y);
    shardGap = 1.0 - smoothstep(gw, gw + px * 1.5, ce);
    shardTilt = dot(q - cpt, vec2(cos(h.x * TAU), sin(h.x * TAU))) * crack * 2.5;
  }

  // chromatic split along the ripple fronts
  float dl = length(disp);
  vec2 dn = dl > 1e-5 ? disp / dl : vec2(1.0, 0.0);
  float ca = u_chroma * (0.0015 + front * 0.014 + uSnare * 0.004 + uDrop * 0.01);
  vec2 sq = q + disp;
  vec3 col;
  col.r = photoAt(sq + dn * ca, hb, mixB).r;
  col.g = photoAt(sq, hb, mixB).g;
  col.b = photoAt(sq - dn * ca, hb, mixB).b;
  col += slope * u_gloss * 0.1;
  col *= 1.0 - min(dent, 1.0) * 0.22 + shardTilt;
  col = clamp(col, 0.0, 1.0);
  // water shows between the shards
  col = mix(col, mix(uBg, uMuted, 0.55), shardGap);

  // paper margin: soft drop shadow, faint water rings, hairline edge
  float sd = sdBox(p, hb);
  float inside = 1.0 - smoothstep(-px, px, sd);
  float sdS = sdBox(p + vec2(0.0, 0.008), hb);
  vec3 paper = uBg * (1.0 - (1.0 - smoothstep(0.0, 0.035, sdS)) * 0.1 * hasMargin);
  paper = mix(paper, uMuted, clamp(front, 0.0, 1.0) * 0.45);
  vec3 outc = mix(paper, col, inside);
  float line = (1.0 - smoothstep(0.0, px * 1.2, abs(sd))) * hasMargin;
  outc = mix(outc, uFg, line * 0.25);

  gl_FragColor = vec4(outc, 1.0);
}
`;

export const photoRipple: SceneDef = {
  id: 'photo-ripple',
  name: 'Ripple Print',
  description:
    'The photo as a print on a liquid surface, inset on paper. Every kick lands as a crater with a tall wave that rolls across the print, splitting the colour along its front; the live spectrum stands as rings around the centre, each radius one frequency; build-ups chop the surface and crack the print; a drop sends one huge ring and breaks the print into floating shards that drift back together. Snares add smaller rings, mids deepen a slow refraction. In silence, soft ripples still fall every few seconds.',
  category: 'photo',
  usesPhotos: true,
  light: true,
  tags: ['calm', 'liquid', 'dreamy', 'elegant', 'warm', 'minimal'],
  params,
  modulations: [
    { source: 'mid', param: 'refraction', amount: 0.25 },
    { source: 'highMid', param: 'chroma', amount: 0.2 },
    { source: 'kick', param: 'gloss', amount: 0.2 },
  ],
  create(init) {
    const rip = Array.from({ length: NRIP }, () => new THREE.Vector4(0, 0, -100, 0));
    const uniforms = {
      ...createBaseUniforms(init.shared, params),
      uImage: { value: null as THREE.Texture | null },
      uImageSize: { value: new THREE.Vector2(1, 1) },
      uImage2: { value: null as THREE.Texture | null },
      uImage2Size: { value: new THREE.Vector2(1, 1) },
      uPhotoIndex: { value: 0 },
      tPrev: { value: null as THREE.Texture | null },
      uRip: { value: rip },
    };
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: buildSceneFragment(fragment, params),
      depthTest: false,
      depthWrite: false,
    });
    const quad = createFullscreenQuad(material);
    const clock = createPhotoClock();
    let head = 0;
    let nextIdle = 0.6;
    let lastDrop = -10;
    const spawn = (x: number, y: number, t: number, s: number) => {
      rip[head].set(x, y, t, s);
      head = (head + 1) % NRIP;
    };

    return {
      render(frame, target) {
        updateBaseUniforms(uniforms, frame);
        updateParamUniforms(uniforms, params, frame.params);
        const pc = clock(frame);
        const n = frame.photos.length;
        const i = Math.floor(pc) % n;
        const p1 = frame.photos[i];
        const p2 = frame.photos[(i + 1) % n];
        uniforms.uImage.value = p1.texture;
        uniforms.uImageSize.value.set(p1.width, p1.height);
        uniforms.uImage2.value = p2.texture;
        uniforms.uImage2Size.value.set(p2.width, p2.height);
        uniforms.uPhotoIndex.value = pc;

        // ripple spawning (positions in the same aspect space as the shader)
        const a = frame.audio;
        const t = frame.time;
        const m = Math.min(0.3, Math.max(0, num(frame.params, 'margin', 0.06)));
        const hx = Math.max(0.05, frame.aspect * 0.5 - m) * 0.85;
        const hy = Math.max(0.05, 0.5 - m) * 0.85;
        const rnd = (h: number) => (Math.random() * 2 - 1) * h;
        if (a.kickHit) spawn(rnd(hx), rnd(hy), t, 0.55 + a.kick * 0.5);
        if (a.snareHit) spawn(rnd(hx), rnd(hy), t, 0.28);
        if (a.drop > 0.5 && t - lastDrop > 2) {
          spawn(0, 0, t, 2.2);
          lastDrop = t;
        }
        const quiet = !a.playing || a.level < 0.04;
        if (!quiet) nextIdle = Math.max(nextIdle, t + 1.5);
        else if (t > nextIdle) {
          spawn(rnd(hx), rnd(hy), t, 0.35 + Math.random() * 0.15);
          nextIdle = t + 2.2 + Math.random() * 2.5;
        }

        quad.render(frame.renderer, target);
      },
      dispose() {
        material.dispose();
        quad.dispose();
      },
    };
  },
};
