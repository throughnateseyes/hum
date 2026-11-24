/**
 * Art direction (server/steps/art.ts): one brief for the whole video, the few drawings it needs and the
 * shots each stands in, decided once the cut is. The person's own drawings are used where they truly fit;
 * the missing ones are made in the background (src/draw/jobs.ts) under the ids the shots already name, so
 * each joins the video the moment it is done. When all are in, Claude looks at them where they stand.
 *
 * It asks nothing unless drawings are allowed here and "Draw into the scene" is on, and whatever goes wrong
 * the video is simply made without drawings.
 */
import { audioEngine } from '../audio/engine';
import type { Lyrics, TrackAnalysis } from '../core/types';
import { makeDrawings, newDrawingId, redraw, songLines, useDrawJobs } from '../draw/jobs';
import { cleanStyle, drawingNow, drawingsHere, drawOpen, songName } from '../draw/session';
import type { DrawIdea, DrawStyle } from '../draw/types';
import { DRAWN_ENTERS, DRAWN_PUTS, DRAWN_SIZES, type DrawnShot } from '../inside/drawnIds';
import { INSIDE_PALETTES, PALETTE_LINES } from '../inside/palettes';
import { layShot, type ShotCue } from '../shot/partShots';
import { findLook, validPlan, type VideoPlan } from '../state/plan';
import { useStudio } from '../state/store';
import { requestStep } from './client';
import { playsClips } from './footage';
import { curvesNow } from './feeling';
import { cutBody, type Chosen, type MakeRun, type Story } from './footageDirector';

/** what the drawings of one video are about, kept on its plan */
export interface VideoArt {
  thread: string;
  rules: string[];
  /** the drawings it uses: their ids, and what they were called when they were chosen */
  drawings: { id: string; name: string }[];
}

/** a shot shorter than this is over before a drawing is seen */
const LEAST = 1.5;
const MOST_STILLS = 12;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const oneOf = <T extends string>(v: unknown, ids: readonly T[], d: T): T => (ids.includes(v as T) ? (v as T) : d);

export interface Art {
  /** the cues with the drawings in them, and what the plan keeps */
  cues: ShotCue[];
  art: VideoArt;
  /** start drawing what is missing (once the video is on) */
  begin: () => void;
}

/** where drawings may be drawn into the scene at all */
export const artOpen = () => drawOpen() && useStudio.getState().drawInScene;

const cueOf = (cues: ShotCue[], at: number) => cues.find((c) => Math.abs(c.at - at) < 0.06);

/** the drawings of the video about to go on. Null when there are to be none. */
export async function directArt(chosen: Chosen, a: TrackAnalysis, o: { story: Story | null; lyrics: Lyrics | null; wish: string; paint?: string }, run: MakeRun): Promise<Art | null> {
  if (!artOpen()) return null;
  const s = useStudio.getState();
  const secs = chosen.cut.analysis.sections;
  const offer = chosen.open.filter((i) => {
    const shot = layShot(cueOf(chosen.cues, secs[i].start)?.shot, chosen.cut.hand?.[i]);
    return shot?.style === 'inside' && shot.drawn === undefined && secs[i].end - secs[i].start >= LEAST;
  });
  if (!offer.length) return null;
  const { body } = cutBody(chosen.cut, o.story, o.lyrics, o.wish, (i) => cueOf(chosen.cues, secs[i].start)?.shot ?? null);
  const have = drawingsHere(s)
    .filter((d) => d.kind === 'pen')
    .slice(-14)
    .map((d, i) => ({ key: `D${i + 1}`, d }));
  const paint = INSIDE_PALETTES.find((p) => p.id === o.paint);
  const last = s.plan?.art?.drawings.map((d) => d.name) ?? [];
  const r = await requestStep(
    'art',
    {
      wish: o.wish,
      title: o.lyrics?.title ?? songName(s),
      track: { summary: a.summary, bpm: a.bpm, tags: a.tags },
      ...(a.character ? { character: { genre: a.character.genre, mood: a.character.mood } } : {}),
      about: curvesNow(a, o.lyrics).about ?? '',
      story: body.story,
      lyrics: songLines(s),
      media: body.media,
      parts: body.parts,
      offer,
      ...(paint ? { paint: PALETTE_LINES[paint.id] ?? paint.name } : {}),
      have: have.map(({ key, d }) => ({ key, name: d.name, why: d.why, wide: d.wide })),
      last,
    },
    { signal: run.signal, quiet: true },
  );
  if (!r.ok) {
    if (!r.closed) run.note('Claude couldn’t choose drawings for this video, so it has none.');
    return null;
  }
  return readArt(r.json, { offer, secs, cues: chosen.cues, have });
}

/** Claude's answer, checked again: the drawings that exist, the ones to make, and the shots they stand in */
export function readArt(
  json: Record<string, unknown>,
  o: { offer: number[]; secs: { start: number; end: number }[]; cues: ShotCue[]; have: { key: string; d: { id: string; name: string } }[] },
): Art | null {
  const style: DrawStyle = cleanStyle(json.style);
  const things = (Array.isArray(json.things) ? json.things : []).slice(0, 3);
  const drawings: VideoArt['drawings'] = [];
  const make: { id: string; idea: DrawIdea }[] = [];
  const places = (Array.isArray(json.places) ? json.places : []).filter(isObj);
  /** "thing|stage" → the drawing */
  const of = new Map<string, string>();
  things.forEach((x, n) => {
    if (!isObj(x)) return;
    for (const stage of ['start', 'end'] as const) {
      const d = x[stage];
      if (!isObj(d)) continue;
      // only what stands somewhere is drawn
      const here = places.filter((p) => p.thing === n && (p.stage === 'end' ? 'end' : 'start') === stage && typeof p.part === 'number' && o.offer.includes(p.part)).map((p) => p.part as number);
      if (!here.length) continue;
      const had = o.have.find((h) => h.key === d.reuse);
      const name = text(d.name, 40);
      const brief = text(d.brief, 700);
      if (had) {
        of.set(`${n}|${stage}`, had.d.id);
        if (!drawings.some((y) => y.id === had.d.id)) drawings.push({ id: had.d.id, name: had.d.name });
      } else if (name && brief && make.length < 4) {
        const id = newDrawingId();
        of.set(`${n}|${stage}`, id);
        drawings.push({ id, name });
        make.push({ id, idea: { name, brief, why: text(x.why, 240), wide: d.wide === 'tall' || d.wide === 'wide' ? d.wide : 'square', suits: 'pen', words: [], lines: [], parts: here.map((i) => ({ start: o.secs[i].start, end: o.secs[i].end })) } });
      }
    }
  });
  const at = new Map<number, DrawnShot>();
  for (const p of places) {
    if (typeof p.part !== 'number' || !o.offer.includes(p.part) || at.has(p.part)) continue;
    const id = of.get(`${String(p.thing)}|${p.stage === 'end' ? 'end' : 'start'}`) ?? of.get(`${String(p.thing)}|start`);
    if (!id) continue;
    const why = text(p.why, 110);
    at.set(p.part, { id, put: oneOf(p.put, DRAWN_PUTS, 'between'), size: oneOf(p.size, DRAWN_SIZES, 'medium'), enter: oneOf(p.enter, DRAWN_ENTERS, 'draw'), ...(why ? { why } : {}) });
  }
  if (!at.size) return null;
  const cues = o.cues.map((c) => {
    const i = [...at.keys()].find((k) => Math.abs(o.secs[k].start - c.at) < 0.06);
    return i === undefined ? c : { ...c, shot: { ...c.shot, drawn: at.get(i)! } };
  });
  const thread = text(json.thread, 220);
  return {
    cues,
    art: { thread, rules: (Array.isArray(json.rules) ? json.rules : []).map((x) => text(x, 120)).filter(Boolean).slice(0, 3), drawings },
    begin: () => {
      // the drawings are in the picture now, so they no longer come up beside the words as well
      if (useStudio.getState().drawOverlay) useStudio.getState().set({ drawOverlay: false });
      if (make.length) makeDrawings(make, style);
    },
  };
}

/* ───────── looking at them where they stand ───────── */

/** the drawing of part i in the plan that is on */
const placedIn = (plan: VideoPlan, i: number) => plan.shots?.[i]?.drawn ?? null;

/** resolves once nothing of this video is being drawn (false: the video went off first) */
function drawn(art: VideoArt, mine: () => boolean): Promise<boolean> {
  const ids = new Set(art.drawings.map((d) => d.id));
  const left = () => useDrawJobs.getState().jobs.some((j) => j.state !== 'failed' && ids.has(j.as ?? j.from ?? ''));
  return new Promise((resolve) => {
    const look = () => {
      if (!mine()) resolve(false);
      else if (!left()) resolve(true);
      else setTimeout(look, 700);
    };
    look();
  });
}

/**
 * Once every drawing is in, Claude sees the finished shots and moves, takes out or has drawn again what
 * looks stuck on: one round, like the check of the cut. Only on the video it was made for, and never
 * changing a picture while it is on screen.
 */
export async function reviewArt(art: VideoArt): Promise<void> {
  const gone = new AbortController();
  const mine = () => {
    const s = useStudio.getState();
    const ok = s.plan?.art === art && !!s.analysis && validPlan(s.plan, s.analysis);
    if (!ok) gone.abort();
    return ok;
  };
  if (!(await drawn(art, mine))) return;
  const s = useStudio.getState();
  const plan = s.plan!;
  const here = drawingsHere(s);
  const parts = s.analysis!.sections.flatMap((_, i) => {
    const d = layShot(plan.shots?.[i], s.partShot?.[i])?.drawn;
    const asset = d ? drawingNow(d.id, here) : null;
    return d && asset && playsClips(plan.looks[i] ? findLook(plan.looks[i]!) : undefined) ? [{ part: i, name: asset.name, put: d.put, size: d.size, why: d.why ?? '', id: d.id }] : [];
  });
  if (!parts.length) return;
  const some = parts.slice(0, MOST_STILLS);
  // a picture is drawn while nothing else needs the graphics card, where that can be had
  for (let k = 0; k < 40 && audioEngine.playing && mine(); k++) await new Promise((r) => setTimeout(r, 500));
  if (!mine()) return;
  const { stillSheets } = await import('./footageStills');
  const off = useStudio.subscribe(() => void mine());
  try {
    const sheets = await stillSheets({ plan, analysis: s.analysis!, shotAt: (i) => layShot(plan.shots?.[i], s.partShot?.[i]) }, some.map((p) => p.part), gone.signal);
    if (!sheets.length) return;
    const r = await requestStep('artReview', { thread: art.thread, places: some.map(({ id: _id, ...p }) => p), images: sheets }, { signal: gone.signal, quiet: true });
    if (!r.ok || !mine()) return;
    const changes = (Array.isArray(r.json.changes) ? r.json.changes : []).filter(isObj);
    const starts = useStudio.getState().analysis!.sections;
    const todo = new Map<number, { at: number; end: number; id: string; next: DrawnShot | null }>();
    for (const c of changes) {
      const p = some.find((x) => x.part === c.part);
      if (!p) continue;
      if (c.do === 'redraw') {
        const now = drawingNow(p.id, drawingsHere());
        // the person's own older drawings are never drawn over: they go out of the shot instead
        if (now && art.drawings.some((d) => d.id === now.id) && now.added > Date.now() - 3600_000 && text(c.note, 200)) redraw(now.id, text(c.note, 200));
        else todo.set(p.part, { at: starts[p.part].start, end: starts[p.part].end, id: p.id, next: null });
        continue;
      }
      const was = placedIn(plan, p.part);
      if (!was) continue;
      todo.set(p.part, { at: starts[p.part].start, end: starts[p.part].end, id: p.id, next: c.do === 'remove' ? null : { ...was, put: oneOf(c.put, DRAWN_PUTS, was.put), size: oneOf(c.size, DRAWN_SIZES, was.size) } });
    }
    if (!todo.size) return;
    const spans = [...todo.values()];
    for (let k = 0; k < 150; k++) {
      const t = audioEngine.currentTime;
      if (!audioEngine.playing || !spans.some((x) => t > x.at - 1.2 && t < x.end + 0.6)) break;
      await new Promise((res) => setTimeout(res, 200));
    }
    if (!mine()) return;
    applyArt(spans);
  } catch (err) {
    if (!gone.signal.aborted) console.warn('the drawings could not be checked', err);
  } finally {
    off();
  }
}

function applyArt(spans: { at: number; id: string; next: DrawnShot | null }[]) {
  const s = useStudio.getState();
  const plan = s.plan!;
  const fix = <T extends { drawn?: DrawnShot | null }>(shot: T, at: number): T => {
    const hit = shot.drawn ? spans.find((x) => Math.abs(x.at - at) < 0.06 && x.id === shot.drawn!.id) : undefined;
    if (!hit) return shot;
    const { drawn: _was, ...rest } = shot;
    return hit.next ? { ...shot, drawn: hit.next } : (rest as T);
  };
  const shots = plan.shots?.map((x, i) => (x ? fix(x, s.analysis!.sections[i].start) : x));
  const src = plan.flat?.src;
  const cues = src?.cues?.map((c) => ({ ...c, shot: fix(c.shot, c.at) }));
  s.set({ plan: { ...plan, ...(shots ? { shots } : {}), ...(plan.flat && src && cues ? { flat: { ...plan.flat, src: { ...src, cues } } } : {}) } });
}
