/**
 * Arranging by hand: every change the Arrange view (src/ui/arrange) makes. What is dealt for a part is
 * written down as it is the first time one of its pop-ups is changed, and from then on that list is the
 * part's, so nothing else in it moves. Each call is one change to the store (one Undo step).
 */
import { drawingNow, drawingsHere } from '../draw/session';
import { ratioOf } from '../scenes/draw/layout';
import type { DrawingAsset } from '../draw/types';
import { HAND_PUTS, type DrawnEnter, type DrawnShot, type HandPut } from '../inside/drawnIds';
import { playsClips } from '../director/footage';
import { live } from '../state/live';
import { findLook, snapToBeat, validPlan } from '../state/plan';
import { setPartsShot } from '../state/partEdit';
import { shotOfPart } from '../shot/partShots';
import { useStudio, type StudioState } from '../state/store';
import { popKinds, type DealtPop } from '../render/popups';
import type { Thing } from './things';
import { clampTo, DRAWING_SIZE, POP_SIZE, popSetFor, spotFor, STANDING_SIZE, withoutAny, withoutPops, type FrameShape, type Placed, type PlacedDrawing, type PlacedPop, type Spot, type Spots } from './types';

export interface Stretch {
  index: number;
  start: number;
  end: number;
}

const uid = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const put = (placed: Placed) => useStudio.getState().set({ placed });
const round = (v: number) => Math.round(v * 10000) / 10000;
const tidy = (s: Spot, size: [number, number]): Spot => ({ x: round(clampTo([-0.5, 1.5], s.x)), y: round(clampTo([-0.5, 1.5], s.y)), size: round(clampTo(size, s.size)), ...(s.dealt ? { dealt: true as const } : {}) });
const withSpot = (spots: Spots | undefined, shape: FrameShape, spot: Spot, size: [number, number]): Spots => ({ ...spots, [shape]: tidy(spot, size) });

/** the part of the video at song time t (null: no video is on) */
export function partAt(t: number, s: StudioState = useStudio.getState()): Stretch | null {
  const a = s.analysis;
  if (!s.planOn || !a || !validPlan(s.plan, a)) return null;
  let i = 0;
  while (i < a.sections.length - 1 && a.sections[i + 1].start <= t) i++;
  const start = a.sections[i].start;
  return { index: i, start, end: a.sections[i + 1]?.start ?? Math.max(a.sections[i].end, a.duration) };
}

/* ───────── pop-ups ───────── */

/** what a part's pop-ups are now: the person's own list, or the ones it was dealt */
export function popsOf(part: Stretch, shape: FrameShape): PlacedPop[] {
  const set = popSetFor(useStudio.getState().placed, part.start, part.end);
  if (set) return set.wins.filter((w) => w.to > part.start + 0.02 && w.from < part.end - 0.02);
  const dealt = live.stage?.dealtPops();
  if (!dealt || Math.abs(dealt.part.start - part.start) > 0.01) return [];
  return dealt.pops.map((d: DealtPop): PlacedPop => {
    const { spot, ...rest } = d;
    return { ...rest, spots: { [shape]: tidy(spot, POP_SIZE) } };
  });
}

/** the part's pop-ups are these from now on */
function setPops(part: Stretch, wins: PlacedPop[]) {
  const p = withoutPops(useStudio.getState().placed, [part]);
  put({ ...p, pops: [...p.pops, { from: part.start, to: part.end, wins }] });
}

function changePop(part: Stretch, shape: FrameShape, id: string, f: (w: PlacedPop) => PlacedPop | null) {
  const wins = popsOf(part, shape);
  if (!wins.some((w) => w.id === id)) return;
  setPops(part, wins.flatMap((w) => (w.id === id ? (f(w) ?? []) : [w])));
}

export const movePop = (part: Stretch, shape: FrameShape, id: string, spot: Spot) => changePop(part, shape, id, (w) => ({ ...w, spots: withSpot(w.spots, shape, spot, POP_SIZE) }));
export const timePop = (part: Stretch, shape: FrameShape, id: string, from: number, to: number) => changePop(part, shape, id, (w) => ({ ...w, from, to, snap: undefined }));
export const removePop = (part: Stretch, shape: FrameShape, id: string) => changePop(part, shape, id, () => null);

/** a pop-up becomes another instrument, or another look */
export const swapPop = (part: Stretch, shape: FrameShape, id: string, to: { title: string } | { look: string }) =>
  changePop(part, shape, id, (w) => {
    const { title: _t, look: _l, shape: frame, ...rest } = w;
    return 'look' in to ? { ...rest, look: to.look, shape: frame ?? FRAMES[0] } : { ...rest, title: to.title };
  });

/** the ways a window can be framed: a window with a bar, a card, a soft-cornered cut-out, a circle */
const FRAMES = [
  { f: 0.2, aspect: 0.1, circle: 0.9, size: 0.5, bar: 0.2 },
  { f: 0.6, aspect: 0.3, circle: 0.9, size: 0.5, bar: 0.2 },
  { f: 0.9, aspect: 0.1, circle: 0.9, size: 0.5, bar: 0.2 },
  { f: 0.9, aspect: 0.1, circle: 0.1, size: 0.5, bar: 0.2 },
  { f: 0.2, aspect: 0.6, circle: 0.9, size: 0.5, bar: 0.8 },
  { f: 0.6, aspect: 0.8, circle: 0.9, size: 0.5, bar: 0.2 },
];
/** the next way it can be framed (an instrument's title bar, a look's frame) */
export const restylePop = (part: Stretch, shape: FrameShape, id: string) =>
  changePop(part, shape, id, (w) => {
    if (!w.look) return { ...w, style: (w.style + 1) % 3 };
    const at = FRAMES.findIndex((f) => w.shape && f.f === w.shape.f && f.aspect === w.shape.aspect && f.circle === w.shape.circle);
    return { ...w, shape: FRAMES[(at + 1) % FRAMES.length] };
  });

/** whether it stays exactly where it was put, or steps aside for the words */
export const loosenPop = (part: Stretch, shape: FrameShape, id: string, loose: boolean) =>
  changePop(part, shape, id, (w) => {
    const at = spotFor(w.spots, shape);
    if (!at) return w;
    const { dealt: _d, ...spot } = at.spot;
    return { ...w, spots: withSpot(w.spots, shape, loose ? { ...spot, dealt: true } : spot, POP_SIZE) };
  });

/** the stretch a new thing is up for: from the beat before t, two bars, inside the part */
function stretchAt(part: Stretch, t: number): { from: number; to: number } {
  const a = useStudio.getState().analysis!;
  const beat = 60 / clampTo([50, 200], a.bpm || 120);
  let from = snapToBeat(a, t - beat / 2);
  // it is all there at t, so it can be taken hold of
  if (t - from < 0.25) from = snapToBeat(a, from - beat);
  from = Math.max(part.start, from);
  const to = Math.min(part.end, Math.max(t + 0.5, from + beat * 8));
  return { from: to - from < 0.5 ? Math.max(part.start, to - beat * 4) : from, to };
}

export function addPop(part: Stretch, shape: FrameShape, t: number, what: { title: string } | { look: string }): string {
  const id = uid('h');
  const wins = popsOf(part, shape);
  // somewhere the last one added isn't
  const n = wins.filter((w) => w.id.startsWith('h-') && w.from <= t && w.to > t).length;
  const at = [[0.27, 0.32], [0.73, 0.32], [0.27, 0.68], [0.73, 0.68], [0.5, 0.25]][n % 5];
  setPops(part, [...wins, { id, ...stretchAt(part, t), ...('look' in what ? { look: what.look, shape: FRAMES[0] } : { title: what.title }), style: n % 3, spots: { [shape]: { x: at[0], y: at[1], size: 1 } } }]);
  return id;
}

/** the instruments that have something to show in this song */
export function kindsHere(s: StudioState): string[] {
  const words = !!(s.lyrics?.synced && s.lyrics.lines.length);
  return popKinds().filter((k) => (k.needs !== 'words' || words) && (k.needs !== 'map' || !!s.analysis?.sections.length)).map((k) => k.title);
}

/* ───────── drawings laid over the picture ───────── */

function changeDrawing(id: string, f: (d: PlacedDrawing) => PlacedDrawing | null) {
  const p = useStudio.getState().placed;
  if (!p.drawings.some((d) => d.id === id)) return;
  put({ ...p, drawings: p.drawings.flatMap((d) => (d.id === id ? (f(d) ?? []) : [d])) });
}
export const moveDrawing = (id: string, shape: FrameShape, spot: Spot) => changeDrawing(id, (d) => ({ ...d, spots: withSpot(d.spots, shape, spot, DRAWING_SIZE) }));
export const timeDrawing = (id: string, from: number, to: number) => changeDrawing(id, (d) => ({ ...d, from, to }));
export const swapDrawing = (id: string, drawing: string) => changeDrawing(id, (d) => ({ ...d, drawing }));
export const enterDrawing = (id: string, enter: PlacedDrawing['enter']) => changeDrawing(id, (d) => ({ ...d, enter }));
export const removeDrawing = (id: string) => changeDrawing(id, () => null);

export function addDrawing(part: Stretch, shape: FrameShape, t: number, drawing: string): string {
  const id = uid('d');
  const p = useStudio.getState().placed;
  put({ ...p, drawings: [...p.drawings, { id, drawing, ...stretchAt(part, t), enter: 'draw', spots: { [shape]: { x: shape === 'tall' ? 0.5 : 0.72, y: shape === 'tall' ? 0.34 : 0.42, size: 0.36 } } }] });
  return id;
}

/** a small drawing beside the words, moved: it is the person's from then on, and that line has no other */
export function keepBeside(t: Thing, shape: FrameShape, spot: Spot): string {
  const id = uid('d');
  const p = useStudio.getState().placed;
  put({ ...p, drawings: [...p.drawings, { id, drawing: t.ref, from: t.from, to: t.to, enter: 'draw', spots: { [shape]: tidy(spot, DRAWING_SIZE) } }], hidden: [...p.hidden, { from: t.from, to: t.to }] });
  return id;
}
export function hideBeside(t: Pick<Thing, 'from' | 'to'>) {
  const p = useStudio.getState().placed;
  put({ ...p, hidden: [...p.hidden, { from: t.from, to: t.to }] });
}

/* ───────── drawings standing in the place ───────── */

/** does this part show the inside of a place, where a drawing can stand? */
export function standsIn(i: number, s: StudioState = useStudio.getState()): boolean {
  const look = s.plan?.looks[i];
  return shotOfPart(i, s)?.style === 'inside' && playsClips(look ? findLook(look) : undefined);
}
export const standing = (i: number, s: StudioState = useStudio.getState()): DrawnShot | null => (standsIn(i, s) ? (shotOfPart(i, s)?.drawn ?? null) : null);

function changeStanding(i: number, f: (d: DrawnShot) => DrawnShot | null) {
  const d = standing(i);
  if (d) setPartsShot([i], { drawn: f(d) });
}
export const moveStanding = (i: number, shape: FrameShape, spot: Spot) => changeStanding(i, (d) => ({ ...d, spots: withSpot(d.spots, shape, spot, STANDING_SIZE) }));
export const putStanding = (i: number, to: HandPut) => changeStanding(i, (d) => (HAND_PUTS.includes(to) ? { ...d, put: to } : d));
export const enterStanding = (i: number, enter: DrawnEnter) => changeStanding(i, (d) => ({ ...d, enter }));
export const swapStanding = (i: number, id: string) => changeStanding(i, (d) => ({ ...d, id, why: undefined }));
export const removeStanding = (i: number) => changeStanding(i, () => null);
/** the shot finds it a place again */
export const looseStanding = (i: number) =>
  changeStanding(i, ({ spots: _s, ...d }) => ({ ...d, put: d.put === 'front' ? 'between' : d.put }));
export const addStanding = (i: number, id: string) => setPartsShot([i], { drawn: { id, put: 'between', size: 'medium', enter: 'draw' } });

/* ───────── a whole part ───────── */

/** has anything in the part been placed by hand? */
export function placedHere(part: Stretch, s: StudioState = useStudio.getState()): boolean {
  if (withoutAny(s.placed, [part]) !== s.placed) return true;
  const d = standing(part.index, s);
  return !!d && (!!d.spots || d.put === 'front');
}
/** everything in the part as Hum would have it */
export function resetHere(part: Stretch) {
  const s = useStudio.getState();
  const placed = withoutAny(s.placed, [part]);
  const d = standing(part.index, s);
  if (placed !== s.placed) put(placed);
  if (d && (d.spots || d.put === 'front')) looseStanding(part.index);
}

/** a drawing by its id, as it is now (redrawn since or not) */
export const drawingOf = (id: string): DrawingAsset | null => drawingNow(id, drawingsHere());
export const drawingRatio = (id: string): number => {
  const d = drawingOf(id);
  return d ? ratioOf(d) : 1;
};
