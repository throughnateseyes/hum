/// <reference lib="webworker" />
/**
 * Listens to a song and writes down the words it hears, with a time for each word. Runs Whisper
 * (base, multilingual) on this computer through transformers.js: the audio never leaves the machine.
 * The model downloads once (~95 MB) and the browser keeps it.
 *
 * in:  { audio: Float32Array (16 kHz mono), language?: string }
 * out: { type: 'download', frac } · { type: 'listening', frac } · { type: 'done', words } · { type: 'error', message }
 */
import { env, pipeline } from '@huggingface/transformers';

const MODEL = 'onnx-community/whisper-base_timestamped';
const RATE = 16000;
/** listen in windows a little under Whisper's 30 s, overlapping so no word is cut in half */
const WIN = 28;
const HOP = 24;

env.allowLocalModels = false;

type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string; chunks?: { text: string; timestamp: [number, number | null] }[] }>;
let asr: Asr | null = null;
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

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

self.onmessage = async (e: MessageEvent<{ audio: Float32Array; language?: string }>) => {
  try {
    const { audio, language } = e.data;
    const model = await load();
    const words: { t: number; end: number; text: string }[] = [];
    const total = audio.length / RATE;
    const loud = rms(audio, 0, audio.length);
    const starts: number[] = [];
    for (let s = 0; s < total - 1; s += HOP) starts.push(s);
    post({ type: 'listening', frac: 0 });
    for (let k = 0; k < starts.length; k++) {
      const s = starts[k];
      const a = Math.floor(s * RATE);
      const b = Math.min(audio.length, Math.floor((s + WIN) * RATE));
      // skip near-silent windows: nothing to hear, and Whisper makes things up in silence
      if (rms(audio, a, b) > loud * 0.12) {
        const out = await model(audio.subarray(a, b), { return_timestamps: 'word', ...(language ? { language } : {}) });
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
      post({ type: 'listening', frac: (k + 1) / starts.length });
    }
    post({ type: 'done', words });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
