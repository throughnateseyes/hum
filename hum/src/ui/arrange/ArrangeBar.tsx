/**
 * Under the picture while arranging: what can be added, what the thing taken hold of can be, and the part
 * that is playing as a strip where each thing can be moved in time and made longer or shorter, on the beat.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointer } from 'react';
import { addDrawing, addPop, addStanding, enterDrawing, enterStanding, kindsHere, loosenPop, looseStanding, partAt, placedHere, putStanding, resetHere, restylePop, standing, standsIn, swapDrawing, swapPop, swapStanding, timeDrawing, timePop, type Stretch } from '../../arrange/edit';
import { thingsNow } from '../../arrange/things';
import { clampTo, type FrameShape, type Spot } from '../../arrange/types';
import { audioEngine } from '../../audio/engine';
import { useCanDraw, useDrawingsHere } from '../../draw/hooks';
import { drawingNow } from '../../draw/session';
import type { DrawingAsset } from '../../draw/types';
import { HAND_PUTS, type DrawnEnter, type HandPut } from '../../inside/drawnIds';
import { familyOf } from '../../presets/fit';
import { getScene } from '../../scenes';
import { allLooks, partNames, snapToBeat } from '../../state/plan';
import { live, onFrame } from '../../state/live';
import { useStudio } from '../../state/store';
import { DrawThumb } from '../Drawings';
import { PUT_NAMES } from '../DrawnHere';
import { Chevron, Plus, Trash } from '../Icons';
import { useLayout } from '../layout';
import { canArrange, closeArrange, openArrange, commitSpot, frameNow, itemsOf, removeItem, select, selected, sizesOf, useArrange, type Item } from './state';
import './arrange.css';

export function ArrangeBar() {
  const on = useArrange((s) => s.on);
  return on ? <Bar /> : null;
}

/** the part playing, and what there is to show of it (followed as it changes, while nothing is dragged) */
function usePart(): { part: Stretch | null; shape: FrameShape; items: Item[] } {
  // anything that changes what a part has
  useStudio((s) => s.placed);
  useStudio((s) => s.partShot);
  useStudio((s) => s.plan);
  useStudio((s) => s.analysis);
  useStudio((s) => s.popups);
  useStudio((s) => s.drawings);
  const [, look] = useState('');
  useEffect(() => {
    let last = '';
    return onFrame(() => {
      const p = partAt(audioEngine.currentTime);
      const dealt = live.stage?.dealtPops();
      const now = p ? `${p.start}|${p.end}|${frameNow().shape}|${dealt?.part.start ?? ''}|${dealt?.pops.map((x) => `${x.id}${x.from.toFixed(2)}${x.to.toFixed(2)}${x.title ?? x.look}`).join() ?? ''}|${thingsNow().some((t) => t.kind === 'beside') ? 1 : 0}` : '';
      if (now !== last) look((last = now));
    });
  }, []);
  const part = partAt(audioEngine.currentTime);
  const { shape } = frameNow();
  return { part, shape, items: part ? itemsOf(part, shape) : [] };
}

function Bar() {
  const { part, shape, items } = usePart();
  const sel = useArrange((s) => s.sel);
  const a = useStudio((s) => s.analysis);
  if (!part || !a) return null;
  const it = selected(sel, part, shape);
  const names = partNames(a);
  const go = (d: number) => {
    const sec = a.sections[part.index + d];
    if (!sec) return;
    select(null);
    audioEngine.seek(sec.start + 0.03);
  };
  return (
    <div className="arrbar" role="region" aria-label="Arrange">
      <div className="arrbar-row">
        <div className="arrbar-part">
          <button type="button" className="btn icon sm ghost" disabled={part.index === 0} onClick={() => go(-1)} aria-label="The part before">
            <Chevron width={14} height={14} style={{ transform: 'rotate(90deg)' }} />
          </button>
          <b title={names[part.index]}>{names[part.index]}</b>
          <button type="button" className="btn icon sm ghost" disabled={part.index >= a.sections.length - 1} onClick={() => go(1)} aria-label="The next part">
            <Chevron width={14} height={14} style={{ transform: 'rotate(-90deg)' }} />
          </button>
        </div>
        {it ? (
          <Selected key={it.key} it={it} part={part} shape={shape} />
        ) : (
          <div className="arrbar-add">
            <AddPop part={part} shape={shape} />
            <AddDrawing part={part} shape={shape} />
            {placedHere(part) && (
              <button type="button" className="btn sm ghost" onClick={() => resetHere(part)} title="Pop-ups and drawings here go back to how Hum placed them">
                Back to automatic
              </button>
            )}
          </div>
        )}
        <button type="button" className="btn sm solid arrbar-done" onClick={closeArrange}>
          Done
        </button>
      </div>
      <Lane part={part} shape={shape} items={items} />
    </div>
  );
}

/* ───────── adding ───────── */

/** a button with a small list over it */
function Menu({ label, name, children }: { label: React.ReactNode; name: string; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener('pointerdown', off, true);
    document.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', off, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [open]);
  return (
    <div className="arr-menu" ref={ref}>
      <button type="button" className={`btn sm ${open ? 'on' : ''}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && (
        <div className="menu arr-pop" role="dialog" aria-label={name}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function pause() {
  if (audioEngine.playing) audioEngine.pause();
}

const nice = (title: string) => title.charAt(0) + title.slice(1).toLowerCase();

function AddPop({ part, shape }: { part: Stretch; shape: FrameShape }) {
  const add = (what: { title: string } | { look: string }, close: () => void) => {
    pause();
    const id = addPop(part, shape, audioEngine.currentTime, what);
    select(`${'look' in what ? 'window' : 'pop'}:${id}`);
    close();
  };
  return (
    <Menu
      name="Add a pop-up"
      label={
        <>
          <Plus width={12} height={12} /> Pop-up
        </>
      }
    >
      {(close) => (
        <>
          <div className="arr-kinds">
            {kindsHere(useStudio.getState()).map((k) => (
              <button type="button" key={k} onClick={() => add({ title: k }, close)}>
                {nice(k)}
              </button>
            ))}
          </div>
          <div className="menu-sep" />
          <label className="arr-field">
            Or a look, playing live
            <select defaultValue="" onChange={(e) => e.target.value && add({ look: e.target.value }, close)}>
              <option value="">Choose a look…</option>
              <LookOptions />
            </select>
          </label>
        </>
      )}
    </Menu>
  );
}

/** the looks a window can play: not footage, drawings, boards or ones that are words */
function LookOptions() {
  const groups = useMemo(() => {
    const ok = allLooks().filter((p) => {
      const d = getScene(p.sceneId);
      return !!d && d.category !== 'board' && !d.showsLyrics && !d.usesClips && !d.usesDrawings && !d.usesFigures;
    });
    const by = new Map<string, { name: string; looks: typeof ok }>();
    for (const p of ok) {
      const fam = familyOf(p);
      const g = by.get(fam.id) ?? { name: fam.name, looks: [] };
      g.looks.push(p);
      by.set(fam.id, g);
    }
    return [...by.values()].sort((x, y) => x.name.localeCompare(y.name));
  }, []);
  return (
    <>
      {groups.map((g) =>
        g.looks.length === 1 ? (
          <option key={g.looks[0].id} value={g.looks[0].id}>
            {g.looks[0].name}
          </option>
        ) : (
          <optgroup key={g.looks[0].id} label={g.name}>
            {g.looks.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </optgroup>
        ),
      )}
    </>
  );
}

function AddDrawing({ part, shape }: { part: Stretch; shape: FrameShape }) {
  const can = useCanDraw();
  const list = useDrawingsHere();
  const place = standsIn(part.index) && !standing(part.index);
  const [inPlace, setInPlace] = useState(true);
  if (!can) return null;
  const add = (d: DrawingAsset, close: () => void) => {
    pause();
    if (place && inPlace) {
      addStanding(part.index, d.id);
      select(`standing:${part.start.toFixed(2)}`);
    } else select(`placed:${addDrawing(part, shape, audioEngine.currentTime, d.id)}`);
    close();
  };
  return (
    <Menu
      name="Add a drawing"
      label={
        <>
          <Plus width={12} height={12} /> Drawing
        </>
      }
    >
      {(close) =>
        list.length ? (
          <>
            {place && (
              <div className="seg full arr-seg" role="group" aria-label="Where it goes">
                <button type="button" className={inPlace ? 'on' : ''} aria-pressed={inPlace} onClick={() => setInPlace(true)}>
                  In the place
                </button>
                <button type="button" className={inPlace ? '' : 'on'} aria-pressed={!inPlace} onClick={() => setInPlace(false)}>
                  Over the picture
                </button>
              </div>
            )}
            <div className="arr-draws">
              {list.map((d) => (
                <button type="button" key={d.id} onClick={() => add(d, close)} title={d.name}>
                  <DrawThumb d={d} replay={0} />
                  <span>{d.name}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="menu-foot">This song has no drawings yet. The Video tab’s Drawings makes them.</p>
        )
      }
    </Menu>
  );
}

/* ───────── the thing taken hold of ───────── */

function Selected({ it, part, shape }: { it: Item; part: Stretch; shape: FrameShape }) {
  const drawings = useDrawingsHere();
  const s = useStudio.getState();
  const pop = it.kind === 'pop' || it.kind === 'window';
  const placed = it.kind === 'placed' ? s.placed.drawings.find((d) => d.id === it.ref) : null;
  const d = it.kind === 'standing' ? standing(part.index, s) : null;
  const drawing = drawingNow(placed?.drawing ?? d?.id ?? '', drawings)?.id ?? '';
  return (
    <div className="arrbar-sel">
      {pop && (
        <>
          <select
            aria-label="What it shows"
            value={it.kind === 'pop' ? `t:${it.name}` : ''}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              swapPop(part, shape, it.ref, v.startsWith('t:') ? { title: v.slice(2) } : { look: v });
              select(`${v.startsWith('t:') ? 'pop' : 'window'}:${it.ref}`);
            }}
          >
            {it.kind === 'window' && <option value="">{it.name}</option>}
            <optgroup label="Instruments">
              {kindsHere(s).map((k) => (
                <option key={k} value={`t:${k}`}>
                  {nice(k)}
                </option>
              ))}
              {it.kind === 'pop' && !kindsHere(s).includes(it.name) && <option value={`t:${it.name}`}>{nice(it.name)}</option>}
            </optgroup>
            <LookOptions />
          </select>
          <button type="button" className="btn sm" onClick={() => restylePop(part, shape, it.ref)} title={it.kind === 'window' ? 'The next way to frame it' : 'The next kind of title bar'}>
            {it.kind === 'window' ? 'Frame' : 'Bar'}
          </button>
        </>
      )}
      {(placed || d) && (
        <select aria-label="Which drawing" value={drawing} onChange={(e) => (placed ? swapDrawing(placed.id, e.target.value) : swapStanding(part.index, e.target.value))}>
          {!drawing && <option value="">{it.name}</option>}
          {drawings.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      )}
      {d && (
        <>
          <select aria-label="Where it stands" value={d.put} onChange={(e) => putStanding(part.index, e.target.value as HandPut)}>
            {HAND_PUTS.map((x) => (
              <option key={x} value={x}>
                {PUT_NAMES[x]}
              </option>
            ))}
          </select>
          <select aria-label="How it arrives" value={d.enter} onChange={(e) => enterStanding(part.index, e.target.value as DrawnEnter)}>
            <option value="draw">Draws itself</option>
            <option value="rise">Rises</option>
            <option value="there">Is there</option>
          </select>
        </>
      )}
      {placed && (
        <select aria-label="How it arrives" value={placed.enter} onChange={(e) => enterDrawing(placed.id, e.target.value as 'draw' | 'there')}>
          <option value="draw">Draws itself</option>
          <option value="there">Is there</option>
        </select>
      )}
      <Size it={it} part={part} />
      {pop && it.hand && (
        <button type="button" className="btn sm ghost" onClick={() => loosenPop(part, shape, it.ref, true)} title="It stays here now. Let it step aside when words need the room.">
          Give way to words
        </button>
      )}
      {d?.spots && (
        <button type="button" className="btn sm ghost" onClick={() => looseStanding(part.index)} title="Let the shot find it a place again">
          Auto place
        </button>
      )}
      {it.kind === 'beside' && <span className="arrbar-note">Move it, and it stays where you put it.</span>}
      <button type="button" className="btn icon sm ghost" onClick={() => removeItem(it, part)} aria-label={`Take out ${it.name}`} title="Take it out (Delete)">
        <Trash width={14} height={14} />
      </button>
    </div>
  );
}

function Size({ it, part }: { it: Item; part: Stretch }) {
  const [held, setHeld] = useState<number | null>(null);
  const t = thingsNow().find((x) => x.key === it.key);
  const [lo, hi] = sizesOf(it.kind);
  const spot: Spot | null = t?.spot ?? it.spot;
  if (!spot || !t) return null;
  // what a hand would call twice as big is as far along the slider wherever it starts
  const along = (v: number) => Math.log(v / lo) / Math.log(hi / lo);
  const v = held ?? along(clampTo([lo, hi], spot.size));
  const done = (x: number) => {
    setHeld(null);
    commitSpot(t, part, { ...spot, size: lo * (hi / lo) ** x });
  };
  return (
    <label className="arr-size">
      Size
      <input type="range" min={0} max={1} step={0.01} value={v} onChange={(e) => setHeld(Number(e.target.value))} onPointerUp={(e) => held !== null && done(Number(e.currentTarget.value))} onKeyUp={(e) => held !== null && done(Number(e.currentTarget.value))} />
    </label>
  );
}

/* ───────── the part in time ───────── */

interface Pulling {
  it: Item;
  edge: 'move' | 'from' | 'to';
  x: number;
  from: number;
  to: number;
  moved: boolean;
}

/** rows with nothing over anything else */
function rows(items: Item[]): Item[][] {
  const out: Item[][] = [];
  for (const it of [...items].sort((p, q) => p.from - q.from)) {
    const row = out.find((r) => r[r.length - 1].to <= it.from + 0.01);
    if (row) row.push(it);
    else out.push([it]);
  }
  return out;
}

const LEAST = 0.4;

function Lane({ part, shape, items }: { part: Stretch; shape: FrameShape; items: Item[] }) {
  const sel = useArrange((s) => s.sel);
  const a = useStudio((s) => s.analysis)!;
  const ref = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLElement>(null);
  const pulling = useRef<Pulling | null>(null);
  const [held, setHeld] = useState<{ key: string; from: number; to: number } | null>(null);
  const len = Math.max(0.1, part.end - part.start);
  useEffect(
    () =>
      onFrame(() => {
        const k = (audioEngine.currentTime - part.start) / len;
        if (head.current) head.current.style.left = `${clampTo([0, 1], k) * 100}%`;
      }),
    [part.start, len],
  );
  const spb = 60 / clampTo([50, 200], a.bpm || 120);
  const beats = useMemo(() => {
    const out: { t: number; bar: boolean }[] = [];
    const first = snapToBeat(a, part.start);
    for (let k = 0; first + k * spb < part.end && k < 400; k++) {
      const t = first + k * spb;
      if (t > part.start + 0.02) out.push({ t, bar: Math.round(t / spb) % 4 === 0 });
    }
    return out;
  }, [a, part.start, part.end, spb]);
  const at = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return part.start + clampTo([0, 1], (clientX - r.left) / r.width) * len;
  };
  const snap = (t: number) => {
    const b = snapToBeat(a, t);
    const near = [b, part.start, part.end].sort((p, q) => Math.abs(p - t) - Math.abs(q - t))[0];
    return clampTo([part.start, part.end], near);
  };

  const begin = (e: ReactPointer, it: Item, edge: Pulling['edge']) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    select(it.key);
    pause();
    if (it.kind === 'standing') return;
    pulling.current = { it, edge, x: e.clientX, from: Math.max(part.start, it.from), to: Math.min(part.end, it.to), moved: false };
    ref.current!.setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointer) => {
    const p = pulling.current;
    if (!p) return;
    if (!p.moved && Math.abs(e.clientX - p.x) < 4) return;
    p.moved = true;
    const d = ((e.clientX - p.x) / ref.current!.getBoundingClientRect().width) * len;
    let { from, to } = p;
    if (p.edge === 'move') {
      const f = clampTo([part.start, Math.max(part.start, part.end - (to - from))], snap(from + d));
      to = f + (to - from);
      from = f;
    } else if (p.edge === 'from') from = Math.min(to - LEAST, snap(from + d));
    else to = Math.max(from + LEAST, snap(to + d));
    setHeld({ key: p.it.key, from: Math.max(part.start, from), to: Math.min(part.end, to) });
  };
  const end = () => {
    const p = pulling.current;
    pulling.current = null;
    if (p?.moved && held) {
      if (p.it.kind === 'placed') timeDrawing(p.it.ref, held.from, held.to);
      else timePop(part, shape, p.it.ref, held.from, held.to);
    }
    // taken hold of where it can be seen
    const it = held ?? p?.it;
    const t = audioEngine.currentTime;
    if (it && (t < it.from + 0.15 || t >= it.to - 0.02)) audioEngine.seek(Math.min(it.from + 0.4, (it.from + it.to) / 2));
    setHeld(null);
  };

  const rs = rows(items);
  return (
    <div className="arr-lane-wrap">
      <div
        className="arr-lane"
        ref={ref}
        style={{ height: Math.max(1, rs.length) * 24 + 10 }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          audioEngine.seek(at(e.clientX));
        }}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={() => {
          pulling.current = null;
          setHeld(null);
        }}
      >
        {beats.map((b) => (
          <i key={b.t} className={`arr-beat ${b.bar ? 'bar' : ''}`} style={{ left: `${((b.t - part.start) / len) * 100}%` }} aria-hidden />
        ))}
        {rs.map((row, r) =>
          row.map((it) => {
            const from = held?.key === it.key ? held.from : Math.max(part.start, it.from);
            const to = held?.key === it.key ? held.to : Math.min(part.end, it.to);
            return (
              <div
                key={it.key}
                role="button"
                tabIndex={0}
                className={`arr-item ${it.kind} ${sel === it.key ? 'sel' : ''} ${it.hand ? 'hand' : ''}`}
                aria-pressed={sel === it.key}
                style={{ left: `${((from - part.start) / len) * 100}%`, width: `${((to - from) / len) * 100}%`, top: 5 + r * 24 }}
                title={it.kind === 'standing' ? `${it.name}: in the place for the whole part` : `${it.name}: drag to move it in time, drag an end to make it longer or shorter`}
                onPointerDown={(e) => begin(e, it, 'move')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') select(it.key);
                }}
              >
                {it.kind !== 'standing' && <i className="arr-end l" onPointerDown={(e) => begin(e, it, 'from')} aria-hidden />}
                <span>{it.kind === 'pop' ? nice(it.name) : it.name}</span>
                {it.kind !== 'standing' && <i className="arr-end r" onPointerDown={(e) => begin(e, it, 'to')} aria-hidden />}
              </div>
            );
          }),
        )}
        {!items.length && <span className="arr-lane-none">No pop-ups or drawings in this part</span>}
        <i className="arr-head" ref={head} aria-hidden />
      </div>
    </div>
  );
}

/** the button that opens it */
export function ArrangeButton({ label = false }: { label?: boolean }) {
  const on = useArrange((s) => s.on);
  const hasPlan = useStudio((s) => s.planOn && !!s.plan && !!s.analysis && !s.clip);
  const phone = useLayout((s) => s.phone);
  if (!hasPlan) return null;
  return (
    <button type="button" className={`btn sm ${label || phone || on ? '' : 'has-tip'} ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => (on ? closeArrange() : openArrange())} data-tip="Move, resize, swap, time and remove the pop-ups and drawings on the picture">
      Arrange
    </button>
  );
}


/** the Part tab's way in: to the part, and what is on it */
export function ArrangeHere({ part }: { part: number }) {
  useArrange((s) => s.on);
  useStudio((s) => s.planOn);
  if (!canArrange()) return null;
  return (
    <button
      type="button"
      className="btn sm"
      onClick={() => {
        const a = useStudio.getState().analysis;
        if (a && partAt(audioEngine.currentTime)?.index !== part) audioEngine.seek(a.sections[part].start + 0.03);
        openArrange();
      }}
    >
      Arrange on the picture
    </button>
  );
}
