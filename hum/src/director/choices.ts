/**
 * Other choices for a part, ready at once: no Claude call. For footage, the person's other media that suits
 * the moment and isn't what plays on either side, the same picture seen closer or whole, another style, or
 * another stretch of the same clip; for a graphic look, the looks that rank next. Trying one on shows it
 * without touching the video; choosing it is a change by hand (state/partEdit.ts), one undo step, and it
 * comes through a remake the way every change by hand does.
 */
import type { MediaNotes, PartShot, Preset } from '../core/types';
import { audioEngine } from '../audio/engine';
import { rank, type MomentId } from '../moments';
import { familyIdOf, familyOf } from '../presets/fit';
import { tryShot } from '../shot/partShots';
import { styleOn } from '../shot/graphics';
import { STYLE_IDS, STYLE_NAMES, STYLE_SERVES, type StyleId } from '../shot/styles';
import { askedFor } from '../state/history';
import { setPartsLook, setPartsShot } from '../state/partEdit';
import { findLook, partEnergy, relatedLooks, releaseHold, tryLook, worldOf } from '../state/plan';
import { useStudio } from '../state/store';
import { affinityIn, contextFor } from '../state/taste';
import { mayPlan } from './footage';
import { fitsMoment } from './footageShots';
import { notesOf, ownMedia } from './media';
import { laidAt, partNow, playingVideo, type PartNow, type Playing } from './partNow';

/** one thing a part could show instead */
export interface Choice {
  /** the same for the same choice, as long as the part shows what it does */
  id: string;
  /** the part it is for */
  part: number;
  /** a few plain words ("The bridge clip", "Closer on the subject") */
  label: string;
  /** a word or two, for under its picture ("Closer", the clip's name) */
  short: string;
  /** a line more, where there is something to say (what is in the picture, what the look is) */
  detail: string;
  /** what to show as its picture: a clip or photo with where to look, or a look */
  thumb: { kind: 'media'; id: string; focusX: number; focusY: number; zoom: number } | { kind: 'look'; look: Preset };
  /** what choosing it does: fields of the part's own picture (undefined: back to the director's), or another look */
  patch?: Partial<PartShot>;
  look?: string;
}

const MOST = 4;

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
const nameOf = (id: string): string => {
  const s = useStudio.getState();
  return (s.clips.find((c) => c.id === id)?.name ?? s.photos.find((p) => p.id === id)?.name ?? '').replace(/\.[a-z0-9]{2,4}$/i, '');
};
const lengthOf = (id: string) => useStudio.getState().clips.find((c) => c.id === id)?.duration ?? 0;
/** a media choice, in words */
const pictureWords = (id: string) => {
  const name = clip(nameOf(id), 28);
  const kind = lengthOf(id) ? 'clip' : 'photo';
  return name ? `The ${kind} “${name}”` : `Another ${kind}`;
};

/** where a picture looks, from the notes on it (else its middle) */
const focusOf = (n: MediaNotes | undefined) => ({ focusX: n?.focusX ?? 0.5, focusY: n?.focusY ?? 0.55 });

/** the seconds of a clip a part could start on, best first, with room for the part and none of them one in `avoid` */
function startsIn(id: string, need: number, avoid: number[]): number[] {
  const length = lengthOf(id);
  if (!length) return [];
  const last = Math.max(0.05, length - Math.min(length * 0.6, need) - 0.25);
  const good = (notesOf(id)?.ins ?? []).map((x) => x.at);
  const spread = [0.12, 0.45, 0.75].map((k) => k * length);
  const out: number[] = [];
  for (const t of [...good, ...spread]) {
    const at = Math.round(Math.min(last, Math.max(0.05, t)) * 100) / 100;
    if (![...avoid, ...out].some((x) => Math.abs(x - at) < 0.8)) out.push(at);
  }
  return out;
}

/** what the parts on either side show (`picked`: what is about to be shown there instead) */
function beside(v: Playing, i: number, picked: Map<number, PartShot>) {
  const near = [i - 1, i + 1].filter((j) => j >= 0 && j < v.analysis.sections.length).map((j) => {
    const now = partNow(v, j);
    return { ...now, shot: { ...now.shot, ...picked.get(j) } };
  });
  return {
    media: new Set(near.flatMap((x) => (x.footage ? [x.shot.media?.[0] ?? ''] : []))),
    styles: new Set(near.flatMap((x) => (x.footage && x.shot.style && x.shot.style !== 'plain' && x.shot.style !== 'inside' ? [x.shot.style] : []))),
    looks: new Set(near.flatMap((x) => (x.look ? [x.look.id] : []))),
  };
}

/** a footage part's other choices, best of each kind first, as many as there are */
function footageChoices(v: Playing, now: PartNow, picked: Map<number, PartShot>): Choice[] {
  const { i } = now;
  const sec = v.analysis.sections[i];
  const need = sec.end - sec.start;
  const shot = now.shot;
  const id = shot.media?.[0] ?? '';
  const notes = notesOf(id);
  const near = beside(v, i, picked);
  const zoom = shot.zoom ?? 1;
  const at = { focusX: shot.focusX ?? focusOf(notes).focusX, focusY: shot.focusY ?? focusOf(notes).focusY };
  const moment: MomentId = now.moment ?? (sec.energy > 0.6 ? 'rush' : 'drift');
  const drawn = laidAt(v, i)?.drawn;
  const make = (key: string, label: string, short: string, detail: string, patch: Partial<PartShot>, pic: { id: string; focusX: number; focusY: number; zoom: number }): Choice => ({ id: `${i}:${key}`, part: i, label, short, detail, thumb: { kind: 'media', ...pic }, patch });

  /* another picture */
  const others = ownMedia().filter((m) => m.id !== id);
  const score = (mid: string) => {
    const n = notesOf(mid);
    return n ? fitsMoment(n, moment) : -0.6;
  };
  const free = others.filter((m) => !near.media.has(m.id)).sort((x, y) => score(y.id) - score(x.id));
  const pictures = free.slice(0, 3).map((m): Choice => {
    const n = notesOf(m.id);
    const from = m.kind === 'clip' ? startsIn(m.id, need, [])[0] : undefined;
    const f = focusOf(n);
    return make(
      `media-${m.id}`,
      pictureWords(m.id),
      nameOf(m.id) || (m.kind === 'clip' ? 'Clip' : 'Photo'),
      n ? clip(n.subject, 80) : '',
      // what was chosen for the picture before doesn't go with this one
      { media: [m.id], from, focusX: f.focusX, focusY: f.focusY, zoom: undefined, ...(drawn ? { drawn: null } : {}) },
      { id: m.id, ...f, zoom: 1 },
    );
  });

  /* the same picture, seen another way */
  const inside = shot.style === 'inside';
  const close = inside ? 1.35 : 1.7;
  const framing: Choice[] = [];
  if (id) {
    const f = focusOf(notes);
    if (zoom < close - 0.25) framing.push(make('closer', notes?.faces ? 'Closer on the face' : 'Closer on the subject', 'Closer', notes ? clip(notes.subject, 80) : '', { focusX: f.focusX, focusY: f.focusY, zoom: close }, { id, ...f, zoom: close }));
    if (zoom > 1.2) framing.push(make('whole', 'The whole picture', 'Whole', 'Not pushed in', { ...at, zoom: 1 }, { id, ...at, zoom: 1 }));
  }

  /* another style */
  const s = useStudio.getState();
  const sung = !!s.lyrics?.lines.length;
  const styles = rank(STYLE_SERVES, moment, STYLE_IDS)
    .filter((x): x is StyleId => x !== shot.style && !near.styles.has(x) && (x !== 'poster' || !sung) && styleOn(x, s.graphicsOff) && (x !== 'inside' || !!v.plan.paint))
    // the plain picture is there for a style with nothing on it; the others come first when there is nothing on it now
    .sort((x, y) => Number(x === 'plain' || x === 'inside') - Number(y === 'plain' || y === 'inside') || 0);
  const ownStyles = inside || shot.style === 'plain' ? styles : [...styles.filter((x) => x === 'inside' || x === 'plain'), ...styles.filter((x) => x !== 'inside' && x !== 'plain')];
  const words: Record<StyleId, string> = {
    inside: 'The words stand in the picture',
    plain: 'The picture alone, nothing on it',
    caption: 'A small slate in one corner',
    poster: 'One word, the picture inside its letters',
    window: 'A flat field with the picture in an opening',
    slab: 'A flat band along one edge',
    grid: 'Cut into cells on the beat',
    split: 'Panels side by side',
  };
  const styled = (id ? ownStyles : []).slice(0, 3).map((x) => make(`style-${x}`, `Style: ${STYLE_NAMES[x]}`, STYLE_NAMES[x], words[x], { style: x, ...(x === 'inside' ? { treatment: 'none' } : {}) }, { id, ...at, zoom }));

  /* another stretch of the same clip */
  const here = shot.from ?? shot.hit ?? 0;
  const later = id ? startsIn(id, need, [here])[0] : undefined;
  const stretch = later === undefined ? [] : [make(`from-${later}`, here < later ? 'Later in the same clip' : 'Earlier in the same clip', here < later ? 'Later' : 'Earlier', `From ${later.toFixed(1)} s`, { media: shot.media, from: later, ...at, ...(zoom > 1 ? { zoom } : {}) }, { id, ...at, zoom })];

  // one of each kind first, then what is left
  const rows = [pictures, framing, styled, stretch];
  const out: Choice[] = [];
  for (let k = 0; k < 3; k++) for (const row of rows) if (row[k]) out.push(row[k]);
  // (pictures are what people look for: two of them before the fourth)
  const second = out.indexOf(pictures[1]);
  if (second > 2) out.splice(2, 0, ...out.splice(second, 1));
  return out;
}

/** a graphic part's other looks, best first: one per family, never a neighbour's, never one the person skips here */
function lookChoices(v: Playing, now: PartNow): Choice[] {
  const { i } = now;
  const id = v.plan.looks[i];
  if (!id) return [];
  const sec = v.analysis.sections[i];
  const aff = affinityIn(contextFor(sec.label));
  const near = beside(v, i, new Map());
  const families = new Set(now.look ? [familyIdOf(now.look)] : []);
  const out: Choice[] = [];
  for (const x of relatedLooks(id, v.analysis, v.plan.looks, (q) => 1.5 * aff(q), { label: sec.label, energy: partEnergy(v.analysis, i) }, worldOf(v.plan))) {
    const look = findLook(x);
    if (!look || x === id || near.looks.has(x) || aff(x) <= -0.4 || !mayPlan(look) || look.sceneId === 'footage') continue;
    const fam = familyIdOf(look);
    if (families.has(fam)) continue;
    families.add(fam);
    out.push({ id: `${i}:look-${x}`, part: i, label: look.name, short: look.name, detail: clip(familyOf(look).blurb || look.description, 80), thumb: { kind: 'look', look }, look: x });
    if (out.length >= 12) break;
  }
  return out;
}

/** every other choice for part i, best first (`picked`: parts about to show something else) */
export function allChoices(v: Playing, i: number, picked: Map<number, PartShot> = new Map()): Choice[] {
  if (i < 0 || i >= v.analysis.sections.length) return [];
  const now = partNow(v, i);
  return now.footage ? footageChoices(v, now, picked) : lookChoices(v, now);
}

/** up to four other choices for a part, ready to show */
export function choicesFor(part: number): Choice[] {
  const v = playingVideo();
  return v ? allChoices(v, part).slice(0, MOST) : [];
}

/* ───────── trying one on ───────── */

/** a hand record with a choice's fields put in (a field given as undefined goes back) */
function patched(hand: PartShot | null, patch: Partial<PartShot>): PartShot {
  const out: Record<string, unknown> = { ...hand, ...patch };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as PartShot;
}

let off: (() => void) | null = null;

/** the choice being tried on goes: the part shows what it did */
export function endPreview() {
  if (!off) return;
  off();
  off = null;
  tryShot(null);
  releaseHold();
}

/**
 * Show a choice where its part plays, without changing anything: no undo step, nothing saved, and it goes
 * by itself when the video changes, a render starts or another choice is tried. Null ends it. With the song
 * elsewhere, it goes to the part, so there is something to see.
 */
export function previewChoice(choice: Choice | null): void {
  endPreview();
  const s = useStudio.getState();
  const v = playingVideo(s);
  if (!choice || !v || s.clip || s.planning || !s.planOn || audioEngine.kind !== 'file') return;
  const sec = v.analysis.sections[choice.part];
  if (!sec) return;
  const t = audioEngine.currentTime;
  if (t < sec.start || t >= sec.end) audioEngine.seek(Math.min(sec.end - 0.05, sec.start + Math.min(1, (sec.end - sec.start) * 0.3)));
  const { plan } = v;
  if (choice.patch) {
    const at = { ...v, hand: v.analysis.sections.map((_, j) => (j === choice.part ? patched(v.hand?.[j] ?? null, choice.patch!) : (v.hand?.[j] ?? null))) };
    tryShot({ plan, part: choice.part, shot: laidAt(at, choice.part) });
  } else {
    const look = choice.look ? findLook(choice.look) : undefined;
    if (!look) return;
    tryLook(look);
  }
  const gone = useStudio.subscribe((now) => {
    if (now.plan !== plan || now.partShot !== s.partShot || now.clip || !now.planOn) endPreview();
  });
  off = gone;
}

/** put a choice in: a change by hand, one undo step */
export function applyChoice(choice: Choice): boolean {
  endPreview();
  const s = useStudio.getState();
  const v = playingVideo(s);
  if (!v || s.clip || s.planning || choice.part >= v.analysis.sections.length) return false;
  askedFor();
  if (choice.look) setPartsLook([choice.part], choice.look);
  else if (choice.patch) setPartsShot([choice.part], choice.patch);
  const after = useStudio.getState();
  return after.plan !== s.plan || after.partShot !== s.partShot;
}
