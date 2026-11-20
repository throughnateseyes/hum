/**
 * A bottom sheet for touch screens: it rises from the bottom edge, rests at a peek, half or full
 * height, and follows the finger on its handle (and the heading under it). A flick moves it a step
 * on; pulling it down past the peek closes it. A tap on the handle swaps between half and full.
 *
 * Generic on purpose: the phone's panels (Looks, Look settings, Lyrics, Export) use it, and anything
 * else that wants a sheet on a phone can too. The sheet lives in a "track", a fixed box that sets
 * where it may go (by default the whole screen, under the top safe area); give it a `className` to
 * move the track (e.g. above a tab row with `bottom`, or to one side in landscape). Heights are
 * measured from the track, so they follow rotation and the browser's bars.
 *
 *   <Sheet open={open} snap={snap} onSnap={setSnap} onClose={close} label="Looks" header={<b>Looks</b>}>
 *     …scrolling content…
 *   </Sheet>
 *
 * The body scrolls by itself (overscroll stays inside it). Children that manage their own scrolling
 * (a flex column with an overflow-y child) can fill it: give them `flex: 1; min-height: 0`.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './sheet.css';

export type SheetSnap = 'peek' | 'half' | 'full';
export const SHEET_SNAPS: SheetSnap[] = ['peek', 'half', 'full'];

export interface SheetProps {
  open: boolean;
  snap: SheetSnap;
  onSnap: (s: SheetSnap) => void;
  onClose: () => void;
  /** read out by screen readers ("Looks", "Export") */
  label: string;
  /** a heading row under the handle; dragging it moves the sheet too */
  header?: ReactNode;
  children: ReactNode;
  /** extra class on the track (where the sheet may go, see the file's notes) */
  className?: string;
  /** the peek height in px (default: about a third of the track, 150–240 px) */
  peek?: number;
}

/** the sheet's height for a snap, in px of the track */
export function sheetHeight(snap: SheetSnap, track: number, peek?: number): number {
  const full = Math.max(120, track);
  const pk = Math.min(full, peek ?? Math.max(150, Math.min(240, Math.round(track * 0.32))));
  const half = Math.max(pk, Math.min(full, Math.round(track * 0.56)));
  return snap === 'peek' ? pk : snap === 'half' ? half : full;
}

/** how long a closing sheet keeps its content for the slide down (ms) */
const CLOSE_MS = 300;

export function Sheet({ open, snap, onSnap, onClose, label, header, children, className = '', peek }: SheetProps) {
  const track = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLElement>(null);
  const [trackH, setTrackH] = useState(600);
  const [mounted, setMounted] = useState(open);
  const [drag, setDrag] = useState<number | null>(null);
  const g = useRef<{ id: number; y0: number; h0: number; moved: boolean; samples: { y: number; t: number }[] } | null>(null);

  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTrackH(el.clientHeight));
    ro.observe(el);
    setTrackH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // keep the content while it slides away, then let it go (a closed sheet costs nothing)
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const id = setTimeout(() => setMounted(false), CLOSE_MS);
    return () => clearTimeout(id);
  }, [open]);

  // Esc closes it (a keyboard on a tablet)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const heights = SHEET_SNAPS.map((s) => sheetHeight(s, trackH, peek));
  const rest = open ? sheetHeight(snap, trackH, peek) : 0;
  const h = drag ?? rest;

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !open) return;
    // a control in the heading keeps its own tap
    if ((e.target as HTMLElement).closest('button:not(.sheet-handle-btn), a, input, select, textarea, label')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    g.current = { id: e.pointerId, y0: e.clientY, h0: rest, moved: false, samples: [{ y: e.clientY, t: e.timeStamp }] };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = g.current;
    if (!d || d.id !== e.pointerId) return;
    const dy = e.clientY - d.y0;
    if (!d.moved && Math.abs(dy) < 6) return;
    d.moved = true;
    d.samples.push({ y: e.clientY, t: e.timeStamp });
    if (d.samples.length > 6) d.samples.shift();
    // past full it stretches a little and stops
    const want = d.h0 - dy;
    const top = heights[2];
    setDrag(want > top ? top + (want - top) * 0.15 : Math.max(0, want));
  };
  const onUp = (e: React.PointerEvent) => {
    const d = g.current;
    g.current = null;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved) {
      // a tap on the handle: half ↔ full
      setDrag(null);
      if ((e.target as HTMLElement).closest('.sheet-handle-btn')) onSnap(snap === 'full' ? 'half' : 'full');
      return;
    }
    const cur = drag ?? d.h0;
    // speed over the last few samples (px/ms, up is positive)
    const a = d.samples[0];
    const b = d.samples[d.samples.length - 1];
    const v = b.t > a.t ? (a.y - b.y) / (b.t - a.t) : 0;
    const projected = cur + v * 180;
    setDrag(null);
    if (projected < heights[0] * 0.55 || (v < -0.9 && cur < heights[1])) {
      onClose();
      return;
    }
    let best = 0;
    for (let i = 1; i < heights.length; i++) if (Math.abs(heights[i] - projected) < Math.abs(heights[best] - projected)) best = i;
    onSnap(SHEET_SNAPS[best]);
  };
  const onCancel = () => {
    g.current = null;
    setDrag(null);
  };

  return (
    <div className={`sheet-track ${open ? 'open' : ''} ${className}`} ref={track}>
      <section
        ref={sheet}
        className={`sheet ${drag !== null ? 'dragging' : ''} ${open ? 'open' : ''}`}
        style={{ height: h }}
        role="dialog"
        aria-label={label}
        aria-hidden={!open}
        data-snap={open ? snap : 'closed'}
      >
        <div className="sheet-grab" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel}>
          <button className="sheet-handle-btn" aria-label={snap === 'full' ? 'Make the panel smaller' : 'Make the panel bigger'} tabIndex={open ? 0 : -1}>
            <span className="sheet-handle" />
          </button>
          {header && <div className="sheet-head">{header}</div>}
        </div>
        <div className="sheet-body">{mounted && children}</div>
      </section>
    </div>
  );
}
