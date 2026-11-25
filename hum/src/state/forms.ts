/** Which 3D form each inside shot of the video asks for (inside/formIds.ts): the person's pick, else by the song. */
import type { TrackAnalysis } from '../core/types';
import { formMoment, formShot, isForm, songForms, type FormId, type FormWish } from '../inside/formIds';
import { offIn } from '../shot/graphics';
import type { Shot } from '../shot/sequence';
import { shotOfPart } from '../shot/partShots';
import { isMoment } from '../moments';
import { shotRecordAt } from './inks';
import { notesOf } from '../director/media';
import { useStudio } from './store';

const picks = new WeakMap<TrackAnalysis, [FormId, FormId]>();
function pairOf(a: TrackAnalysis): [FormId, FormId] {
  let p = picks.get(a);
  if (!p) {
    const beats = (a.duration * a.bpm) / 60;
    p = songForms((a.layers?.kick.length ?? beats * 0.5) / Math.max(1, beats), Math.round(a.duration * 10));
    picks.set(a, p);
  }
  return p;
}

/** how far through the song's big parts this one comes, 0..1 */
function levelAt(a: TrackAnalysis, t: number): number {
  const s = useStudio.getState();
  if (!s.planOn || s.plan?.looks.length !== a.sections.length) return 0.5;
  const big = a.sections.flatMap((sec, i) => {
    const m = shotOfPart(i, s)?.moment;
    return isMoment(m) && formMoment(m) === 'main' ? [sec.start] : [];
  });
  if (big.length < 2) return 1;
  return big.filter((b) => b <= t + 0.05).length / big.length;
}

export function formIn(shot: Shot, a: TrackAnalysis, mediaId: string | null): FormWish | null {
  const rec = shotRecordAt(shot.start + 0.01);
  if (rec?.form === 'none' || rec?.graphics === 'off' || shot.drawn) return null;
  if (isForm(rec?.form)) return { ids: [rec.form], level: 1, asked: true };
  const kind = formMoment(shot.moment);
  if (!kind || !formShot(kind, shot.index, shot.end - shot.start)) return null;
  const off = offIn(rec, useStudio.getState().graphicsOff);
  const [main, other] = pairOf(a);
  const ids: FormId[] = kind === 'main' ? [main, other] : [other, main];
  if (kind === 'main' && mediaId && /zebra|cross-?walk|pedestrian crossing|road marking|lane marking/i.test(notesOf(mediaId)?.subject ?? '')) ids.unshift('crossing');
  const on = ids.filter((id) => !off.includes(`f-${id}`));
  return on.length ? { ids: on, level: levelAt(a, shot.start), asked: false } : null;
}
