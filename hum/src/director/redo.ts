/**
 * Redo a part (or a few): another choice for what it shows, the rest of the video as it is.
 *
 * One small Claude call (server/steps/redo.ts) that sees the idea, what is round the part, the kept parts,
 * the notes on the person's media and what the song feels like there, with the person's words for it when
 * they gave some. What comes back is checked and timed the way a Make's shots are, has to differ from what
 * is there, and goes in as the director's own choice, in one undo step. Without Claude (off, refused, or an
 * answer that can't be used) Hum takes the next of its own choices (choices.ts), so it always does something.
 */
import { create } from 'zustand';
import type { PartShot } from '../core/types';
import { cuesAfter, plannedShot, type ShotCue } from '../shot/partShots';
import { askedFor } from '../state/history';
import type { LyricMedium } from '../state/lyricPlan';
import { findLook, listNames, partNames, releaseHold, type VideoPlan } from '../state/plan';
import { keepPlan, originalOf } from '../state/planCache';
import { useStudio } from '../state/store';
import type { Wanted } from '../timing';
import { useAccessGate } from './access';
import { allChoices, endPreview, type Choice } from './choices';
import { requestStep } from './client';
import { cutBody, readShot, withTiming } from './footageDirector';
import { playsClips } from './footage';
import { readClips, timeCut } from './footageTiming';
import { notesOf, recallNotes } from './media';
import { laidAt, partNow, playingVideo, type PartNow, type Playing } from './partNow';

/** parts done at once */
export const MOST_REDO = 8;
/** how many parts either side Claude is told about */
const NEAR = 4;
const LOOKS = 12;
/** the footage look a graphic part takes when the person asked for their footage there and no other part shows any */
const FOOTAGE_LOOK = 'footage-bands';

export interface RedoResult {
  /** the parts that now show something else */
  changed: number[];
  /** who chose (null: nothing changed) */
  by: 'claude' | 'hum' | null;
  note: string;
}

interface RedoState {
  running: boolean;
  /** the parts it is on now, or was on last */
  parts: number[];
  /** how it went, or what it is doing, in one plain line */
  note: string;
  cancel: () => void;
}

let ctrl: AbortController | null = null;
export const cancelRedo = () => ctrl?.abort();

export const useRedo = create<RedoState>(() => ({ running: false, parts: [], note: '', cancel: cancelRedo }));

// what was said belongs to the song it was said about
useStudio.subscribe((s, was) => {
  const song = (a: typeof s.analysis) => (a ? originalOf(a) : null);
  if (s.track === was.track && song(s.analysis) === song(was.analysis)) return;
  ctrl?.abort();
  tried.clear();
  if (useRedo.getState().note || useRedo.getState().parts.length) useRedo.setState({ parts: [], note: '' });
});

/** what each part showed before it was redone, by where it starts: never offered straight back */
const tried = new Map<number, { key: string; was: string }[]>();
const startOf = (v: Playing, i: number) => Math.round(v.analysis.sections[i].start * 1000);
const r1 = (x: number) => Math.round(x * 10) / 10;
const keyOf = (n: Pick<PartNow, 'footage' | 'shot'> & { look?: { id: string } }) =>
  n.footage ? [n.shot.media?.[0] ?? '', n.shot.style ?? '', n.shot.treatment ?? '', r1(n.shot.zoom ?? 1), Math.round(n.shot.from ?? n.shot.hit ?? 0)].join('|') : (n.look?.id ?? '');

function remember(v: Playing, i: number, was: string) {
  const list = tried.get(startOf(v, i)) ?? [];
  tried.set(startOf(v, i), [...list, { key: keyOf(partNow(v, i)), was }].slice(-6));
}

/** it is clearly something else: another picture, or the same one seen another way */
function differs(now: PartShot, next: PartShot): boolean {
  if (now.media?.[0] !== next.media?.[0]) return true;
  if ((now.style ?? 'plain') !== (next.style ?? 'plain') || (now.treatment ?? 'none') !== (next.treatment ?? 'none') || (now.motion ?? 'play') !== (next.motion ?? 'play')) return true;
  if (Math.abs((now.zoom ?? 1) - (next.zoom ?? 1)) >= 0.15) return true;
  if (next.from !== undefined && now.from !== undefined && Math.abs(next.from - now.from) >= 0.8) return true;
  if (next.hit !== undefined && next.hit !== now.hit) return true;
  return Math.abs((now.focusX ?? 0.5) - (next.focusX ?? 0.5)) >= 0.2 || Math.abs((now.focusY ?? 0.55) - (next.focusY ?? 0.55)) >= 0.2;
}

/** what a part is to show instead */
interface Next {
  shot?: PartShot;
  look?: string;
  why?: string;
  lyric?: LyricMedium;
  wanted?: Wanted;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** the looks a graphic part could take, the best first */
const looksFor = (v: Playing, i: number) => allChoices(v, i).flatMap((c) => (c.look ? [findLook(c.look)!] : [])).slice(0, LOOKS);

/** ask Claude; null when there is nothing to ask with */
async function ask(v: Playing, parts: number[], wish: string, signal: AbortSignal): Promise<{ next: Map<number, Next>; reason: string }> {
  const none = (reason: string) => ({ next: new Map<number, Next>(), reason });
  const say = (note: string) => useRedo.setState({ note });
  if (useAccessGate.getState().need === 'off') return none('AI is switched off on this site.');
  const s = useStudio.getState();
  await recallNotes();
  const now = new Map(parts.map((i) => [i, partNow(v, i)]));
  const footage = parts.filter((i) => now.get(i)!.footage);
  if (footage.length) await readClips({ signal, say });
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  say(parts.length > 1 ? 'Choosing the parts again' : 'Choosing the part again');
  const a = v.analysis;
  // the video as it plays: what the run dealt is written down, so every part says what it shows
  const told: VideoPlan = { ...v.plan, shots: a.sections.map((_, i) => (playsClips(v.plan.looks[i] ? findLook(v.plan.looks[i]!) : undefined) ? partNow(v, i).shot : null)) };
  const { body, seen } = cutBody({ plan: told, analysis: a, hand: null, kept: a.sections.map((_, i) => !parts.includes(i)) }, null, s.lyrics, wish, (i) => now.get(i)?.shot ?? null);
  if (!seen.length && footage.length) return none('Claude hasn’t seen your footage yet.');
  const kept = a.sections.flatMap((_, i) => (v.plan.kept?.[i] && !parts.includes(i) ? [i] : []));
  // the parts round them, and the kept ones; each is told by its own section's moment
  const near = body.parts.filter((p) => kept.includes(p.i) || parts.some((i) => Math.abs(i - p.i) <= NEAR)).map((p) => (parts.includes(p.i) ? { ...p, kind: 'footage' as const } : p));
  if (!parts.every((i) => near.some((p) => p.i === i))) return none('This part is too far into the song for Claude to see.');
  const inUse = new Set(near.map((p) => p.section));
  const story = { ...body.story, idea: v.plan.idea ?? '', sections: body.story.sections.map((x, k) => (inUse.has(k) ? x : { ...x, moment: '' })) };
  const looks = parts.filter((i) => !now.get(i)!.footage).map((i) => ({ i, now: now.get(i)!.look?.name ?? '', looks: looksFor(v, i).map((l) => ({ id: l.id, name: l.name, tags: l.tags.slice(0, 4) })) }));
  const before = parts.flatMap((i) => (tried.get(startOf(v, i)) ?? []).slice(-3).map((x) => ({ i, was: x.was })));
  const r = await requestStep('redo', { ...body, story, parts: near, looks, kept, tried: before }, { signal });
  if (!r.ok) return none(r.reason);
  const next = new Map<number, Next>();
  for (const x of Array.isArray(r.json.shots) ? r.json.shots : []) {
    if (!isObj(x) || typeof x.i !== 'number' || !parts.includes(x.i) || next.has(x.i)) continue;
    const here = now.get(x.i)!;
    if (typeof x.look === 'string') {
      const offered = looks.find((l) => l.i === x.i)?.looks.some((l) => l.id === x.look);
      if (!here.footage && offered && x.look !== here.look?.id) next.set(x.i, { look: x.look, ...(typeof x.why === 'string' ? { why: x.why.slice(0, 110) } : {}) });
      continue;
    }
    const g = readShot(x, seen);
    if (!g) continue;
    if (here.footage && !g.wanted && !differs(here.shot, g.shot)) continue;
    next.set(x.i, { shot: g.shot, why: g.why, ...(g.lyric ? { lyric: g.lyric } : {}), ...(g.wanted ? { wanted: g.wanted } : {}), ...(here.footage ? {} : { look: footageLookNear(v, x.i) }) });
  }
  return { next, reason: next.size ? '' : 'Claude had no other choice this time.' };
}

/** the footage look the nearest footage part plays */
function footageLookNear(v: Playing, i: number): string {
  const order = v.plan.looks.map((id, j) => ({ id, d: Math.abs(j - i) })).sort((x, y) => x.d - y.d);
  return order.find((x) => x.id && findLook(x.id)?.sceneId === 'footage')?.id ?? FOOTAGE_LOOK;
}

/** Hum's own choice for a part: the next one it hasn't shown there */
function ownChoice(v: Playing, i: number, picked: Map<number, PartShot>): { next: Next; choice: Choice } | null {
  const list = allChoices(v, i, picked);
  const had = new Set((tried.get(startOf(v, i)) ?? []).map((x) => x.key));
  const now = partNow(v, i);
  const keyed = list.map((c) => {
    const shot = c.patch ? { ...now.shot, ...c.patch } : now.shot;
    return { c, shot, key: c.look ?? keyOf({ footage: true, shot }) };
  });
  const pick = keyed.find((x) => !had.has(x.key)) ?? keyed[0];
  if (!pick) return null;
  if (pick.c.look) return { next: { look: pick.c.look }, choice: pick.c };
  const { pin: _p, hit: _h, on: _o, ramp: _r, ...rest } = { ...laidAt(v, i), ...pick.c.patch } as PartShot;
  const same = !pick.c.patch?.media || pick.c.patch.media[0] === now.shot.media?.[0];
  const keptHit = same && pick.c.patch?.from === undefined && now.shot.hit !== undefined ? { hit: now.shot.hit, on: now.shot.on, ramp: now.shot.ramp } : {};
  const shot: Record<string, unknown> = { ...rest, media: rest.media?.length ? rest.media : now.shot.media, ...keptHit };
  for (const k of Object.keys(shot)) if (shot[k] === undefined) delete shot[k];
  return { next: { shot: shot as PartShot }, choice: pick.c };
}

/** what the part showed, for Claude not to come back to */
function wasWords(now: PartNow): string {
  if (!now.footage) return now.look ? `the look ${now.look.name}` : '';
  const s = now.shot;
  const subject = notesOf(s.media?.[0] ?? '')?.subject ?? '';
  return [subject, s.style ?? '', s.treatment && s.treatment !== 'none' ? s.treatment : '', s.zoom && s.zoom > 1.1 ? `zoom ${r1(s.zoom)}` : '', s.from !== undefined ? `from ${r1(s.from)} s` : ''].filter(Boolean).join(', ').slice(0, 120);
}

/** put the choices in, as the director's: one undo step. The parts that could take theirs. */
function putIn(v: Playing, next: Map<number, Next>): number[] {
  const s = useStudio.getState();
  const cur = playingVideo(s);
  if (!cur || cur.analysis !== v.analysis || s.clip || s.planning) return [];
  // a part changed (or kept) since it was asked about is the person's
  const same = (i: number) => cur.plan.looks[i] === v.plan.looks[i] && !cur.plan.kept?.[i] && JSON.stringify(laidAt(cur, i)) === JSON.stringify(laidAt(v, i));
  const parts = [...next.keys()].filter(same).sort((x, y) => x - y);
  if (!parts.length) return [];
  const a = cur.analysis;
  const looks = cur.plan.looks.map((id, i) => (parts.includes(i) ? (next.get(i)!.look ?? id) : id));
  const shotOf = (i: number): PartShot | null => (parts.includes(i) ? (next.get(i)!.shot ?? null) : laidAt(cur, i));
  const open = new Set(parts.filter((i) => next.get(i)!.shot));
  const wanted = new Map(parts.flatMap((i) => (next.get(i)!.wanted ? [[i, next.get(i)!.wanted!] as const] : [])));
  const timed = open.size ? timeCut({ plan: { ...cur.plan, looks }, analysis: a, shotAt: shotOf }, { open, wanted }) : [];
  const made = new Map<number, PartShot>();
  for (const i of open) {
    const shot = next.get(i)!.shot!;
    // (a drawing that stands in the picture stays while the words do)
    const was = plannedShot(cur.plan, i)?.drawn;
    const t = timed[i] ? withTiming(shot, timed[i]!) : shot;
    made.set(i, was && t.style === 'inside' && t.drawn === undefined ? { ...t, drawn: was } : t);
  }
  const shots = looks.map((_, i) => (made.has(i) ? made.get(i)! : parts.includes(i) ? null : (cur.plan.shots?.[i] ?? null)));
  const why = looks.map((_, i) => (parts.includes(i) ? (next.get(i)!.why ?? '') : (cur.plan.why[i] ?? '')));
  const lp = cur.plan.lyricPlan;
  const lyricPlan = lp && parts.some((i) => next.get(i)!.lyric && lp.parts[i]) ? { ...lp, parts: lp.parts.map((p, i) => (p && parts.includes(i) && next.get(i)!.lyric ? { ...p, medium: next.get(i)!.lyric!, moment: null, why: 'planned by Claude' } : p)) } : lp;
  const base = lyricPlan !== lp && cur.plan.base ? { ...cur.plan.base, lyric: cur.plan.base.lyric.map((m, i) => (parts.includes(i) && next.get(i)!.lyric && lp!.parts[i] ? next.get(i)!.lyric! : m)) } : cur.plan.base;
  const src = cur.plan.flat!.src;
  // the planner's plan has it too, so a new Pace cuts it again with the rest
  const cues = src.cues?.map((c): ShotCue => {
    const i = [...made.keys()].find((k) => Math.abs(a.sections[k].start - c.at) < 0.06);
    if (i === undefined) return c;
    const { why: _w, lyric: _l, ...rest } = c;
    const n = next.get(i)!;
    return { ...rest, shot: made.get(i)!, ...(n.why ? { why: n.why } : {}), ...(n.lyric ? { lyric: n.lyric } : {}) };
  });
  // a like was for what was there
  const liked = cur.plan.liked?.map((x, i) => x && !parts.includes(i));
  const plan: VideoPlan = {
    ...cur.plan,
    looks,
    why,
    rotate: looks.map((_, i) => (looks[i] === cur.plan.looks[i] ? (cur.plan.rotate?.[i] ?? null) : null)),
    ...(cur.plan.shots || made.size ? { shots } : {}),
    ...(lyricPlan ? { lyricPlan } : {}),
    ...(base ? { base } : {}),
    ...(liked ? { liked } : {}),
    flat: { ...cur.plan.flat!, src: cues ? { ...src, cues: cuesAfter(src.cues!, cues) } : src },
  };
  // what the person had set on these pictures was for the ones that were there (their own drawing stays)
  const hand = cur.hand?.map((h, i) => (!h || !parts.includes(i) ? h : h.drawn && made.get(i)?.style === 'inside' ? { drawn: h.drawn } : null)) ?? null;
  for (const i of parts) remember(cur, i, wasWords(partNow(cur, i)));
  askedFor();
  s.set({ plan, partShot: hand?.some((x) => x !== null) ? hand : null, planOn: true, autoPilot: false });
  keepPlan(plan);
  releaseHold();
  return parts;
}

/**
 * Choose these parts again (the kept ones are left alone, and at most eight at once), with the person's
 * words for it when they gave some. A second call stops the first. Never throws.
 */
export async function redoParts(parts: number[], wish = ''): Promise<RedoResult> {
  const done = (r: RedoResult): RedoResult => {
    useRedo.setState({ running: false, note: r.note });
    return r;
  };
  const nothing = (note: string): RedoResult => ({ changed: [], by: null, note });
  cancelRedo();
  endPreview();
  const s = useStudio.getState();
  const v = playingVideo(s);
  if (!v) return done(nothing('Make a video first.'));
  if (s.clip) return done(nothing('Wait for the video to finish saving.'));
  if (s.planning) return done(nothing('Wait for the video to be made.'));
  const all = [...new Set(parts)].filter((i) => Number.isInteger(i) && i >= 0 && i < v.analysis.sections.length && !!v.plan.looks[i]).sort((x, y) => x - y);
  const open = all.filter((i) => !v.plan.kept?.[i]);
  const todo = open.slice(0, MOST_REDO);
  if (!todo.length) return done(nothing(all.length ? (all.length > 1 ? 'These parts are kept. Let one go to redo it.' : 'This part is kept. Let it go to redo it.') : 'There is no part to redo.'));
  const mine = new AbortController();
  ctrl = mine;
  useRedo.setState({ running: true, parts: todo, note: todo.length > 1 ? 'Choosing the parts again' : 'Choosing the part again' });
  const words = wish.replace(/\s+/g, ' ').trim().slice(0, 300);
  let next = new Map<number, Next>();
  let reason = '';
  const stopped = () => (useStudio.getState().analysis === v.analysis ? 'Stopped. Nothing was changed.' : '');
  try {
    ({ next, reason } = await ask(v, todo, words, mine.signal));
  } catch (err) {
    if (mine.signal.aborted) {
      // (a newer one says where it is itself)
      if (ctrl === mine) useRedo.setState({ running: false, note: stopped() });
      return nothing('Stopped. Nothing was changed.');
    }
    console.warn('a part could not be redone', err);
    reason = 'Claude couldn’t choose this time.';
  } finally {
    if (ctrl === mine && mine.signal.aborted) ctrl = null;
  }
  if (mine.signal.aborted) {
    if (useRedo.getState().running && (ctrl === mine || !ctrl)) useRedo.setState({ running: false, note: stopped() });
    return nothing('Stopped. Nothing was changed.');
  }
  const byClaude = new Set(next.keys());
  const picked = new Map([...next].flatMap(([i, n]) => (n.shot ? [[i, n.shot] as const] : [])));
  const own = new Map<number, string>();
  try {
    for (const i of todo) {
      if (next.has(i)) continue;
      const mineOwn = ownChoice(v, i, picked);
      if (!mineOwn) continue;
      next.set(i, mineOwn.next);
      if (mineOwn.next.shot) picked.set(i, mineOwn.next.shot);
      own.set(i, mineOwn.choice.label);
    }
    const changed = putIn(v, next);
    ctrl = null;
    if (!changed.length) return done(nothing(next.size ? 'The part was changed meanwhile, so it was left as it is.' : 'There is nothing else to show there yet. Add another clip or photo.'));
    const left = open.length - todo.length;
    const names = partNames(v.analysis);
    const theirs = changed.filter((i) => byClaude.has(i));
    const ours = changed.filter((i) => own.has(i));
    const by = theirs.length ? 'claude' : 'hum';
    const hum = !ours.length ? '' : theirs.length ? ' Hum chose the rest.' : `${reason ? ' ' : ''}Hum chose by itself: ${ours.length === 1 ? own.get(ours[0]) : `${ours.length} parts`}.${words ? ' It can’t follow your words without Claude.' : ''}`;
    const said = theirs.length === 1 ? (next.get(theirs[0])?.why ? `Now: ${next.get(theirs[0])!.why}` : `${names[theirs[0]]} was chosen again.`) : theirs.length ? `${listNames(theirs.slice(0, 3).map((i) => names[i]))}${theirs.length > 3 ? ` and ${theirs.length - 3} more` : ''} were chosen again.` : reason;
    return done({ changed, by, note: `${said.replace(/([^.])$/, '$1.')}${hum}${left ? ` ${left} more were left: at most ${MOST_REDO} at a time.` : ''}${all.length > open.length ? ' Kept parts were left alone.' : ''}`.trim() });
  } catch (err) {
    ctrl = null;
    console.warn('a part could not be redone', err);
    return done(nothing('That part couldn’t be redone.'));
  }
}
