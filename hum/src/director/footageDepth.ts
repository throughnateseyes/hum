/**
 * Make and the depth of the person's clips: the first look at every one is taken while the director
 * works, and the seconds the chosen Inside shots show are read before the video goes on (src/depth, in
 * this browser: nothing is sent anywhere). It waits a minute at the most; what is missing then is read
 * while the video plays.
 */
import { readingOf } from '../inside/readings';
import { insideRanges } from '../scenes/footage';
import { useStudio } from '../state/store';
import type { Cut } from './footageStills';
import { runOfCut } from './footageTiming';
import { ownMedia } from './media';

const MOST_MS = 60000;

/** start on every clip and photo now, in the background */
export function beginDepth() {
  for (const m of ownMedia()) void readingOf(m.kind === 'clip' ? m.clip : m.photo).open();
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
