import { useEffect, useRef, useState } from 'react';
import type { LayerId, ParamDef, ParamValue } from '../core/types';
import { LAYERS } from '../core/palettes';
import { onFrame } from '../state/live';
import { useStudio } from '../state/store';

export const LAYER_MIME = 'application/x-hum-layer';

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  liveValue,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  liveValue?: () => number | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const frac = (v: number) => Math.min(1, Math.max(0, (v - min) / (max - min || 1)));

  useEffect(() => {
    if (!liveValue) return;
    return onFrame(() => {
      const el = liveRef.current;
      if (!el) return;
      const v = liveValue();
      if (v === undefined || Math.abs(v - value) < (max - min) * 0.004) {
        el.style.opacity = '0';
        return;
      }
      el.style.opacity = '1';
      el.style.left = `${frac(v) * 100}%`;
    });
  });

  const setFromX = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    let v = min + ((clientX - r.left) / r.width) * (max - min);
    if (step) v = Math.round(v / step) * step;
    onChange(Math.min(max, Math.max(min, Number(v.toFixed(5)))));
  };

  return (
    <div
      className="slider"
      ref={ref}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        setFromX(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) setFromX(e.clientX);
      }}
    >
      <div className="track" />
      <div className="fill" style={{ width: `${frac(value) * 100}%` }} />
      {liveValue && <div className="live" ref={liveRef} style={{ opacity: 0 }} />}
      <div className="knob" style={{ left: `${frac(value) * 100}%` }} />
    </div>
  );
}

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <button className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)} aria-pressed={on} />;
}

function fmt(v: number, def: { min: number; max: number; step?: number }) {
  const range = def.max - def.min;
  const dp = def.step && def.step >= 1 ? 0 : range >= 100 ? 0 : range >= 10 ? 1 : 2;
  return v.toFixed(dp);
}

/**
 * One parameter row. `target` is the modulation target string ('scene.x' / 'fx.<id>.x').
 * Drop an audio layer chip on it to create a routing.
 */
export function ParamControl({
  def,
  value,
  onChange,
  target,
  live,
}: {
  def: ParamDef;
  value: ParamValue | undefined;
  onChange: (v: ParamValue) => void;
  target: string;
  live?: () => ParamValue | undefined;
}) {
  const allMods = useStudio((s) => s.modulations);
  const mods = allMods.filter((m) => m.target === target);
  const addModulation = useStudio((s) => s.addModulation);
  const [over, setOver] = useState(false);
  const v = value ?? def.default;

  const dropProps =
    def.type === 'number'
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (e.dataTransfer.types.includes(LAYER_MIME)) {
              e.preventDefault();
              setOver(true);
            }
          },
          onDragLeave: () => setOver(false),
          onDrop: (e: React.DragEvent) => {
            setOver(false);
            const id = e.dataTransfer.getData(LAYER_MIME) as LayerId;
            if (id) addModulation(id, target, 0.4);
          },
        }
      : {};

  return (
    <div className={`param ${over ? 'drop-target' : ''}`} {...dropProps}>
      <div className="param-top">
        <span className="param-name">
          {def.label}
          {mods.map((m) => (
            <span key={m.id} className="mod-badge" title={`${m.source} → ${def.label} (${Math.round(m.amount * 100)}%)`}>
              {LAYERS.find((l) => l.id === m.source)?.short ?? m.source}
            </span>
          ))}
        </span>
        {def.type === 'number' && <span className="param-val">{fmt(v as number, def)}</span>}
        {def.type === 'bool' && <Toggle on={!!v} onChange={onChange} />}
      </div>
      {def.type === 'number' && (
        <Slider
          value={v as number}
          min={def.min}
          max={def.max}
          step={def.step}
          onChange={onChange}
          liveValue={live ? () => live() as number | undefined : undefined}
        />
      )}
      {def.type === 'select' && (
        <div className="seg" style={{ flexWrap: 'wrap', display: def.options.length > 4 ? 'none' : 'inline-flex' }}>
          {def.options.map((o) => (
            <button key={o.value} className={v === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
              {o.label}
            </button>
          ))}
        </div>
      )}
      {def.type === 'select' && def.options.length > 4 && (
        <select className="sel" value={v as string} onChange={(e) => onChange(e.target.value)}>
          {def.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      {def.type === 'color' && (
        <div className="color-in">
          <input type="color" value={v as string} onChange={(e) => onChange(e.target.value)} />
          <span className="param-val">{String(v)}</span>
        </div>
      )}
    </div>
  );
}

/** Group params by their `group` field, preserving order. */
export function groupParams(defs: ParamDef[]): [string, ParamDef[]][] {
  const out: [string, ParamDef[]][] = [];
  for (const d of defs) {
    const g = d.group ?? 'Parameters';
    let bucket = out.find((x) => x[0] === g);
    if (!bucket) out.push((bucket = [g, []]));
    bucket[1].push(d);
  }
  return out;
}
