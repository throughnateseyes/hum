/**
 * Taking frames out of a clip, for reading it. A clip is opened on one player of its own, one clip at
 * a time, and closed again, so the players the video uses are left alone.
 *
 *   FrameReader   a clip open for reading: put it on a second, then take the frame's picture (for the
 *                 depth model) and its brightness (for seeing what moved)
 *   takeTurn      wait until no other clip is being read
 */

/** the longest side the model's picture is taken at */
const PICTURE = 1288;
/** the longest side of the brightness picture and of the maps */
export const SMALL = 384;

/** the longest side of the picture lines are looked for in */
const FINE = 704;

const gone = () => new DOMException('Cancelled', 'AbortError');

/** the size kept of a picture of this shape: the longest side is SMALL, both even */
export function smallSize(w: number, h: number): [number, number] {
  const k = SMALL / Math.max(w, h);
  return [Math.max(2, Math.round((w * k) / 2) * 2), Math.max(2, Math.round((h * k) / 2) * 2)];
}

let turn: Promise<void> = Promise.resolve();
/** Runs `fn` once every earlier clip has been let go of. */
export function takeTurn<T>(fn: () => Promise<T>): Promise<T> {
  const mine = turn.then(fn);
  turn = mine.then(
    () => undefined,
    () => undefined,
  );
  return mine;
}

/** The brightness (0..255) of a picture on a canvas, rows bottom to top */
function brightness(g: CanvasRenderingContext2D, w: number, h: number): Float32Array {
  const d = g.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let p = (h - 1 - y) * w * 4;
    for (let x = 0, o = y * w; x < w; x++, p += 4) out[o + x] = 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
  }
  return out;
}

const sheet = (w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  return { c, g };
};

/** Shrinks pictures in two steps (one big step skips pixels and shimmers) */
export class Shrinker {
  readonly width: number;
  readonly height: number;
  private big: ReturnType<typeof sheet>;
  private small: ReturnType<typeof sheet>;
  private fine: ReturnType<typeof sheet> | null = null;

  constructor(w: number, h: number) {
    const k = Math.min(1, PICTURE / Math.max(w, h));
    this.big = sheet(Math.max(2, Math.round(w * k)), Math.max(2, Math.round(h * k)));
    [this.width, this.height] = smallSize(w, h);
    this.small = sheet(this.width, this.height);
  }

  take(src: CanvasImageSource) {
    this.big.g.drawImage(src, 0, 0, this.big.c.width, this.big.c.height);
  }

  /** the picture last taken, for the depth model */
  picture(): Promise<ImageBitmap> {
    return createImageBitmap(this.big.c);
  }

  /** the picture last taken, as brightness */
  luma(): Float32Array {
    const { c, g } = this.small;
    g.drawImage(this.big.c, 0, 0, c.width, c.height);
    return brightness(g, c.width, c.height);
  }

  /** the picture last taken, as a larger brightness picture: thin things (a cable, a kerb) still show in it */
  fineLuma(): { luma: Float32Array; width: number; height: number } {
    const { width: W, height: H } = this.big.c;
    const k = Math.min(1, FINE / Math.max(W, H));
    const w = Math.max(2, Math.round(W * k));
    const h = Math.max(2, Math.round(H * k));
    this.fine ??= sheet(w, h);
    this.fine.g.drawImage(this.big.c, 0, 0, w, h);
    return { luma: brightness(this.fine.g, w, h), width: w, height: h };
  }

  close() {
    for (const s of [this.big, this.small, this.fine]) if (s) s.c.width = s.c.height = 0;
  }
}

export class FrameReader {
  duration = 0;
  aspect = 16 / 9;
  shrinker!: Shrinker;
  private v = document.createElement('video');
  /** the second the frame on show starts at, when the browser said */
  private real = 0;
  /** what a seek costs lately, ms: clips with few whole frames decode a long run-up for each */
  private cost = 0;

  constructor(private signal?: AbortSignal) {}

  async open(url: string) {
    const v = this.v;
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    const ready = this.wait('loadeddata', 15000);
    v.src = url;
    await ready;
    this.duration = v.duration;
    this.aspect = v.videoWidth / Math.max(1, v.videoHeight);
    this.shrinker = new Shrinker(v.videoWidth, v.videoHeight);
  }

  /**
   * Put the clip on a second and take its frame. Answers with the second that frame really starts
   * at, when the browser says (a clip's frames rarely fall on round numbers), else the one asked for.
   * A little way ahead in a clip that is slow to seek, it is played up to instead.
   */
  async at(t: number): Promise<number> {
    const v = this.v;
    if (this.signal?.aborted) throw gone();
    const want = Math.max(0, Math.min(this.duration - 0.02, t));
    const ahead = want - v.currentTime;
    if (this.cost > 70 && ahead > 0.005 && ahead < 0.4 && !document.hidden) {
      const got = await this.playTo(want);
      if (got !== null) return (this.real = got);
    }
    let real = this.real;
    const began = performance.now();
    if (Math.abs(v.currentTime - want) > 1e-4 || v.seeking) {
      let shown: Promise<void> | null = null;
      if ('requestVideoFrameCallback' in v)
        shown = new Promise<void>((r) => {
          v.requestVideoFrameCallback((_now, meta) => {
            real = meta.mediaTime;
            r();
          });
        });
      const done = this.wait('seeked', 8000);
      v.currentTime = want;
      await done;
      // the picture follows the seek by a moment; a seek that lands on the same frame shows nothing new
      if (shown) await Promise.race([shown, new Promise<void>((r) => setTimeout(r, 70))]);
      this.cost = this.cost * 0.5 + (performance.now() - began) * 0.5;
    }
    if (this.signal?.aborted) throw gone();
    this.shrinker.take(v);
    this.real = Math.abs(real - want) < 0.2 ? real : want;
    return this.real;
  }

  /** play up to a second and take the first frame from there on; null if it didn't come, or too much went by */
  private playTo(t: number): Promise<number | null> {
    const { v } = this;
    if (!('requestVideoFrameCallback' in v)) return Promise.resolve(null);
    return new Promise((resolve) => {
      let over = false;
      const end = (got: number | null) => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        this.signal?.removeEventListener('abort', stop);
        v.pause();
        resolve(got);
      };
      const stop = () => end(null);
      const timer = setTimeout(() => end(null), 1200);
      this.signal?.addEventListener('abort', stop);
      const look = () =>
        v.requestVideoFrameCallback((_now, meta) => {
          if (over) return;
          if (meta.mediaTime < t - 0.016) {
            look();
            return;
          }
          if (meta.mediaTime > t + 0.06) end(null);
          else {
            this.shrinker.take(v);
            end(meta.mediaTime);
          }
        });
      look();
      v.play().catch(() => end(null));
    });
  }

  close() {
    this.v.pause();
    this.v.removeAttribute('src');
    this.v.load();
    this.shrinker?.close();
  }

  private wait(event: string, ms: number): Promise<void> {
    const { v, signal } = this;
    return new Promise((resolve, reject) => {
      const end = (fn: () => void) => {
        clearTimeout(timer);
        v.removeEventListener(event, ok);
        v.removeEventListener('error', bad);
        signal?.removeEventListener('abort', stop);
        fn();
      };
      const ok = () => end(resolve);
      const bad = () => end(() => reject(new Error('could not be opened')));
      const stop = () => end(() => reject(gone()));
      const timer = setTimeout(() => end(() => reject(new Error('timed out'))), ms);
      v.addEventListener(event, ok);
      v.addEventListener('error', bad);
      signal?.addEventListener('abort', stop);
    });
  }
}
