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

/**
 * Analyse a decoded track off the main thread: overview, energy/band curves, BPM,
 * sections, drops, mood, tags, preset suggestions and a plain-English summary.
 * Typically well under 2 s for a 4-minute song.
 */
export async function analyzeTrack(buffer: AudioBuffer, presetTags: { id: string; tags: string[] }[]): Promise<TrackAnalysis> {
  const channel = toMono(buffer);
  const tags = presetTags.map((p) => ({ id: p.id, tags: [...(p.tags ?? [])] }));
  const request: AnalysisRequest = { channel, sampleRate: buffer.sampleRate, presetTags: tags };

  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }

  if (!worker) {
    // No worker support (rare): run inline on the main thread.
    const mod = await import('./analysis.worker');
    return mod.computeAnalysis(channel, request.sampleRate, tags);
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
    w.postMessage(request, [channel.buffer]);
  });
}
