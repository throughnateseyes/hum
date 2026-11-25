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
import { DRAWN_ENTERS, DRAWN_PUTS, DRAWN_SIZES, inRoom, type DrawnPut, type DrawnShot, type Room } from '../inside/drawnIds';
import { forgetSeats } from '../inside/seated';
import { ratioOf } from '../inside/shot';
import type { Cut } from './footageStills';
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

/** the room each part has (empty where it couldn't be worked out: then nothing is held back) */
async function roomIn(cut: Cut, parts: { part: number; ratio?: number }[], signal: AbortSignal): Promise<Map<number, Room>> {
  try {
    const { roomFor } = await import('./footageStills');
    return await roomFor(cut, parts, signal);
  } catch (err) {
    if (signal.aborted) throw err;
    console.warn('the room for drawings could not be worked out', err);
    return new Map();
  }
}

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
  // only shots a drawing really has room in, words and all, and what each holds
  const room = await roomIn({ ...chosen.cut, shotAt: (i) => layShot(cueOf(chosen.cues, secs[i].start)?.shot, chosen.cut.hand?.[i]) }, offer.map((part) => ({ part })), run.signal);
  // (a shot whose depth isn't read yet may have room or not: a drawing that has none there is moved later, rehouse)
  const open = offer.filter((i) => !room.has(i) || Object.keys(room.get(i)!).length);
  if (!open.length) return null;
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
      offer: open,
      room: open.filter((i) => room.has(i)).map((part) => ({ part, room: room.get(part) })),
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
  return readArt(r.json, { offer: open, secs, cues: chosen.cues, have, room });
}

/** Claude's answer, checked again: the drawings that exist, the ones to make, and the shots they stand in */
export function readArt(
  json: Record<string, unknown>,
  o: { offer: number[]; secs: { start: number; end: number }[]; cues: ShotCue[]; have: { key: string; d: { id: string; name: string } }[]; room?: Map<number, Room> },
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
    const put = oneOf(p.put, DRAWN_PUTS, 'between');
    const size = oneOf(p.size, DRAWN_SIZES, 'medium');
    const held = o.room?.get(p.part);
    const fits = held ? inRoom(held, put, size) : { put, size };
    if (!fits) continue;
    at.set(p.part, { id, ...fits, enter: oneOf(p.enter, DRAWN_ENTERS, 'draw'), ...(why ? { why } : {}) });
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
      forgetSeats();
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
  await rehouse(mine, gone.signal).catch(() => {});
  if (!mine()) return;
  const s = useStudio.getState();
  const plan = s.plan!;
  const here = drawingsHere(s);
  const parts = s.analysis!.sections.flatMap((_, i) => {
    const d = layShot(plan.shots?.[i], s.partShot?.[i])?.drawn;
    const asset = d ? drawingNow(d.id, here) : null;
    // (one the person put somewhere stays there)
    return d && asset && !byHand(d) && playsClips(plan.looks[i] ? findLook(plan.looks[i]!) : undefined) ? [{ part: i, name: asset.name, put: d.put as DrawnPut, size: d.size, why: d.why ?? '', id: d.id, ratio: ratioOf({ asset }) }] : [];
  });
  if (!parts.length) return;
  const some = parts.slice(0, MOST_STILLS);
  // a picture is drawn while nothing else needs the graphics card, where that can be had
  for (let k = 0; k < 40 && audioEngine.playing && mine(); k++) await new Promise((r) => setTimeout(r, 500));
  if (!mine()) return;
  const { stillSheets } = await import('./footageStills');
  const off = useStudio.subscribe(() => void mine());
  try {
    const cut: Cut = { plan, analysis: s.analysis!, shotAt: (i) => layShot(plan.shots?.[i], s.partShot?.[i]) };
    const room = await roomIn(cut, some.map(({ part, ratio }) => ({ part, ratio })), gone.signal);
    const sheets = await stillSheets(cut, some.map((p) => p.part), gone.signal);
    if (!sheets.length) return;
    const r = await requestStep('artReview', { thread: art.thread, places: some.map(({ id: _id, ratio: _r, ...p }) => ({ ...p, ...(room.has(p.part) ? { room: room.get(p.part) } : {}) })), images: sheets }, { signal: gone.signal, quiet: true });
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
      // never moved to where there is no room for it
      const held = room.get(p.part);
      const put = oneOf(c.put, DRAWN_PUTS, was.put as DrawnPut);
      const size = oneOf(c.size, DRAWN_SIZES, was.size);
      const fits = held ? inRoom(held, put, size) : { put, size };
      if (c.do !== 'remove' && fits && fits.put === was.put && fits.size === was.size) continue;
      todo.set(p.part, { at: starts[p.part].start, end: starts[p.part].end, id: p.id, next: c.do === 'remove' || !fits ? null : { ...was, ...fits } });
    }
    if (!todo.size) return;
    const spans = [...todo.values()];
    await offScreen(spans);
    if (!mine()) return;
    applyArt(spans);
  } catch (err) {
    if (!gone.signal.aborted) console.warn('the drawings could not be checked', err);
  } finally {
    off();
  }
}

const byHand = (d: DrawnShot) => !!d.spots || d.put === 'front';

/** resolves once none of these shots is on screen (or after half a minute) */
async function offScreen(spans: { at: number; end: number }[]) {
  for (let k = 0; k < 150; k++) {
    const t = audioEngine.currentTime;
    if (!audioEngine.playing || !spans.some((x) => t > x.at - 1.2 && t < x.end + 0.6)) return;
    await new Promise((res) => setTimeout(res, 200));
  }
}

/**
 * A drawing that turns out not to fit where it was put (its real shape is known now, and all the depth) takes the
 * nearest place and size its shot does hold; one with no room there at all moves to the nearest shot that has some,
 * so nothing is drawn for nothing. The check then looks at drawings that fit, and needn't spend its answer on it.
 */
async function rehouse(mine: () => boolean, signal: AbortSignal) {
  const s = useStudio.getState();
  const plan = s.plan!;
  const a = s.analysis!;
  const here = drawingsHere(s);
  const shotAt = (i: number) => layShot(plan.shots?.[i], s.partShot?.[i]);
  const inside = a.sections.map((_, i) => i).filter((i) => shotAt(i)?.style === 'inside' && playsClips(plan.looks[i] ? findLook(plan.looks[i]!) : undefined));
  const placed = inside.flatMap((part) => {
    const d = shotAt(part)!.drawn;
    const asset = d && drawingNow(d.id, here);
    return d && asset && !byHand(d) ? [{ part, d, ratio: ratioOf({ asset }) }] : [];
  });
  const cut: Cut = { plan, analysis: a, shotAt };
  if (!placed.length) return;
  // by now nothing hurries: the shots' depth is read to the end, so what is measured is what will be seen
  const { readDepth } = await import('./footageDepth');
  await readDepth(cut, { signal, say: () => {} });
  if (!mine()) return;
  const room = await roomIn(cut, placed.map(({ part, ratio }) => ({ part, ratio })), signal);
  const lost = placed.filter((p) => room.has(p.part) && !Object.keys(room.get(p.part)!).length);
  // (a shot whose drawing the person set is theirs)
  const tight = placed.flatMap((p) => {
    const fit = !s.partShot?.[p.part]?.drawn && room.has(p.part) ? inRoom(room.get(p.part)!, p.d.put as DrawnPut, p.d.size) : null;
    return fit && (fit.put !== p.d.put || fit.size !== p.d.size) ? [{ ...p, fit }] : [];
  });
  if ((!lost.length && !tight.length) || !mine()) return;
  const free = new Set(inside.filter((i) => shotAt(i)!.drawn === undefined && a.sections[i].end - a.sections[i].start >= LEAST));
  const spans: Span[] = tight.map((p) => ({ at: a.sections[p.part].start, end: a.sections[p.part].end, id: p.d.id, next: { ...p.d, ...p.fit } }));
  for (const p of lost) {
    const taken = new Map(placed.filter((x) => !lost.includes(x)).map((x) => [x.part, x.d.id]));
    const near = [...free].filter((i) => [i - 1, i + 1].every((n) => !taken.has(n) || taken.get(n) === p.d.id)).sort((x, y) => Math.abs(x - p.part) - Math.abs(y - p.part)).slice(0, 6);
    const there = await roomIn(cut, near.map((part) => ({ part, ratio: p.ratio })), signal);
    const to = near.find((i) => Object.keys(there.get(i) ?? {}).length);
    const span = (i: number) => ({ at: a.sections[i].start, end: a.sections[i].end, id: p.d.id });
    if (to === undefined) continue;
    free.delete(to);
    spans.push({ ...span(p.part), next: null }, { ...span(to), next: { ...p.d, ...inRoom(there.get(to)!, p.d.put as DrawnPut, p.d.size)! }, fresh: true });
  }
  if (!spans.length) return;
  await offScreen(spans);
  if (mine()) applyArt(spans);
}

interface Span {
  at: number;
  end: number;
  id: string;
  next: DrawnShot | null;
  /** the shot had none until now */
  fresh?: boolean;
}

function applyArt(spans: Span[]) {
  const s = useStudio.getState();
  const plan = s.plan!;
  const fix = <T extends { drawn?: DrawnShot | null }>(shot: T, at: number): T => {
    const hit = spans.find((x) => Math.abs(x.at - at) < 0.06 && (x.fresh ? shot.drawn === undefined : x.id === shot.drawn?.id));
    if (!hit) return shot;
    const { drawn: _was, ...rest } = shot;
    return hit.next ? { ...shot, drawn: hit.next } : (rest as T);
  };
  const shots = plan.shots?.map((x, i) => (x ? fix(x, s.analysis!.sections[i].start) : x));
  const src = plan.flat?.src;
  const cues = src?.cues?.map((c) => ({ ...c, shot: fix(c.shot, c.at) }));
  s.set({ plan: { ...plan, ...(shots ? { shots } : {}), ...(plan.flat && src && cues ? { flat: { ...plan.flat, src: { ...src, cues } } } : {}) } });
}
