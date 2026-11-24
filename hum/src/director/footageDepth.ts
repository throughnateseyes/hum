/**
 * Make and the depth of the person's clips: the first look at every one is taken while the director
 * works, and the seconds the chosen Inside shots show are read before the video goes on (src/depth, in
 * this browser: nothing is sent anywhere). It waits a minute at the most; what is missing then is read
 * while the video plays.
 */
import { readingOf } from '../inside/readings';
import { insideRanges, titleWords } from '../scenes/footage';
import { deckIdsOf, footageRun, runPartOf, withOwn } from '../shot/run';
import { findLook } from '../state/plan';
import { originalOf, parentsOf } from '../state/planCache';
import { useStudio } from '../state/store';
import type { Cut } from './footageStills';
import { ownMedia } from './media';

const MOST_MS = 60000;

/** start on every clip and photo now, in the background */
export function beginDepth() {
  for (const m of ownMedia()) void readingOf(m.kind === 'clip' ? m.clip : m.photo).open();
}

/** what the cut's inside shots show, picture by picture */
function rangesOf(cut: Cut): { id: string; range: [number, number] }[] {
  const s = useStudio.getState();
  const deckIds = deckIdsOf(s.clips, s.photos);
  const parts = cut.analysis.sections.map((_, i) => {
    const look = cut.plan.looks[i] ? findLook(cut.plan.looks[i]!) : undefined;
    if (!look || look.sceneId !== 'footage') return null;
    return withOwn(runPartOf({ ...(look.sceneParams ?? {}), ...(s.tweaks[look.id]?.sceneParams ?? {}) }), cut.shotAt(i), deckIds);
  });
  const clips = deckIds.map((id) => s.clips.find((c) => c.id === id)?.duration ?? 1e6).map((d) => Math.round(d * 100) / 100);
  if (!clips.length) return [];
  const run = footageRun({ analysis: cut.analysis, sections: originalOf(cut.analysis).sections, parents: parentsOf(cut.analysis), parts, clips, words: titleWords() });
  return run.seqs.flatMap((seq) => (seq ? insideRanges(seq).map((x) => ({ id: deckIds[x.clip % deckIds.length], range: x.range })) : []));
}

export async function readDepth(cut: Cut, o: { signal: AbortSignal; say: (text: string, n?: number, of?: number) => void }) {
  const s = useStudio.getState();
  const all = rangesOf(cut);
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
