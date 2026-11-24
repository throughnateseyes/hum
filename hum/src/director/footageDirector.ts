/**
 * Directing a video from the person's own footage, in small steps (server/steps/footage.ts):
 *
 *   watch    notes on each clip and photo, once ever (media.ts)
 *   story    the idea, a moment per section, which pictures belong where
 *   (plan)   the looks, told the story (state/plan.ts requestVideoPlan)
 *   shots    what each footage part of the cut video shows
 *   review   small stills of it, once: the weak shots are replaced while it plays
 *
 * Claude only ever chooses: which picture, which second, which moment, which template. The cutting,
 * speeds, cameras and exact times are worked out by code. What it chose is kept on the plan by time
 * (VideoPlan.cues), under whatever the person set by hand. Any step may fail: the next one carries on
 * with what there is, and `note` says so in a line.
 */
import { textBetween } from '../audio/lyrics';
import type { Lyrics, MediaNotes, PartShot, TrackAnalysis } from '../core/types';
import { MOTION_IDS, MOTION_SERVES, isMotion } from '../shot/motion';
import { STYLE_IDS, STYLE_SERVES, isStyle } from '../shot/styles';
import { TREATMENT_IDS, TREATMENT_SERVES, isTreatment } from '../shot/treatments';
import { layShot, type ShotCue } from '../shot/partShots';
import { dropAt, isMoment, momentsFor, type MomentId, type Serves } from '../moments';
import { carryByTime, carryEdits, flattenPlan } from '../state/flatPlan';
import { LYRIC_MEDIUMS, type LyricMedium } from '../state/lyricPlan';
import { findLook, partEdits, sectionIndexAt, validPlan, type VideoPlan } from '../state/plan';
import { parentsOf } from '../state/planCache';
import { useStudio } from '../state/store';
import { audioEngine } from '../audio/engine';
import { requestStep } from './client';
import { playsClips } from './footage';
import { framesSent } from './footageNotice';
import { momentShots } from './footageShots';
import { notesOf, ownMedia, recallNotes, unwatched, watchMedia } from './media';

/** one Make: what stops it and how it says where it is */
export interface MakeRun {
  signal: AbortSignal;
  say: (text: string, n?: number, of?: number) => void;
  /** a step that failed, in one short line */
  note: (line: string) => void;
}

/** the treatment of the whole video; `sections` has one entry per section of the song */
export interface Story {
  title: string;
  idea: string;
  arc: string;
  sections: { moment: MomentId; media: string[]; footage: boolean; note: string }[];
}

let current: AbortController | null = null;

/** start a Make: an earlier one still running is stopped */
export function beginMake(): MakeRun & { end: () => void; abort: () => void } {
  current?.abort();
  const ctrl = new AbortController();
  current = ctrl;
  const set = useStudio.getState().set;
  const lines: string[] = [];
  set({ making: { text: 'Getting ready' }, makeNote: '' });
  return {
    signal: ctrl.signal,
    say: (text, n, of) => {
      if (current === ctrl) set({ making: { text, ...(of ? { n, of } : {}) } });
    },
    note: (line) => {
      lines.push(line);
      if (current === ctrl) set({ makeNote: lines.join(' ') });
    },
    end: () => {
      if (current !== ctrl) return;
      current = null;
      set({ making: null });
    },
    abort: () => ctrl.abort(),
  };
}

// what went wrong belongs to the song it was said about
useStudio.subscribe((s, was) => {
  if (s.track !== was.track && s.makeNote) s.set({ makeNote: '' });
});

/** stop the Make that is running, at whatever step it is */
export function cancelMake() {
  current?.abort();
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const r2 = (v: number) => Math.round(v * 100) / 100;

/* ───────── what every step is told ───────── */

interface Seen {
  key: string;
  id: string;
  seconds: number;
  notes: MediaNotes;
}

/** the media Claude has notes on, with the short keys this request calls them by */
function seenMedia(): Seen[] {
  let c = 0;
  let p = 0;
  return ownMedia().flatMap((m) => {
    const notes = notesOf(m.id);
    if (!notes) return [];
    return [{ key: m.kind === 'clip' ? String.fromCharCode(65 + c++) : `P${++p}`, id: m.id, seconds: m.kind === 'clip' ? m.clip.duration : 0, notes }];
  });
}

const mediaBody = (seen: Seen[]) =>
  seen.map(({ key, seconds, notes: n }) => ({
    key,
    kind: n.kind,
    seconds: r2(seconds),
    subject: n.subject,
    mood: n.mood,
    energy: n.energy,
    bright: n.measure.bright,
    size: n.size,
    camera: n.camera,
    shake: n.measure.shake,
    faces: n.faces,
    text: n.text,
    ins: n.ins.map((x) => ({ at: r2(x.at), why: x.why })),
  }));

const idsOf = (keys: unknown, seen: Seen[], max: number): string[] => {
  const out: string[] = [];
  for (const k of Array.isArray(keys) ? keys : []) {
    const id = seen.find((s) => s.key === k)?.id;
    if (id && !out.includes(id) && out.length < max) out.push(id);
  }
  return out;
};

/* what each choice is, in a line: the ids and the moments they serve come from the templates themselves */
const STYLE_LINES: Record<string, string> = {
  plain: 'the footage alone, nothing on it',
  caption: 'the footage with a small slate in one corner',
  poster: 'one enormous word on a flat field, the footage seen only inside its letters',
  window: 'a flat colour field with one large opening, the footage inside it',
  slab: 'one huge flat shape cropping the footage from an edge',
  grid: 'the frame cut into cells that fill and empty on the beat, the footage in some',
  split: 'two or three panels side by side, each another crop or picture (give it two media)',
};
const TREATMENT_LINES: Record<string, string> = {
  none: 'the picture as it is',
  mosh: 'it melts along its own motion, hard digital smears',
  sort: 'runs of it smeared into streaks by brightness',
  cells: 'rebuilt from characters and blocks on a dark field, the subject barely readable',
  readout: 'coarse one-colour pixels with numbered boxes locked on, like a machine looking',
  collage: 'one big picture with cut-out pieces of others over it (give it three or four media)',
  trace: 'pictures pinned up as a tracking board with lines between them (give it two to four media)',
};
const MOTION_LINES: Record<string, string> = {
  play: 'plays',
  stutter: 'repeats the last beat on hits',
  echo: 'trails ghosts of its last frames',
  reverse: 'runs backwards',
  slices: 'strips of it a moment apart',
};

const choices = <T extends string>(ids: readonly T[], serves: Record<T, Serves>, lines: Record<string, string>) =>
  ids.map((id) => ({ id, line: lines[id] ?? id, serves: (Object.entries(serves[id]) as [string, number][]).filter(([, v]) => v >= 2).map(([m]) => m) }));

/** with lyrics on screen Poster has no word of its own to set, so it isn't offered */
const vocabulary = (lyr: Lyrics | null) => ({
  styles: choices(lyr?.lines.length ? STYLE_IDS.filter((s) => s !== 'poster') : STYLE_IDS, STYLE_SERVES, STYLE_LINES),
  treatments: choices(TREATMENT_IDS, TREATMENT_SERVES, TREATMENT_LINES),
  motions: choices(MOTION_IDS, MOTION_SERVES, MOTION_LINES),
});

/* ───────── watch and story ───────── */

/**
 * Watch what has not been seen, then find the story. Null when there is none to follow (`closed`: no
 * AI here, or no access code, so nothing further should ask).
 */
export async function findStory(a: TrackAnalysis, lyr: Lyrics | null, wish: string, run: MakeRun): Promise<{ story: Story | null; closed: boolean }> {
  await recallNotes();
  const todo = unwatched();
  if (todo) {
    const media = ownMedia();
    const clips = media.some((m) => m.kind === 'clip');
    const what = clips ? (media.some((m) => m.kind === 'photo') ? 'footage' : 'clips') : 'photos';
    framesSent();
    const w = await watchMedia({ signal: run.signal, onProgress: (done, of) => run.say(`Watching your ${what}`, Math.min(of, done + 1), of) });
    if (w.missed) {
      if (w.closed && !seenMedia().length) {
        run.note(`${w.reason} Hum planned this one by itself.`);
        return { story: null, closed: true };
      }
      run.note(seenMedia().length ? `Claude couldn’t watch ${w.missed === 1 ? 'one of your files' : `${w.missed} of your files`}, so the others carry the video.` : 'Claude couldn’t watch your footage this time, so Hum chose the shots.');
    }
  }
  const seen = seenMedia();
  if (!seen.length) return { story: null, closed: false };
  run.say('Finding the story');
  const hints = momentsFor(a);
  const r = await requestStep(
    'story',
    {
      wish,
      track: { summary: a.summary, bpm: a.bpm, tags: a.tags },
      ...(a.character ? { character: { genre: a.character.genre, mood: a.character.mood } } : {}),
      sections: a.sections.map((x, i) => ({
        label: x.label,
        group: x.group,
        start: r2(x.start),
        end: r2(x.end),
        energy: r2(x.energy),
        drop: i ? r2(dropAt(a, x.start)) : 0,
        hint: hints[i],
        ...(lyr?.synced ? { lyrics: textBetween(lyr.lines, x.start, x.end).slice(0, 260) } : {}),
      })),
      ...(lyr && !lyr.synced && lyr.plain ? { lyrics: lyr.plain.slice(0, 1500) } : {}),
      media: mediaBody(seen),
    },
    { signal: run.signal },
  );
  if (!r.ok) {
    run.note(r.closed ? `${r.reason} Hum planned this one by itself.` : 'Claude couldn’t find a story this time, so the parts follow the song alone.');
    return { story: null, closed: !!r.closed };
  }
  const idea = text(r.json.idea, 220);
  const got = Array.isArray(r.json.sections) ? r.json.sections.filter(isObj) : [];
  if (!idea || !got.length) {
    run.note('Claude couldn’t find a story this time, so the parts follow the song alone.');
    return { story: null, closed: false };
  }
  return {
    story: {
      title: text(r.json.title, 60),
      idea,
      arc: text(r.json.arc, 320),
      sections: a.sections.map((_, i) => {
        const x = got.find((g) => g.index === i);
        const m = text(x?.moment, 20);
        return { moment: isMoment(m) ? m : hints[i], media: idsOf(x?.media, seen, 3), footage: x?.footage !== false || i === 0 || i === a.sections.length - 1, note: text(x?.note, 140) };
      }),
    },
    closed: false,
  };
}

/** the story as the plan request carries it */
export const storyForPlan = (s: Story) => ({ idea: s.idea, arc: s.arc, sections: s.sections.map(({ moment, footage, note }) => ({ moment, footage, note })) });

/* ───────── shots ───────── */

/** one part of the cut video, as the shots step is told about it */
interface PartLine {
  i: number;
  kind: 'footage' | 'set' | 'graphic';
}

/** the video as it would play now (the person's changes carried), without putting it on */
function cutNow(plan: VideoPlan, a: TrackAnalysis, keep: VideoPlan | null) {
  const s = useStudio.getState();
  const f = flattenPlan(plan, a, s.pace, s.lyrics);
  if (!f) return null;
  const prevA = s.analysis;
  const prev = keep?.flat && prevA && validPlan(keep, prevA) ? { plan: keep, analysis: prevA } : null;
  const out = prev ? carryEdits(f, prev) : f;
  const hand = prevA && prevA !== out.analysis ? carryByTime(s.partShot, prevA, out.analysis) : s.partShot;
  // the looks the person chose or liked keep the picture they had
  const edits = prev ? partEdits(prev.plan, prev.analysis, null, null, null) : [];
  const kept = out.analysis.sections.map((sec, i) => {
    if (!prev) return false;
    const j = sectionIndexAt(prev.analysis.sections, sec.start + 0.06);
    return (!!edits[j]?.look || !!prev.plan.liked?.[j]) && prev.plan.looks[j] === out.plan.looks[i];
  });
  return { plan: out.plan, analysis: out.analysis, hand, kept };
}

/** the body the shots and the review step share */
export function cutBody(cut: { plan: VideoPlan; analysis: TrackAnalysis; hand: (PartShot | null)[] | null; kept: boolean[] }, story: Story | null, lyr: Lyrics | null, wish: string, shown?: (i: number) => PartShot | null) {
  const seen = seenMedia();
  const pa = cut.analysis;
  const parents = parentsOf(pa);
  const keyOf = (id: string) => seen.find((s) => s.id === id)?.key ?? '';
  const brief = (s: PartShot) => ({
    media: (s.media ?? []).map(keyOf).filter(Boolean),
    ...(s.from !== undefined ? { from: r2(s.from) } : {}),
    moment: s.moment ?? '',
    style: s.style ?? '',
    treatment: s.treatment ?? '',
    motion: s.motion ?? '',
    ...(s.zoom !== undefined ? { zoom: r2(s.zoom) } : {}),
    ...(s.focusX !== undefined && s.focusY !== undefined ? { focusX: r2(s.focusX), focusY: r2(1 - s.focusY) } : {}),
  });
  const lines: PartLine[] = [];
  const parts = pa.sections.slice(0, 120).map((sec, i) => {
    const look = cut.plan.looks[i] ? findLook(cut.plan.looks[i]!) : undefined;
    const footage = playsClips(look);
    const own = cut.hand?.[i];
    const kind: PartLine['kind'] = !footage ? 'graphic' : own?.media?.length || cut.kept[i] ? 'set' : 'footage';
    lines.push({ i, kind });
    const next = pa.sections[i + 1];
    const now = kind === 'set' ? layShot(cut.plan.shots?.[i], own) : kind === 'footage' ? shown?.(i) : null;
    return {
      i,
      section: parents[i],
      seconds: r2(sec.end - sec.start),
      energy: r2(sec.energy),
      kind,
      ...(look && !footage ? { look: look.name } : {}),
      ...(i && dropAt(pa, sec.start) ? { lands: true } : {}),
      ...(next && dropAt(pa, next.start) ? { leads: true } : {}),
      ...(lyr?.synced ? { words: textBetween(lyr.lines, sec.start, sec.end).slice(0, 120) } : {}),
      ...(now ? { now: brief(now) } : {}),
    };
  });
  const orig = parents.length ? cut.plan.flat?.src : undefined;
  const moments = story?.sections.map((x) => x.moment) ?? orig?.moments ?? [];
  return {
    seen,
    lines,
    body: {
      wish,
      story: {
        idea: story?.idea ?? '',
        arc: story?.arc ?? '',
        sections: moments.map((m, i) => ({ moment: m ?? '', media: (story?.sections[i]?.media ?? []).map(keyOf).filter(Boolean), note: story?.sections[i]?.note ?? '' })),
      },
      ...vocabulary(lyr),
      media: mediaBody(seen),
      parts,
    },
  };
}

/** one shot from Claude, checked again here: only ids this browser has, numbers inside their ranges */
export function readShot(x: unknown, seen: Seen[]): { i: number; shot: PartShot; why: string; lyric?: LyricMedium } | null {
  if (!isObj(x) || typeof x.i !== 'number' || !Number.isInteger(x.i)) return null;
  const media = idsOf(x.media, seen, 4);
  const moment = text(x.moment, 20);
  if (!media.length || !isMoment(moment)) return null;
  const first = seen.find((s) => s.id === media[0])!;
  const n = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
  const style = text(x.style, 24);
  const treatment = text(x.treatment, 24);
  const motion = text(x.motion, 24);
  const from = first.seconds ? n(x.from, 0, Math.max(0, first.seconds - 0.6)) : undefined;
  const zoom = n(x.zoom, 1, 2.2);
  const fx = n(x.focusX, 0, 1);
  const fy = n(x.focusY, 0, 1);
  const focused = fx !== undefined && fy !== undefined;
  const lyric = text(x.lyric, 12) as LyricMedium;
  return {
    i: x.i,
    shot: {
      media,
      moment,
      style: isStyle(style) ? style : 'plain',
      treatment: isTreatment(treatment) ? treatment : 'none',
      motion: isMotion(motion) ? motion : 'play',
      ...(from !== undefined ? { from } : {}),
      // looking where the subject is, unless Claude pointed somewhere else (it counts from the top)
      focusX: focused ? fx : first.notes.focusX,
      focusY: focused ? 1 - fy : first.notes.focusY,
      ...(zoom !== undefined && zoom > 1.01 ? { zoom } : {}),
    },
    why: text(x.why, 110),
    ...(LYRIC_MEDIUMS.includes(lyric) && lyric !== 'own' && lyric !== 'none' ? { lyric } : {}),
  };
}

/** what the check needs to know about the cut it was made for */
export interface Chosen {
  cut: NonNullable<ReturnType<typeof cutNow>>;
  cues: ShotCue[];
  /** the footage parts Claude may change */
  open: number[];
}

/**
 * The plan with a shot for every footage part: Claude's where it gave one, else what the part's moment
 * asks for (footageShots.ts). Without an answer the plan comes back with its idea alone, and the parts
 * are dealt by their moments when it goes on.
 */
export async function chooseShots(plan: VideoPlan, a: TrackAnalysis, o: { keep: VideoPlan | null; story: Story | null; lyrics: Lyrics | null; wish: string }, run: MakeRun): Promise<{ plan: VideoPlan; chosen: Chosen | null }> {
  const told: VideoPlan = o.story ? { ...plan, idea: o.story.idea } : plan;
  const cut = cutNow(told, a, o.keep);
  const alone = { plan: told, chosen: null };
  if (!cut) return alone;
  const { seen, lines, body } = cutBody(cut, o.story, o.lyrics, o.wish);
  const open = new Set(lines.flatMap((p) => (p.kind === 'footage' ? [p.i] : [])));
  if (!seen.length || !open.size) return alone;
  run.say('Choosing shots');
  const r = await requestStep('shots', body, { signal: run.signal });
  if (!r.ok) {
    run.note('Claude couldn’t choose the shots this time, so Hum chose them from its notes.');
    return alone;
  }
  const got = new Map<number, NonNullable<ReturnType<typeof readShot>>>();
  for (const x of Array.isArray(r.json.shots) ? r.json.shots : []) {
    const s = readShot(x, seen);
    if (s && open.has(s.i) && !got.has(s.i)) got.set(s.i, s);
  }
  if (!got.size) {
    run.note('Claude couldn’t choose the shots this time, so Hum chose them from its notes.');
    return alone;
  }
  const rest = momentShots(cut.plan.flat?.src ?? told, cut.analysis, cut.plan.looks, findLook);
  const cues: ShotCue[] = cut.analysis.sections.flatMap((sec, i) => {
    const g = got.get(i);
    const shot = g?.shot ?? rest[i];
    if (!shot) return [];
    return [{ at: sec.start, end: sec.end, shot, ...(g?.why ? { why: g.why } : {}), ...(g?.lyric ? { lyric: g.lyric } : {}) }];
  });
  return { plan: { ...told, cues }, chosen: { cut, cues, open: [...open] } };
}

/* ───────── review ───────── */

/** the check after a Make; false leaves it out */
const REVIEW = true;

/** stills of the chosen shots, drawn before the video goes on so nothing playing is disturbed (null: not checked) */
export async function stillsFor(chosen: Chosen, run: MakeRun): Promise<{ sheets: string[]; parts: number[] } | null> {
  if (!REVIEW) return null;
  run.say('Checking the cut');
  const { partsToCheck, stillSheets } = await import('./footageStills');
  const cut = { ...chosen.cut, shotAt: (i: number) => layShot(shotAtPart(chosen, i), chosen.cut.hand?.[i]) };
  try {
    const parts = partsToCheck(cut, chosen.open);
    // one or two stills tell nothing about a cut
    if (parts.length < 3) return null;
    const sheets = await stillSheets(cut, parts, run.signal);
    return sheets.length ? { sheets, parts } : null;
  } catch (err) {
    if (run.signal.aborted) throw err;
    // no second picture to be had (a busy graphics card): the video simply isn't checked
    console.warn('the cut could not be checked', err);
    return null;
  }
}

const shotAtPart = (chosen: Chosen, i: number): PartShot | null => chosen.cues.find((c) => Math.abs(c.at - chosen.cut.analysis.sections[i].start) < 0.06)?.shot ?? null;

/**
 * Claude looks at the stills and the weak shots get its replacements: one round, while the video plays.
 * Only on the plan this Make put on, only in parts cut as they were, and never while a part it changes
 * is on screen. What the person set by hand stays on top, as always.
 */
export async function reviewCut(chosen: Chosen, stills: { sheets: string[]; parts: number[] }, o: { story: Story | null; lyrics: Lyrics | null; wish: string }, run: MakeRun): Promise<void> {
  const mine = () => {
    const s = useStudio.getState();
    return !run.signal.aborted && s.plan?.flat?.src.cues === chosen.cues && !!s.analysis && validPlan(s.plan, s.analysis) ? s : null;
  };
  if (!mine()) return;
  const { body, seen } = cutBody(chosen.cut, o.story, o.lyrics, o.wish, (i) => shotAtPart(chosen, i));
  // only the parts on the sheets may be changed
  const parts = body.parts.filter((p) => p.kind !== 'footage' || stills.parts.includes(p.i));
  const r = await requestStep('review', { ...body, parts, images: stills.sheets }, { signal: run.signal, quiet: true });
  if (!r.ok) {
    run.note('Claude couldn’t check the cut this time.');
    return;
  }
  const at = new Map<number, ShotCue>();
  for (const x of Array.isArray(r.json.weak) ? r.json.weak : []) {
    const g = readShot(x, seen);
    const cue = g && stills.parts.includes(g.i) ? chosen.cues.find((c) => Math.abs(c.at - chosen.cut.analysis.sections[g.i].start) < 0.06) : undefined;
    if (g && cue && !at.has(g.i)) at.set(g.i, { ...cue, shot: g.shot, ...(g.why ? { why: g.why } : {}) });
  }
  if (!at.size) return;
  const starts = [...at.values()].map((c) => c.at);
  // a picture never changes under the person's eyes: wait until none of its parts is on
  for (let k = 0; k < 150; k++) {
    const t = audioEngine.currentTime;
    const onScreen = [...at.values()].some((c) => t > c.at - 1.2 && t < c.end + 0.6);
    if (!audioEngine.playing || !onScreen) break;
    await new Promise((res) => setTimeout(res, 200));
  }
  const s = mine();
  if (!s) return;
  const plan = s.plan!;
  const cues = chosen.cues.map((c) => [...at.values()].find((x) => x.at === c.at) ?? c);
  const bounds = s.analysis!.sections.map((x) => x.start);
  let changed = 0;
  const shots = bounds.map((b, i) => {
    const hit = starts.some((x) => Math.abs(x - b) < 0.06) ? cues.find((c) => Math.abs(c.at - b) < 0.06) : undefined;
    // a part whose look was changed since is the person's now
    if (!hit || !playsClips(plan.looks[i] ? findLook(plan.looks[i]!) : undefined) || plan.base?.looks[i] !== plan.looks[i]) return plan.shots?.[i] ?? null;
    changed++;
    return hit.shot;
  });
  if (!changed) return;
  const why = plan.why.map((w, i) => cues.find((c) => Math.abs(c.at - bounds[i]) < 0.06 && starts.includes(c.at))?.why ?? w);
  useStudio.getState().set({ plan: { ...plan, shots, why, flat: { ...plan.flat!, src: { ...plan.flat!.src, cues } } } });
  run.note(`Claude checked the cut and changed ${changed === 1 ? 'one shot' : `${changed} shots`}.`);
}
