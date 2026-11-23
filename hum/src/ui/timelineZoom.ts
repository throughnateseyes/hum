/**
 * How far the timeline is zoomed (ui/Timeline.tsx): 1 shows the whole song, more shows less of it.
 * The keys (+ − 0), the zoom buttons and ⌘/Ctrl+wheel all come through here; a zoom can name a song
 * time to keep still in the view (the one under the pointer), which the timeline reads once.
 */
import { create } from 'zustand';
import { useStudio } from '../state/store';

export const useTimelineZoom = create<{ zoom: number }>(() => ({ zoom: 1 }));

/** zoomed in this far, about four seconds fill the view (and never more than 64×) */
export const maxZoom = (d: number) => Math.max(1, Math.min(64, d / 4));

/** where the next zoom should keep still: a song time and where it sits in the view (0 left … 1 right) */
let anchor: { t: number; at: number } | null = null;

/** the anchor of the zoom just made, once (null: keep the playhead, or the middle, in place) */
export function takeZoomAnchor(): { t: number; at: number } | null {
  const a = anchor;
  anchor = null;
  return a;
}

/** zoom to `z` (kept between fit and maxZoom), keeping song time `keep.t` where it is in the view */
export function zoomTo(z: number, keep?: { t: number; at: number }) {
  const d = useStudio.getState().analysis?.duration ?? 0;
  const next = Math.max(1, Math.min(maxZoom(d), z));
  if (Math.abs(next - useTimelineZoom.getState().zoom) < 1e-3) return;
  anchor = keep ?? null;
  useTimelineZoom.setState({ zoom: next });
}

/** a step in or out, around the playhead (or the middle of the view when it's out of sight) */
export const zoomStep = (dir: 1 | -1) => zoomTo(useTimelineZoom.getState().zoom * (dir > 0 ? 1.5 : 1 / 1.5));

/** the whole song in view */
export const zoomFit = () => zoomTo(1);
