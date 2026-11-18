/**
 * Post-effects library — stackable full-screen GLSL passes.
 * Each EffectDef.fragment is only `void main()` + helpers; the chain engine prepends
 * GLSL_HEADER, tInput / tPrev, one `u_<paramId>` uniform per param and GLSL_COMMON.
 */
import type { EffectDef } from '../core/types';
import { colorEffects } from './defs/color';
import { distortEffects } from './defs/distort';
import { glitchEffects } from './defs/glitch';
import { opticsEffects } from './defs/optics';
import { textureEffects } from './defs/texture';
import { timeEffects } from './defs/time';

export const effects: EffectDef[] = [
  ...textureEffects, // dither, halftone, ascii, pixelate, grain, edge
  ...colorEffects, // gradient-map, posterize, grade, flash
  ...opticsEffects, // chroma, bloom, crt, vignette
  ...distortEffects, // kaleido, mirror, displace, zoom-punch
  ...timeEffects, // trails, smear
  ...glitchEffects, // glitch
];
