/** Which 3D form each inside shot of the video asks for (inside/formIds.ts): the person's pick, else by the song. */
import type { TrackAnalysis } from '../core/types';
import type { ClipScene } from '../depth/types';
import { formMoment, formParts, formShot, isForm, songForms, type FormId, type FormWish } from '../inside/formIds';
import { sceneOf } from '../inside/readings';
import { offIn } from '../shot/graphics';
import type { Shot } from '../shot/sequence';
import { shotOfPart } from '../shot/partShots';
import { isMoment } from '../moments';
import { shotRecordAt } from './inks';
import { originalOf } from './planCache';
import { notesOf } from '../director/media';
import { useStudio } from './store';

const picks = new WeakMap<TrackAnalysis, FormId[]>();
function orderOf(a: TrackAnalysis): FormId[] {
  const song = originalOf(a);
  let p = picks.get(song);
  if (!p) {
    const beats = (song.duration * song.bpm) / 60;
    p = songForms((song.layers?.kick.length ?? beats * 0.5) / Math.max(1, beats), Math.round(song.duration * 10));
    picks.set(song, p);
  }
  return p;
}

/** has this clip ground to stand a form on? Settled once its depth is known, so a choice doesn't come and go; true until then */
const roomy = new WeakMap<ClipScene, boolean>();
function hasRoom(id: string | undefined): boolean {
  const scene = id ? sceneOf(id) : null;
  if (!scene) return true;
  let yes = roomy.get(scene);
  if (yes === undefined) roomy.set(scene, (yes = scene.ground > 0.06 && scene.sure.horizon > 0.3));
  return yes;
}

/** the parts of the video that have one, worked out again when the plan, the parts' own choices or what is known of the clips change */
let last: { plan: unknown; own: unknown; a: unknown; media: string[]; rooms: string; parts: Map<number, number> } | null = null;
const roomsOf = (media: string[]) => media.map((id) => (hasRoom(id) ? 1 : 0)).join('');
function partsNow(): Map<number, number> | null {
  const s = useStudio.getState();
  const a = s.analysis;
  if (!a || !s.planOn || s.plan?.looks.length !== a.sections.length) return null;
  if (last && last.plan === s.plan && last.own === s.partShot && last.a === a && last.rooms === roomsOf(last.media)) return last.parts;
  const media = new Set<string>();
  const kinds = a.sections.map((_, i) => {
    const r = shotOfPart(i, s);
    if (r?.style !== 'inside' || r.drawn || !isMoment(r.moment) || !formMoment(r.moment)) return '' as const;
    for (const id of r.media ?? []) media.add(id);
    return !r.media?.length || r.media.some(hasRoom) ? r.moment : ('' as const);
  });
  const ids = [...media];
  last = { plan: s.plan, own: s.partShot, a, media: ids, rooms: roomsOf(ids), parts: formParts(kinds) };
  return last.parts;
}

export function formIn(shot: Shot, a: TrackAnalysis, mediaId: string | null): FormWish | null {
  const rec = shotRecordAt(shot.start + 0.01);
  if (rec?.form === 'none' || rec?.graphics === 'off' || shot.drawn) return null;
  if (isForm(rec?.form)) return { ids: [rec.form], level: 1, asked: true };
  const kind = formMoment(shot.moment);
  if (!kind || !formShot(kind, shot.index, shot.end - shot.start)) return null;
  const s = useStudio.getState();
  const off = offIn(rec, s.graphicsOff);
  const parts = partsNow();
  // which of the video's forms this is: the main one mostly, the others between
  let nth = kind === 'main' ? 0 : 1;
  let level = 0.6;
  if (parts) {
    const i = s.analysis!.sections.findLastIndex((x) => x.start <= shot.start + 0.01);
    const at = parts.get(i);
    if (at === undefined) return null;
    nth = [0, 1, 0, 2][at % 4];
    level = parts.size < 2 ? 1 : at / (parts.size - 1);
  }
  const order = orderOf(a);
  const ids: FormId[] = [order[nth], ...order.filter((_, k) => k !== nth)];
  if (kind === 'main' && mediaId && /zebra|cross-?walk|pedestrian crossing|road marking|lane marking/i.test(notesOf(mediaId)?.subject ?? '')) ids.unshift('crossing');
  const on = ids.filter((id) => !off.includes(`f-${id}`));
  return on.length ? { ids: on, level, asked: false } : null;
}
