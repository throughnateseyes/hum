/**
 * What the Part tab's Picture group (FootagePicture.tsx) reads: the person's clips and photos as one
 * list with small stills, and the value a look plays with for one of its scene's settings.
 */
import type { ClipAsset, ParamValue, PhotoAsset, Preset } from '../core/types';
import { getScene } from '../scenes';
import { useStudio } from '../state/store';

/** one clip or photo, as the picker and the framing preview need it */
export interface MediaItem {
  id: string;
  name: string;
  kind: 'clip' | 'photo';
  /** a small still: the clip's own thumb, or one drawn from the photo */
  thumb: string;
  width: number;
  height: number;
  /** seconds, for clips */
  duration?: number;
}

const photoThumbs = new WeakMap<object, string>();

/** a small square-ish JPEG of a photo, drawn once and kept for as long as the photo is */
function photoThumb(p: PhotoAsset): string {
  const had = photoThumbs.get(p.image);
  if (had) return had;
  const src = p.image;
  const w = 'naturalWidth' in src ? src.naturalWidth : src.width;
  const h = 'naturalHeight' in src ? src.naturalHeight : src.height;
  let url = '';
  try {
    // long side 240: big enough for the framing preview, small enough to draw at once
    const k = 240 / Math.max(1, w, h);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
    url = c.toDataURL('image/jpeg', 0.8);
  } catch {
    /* a photo that can't be drawn shows as an empty tile */
  }
  photoThumbs.set(p.image, url);
  return url;
}

const clipItem = (c: ClipAsset): MediaItem => ({ id: c.id, name: c.name, kind: 'clip', thumb: c.thumb, width: c.width, height: c.height, duration: c.duration });
const photoItem = (p: PhotoAsset): MediaItem => ({ id: p.id, name: p.name, kind: 'photo', thumb: photoThumb(p), width: p.width, height: p.height });

/** the person's clips, then their photos (the built-in stand-in photo isn't theirs to pick) */
export function useMedia(): MediaItem[] {
  const clips = useStudio((s) => s.clips);
  const photos = useStudio((s) => s.photos);
  return [...clips.map(clipItem), ...photos.filter((p) => !p.builtin).map(photoItem)];
}

/** the value a look plays with for one of its scene's settings: the person's tweak, the preset, the default */
export function lookParam(p: Preset, tweak: { sceneParams?: Record<string, ParamValue> } | undefined, k: string): ParamValue | undefined {
  return tweak?.sceneParams?.[k] ?? p.sceneParams?.[k] ?? getScene(p.sceneId)?.params.find((d) => d.id === k)?.default;
}
