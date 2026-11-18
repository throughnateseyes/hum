import { defineShaderScene } from '../core/sceneHelpers';
import type { CustomShaderSpec, SceneDef } from '../core/types';

/** Turn an AI- or user-written fragment shader into a live scene. */
export function makeCustomShaderScene(spec: CustomShaderSpec): SceneDef {
  return defineShaderScene({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    category: 'code',
    tags: ['custom', 'generated'],
    params: spec.params,
    modulations: spec.modulations,
    feedback: /\btPrev\b/.test(spec.fragment),
    fragment: spec.fragment,
  });
}

export const CUSTOM_SHADER_EXAMPLE = /* glsl */ `void main() {
  vec2 uv = vUv;
  vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
  float r = length(p);
  float a = atan(p.y, p.x);
  float rings = sin(r * u_density - uTime * 2.0 - uBass * 6.0);
  float spokes = spectrum(fract(a / TAU + 0.5)) * (0.6 + uKick);
  float m = smoothstep(0.02, 0.0, abs(rings) * r - spokes * 0.05);
  vec3 col = mix(uBg, uAccent, m);
  col = mix(col, uAccent2, smoothstep(0.35 + uEnergy * 0.2, 0.0, r) * uKick);
  gl_FragColor = vec4(col, 1.0);
}`;
