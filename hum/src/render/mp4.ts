/**
 * A small MP4 writer for the render timeline: one H.264 video track and one AAC audio track, laid out
 * ftyp → moov → mdat ("fast start", so a phone or a website can play it before it has all arrived).
 *
 * The encoded samples come from WebCodecs (VideoEncoder with avc format, AudioEncoder with raw AAC);
 * their decoder configs (the avcC record and the AudioSpecificConfig) go into the sample
 * descriptions as they are. Samples are kept as Blobs while the render runs, so a long render doesn't
 * hold every frame in one growing array.
 */

export interface VideoTrackInfo {
  width: number;
  height: number;
  /** ticks per second for the video track (e.g. fps × 1000) */
  timescale: number;
  /** the avcC record (VideoDecoderConfig.description) */
  avcC: Uint8Array;
}

export interface AudioTrackInfo {
  sampleRate: number;
  channels: number;
  /** the AudioSpecificConfig (AudioDecoderConfig.description) */
  asc: Uint8Array;
  /** samples of encoder delay to skip at the start (written as an edit list) */
  priming: number;
  /** how long the audio really is, in samples (the last AAC frame is padded) */
  length: number;
  avgBitrate: number;
}

interface Sample {
  size: number;
  /** duration in the track's timescale */
  dur: number;
  /** composition offset (presentation − decode time) in the track's timescale */
  cto: number;
  key: boolean;
}

/** collects bytes into Blobs of about 8 MB, so big renders can be paged out by the browser */
class BlobSink {
  private parts: Blob[] = [];
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  size = 0;
  push(b: Uint8Array) {
    this.pending.push(b);
    this.pendingBytes += b.byteLength;
    this.size += b.byteLength;
    if (this.pendingBytes > 8 << 20) this.flush();
  }
  flush() {
    if (!this.pending.length) return;
    this.parts.push(new Blob(this.pending as BlobPart[]));
    this.pending = [];
    this.pendingBytes = 0;
  }
  blobs(): Blob[] {
    this.flush();
    return this.parts;
  }
}

/* ───────── box helpers ───────── */

class W {
  private buf = new Uint8Array(256);
  private dv = new DataView(this.buf.buffer);
  n = 0;
  private need(k: number) {
    if (this.n + k <= this.buf.length) return;
    let len = this.buf.length * 2;
    while (len < this.n + k) len *= 2;
    const nb = new Uint8Array(len);
    nb.set(this.buf.subarray(0, this.n));
    this.buf = nb;
    this.dv = new DataView(nb.buffer);
  }
  u8(v: number) {
    this.need(1);
    this.dv.setUint8(this.n, v);
    this.n += 1;
    return this;
  }
  u16(v: number) {
    this.need(2);
    this.dv.setUint16(this.n, v);
    this.n += 2;
    return this;
  }
  u24(v: number) {
    this.u8((v >>> 16) & 255);
    this.u16(v & 0xffff);
    return this;
  }
  u32(v: number) {
    this.need(4);
    this.dv.setUint32(this.n, v >>> 0);
    this.n += 4;
    return this;
  }
  i32(v: number) {
    this.need(4);
    this.dv.setInt32(this.n, v | 0);
    this.n += 4;
    return this;
  }
  u64(v: number) {
    this.u32(Math.floor(v / 2 ** 32));
    this.u32(v % 2 ** 32);
    return this;
  }
  bytes(b: Uint8Array) {
    this.need(b.length);
    this.buf.set(b, this.n);
    this.n += b.length;
    return this;
  }
  str(s: string) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    return this;
  }
  zeros(k: number) {
    for (let i = 0; i < k; i++) this.u8(0);
    return this;
  }
  out() {
    return this.buf.slice(0, this.n);
  }
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  let len = 8;
  for (const p of parts) len += p.length;
  const w = new W().u32(len).str(type);
  for (const p of parts) w.bytes(p);
  return w.out();
}
/** a "full box": version and flags first */
function fbox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
  return box(type, new W().u8(version).u24(flags).out(), ...parts);
}
const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

/* ───────── the muxer ───────── */

export class Mp4Muxer {
  private vSink = new BlobSink();
  private aSink = new BlobSink();
  private vSamples: Sample[] = [];
  private aSamples: Sample[] = [];
  private video: VideoTrackInfo | null = null;
  private audio: AudioTrackInfo | null = null;

  setVideo(info: VideoTrackInfo) {
    this.video = info;
  }
  setAudio(info: AudioTrackInfo) {
    this.audio = info;
  }

  /** one video sample, in decode order: `cto` is its presentation time minus its decode time (ticks) */
  addVideo(data: Uint8Array, dur: number, key: boolean, cto = 0) {
    this.vSink.push(data);
    this.vSamples.push({ size: data.byteLength, dur, cto, key });
  }
  addAudio(data: Uint8Array, dur: number) {
    this.aSink.push(data);
    this.aSamples.push({ size: data.byteLength, dur, cto: 0, key: true });
  }

  get videoFrames() {
    return this.vSamples.length;
  }

  /** the finished file */
  finish(): Blob {
    const v = this.video;
    if (!v) throw new Error('no video track');
    const a = this.audio && this.aSamples.length ? this.audio : null;
    const ftyp = box('ftyp', new W().str('isom').u32(0x200).str('isom').str('iso2').str('avc1').str('mp41').out());
    const audioBytes = a ? this.aSink.size : 0;
    const videoBytes = this.vSink.size;
    const mdatPayload = audioBytes + videoBytes;
    const large = mdatPayload + 16 > 0xffffffff;
    const mdatHeader = large ? new W().u32(1).str('mdat').u64(mdatPayload + 16).out() : new W().u32(mdatPayload + 8).str('mdat').out();
    // the moov's size doesn't depend on the offsets inside it, so build it once to measure, then for real
    const build = (base: number) => this.moov(v, a, base + mdatHeader.length, audioBytes, large);
    const probe = build(0);
    const moov = build(ftyp.length + probe.length);
    const parts = [ftyp, moov, mdatHeader] as BlobPart[];
    if (a) parts.push(...this.aSink.blobs());
    parts.push(...this.vSink.blobs());
    return new Blob(parts, { type: 'video/mp4' });
  }

  private moov(v: VideoTrackInfo, a: AudioTrackInfo | null, dataStart: number, audioBytes: number, co64: boolean): Uint8Array {
    const vTicks = this.vSamples.reduce((s, x) => s + x.dur, 0);
    const vSecs = vTicks / v.timescale;
    const aSecs = a ? a.length / a.sampleRate : 0;
    const MOVIE_TS = 1000;
    const movieDur = Math.round(Math.max(vSecs, aSecs) * MOVIE_TS);
    const mvhd = fbox(
      'mvhd',
      0,
      0,
      (() => {
        const w = new W().u32(0).u32(0).u32(MOVIE_TS).u32(movieDur).u32(0x00010000).u16(0x0100).zeros(10);
        for (const m of MATRIX) w.u32(m);
        return w.zeros(24).u32(a ? 3 : 2).out();
      })(),
    );
    const tracks = [this.videoTrak(v, Math.round(vSecs * MOVIE_TS), a ? dataStart + audioBytes : dataStart, co64)];
    if (a) tracks.push(this.audioTrak(a, Math.round(aSecs * MOVIE_TS), dataStart, co64));
    return box('moov', mvhd, ...tracks);
  }

  private tkhd(id: number, dur: number, audio: boolean, w = 0, h = 0) {
    const x = new W().u32(0).u32(0).u32(id).u32(0).u32(dur).zeros(8).u16(0).u16(audio ? 1 : 0).u16(audio ? 0x0100 : 0).u16(0);
    for (const m of MATRIX) x.u32(m);
    x.u32(w * 65536).u32(h * 65536);
    return fbox('tkhd', 0, 3, x.out());
  }

  private mdhd(timescale: number, dur: number) {
    // language 'und'
    return fbox('mdhd', 0, 0, new W().u32(0).u32(0).u32(timescale).u32(dur).u16(0x55c4).u16(0).out());
  }

  private hdlr(type: string, name: string) {
    return fbox('hdlr', 0, 0, new W().u32(0).str(type).zeros(12).str(name).u8(0).out());
  }

  private dinf() {
    return box('dinf', fbox('dref', 0, 0, new W().u32(1).out(), fbox('url ', 0, 1)));
  }

  /** stts, stsc, stsz, stco: every sample in one chunk at `offset` */
  private tables(samples: Sample[], offset: number, co64: boolean): Uint8Array[] {
    // stts: runs of equal durations
    const runs: [number, number][] = [];
    for (const s of samples) {
      const last = runs[runs.length - 1];
      if (last && last[1] === s.dur) last[0]++;
      else runs.push([1, s.dur]);
    }
    const stts = new W().u32(runs.length);
    for (const [c, d] of runs) stts.u32(c).u32(d);
    const out = [fbox('stts', 0, 0, stts.out())];
    if (samples.some((s) => s.cto !== 0)) {
      const cr: [number, number][] = [];
      for (const s of samples) {
        const last = cr[cr.length - 1];
        if (last && last[1] === s.cto) last[0]++;
        else cr.push([1, s.cto]);
      }
      const ctts = new W().u32(cr.length);
      for (const [c, o] of cr) ctts.u32(c).i32(o);
      out.push(fbox('ctts', 1, 0, ctts.out()));
    }
    if (samples.some((s) => !s.key)) {
      const keys = samples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
      const stss = new W().u32(keys.length);
      for (const k of keys) stss.u32(k);
      out.push(fbox('stss', 0, 0, stss.out()));
    }
    out.push(fbox('stsc', 0, 0, new W().u32(1).u32(1).u32(samples.length).u32(1).out()));
    const stsz = new W().u32(0).u32(samples.length);
    for (const s of samples) stsz.u32(s.size);
    out.push(fbox('stsz', 0, 0, stsz.out()));
    out.push(co64 ? fbox('co64', 0, 0, new W().u32(1).u64(offset).out()) : fbox('stco', 0, 0, new W().u32(1).u32(offset).out()));
    return out;
  }

  private videoTrak(v: VideoTrackInfo, movieDur: number, offset: number, co64: boolean) {
    const ticks = this.vSamples.reduce((s, x) => s + x.dur, 0);
    const avc1 = box(
      'avc1',
      new W()
        .zeros(6)
        .u16(1)
        .zeros(16)
        .u16(v.width)
        .u16(v.height)
        .u32(0x00480000)
        .u32(0x00480000)
        .u32(0)
        .u16(1)
        .u8(3)
        .str('hum')
        .zeros(28)
        .u16(0x0018)
        .u16(0xffff)
        .out(),
      box('avcC', v.avcC),
      // BT.709, limited range: what the browser's encoder writes for a canvas
      box('colr', new W().str('nclx').u16(1).u16(1).u16(1).u8(0).out()),
      box('pasp', new W().u32(1).u32(1).out()),
    );
    const stsd = fbox('stsd', 0, 0, new W().u32(1).out(), avc1);
    const stbl = box('stbl', stsd, ...this.tables(this.vSamples, offset, co64));
    const minf = box('minf', fbox('vmhd', 0, 1, new W().zeros(8).out()), this.dinf(), stbl);
    const mdia = box('mdia', this.mdhd(v.timescale, ticks), this.hdlr('vide', 'Hum video'), minf);
    return box('trak', this.tkhd(1, movieDur, false, v.width, v.height), mdia);
  }

  private audioTrak(a: AudioTrackInfo, movieDur: number, offset: number, co64: boolean) {
    const ticks = this.aSamples.reduce((s, x) => s + x.dur, 0);
    const esds = fbox('esds', 0, 0, esDescriptor(a));
    const mp4a = box(
      'mp4a',
      new W()
        .zeros(6)
        .u16(1)
        .zeros(8)
        .u16(a.channels)
        .u16(16)
        .u16(0)
        .u16(0)
        .u32(Math.min(65535, a.sampleRate) * 65536)
        .out(),
      esds,
    );
    const stsd = fbox('stsd', 0, 0, new W().u32(1).out(), mp4a);
    const stbl = box('stbl', stsd, ...this.tables(this.aSamples, offset, co64));
    const minf = box('minf', fbox('smhd', 0, 0, new W().u32(0).out()), this.dinf(), stbl);
    const mdia = box('mdia', this.mdhd(a.sampleRate, ticks), this.hdlr('soun', 'Hum audio'), minf);
    // the edit list skips the encoder's priming samples, so sound and picture start together
    const elst = fbox('elst', 0, 0, new W().u32(1).u32(movieDur).i32(a.priming).u16(1).u16(0).out());
    return box('trak', this.tkhd(2, movieDur, true), box('edts', elst), mdia);
  }
}

/** MPEG-4 descriptor length, always written in four bytes */
function descLen(w: W, n: number) {
  w.u8(0x80 | ((n >>> 21) & 0x7f))
    .u8(0x80 | ((n >>> 14) & 0x7f))
    .u8(0x80 | ((n >>> 7) & 0x7f))
    .u8(n & 0x7f);
}

function esDescriptor(a: AudioTrackInfo): Uint8Array {
  const dsi = new W().u8(0x05);
  descLen(dsi, a.asc.length);
  dsi.bytes(a.asc);
  const dsiB = dsi.out();
  const dcd = new W().u8(0x04);
  descLen(dcd, 13 + dsiB.length);
  dcd.u8(0x40) // MPEG-4 audio
    .u8(0x15) // audio stream
    .u24(0)
    .u32(a.avgBitrate)
    .u32(a.avgBitrate)
    .bytes(dsiB);
  const dcdB = dcd.out();
  const sl = new W().u8(0x06);
  descLen(sl, 1);
  sl.u8(0x02);
  const slB = sl.out();
  const es = new W().u8(0x03);
  descLen(es, 3 + dcdB.length + slB.length);
  es.u16(2).u8(0).bytes(dcdB).bytes(slB);
  return es.out();
}
