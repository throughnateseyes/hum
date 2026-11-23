/**
 * How a footage part's picture sits in the frame (store.partShot[i].focusX / focusY / zoom), in the
 * Part tab's Picture group (FootagePicture.tsx).
 *
 * The whole picture is shown small; the bright window over it is the video's shape at the chosen zoom,
 * which is what stays on screen. The dot is the focus point: drag it (or click anywhere on the picture),
 * or nudge it with the arrow keys (Shift for bigger steps). Focus is measured from the left and from
 * the bottom, as the footage scene reads it.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { Aspect } from '../state/store';
import { useStudio } from '../state/store';
import { Field, Slider } from './controls';
import type { MediaItem } from './footageMedia';

const RATIO: Record<Aspect, number> = { fill: 16 / 9, '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5 };
/** the preview's tallest */
const MAX_H = 150;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

export interface FramingValue {
  focusX: number;
  focusY: number;
  zoom: number;
}

export function Framing({ item, value, onChange, disabled }: { item: MediaItem; value: FramingValue; onChange: (v: Partial<FramingValue>) => void; disabled?: boolean }) {
  const aspect = useStudio((s) => s.aspect);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(260);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 260));
    ro.observe(el);
    setWidth(el.clientWidth || 260);
    return () => ro.disconnect();
  }, []);

  // the picture, fitted whole into the panel's width and at most MAX_H tall
  const pr = Math.max(0.1, item.width / Math.max(1, item.height));
  const h = Math.min(MAX_H, width / pr);
  const w = h * pr;
  // the window the video keeps: its shape, covering the picture, pushed in by zoom, centred on the focus
  const vr = RATIO[aspect] ?? 16 / 9;
  const z = clamp(value.zoom, 1, 3);
  let ww = vr > pr ? w : h * vr;
  let wh = vr > pr ? w / vr : h;
  ww /= z;
  wh /= z;
  const cx = value.focusX * w;
  const cy = (1 - value.focusY) * h;
  const left = clamp(cx - ww / 2, 0, w - ww);
  const top = clamp(cy - wh / 2, 0, h - wh);

  const fromPointer = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    onChange({ focusX: round2(clamp((e.clientX - r.left) / r.width, 0, 1)), focusY: round2(clamp(1 - (e.clientY - r.top) / r.height, 0, 1)) });
  };
  const nudge = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const m = d[e.key];
    if (!m) return;
    e.preventDefault();
    e.stopPropagation();
    onChange({ focusX: round2(clamp(value.focusX + m[0], 0, 1)), focusY: round2(clamp(value.focusY + m[1], 0, 1)) });
  };

  return (
    <div className="fr">
      <div className="fr-wrap" ref={wrap}>
        <div
          className={`fr-pic ${disabled ? 'is-off' : ''}`}
          style={{ width: w, height: h, backgroundImage: item.thumb ? `url("${item.thumb}")` : undefined }}
          onPointerDown={(e) => {
            if (disabled) return;
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            fromPointer(e);
          }}
          onPointerMove={(e) => {
            if (!disabled && e.buttons & 1) fromPointer(e);
          }}
        >
          <span className="fr-win" style={{ left, top, width: ww, height: wh }} aria-hidden />
          <span
            className="fr-dot"
            style={{ left: cx, top: cy }}
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label="Focus point"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(value.focusX * 100)}
            aria-valuetext={`${Math.round(value.focusX * 100)}% from the left, ${Math.round(value.focusY * 100)}% up. Arrow keys move it.`}
            onKeyDown={nudge}
          />
        </div>
      </div>
      <Field label="Zoom" value={`${z.toFixed(1)}×`} tip="How far the picture is pushed in. 1 fits the frame.">
        <Slider value={z} min={1} max={3} step={0.05} onChange={(v) => !disabled && onChange({ zoom: round2(v) })} />
      </Field>
    </div>
  );
}
