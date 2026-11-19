import * as THREE from 'three';
import type { ParamDef, SceneDef } from '../../core/types';
import { num } from '../../core/uniforms';
import { approach, stepDt } from '../three/common';
import { DropTimer, VolumePipeline, dirFromAngles, linColor, tempoRate } from './volume';

/**
 * Gilded Clouds: realistic volumetric cumulus lit by a low, golden sun on a dusty blue sky,
 * seen from the ground looking up. The bottom of the frame is the hazy horizon (calm for
 * lyrics), the big towers are overhead.
 *
 * Palette roles: bg = zenith sky, muted = horizon haze, fg = deep sky / shadow, accent = cloud
 * highlight, accent2 = the gold in the sunlight.
 */
const params: ParamDef[] = [
  { id: 'cover', label: 'Cloud cover', group: 'Shape', type: 'number', min: 0.2, max: 0.9, step: 0.01, default: 0.52 },
  { id: 'size', label: 'Cloud size', group: 'Shape', type: 'number', min: 0.5, max: 2, step: 0.01, default: 1 },
  { id: 'speed', label: 'Drift', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 0.7, hint: 'Follows the tempo' },
  { id: 'swell', label: 'Kick swell', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'The clouds swell and glow on the kick' },
  { id: 'dusk', label: 'Quiet dusk', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, hint: 'The sun sinks and the sky deepens in quiet parts' },
  { id: 'dropGlow', label: 'Drop sunburst', group: 'Reactivity', type: 'number', min: 0, max: 1.5, step: 0.01, default: 0.8 },
  { id: 'gold', label: 'Gold', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.85, hint: 'How golden the sunlight is' },
  { id: 'grain', label: 'Film grain', group: 'Color', type: 'number', min: 0, max: 0.1, step: 0.002, default: 0.03 },
];

const fragment = /* glsl */ `
uniform vec3 uSunCol, uZenith, uHorizon, uAmbTop, uAmbBot;
uniform float uCover, uDensity, uSize, uSunGlow, uErosion;

vec3 gcSky(vec3 rd) {
  float y = max(rd.y, 0.0);
  vec3 sky = mix(uHorizon, uZenith, pow(y, 0.42));
  float mu = dot(rd, uSunDir);
  // warm Mie glow around the sun, spreading low along the horizon
  sky += uSunCol * (0.012 * ntHG(mu, 0.8) + 0.04 * pow(max(mu, 0.0), 3.0) * (1.0 - y)) * uSunGlow;
  // sun disc
  sky += uSunCol * 40.0 * smoothstep(0.9997, 0.99985, mu);
  return sky;
}

void main() {
  vec3 ro = uCamPos;
  vec3 rd = ntRay(ntUv());
  vec3 sky = gcSky(rd);
  vec3 col = sky;
  Slab s = Slab(1.3, 3.6, uCover, uDensity, 0.075 / uSize, 0.9 / uSize, 0.018 / uSize, uErosion, 1.0);
  if (rd.y > 0.012) {
    float t0 = (s.lo - ro.y) / rd.y;
    float t1 = min((s.hi - ro.y) / rd.y, t0 + 14.0);
    if (t0 < 70.0) {
      float tHit;
      int steps = int(mix(48.0, 30.0, smoothstep(5.0, 40.0, t0)));
      vec4 c = ntMarch(ro, rd, t0, t1, s, uSunCol, uAmbTop, uAmbBot, 38.0, ntIGN(ntPix()), steps, tHit);
      // aerial perspective: distant clouds melt into the horizon haze
      float fog = 1.0 - exp(-max(tHit > 0.0 ? tHit : t0, 0.0) * 0.045);
      vec3 cl = mix(c.rgb, sky * (1.0 - c.a), fog);
      col = sky * c.a + cl;
    }
  }
  // haze band right on the horizon
  col = mix(col, uHorizon * 1.05, (1.0 - smoothstep(0.0, 0.06, rd.y)) * 0.6);
  gl_FragColor = vec4(col, 1.0);
}
`;

export const gildedClouds: SceneDef = {
  id: 'gilded-clouds',
  name: 'Gilded Clouds',
  description:
    'Realistic volumetric cumulus lit by a low golden sun on a dusty blue sky, seen from the ground looking up. The clouds swell and glow on the kick and drift with the tempo, the sun sinks and the sky deepens in quiet parts, a build piles them higher and the drop floods them with light. The hazy horizon along the bottom keeps lyrics readable.',
  category: 'form',
  style: 'world',
  tags: ['dreamy', 'calm', 'romantic', 'tender', 'ambient', 'spacious', 'warm', 'soft', 'nature', 'organic', 'acoustic', 'indie', 'realistic'],
  light: true,
  params,
  modulations: [{ source: 'sway', param: 'cover', amount: 0.02 }],
  create(init) {
    const extra = {
      uSunCol: { value: new THREE.Vector3() },
      uZenith: { value: new THREE.Vector3() },
      uHorizon: { value: new THREE.Vector3() },
      uAmbTop: { value: new THREE.Vector3() },
      uAmbBot: { value: new THREE.Vector3() },
      uCover: { value: 0.5 },
      uDensity: { value: 1 },
      uSize: { value: 1 },
      uSunGlow: { value: 1 },
      uErosion: { value: 0.6 },
    };
    const vol = new VolumePipeline({ init, params, fragment, clouds: true, extra });
    const drop = new DropTimer();
    const wind = new THREE.Vector3();
    let dusk = 0.5;
    let swellS = 0;
    let detailT = 0;
    const col = new THREE.Color();
    return {
      render(frame, target) {
        const dt = stepDt(frame);
        const a = frame.audio;
        const p = frame.params;
        const pal = frame.palette.c;
        drop.step(frame);
        const dEnv = drop.env * num(p, 'dropGlow', 0.8);
        const quiet = 1 - THREE.MathUtils.smoothstep(a.energy, 0.08, 0.55);
        dusk = approach(dusk, quiet * num(p, 'dusk', 0.7), 0.6, dt);
        swellS = approach(swellS, a.kick * num(p, 'swell', 1), 14, dt);
        const feel = frame.feel;
        // tension also rises in the seconds before a drop the analysis knows about, so the clouds pile up ahead of it
        const build = Math.min(1, Math.max(0, a.build, feel.tension));

        // camera: on the ground, tilted up so the frame's bottom edge sits just above the horizon
        const fov = vol.fitCamera(frame.aspect, 52, 64);
        const pitch = fov / 2 + 1.2;
        vol.camera.position.set(0, 0.03, 0);
        vol.camera.rotation.set((pitch * Math.PI) / 180, 0, 0, 'YXZ');

        // sun: low and golden; sinks toward dusk in quiet parts
        const u = vol.march.uniforms;
        // the shared light: behind-left early in the song, overhead-behind at its peak, behind-right by the end
        dirFromAngles(24 - 9 * dusk + 5 * Math.sin(feel.light), -180 - 30 * Math.cos(feel.light), u.uSunDir.value as THREE.Vector3);

        // drift with the tempo (km/s); a build pushes the wind
        const rate = num(p, 'speed', 0.7) * tempoRate(frame) * (0.6 + 0.5 * a.energy + 0.8 * build);
        // the shared wind decides which way they drift, and gusts push them along
        wind.x += dt * rate * 0.12 * feel.windX * (0.75 + 0.6 * feel.gust);
        wind.z += dt * rate * 0.03;
        detailT += dt * rate * 0.02;
        (u.uWind.value as THREE.Vector3).copy(wind);
        u.uDetailT.value = detailT;

        col.copy(pal.accent).lerp(pal.accent2, num(p, 'gold', 0.85));
        const sunI = 9 * (1 - 0.33 * dusk) * (1 + 0.25 * swellS + 1.3 * dEnv);
        linColor(col, u.uSunCol.value as THREE.Vector3).multiplyScalar(sunI);
        // the sky deepens in quiet parts
        col.copy(pal.bg).lerp(pal.fg, 0.18 + 0.4 * dusk);
        linColor(col, u.uZenith.value as THREE.Vector3).multiplyScalar(0.95);
        col.copy(pal.muted).lerp(pal.accent2, 0.15 + 0.2 * build);
        linColor(col, u.uHorizon.value as THREE.Vector3).multiplyScalar(1.3 - 0.5 * dusk);
        linColor(pal.bg, u.uAmbTop.value as THREE.Vector3).multiplyScalar(0.8 - 0.3 * dusk);
        col.copy(pal.fg).lerp(pal.bg, 0.4);
        linColor(col, u.uAmbBot.value as THREE.Vector3).multiplyScalar(0.35);
        u.uCover.value = num(p, 'cover', 0.52) + 0.07 * swellS + 0.1 * build - 0.05 * dEnv;
        u.uDensity.value = 1 + 0.25 * a.bass;
        u.uSize.value = num(p, 'size', 1);
        u.uSunGlow.value = 1 + 2 * dEnv;
        u.uErosion.value = 0.7;

        const c = vol.composite.uniforms;
        c.uExposure.value = 0.72 + 0.15 * swellS + 0.25 * dEnv;
        c.uGrain.value = num(p, 'grain', 0.03);
        c.uSat.value = 1.1;
        c.uLift.value = 0.02;
        vol.render(frame, target);
      },
      dispose() {
        vol.dispose();
      },
    };
  },
};
