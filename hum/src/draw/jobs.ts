/**
 * Drawing a song, in the background: Claude chooses what to draw (drawIdeas), then the drawings are made
 * a few at a time (draw), each looked at once (local checks, and a quick look by the small model) and
 * corrected at most once (drawFix). Each one joins the song's drawings the moment it is done. Nothing
 * here blocks the person, everything can be stopped, and a drawing that fails just waits for "Try again".
 *
 * Claude's answers are numbers and short texts: every one goes through the same checks as a saved drawing.
 */
import { create } from 'zustand';
import type { TrackAnalysis } from '../core/types';
import { postDirector } from '../director/access';
import { sectionNames } from '../state/plan';
import { originalOf } from '../state/planCache';
import { songCredit } from '../state/songName';
import { useStudio, type StudioState } from '../state/store';
import { figureProof } from '../figures';
import { validateFigure, type Figure } from '../figures/format';
import { cleanDrawing, drawingFaults, type Drawing } from './format';
import { kindOf } from './kinds';
import { drawDrawing, seedOf } from './pen';
import { allDrawings, cleanShape, cleanStyle, deleteDrawing, drawingsHere, songName } from './session';
import { lineKey, type DrawIdea, type DrawingAsset, type DrawStyle } from './types';

/** how many are drawn at once */
const AT_ONCE = 3;
/** how many drawings one press makes */
export const SET_SIZE = 8;

export type JobState = 'waiting' | 'drawing' | 'checking' | 'fixing' | 'failed';

export interface DrawJob {
  id: string;
  idea: DrawIdea;
  style: DrawStyle;
  /** which kind of drawing to make */
  kind: string;
  song: string;
  state: JobState;
  error?: string;
  /** redrawing this one, with these words about how */
  from?: string;
  note?: string;
  /** the id the finished drawing takes, when something already names it (a shot waiting for it) */
  as?: string;
}

interface DrawJobs {
  /** choosing what to draw */
  thinking: boolean;
  jobs: DrawJob[];
  /** how many the current run has finished, and started with (for "3 of 8") */
  done: number;
  total: number;
  error: string | null;
}

export const useDrawJobs = create<DrawJobs>(() => ({ thinking: false, jobs: [], done: 0, total: 0, error: null }));

/** drawings made since the page opened, and when: their thumbnails draw themselves on */
export const justDrawn = new Map<string, number>();

const patchJob = (id: string, p: Partial<DrawJob>) => useDrawJobs.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...p } : j)) }));
const running = new Map<string, AbortController>();
let thinkingStop: AbortController | null = null;

let count = 0;
const newId = () => `dr${Date.now().toString(36)}${(count++).toString(36)}`;
/** an id for a drawing that isn't made yet (makeDrawings) */
export const newDrawingId = newId;

/* ───────────────────────── asking ───────────────────────── */

class StepError extends Error {}

async function step(body: Record<string, unknown>, signal: AbortSignal, quiet = false): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await postDirector((accessCode) => ({ ...body, accessCode }), { signal, quiet });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new StepError('Couldn’t reach Claude. Check the connection and try again.');
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
  if (res.ok && json) return json;
  if (res.status === 403) throw new StepError('This access code doesn’t include drawings.');
  if (res.status === 429) throw new StepError('Claude is busy or out of turns for now. Try again in a little while.');
  if (res.status === 501) throw new StepError('Claude is switched off here.');
  throw new StepError(res.status === 502 ? 'That drawing didn’t come out. Try again.' : 'Something went wrong. Try again.');
}

const say = (e: unknown) => (e instanceof StepError ? e.message : 'Something went wrong. Try again.');

/* ───────────────────────── what Claude hears about the song ───────────────────────── */

/** the sung lines once each, in order: a chorus is only read once */
export function songLines(s: StudioState): string[] {
  const l = s.lyrics;
  if (!l || l.instrumental) return [];
  const all = l.lines.length ? l.lines.map((x) => x.text) : (l.plain ?? '').split('\n');
  const seen = new Set<string>();
  return all.filter((x) => {
    const k = lineKey(x);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

function songFacts(s: StudioState, a: TrackAnalysis | null) {
  if (!a) return { title: songCredit(s).title || songName(s) };
  const names = sectionNames(a.sections);
  const top = a.sections.reduce((m, x, i) => (x.energy > a.sections[m].energy ? i : m), 0);
  const moments = [
    a.drops.length ? `drops at ${a.drops.slice(0, 6).map(clock).join(', ')}` : '',
    a.sections.length ? `loudest part: ${names[top]} at ${clock(a.sections[top].start)}` : '',
    ...(a.harmony?.keyChanges ?? []).slice(0, 2).map((k) => `key moves from ${k.from} to ${k.to} at ${clock(k.t)}`),
  ].filter(Boolean);
  const c = a.character;
  return {
    title: songCredit(s).title || songName(s),
    bpm: a.bpm,
    summary: a.summary,
    feeling: a.tags.slice(0, 10).join(', '),
    character: c ? [c.genre, c.mood, c.instruments.slice(0, 6).join(', ')].filter(Boolean).join('; ') : '',
    key: a.harmony?.key.name ?? '',
    moments: moments.join('; '),
    sections: a.sections.slice(0, 40).map((x, i) => ({ label: names[i] ?? x.label, start: x.start, end: x.end, energy: x.energy })),
  };
}

/* ───────────────────────── one press: choose, then draw ───────────────────────── */

/** "Draw this song": choose a set and draw it. More can be asked for later; those already there are left out. */
export async function drawSong(opts: { count?: number; wish?: string; kind?: string } = {}) {
  const s = useStudio.getState();
  if (useDrawJobs.getState().thinking || !s.track) return;
  const kind = kindFor(opts.kind);
  const song = songName(s);
  const a = s.analysis ? originalOf(s.analysis) : null;
  const lines = songLines(s);
  const have = drawingsHere(s);
  thinkingStop = new AbortController();
  useDrawJobs.setState({ thinking: true, error: null, ...(useDrawJobs.getState().jobs.some((j) => j.state !== 'failed') ? {} : { jobs: [], done: 0, total: 0 }) });
  try {
    const out = await step(
      { mode: 'drawIdeas', song: songFacts(s, a), lyrics: lines, count: opts.count ?? SET_SIZE, kind, have: have.map((d) => d.name), wish: opts.wish ?? '' },
      thinkingStop.signal,
    );
    // the same song keeps the same hand: more drawings join the set they belong to
    const before = have.filter((d) => d.kind === kind);
    const style = before.length ? before[before.length - 1].style : cleanStyle(out.style);
    // the same thing twice isn't worth the wait
    const had = new Set(have.map((d) => lineKey(d.name)));
    const ideas = (Array.isArray(out.objects) ? out.objects : []).flatMap((x) => ideaFrom(x, lines, a) ?? []).filter((x) => !had.has(lineKey(x.name))).slice(0, opts.count ?? SET_SIZE);
    if (!ideas.length) throw new StepError('Claude didn’t find anything to draw this time. Try again.');
    const jobs: DrawJob[] = ideas.map((idea) => ({ id: newId(), idea, style, kind, song, state: 'waiting' }));
    useDrawJobs.setState((j) => ({ jobs: [...j.jobs.filter((x) => x.state !== 'failed'), ...jobs], total: j.total + jobs.length }));
    pump();
  } catch (e) {
    if (!thinkingStop?.signal.aborted) useDrawJobs.setState({ error: say(e) });
  } finally {
    thinkingStop = null;
    useDrawJobs.setState({ thinking: false });
  }
}

/** draw these, each under the id it was promised (a video's shots already name them: director/footageArt.ts) */
export function makeDrawings(list: { id: string; idea: DrawIdea }[], style: DrawStyle) {
  const song = songName(useStudio.getState());
  if (!list.length || !song) return;
  const jobs: DrawJob[] = list.map(({ id, idea }) => ({ id: newId(), as: id, idea, style, kind: 'pen', song, state: 'waiting' }));
  // drawings still waiting for a video that has been made again since are not wanted any more
  const keep = useDrawJobs.getState().jobs.filter((j) => j.state !== 'failed' && !(j.as && j.state === 'waiting' && j.song === song));
  useDrawJobs.setState((s) => ({ jobs: [...keep, ...jobs], total: Math.max(s.done, s.total - (s.jobs.filter((j) => j.state !== 'failed').length - keep.length)) + jobs.length, error: null }));
  pump();
}

/** stop what is being drawn for shots that are gone (a video took the place of the one it was for); what the person asked for stays */
export function dropDrawings(wanted: (id: string) => boolean) {
  const song = songName(useStudio.getState());
  const gone = useDrawJobs.getState().jobs.filter((j) => j.as && j.song === song && j.state !== 'failed' && !wanted(j.as));
  for (const j of gone) cancelJob(j.id);
}

/** one object Claude chose, checked: its lines and sections become the song's own words and times */
function ideaFrom(raw: unknown, lines: string[], a: TrackAnalysis | null): DrawIdea | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
  const name = str(o.name, 40);
  const brief = str(o.brief, 700);
  if (!name || !brief) return null;
  const nums = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x) && x >= 0 && x < max) : []);
  return {
    name,
    brief,
    why: str(o.why, 240),
    wide: cleanShape(o.wide),
    suits: o.style === 'figure' ? 'figure' : 'pen',
    words: (Array.isArray(o.words) ? o.words : []).map((w) => lineKey(str(w, 24))).filter((w) => w && !w.includes(' ')).slice(0, 8),
    lines: nums(o.lines, lines.length).slice(0, 16).map((i) => lineKey(lines[i])),
    parts: a ? nums(o.sections, a.sections.length).slice(0, 24).map((i) => ({ start: a.sections[i].start, end: a.sections[i].end })) : [],
  };
}

/* ───────────────────────── the queue ───────────────────────── */

function pump() {
  const { jobs } = useDrawJobs.getState();
  let busy = jobs.filter((j) => running.has(j.id)).length;
  for (const j of jobs) {
    if (busy >= AT_ONCE) return;
    if (j.state !== 'waiting' || running.has(j.id)) continue;
    busy++;
    void run(j);
  }
}

/**
 * Who makes each kind of drawing. Another kind (src/draw/kinds.ts) joins with one entry here: it answers
 * with that kind's `data`, or throws. A kind nobody here can make is drawn with the pen.
 */
export type Maker = (job: DrawJob, signal: AbortSignal, state: (s: JobState) => void) => Promise<unknown>;
export const MAKERS: Record<string, Maker> = {
  pen: async (job, signal, state) => {
    const object = { name: job.idea.name, brief: job.idea.brief, why: job.idea.why, wide: job.idea.wide };
    const first = cleanDrawing((await step({ mode: 'draw', object, style: job.style, note: job.note ?? '' }, signal)).drawing);
    if (!first) throw new StepError('That drawing didn’t come out. Try again.');
    state('checking');
    return improved(job, object, first, signal);
  },
  figure: async (job, signal, state) => {
    const { name, why, brief } = job.idea;
    // a redraw's note leads: the brief is cut at the length the step reads
    const ask = { object: name, brief: [job.note ? `Asked for this time: ${job.note}.` : '', brief, why].filter(Boolean).join(' '), mood: job.style.manner };
    const figureOf = async (body: Record<string, unknown>, quiet = false) => {
      const j = await step(body, signal, quiet);
      const c = validateFigure(j.figure);
      return c ? { figure: c.figure, notes: Array.isArray(j.notes) ? j.notes.filter((n): n is string => typeof n === 'string') : [] } : null;
    };
    const first = await figureOf({ mode: 'figure', brief: ask });
    if (!first) throw new StepError('That drawing didn’t come out. Try again.');
    // looked at once, both at rest and with everything moved; any trouble keeps the first one
    try {
      state('checking');
      const picture = figureProof(first.figure);
      state('fixing');
      const second = await figureOf({ mode: 'figureFix', brief: ask, figure: first.figure, notes: first.notes, images: [picture] }, true);
      // a "fix" that lost most of the drawing isn't one
      if (second && second.figure.solids.length >= first.figure.solids.length * 0.5) return second.figure;
    } catch (e) {
      if (signal.aborted) throw e;
    }
    return first.figure satisfies Figure;
  },
};
/** a kind of drawing that can be made here (the pen when asked for anything else) */
export const kindFor = (kind: unknown): string => (typeof kind === 'string' && Object.hasOwn(MAKERS, kind) && kindOf(kind) ? kind : 'pen');

async function run(job: DrawJob) {
  const stop = new AbortController();
  running.set(job.id, stop);
  patchJob(job.id, { state: 'drawing', error: undefined });
  try {
    const final = await MAKERS[job.kind](job, stop.signal, (state) => patchJob(job.id, { state }));
    finish(job, final);
  } catch (e) {
    if (stop.signal.aborted) useDrawJobs.setState((s) => ({ jobs: s.jobs.filter((j) => j.id !== job.id), total: Math.max(s.done, s.total - 1) }));
    else patchJob(job.id, { state: 'failed', error: say(e) });
  } finally {
    running.delete(job.id);
    const st = useDrawJobs.getState();
    // everything is done: the next press counts from nought
    if (!st.jobs.some((j) => j.state !== 'failed') && !st.thinking) useDrawJobs.setState({ done: 0, total: 0 });
    pump();
  }
}

/** look at a drawing once, and have it corrected once if it needs it; any trouble keeps the first one */
async function improved(job: DrawJob, object: Record<string, string>, first: Drawing, signal: AbortSignal): Promise<Drawing> {
  try {
    const faults = drawingFaults(first);
    const picture = jpegOf(first, job.style);
    if (!picture) return first;
    let wrong = faults.length > 0;
    const notes = [...faults];
    if (!wrong) {
      const look = await step({ mode: 'drawLook', object, images: [picture] }, signal, true);
      const problem = typeof look.problem === 'string' ? look.problem : '';
      const sees = typeof look.sees === 'string' ? look.sees : '';
      // almost right is kept: only a drawing that would be misread, or is broken, is worth another minute
      wrong = look.reads === 'no' || look.redo === true;
      if (look.reads === 'no') notes.push(sees ? `Someone who saw it called it: ${sees}.` : 'It does not read as what it should be.');
      if (wrong && problem) notes.push(problem);
    }
    if (!wrong) return first;
    patchJob(job.id, { state: 'fixing' });
    const fixed = cleanDrawing((await step({ mode: 'drawFix', object, style: job.style, note: job.note ?? '', drawing: first, faults: notes, images: [picture] }, signal, true)).drawing);
    // a correction that brings more faults than it took away is not one
    return fixed && drawingFaults(fixed).length <= faults.length ? fixed : first;
  } catch (e) {
    if (signal.aborted) throw e;
    return first;
  }
}

/** the drawing in black on white, small: what the judge and the corrector look at */
function jpegOf(d: Drawing, style: DrawStyle): string | null {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#fbf9f4';
  g.fillRect(0, 0, 512, 512);
  drawDrawing(g, d, { seed: 7, hand: style.hand, boil: 0, progress: 1, box: { x: 24, y: 24, w: 464, h: 464 }, inks: { ink: '#161412', a: '#dd5a3c', b: '#e9b44c', c: '#b9cabf' }, colour: style.colour });
  const url = c.toDataURL('image/jpeg', 0.8);
  return url.startsWith('data:image/jpeg;base64,') ? url.slice(23) : null;
}

function finish(job: DrawJob, data: unknown) {
  const s = useStudio.getState();
  const id = job.as ?? newId();
  const old = job.from ? s.drawings.find((d) => d.id === job.from) : undefined;
  const asset: DrawingAsset = { ...job.idea, id, kind: job.kind, songs: old?.songs ?? [job.song], style: job.style, seed: seedOf(id), data, added: old?.added ?? Date.now(), ...(job.from ? { from: job.from } : {}) };
  justDrawn.set(id, performance.now());
  s.set({ drawings: [...s.drawings, asset] });
  if (old) deleteDrawing(old.id);
  useDrawJobs.setState((j) => ({ jobs: j.jobs.filter((x) => x.id !== job.id), done: j.done + 1 }));
}

/* ───────────────────────── what the person can do ───────────────────────── */

/** stop everything; the drawings already finished stay */
export function cancelDrawing() {
  thinkingStop?.abort();
  for (const c of running.values()) c.abort();
  useDrawJobs.setState((s) => ({ jobs: s.jobs.filter((j) => j.state === 'failed' || running.has(j.id)), error: null }));
}

export function cancelJob(id: string) {
  const c = running.get(id);
  if (c) c.abort();
  else useDrawJobs.setState((s) => ({ jobs: s.jobs.filter((j) => j.id !== id), total: Math.max(s.done, s.total - 1) }));
}

export function retryJob(id: string) {
  patchJob(id, { state: 'waiting', error: undefined });
  pump();
}

/** can this drawing be drawn again here? */
export const canRedraw = (d: DrawingAsset) => Object.hasOwn(MAKERS, d.kind);

/** draw one again, asked for differently ("simpler", "from the side"). The old one goes when the new one is in. */
export function redraw(id: string, note: string) {
  const d = allDrawings().find((x) => x.id === id);
  if (!d || !canRedraw(d)) return;
  const { name, why, brief, wide, words, lines, parts, suits, style } = d;
  const job: DrawJob = { id: newId(), idea: { name, why, brief, wide, words, lines, parts, suits }, style, kind: d.kind, song: songName(useStudio.getState()), state: 'waiting', from: id, note: note.trim().slice(0, 200) };
  useDrawJobs.setState((s) => ({ jobs: [...s.jobs.filter((j) => j.from !== id || running.has(j.id)), job], total: s.total + 1, error: null }));
  pump();
}
