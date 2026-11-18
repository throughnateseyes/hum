import type { TrackAnalysis } from '../core/types';
import type { AnalysisReply, AnalysisRequest } from './analysis.worker';

/** Mix an AudioBuffer down to a fresh mono Float32Array (safe to transfer). */
function toMono(buffer: AudioBuffer): Float32Array {
  const n = buffer.length;
  const ch = buffer.numberOfChannels;
  const out = new Float32Array(n);
  if (ch === 1) {
    buffer.copyFromChannel(out, 0);
    return out;
  }
  const tmp = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    buffer.copyFromChannel(tmp, c);
    for (let i = 0; i < n; i++) out[i] += tmp[i];
  }
  const inv = 1 / ch;
  for (let i = 0; i < n; i++) out[i] *= inv;
  return out;
}

/** (L − R) / 2 for stereo files — lets the analysis tell a centred voice from wide synths. null for mono. */
function toSide(buffer: AudioBuffer): Float32Array | null {
  if (buffer.numberOfChannels < 2) return null;
  const n = buffer.length;
  const out = new Float32Array(n);
  const r = new Float32Array(n);
  buffer.copyFromChannel(out, 0);
  buffer.copyFromChannel(r, 1);
  for (let i = 0; i < n; i++) out[i] = (out[i] - r[i]) * 0.5;
  return out;
}

/**
 * Analyse a decoded track off the main thread: overview, energy/band curves, BPM, the song taken
 * apart into layers (drum hits, bass and lead notes, vocals), sections, drops with their size,
 * genre / instruments / mood, tags, preset suggestions and a plain-English summary.
 * Typically 1–2 s for a 4-minute song.
 */
export async function analyzeTrack(buffer: AudioBuffer, presetTags: { id: string; tags: string[] }[]): Promise<TrackAnalysis> {
  const channel = toMono(buffer);
  const side = toSide(buffer);
  const tags = presetTags.map((p) => ({ id: p.id, tags: [...(p.tags ?? [])] }));
  const request: AnalysisRequest = { channel, sampleRate: buffer.sampleRate, presetTags: tags, side };

  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }

  if (!worker) {
    // No worker support (rare): run inline on the main thread.
    const mod = await import('./analysis.worker');
    return mod.computeAnalysis(channel, request.sampleRate, tags, side);
  }

  const w = worker;
  return new Promise<TrackAnalysis>((resolve, reject) => {
    w.onmessage = (e: MessageEvent<AnalysisReply>) => {
      w.terminate();
      if (e.data.ok) resolve(e.data.analysis);
      else reject(new Error(`Track analysis failed: ${e.data.error}`));
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(`Track analysis worker error: ${e.message || 'unknown'}`));
    };
    w.postMessage(request, side ? [channel.buffer, side.buffer] : [channel.buffer]);
  });
}
