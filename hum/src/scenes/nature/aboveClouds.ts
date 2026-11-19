import * as THREE from 'three';
import type { ParamDef, SceneDef } from '../../core/types';
import { num } from '../../core/uniforms';
import { approach, stepDt } from '../three/common';
import { DropTimer, VolumePipeline, dirFromAngles, linColor, tempoRate } from './volume';

/**
 * Above the Clouds: flying just over a sea of volumetric clouds at golden hour, under a dark,
 * heavy deck lit from below by a sun sitting on the horizon. Columns of light stand in the
 * cloud sea: they rise with a build and blaze on the drop.
 *
 * Palette roles: bg = the dark deck / upper sky, fg = the hottest light (pillars, horizon),
 * accent = the sun's gold, accent2 = rose glow, muted = violet shadow in the cloud sea.
 */
const PILLARS = 6;

const params: ParamDef[] = [
  { id: 'sea', label: 'Cloud sea', group: 'Shape', type: 'number', min: 0.4, max: 1, step: 0.01, default: 0.78 },
  { id: 'deck', label: 'Dark deck', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.62 },
  { id: 'speed', label: 'Flight speed', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 0.6, hint: 'Follows the tempo' },
  { id: 'pillars', label: 'Light pillars', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'Rise with a build, blaze on the drop' },
  { id: 'glow', label: 'Kick glow', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.7, hint: 'The sea and the deck glow brighter on the kick' },
  { id: 'sun', label: 'Sun height', group: 'Color', type: 'number', min: -1, max: 6, step: 0.1, default: 1.6, hint: 'Degrees above the horizon' },
  { id: 'grain', label: 'Film grain', group: 'Color', type: 'number', min: 0, max: 0.1, step: 0.002, default: 0.03 },
];

const fragment = /* glsl */ `
uniform vec3 uSunCol, uSkyHot, uSkyRose, uSkyTop, uSeaAmbTop, uSeaAmbBot, uDeckAmbTop, uDeckAmbBot, uPillarCol;
uniform float uSeaCov, uDeckCov, uPillarH, uPillarI, uDeckSun;
uniform vec4 uPil[${PILLARS}];
uniform float uPilBand[${PILLARS}];

const float SEA_LO = 0.5;
const float SEA_HI = 1.9;
const float DECK_LO = 4.4;
const float DECK_HI = 5.8;

// sky without the sun itself (also the colour distant clouds fade into)
vec3 acHaze(vec3 rd) {
  float y = rd.y;
  float az = max(dot(normalize(rd.xz), normalize(uSunDir.xz)), 0.0);
  // a hot band on the horizon, rose above it, then the dark sky under the deck
  vec3 sky = mix(uSkyHot, uSkyRose, smoothstep(0.0, 0.07, y));
  sky = mix(sky, uSkyTop, smoothstep(0.05, 0.3, y));
  // brighter toward the sun
  return sky * (0.5 + 1.0 * pow(az, 6.0));
}
vec3 acSky(vec3 rd) {
  float mu = dot(rd, uSunDir);
  vec3 sky = acHaze(rd);
  sky += uSunCol * (0.0015 * ntHG(mu, 0.85) + 0.025 * pow(max(mu, 0.0), 24.0));
  sky += uSunCol * 12.0 * smoothstep(0.99955, 0.9998, mu);
  return sky;
}

// light pillars: thin glowing columns standing in the cloud sea (analytic, no march)
vec3 acPillars(vec3 ro, vec3 rd, float tStop) {
  vec3 acc = vec3(0.0);
  vec2 d2 = rd.xz;
  float dd = max(dot(d2, d2), 1e-5);
  for (int i = 0; i < ${PILLARS}; i++) {
    vec4 P = uPil[i];
    float tc = dot(P.xy - ro.xz, d2) / dd;
    if (tc <= 0.0 || tc > tStop) continue;
    float dist = length(ro.xz + d2 * tc - P.xy);
    float y = ro.y + rd.y * tc;
    float top = SEA_HI + uPillarH * (0.75 + 0.5 * P.w);
    float hm = smoothstep(SEA_HI - 0.1, SEA_HI + 0.25, y) * (1.0 - smoothstep(top - 0.6 - uPillarH * 0.3, top, y));
    float w = P.z;
    float core = exp(-pow(dist / w, 2.0));
    float halo = exp(-pow(dist / (w * 5.0), 2.0)) * 0.22;
    acc += uPillarCol * (core + halo) * hm * (0.6 + 0.8 * uPilBand[i]);
  }
  return acc * uPillarI;
}

void main() {
  vec3 ro = uCamPos;
  vec3 rd = ntRay(ntUv());
  vec3 sky = acSky(rd);
  vec3 col = sky;
  float jit = ntIGN(ntPix());
  float tStop = 200.0;
  if (rd.y < -0.004) {
    // the cloud sea below
    Slab s = Slab(SEA_LO, SEA_HI, uSeaCov, 1.0, 0.1, 1.0, 0.03, 0.55, 0.9);
    float t0 = (SEA_HI - ro.y) / rd.y;
    float t1 = min((SEA_LO - ro.y) / rd.y, t0 + 6.0);
    if (t0 < 90.0) {
      float tHit;
      int steps = int(mix(44.0, 18.0, smoothstep(1.0, 30.0, t0)));
      vec4 c = ntMarch(ro, rd, t0, t1, s, uSunCol, uSeaAmbTop, uSeaAmbBot, 30.0, jit, steps, tHit);
      float tt = tHit > 0.0 ? tHit : t0;
      float fog = 1.0 - exp(-tt * 0.014);
      vec3 haze = acHaze(normalize(vec3(rd.x, 0.0, rd.z)));
      // through gaps in the sea: the ground in the clouds' shade, not more sky
      vec3 below = haze * vec3(0.22, 0.24, 0.3);
      col = mix(below * c.a + c.rgb, haze, fog);
      tStop = tt + 0.4;
    }
  } else if (rd.y > 0.004) {
    // the dark deck above, lit from underneath
    Slab s = Slab(DECK_LO, DECK_HI, uDeckCov, 1.4, 0.06, 0.7, 0.02, 0.45, 1.0);
    float t0 = (DECK_LO - ro.y) / rd.y;
    float t1 = min((DECK_HI - ro.y) / rd.y, t0 + 6.0);
    if (t0 < 110.0) {
      float tHit;
      int steps = int(mix(22.0, 14.0, smoothstep(4.0, 40.0, t0)));
      vec4 c = ntMarch(ro, rd, t0, t1, s, uSunCol * uDeckSun, uDeckAmbTop, uDeckAmbBot, 34.0, jit, steps, tHit);
      float tt = tHit > 0.0 ? tHit : t0;
      float fog = 1.0 - exp(-tt * 0.008);
      vec3 haze = acHaze(normalize(vec3(rd.x, 0.02, rd.z)));
      col = mix(sky * c.a + c.rgb, haze, fog);
      tStop = tt;
    }
  }
  // pillars stand in front of whatever the ray hits beyond them; the sea in front hides their feet
  col += acPillars(ro, rd, tStop);
  gl_FragColor = vec4(col, 1.0);
}
`;

export const aboveClouds: SceneDef = {
  id: 'above-clouds',
  name: 'Above the Clouds',
  description:
    'Flying just over a realistic sea of clouds at golden hour, under a dark deck lit from below by a sun on the horizon. Columns of light stand in the cloud sea: they rise with a build and blaze on the drop; kicks make the sea glow.',
  category: 'form',
  style: 'world',
  tags: ['euphoric', 'cinematic', 'epic', 'spacious', 'dreamy', 'uplifting', 'warm', 'ambient', 'nature', 'organic', 'realistic', 'emotional'],
  params,
  modulations: [],
  create(init) {
    const pil = Array.from({ length: PILLARS }, () => new THREE.Vector4());
    const extra = {
      uSunCol: { value: new THREE.Vector3() },
      uSkyHot: { value: new THREE.Vector3() },
      uSkyRose: { value: new THREE.Vector3() },
      uSkyTop: { value: new THREE.Vector3() },
      uSeaAmbTop: { value: new THREE.Vector3() },
      uSeaAmbBot: { value: new THREE.Vector3() },
      uDeckAmbTop: { value: new THREE.Vector3() },
      uDeckAmbBot: { value: new THREE.Vector3() },
      uPillarCol: { value: new THREE.Vector3() },
      uDeckSun: { value: 0.12 },
      uSeaCov: { value: 0.78 },
      uDeckCov: { value: 0.6 },
      uPillarH: { value: 0.3 },
      uPillarI: { value: 0.2 },
      uPil: { value: pil },
      uPilBand: { value: new Array(PILLARS).fill(0) },
    };
    const vol = new VolumePipeline({ init, params, fragment, clouds: true, extra });
    vol.scale = 0.38;
    const drop = new DropTimer();
    const wind = new THREE.Vector3();
    let glowS = 0;
    let buildS = 0;
    let detailT = 0;
    const bands = new Array(PILLARS).fill(0);
    const col = new THREE.Color();
    // fixed pillar layout, spread across the view; z = km ahead
    const layout = Array.from({ length: PILLARS }, (_, i) => {
      const h = Math.sin(i * 91.7) * 43758.5453;
      const r = h - Math.floor(h);
      return { u: (i + 0.5) / PILLARS - 0.5 + (r - 0.5) * 0.08, z: 6 + r * 11, w: 0.025 + r * 0.03, seed: r };
    });
    return {
      render(frame, target) {
        const dt = stepDt(frame);
        const a = frame.audio;
        const p = frame.params;
        const pal = frame.palette.c;
        drop.step(frame);
        const dEnv = drop.env;
        glowS = approach(glowS, a.kick * num(p, 'glow', 0.7), 12, dt);
        const feel = frame.feel;
        // tension also rises in the seconds before a drop the analysis knows about
        buildS = approach(buildS, Math.min(1, Math.max(0, a.build, feel.tension)), 3, dt);

        // camera: just above the sea, looking out to the horizon
        const fov = vol.fitCamera(frame.aspect, 46, 50);
        vol.camera.position.set(0, 2.55, 0);
        vol.camera.rotation.set((-2.5 * Math.PI) / 180, 0, 0, 'YXZ');
        const u = vol.march.uniforms;
        // the sun sits on the horizon ahead; the shared light slides it from left of centre to right over the song
        dirFromAngles(num(p, 'sun', 1.6), -14 * Math.cos(feel.light), u.uSunDir.value as THREE.Vector3);

        // fly forward over the sea (km/s)
        const rate = num(p, 'speed', 0.6) * tempoRate(frame) * (0.6 + 0.5 * a.energy + 0.6 * buildS);
        wind.z += dt * rate * 0.35;
        wind.x += dt * rate * 0.04 * feel.windX * (0.75 + 0.6 * feel.gust);
        detailT += dt * rate * 0.03;
        (u.uWind.value as THREE.Vector3).copy(wind);
        u.uDetailT.value = detailT;

        const sunI = 7 * (1 + 0.35 * glowS + 0.8 * dEnv);
        linColor(pal.accent, u.uSunCol.value as THREE.Vector3).multiplyScalar(sunI);
        col.copy(pal.fg).lerp(pal.accent, 0.35);
        linColor(col, u.uSkyHot.value as THREE.Vector3).multiplyScalar(1.4 * (1 + 0.3 * dEnv));
        linColor(pal.accent2, u.uSkyRose.value as THREE.Vector3).multiplyScalar(0.6);
        col.copy(pal.bg).lerp(pal.accent2, 0.12);
        linColor(col, u.uSkyTop.value as THREE.Vector3).multiplyScalar(0.12);
        col.copy(pal.accent2).lerp(pal.accent, 0.3);
        linColor(col, u.uSeaAmbTop.value as THREE.Vector3).multiplyScalar(0.4 * (1 + 0.6 * glowS));
        linColor(pal.muted, u.uSeaAmbBot.value as THREE.Vector3).multiplyScalar(0.15);
        linColor(pal.bg, u.uDeckAmbTop.value as THREE.Vector3).multiplyScalar(0.02);
        col.copy(pal.accent).lerp(pal.accent2, 0.5);
        linColor(col, u.uDeckAmbBot.value as THREE.Vector3).multiplyScalar(0.12 * (1 + 0.5 * glowS + 0.25 * a.snare + 0.8 * dEnv));
        col.copy(pal.fg).lerp(pal.accent, 0.25);
        linColor(col, u.uPillarCol.value as THREE.Vector3).multiplyScalar(1.6);
        u.uDeckSun.value = 0.08;
        (u.uMs.value as THREE.Vector2).set(0.3, 0.25);
        u.uSeaCov.value = num(p, 'sea', 0.78) + 0.04 * glowS;
        u.uDeckCov.value = num(p, 'deck', 0.62) - 0.08 * dEnv;

        // pillars: low and faint until a build lifts them; the drop makes them blaze
        const pk = num(p, 'pillars', 1);
        u.uPillarH.value = 0.3 + (2.2 * buildS + 1.6 * dEnv) * pk;
        u.uPillarI.value = (0.12 + 0.6 * buildS + 1.8 * dEnv + 0.15 * a.energy) * pk;
        const tanX = Math.tan((fov * Math.PI) / 360) * frame.aspect;
        const spec = a.spectrum;
        for (let i = 0; i < PILLARS; i++) {
          const L = layout[i];
          pil[i].set(L.u * 2 * tanX * L.z * 0.85, -L.z, L.w, L.seed);
          const bin = Math.floor(8 + (i / (PILLARS - 1)) * 90);
          bands[i] = approach(bands[i], spec ? spec[bin] ?? 0 : 0, 10, dt);
        }
        (u.uPilBand.value as number[]).splice(0, PILLARS, ...bands);

        const c = vol.composite.uniforms;
        c.uExposure.value = 0.7 * (1 + 0.1 * glowS + 0.15 * dEnv);
        c.uGrain.value = num(p, 'grain', 0.03);
        c.uSat.value = 1.05;
        c.uLift.value = 0.01;
        vol.render(frame, target);
      },
      dispose() {
        vol.dispose();
      },
    };
  },
};
