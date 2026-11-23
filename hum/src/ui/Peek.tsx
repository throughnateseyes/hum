import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { PeekLook } from '../render/stage';
import { live } from '../state/live';
import { useStudio } from '../state/store';

/** Hover a look or scene in the library and it plays live in a small window beside it. */

const W = 256;
const H = 160;
const SHOW_DELAY_MS = 180;
const HIDE_DELAY_MS = 120;

interface PeekTarget {
  key: string;
  title: string;
  hint: string;
  look: PeekLook;
  poster?: string;
  rect: DOMRect;
  place: 'right' | 'above';
}

const usePeek = create<{ target: PeekTarget | null }>(() => ({ target: null }));

let showTimer: ReturnType<typeof setTimeout> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

export function hidePeek() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  usePeek.setState({ target: null });
}

/**
 * Mouse handlers for a library row. `getLook` returns null when there is nothing to preview
 * (for example, the row is what the stage is already showing).
 */
export function peekHandlers(opts: { key: string; title: string; hint: string; poster?: string; place?: 'right' | 'above'; getLook: () => PeekLook | null }) {
  return {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      const el = e.currentTarget;
      const show = () => {
        const st = useStudio.getState();
        const look = st.clip ? null : opts.getLook();
        usePeek.setState({ target: look ? { key: opts.key, title: opts.title, hint: opts.hint, poster: opts.poster, look, rect: el.getBoundingClientRect(), place: opts.place ?? 'right' } : null });
      };
      // once a preview is open, moving to the next row switches straight away
      if (usePeek.getState().target) show();
      else showTimer = setTimeout(show, SHOW_DELAY_MS);
    },
    onMouseLeave: () => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => usePeek.setState({ target: null }), HIDE_DELAY_MS);
    },
  };
}

export function PeekWindow() {
  const target = usePeek((s) => s.target);
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: -9999, top: 0 });

  useEffect(() => {
    const stage = live.stage;
    if (!target || !stage) return;
    stage.setPeek(target.look, canvas.current, W, H);
    return () => stage.setPeek(null, null);
  }, [target]);

  useLayoutEffect(() => {
    if (!target) return;
    const r = target.rect;
    const h = box.current?.offsetHeight ?? H + 44;
    if (target.place === 'above') {
      setPos({ left: Math.max(8, Math.min(window.innerWidth - W - 8, r.left + r.width / 2 - W / 2)), top: Math.max(8, r.top - h - 10) });
      return;
    }
    let left = r.right + 10;
    if (left + W > window.innerWidth - 8) left = r.left - W - 10;
    const top = Math.max(8, Math.min(window.innerHeight - h - 8, r.top + r.height / 2 - h / 2));
    setPos({ left, top });
  }, [target]);

  if (!target) return null;
  return (
    <div className="peek" ref={box} style={pos} key={target.key}>
      <canvas
        ref={canvas}
        width={W * 2}
        height={H * 2}
        style={{ width: W, height: H, backgroundImage: target.poster ? `url(${target.poster})` : undefined }}
      />
      <div className="peek-cap">
        <b>{target.title}</b>
        <span>{target.hint}</span>
      </div>
    </div>
  );
}
