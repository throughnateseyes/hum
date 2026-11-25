/**
 * Make and the depth of the person's clips: the first look at every one is taken while the director
 * works, then the seconds a shot is likely to start on (the ones Claude's notes name) are read while the
 * story and the shots are chosen, and what the chosen Inside shots show beyond that is read before the
 * video goes on (src/depth, in this browser: nothing is sent anywhere). It waits a minute at the most;
 * what is missing then is read while the video plays. A render reads all that its stretch shows before it
 * draws (readStretch), however long that takes.
 */
import type { ClipReader, ReadProgress } from '../depth';
import { readingOf } from '../inside/readings';
import { insideRanges, titleWords } from '../scenes/footage';
import { shotOfPart } from '../shot/partShots';
import { deckIdsOf, runPartOf, withOwn } from '../shot/run';
import { partSequence, planFootage, shownOf } from '../shot/sequence';
import { useStudio } from '../state/store';
import type { Cut } from './footageStills';
import { landable, runOfCut } from './footageTiming';
import { notesOf, ownMedia } from './media';

const MOST_MS = 60000;

/** start on every clip and photo now, in the background */
export function beginDepth() {
  for (const m of ownMedia()) void readingOf(m.kind === 'clip' ? m.clip : m.photo).open();
}

/** how much of a clip is read from a second a shot may start on: what most shots of it show */
const LIKELY_S = 2.6;

let ahead: { stop: () => void } | null = null;

/**
 * Read the depth of the seconds shots are likely to start on, a short stretch at a time, until the real
 * shots are known (readDepth) or the Make is stopped. `first`: the media to begin with, in order. Whatever
 * is read is kept for this clip, so a second Make finds it done.
 */
export function readLikely(signal: AbortSignal, first: string[]) {
  ahead?.stop();
  let over = false;
  const mine = { stop: () => void (over = true) };
  ahead = mine;
  const clips = ownMedia().flatMap((m) => (m.kind === 'clip' ? [m.clip] : []));
  const rank = (id: string) => (first.includes(id) ? first.indexOf(id) : first.length);
  const starts = [...clips]
    .sort((x, y) => rank(x.id) - rank(y.id))
    .map((clip) => {
      const notes = notesOf(clip.id);
      return { clip, at: [...(notes?.ins ?? []).map((x) => x.at), ...landable(clip.id, notes).map((e) => e.at - 0.8)] };
    });
  void (async () => {
    // every clip's first, then every clip's second, so what time allows is from all of them
    for (let k = 0; k < Math.max(0, ...starts.map((s) => s.at.length)); k++)
      for (const { clip, at } of starts) {
        if (over || signal.aborted) return;
        if (k >= at.length) continue;
        const r = (await readingOf(clip).open()) as ClipReader | null;
        if (over || signal.aborted) return;
        const a = Math.max(0, at[k] - 0.1);
        await r?.need([[a, Math.min(clip.duration, a + LIKELY_S)]], { signal }).catch(() => undefined);
      }
  })();
}

/** what the cut's inside shots show, picture by picture */
function rangesOf(cut: Cut): { id: string; range: [number, number] }[] {
  const r = runOfCut(cut);
  return r ? r.run.seqs.flatMap((seq) => (seq ? insideRanges(seq).map((x) => ({ id: r.deckIds[x.clip % r.deckIds.length], range: x.range })) : [])) : [];
}

/** the first two (they play at once), then every fifth, and the ones between: what time allows is from all over the song */
function spread<T>(xs: T[]): T[] {
  const rest = xs.slice(2);
  return [...xs.slice(0, 2), ...[2, 0, 3, 1, 4].flatMap((k) => rest.filter((_, i) => i % 5 === k))];
}

export async function readDepth(cut: Cut, o: { signal: AbortSignal; say: (text: string, n?: number, of?: number) => void }) {
  // (the stretch being read is let finish: it is most likely one of these)
  ahead?.stop();
  const s = useStudio.getState();
  const all = spread(rangesOf(cut));
  if (!all.length) return;
  o.say('Reading the depth of your footage');
  const until = performance.now() + MOST_MS;
  const stop = new Promise<void>((r) => o.signal.addEventListener('abort', () => r(), { once: true }));
  for (const [i, { id, range }] of all.entries()) {
    const left = until - performance.now();
    if (o.signal.aborted || left <= 0) return;
    const asset = s.clips.find((c) => c.id === id) ?? s.photos.find((p) => p.id === id);
    if (!asset) continue;
    o.say('Reading the depth of your footage', i + 1, all.length);
    await Promise.race([readingOf(asset).need([range]), stop, new Promise((r) => setTimeout(r, left))]);
  }
}

/* ───────── a render's stretch ───────── */

/** what the inside shots of a stretch of the song show, as the video on screen is cut now, in song order */
function shownIn(from: number, to: number): { id: string; range: [number, number] }[] {
  const s = useStudio.getState();
  const a = s.analysis;
  if (!a?.sections.length) return [];
  if (s.planOn && s.plan?.flat) {
    const r = runOfCut({ plan: s.plan, analysis: a, shotAt: (i) => shotOfPart(i) });
    return r ? r.run.seqs.flatMap((seq) => (seq && seq.end > from && seq.start < to ? insideRanges(seq).map((x) => ({ id: r.deckIds[x.clip % r.deckIds.length], range: x.range })) : [])) : [];
  }
  // a footage look playing on its own cuts each part itself
  const deckIds = deckIdsOf(s.clips, s.photos);
  if (s.sceneId !== 'footage' || !deckIds.length) return [];
  const lengths = deckIds.map((id) => s.clips.find((c) => c.id === id)?.duration ?? 1e6);
  const words = s.sceneParams.words === false ? [] : titleWords();
  return a.sections.flatMap((sec, i) => {
    if (sec.end <= from || sec.start >= to) return [];
    const seq = partSequence(a, i, { ...withOwn(runPartOf(s.sceneParams), s.soloShot, deckIds), words, card: words.length > 0, pictures: deckIds.length });
    const curves = planFootage(seq, lengths);
    return seq.shots.flatMap((shot) => {
      if (shot.kind !== 'footage' || shot.style !== 'inside') return [];
      const [lo, hi] = shownOf(shot, curves[shot.index]);
      return [{ id: deckIds[shot.footageIndex % deckIds.length], range: [Math.max(0, lo - 0.1), hi + 0.3] as [number, number] }];
    });
  });
}

/** a reading that has said nothing for this long has failed */
const STALL_MS = 180000;

export interface DepthProgress {
  frac: number;
  /** the shot being read, and of how many (0: the clips are still being looked at) */
  n: number;
  of: number;
  /** the model itself is still on its way (the first time only) */
  loading: boolean;
}

/**
 * Read the depth a render of this stretch draws from, in song order. Settles early when stopped: the shot
 * being read is let finish, and kept. Says nothing when all of it is read already.
 */
export async function readStretch(from: number, to: number, o: { stopped: () => boolean; say: (p: DepthProgress) => void }): Promise<void> {
  const s = useStudio.getState();
  const all = shownIn(from, to).flatMap(({ id, range }) => {
    const asset = s.clips.find((c) => c.id === id) ?? s.photos.find((p) => p.id === id);
    return asset ? [{ reading: readingOf(asset), range }] : [];
  });
  /** one reading, until it is done, stopped or stuck; what it says goes on */
  const read = async (reading: (typeof all)[number]['reading'], ranges: [number, number][], say: (p: ReadProgress) => void) => {
    let heard = performance.now();
    let done = false;
    const job = reading
      .read(ranges, (p) => {
        heard = performance.now();
        if (!done) say(p);
      })
      .then(() => void (done = true));
    while (!done && !o.stopped() && performance.now() - heard < STALL_MS) await Promise.race([job, new Promise((r) => setTimeout(r, 120))]);
    if (!done && !o.stopped()) console.warn('[hum] reading the depth of a clip got stuck; its shots are drawn without it');
    done = true;
  };
  // the first look at every clip, and what else was being read of them: then it is known what is missing
  for (const reading of new Set(all.map((x) => x.reading))) {
    if (o.stopped()) return;
    await read(reading, [], (p) => p.stage !== 'read' && o.say({ frac: 0, n: 0, of: 0, loading: p.stage === 'download' }));
  }
  const of = all.filter((x) => !x.reading.has(x.range)).length;
  let n = 0;
  for (const { reading, range } of all) {
    if (o.stopped()) return;
    const missing = !reading.has(range);
    const say = (frac: number, loading = false) => missing && o.say({ frac: (n - 1 + frac) / of, n, of, loading });
    if (missing) n++;
    say(0);
    await read(reading, [range], (p) => say(p.stage === 'read' ? p.frac : 0, p.stage === 'download'));
  }
}
