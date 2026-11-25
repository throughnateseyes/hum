/**
 * Arranging on the picture: everything that is up is outlined, and can be taken hold of, moved and made
 * bigger or smaller with the hand. Lines show when it is in the middle, on a third or on the margin; on a
 * phone-tall frame the room the apps' own bars take is marked.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointer } from 'react';
import { thingsNow, tryOut, wordsNow, type Box, type Thing } from '../../arrange/things';
import { clampTo, type Spot } from '../../arrange/types';
import { audioEngine } from '../../audio/engine';
import { safeInsets } from '../../render/lyricSpace';
import { onFrame } from '../../state/live';
import { closeArrange, commitSpot, partNow, removeItem, select, selected, frameNow, sizesOf, useArrange } from './state';
import './arrange.css';

const NAMES: Record<Thing['kind'], string> = { pop: 'Pop-up', window: 'Look window', standing: 'Drawing in the place', placed: 'Drawing', beside: 'Drawing beside the words' };
/** how near a line pulls (px) */
const PULL = 7;

const sig = (ts: readonly Thing[], ws: readonly Box[]) => [...ts.map((t) => `${t.key}${[t.box.x0, t.box.y0, t.box.x1, t.box.y1].map((v) => v.toFixed(3)).join()}${t.hand}`), ...ws.map((w) => `${w.x0.toFixed(2)},${w.y0.toFixed(2)},${w.x1.toFixed(2)},${w.y1.toFixed(2)}`)].join('|');

const cover = (a: Box, b: Box) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
const area = (b: Box) => Math.max(1e-6, (b.x1 - b.x0) * (b.y1 - b.y0));

interface Drag {
  t: Thing;
  mode: 'move' | 'size';
  x: number;
  y: number;
  far: number;
  moved: boolean;
  spot: Spot;
  id: number;
}

export function ArrangeLayer() {
  const on = useArrange((s) => s.on);
  return on ? <Layer /> : null;
}

function Layer() {
  const sel = useArrange((s) => s.sel);
  const [seen, setSeen] = useState<{ things: readonly Thing[]; words: readonly Box[] }>({ things: [], words: [] });
  const [lines, setLines] = useState<{ x?: number; y?: number }>({});
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  useEffect(() => {
    let last = '';
    return onFrame(() => {
      const things = thingsNow();
      const words = wordsNow();
      const s = sig(things, words);
      if (s === last) return;
      last = s;
      setSeen({ things: [...things], words: [...words] });
    });
  }, []);

  useKeys();

  const begin = (e: ReactPointer, t: Thing, mode: Drag['mode']) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).focus?.({ preventScroll: true });
    // what is taken hold of stays up
    if (audioEngine.playing) audioEngine.pause();
    select(t.key);
    const r = root.current!.getBoundingClientRect();
    const cx = r.left + ((t.box.x0 + t.box.x1) / 2) * r.width;
    const cy = r.top + ((t.box.y0 + t.box.y1) / 2) * r.height;
    drag.current = { t, mode, x: e.clientX, y: e.clientY, far: Math.max(8, Math.hypot(e.clientX - cx, e.clientY - cy)), moved: false, spot: t.spot, id: e.pointerId };
    root.current!.setPointerCapture(e.pointerId);
  };

  const move = (e: ReactPointer) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 3) return;
    d.moved = true;
    const r = root.current!.getBoundingClientRect();
    const { t } = d;
    if (d.mode === 'size') {
      const cx = r.left + ((t.box.x0 + t.box.x1) / 2) * r.width;
      const cy = r.top + ((t.box.y0 + t.box.y1) / 2) * r.height;
      d.spot = { x: t.spot.x, y: t.spot.y, size: clampTo(sizesOf(t.kind), t.spot.size * (Math.hypot(e.clientX - cx, e.clientY - cy) / d.far)) };
    } else {
      let dx = (e.clientX - d.x) / r.width;
      let dy = (e.clientY - d.y) / r.height;
      const at: { x?: number; y?: number } = {};
      if (!e.altKey) {
        const px = pull(t.box.x0 + dx, t.box.x1 + dx, r.width, guides(r.width, r.height).x);
        const py = pull(t.box.y0 + dy, t.box.y1 + dy, r.height, guides(r.width, r.height).y);
        if (px) {
          dx += px.by;
          at.x = px.line;
        }
        if (py) {
          dy += py.by;
          at.y = py.line;
        }
      }
      setLines(at);
      const k = t.push ?? 1;
      d.spot = { x: t.spot.x + dx / k, y: t.spot.y + dy / k, size: t.spot.size };
    }
    tryOut({ key: t.key, spot: d.spot });
  };

  const end = (e: ReactPointer, off = false) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    setLines({});
    const part = partNow();
    if (!off && d.moved && part) commitSpot(d.t, part, d.spot);
    else tryOut(null);
  };

  const f = frameNow();
  const safe = safeInsets(f.W, f.H);
  return (
    <div
      className="arr"
      ref={root}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) select(null);
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={(e) => end(e, true)}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {f.shape === 'tall' && <div className="arr-safe" style={{ inset: `${safe.t}px ${safe.r}px ${safe.b}px ${safe.l}px` }} aria-hidden />}
      {lines.x !== undefined && <i className="arr-line v" style={{ left: `${lines.x * 100}%` }} aria-hidden />}
      {lines.y !== undefined && <i className="arr-line h" style={{ top: `${lines.y * 100}%` }} aria-hidden />}
      {seen.things.map((t) => {
        const over = seen.words.some((w) => cover(t.box, w) / Math.min(area(w), area(t.box)) > 0.12);
        const mine = t.key === sel;
        return (
          <div
            key={t.key}
            role="button"
            tabIndex={0}
            className={`arr-box ${mine ? 'sel' : ''} ${t.hand ? 'hand' : ''}`}
            aria-pressed={mine}
            aria-label={`${NAMES[t.kind]}: ${t.name}`}
            style={{ left: `${t.box.x0 * 100}%`, top: `${t.box.y0 * 100}%`, width: `${(t.box.x1 - t.box.x0) * 100}%`, height: `${(t.box.y1 - t.box.y0) * 100}%`, zIndex: mine ? 3 : t.kind === 'standing' ? 1 : 2 }}
            onPointerDown={(e) => begin(e, t, 'move')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') select(t.key);
            }}
          >
            <span className={`arr-tag ${t.box.y0 < 0.07 ? 'in' : ''}`}>
              {t.name}
              {over && <b>Over the words</b>}
            </span>
            {mine && ['nw', 'ne', 'sw', 'se'].map((c) => <i key={c} className={`arr-grip ${c}`} onPointerDown={(e) => begin(e, t, 'size')} aria-hidden />)}
          </div>
        );
      })}
      {!seen.things.length && <div className="arr-none">Nothing is up right now. Add something below, or move to another moment.</div>}
    </div>
  );
}

/** the lines a thing is pulled to: the middle, the thirds, and (for its edges) the margins */
function guides(W: number, H: number): { x: { mid: number[]; edge: [number, number] }; y: { mid: number[]; edge: [number, number] } } {
  const s = safeInsets(W, H);
  return { x: { mid: [0.5, 1 / 3, 2 / 3], edge: [s.l / W, 1 - s.r / W] }, y: { mid: [0.5, 1 / 3, 2 / 3], edge: [s.t / H, 1 - s.b / H] } };
}
function pull(a: number, b: number, px: number, g: { mid: number[]; edge: [number, number] }): { by: number; line: number } | null {
  const tries = [...g.mid.map((line) => ({ by: line - (a + b) / 2, line })), { by: g.edge[0] - a, line: g.edge[0] }, { by: g.edge[1] - b, line: g.edge[1] }];
  const best = tries.sort((p, q) => Math.abs(p.by) - Math.abs(q.by))[0];
  return Math.abs(best.by) * px < PULL ? best : null;
}

/** arrows move what is held, Delete takes it out, Esc lets go of it and then closes the view */
function useKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable || e.metaKey || e.ctrlKey) return;
      const { sel } = useArrange.getState();
      const part = partNow();
      const stop = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      if (e.key === 'Escape') {
        stop();
        if (sel) select(null);
        else closeArrange();
        return;
      }
      if (!sel || !part) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const it = selected(sel, part, frameNow().shape);
        if (!it) return;
        stop();
        removeItem(it, part);
        return;
      }
      const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!dir) return;
      stop();
      const t = thingsNow().find((x) => x.key === sel);
      if (!t) return;
      const step = e.shiftKey ? 0.03 : 0.005;
      const { W, H } = frameNow();
      commitSpot(t, part, { x: t.spot.x + (dir[0] * step * Math.min(W, H)) / W, y: t.spot.y + (dir[1] * step * Math.min(W, H)) / H, size: t.spot.size });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}
