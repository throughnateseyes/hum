/**
 * Reads where the pictures of an MP4 or MOV are, so they can be decoded in order (frameSource.ts): only
 * the index is read, never the pictures themselves. Answers null for anything out of the ordinary (pieces
 * of a stream, odd edit lists, several picture tracks, other codecs): the clip is then played by seeking.
 */

export interface Mp4Video {
  /** for VideoDecoder.configure */
  config: VideoDecoderConfig;
  /** a picture's place in the file, in the order they are decoded */
  offset: Float64Array;
  size: Uint32Array;
  key: Uint8Array;
  /** when it is shown and how long it lasts (µs), as the browser counts them */
  pts: Float64Array;
  lasts: Float64Array;
  /** ticks a second the file itself counts in */
  scale: number;
  /** the pictures in the order they are shown */
  order: Uint32Array;
}

interface Box {
  type: string;
  /** what is inside, as offsets in the buffer */
  at: number;
  end: number;
}

const name = (d: DataView, at: number) => String.fromCharCode(d.getUint8(at), d.getUint8(at + 1), d.getUint8(at + 2), d.getUint8(at + 3));

function boxes(d: DataView, from: number, to: number): Box[] {
  const out: Box[] = [];
  for (let at = from; at + 8 <= to; ) {
    let size = d.getUint32(at);
    let head = 8;
    if (size === 1) {
      size = Number(d.getBigUint64(at + 8));
      head = 16;
    } else if (size === 0) size = to - at;
    if (size < head || at + size > to) break;
    out.push({ type: name(d, at + 4), at: at + head, end: at + size });
    at += size;
  }
  return out;
}

const inside = (d: DataView, b: Box, type: string) => boxes(d, b.at, b.end).find((x) => x.type === type);
function path(d: DataView, b: Box | undefined, ...types: string[]): Box | undefined {
  for (const t of types) b = b && inside(d, b, t);
  return b;
}

const hex = (n: number, w = 2) => n.toString(16).padStart(w, '0');

function hevcName(kind: string, c: Uint8Array): string {
  const space = ['', 'A', 'B', 'C'][c[1] >> 6];
  let compat = 0;
  const flags = ((c[2] << 24) | (c[3] << 16) | (c[4] << 8) | c[5]) >>> 0;
  for (let i = 0; i < 32; i++) if (flags & (1 << i)) compat |= 1 << (31 - i);
  const more = [...c.subarray(6, 12)];
  while (more.length && !more[more.length - 1]) more.pop();
  return [kind, `${space}${c[1] & 31}`, (compat >>> 0).toString(16), `${c[1] & 32 ? 'H' : 'L'}${c[12]}`, ...more.map((x) => x.toString(16))].join('.');
}

const PRIMARIES: Record<number, string> = { 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020', 12: 'smpte432' };
const TRANSFERS: Record<number, string> = { 1: 'bt709', 6: 'smpte170m', 13: 'iec61966-2-1', 16: 'pq', 18: 'hlg' };
const MATRICES: Record<number, string> = { 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020-ncl' };

/** quarter turns a track's matrix asks for, or null when it does something else */
function turnOf(d: DataView, tkhd: Box): number | null {
  const v1 = d.getUint8(tkhd.at) === 1;
  const m = tkhd.at + (v1 ? 52 : 40);
  const [a, b, , c, e] = [0, 1, 2, 3, 4].map((i) => d.getInt32(m + i * 4));
  const u = 0x10000;
  if (a === u && b === 0 && c === 0 && e === u) return 0;
  if (a === 0 && b === u && c === -u && e === 0) return 90;
  if (a === -u && b === 0 && c === 0 && e === -u) return 180;
  if (a === 0 && b === -u && c === u && e === 0) return 270;
  return null;
}

async function moovOf(file: Blob): Promise<DataView | null> {
  let found: DataView | null = null;
  for (let at = 0, n = 0; at + 8 <= file.size && n < 64; n++) {
    const d = new DataView(await file.slice(at, Math.min(file.size, at + 16)).arrayBuffer());
    let size = d.getUint32(0);
    const type = name(d, 4);
    if (size === 1 && d.byteLength >= 16) size = Number(d.getBigUint64(8));
    else if (size === 0) size = file.size - at;
    if (size < 8) return null;
    // a file in pieces
    if (type === 'moof') return null;
    if (type === 'moov') {
      if (found || size > 64 << 20) return null;
      found = new DataView(await file.slice(at, at + size).arrayBuffer());
    }
    at += size;
  }
  return found;
}

export async function readMp4(file: Blob): Promise<Mp4Video | null> {
  const d = await moovOf(file);
  if (!d || !d.byteLength) return null;
  const moov = boxes(d, 0, d.byteLength)[0];
  if (!moov || moov.type !== 'moov' || inside(d, moov, 'mvex')) return null;
  const tracks = boxes(d, moov.at, moov.end).filter((b) => {
    const hdlr = b.type === 'trak' ? path(d, b, 'mdia', 'hdlr') : undefined;
    return !!hdlr && name(d, hdlr.at + 8) === 'vide';
  });
  if (tracks.length !== 1) return null;
  const [trak] = tracks;
  const tkhd = inside(d, trak, 'tkhd');
  const mdhd = path(d, trak, 'mdia', 'mdhd');
  const stbl = path(d, trak, 'mdia', 'minf', 'stbl');
  if (!tkhd || !mdhd || !stbl) return null;
  const turn = turnOf(d, tkhd);
  if (turn === null) return null;
  const scale = d.getUint32(mdhd.at + (d.getUint8(mdhd.at) === 1 ? 20 : 12));
  const table = (type: string) => {
    const b = inside(d, stbl, type);
    return b ? { b, at: b.at + 8, n: d.getUint32(b.at + 4) } : null;
  };

  // one edit at most, and only one that says where the pictures begin
  let begin = 0;
  const elst = path(d, trak, 'edts', 'elst');
  if (elst) {
    if (d.getUint32(elst.at + 4) !== 1) return null;
    const v1 = d.getUint8(elst.at) === 1;
    begin = v1 ? Number(d.getBigInt64(elst.at + 16)) : d.getInt32(elst.at + 12);
    if (begin < 0 || d.getInt32(elst.at + (v1 ? 24 : 16)) !== 0x10000) return null;
  }

  // what the pictures are
  const stsd = table('stsd');
  if (!stsd || stsd.n !== 1) return null;
  const entry = boxes(d, stsd.at, stsd.b.end)[0];
  if (!entry || !/^(avc1|hvc1|hev1)$/.test(entry.type)) return null;
  const within = boxes(d, entry.at + 78, entry.end);
  const part = (t: string) => within.find((x) => x.type === t);
  const conf = part(entry.type === 'avc1' ? 'avcC' : 'hvcC');
  if (!conf || part('dvcC') || part('dvvC') || part('clap')) return null;
  const pasp = part('pasp');
  if (pasp && d.getUint32(pasp.at) !== d.getUint32(pasp.at + 4)) return null;
  const description = new Uint8Array(d.buffer.slice(d.byteOffset + conf.at, d.byteOffset + conf.end));
  const codec = entry.type === 'avc1' ? `avc1.${hex(description[1])}${hex(description[2])}${hex(description[3])}` : hevcName(entry.type, description);
  const config: VideoDecoderConfig & { rotation?: number } = { codec, description, codedWidth: d.getUint16(entry.at + 24), codedHeight: d.getUint16(entry.at + 26), optimizeForLatency: false };
  if (turn) config.rotation = turn;
  const colr = part('colr');
  if (colr && /^ncl[xc]$/.test(name(d, colr.at))) {
    const [p, t, m] = [4, 6, 8].map((o) => d.getUint16(colr.at + o));
    if (PRIMARIES[p] && TRANSFERS[t] && MATRICES[m]) config.colorSpace = { primaries: PRIMARIES[p], transfer: TRANSFERS[t], matrix: MATRICES[m], fullRange: name(d, colr.at) === 'nclx' && colr.end - colr.at > 10 ? d.getUint8(colr.at + 10) >> 7 === 1 : false } as VideoColorSpaceInit;
  }

  // where each is, and when
  const stsz = inside(d, stbl, 'stsz');
  const stts = table('stts');
  const stsc = table('stsc');
  const stco = table('stco');
  const co64 = table('co64');
  const chunks = stco ?? co64;
  if (!stsz || !stts || !stsc || !chunks) return null;
  const same = d.getUint32(stsz.at + 4);
  const n = d.getUint32(stsz.at + 8);
  if (!n || n > 2e6) return null;
  const size = new Uint32Array(n);
  for (let i = 0; i < n; i++) size[i] = same || d.getUint32(stsz.at + 12 + i * 4);
  const offset = new Float64Array(n);
  let s = 0;
  for (let c = 0, r = 0; c < chunks.n && s < n; c++) {
    while (r + 1 < stsc.n && d.getUint32(stsc.at + (r + 1) * 12) <= c + 1) r++;
    let at = stco ? d.getUint32(stco.at + c * 4) : Number(d.getBigUint64(co64!.at + c * 8));
    for (let k = d.getUint32(stsc.at + r * 12 + 4); k > 0 && s < n; k--, s++) {
      offset[s] = at;
      at += size[s];
    }
  }
  if (s < n || offset[n - 1] + size[n - 1] > file.size) return null;
  const ticks = new Float64Array(n);
  const lasts = new Float64Array(n);
  let t = 0;
  s = 0;
  for (let r = 0; r < stts.n; r++) {
    const delta = d.getUint32(stts.at + r * 8 + 4);
    for (let k = d.getUint32(stts.at + r * 8); k > 0 && s < n; k--, s++) {
      ticks[s] = t;
      lasts[s] = Math.round((delta * 1e6) / scale);
      t += delta;
    }
  }
  if (s < n) return null;
  const ctts = table('ctts');
  if (ctts) {
    s = 0;
    for (let r = 0; r < ctts.n; r++) {
      const by = d.getInt32(ctts.at + r * 8 + 4);
      for (let k = d.getUint32(ctts.at + r * 8); k > 0 && s < n; k--, s++) ticks[s] += by;
    }
  }
  const pts = ticks.map((x) => Math.round(((x - begin) * 1e6) / scale));
  const key = new Uint8Array(n);
  const stss = table('stss');
  if (stss) for (let i = 0; i < stss.n; i++) key[d.getUint32(stss.at + i * 4) - 1] = 1;
  else key.fill(1);
  if (!key[0]) return null;
  const order = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => pts[a] - pts[b]);
  // two pictures at once, or ones before the beginning: not this kind of file
  if (pts[order[0]] < 0) return null;
  for (let i = 1; i < n; i++) if (pts[order[i]] <= pts[order[i - 1]]) return null;
  return { config, offset, size, key, pts, lasts, scale, order };
}
