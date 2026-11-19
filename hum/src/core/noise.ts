import * as THREE from 'three';

/**
 * The shared noise texture (`uNoiseTex` in every shader): 256×256 of random values, read with
 * `tnoise` / `tnoise3` / `tfbm` (see core/glsl.ts). One texture read replaces the ~40 instructions of
 * a computed simplex noise, which is most of what the heavier scenes spend their time on.
 *
 * Red is random; green is red shifted by (37, 17), which is what lets `tnoise3` read two slices of 3D
 * noise in a single fetch; blue and alpha are two more independent channels.
 */
export const NOISE_SIZE = 256;

export function createNoiseTexture(): THREE.DataTexture {
  const n = NOISE_SIZE;
  const data = new Uint8Array(n * n * 4);
  // small deterministic generator, so every load (and every thumbnail) gets the same noise
  let a = 0x9e3779b9;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 24;
  };
  for (let i = 0; i < n * n; i++) {
    data[i * 4] = rand();
    data[i * 4 + 2] = rand();
    data[i * 4 + 3] = rand();
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) data[(y * n + x) * 4 + 1] = data[(((y + 17) % n) * n + ((x + 37) % n)) * 4];
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
