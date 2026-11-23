/**
 * Bringing a video clip into Hum: read its size and length, take its colours from three frames across
 * it, and keep a small still for the library. The clip itself stays a file; looks open their own
 * player on it when they need one (see ClipAsset in core/types.ts).
 */
import type { ClipAsset } from '../core/types';
import { paletteFromPixels } from './palette';

const isVideo = (f: File) => f.type.startsWith('video/') || /\.(mp4|m4v|mov|webm)$/i.test(f.name);
export const looksLikeVideo = isVideo;

function waitFor(v: HTMLVideoElement, event: string, ms = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    v.addEventListener(event, done, { once: true });
    v.addEventListener('error', () => reject(new Error('could not be opened')), { once: true });
  });
}

/** `file` is a video (or a Blob of one, with a name to show) */
export async function loadClip(file: File | Blob, name = file instanceof File ? file.name : 'clip'): Promise<ClipAsset> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  try {
    v.src = url;
    await waitFor(v, 'loadeddata');
    if (!v.videoWidth || !Number.isFinite(v.duration) || v.duration <= 0) throw new Error('has no picture');
    // three frames across the clip, stacked: its colours and its brightness bands come from all of them
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 36 * 3;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    for (const [i, at] of [0.2, 0.5, 0.8].entries()) {
      v.currentTime = Math.min(v.duration - 0.05, v.duration * at);
      await waitFor(v, 'seeked');
      g.drawImage(v, 0, i * 36, 64, 36);
      if (i === 1) {
        // the middle frame is also the library's still
        const t = document.createElement('canvas');
        t.width = 240;
        t.height = Math.max(1, Math.round((240 * v.videoHeight) / v.videoWidth));
        t.getContext('2d')!.drawImage(v, 0, 0, t.width, t.height);
        c.dataset.thumb = t.toDataURL('image/jpeg', 0.72);
      }
    }
    return {
      id: `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: name.replace(/\.[^.]+$/, '') || 'clip',
      url,
      file,
      duration: v.duration,
      width: v.videoWidth,
      height: v.videoHeight,
      thumb: c.dataset.thumb ?? '',
      palette: paletteFromPixels(g.getImageData(0, 0, 64, 36 * 3).data),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw new Error(`Couldn’t open “${name}” as a video clip (${err instanceof Error ? err.message : 'unknown problem'}). Try an MP4 or MOV.`);
  } finally {
    v.removeAttribute('src');
    v.load();
  }
}
