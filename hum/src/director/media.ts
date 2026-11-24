/**
 * Watching the person's clips and photos: what Claude saw in each one, kept by media id in this
 * browser, so every file is watched once and a remake sends nothing already seen.
 *
 * A few small frames of each clip (and a small copy of each photo) go to Claude on contact sheets
 * (mediaSample.ts), only after the person pressed Make with the note about it on screen
 * (state/plan.ts). Notes come back checked here: Claude's answer is never trusted.
 */
import type { ClipAsset, MediaMeasure, MediaNotes, PhotoAsset } from '../core/types';
import { deckIdsOf } from '../shot/run';
import { ask, NOTES } from '../state/saved';
import { useStudio } from '../state/store';
import { requestStep } from './client';
import { PHOTOS_PER_SHEET, breathe, photoSheet, sampleClip } from './mediaSample';

/** raised when the notes change shape: media is then watched again */
const VERSION = 1;
/** sheets in one request, and requests on their way at once */
const SHEETS = 3;
const IN_FLIGHT = 3;

const known = new Map<string, MediaNotes>();
let recalled: Promise<void> | null = null;

/** bring the notes kept from before into memory (once) */
export function recallNotes(): Promise<void> {
  recalled ??= ask<MediaNotes[]>(NOTES, 'readonly', (s) => s.getAll()).then((r) => {
    for (const n of r.value ?? []) if (n && typeof n.id === 'string' && n.v === VERSION && n.measure && !known.has(n.id)) known.set(n.id, n);
  });
  return recalled;
}

/** what Claude saw in this clip or photo, if it has been watched */
export const notesOf = (id: string): MediaNotes | undefined => known.get(id);

/** keep a file's notes (in memory, and for next time) */
export function keepNotes(n: MediaNotes) {
  known.set(n.id, n);
  void ask(NOTES, 'readwrite', (s) => s.put(n));
}

/** the clips and photos a video can use, in the order footage looks deal them (never the placeholder) */
export function ownMedia(): ({ kind: 'clip'; id: string; clip: ClipAsset } | { kind: 'photo'; id: string; photo: PhotoAsset })[] {
  const s = useStudio.getState();
  const out: ReturnType<typeof ownMedia> = [];
  for (const id of deckIdsOf(s.clips, s.photos)) {
    const clip = s.clips.find((c) => c.id === id);
    const photo = clip ? undefined : s.photos.find((p) => p.id === id && !p.builtin);
    if (clip) out.push({ kind: 'clip', id, clip });
    else if (photo) out.push({ kind: 'photo', id, photo });
  }
  return out;
}

/** how many of them Claude has not seen yet */
export const unwatched = () => ownMedia().filter((m) => !known.has(m.id)).length;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const text = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

/** one clip or photo on its way to Claude */
interface Sent {
  key: string;
  id: string;
  kind: 'clip' | 'photo';
  seconds: number;
  width: number;
  height: number;
  sheet: number;
  measure: MediaMeasure;
}

const shapeOf = (w: number, h: number) => (w > h * 1.15 ? 'wide' : h > w * 1.15 ? 'tall' : 'square');

/** Claude's notes on one item, checked against what was sent */
function readNotes(raw: unknown, sent: Sent): MediaNotes | null {
  if (!isObj(raw)) return null;
  const subject = text(raw.subject, 140);
  if (!subject) return null;
  const ins = Array.isArray(raw.ins) ? raw.ins : [];
  return {
    id: sent.id,
    v: VERSION,
    kind: sent.kind,
    subject,
    focusX: num(raw.focusX, 0, 1, 0.5),
    // Claude counts from the top, the pictures here from the bottom
    focusY: 1 - num(raw.focusY, 0, 1, 0.5),
    mood: (Array.isArray(raw.mood) ? raw.mood : []).map((m) => text(m, 20).toLowerCase()).filter(Boolean).slice(0, 4),
    energy: num(raw.energy, 0, 1, 0.4),
    camera: text(raw.camera, 20) || 'still',
    size: text(raw.size, 20) || 'medium',
    ins:
      sent.kind === 'photo'
        ? []
        : ins
            .filter(isObj)
            .filter((x) => typeof x.at === 'number' && Number.isFinite(x.at))
            .slice(0, 3)
            .map((x) => ({ at: num(x.at, 0, Math.max(0, sent.seconds - 0.6), 0), why: text(x.why, 80) })),
    faces: raw.faces === true,
    text: raw.text === true,
    measure: sent.measure,
  };
}

export interface WatchResult {
  /** how many could not be watched */
  missed: number;
  /** why, in a short line ('' when nothing was missed) */
  reason: string;
  /** no AI here, or no access code */
  closed?: boolean;
}

/**
 * Watch every clip and photo that has no notes yet. Sheets are made one after the other (one player
 * at a time) while earlier ones are already with Claude, a few requests at once. Whatever comes back
 * is kept; the rest is simply missed. Throws only when cancelled.
 */
export async function watchMedia(opts: { signal?: AbortSignal; onProgress?: (done: number, of: number) => void } = {}): Promise<WatchResult> {
  await recallNotes();
  const { signal } = opts;
  const todo = ownMedia().filter((m) => !known.has(m.id));
  if (!todo.length) return { missed: 0, reason: '' };
  let done = 0;
  let reason = '';
  let closed = false;
  const tell = (n: number) => opts.onProgress?.((done += n), todo.length);
  tell(0);

  // photos share sheets, clips have one each
  type Job = { clip: ClipAsset } | { photos: PhotoAsset[] };
  const jobs: Job[] = todo.flatMap((m) => (m.kind === 'clip' ? [{ clip: m.clip }] : []));
  const photos = todo.flatMap((m) => (m.kind === 'photo' ? [m.photo] : []));
  for (let i = 0; i < photos.length; i += PHOTOS_PER_SHEET) jobs.push({ photos: photos.slice(i, i + PHOTOS_PER_SHEET) });

  const flying = new Set<Promise<void>>();
  const send = async (sheets: string[], sent: Sent[]) => {
    const r = await requestStep(
      'watch',
      {
        images: sheets,
        media: sent.map((x) => ({ key: x.key, kind: x.kind, seconds: x.seconds, shape: shapeOf(x.width, x.height), sheet: x.sheet, ...x.measure })),
      },
      { signal },
    );
    if (r.ok) {
      const notes = Array.isArray(r.json.notes) ? r.json.notes : [];
      for (const x of sent) {
        const got = readNotes(
          notes.find((n) => isObj(n) && n.key === x.key),
          x,
        );
        if (got) keepNotes(got);
      }
    } else {
      reason = r.reason;
      closed ||= !!r.closed;
    }
    tell(sent.length);
  };
  // the first request goes alone (the next sheets are made meanwhile): it may stop to ask for an
  // access code, or find there is no AI here, and then nothing more is sent
  let gate: Promise<void> | null = null;
  let refused = false;
  let sheets: string[] = [];
  let sent: Sent[] = [];
  const launch = async () => {
    if (!sheets.length) return;
    const [pics, items] = [sheets, sent];
    sheets = [];
    sent = [];
    if (gate) await gate;
    if (refused) return;
    while (flying.size >= IN_FLIGHT) await Promise.race(flying);
    const before = known.size;
    const p: Promise<void> = send(pics, items).finally(() => flying.delete(p));
    flying.add(p);
    // a failure is caught by whoever waits for it; this stops the browser calling it unhandled meanwhile
    p.catch(() => undefined);
    gate ??= p.then(() => {
      refused = known.size === before;
    });
    gate.catch(() => undefined);
  };

  let n = 0;
  for (const job of jobs) {
    if (refused) break;
    try {
      if ('clip' in job) {
        const key = String.fromCharCode(65 + (n++ % 26));
        const got = await sampleClip(job.clip, key, signal);
        sent.push({ key, id: job.clip.id, kind: 'clip', seconds: job.clip.duration, width: job.clip.width, height: job.clip.height, sheet: sheets.length, measure: got.measure });
        sheets.push(got.jpeg);
      } else {
        const keyed = job.photos.map((photo, i) => ({ photo, key: `P${i + 1}` }));
        // two photo sheets in one request would share keys: send what is waiting first
        if (sent.some((x) => x.kind === 'photo')) await launch();
        const got = await photoSheet(keyed, signal);
        keyed.forEach(({ photo, key }, i) =>
          sent.push({ key, id: photo.id, kind: 'photo', seconds: 0, width: photo.width, height: photo.height, sheet: sheets.length, measure: { at: [], motion: [], bright: got.bright[i], shake: 0 } }),
        );
        sheets.push(got.jpeg);
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      // a clip that can't be opened is missed; the rest still are watched
      reason = 'One of your files could not be opened.';
      tell('clip' in job ? 1 : job.photos.length);
    }
    if (sheets.length >= SHEETS) await launch();
    await breathe();
  }
  await launch();
  await Promise.all(flying);
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const missed = todo.filter((m) => !known.has(m.id)).length;
  return { missed, reason: missed ? reason || 'Claude did not say anything about some of your files.' : '', closed };
}
