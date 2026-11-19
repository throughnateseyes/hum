/**
 * Turning rendered frames and the song's samples into an MP4 in the browser (WebCodecs): H.264 video,
 * AAC sound, muxed by mp4.ts. No libraries, no upload; everything stays on this computer.
 */
import { Mp4Muxer } from './mp4';

const AUDIO_RATE = 48000;
const AUDIO_BITRATE = 192_000;
/** a short fade in and out so the cut doesn't click (as the live clip export does) */
const FADE_IN = 0.04;
const FADE_OUT = 0.35;

/** H.264 levels: the largest frame (macroblocks), macroblocks a second and High-profile bitrate (bits/s) each allows */
const LEVELS: { id: number; fs: number; mbps: number; br: number }[] = [
  { id: 0x1f, fs: 3600, mbps: 108000, br: 17.5e6 },
  { id: 0x20, fs: 5120, mbps: 216000, br: 25e6 },
  { id: 0x28, fs: 8192, mbps: 245760, br: 25e6 },
  { id: 0x2a, fs: 8704, mbps: 522240, br: 62.5e6 },
  { id: 0x32, fs: 22080, mbps: 589824, br: 168.75e6 },
  { id: 0x33, fs: 36864, mbps: 983040, br: 300e6 },
  { id: 0x34, fs: 36864, mbps: 2073600, br: 300e6 },
];

/** about 18 Mbps for 1080p at 30 fps, scaled by the picture's area and a little more for 60 fps */
export function videoBitrate(w: number, h: number, fps: number): number {
  const v = 18e6 * ((w * h) / (1920 * 1080)) * (fps > 30 ? 1.35 : 1);
  return Math.round(Math.min(28e6, Math.max(6e6, v)));
}

/** the smallest H.264 level that fits this size, frame rate and bitrate */
export function avcLevel(w: number, h: number, fps: number, bitrate: number): number {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const lv = LEVELS.find((l) => mbs <= l.fs && mbs * fps <= l.mbps && bitrate <= l.br) ?? LEVELS[LEVELS.length - 1];
  return lv.id;
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

/** a VideoEncoder config this browser can do for w×h at fps: High profile first, then Main, then Baseline */
export async function videoConfig(w: number, h: number, fps: number): Promise<VideoEncoderConfig | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  const bitrate = videoBitrate(w, h, fps);
  const level = avcLevel(w, h, fps, bitrate);
  const tries: string[] = [];
  for (const profile of ['6400', '4d00', '4200']) {
    tries.push(`avc1.${profile}${hex2(level)}`);
    // a level up, in case the encoder is fussy about the edge of the table
    const up = LEVELS.find((l) => l.id > level);
    if (up) tries.push(`avc1.${profile}${hex2(up.id)}`);
  }
  for (const codec of tries) {
    for (const hw of ['no-preference', 'prefer-software'] as HardwareAcceleration[]) {
      const cfg: VideoEncoderConfig = {
        codec,
        width: w,
        height: h,
        bitrate,
        bitrateMode: 'variable',
        framerate: fps,
        latencyMode: 'quality',
        hardwareAcceleration: hw,
        avc: { format: 'avc' },
      };
      try {
        const r = await VideoEncoder.isConfigSupported(cfg);
        if (r.supported) return r.config ?? cfg;
      } catch {
        /* try the next */
      }
    }
  }
  return null;
}

export function audioConfig(): AudioEncoderConfig {
  return { codec: 'mp4a.40.2', sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate: AUDIO_BITRATE };
}

/** Can this browser make videos without playing them (H.264 + AAC through WebCodecs)? Null when yes, else why not. */
export async function offlineBlocker(): Promise<string | null> {
  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined' || typeof VideoFrame === 'undefined') return "This browser can't encode video by itself (no WebCodecs).";
  try {
    const a = await AudioEncoder.isConfigSupported(audioConfig());
    if (!a.supported) return "This browser can't write AAC sound.";
  } catch {
    return "This browser can't write AAC sound.";
  }
  if (!(await videoConfig(1080, 1920, 30))) return "This browser can't write H.264 video.";
  return null;
}

/** the song's sound for one stretch, encoded once and shared by every size of a render */
export interface EncodedAudio {
  chunks: Uint8Array[];
  asc: Uint8Array;
  /** encoder delay in samples, skipped by the file's edit list */
  priming: number;
  /** the real length in samples */
  length: number;
}

/** the song from `start` to `end` (s) at 48 kHz stereo, with the fades */
export function sliceSong(buf: { channels: Float32Array[]; sampleRate: number }, start: number, end: number): Float32Array[] {
  const n = Math.max(1, Math.round((end - start) * AUDIO_RATE));
  const src = buf.channels;
  const ratio = buf.sampleRate / AUDIO_RATE;
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let c = 0; c < 2; c++) {
    const ch = src[Math.min(c, src.length - 1)];
    const o = out[c];
    const s0 = start * buf.sampleRate;
    for (let i = 0; i < n; i++) {
      const x = s0 + i * ratio;
      const j = Math.floor(x);
      const f = x - j;
      const a = j >= 0 && j < ch.length ? ch[j] : 0;
      const b = j + 1 >= 0 && j + 1 < ch.length ? ch[j + 1] : 0;
      o[i] = ratio === 1 ? a : a + (b - a) * f;
    }
  }
  const fi = Math.round(FADE_IN * AUDIO_RATE);
  const fo = Math.min(n, Math.round(FADE_OUT * AUDIO_RATE));
  for (const o of out) {
    for (let i = 0; i < Math.min(fi, n); i++) o[i] *= i / fi;
    for (let i = 0; i < fo; i++) o[n - 1 - i] *= i / fo;
  }
  return out;
}

/** raw AAC frames for the samples, and the stream description */
async function aacFrames(pcm: Float32Array[]): Promise<{ chunks: Uint8Array[]; asc: Uint8Array }> {
  const chunks: Uint8Array[] = [];
  let asc: Uint8Array | null = null;
  let error: unknown = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      const d = new Uint8Array(chunk.byteLength);
      chunk.copyTo(d);
      chunks.push(d);
      const desc = meta?.decoderConfig?.description;
      if (desc && !asc) asc = toBytes(desc);
    },
    error: (e) => {
      error = e;
    },
  });
  enc.configure(audioConfig());
  const n = pcm[0].length;
  const block = 1024 * 8;
  for (let i = 0; i < n; i += block) {
    const len = Math.min(block, n - i);
    const data = new Float32Array(len * 2);
    data.set(pcm[0].subarray(i, i + len), 0);
    data.set(pcm[1].subarray(i, i + len), len);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: AUDIO_RATE, numberOfFrames: len, numberOfChannels: 2, timestamp: Math.round((i / AUDIO_RATE) * 1e6), data });
    enc.encode(ad);
    ad.close();
  }
  await enc.flush();
  enc.close();
  if (error) throw error;
  // AAC-LC, 48 kHz, stereo: the usual AudioSpecificConfig if the encoder didn't hand one over
  return { chunks, asc: asc ?? new Uint8Array([0x11, 0x90]) };
}

let priming: Promise<number> | null = null;
/**
 * How many samples of silence this browser's AAC encoder puts in front (2112 on a Mac, 1024 with
 * some encoders): a click is encoded, decoded again and found. Measured once; the file's edit list
 * skips them so the sound lines up with the picture to the sample.
 */
function encoderDelay(): Promise<number> {
  priming ??= (async () => {
    const at = 4800;
    const n = AUDIO_RATE / 2;
    const L = new Float32Array(n);
    for (let i = 0; i < 32; i++) L[at + i] = 0.9;
    const { chunks, asc } = await aacFrames([L, L]);
    const out: Float32Array[] = [];
    const dec = new AudioDecoder({
      output: (d) => {
        const f = new Float32Array(d.numberOfFrames);
        d.copyTo(f, { planeIndex: 0, format: 'f32-planar' });
        out.push(f);
        d.close();
      },
      error: () => {},
    });
    dec.configure({ codec: 'mp4a.40.2', sampleRate: AUDIO_RATE, numberOfChannels: 2, description: asc });
    chunks.forEach((c, i) => dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round((i * 1024 * 1e6) / AUDIO_RATE), data: c })));
    await dec.flush();
    dec.close();
    let pos = 0;
    for (const f of out) {
      for (let i = 0; i < f.length; i++) if (Math.abs(f[i]) > 0.3) return Math.max(0, Math.min(4096, pos + i - at));
      pos += f.length;
    }
    return 2112;
  })().catch(() => 2112);
  return priming;
}

/** Encode the sound for a render (AAC, 48 kHz stereo). */
export async function encodeAudio(pcm: Float32Array[]): Promise<EncodedAudio> {
  const [{ chunks, asc }, delay] = await Promise.all([aacFrames(pcm), encoderDelay()]);
  return { chunks, asc, priming: delay, length: pcm[0].length };
}

function toBytes(d: AllowSharedBufferSource): Uint8Array {
  if (d instanceof Uint8Array) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
  return new Uint8Array(d.slice(0));
}

/**
 * One video file being made: frames go in (with backpressure so memory stays flat), an MP4 comes out.
 */
export class VideoFileWriter {
  private enc: VideoEncoder;
  private mux = new Mp4Muxer();
  private avcC: Uint8Array | null = null;
  private error: unknown = null;
  private n = 0;
  private readonly timescale: number;
  private readonly tick: number;
  constructor(
    private cfg: VideoEncoderConfig,
    private fps: number,
    private audio: EncodedAudio | null,
  ) {
    this.timescale = fps * 1000;
    this.tick = 1000;
    this.enc = new VideoEncoder({
      output: (chunk, meta) => {
        const d = new Uint8Array(chunk.byteLength);
        chunk.copyTo(d);
        const desc = meta?.decoderConfig?.description;
        if (desc && !this.avcC) this.avcC = toBytes(desc);
        this.take({ data: d, pts: Math.round((chunk.timestamp / 1e6) * this.timescale), key: chunk.type === 'key' });
      },
      error: (e) => {
        this.error = e;
      },
    });
    this.enc.configure(cfg);
  }

  /**
   * Chunks arrive in decode order. Browsers' H.264 encoders don't reorder frames, so each presentation
   * time equals its decode time; if one ever does, the offset goes into the file (ctts, signed).
   */
  private take(c: { data: Uint8Array; pts: number; key: boolean }) {
    const dts = this.n * this.tick;
    this.mux.addVideo(c.data, this.tick, c.key, c.pts - dts);
    this.n++;
  }

  /** Encode one frame; waits while the encoder is busy so frames don't pile up in memory. */
  async add(frame: VideoFrame, index: number) {
    if (this.error) throw this.error;
    this.enc.encode(frame, { keyFrame: index % (this.fps * 2) === 0 });
    while (this.enc.encodeQueueSize > 3) {
      await new Promise<void>((res) => {
        const t = setTimeout(res, 50);
        this.enc.addEventListener(
          'dequeue',
          () => {
            clearTimeout(t);
            res();
          },
          { once: true },
        );
      });
      if (this.error) throw this.error;
    }
  }

  /** finish encoding and hand back the MP4 */
  async finish(): Promise<Blob> {
    await this.enc.flush();
    this.enc.close();
    if (this.error) throw this.error;
    if (!this.avcC) throw new Error('The video encoder gave no stream description.');
    this.mux.setVideo({ width: this.cfg.width, height: this.cfg.height, timescale: this.timescale, avcC: this.avcC });
    const a = this.audio;
    if (a) {
      this.mux.setAudio({ sampleRate: AUDIO_RATE, channels: 2, asc: a.asc, priming: a.priming, length: a.length, avgBitrate: AUDIO_BITRATE });
      for (const c of a.chunks) this.mux.addAudio(c, 1024);
    }
    return this.mux.finish();
  }

  close() {
    if (this.enc.state !== 'closed') this.enc.close();
  }
}
