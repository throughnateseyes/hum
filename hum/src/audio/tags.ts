/**
 * Read a song's own tags (title, artist, album, embedded lyrics) straight from the file, so lyrics
 * can be found without the person typing anything. Handles MP3 (ID3v2.2–2.4 and ID3v1), M4A / AAC
 * (MP4 ilst atoms), FLAC (Vorbis comments) and WAV (INFO list or an embedded ID3 chunk). Reads only
 * the bytes it needs, so a 100 MB file costs a few small slices.
 */

export interface SongTags {
  title?: string;
  artist?: string;
  album?: string;
  /** lyrics stored in the file: plain text, or LRC with [mm:ss.xx] timestamps */
  lyrics?: string;
}

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');
const utf16le = new TextDecoder('utf-16le');
const utf16be = new TextDecoder('utf-16be');

const bytes = async (b: Blob, start: number, end: number): Promise<Uint8Array> => new Uint8Array(await b.slice(start, end).arrayBuffer());
const ascii = (u: Uint8Array, o: number, n: number) => String.fromCharCode(...u.subarray(o, o + n));
const be32 = (u: Uint8Array, o: number) => ((u[o] << 24) | (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3]) >>> 0;
const le32 = (u: Uint8Array, o: number) => (u[o] | (u[o + 1] << 8) | (u[o + 2] << 16) | (u[o + 3] << 24)) >>> 0;
const syncsafe = (u: Uint8Array, o: number) => ((u[o] & 0x7f) << 21) | ((u[o + 1] & 0x7f) << 14) | ((u[o + 2] & 0x7f) << 7) | (u[o + 3] & 0x7f);
const clean = (s: string | undefined) => {
  const t = (s ?? '').replace(/\0+$/g, '').replace(/\0/g, ' ').trim();
  return t || undefined;
};

export async function readTags(file: Blob): Promise<SongTags> {
  try {
    const head = await bytes(file, 0, 12);
    if (ascii(head, 0, 3) === 'ID3') return { ...(await id3v1(file)), ...(await id3v2(file, 0)) };
    if (ascii(head, 4, 4) === 'ftyp') return await mp4(file);
    if (ascii(head, 0, 4) === 'fLaC') return await flac(file);
    if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WAVE') return await wav(file);
    return await id3v1(file);
  } catch (e) {
    console.warn('[hum] could not read tags', e);
    return {};
  }
}

/* ───────────────────────── ID3v2 ───────────────────────── */

function id3Text(u: Uint8Array): string {
  const enc = u[0];
  const body = u.subarray(1);
  if (enc === 0) return latin1.decode(body);
  if (enc === 3) return utf8.decode(body);
  if (enc === 2) return utf16be.decode(body);
  // 1: UTF-16 with a byte-order mark
  if (body[0] === 0xfe && body[1] === 0xff) return utf16be.decode(body.subarray(2));
  if (body[0] === 0xff && body[1] === 0xfe) return utf16le.decode(body.subarray(2));
  return utf16le.decode(body);
}

/** USLT: encoding, 3-byte language, a description ending in a terminator, then the lyrics */
function id3Lyrics(u: Uint8Array): string {
  const enc = u[0];
  let i = 4;
  const wide = enc === 1 || enc === 2;
  if (wide) {
    while (i + 1 < u.length && !(u[i] === 0 && u[i + 1] === 0 && (i - 4) % 2 === 0)) i += 2;
    i += 2;
  } else {
    while (i < u.length && u[i] !== 0) i++;
    i += 1;
  }
  return id3Text(new Uint8Array([enc, ...u.subarray(i)]));
}

function unsync(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  for (let i = 0; i < u.length; i++) {
    out.push(u[i]);
    if (u[i] === 0xff && u[i + 1] === 0x00) i++;
  }
  return new Uint8Array(out);
}

async function id3v2(file: Blob, offset: number): Promise<SongTags> {
  const h = await bytes(file, offset, offset + 10);
  const ver = h[3];
  const flags = h[5];
  const size = syncsafe(h, 6);
  let u = await bytes(file, offset + 10, offset + 10 + size);
  if (flags & 0x80 && ver < 4) u = unsync(u);
  let p = 0;
  if (flags & 0x40) p += ver === 4 ? syncsafe(u, 0) : be32(u, 0) + 4; // extended header
  const tags: SongTags = {};
  const idLen = ver === 2 ? 3 : 4;
  const hdrLen = ver === 2 ? 6 : 10;
  while (p + hdrLen <= u.length) {
    const id = ascii(u, p, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const len = ver === 2 ? (u[p + 3] << 16) | (u[p + 4] << 8) | u[p + 5] : ver === 4 ? syncsafe(u, p + 4) : be32(u, p + 4);
    const fflags = ver === 2 ? 0 : u[p + 9];
    let data = u.subarray(p + hdrLen, p + hdrLen + len);
    if (ver === 4 && fflags & 0x02) data = unsync(data);
    if (ver === 4 && fflags & 0x01) data = data.subarray(4); // data length indicator
    p += hdrLen + len;
    if (!len) continue;
    if (id === 'TIT2' || id === 'TT2') tags.title ??= clean(id3Text(data));
    else if (id === 'TPE1' || id === 'TP1') tags.artist ??= clean(id3Text(data));
    else if ((id === 'TPE2' || id === 'TP2') && !tags.artist) tags.artist = clean(id3Text(data));
    else if (id === 'TALB' || id === 'TAL') tags.album ??= clean(id3Text(data));
    else if (id === 'USLT' || id === 'ULT') tags.lyrics ??= clean(id3Lyrics(data));
    else if (id === 'TXXX' || id === 'TXX') {
      // user text frame: description then value (some tools file lyrics here)
      const [desc, ...rest] = id3Text(data).split('\0');
      if (/^(lyrics|unsyncedlyrics|syncedlyrics|uslt)$/i.test(desc.trim())) tags.lyrics ??= clean(rest.join('\n'));
    }
  }
  return tags;
}

async function id3v1(file: Blob): Promise<SongTags> {
  if (file.size < 128) return {};
  const u = await bytes(file, file.size - 128, file.size);
  if (ascii(u, 0, 3) !== 'TAG') return {};
  return { title: clean(latin1.decode(u.subarray(3, 33))), artist: clean(latin1.decode(u.subarray(33, 63))), album: clean(latin1.decode(u.subarray(63, 93))) };
}

/* ───────────────────────── MP4 / M4A ───────────────────────── */

/** walk sibling atoms in [start, end) of the file, calling `visit` with each type and range */
async function atoms(file: Blob, start: number, end: number, visit: (type: string, from: number, to: number) => Promise<boolean | void>) {
  let p = start;
  while (p + 8 <= end) {
    const h = await bytes(file, p, p + 16);
    let size = be32(h, 0);
    const type = ascii(h, 4, 4);
    let hdr = 8;
    if (size === 1) {
      size = be32(h, 8) * 2 ** 32 + be32(h, 12);
      hdr = 16;
    } else if (size === 0) size = end - p;
    if (size < hdr) break;
    if (await visit(type, p + hdr, p + size)) return;
    p += size;
  }
}

async function mp4(file: Blob): Promise<SongTags> {
  const tags: SongTags = {};
  const map: Record<string, keyof SongTags> = { '©nam': 'title', '©ART': 'artist', aART: 'artist', '©alb': 'album', '©lyr': 'lyrics' };
  await atoms(file, 0, file.size, async (type, a, b) => {
    if (type !== 'moov') return;
    await atoms(file, a, b, async (t2, a2, b2) => {
      if (t2 !== 'udta') return;
      await atoms(file, a2, b2, async (t3, a3, b3) => {
        if (t3 !== 'meta') return;
        await atoms(file, a3 + 4, b3, async (t4, a4, b4) => {
          if (t4 !== 'ilst') return;
          const u = await bytes(file, a4, b4);
          let p = 0;
          while (p + 8 <= u.length) {
            const size = be32(u, p);
            const key = latin1.decode(u.subarray(p + 4, p + 8));
            const field = map[key];
            // child 'data' atom: size, 'data', type(4), locale(4), value
            if (field && !tags[field] && ascii(u, p + 12, 4) === 'data') tags[field] = clean(utf8.decode(u.subarray(p + 24, p + size)));
            if (size < 8) break;
            p += size;
          }
          return true;
        });
        return true;
      });
      return true;
    });
    return true;
  });
  return tags;
}

/* ───────────────────────── FLAC ───────────────────────── */

function vorbisComments(u: Uint8Array): SongTags {
  const tags: SongTags = {};
  let p = 4 + le32(u, 0);
  const n = le32(u, p);
  p += 4;
  for (let i = 0; i < n && p + 4 <= u.length; i++) {
    const len = le32(u, p);
    const s = utf8.decode(u.subarray(p + 4, p + 4 + len));
    p += 4 + len;
    const eq = s.indexOf('=');
    const k = s.slice(0, eq).toUpperCase();
    const v = clean(s.slice(eq + 1));
    if (k === 'TITLE') tags.title ??= v;
    else if (k === 'ARTIST') tags.artist ??= v;
    else if (k === 'ALBUMARTIST' && !tags.artist) tags.artist = v;
    else if (k === 'ALBUM') tags.album ??= v;
    else if (k === 'LYRICS' || k === 'UNSYNCEDLYRICS' || k === 'SYNCEDLYRICS') tags.lyrics ??= v;
  }
  return tags;
}

async function flac(file: Blob): Promise<SongTags> {
  let p = 4;
  for (let guard = 0; guard < 64 && p + 4 <= file.size; guard++) {
    const h = await bytes(file, p, p + 4);
    const last = h[0] & 0x80;
    const type = h[0] & 0x7f;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 4) return vorbisComments(await bytes(file, p + 4, p + 4 + len));
    if (last) break;
    p += 4 + len;
  }
  return {};
}

/* ───────────────────────── WAV ───────────────────────── */

async function wav(file: Blob): Promise<SongTags> {
  let tags: SongTags = {};
  let p = 12;
  for (let guard = 0; guard < 64 && p + 8 <= file.size; guard++) {
    const h = await bytes(file, p, p + 12);
    const id = ascii(h, 0, 4);
    const len = le32(h, 4);
    if (id === 'id3 ' || id === 'ID3 ') tags = { ...tags, ...(await id3v2(file, p + 8)) };
    else if (id === 'LIST' && ascii(h, 8, 4) === 'INFO') {
      const u = await bytes(file, p + 12, p + 8 + len);
      let q = 0;
      while (q + 8 <= u.length) {
        const k = ascii(u, q, 4);
        const n = le32(u, q + 4);
        const v = clean(utf8.decode(u.subarray(q + 8, q + 8 + n)));
        if (k === 'INAM') tags.title ??= v;
        else if (k === 'IART') tags.artist ??= v;
        else if (k === 'IPRD') tags.album ??= v;
        q += 8 + n + (n & 1);
      }
    }
    p += 8 + len + (len & 1);
  }
  return tags;
}

/* ───────────────────────── file names ───────────────────────── */

/**
 * Guess artist and title from a file name: "Artist - Title", "03 - Artist - Title", "03. Title",
 * dropping things like "(Official Video)", "[320kbps]" and "lyrics".
 */
export function tagsFromFilename(name: string): SongTags {
  let s = name.replace(/\.[a-z0-9]{2,4}$/i, '');
  s = s.replace(/[_]+/g, ' ');
  s = s.replace(/\s*[([](official|lyric|lyrics|audio|video|visuali[sz]er|hq|hd|4k|\d+\s?kbps|explicit|clean|remaster(ed)?[^)\]]*)[^)\]]*[)\]]/gi, '');
  s = s.replace(/^\s*\d{1,3}\s*[-.)]\s*/, '').trim();
  const parts = s.split(/\s+[-–—]\s+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) return { artist: parts[0], title: parts.slice(1).join(' - ') };
  return parts[0] ? { title: parts[0] } : {};
}
