import * as THREE from 'three';

/**
 * GLSL helpers shared by the photo shader scenes. Appended after GLSL_COMMON, so it can use
 * luma/coverUv and the uImage* uniforms declared by buildSceneFragment.
 *
 * Tone mapping keeps the photo's tonality on both light and dark palettes:
 *  - light palette: shadows → accent (ink), highlights → bg (paper)
 *  - dark palette:  shadows → bg, highlights → accent
 */
export const PHOTO_GLSL = /* glsl */ `
float isLightBg() { return step(0.5, luma(uBg)); }
vec3 duoTone(float l) {
  return mix(mix(uBg, uAccent, l), mix(uAccent, uBg, l), isLightBg());
}
vec3 triTone(float l) {
  float lb = isLightBg();
  vec3 dk = mix(uBg, uFg, lb);
  vec3 lt = mix(uFg, uBg, lb);
  return l < 0.5 ? mix(dk, uAccent, l * 2.0) : mix(uAccent, lt, l * 2.0 - 1.0);
}
vec3 photo1(vec2 uv) { return texture2D(uImage, coverUv(uv, uImageSize, uAspect)).rgb; }
vec3 photo2(vec2 uv) { return texture2D(uImage2, coverUv(uv, uImage2Size, uAspect)).rgb; }
`;

/** Configure a texture made from a canvas/image for Hum (colour management is off app-wide). */
export function makePhotoTexture(source: HTMLCanvasElement): THREE.Texture {
  const tex = new THREE.CanvasTexture(source);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export function photoId(prefix = 'photo') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
