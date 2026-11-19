import type { ClockDef } from './lib';
import { HM_LIB, defineClockedShaderScene, kickCountClock, sinceKickClock, speedClock } from './lib';

const fragment = /* glsl */ `
${HM_LIB}
vec3 gB[6];
float gR[6];
vec4 gD[3];
float gK;
float gRipA;   // kick ripple amplitude
float gRipT;   // seconds since the kick
float gTrem;   // build tremble amplitude
vec3 gCen;     // cluster centre (ripples radiate from it)

// 0 → ~1 in ~0.15 s after a drop, then a slow ~1.5 s fall
float cbBurst(float s) { return clamp((1.0 - exp(-s * 16.0)) * exp(-s * 1.5) * 1.35, 0.0, 1.0); }
float cbBand(float x) { return (spectrum(x - 0.03) + spectrum(x) + spectrum(x + 0.03)) / 3.0; }

float hmSmin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float mapBlobs(vec3 p) {
  float d = 100000.0;
  for (int i = 0; i < 6; i++) {
    if (float(i) >= u_count) break;
    d = hmSmin(d, length(p - gB[i]) - gR[i], gK);
  }
  for (int j = 0; j < 3; j++) {
    if (gD[j].w > 0.002) d = hmSmin(d, length(p - gD[j].xyz) - gD[j].w, gK * 0.6);
  }
  // kick: a ring of ripples runs across the skin, out from the cluster centre
  if (gRipA > 0.001) {
    float rr = length(p - gCen);
    float x = rr - gRipT * 2.2;
    d += gRipA * sin(x * 18.0) * exp(-x * x * 9.0);
  }
  // build: a fine, nervous tremble on the surface
  if (gTrem > 0.001) d += gTrem * sin(p.x * 31.0 + uTime * 23.0) * sin(p.y * 29.0 - uTime * 19.0) * sin(p.z * 27.0 + uTime * 17.0);
  return d;
}

vec3 blobNormal(vec3 p) {
  const vec2 e = vec2(0.0015, -0.0015);
  return normalize(e.xyy * mapBlobs(p + e.xyy) + e.yyx * mapBlobs(p + e.yyx) +
                   e.yxy * mapBlobs(p + e.yxy) + e.xxx * mapBlobs(p + e.xxx));
}

// fake studio environment built from the palette (matcap-like)
vec3 studio(vec3 d) {
  vec3 hi = hmLight();
  vec3 lo = hmDark();
  float y = d.y;
  vec3 col = mix(lo, mix(lo, uMuted, 0.6), smoothstep(-1.0, -0.05, y));
  col = mix(col, mix(uBg, hi, 0.5), smoothstep(-0.05, 0.5, y));
  col = mix(col, uAccent, exp(-abs(y + 0.02) * 22.0) * 0.8);
  float az = atan(d.x, -d.z);
  float sb = 1.0 - smoothstep(0.0, 0.05, sdBox(vec2(az - 0.8, y - 0.35), vec2(0.28, 0.16)));
  sb += 0.8 * (1.0 - smoothstep(0.0, 0.05, sdBox(vec2(az + 1.3, y - 0.15), vec2(0.12, 0.45))));
  sb += 0.5 * (1.0 - smoothstep(0.0, 0.35, length(vec2(abs(az) - 2.9, y - 0.6))));
  col = mix(col, mix(hi, vec3(1.0), 0.5), clamp(sb, 0.0, 1.0));
  col += uAccent2 * (1.0 - smoothstep(0.0, 0.1, abs(az + 2.3) - 0.12)) * smoothstep(-0.2, 0.3, y) * (0.35 + 0.9 * uKick);
  return col;
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float t = u_clk;

  float burst = u_burst * cbBurst(u_sinceDrop);
  float tens = clamp(uBuild * u_tension, 0.0, 1.0);
  float kick = uKick * u_punch;

  // sub swells and merges the blobs; kicks punch them fat and shove them apart (they snap back
  // together through the smooth-min); build-ups squeeze them into one tight, merged knot;
  // the drop shatters the cluster into separate beads that fly out, then re-gather
  float swell = 1.0 + 0.35 * uSub * u_swell + 0.12 * uBass + 0.3 * kick;
  gK = u_merge * (0.25 + 0.45 * uSub * u_swell + 0.35 * tens) * (1.0 - 0.85 * burst);
  float spread = u_spread * (1.0 - 0.45 * tens) * (1.0 + 0.3 * kick + 1.3 * burst);
  gCen = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    vec3 h = vec3(hash11(fi * 1.7 + 0.3), hash11(fi * 2.9 + 1.1), hash11(fi * 4.3 + 2.7));
    gB[i] = vec3(sin(t * (0.5 + h.x * 0.6) + h.y * TAU) * 0.75,
                 cos(t * (0.4 + h.y * 0.5) + h.z * TAU) * 0.45,
                 sin(t * (0.3 + h.z * 0.4) + h.x * TAU) * 0.4) * spread;
    gB[i].y *= 1.0 - 0.35 * uSnare * u_punch; // snare: the cluster squashes flat for a moment
    // each blob swells with its own slice of the spectrum (low → high, highs boosted)
    float bx = 0.05 + 0.75 * fi / 5.0;
    float band = cbBand(bx) * (1.0 + 1.2 * bx);
    gR[i] = (0.28 + 0.16 * h.z) * u_size * swell * (1.0 + u_bands * 0.55 * band) * (1.0 - 0.15 * tens) * (1.0 - 0.35 * burst);
    if (float(i) < u_count) gCen += gB[i];
  }
  gCen /= max(u_count, 1.0);
  gRipA = 0.024 * u_ripple * u_kickAmp * exp(-u_sinceKick * 3.0);
  gRipT = u_sinceKick;
  gTrem = 0.006 * tens;
  // kick droplets: three slots, each launched by one of the last three kicks
  for (int j = 0; j < 3; j++) {
    float age = u_age0;
    if (j == 1) age = u_age1;
    if (j == 2) age = u_age2;
    float seed = u_kickN - float(j);
    vec3 dir = normalize(vec3(hash11(seed * 3.1 + 0.5) - 0.5,
                              hash11(seed * 5.7 + 0.2) * 0.8 - 0.15,
                              (hash11(seed * 7.3 + 0.9) - 0.5) * 0.6) + vec3(0.0001, 0.0, 0.0));
    float life = clamp(1.0 - age / 1.4, 0.0, 1.0);
    vec3 pos = dir * (0.35 + age * 1.6) * u_spread + vec3(0.0, -0.7 * age * age, 0.0);
    gD[j] = vec4(pos, 0.14 * u_droplets * life * life * (1.0 + 0.6 * burst));
  }

  // camera, with a slow bar-locked orbit
  vec3 ro = vec3(0.0, 0.0, 3.2);
  vec3 rd = normalize(vec3(p, -1.6));
  float ang = 0.18 * uSway;
  ro.xz = rot2(ang) * ro.xz;
  rd.xz = rot2(ang) * rd.xz;

  float tt = 0.0;
  float minD = 10.0;
  bool hit = false;
  for (int i = 0; i < 64; i++) {
    float d = mapBlobs(ro + rd * tt);
    minD = min(minD, d);
    if (d < 0.0015) { hit = true; break; }
    tt += d * 0.8;
    if (tt > 7.0) break;
  }

  // backdrop: palette sweep with a soft contact shadow
  vec3 col = mix(uBg, mix(uBg, uMuted, 0.6), (1.0 - smoothstep(-0.6, 0.15, p.y)));
  float shadowD = length((p - vec2(0.0, -0.44)) * vec2(0.9, 4.0));
  col = mix(col, hmDark(), exp(-shadowD * shadowD * 1.5) * (0.16 + 0.08 * uSub));
  col = mix(col, uAccent, exp(-minD * 30.0) * 0.18 * uKick);

  if (hit) {
    vec3 pos = ro + rd * tt;
    vec3 n = blobNormal(pos);
    vec3 rf = reflect(rd, n);
    rf.xz = rot2(uDrop * 2.4) * rf.xz; // drop swirls the studio
    float fres = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    vec3 env = studio(rf);
    vec3 chrome = mix(env, env * mix(vec3(1.0), uAccent, 0.4), u_tint);
    chrome = mix(chrome, studio(n), 0.12);
    col = mix(chrome, hmLight(), fres * 0.3);
    col += uAccent2 * fres * fres * uKick * 0.6;
  }

  col += hmGrain(fc, uTime) * u_grain;
  vec2 vv = vUv - 0.5;
  col *= 1.0 - dot(vv, vv) * 0.25;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/** Seconds since the drop fired (rising edge of the drop envelope). */
const sinceDropClock: ClockDef = {
  init: 100,
  step: (v, f, _s, mem) => {
    const d = f.audio.drop;
    const fired = d > 0.6 && (mem.sdPrev ?? 0) <= 0.6;
    mem.sdPrev = d;
    return fired ? 0 : Math.min(v + f.dt, 100);
  },
};

/** Strength of the last kick (already shaped by Impact), held until the next one. */
const kickAmpClock: ClockDef = { step: (v, f) => (f.audio.kickHit ? f.audio.kick : v) };

/** age of the droplet launched by the kick `slot` kicks ago */
const ageClock = (from: string | null): ClockDef => ({
  init: 99,
  step: (v, f, s) => (f.audio.kickHit ? (from ? s[from] : 0) : Math.min(v + f.dt, 99)),
});

export const chromeBlobs = defineClockedShaderScene(
  {
    id: 'chrome-blobs',
    name: 'Chrome Blobs',
    description:
      'Raymarched liquid-chrome metaballs reflecting a fake studio built from the palette. Sub swells and merges the blobs and each blob swells with its own frequency band; every kick puffs them up, shoves them apart, runs a ring of ripples across the chrome and flings off a droplet; build-ups squeeze them into one trembling knot; a drop shatters the cluster into flying beads and swirls the reflections.',
    category: 'field',
    style: 'light',
    fragment,
    tags: ['glossy', 'futuristic', 'playful', 'liquid', 'y2k', 'bouncy', 'heavy', 'sleek'],
    params: [
      { id: 'count', label: 'Blobs', group: 'Shape', type: 'number', min: 2, max: 6, step: 1, default: 5 },
      { id: 'size', label: 'Size', group: 'Shape', type: 'number', min: 0.5, max: 1.6, step: 0.01, default: 1 },
      { id: 'spread', label: 'Spread', group: 'Shape', type: 'number', min: 0.3, max: 1.5, step: 0.01, default: 1 },
      { id: 'merge', label: 'Merge', group: 'Shape', type: 'number', min: 0.1, max: 1.2, step: 0.01, default: 0.55 },
      { id: 'swell', label: 'Sub swell', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1 },
      { id: 'droplets', label: 'Kick droplets', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1 },
      { id: 'punch', label: 'Kick punch', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.8, hint: 'Kicks puff the blobs up and shove them apart' },
      { id: 'ripple', label: 'Kick ripple', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.8, hint: 'A ring of ripples runs across the chrome on each kick' },
      { id: 'bands', label: 'Spectrum swell', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.7, hint: 'Each blob swells with its own frequency band' },
      { id: 'burst', label: 'Drop shatter', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.8 },
      { id: 'tension', label: 'Build tension', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, hint: 'Build-ups squeeze the blobs into one tight, trembling knot' },
      { id: 'speed', label: 'Speed', group: 'Motion', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.35 },
      { id: 'tint', label: 'Accent tint', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.45 },
      { id: 'grain', label: 'Grain', group: 'Color', type: 'number', min: 0, max: 0.2, step: 0.005, default: 0.035 },
    ],
    modulations: [
      { source: 'sub', param: 'merge', amount: 0.2 },
      { source: 'bass', param: 'size', amount: 0.08 },
      { source: 'energy', param: 'spread', amount: 0.12 },
    ],
  },
  {
    clk: speedClock('speed', 0.35, (f) => 0.6 + 0.8 * f.audio.energy + 0.4 * f.audio.bass + 0.9 * f.audio.build),
    // stepped in this order so each slot inherits the previous slot's age on a kick
    age2: ageClock('age1'),
    age1: ageClock('age0'),
    age0: ageClock(null),
    kickN: kickCountClock,
    sinceKick: sinceKickClock,
    kickAmp: kickAmpClock,
    sinceDrop: sinceDropClock,
  },
);
