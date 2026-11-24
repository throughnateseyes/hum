/**
 * The person's clips and photos as the picture controls need them (FootagePicture.tsx, MediaPicker.tsx,
 * the Library's tiles, the timeline's blocks and drops, the stage's drop), and the one way a picture is
 * given to a part or to the look on screen, whether by a click, a drag or the Library's "Use" action.
 *
 *   useMedia        the clips, then the photos, each with a small still
 *   pictureKind     what a scene can show: clips and photos (footage looks), photos only (photo looks), none
 *   giveMedia       make a clip or photo the picture of some parts, or of the look playing on its own;
 *                   a look that can't show it gets a note offering to switch to the Footage look
 *   shownMedia      which clip or photo a part will actually play (for the timeline's thumbnails)
 */
import { create } from 'zustand';
import { audioEngine } from '../audio/engine';
import type { ClipAsset, ParamValue, PartShot, PhotoAsset, Preset } from '../core/types';
import { getScene } from '../scenes';
import { planPlaying, setPartsLook, setPartsShot, setSoloShot } from '../state/partEdit';
import { findLook, listNames, partNames, sectionIndexAt, validPlan } from '../state/plan';
import { useStudio, type StudioState } from '../state/store';
import { plannedShot, shotOfPart } from '../shot/partShots';
import { mediaForPart } from '../shot/run';

/** one clip or photo, as the picker and the framing preview need it */
export interface MediaItem {
  id: string;
  name: string;
  kind: 'clip' | 'photo';
  /** a small still: the clip's own thumb, or one drawn from the photo */
  thumb: string;
  width: number;
  height: number;
  /** seconds, for clips */
  duration?: number;
}

/** what a dragged clip or photo carries (its id) */
export const MEDIA_MIME = 'application/x-hum-media';

const photoThumbs = new WeakMap<object, string>();

/** a small square-ish JPEG of a photo, drawn once and kept for as long as the photo is */
function photoThumb(p: PhotoAsset): string {
  const had = photoThumbs.get(p.image);
  if (had) return had;
  const src = p.image;
  const w = 'naturalWidth' in src ? src.naturalWidth : src.width;
  const h = 'naturalHeight' in src ? src.naturalHeight : src.height;
  let url = '';
  try {
    // long side 240: big enough for the framing preview, small enough to draw at once
    const k = 240 / Math.max(1, w, h);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
    url = c.toDataURL('image/jpeg', 0.8);
  } catch {
    /* a photo that can't be drawn shows as an empty tile */
  }
  photoThumbs.set(p.image, url);
  return url;
}

const clipItem = (c: ClipAsset): MediaItem => ({ id: c.id, name: c.name, kind: 'clip', thumb: c.thumb, width: c.width, height: c.height, duration: c.duration });
const photoItem = (p: PhotoAsset): MediaItem => ({ id: p.id, name: p.name, kind: 'photo', thumb: photoThumb(p), width: p.width, height: p.height });

/** the person's clips, then their photos (the built-in stand-in photo isn't theirs to pick) */
export function mediaOf(s: Pick<StudioState, 'clips' | 'photos'>): MediaItem[] {
  return [...s.clips.map(clipItem), ...s.photos.filter((p) => !p.builtin).map(photoItem)];
}

/** the same, kept up to date in a component */
export function useMedia(): MediaItem[] {
  const clips = useStudio((s) => s.clips);
  const photos = useStudio((s) => s.photos);
  return mediaOf({ clips, photos });
}

/** the value a look plays with for one of its scene's settings: the person's tweak, the preset, the default */
export function lookParam(p: Preset, tweak: { sceneParams?: Record<string, ParamValue> } | undefined, k: string): ParamValue | undefined {
  return tweak?.sceneParams?.[k] ?? p.sceneParams?.[k] ?? getScene(p.sceneId)?.params.find((d) => d.id === k)?.default;
}

/** what a scene shows of the person's media: 'footage' clips and photos, 'photos' photos only, or null */
export type PictureKind = 'footage' | 'photos' | null;
export function pictureKind(sceneId: string | undefined): PictureKind {
  const sc = sceneId ? getScene(sceneId) : undefined;
  return sc?.usesClips ? 'footage' : sc?.usesPhotos ? 'photos' : null;
}

/** can a look of this kind show this clip or photo? */
export const canShow = (kind: PictureKind, m: { kind: 'clip' | 'photo' }) => kind === 'footage' || (kind === 'photos' && m.kind === 'photo');

/** the Footage look a part switches to when its own look can't show the picture given to it */
export const FOOTAGE_LOOK = 'footage-bands';

/**
 * Which clip or photo part i will play: its own first pick, else the one the footage run deals it
 * (shot/run.ts). Null when the part's look shows none.
 */
export function shownMedia(s: StudioState, i: number, media: MediaItem[]): MediaItem | null {
  const a = s.analysis;
  if (!a || !validPlan(s.plan, a)) return null;
  const kind = pictureKind(findLook(s.plan.looks[i])?.sceneId);
  if (!kind) return null;
  const own = shotOfPart(i, s)?.media;
  const fits = media.filter((m) => canShow(kind, m));
  const mine = own?.map((id) => fits.find((m) => m.id === id)).find((m) => !!m);
  if (mine) return mine;
  // a photo look with nothing chosen shows the look's own picture on the timeline, as before
  if (kind !== 'footage') return null;
  // a footage part with nothing chosen: the picture the run will deal it (clips rotate from cut to cut)
  const dealt = mediaForPart(a, i);
  return fits.find((m) => m.id === dealt) ?? fits[0] ?? null;
}

/* ───────── giving a picture to parts, or to the look on screen ───────── */

/** what the picture is being given to: picked parts, or the look playing on its own */
export type MediaTarget = { parts: number[] } | 'solo';

/** the note a drop or a "Use" leaves (shown by MediaNote in MediaPicker.tsx) */
export interface MediaNoteState {
  text: string;
  /** the obvious next step, one click (switch to the Footage look with this picture) */
  offer?: { label: string; run: () => void };
  key: number;
}
export const useMediaNote = create<{ note: MediaNoteState | null }>(() => ({ note: null }));
let noteTimer = 0;
export function showMediaNote(text: string, offer?: MediaNoteState['offer']) {
  clearTimeout(noteTimer);
  useMediaNote.setState({ note: { text, offer, key: Date.now() } });
  // a note with a choice in it stays long enough to take it
  noteTimer = window.setTimeout(() => useMediaNote.setState({ note: null }), offer ? 7000 : 2600);
}
export const hideMediaNote = () => {
  clearTimeout(noteTimer);
  useMediaNote.setState({ note: null });
};

/** where a picture given "here" goes: the picked parts, else the part playing, else the look on its own */
export function hereTarget(s = useStudio.getState()): MediaTarget {
  if (!s.analysis || !validPlan(s.plan, s.analysis)) return 'solo';
  const n = s.analysis.sections.length;
  const sel = s.selectedParts.filter((i) => i >= 0 && i < n);
  if (sel.length) return { parts: sel };
  if (!planPlaying(s)) return 'solo';
  return { parts: [sectionIndexAt(s.analysis.sections, audioEngine.currentTime)] };
}

/** the stage: the part that is playing, or the look on its own */
export function playingTarget(s = useStudio.getState()): MediaTarget {
  if (!planPlaying(s)) return 'solo';
  return { parts: [sectionIndexAt(s.analysis!.sections, audioEngine.currentTime)] };
}

/** "this shot", "these 3 shots", "this look": what a "Use" action would change */
export function targetWords(t: MediaTarget): string {
  if (t === 'solo') return 'this look';
  return t.parts.length > 1 ? `these ${t.parts.length} shots` : 'this shot';
}

/**
 * Make clip or photo `id` the picture of `target` (`add`: put it with the ones already chosen). Parts
 * whose look can't show it are left alone, and a note offers to switch them to the Footage look with
 * this picture, one click and one Undo step.
 */
export function giveMedia(id: string, target: MediaTarget, add = false) {
  const s = useStudio.getState();
  const item = mediaOf(s).find((m) => m.id === id);
  if (!item) return;
  const what = item.kind === 'clip' ? 'clip' : 'photo';
  const plus = (cur: string[] | undefined) => (add ? [...(cur ?? []).filter((x) => x !== id), id] : [id]);
  if (target === 'solo') {
    const kind = pictureKind(s.sceneId);
    if (canShow(kind, item)) {
      setSoloShot({ media: plus(s.soloShot?.media) });
      showMediaNote(`${item.name} is the picture of this look${add ? ', with the others' : ''}`);
      return;
    }
    showMediaNote(kind === 'photos' ? `This look shows photos only, not clips.` : `This look doesn’t show your clips or photos.`, {
      label: `Play it in the Footage look`,
      run: () => {
        const p = findLook(FOOTAGE_LOOK);
        if (!p) return;
        useStudio.getState().applyPreset(p);
        setSoloShot({ media: [id] });
        showMediaNote(`${item.name} plays in the Footage look`);
      },
    });
    return;
  }
  const a = s.analysis;
  const plan = s.plan;
  if (!a || !validPlan(plan, a)) return;
  const n = a.sections.length;
  const names = partNames(a);
  const parts = target.parts.filter((i) => i >= 0 && i < n);
  const ok = parts.filter((i) => canShow(pictureKind(findLook(plan.looks[i])?.sceneId), item));
  const no = parts.filter((i) => !ok.includes(i));
  for (const i of ok) setPartsShot([i], { media: plus(s.partShot?.length === n ? s.partShot[i]?.media : undefined) });
  const who = (is: number[]) => (is.length > 2 ? `${is.length} parts` : listNames(is.map((i) => names[i])));
  if (!no.length) {
    showMediaNote(`${item.name} → ${who(ok)}`);
    return;
  }
  const why = ok.length ? `${item.name} → ${who(ok)}. ${who(no)} can’t show a ${what}.` : `The look in ${who(no)} can’t show a ${what}.`;
  showMediaNote(why, {
    label: `Switch ${no.length > 1 ? 'them' : 'it'} to Footage with this ${what}`,
    run: () => {
      setPartsLook(no, FOOTAGE_LOOK);
      setPartsShot(no, { media: [id] });
      showMediaNote(`${who(no)} now ${no.length > 1 ? 'play' : 'plays'} ${item.name} in the Footage look`);
    },
  });
}

/* ───────── the Picture controls' target, and opening them ───────── */

/** what the Picture controls change: some parts of the plan, or the look on its own */
export interface ShotTarget {
  /** remount key: which parts, or 'solo' */
  key: string;
  shots: (PartShot | null)[];
  /** what the director chose for each (what a shot with no choice of the person's plays) */
  planned: (PartShot | null)[];
  set: (patch: Partial<PartShot> | null) => void;
  /** the look's own value of one of its scene's settings (what a shot with no choice follows) */
  lookValue: (k: string) => ParamValue | undefined;
  sceneId: string;
  /** "this shot", "these shots", "this look" */
  scope: string;
  solo: boolean;
}

/** the target for parts of the plan playing `look` (defaults from that look and its tweaks) */
export function usePartsTarget(parts: number[], look: Preset): ShotTarget {
  const n = useStudio((s) => s.analysis?.sections.length ?? -1);
  const partShot = useStudio((s) => s.partShot);
  const tweak = useStudio((s) => s.tweaks[look.id]);
  const plan = useStudio((s) => s.plan);
  const planned = parts.map((j) => plannedShot(plan, j));
  // a setting the director chose for this shot stands in for the look's
  const own = (k: string) => (planned.length === 1 ? (planned[0] as Record<string, unknown> | null)?.[k] : undefined) as ParamValue | undefined;
  return {
    key: parts.join(','),
    shots: parts.map((j) => (partShot?.length === n ? (partShot[j] ?? null) : null)),
    planned,
    set: (patch) => setPartsShot(parts, patch),
    lookValue: (k) => own(k) ?? lookParam(look, tweak, k),
    sceneId: look.sceneId,
    scope: parts.length > 1 ? 'these shots' : 'this shot',
    solo: false,
  };
}

/** the target for the look playing on its own (its settings as they are on screen) */
export function useSoloTarget(): ShotTarget {
  const soloShot = useStudio((s) => s.soloShot);
  const sceneParams = useStudio((s) => s.sceneParams);
  const sceneId = useStudio((s) => s.sceneId);
  return {
    key: 'solo',
    shots: [soloShot],
    planned: [null],
    set: (patch) => setSoloShot(patch),
    lookValue: (k) => sceneParams[k] ?? getScene(sceneId)?.params.find((d) => d.id === k)?.default,
    sceneId,
    scope: 'this look',
    solo: true,
  };
}


/** set by showPicture: the next Part tab to open scrolls to its Picture group */
let wantPicture = false;

/** open the Part tab on these parts, scrolled to their Picture group (the timeline's "Change picture…") */
export function showPicture(parts: number[]) {
  wantPicture = true;
  useStudio.getState().set({ selectedParts: parts, inspectorTab: 'part' });
  // already showing these parts: no remount, so scroll now
  requestAnimationFrame(() => requestAnimationFrame(scrollToPicture));
}

export function scrollToPicture() {
  if (!wantPicture) return;
  const el = document.getElementById('pp-picture');
  if (!el) return;
  wantPicture = false;
  el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  el.querySelector<HTMLElement>('.mp-tile, .mp-add')?.focus({ preventScroll: true });
}

