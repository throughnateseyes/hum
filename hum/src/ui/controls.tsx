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
    // only touch the page when the marker actually moves (most sliders aren't modulated)
    let shown = '';
    let left = '';
    return onFrame(() => {
      const el = liveRef.current;
      if (!el) return;
      const v = liveValue();
      const hide = v === undefined || Math.abs(v - value) < (max - min) * 0.004;
      const op = hide ? '0' : '1';
      if (op !== shown) el.style.opacity = shown = op;
      if (hide) return;
      const l = `${Math.round(frac(v) * 1000) / 10}%`;
      if (l !== left) el.style.left = left = l;
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

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button type="button" role="switch" className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)} aria-checked={on} aria-label={label} />;
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
        <div
          className={`seg ${def.options.map((o) => o.label).join('').length > 26 ? 'grid2' : 'full'}`}
          style={def.options.length > 4 ? { display: 'none' } : undefined}
        >
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

/* ───────── layout pieces shared by the panels ───────── */

/** which collapsible sections are open, kept for this visit so switching tabs doesn't reset them */
const sectionOpen = new Map<string, boolean>();

/**
 * A titled group in a panel. With `collapsible`, the title opens and closes it; `right` holds a
 * control that sits on the title row (a switch, a value) and stays usable when it's closed. With
 * `value` it is a settings row: its name, what it is set to now, and a caret; the sub line shows once open.
 */
export function Section({
  id,
  title,
  sub,
  right,
  value,
  collapsible = false,
  defaultOpen = true,
  children,
}: {
  id: string;
  title: React.ReactNode;
  sub?: React.ReactNode;
  right?: React.ReactNode;
  value?: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpenState] = useState(() => sectionOpen.get(id) ?? defaultOpen);
  const setOpen = (v: boolean) => {
    sectionOpen.set(id, v);
    setOpenState(v);
  };
  const shown = !collapsible || open;
  const row = collapsible && value !== undefined;
  const head = (
    <>
      <span className="sec-t">
        {collapsible && !row && <Caret open={open} />}
        {title}
      </span>
      {row ? (
        <span className="sec-v">
          <span>{value}</span>
          <Caret open={open} />
        </span>
      ) : (
        sub && <span className="sec-s">{sub}</span>
      )}
    </>
  );
  return (
    <section className={`sec ${collapsible ? 'collapsible' : ''} ${row ? 'row' : ''} ${shown ? 'open' : ''}`}>
      <div className="sec-head">
        {collapsible ? (
          <button className="sec-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
            {head}
          </button>
        ) : (
          <div className="sec-toggle">{head}</div>
        )}
        {right && <div className="sec-right">{right}</div>}
      </div>
      {shown && children && (
        <div className="sec-body">
          {row && sub && <p className="field-note sec-note">{sub}</p>}
          {children}
        </div>
      )}
    </section>
  );
}

/** rows that belong together, under a quiet label */
export function Group({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div className="grp" role="group" aria-label={label}>
      {label && <span className="grp-l">{label}</span>}
      {children}
    </div>
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg className="sec-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden style={{ transform: open ? 'rotate(90deg)' : 'none' }}>
      <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** one labelled control inside a section: the name (with an optional value or hint) over the control */
export function Field({ label, value, tip, children }: { label: React.ReactNode; value?: React.ReactNode; tip?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <div className={`param-top ${tip ? 'has-tip' : ''}`} data-tip={tip}>
        <span className="param-name">{label}</span>
        {value !== undefined && <span className="param-val">{value}</span>}
      </div>
      {children}
    </div>
  );
}

/**
 * A segmented control that fills its row: a white pill on the choice that's on. `cols` lays a longer
 * set out as an even grid (seven finishes as two rows of four) instead of squeezing it into one row.
 */
export function Seg<T extends string | number>({
  value,
  options,
  onChange,
  disabled,
  cols,
  label,
  onHover,
}: {
  value: T;
  /** span: how many of the grid's columns a choice takes (with cols) */
  options: { v: T; label: string; tip?: string; span?: number }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  cols?: number;
  label?: string;
  /** the choice under the pointer or with keyboard focus (null when none): for a line that explains it */
  onHover?: (v: T | null) => void;
}) {
  return (
    <div
      className={`seg ${cols ? 'grid' : 'full'} ${disabled ? 'is-off' : ''}`}
      style={cols ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } : undefined}
      role="radiogroup"
      aria-label={label}
    >
      {options.map((o) => (
        <button
          key={String(o.v)}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          className={value === o.v ? 'on' : ''}
          disabled={disabled}
          title={onHover ? undefined : o.tip}
          onMouseEnter={onHover ? () => onHover(o.v) : undefined}
          onMouseLeave={onHover ? () => onHover(null) : undefined}
          onFocus={onHover ? () => onHover(o.v) : undefined}
          onBlur={onHover ? () => onHover(null) : undefined}
          style={o.span ? { gridColumn: `span ${o.span}` } : undefined}
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** a labelled switch on its own row, with an optional line under the name */
export function SwitchRow({ label, note, on, onChange, tip }: { label: string; note?: string; on: boolean; onChange: (v: boolean) => void; tip?: string }) {
  return (
    <div className={`row-switch ${tip ? 'has-tip' : ''}`} data-tip={tip}>
      <span>
        <b>{label}</b>
        {note && <small>{note}</small>}
      </span>
      <Toggle on={on} onChange={onChange} label={label} />
    </div>
  );
}

/** a long description cut to three lines, with a quiet More / Less */
export function Clamp({ text, lines = 3 }: { text: string; lines?: number }) {
  const [open, setOpen] = useState(false);
  const long = text.length > lines * 52;
  return (
    <div className="clamp">
      <p className={open || !long ? '' : 'cut'} style={{ ['--lines' as string]: lines }}>
        {text}
      </p>
      {long && (
        <button className="clamp-more" onClick={() => setOpen(!open)}>
          {open ? 'Less' : 'More'}
        </button>
      )}
    </div>
  );
}
