import { create } from 'zustand';
import { setArranging, thingsNow, tryOut, type Thing } from '../../arrange/things';
import { drawingOf, drawingRatio, hideBeside, keepBeside, moveDrawing, movePop, moveStanding, partAt, popsOf, removeDrawing, removePop, removeStanding, standing, type Stretch } from '../../arrange/edit';
import { clampTo, DRAWING_SIZE, POP_SIZE, shapeOfFrame, STANDING_SIZE, type FrameShape, type Spot } from '../../arrange/types';
import { audioEngine } from '../../audio/engine';
import { findLook, validPlan } from '../../state/plan';
import { useStudio } from '../../state/store';

/** the Arrange view: whether it is open, and the thing taken hold of (by its key, arrange/things.ts) */
export const useArrange = create<{ on: boolean; sel: string | null }>(() => ({ on: false, sel: null }));

export function canArrange(s = useStudio.getState()): boolean {
  return s.planOn && !!s.track && s.track.source !== 'mic' && validPlan(s.plan, s.analysis) && !s.clip && !s.perform;
}
export function openArrange() {
  if (!canArrange()) return useStudio.getState().flash('Make a video first, then arrange what is on it');
  setArranging(true);
  useArrange.setState({ on: true, sel: null });
}
export function closeArrange() {
  setArranging(false);
  useArrange.setState({ on: false, sel: null });
}
export const toggleArrange = () => (useArrange.getState().on ? closeArrange() : openArrange());
export const select = (sel: string | null) => useArrange.setState({ sel });

// full screen, a render, another look or song: there is nothing to arrange any more
useStudio.subscribe((s) => {
  if (useArrange.getState().on && !canArrange(s)) closeArrange();
});

/** the frame that is on screen */
export function frameNow(): { W: number; H: number; shape: FrameShape } {
  const c = document.querySelector<HTMLElement>('.stage-frame');
  const W = c?.clientWidth || 16;
  const H = c?.clientHeight || 9;
  return { W, H, shape: shapeOfFrame(W, H) };
}

export const partNow = (): Stretch | null => partAt(audioEngine.currentTime);

/** something in the part playing, on screen now or not */
export interface Item {
  key: string;
  kind: Thing['kind'];
  ref: string;
  name: string;
  from: number;
  to: number;
  spot: Spot | null;
  /** put there by hand */
  hand: boolean;
}

/** what the part playing has, in the order it comes up */
export function itemsOf(part: Stretch, shape: FrameShape): Item[] {
  const s = useStudio.getState();
  const out: Item[] = [];
  const d = standing(part.index, s);
  if (d) out.push({ key: `standing:${part.start.toFixed(2)}`, kind: 'standing', ref: d.id, name: drawingOf(d.id)?.name ?? 'Drawing', from: part.start, to: part.end, spot: d.spots?.[shape] ?? null, hand: !!d.spots });
  for (const p of s.placed.drawings) if (p.to > part.start + 0.02 && p.from < part.end - 0.02) out.push({ key: `placed:${p.id}`, kind: 'placed', ref: p.id, name: drawingOf(p.drawing)?.name ?? 'Drawing', from: p.from, to: p.to, spot: p.spots[shape] ?? null, hand: true });
  for (const w of popsOf(part, shape)) {
    const sp = w.spots[shape] ?? null;
    const off = s.popups === 'off' && Object.values(w.spots).every((x) => x.dealt);
    if (!off) out.push({ key: `${w.look ? 'window' : 'pop'}:${w.id}`, kind: w.look ? 'window' : 'pop', ref: w.id, name: w.look ? (findLook(w.look)?.name ?? 'A look') : (w.title ?? ''), from: w.from, to: w.to, spot: sp, hand: !!sp && !sp.dealt });
  }
  return out;
}

/** which of the part's things is taken hold of: in the part's list, or only on screen (one beside the words) */
export function selected(key: string | null, part: Stretch | null, shape: FrameShape): Item | null {
  if (!key || !part) return null;
  const it = itemsOf(part, shape).find((x) => x.key === key);
  if (it) return it;
  const t = thingsNow().find((x) => x.key === key && x.kind === 'beside');
  return t ? { key: t.key, kind: t.kind, ref: t.ref, name: t.name, from: t.from, to: t.to, spot: t.spot, hand: false } : null;
}

export const sizesOf = (kind: Thing['kind']): [number, number] => (kind === 'standing' ? STANDING_SIZE : kind === 'pop' || kind === 'window' ? POP_SIZE : DRAWING_SIZE);

/** the thing is let go: what the hand did is written down */
export function commitSpot(t: Thing, part: Stretch, spot: Spot) {
  const { shape } = frameNow();
  const at: Spot = { x: spot.x, y: spot.y, size: clampTo(sizesOf(t.kind), spot.size) };
  if (t.kind === 'standing') moveStanding(part.index, shape, at);
  else if (t.kind === 'placed') moveDrawing(t.key.slice('placed:'.length), shape, at);
  else if (t.kind === 'beside') select(`placed:${keepBeside(t, shape, at)}`);
  else movePop(part, shape, t.ref, at);
  tryOut(null);
}

export function removeItem(it: Item, part: Stretch) {
  const { shape } = frameNow();
  if (it.kind === 'standing') removeStanding(part.index);
  else if (it.kind === 'placed') removeDrawing(it.ref);
  else if (it.kind === 'beside') hideBeside(it);
  else removePop(part, shape, it.ref);
  select(null);
}

export { drawingRatio };
