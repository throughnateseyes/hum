/**
 * Make and the timing of the person's clips: what happens in each is found (src/timing, in this browser:
 * nothing is sent anywhere), and landed on the song once the pictures are chosen, by Claude or by Hum.
 */
import type { MediaNotes, PartShot, TrackAnalysis } from '../core/types';
import { titleWords } from '../scenes/footage';
import { deckIdsOf, footageRun, runPartOf, withOwn, type Run } from '../shot/run';
import { findLook, type VideoPlan } from '../state/plan';
import { originalOf, parentsOf } from '../state/planCache';
import { useStudio } from '../state/store';
import { eventsOf, motionOf, readMotion, readMotions, sawOf, timeParts, type Wanted } from '../timing';
import { curvesFor } from './feeling';
import { playsClips } from './footage';
import { fitsMoment } from './footageShots';
import { notesOf } from './media';

/** the longest a Make waits for the clips to be read */
const MOST_MS = 90000;

export interface CutShots {
  plan: VideoPlan;
  analysis: TrackAnalysis;
  shotAt: (i: number) => PartShot | null;
}

/** the run of shots a cut would play, with what each part shows; null when it has no footage */
export function runOfCut(cut: CutShots): { run: Run; deckIds: string[] } | null {
  const s = useStudio.getState();
  const deckIds = deckIdsOf(s.clips, s.photos);
  const clips = deckIds.map((id) => s.clips.find((c) => c.id === id)?.duration ?? 1e6).map((d) => Math.round(d * 100) / 100);
  if (!clips.length) return null;
  const parts = cut.analysis.sections.map((_, i) => {
    const look = cut.plan.looks[i] ? findLook(cut.plan.looks[i]!) : undefined;
    if (!look || look.sceneId !== 'footage') return null;
    return withOwn(runPartOf({ ...(look.sceneParams ?? {}), ...(s.tweaks[look.id]?.sceneParams ?? {}) }), cut.shotAt(i), deckIds);
  });
  const run = footageRun({ analysis: cut.analysis, sections: originalOf(cut.analysis).sections, parents: parentsOf(cut.analysis), parts, clips, words: titleWords(), feel: curvesFor(cut.plan, cut.analysis, s.lyrics) });
  return { run, deckIds };
}

/** start on every clip now, in the background */
export function beginTiming() {
  for (const c of useStudio.getState().clips) void readMotion(c);
}

/** wait for the clips to be read (not for ever); false when none is */
export async function readClips(o: { signal: AbortSignal; say: (text: string, n?: number, of?: number) => void }): Promise<boolean> {
  const { clips } = useStudio.getState();
  if (!clips.length) return false;
  if (clips.some((c) => !motionOf(c.id))) {
    o.say('Finding what happens in your clips');
    await Promise.race([
      readMotions(clips, o.signal, (n, of) => o.say('Finding what happens in your clips', Math.min(of, n + 1), of)),
      new Promise((r) => setTimeout(r, MOST_MS)),
    ]);
  }
  return clips.some((c) => motionOf(c.id));
}

/** the moments of a clip worth landing, for Claude: numbered from 1 in this order */
export function landable(id: string, notes?: MediaNotes): { at: number; what: string }[] {
  return eventsOf(motionOf(id) ?? null, notes)
    .filter((e) => e.strength >= (e.what ? 0.3 : 0.4))
    .sort((x, y) => (y.what ? 1 : 0) - (x.what ? 1 : 0) || y.strength - x.strength)
    .slice(0, 5)
    .sort((x, y) => x.at - y.at)
    .map((e) => ({ at: Math.round(e.at * 100) / 100, what: e.what ?? sawOf(e) }));
}

/**
 * The parts' choices with what happens in their clips landed on the song. `open`: the parts whose choice
 * is the director's; `free`: those of them whose clip nobody chose. The rest are cut around.
 */
export function timeCut(cut: CutShots, o: { open: Set<number>; free?: Set<number>; wanted?: Map<number, Wanted> }): (PartShot | null)[] {
  const s = useStudio.getState();
  const had = cut.analysis.sections.map((_, i) => cut.shotAt(i));
  const r = runOfCut(cut);
  if (!r) return had;
  const { run, deckIds } = r;
  const clipIds = deckIds.filter((id) => s.clips.some((c) => c.id === id));
  return timeParts({
    analysis: cut.analysis,
    feel: curvesFor(cut.plan, cut.analysis, s.lyrics),
    fits: fitsMoment,
    clipOf: (id) => ({ length: s.clips.find((c) => c.id === id)?.duration ?? 1e6, motion: motionOf(id) ?? null, notes: notesOf(id) }),
    parts: cut.analysis.sections.map((_, i) => {
      const seq = run.seqs[i];
      const look = cut.plan.looks[i] ? findLook(cut.plan.looks[i]!) : undefined;
      const id = seq?.shots.length ? (deckIds[seq.shots[0].footageIndex % deckIds.length] ?? '') : '';
      const clip = clipIds.includes(id) ? id : '';
      const open = o.open.has(i);
      const shot = seq && playsClips(look) ? (had[i] ?? (open ? null : {})) : null;
      return {
        shot,
        seq,
        clip,
        ...(open && o.free?.has(i) && clipIds.length > 1 ? { free: clipIds } : {}),
        ...(o.wanted?.has(i) ? { wanted: o.wanted.get(i)! } : {}),
        ...(open ? {} : { fixed: true }),
      };
    }),
  }).map((x, i) => (o.open.has(i) ? x : had[i]));
}
