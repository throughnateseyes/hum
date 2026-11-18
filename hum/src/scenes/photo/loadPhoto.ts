import type { PhotoAsset } from '../../core/types';
import { makePhotoTexture, photoId } from './common';

const MAX_SIDE = 2048;

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

async function decode(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() };
    } catch {
      /* fall through to <img> (some formats only decode there) */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(`Couldn't decode "${file.name}" — try a JPEG, PNG or WebP.`);
  }
}

/** Decode a dropped image file, downscale it to ≤2048 px on the long side, and make a texture. */
export async function loadPhoto(file: File): Promise<PhotoAsset> {
  if (file.type && !file.type.startsWith('image/')) {
    throw new Error(`"${file.name}" is not an image.`);
  }
  const d = await decode(file);
  try {
    if (!d.width || !d.height) throw new Error(`"${file.name}" has no pixels.`);
    const s = Math.min(1, MAX_SIDE / Math.max(d.width, d.height));
    const w = Math.max(1, Math.round(d.width * s));
    const h = Math.max(1, Math.round(d.height * s));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(d.source, 0, 0, w, h);
    return {
      id: photoId(),
      name: file.name.replace(/\.[^.]+$/, '') || 'photo',
      texture: makePhotoTexture(canvas),
      image: canvas,
      width: w,
      height: h,
    };
  } finally {
    d.release();
  }
}
