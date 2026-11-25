/**
 * A project as one file (`.hum`) is a plain zip with nothing compressed: what is in it is already
 * compressed (audio, video, JPEG), and any zip tool opens it once it is renamed. Files are never read into
 * memory whole: a zip is made of the blobs themselves, and an opened one hands out slices of the file.
 */

/** the most one file can be (zips past this need another format, and most browsers struggle anyway) */
export const MOST_BYTES = 0xffffffff;
const HEAD = 0x04034b50;
const ENTRY = 0x02014b50;
const END = 0x06054b50;
/** names are UTF-8 */
const UTF8 = 0x0800;

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export async function crc32(b: Blob): Promise<number> {
  let c = 0xffffffff;
  const r = b.stream().getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    for (let i = 0; i < value.length; i++) c = TABLE[(c ^ value[i]) & 255] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export class TooBig extends Error {}

export async function zip(files: { path: string; blob: Blob }[], onProgress?: (frac: number) => void): Promise<Blob> {
  const total = files.reduce((s, f) => s + f.blob.size + 2 * f.path.length * 3 + 100, 0);
  if (total > MOST_BYTES) throw new TooBig('too big for one file');
  const parts: BlobPart[] = [];
  const entries: BlobPart[] = [];
  let at = 0;
  let listed = 0;
  for (const f of files) {
    const name = new TextEncoder().encode(f.path);
    const crc = await crc32(f.blob);
    const shared = (v: DataView, o: number) => {
      v.setUint16(o, 20, true);
      v.setUint16(o + 2, UTF8, true);
      v.setUint16(o + 4, 0, true);
      v.setUint32(o + 6, 0x00210000, true);
      v.setUint32(o + 10, crc, true);
      v.setUint32(o + 14, f.blob.size, true);
      v.setUint32(o + 18, f.blob.size, true);
      v.setUint16(o + 22, name.length, true);
    };
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, HEAD, true);
    shared(head, 4);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, ENTRY, true);
    entry.setUint16(4, 20, true);
    shared(entry, 6);
    entry.setUint32(42, at, true);
    parts.push(head.buffer as ArrayBuffer, name, f.blob);
    entries.push(entry.buffer as ArrayBuffer, name);
    at += 30 + name.length + f.blob.size;
    listed += 46 + name.length;
    onProgress?.(at / total);
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, END, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, listed, true);
  end.setUint32(16, at, true);
  return new Blob([...parts, ...entries, end.buffer as ArrayBuffer], { type: 'application/x-hum' });
}

/** every file in it, by its path; null when it isn't a zip of ours */
export async function unzip(b: Blob): Promise<Map<string, Blob> | null> {
  const tail = Math.min(b.size, 65557);
  const v = new DataView(await b.slice(b.size - tail).arrayBuffer());
  let e = tail - 22;
  while (e >= 0 && v.getUint32(e, true) !== END) e--;
  if (e < 0) return null;
  const count = v.getUint16(e + 10, true);
  const size = v.getUint32(e + 12, true);
  const from = v.getUint32(e + 16, true);
  if (from + size > b.size) return null;
  const list = await b.slice(from, from + size).arrayBuffer();
  const d = new DataView(list);
  const out = new Map<string, Blob>();
  let o = 0;
  for (let i = 0; i < count; i++) {
    if (o + 46 > size || d.getUint32(o, true) !== ENTRY) return null;
    const method = d.getUint16(o + 10, true);
    const bytes = d.getUint32(o + 20, true);
    const nameLen = d.getUint16(o + 28, true);
    const skip = d.getUint16(o + 30, true) + d.getUint16(o + 32, true);
    const at = d.getUint32(o + 42, true);
    const path = new TextDecoder().decode(new Uint8Array(list, o + 46, nameLen));
    o += 46 + nameLen + skip;
    if (path.endsWith('/')) continue;
    const head = new DataView(await b.slice(at, at + 30).arrayBuffer());
    if (head.byteLength < 30 || head.getUint32(0, true) !== HEAD) return null;
    const data = at + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    if (data + bytes > b.size) return null;
    const raw = b.slice(data, data + bytes);
    // one made again by another zip tool may be squeezed
    if (method === 8) out.set(path, await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob());
    else if (method === 0) out.set(path, raw);
    else return null;
  }
  return out;
}
