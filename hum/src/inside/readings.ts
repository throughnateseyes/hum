/**
 * One depth reading per clip and photo (src/depth reads them, in the background), and when they are
 * asked for: Make has the first look at every clip taken, and the footage look asks for the seconds its
 * inside shots show, the next ones first. A render waits for exactly what it draws.
 */
import type { ClipAsset, PhotoAsset } from '../core/types';
import type { ClipReader, ReadProgress } from '../depth';
import type { ClipScene } from '../depth/types';
import { useStudio } from '../state/store';
import type { Reading } from './reading';

class One implements Reading {
  private reader: ClipReader | null = null;
  private photo: ClipScene | null = null;
  private opening: Promise<ClipReader | null> | null = null;
  private readonly stop = new AbortController();
  /** told how the first look is going, while somebody waits for it */
  private tell: ((p: ReadProgress) => void) | null = null;
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
    const opts = { signal: this.stop.signal, onProgress: (p: ReadProgress) => this.tell?.(p) };
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
  /** are these seconds read, with the first look done? */
  has(range: [number, number]): boolean {
    return this.reader ? this.reader.has([range]) : !!this.photo;
  }
  /**
   * Read these seconds for a render: says how it goes, tries again what failed before, and answers
   * whether it worked. What was asked for earlier is let finish first.
   */
  async read(ranges: [number, number][], say: (p: ReadProgress) => void): Promise<boolean> {
    if (this.opening && !(await this.opening) && !this.photo && !this.stop.signal.aborted) this.opening = null;
    this.tell = say;
    try {
      const r = await this.open();
      await r?.need(ranges, { onProgress: say });
      return !!this.scene;
    } catch (err) {
      if (!this.stop.signal.aborted) console.warn('[hum] a clip could not be read for depth', err);
      return false;
    } finally {
      if (this.tell === say) this.tell = null;
    }
  }
  close() {
    this.stop.abort();
    this.reader?.cancel();
  }
}

const kept = new Map<string, { asset: ClipAsset | PhotoAsset; one: One }>();

let held = false;
/** while a render draws, nothing is read ahead for the video on screen: it would change what the render draws from */
export const holdReading = (on: boolean) => {
  held = on;
};
export const readingHeld = () => held;

export function readingOf(asset: ClipAsset | PhotoAsset): Reading & Pick<One, 'open' | 'has' | 'read'> {
  const had = kept.get(asset.id);
  if (had) return had.one;
  const one = new One(asset);
  kept.set(asset.id, { asset, one });
  return one;
}

/** what is known of a clip or photo so far, without asking for it */
export const sceneOf = (id: string): ClipScene | null => kept.get(id)?.one.scene ?? null;

useStudio.subscribe((s, prev) => {
  if (s.clips === prev.clips && s.photos === prev.photos) return;
  const ids = new Set([...s.clips.map((c) => c.id), ...s.photos.map((p) => p.id)]);
  for (const [id, k] of kept)
    if (!ids.has(id)) {
      k.one.close();
      kept.delete(id);
    }
});
