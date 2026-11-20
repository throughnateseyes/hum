/// <reference lib="webworker" />
/**
 * Listens to a song and writes down the words it hears, with a time for each word. Runs Whisper
 * (base, multilingual) on this computer through transformers.js: the audio never leaves the machine.
 * The model downloads once (~95 MB) and the browser keeps it.
 *
 * in:  { type: 'listen', id, audio: Float32Array (16 kHz mono), language?: string } · { type: 'cancel', id }
 * out: { id, type: 'download', frac } · { id, type: 'listening', frac } · { id, type: 'done', words }
 *      · { id, type: 'cancelled' } · { id, type: 'error', message }
 *
 * Jobs run one at a time. A cancelled job stops at the next window (the model download, if it's
 * under way, still finishes and is kept, so the next song doesn't start it over).
 */
import { env, pipeline } from '@huggingface/transformers';

const MODEL = 'onnx-community/whisper-base_timestamped';
const RATE = 16000;
/** listen in windows a little under Whisper's 30 s, overlapping so no word is cut in half */
const WIN = 28;
const HOP = 24;
/** Whisper sometimes stops early in a window and misses a whole verse: gaps longer than this get a second listen */
const GAP = 7;
const MAX_RETRIES = 14;

env.allowLocalModels = false;

type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string; chunks?: { text: string; timestamp: [number, number | null] }[] }>;
let asr: Asr | null = null;
/** the job being worked on (its id goes on every message) */
let job = 0;
const post = (m: Record<string, unknown>) => (self as unknown as Worker).postMessage({ id: job, ...m });
const cancelled = new Set<number>();
class Cancelled extends Error {}
/** let a waiting cancel message in, then stop if it was for this job */
async function checkpoint(id: number) {
  await new Promise((r) => setTimeout(r, 0));
  if (cancelled.has(id)) throw new Cancelled();
}

async function load() {
  if (asr) return asr;
  const files = new Map<string, { loaded: number; total: number }>();
  const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
    if (p.status !== 'progress' || !p.file) return;
    files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
    let l = 0;
    let t = 0;
    for (const f of files.values()) {
      l += f.loaded;
      t += f.total;
    }
    if (t > 0) post({ type: 'download', frac: l / t });
  };
  const make = (opts: Record<string, unknown>) => pipeline('automatic-speech-recognition', MODEL, { progress_callback, ...opts }) as unknown as Promise<Asr>;
  const gpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
  try {
    // the encoder is the heavy part: on the GPU when there is one; the decoder is quick on the CPU
    asr = gpu
      ? await make({ device: { encoder_model: 'webgpu', decoder_model_merged: 'wasm' }, dtype: { encoder_model: 'fp16', decoder_model_merged: 'q8' } })
      : await make({ device: 'wasm', dtype: 'q8' });
  } catch (e) {
    if (!gpu) throw e;
    asr = await make({ device: 'wasm', dtype: 'q8' });
  }
  return asr;
}

function rms(a: Float32Array, from: number, to: number) {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

type Msg = { type: 'listen'; id: number; audio: Float32Array; language?: string } | { type: 'cancel'; id: number };
let queue: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  if (m.type === 'cancel') cancelled.add(m.id);
  else queue = queue.then(() => listen(m.id, m.audio, m.language));
};

async function listen(id: number, audio: Float32Array, language?: string) {
  job = id;
  try {
    await checkpoint(id);
    const model = await load();
    await checkpoint(id);
    const words: { t: number; end: number; text: string }[] = [];
    const total = audio.length / RATE;
    const loud = rms(audio, 0, audio.length);
    const starts: number[] = [];
    for (let s = 0; s < total - 1; s += HOP) starts.push(s);
    // a rough plan for progress: the windows, plus a few second listens
    const planned = starts.length + 4;
    post({ type: 'listening', frac: 0 });
    for (let k = 0; k < starts.length; k++) {
      const s = starts[k];
      const a = Math.floor(s * RATE);
      const b = Math.min(audio.length, Math.floor((s + WIN) * RATE));
      // skip near-silent windows: nothing to hear, and Whisper makes things up in silence
      if (rms(audio, a, b) > loud * 0.12) {
        const out = await model(audio.subarray(a, b), { return_timestamps: 'word', ...(language ? { language } : {}) });
        await checkpoint(id);
        // keep words from the middle of each window; the overlap belongs to whichever window sees it whole
        const lo = k === 0 ? -1 : s + (WIN - HOP) / 2;
        const hi = k === starts.length - 1 ? Infinity : s + WIN - (WIN - HOP) / 2;
        for (const c of out.chunks ?? []) {
          const t = s + c.timestamp[0];
          const end = s + (c.timestamp[1] ?? c.timestamp[0] + 0.3);
          const text = c.text.trim();
          if (text && t >= lo && t < hi) words.push({ t, end, text });
        }
      }
      post({ type: 'listening', frac: Math.min(0.95, (k + 1) / planned) });
    }
    // second listen: where nothing was heard for a while but there's sound, listen again from a
    // different starting point (Whisper's early stops depend on where the window starts)
    words.sort((x, y) => x.t - y.t);
    let tries = 0;
    for (let pass = 0; pass < 2 && tries < MAX_RETRIES; pass++) {
      const gaps: [number, number][] = [];
      const sounding = (a: number, b: number) => b - a > GAP && rms(audio, Math.floor(a * RATE), Math.floor(b * RATE)) > loud * 0.2;
      let prevEnd = 0;
      for (const w of words) {
        if (sounding(prevEnd, w.t)) gaps.push([prevEnd, w.t]);
        prevEnd = Math.max(prevEnd, w.end);
      }
      if (sounding(prevEnd, total)) gaps.push([prevEnd, total]);
      if (!gaps.length) break;
      for (const [a, b] of gaps) {
        let from = Math.max(0, a - 1.5);
        while (from < b - 2 && tries < MAX_RETRIES) {
          tries++;
          const lo = Math.floor(from * RATE);
          const hi = Math.min(audio.length, Math.floor((from + WIN) * RATE));
          const out = await model(audio.subarray(lo, hi), { return_timestamps: 'word', ...(language ? { language } : {}) });
          await checkpoint(id);
          let last = -1;
          for (const c of out.chunks ?? []) {
            const t = from + c.timestamp[0];
            const end = from + (c.timestamp[1] ?? c.timestamp[0] + 0.3);
            const text = c.text.trim();
            if (text && t > a + 0.05 && t < b - 0.05) {
              words.push({ t, end, text });
              last = Math.max(last, end);
            }
          }
          post({ type: 'listening', frac: Math.min(0.99, (starts.length + tries) / Math.max(planned, starts.length + tries + 1)) });
          // carry on from what was heard, or skip ahead if this listen heard nothing either
          from = last > from + 2 ? last - 1 : from + WIN - 6;
        }
      }
      words.sort((x, y) => x.t - y.t);
    }
    post({ type: 'done', words });
  } catch (err) {
    if (err instanceof Cancelled) post({ type: 'cancelled' });
    else post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    cancelled.delete(id);
  }
}
