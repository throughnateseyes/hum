/**
 * Small pictures of the person's media for Claude to look at, and what can be measured without Claude.
 *
 *   sampleClip    one contact sheet of a clip (six frames, their seconds written on), and how much it
 *                 moves, how bright it is and how much the camera shakes
 *   photoSheet    one sheet with up to six photos on it
 *   toJpeg        a canvas as a JPEG that fits in a request
 *
 * Only these small sheets ever leave the browser, never a file. A clip is opened on one player of its
 * own, one clip at a time, and closed again, so the players the video uses are left alone; the page
 * gets to breathe between frames.
 */
import type { ClipAsset, MediaMeasure, PhotoAsset } from '../core/types';

/** the longest side of a sheet, and the most base64 text one picture may be (the server allows 400k) */
const SHEET_EDGE = 1280;
const MAX_CHARS = 380_000;
/** frames on a clip's sheet */
const FRAMES = 6;
/** photos on one sheet */
export const PHOTOS_PER_SHEET = 6;
/** the size pictures are measured at */
const MW = 48;
const MH = 27;
/** seconds between the frames that are compared */
const STEP = 0.1;

export interface ClipSample {
  jpeg: string;
  /** the seconds of the frames on the sheet, in order */
  times: number[];
  measure: MediaMeasure;
}

export const breathe = () => new Promise<void>((r) => setTimeout(r, 0));

const stopIf = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
};

/** a canvas as base64 JPEG (no prefix), squeezed until it fits in a request */
export async function toJpeg(c: HTMLCanvasElement): Promise<string> {
  for (const q of [0.74, 0.6, 0.45, 0.3]) {
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', q));
    if (!blob) break;
    if (blob.size * 1.34 > MAX_CHARS) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    // in pieces: one call with every byte overflows the stack
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  throw new Error('a picture could not be made small enough');
}

/** let go of a canvas's memory now rather than when the browser gets to it */
export function letGo(c: HTMLCanvasElement) {
  c.width = 0;
  c.height = 0;
}

/** a label in the corner of a frame, readable on any picture */
export function label(g: CanvasRenderingContext2D, text: string, x: number, y: number) {
  g.font = '600 20px ui-monospace, Menlo, monospace';
  const w = g.measureText(text).width + 14;
  g.fillStyle = '#000';
  g.fillRect(x, y, w, 28);
  g.fillStyle = '#fff';
  g.textBaseline = 'middle';
  g.fillText(text, x + 7, y + 15);
}

const waitFor = (v: HTMLVideoElement, event: string, signal: AbortSignal | undefined, ms: number) =>
  new Promise<void>((resolve, reject) => {
    const end = (fn: () => void) => {
      clearTimeout(timer);
      v.removeEventListener(event, ok);
      v.removeEventListener('error', bad);
      signal?.removeEventListener('abort', stop);
      fn();
    };
    const ok = () => end(resolve);
    const bad = () => end(() => reject(new Error('could not be opened')));
    const stop = () => end(() => reject(new DOMException('Cancelled', 'AbortError')));
    const timer = setTimeout(() => end(() => reject(new Error('timed out'))), ms);
    v.addEventListener(event, ok);
    v.addEventListener('error', bad);
    signal?.addEventListener('abort', stop);
  });

async function seek(v: HTMLVideoElement, t: number, signal?: AbortSignal) {
  if (Math.abs(v.currentTime - t) < 1e-3 && !v.seeking) return;
  const done = waitFor(v, 'seeked', signal, 5000);
  v.currentTime = t;
  await done;
}

/** the picture on the player as brightness, small */
function grey(v: HTMLVideoElement, g: CanvasRenderingContext2D): Float32Array {
  g.drawImage(v, 0, 0, MW, MH);
  const d = g.getImageData(0, 0, MW, MH).data;
  const out = new Float32Array(MW * MH);
  for (let i = 0; i < out.length; i++) out[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
  return out;
}

const diff = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
};

/** how far the whole picture slid from a to b (in small pixels), by trying small slides */
function slide(a: Float32Array, b: Float32Array): [number, number] {
  let best = Infinity;
  let at: [number, number] = [0, 0];
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -4; dx <= 4; dx++) {
      let s = 0;
      for (let y = 4; y < MH - 4; y += 2) for (let x = 5; x < MW - 5; x += 2) s += Math.abs(a[y * MW + x] - b[(y + dy) * MW + x + dx]);
      // standing still wins a tie
      s += (Math.abs(dx) + Math.abs(dy)) * 0.02;
      if (s < best) {
        best = s;
        at = [dx, dy];
      }
    }
  return at;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** A clip's contact sheet and measures. `key` is what the sheet calls it (A, B, …). */
export async function sampleClip(c: Pick<ClipAsset, 'url'>, key: string, signal?: AbortSignal): Promise<ClipSample> {
  stopIf(signal);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  const small = document.createElement('canvas');
  const sheet = document.createElement('canvas');
  try {
    const ready = waitFor(v, 'loadeddata', signal, 10000);
    v.src = c.url;
    await ready;
    const d = Math.max(0.2, v.duration);
    const aspect = v.videoWidth / Math.max(1, v.videoHeight);
    // a wide clip's frames go in two rows of three, a tall one's in one row of six
    const cols = aspect > 1 ? 3 : 6;
    const rows = FRAMES / cols;
    const cw = Math.floor(SHEET_EDGE / cols);
    const ch = Math.min(Math.floor(SHEET_EDGE / rows), Math.round(cw / aspect));
    sheet.width = cw * cols;
    sheet.height = ch * rows;
    small.width = MW;
    small.height = MH;
    const g = sheet.getContext('2d')!;
    const sg = small.getContext('2d', { willReadFrequently: true })!;
    const n = Math.max(FRAMES, Math.min(9, Math.round(d)));
    const onSheet = Array.from({ length: FRAMES }, (_, i) => Math.round((i * (n - 1)) / (FRAMES - 1)));
    const times: number[] = [];
    const at: number[] = [];
    const motion: number[] = [];
    let bright = 0;
    let shake = 0;
    for (let i = 0; i < n; i++) {
      const t = Math.max(0, Math.min(d - 0.3, d * (0.03 + (0.92 * i) / (n - 1))));
      await seek(v, t, signal);
      const f0 = grey(v, sg);
      const k = onSheet.indexOf(i);
      if (k >= 0) {
        const x = (k % cols) * cw;
        const y = Math.floor(k / cols) * ch;
        g.drawImage(v, x, y, cw, ch);
        label(g, `${key} ${t.toFixed(1)}s`, x, y);
        times.push(r2(t));
      }
      await seek(v, t + STEP, signal);
      const f1 = grey(v, sg);
      await seek(v, t + STEP * 2, signal);
      const f2 = grey(v, sg);
      at.push(r2(t));
      // a tenth of a second that changes the picture by 6% on average is a lot of movement
      motion.push(r2(Math.min(1, (diff(f0, f1) + diff(f1, f2)) / 2 / 0.06)));
      const a = slide(f0, f1);
      const b = slide(f1, f2);
      shake += Math.hypot(b[0] - a[0], b[1] - a[1]);
      bright += f0.reduce((s, x) => s + x, 0) / f0.length;
      await breathe();
    }
    return { jpeg: await toJpeg(sheet), times, measure: { at, motion, bright: r2(bright / n), shake: r2(Math.min(1, shake / n / 2.5)) } };
  } finally {
    v.removeAttribute('src');
    v.load();
    letGo(small);
    letGo(sheet);
  }
}

/** Up to six photos on one sheet, each whole, with its key in the corner, and how bright each is */
export async function photoSheet(photos: { photo: PhotoAsset; key: string }[], signal?: AbortSignal): Promise<{ jpeg: string; bright: number[] }> {
  stopIf(signal);
  const cols = Math.min(3, photos.length);
  const rows = Math.ceil(photos.length / cols);
  const cw = Math.floor(Math.min(SHEET_EDGE / cols, 640));
  const ch = Math.floor(Math.min(SHEET_EDGE / rows, cw * 0.8));
  const c = document.createElement('canvas');
  const small = document.createElement('canvas');
  try {
    c.width = cw * cols;
    c.height = ch * rows;
    small.width = 16;
    small.height = 16;
    const g = c.getContext('2d')!;
    const sg = small.getContext('2d', { willReadFrequently: true })!;
    g.fillStyle = '#777';
    g.fillRect(0, 0, c.width, c.height);
    const bright: number[] = [];
    for (const [i, { photo, key }] of photos.entries()) {
      const x = (i % cols) * cw;
      const y = Math.floor(i / cols) * ch;
      const k = Math.min(cw / photo.width, ch / photo.height);
      const w = photo.width * k;
      const h = photo.height * k;
      g.drawImage(photo.image, x + (cw - w) / 2, y + (ch - h) / 2, w, h);
      label(g, key, x + (cw - w) / 2, y + (ch - h) / 2);
      sg.drawImage(photo.image, 0, 0, 16, 16);
      const d = sg.getImageData(0, 0, 16, 16).data;
      let s = 0;
      for (let p = 0; p < d.length; p += 4) s += (0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]) / 255;
      bright.push(r2(s / 256));
      await breathe();
      stopIf(signal);
    }
    return { jpeg: await toJpeg(c), bright };
  } finally {
    letGo(c);
    letGo(small);
  }
}
