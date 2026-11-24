/**
 * What the video plays now lands on the song, for the app to show: the Part tab's line under a part's
 * picture (FootagePicture.tsx) and the marks in the Breakdown.
 */
import { useEffect, useMemo, useState } from 'react';
import { dropList } from './song';
import { shotOfPart } from '../shot/partShots';
import type { RampId } from '../shot/sequence';
import { validPlan } from '../state/plan';
import { originalOf } from '../state/planCache';
import { useStudio } from '../state/store';
import { eventsOf, motionOf, sawOf } from '../timing';
import { runOfCut } from '../director/footageTiming';
import { notesOf, recallNotes } from '../director/media';

export interface Landing {
  part: number;
  /** song second */
  at: number;
  clip: string;
  /** the clip second it happens on, and the one the part starts on */
  second: number;
  from: number;
  ramp: RampId;
  /** what happens, as Claude named it or as Hum measured it ('' when nothing is known of it any more) */
  what: string;
  /** what of the song it lands on */
  on: 'drop' | 'word' | 'cut' | 'beat';
}

/** every landing of the video that plays now, in time order */
export function landingsNow(): Landing[] {
  const s = useStudio.getState();
  const a = s.analysis;
  if (!a || !s.planOn || !s.plan?.flat || !validPlan(s.plan, a) || !s.clips.length) return [];
  const shots = a.sections.map((_, i) => shotOfPart(i, s));
  if (!shots.some((x) => x?.hit !== undefined)) return [];
  const r = runOfCut({ plan: s.plan, analysis: a, shotAt: (i) => shots[i] });
  if (!r) return [];
  const drops = dropList(originalOf(a));
  const words = (s.lyrics?.lines ?? []).flatMap((l) => l.words ?? []);
  const out: Landing[] = [];
  r.run.seqs.forEach((seq, part) => {
    for (const shot of seq?.shots ?? []) {
      const id = r.deckIds[shot.footageIndex % r.deckIds.length];
      if (!shot.hit || !s.clips.some((c) => c.id === id)) continue;
      const { at, clip, ramp } = shot.hit;
      const e = eventsOf(motionOf(id) ?? null, notesOf(id)).reduce<ReturnType<typeof eventsOf>[number] | null>((b, x) => (Math.abs(x.at - clip) < 0.11 && (!b || Math.abs(x.at - clip) < Math.abs(b.at - clip)) ? x : b), null);
      out.push({
        part,
        at,
        clip: id,
        second: clip,
        from: shot.clipFrom ?? 0,
        ramp,
        what: e ? (e.what ?? sawOf(e)) : '',
        on: drops.some((d) => Math.abs(d.t - at) < 0.12) ? 'drop' : Math.abs(at - a.sections[part].start) < 0.05 ? 'cut' : words.some((w) => Math.abs(w.t - at) < 0.04) ? 'word' : 'beat',
      });
    }
  });
  return out.sort((x, y) => x.at - y.at);
}

/** the same, kept up to date in a component */
export function useLandings(): Landing[] {
  const a = useStudio((s) => s.analysis);
  const plan = useStudio((s) => s.plan);
  const planOn = useStudio((s) => s.planOn);
  const partShot = useStudio((s) => s.partShot);
  const clips = useStudio((s) => s.clips);
  const photos = useStudio((s) => s.photos);
  const tweaks = useStudio((s) => s.tweaks);
  const lyrics = useStudio((s) => s.lyrics);
  const making = useStudio((s) => !!s.making);
  const [known, setKnown] = useState(0);
  useEffect(() => {
    let on = true;
    void recallNotes().then(() => on && setKnown(1));
    return () => {
      on = false;
    };
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (making ? [] : landingsNow()), [a, plan, planOn, partShot, clips, photos, tweaks, lyrics, making, known]);
}
