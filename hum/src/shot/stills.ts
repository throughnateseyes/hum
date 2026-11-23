/**
 * Stills of the person's pictures, for the treatments that lay several of them out at once (Collage,
 * Trace), and the anchor points Trace draws its lines between.
 *
 *   grabStill   a video clip's frame at full size (a fixed moment of it, so a render and the live
 *               picture cut the same frame), opened on a player of its own and closed again
 *   anchorsOf   the points of a picture worth pointing at: its brightest spots and its strongest
 *               corners, found once on a small copy (about 64 px) and kept with the picture
 */
import * as THREE from 'three';

/** a point of a picture, 0..1 from its bottom-left (texture space) */
export type Anchor = [number, number];

/** the longest side a grabbed still is kept at */
const STILL_SIDE = 1280;
/** where in the clip the still is taken (a share of its length) */
const STILL_AT = 0.35;

/** a canvas as a texture the shaders read like any picture */
export function canvasTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** one frame of a clip at full size (up to 1280 px on its long side), with its anchors */
export function grabStill(url: string): Promise<{ texture: THREE.CanvasTexture; anchors: Anchor[] }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    const done = () => {
      v.removeAttribute('src');
      v.load();
    };
    v.addEventListener('error', () => {
      done();
      reject(new Error('That clip could not be opened.'));
    });
    v.addEventListener(
      'loadeddata',
      () => {
        v.addEventListener(
          'seeked',
          () => {
            const k = Math.min(1, STILL_SIDE / Math.max(v.videoWidth, v.videoHeight, 1));
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(v.videoWidth * k));
            c.height = Math.max(1, Math.round(v.videoHeight * k));
            c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
            done();
            resolve({ texture: canvasTexture(c), anchors: anchorsOf(c, c.width, c.height) });
          },
          { once: true },
        );
        v.currentTime = Math.max(0, (v.duration || 0) * STILL_AT);
      },
      { once: true },
    );
    v.src = url;
    v.load();
  });
}

/**
 * Up to four points of a picture worth pointing at, best first: local peaks of a corner measure
 * (Harris) and of brightness, on a small copy, kept apart from each other and off the edges.
 */
export function anchorsOf(src: CanvasImageSource, w: number, h: number): Anchor[] {
  const side = 64;
  const k = side / Math.max(w, h, 1);
  const cw = Math.max(8, Math.round(w * k));
  const ch = Math.max(8, Math.round(h * k));
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return [];
  g.drawImage(src, 0, 0, cw, ch);
  const px = g.getImageData(0, 0, cw, ch).data;
  const L = new Float32Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) L[i] = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255;
  const at = (x: number, y: number) => L[Math.min(ch - 1, Math.max(0, y)) * cw + Math.min(cw - 1, Math.max(0, x))];
  // the corner measure over a 5 x 5 window, and brightness softened over the same
  const score = new Float32Array(cw * ch);
  let top = 1e-6;
  const bright = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      let xx = 0;
      let yy = 0;
      let xy = 0;
      let b = 0;
      for (let j = -2; j <= 2; j++)
        for (let i = -2; i <= 2; i++) {
          const gx = at(x + i + 1, y + j) - at(x + i - 1, y + j);
          const gy = at(x + i, y + j + 1) - at(x + i, y + j - 1);
          xx += gx * gx;
          yy += gy * gy;
          xy += gx * gy;
          b += at(x + i, y + j);
        }
      const r = xx * yy - xy * xy - 0.05 * (xx + yy) ** 2;
      score[y * cw + x] = Math.max(0, r);
      top = Math.max(top, r);
      bright[y * cw + x] = b / 25;
    }
  type Cand = { x: number; y: number; s: number };
  const cands: Cand[] = [];
  const edge = 0.1;
  for (let y = 1; y < ch - 1; y++)
    for (let x = 1; x < cw - 1; x++) {
      const u = x / (cw - 1);
      const v = y / (ch - 1);
      if (u < edge || u > 1 - edge || v < edge || v > 1 - edge) continue;
      const i = y * cw + x;
      let peakS = true;
      let peakB = true;
      for (let j = -1; j <= 1; j++)
        for (let q = -1; q <= 1; q++) {
          if (!q && !j) continue;
          if (score[i + j * cw + q] > score[i]) peakS = false;
          if (bright[i + j * cw + q] > bright[i]) peakB = false;
        }
      if (peakS && score[i] > top * 0.04) cands.push({ x, y, s: score[i] / top });
      if (peakB && bright[i] > 0.35) cands.push({ x, y, s: bright[i] * 0.8 });
    }
  cands.sort((a, b) => b.s - a.s || a.y - b.y || a.x - b.x);
  const out: Anchor[] = [];
  const apart = 0.2;
  for (const cd of cands) {
    const p: Anchor = [cd.x / (cw - 1), 1 - cd.y / (ch - 1)];
    if (out.some((o) => Math.hypot((o[0] - p[0]) * (cw / ch), o[1] - p[1]) < apart)) continue;
    out.push(p);
    if (out.length >= 4) break;
  }
  // a flat picture with nothing to point at: thirds
  const fill: Anchor[] = [
    [0.36, 0.62],
    [0.66, 0.38],
    [0.62, 0.7],
    [0.34, 0.3],
  ];
  for (const f of fill) if (out.length < 3) out.push(f);
  return out;
}
