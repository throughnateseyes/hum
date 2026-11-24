/**
 * One depth reading per clip and photo (src/depth reads them, in the background), and when they are
 * asked for: Make has the first look at every clip taken, and the footage look asks for the seconds its
 * inside shots show, the next ones first. A render waits for exactly what it draws.
 */
import type { ClipAsset, PhotoAsset } from '../core/types';
import type { ClipReader } from '../depth';
import type { ClipScene } from '../depth/types';
import { useStudio } from '../state/store';
import type { Reading } from './reading';

class One implements Reading {
  private reader: ClipReader | null = null;
  private photo: ClipScene | null = null;
  private opening: Promise<ClipReader | null> | null = null;
  private readonly stop = new AbortController();
  private readonly asset: ClipAsset | PhotoAsset;
  constructor(asset: ClipAsset | PhotoAsset) {
    this.asset = asset;
  }
  get scene(): ClipScene | null {
    return this.reader?.scene ?? this.photo;
  }
  open(): Promise<ClipReader | null> {
    return (this.opening ??= this.look().catch((err) => {
      if (!this.stop.signal.aborted) console.warn('[hum] a clip could not be read for depth', err);
      return null;
    }));
  }
  private async look(): Promise<ClipReader | null> {
    const d = await import('../depth');
    const opts = { signal: this.stop.signal };
    if ('url' in this.asset) this.reader = await d.readClip(this.asset, opts);
    else this.photo = await d.readPhoto(this.asset, opts);
    return this.reader;
  }
  async need(ranges: [number, number][]): Promise<void> {
    const r = await this.open();
    try {
      await r?.need(ranges);
    } catch {
      /* drawn without depth */
    }
  }
  close() {
    this.stop.abort();
    this.reader?.cancel();
  }
}

const kept = new Map<string, { asset: ClipAsset | PhotoAsset; one: One }>();

export function readingOf(asset: ClipAsset | PhotoAsset): Reading & { open(): Promise<unknown> } {
  const had = kept.get(asset.id);
  if (had) return had.one;
  const one = new One(asset);
  kept.set(asset.id, { asset, one });
  return one;
}

useStudio.subscribe((s, prev) => {
  if (s.clips === prev.clips && s.photos === prev.photos) return;
  const ids = new Set([...s.clips.map((c) => c.id), ...s.photos.map((p) => p.id)]);
  for (const [id, k] of kept)
    if (!ids.has(id)) {
      k.one.close();
      kept.delete(id);
    }
});
