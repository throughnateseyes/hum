/**
 * A clip's pictures for a frame-by-frame render, decoded in order instead of by seeking a player.
 *
 * Putting a player on a second makes the browser begin again at the whole picture before it and decode up
 * to it, every time. A render goes through a clip nearly in order, so this keeps one decoder running along
 * the file and takes each picture as it comes, a few ahead of where the render is, so decoding goes on
 * while the last frame is drawn. A jump begins again at the whole picture before it, as a seek would.
 *
 * It only stands in for the player where it gives the very same pictures: `proves` puts the player on a
 * few seconds of the clip, and the pictures and their times have to be the same to the byte. Any clip that
 * isn't, can't be read (mp4In.ts) or fails half way is played by seeking, as before.
 */
import { readMp4, type Mp4Video } from './mp4In';

/** pictures fed past the one wanted: some come out late, the rest is a head start */
const AHEAD = 8;
/** (fewer of very large ones) */
const AHEAD_LARGE = 4;
const LARGE = 4e6;
/** pictures kept that were just shown, for a step back */
const BEHIND = 2;
/** and at most this many, when one still hasn't come out */
const MOST_AHEAD = 24;
/** bytes read from the file at once */
const READ = 4 << 20;
/** decoders open at once over the page; the one left alone longest closes first */
const OPEN = 3;
/** how long one picture may take (ms) before the clip is given up on */
const SLOW_MS = 8000;

/** how often a player is asked before it is believed to show something else */
const TRIES = 3;

const open: FrameSource[] = [];
const verdicts = new WeakMap<Blob, boolean>();

export class FrameSource {
  private dec: VideoDecoder | null = null;
  private failed: unknown = null;
  /** the next picture to hand the decoder (in the file's order) */
  private next = 0;
  /** pictures shown before this one can't be trusted until the decoder begins again (µs) */
  private from = 0;
  /** the last one that came out (µs) */
  private out = -1;
  private flushed = false;
  /** who waits for the next one to come out */
  private wake: (() => void) | null = null;
  private readonly held = new Map<number, VideoFrame>();
  private bytes: { from: number; to: number; data: Promise<Uint8Array> }[] = [];
  private turn: Promise<unknown> = Promise.resolve();
  private gone = false;
  private busy = 0;
  /** the first picture worth keeping (µs) */
  private keep = 0;
  /** how far past the one wanted it feeds the decoder (more, once this clip has turned out to need it) */
  private ahead: number;
  /** the shown order's times */
  private readonly times: Float64Array;
  private readonly keys: number[] = [];
  /** where each whole picture's stretch begins (ticks), and the whole picture's place in the shown order */
  private readonly begins: { tick: number; place: number }[] = [];

  private constructor(
    private readonly file: Blob,
    private readonly v: Mp4Video,
  ) {
    this.times = Float64Array.from(v.order, (i) => v.pts[i]);
    v.key.forEach((k, i) => k && this.keys.push(i));
    const placeOf = new Uint32Array(v.order.length);
    v.order.forEach((i, place) => (placeOf[i] = place));
    this.keys.forEach((key, n) => {
      let first = Infinity;
      for (let i = key, end = this.keys[n + 1] ?? v.pts.length; i < end; i++) first = Math.min(first, v.pts[i]);
      this.begins.push({ tick: Math.round((first * v.scale) / 1e6), place: placeOf[key] });
    });
    this.ahead = (v.config.codedWidth ?? 0) * (v.config.codedHeight ?? 0) > LARGE ? AHEAD_LARGE : AHEAD;
  }

  /** null when this clip can't be decoded this way */
  static async open(file: Blob): Promise<FrameSource | null> {
    if (typeof VideoDecoder === 'undefined' || verdicts.get(file) === false) return null;
    try {
      const v = await readMp4(file);
      if (!v || !(await VideoDecoder.isConfigSupported(v.config)).supported) {
        verdicts.set(file, false);
        return null;
      }
      return new FrameSource(file, v);
    } catch {
      verdicts.set(file, false);
      return null;
    }
  }

  /** does it give what a player shows? (asked of the player itself, once per clip) */
  async proves(player: { show(t: number): Promise<VideoFrame | null>; duration: number }): Promise<boolean> {
    const had = verdicts.get(this.file);
    if (had !== undefined) return had;
    let good = false;
    try {
      good = true;
      for (const t of this.spots(player.duration - 0.1)) {
        const mine = await this.at(t);
        // (a player just opened can say it is there a moment before its picture is)
        for (let tries = 0; tries < TRIES; tries++) {
          const theirs = await player.show(t);
          good = !!theirs && (await alike(theirs, mine));
          theirs?.close();
          if (good) break;
        }
        mine.close();
        if (!good) break;
      }
    } catch {
      good = false;
    }
    verdicts.set(this.file, good);
    return good;
  }

  /** a few seconds spread over the clip that are quick to get to: just past a whole picture */
  private spots(end: number): number[] {
    const { keys } = this;
    const out: number[] = [];
    [0.05, 0.4, 0.75].forEach((share, n) => {
      const key = keys[Math.floor(share * keys.length)];
      // (within a clip that begins anew too seldom to have three, further on in the same stretch)
      const place = Math.min(this.times.length - 1, this.begins[keys.indexOf(key)].place + 3 + (keys.length < 3 ? n * 4 : 0));
      const t = (this.times[place] + this.v.lasts[this.v.order[place]] / 2) / 1e6;
      if (t < end) out.push(t);
    });
    return out.length ? out : [Math.max(0, end / 2)];
  }

  /** the place (in the shown order) of the picture on show at second t */
  place(t: number): number {
    const us = Math.floor(t * 1e6);
    let lo = 0;
    let hi = this.times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.times[mid] <= us) lo = mid;
      else hi = mid - 1;
    }
    // A player begins at a whole picture: the last one whose stretch has begun, counted in the file's own
    // ticks (so up to half a tick early), and a stretch begins at the first picture shown in it even if that
    // comes before the whole picture. It never shows anything before the picture it began at.
    const tick = Math.round((us * this.v.scale) / 1e6);
    let k = -1;
    for (let i = 0, j = this.begins.length - 1; i <= j; ) {
      const mid = (i + j) >> 1;
      if (this.begins[mid].tick <= tick) {
        k = mid;
        i = mid + 1;
      } else j = mid - 1;
    }
    return k < 0 ? lo : Math.max(lo, this.begins[k].place);
  }

  /** The picture on show at second t: the caller's own, to close. */
  at(t: number): Promise<VideoFrame> {
    this.busy++;
    const mine = this.turn.then(() => this.get(this.place(t))).finally(() => this.busy--);
    this.turn = mine.catch(() => undefined);
    return mine;
  }

  close() {
    this.gone = true;
    this.shut();
    this.wake?.();
  }

  private shut() {
    const i = open.indexOf(this);
    if (i >= 0) open.splice(i, 1);
    if (this.dec && this.dec.state !== 'closed') this.dec.close();
    this.dec = null;
    for (const f of this.held.values()) f.close();
    this.held.clear();
    this.bytes = [];
  }

  private start(key: number) {
    const i = open.indexOf(this);
    if (i >= 0) open.splice(i, 1);
    open.push(this);
    for (const other of [...open]) if (open.length > OPEN && other !== this && !other.busy) other.shut();
    if (!this.dec) {
      const dec = new VideoDecoder({
        output: (f) => {
          if (this.dec !== dec || f.timestamp < this.from || f.timestamp < this.keep) f.close();
          else {
            this.held.get(f.timestamp)?.close();
            this.held.set(f.timestamp, f);
          }
          if (this.dec === dec) this.out = Math.max(this.out, f.timestamp);
          this.wake?.();
        },
        error: (e) => {
          if (this.dec !== dec) return;
          // the browser takes back a decoder left alone for long (a render in a hidden tab): it opens again when asked
          if (!this.busy) return this.shut();
          this.failed = e;
          this.wake?.();
        },
      });
      this.dec = dec;
    } else this.dec.reset();
    this.dec.configure(this.v.config);
    for (const f of this.held.values()) f.close();
    this.held.clear();
    this.next = key;
    this.from = this.v.pts[key];
    this.out = -1;
    this.flushed = false;
  }

  private async get(place: number): Promise<VideoFrame> {
    const { v } = this;
    const sample = v.order[place];
    const ts = v.pts[sample];
    if (this.gone) throw new Error('closed');
    if (this.failed) throw this.failed;
    // what went by is let go
    this.keep = this.times[Math.max(0, place - BEHIND)];
    for (const [k, f] of this.held)
      if (k < this.keep) {
        f.close();
        this.held.delete(k);
      }
    // the whole picture to begin at: the last one shown no later than this one
    let key = 0;
    for (const k of this.keys) if (k <= sample && v.pts[k] <= ts) key = k;
    const passed = this.next > sample && !this.held.has(ts) && this.out >= ts;
    if (!this.dec || this.flushed || ts < this.from || passed || key > this.next) if (!(this.dec && this.held.has(ts))) this.start(key);
    const began = performance.now();
    for (;;) {
      if (this.gone) throw new Error('closed');
      if (this.failed) throw this.failed;
      const last = Math.min(v.size.length, sample + 1 + this.ahead);
      while (this.next < last && !this.flushed) {
        const i = this.next;
        const data = await this.read(i);
        if (this.gone || !this.dec) throw new Error('closed');
        if (this.failed) throw this.failed;
        this.dec.decode(new EncodedVideoChunk({ type: v.key[i] ? 'key' : 'delta', timestamp: v.pts[i], duration: v.lasts[i], data }));
        this.next = i + 1;
      }
      const f = this.held.get(ts);
      // (a copy, which costs no pixels: another clip may have this one's decoder shut at any moment)
      if (f) return f.clone();
      if (performance.now() - began > SLOW_MS) throw new Error('the decoder stopped');
      if (this.next >= v.size.length && !this.flushed) {
        this.flushed = true;
        await this.dec!.flush();
        if (!this.held.has(ts)) throw new Error('a picture is missing');
        continue;
      }
      // nothing left to decode and it hasn't come: the decoder is waiting for more
      if (this.dec!.decodeQueueSize === 0 && this.ahead < MOST_AHEAD) {
        const came = await this.nap(30);
        if (!came) this.ahead += 4;
      } else await this.nap(200);
    }
  }

  /** until something comes out of the decoder, or a moment has gone by */
  private nap(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const end = (came: boolean) => {
        clearTimeout(timer);
        this.wake = null;
        resolve(came);
      };
      const timer = setTimeout(() => end(false), ms);
      this.wake = () => end(true);
    });
  }

  /** picture i as it is in the file; the file is read a stretch at a time, the next one early */
  private async read(i: number): Promise<Uint8Array> {
    const at = this.v.offset[i];
    const end = at + this.v.size[i];
    let b = this.bytes.find((x) => at >= x.from && end <= x.to);
    if (!b) {
      const to = Math.min(this.file.size, Math.max(end, at + READ));
      b = { from: at, to, data: this.file.slice(at, to).arrayBuffer().then((x) => new Uint8Array(x)) };
      this.bytes.push(b);
      if (this.bytes.length > 2) this.bytes.shift();
    }
    return (await b.data).subarray(at - b.from, end - b.from);
  }
}

/** are two pictures the same, to the byte, and shown at the same moment? */
async function alike(a: VideoFrame, b: VideoFrame): Promise<boolean> {
  const shape = (f: VideoFrame) => {
    const x = f as VideoFrame & { rotation?: number; flip?: boolean };
    return JSON.stringify([f.timestamp, f.duration, f.format, f.codedWidth, f.codedHeight, f.displayWidth, f.displayHeight, f.visibleRect, f.colorSpace.primaries, f.colorSpace.matrix, f.colorSpace.fullRange, x.rotation ?? 0, x.flip ?? false]);
  };
  if (shape(a) !== shape(b)) return false;
  // (the browser calls the same picture's light curve by one name or another: then how it comes out says)
  if (!a.format || a.colorSpace.transfer !== b.colorSpace.transfer) return drawnAlike(a, b);
  const [x, y] = [new Uint8Array(a.allocationSize()), new Uint8Array(b.allocationSize())];
  await Promise.all([a.copyTo(x), b.copyTo(y)]);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** the same of pictures whose bytes can't be had (10 bits a colour): as drawn */
function drawnAlike(a: VideoFrame, b: VideoFrame): boolean {
  const drawn = (f: VideoFrame) => {
    const g = new OffscreenCanvas(f.displayWidth, f.displayHeight).getContext('2d', { willReadFrequently: true });
    g?.drawImage(f, 0, 0);
    return g && new Uint32Array(g.getImageData(0, 0, f.displayWidth, f.displayHeight).data.buffer);
  };
  const [x, y] = [drawn(a), drawn(b)];
  if (!x || !y || x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
