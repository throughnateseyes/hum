/**
 * The timeline: the song's parts with the shots inside each one, the waveform under them and one
 * playhead through both.
 *
 * A part is labelled above its shots. Each shot is the look on screen from one cut to the next (the
 * sequencer's own shots, plan.ts planShots, the opening interlude included): its picture and name when
 * there is room, only the picture when it's narrow, a plain tick when it's very narrow, and a tooltip
 * always.
 *
 *   click            pick a part (the Part tab comes forward; the song doesn't move)
 *   ⌘/Ctrl-click     add or take away a part      Shift-click   pick the run between
 *   double-click     play the part                Esc / click an empty spot   pick nothing
 *   right-click      the part menu: split, combine, play from here, swap, hand-drawn, pop-ups, reset
 *   C or ✂           the split tool: a guide follows the pointer, a click splits on the nearest beat
 *   ⌘/Ctrl+J         combine the picked parts (or the picked part with the next one)
 *   drag a look      from the Library onto a part (onto any picked part: all the picked parts)
 *
 * On a phone a tap opens the part sheet (PartSheet.tsx) instead.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { audioEngine } from '../audio/engine';
import type { Preset, TrackAnalysis } from '../core/types';
import { presetToLook } from '../presets/apply';
import { onFrame } from '../state/live';
import { combineParts, combineRun, playFrom, playPart, resetParts, setPartsHand, setPartsLook, setPartsPops, splitPartAt, splitPoint } from '../state/partEdit';
import { assignLook, findLook, partEdits, planShots, sectionIndexAt, sectionNames, shotIndexAt, validPlan, type Shot } from '../state/plan';
import { useStudio } from '../state/store';
import { noteHandPick } from '../state/taste';
import { ContextMenu, MOD, type MenuItem } from './ContextMenu';
import { Plus } from './Icons';
import { LOOK_MIME, STATIC_THUMBS } from './Library';
import { useLayout } from './layout';
import { togglePartSheet } from './PartSheet';
import { peekHandlers } from './Peek';
import { RangeOverlay, useRenderMode } from './RenderBar';
import { GROUP_INK, dropList, fmtTime, lookBg } from './song';
import './timeline.css';

/** the split tool (the blade) is on */
export const useTimelineTool = create<{ blade: boolean }>(() => ({ blade: false }));
export const toggleBlade = (on?: boolean) => useTimelineTool.setState((s) => ({ blade: on ?? !s.blade }));

/** what a cut lands on, in plain words (shot tooltips) */
const CUT_ON: Record<Shot['on'], string> = {
  section: 'opens the part',
  interlude: 'opens the part for a few bars',
  phrase: 'cut on the phrase',
  hit: 'cut on a hit',
  drop: 'cut on a drop',
  vocal: 'cut as the voice comes in',
  lyric: 'cut on a new lyric line',
  resolve: 'cut as the chords come home',
};

const NO_SHOTS: Shot[] = [];

/** a time with tenths, for the split guide: 0:42.3 */
const fmtFine = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

/** the part last clicked without Shift: where a Shift-click run starts */
let anchor: number | null = null;

/** pick parts on the timeline; the Part tab comes forward when there are any */
function pickParts(sel: number[]) {
  const s = useStudio.getState();
  s.set(sel.length ? { selectedParts: sel, inspectorTab: 'part' } : { selectedParts: [] });
}

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

interface MenuAt {
  x: number;
  y: number;
  /** the song time under the pointer */
  t: number;
  part: number;
  shot: Shot | null;
}

export function Timeline({ side }: { side?: React.ReactNode }) {
  const track = useStudio((s) => s.track);
  const analysis = useStudio((s) => s.analysis);
  const analyzing = useStudio((s) => s.analyzing);
  const plan = useStudio((s) => s.plan);
  const renderOn = useRenderMode((s) => s.on);
  const blade = useTimelineTool((s) => s.blade);
  const phone = useLayout((s) => s.phone);
  const canvas = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const lane = useRef<HTMLDivElement>(null);
  const [laneW, setLaneW] = useState(600);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const secs = analysis?.sections ?? [];
  const hasPlan = validPlan(plan, analysis);
  const canEdit = hasPlan && !phone && !renderOn;

  useLayoutEffect(() => {
    const el = lane.current!;
    const ro = new ResizeObserver(() => setLaneW(el.clientWidth));
    ro.observe(el);
    setLaneW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // the waveform's size comes from a ResizeObserver, so the frame loop never reads layout
  const waveSize = useRef({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ro = new ResizeObserver(() => (waveSize.current = { w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    waveSize.current = { w: el.clientWidth, h: el.clientHeight };
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let lastLeft = '';
    let lastShow = '';
    return onFrame(() => {
      const f = audioEngine.frame;
      const d = analysis?.duration || f.duration;
      const t = audioEngine.kind === 'mic' ? 0 : audioEngine.currentTime;
      drawWave(canvas.current, waveSize.current, analysis, t, d);
      const el = head.current;
      if (el) {
        const show = d > 0 && audioEngine.kind !== 'mic' ? '' : 'none';
        const left = `${d > 0 ? Math.round((t / d) * 10000) / 100 : 0}%`;
        if (show !== lastShow) el.style.display = lastShow = show;
        if (left !== lastLeft) el.style.left = lastLeft = left;
      }
    });
  }, [analysis]);

  // the tool and the picked parts go when they no longer make sense
  useEffect(() => {
    if (!canEdit) toggleBlade(false);
  }, [canEdit]);

  // Esc leaves the split tool, then picks nothing; C is the split tool; ⌘/Ctrl+J combines
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typing(e.target) || useStudio.getState().perform) return;
      const s = useStudio.getState();
      if (e.key === 'Escape') {
        if (useTimelineTool.getState().blade) toggleBlade(false);
        else if (s.selectedParts.length) pickParts([]);
        else return;
        e.preventDefault();
      } else if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (!canEdit) return;
        e.preventDefault();
        toggleBlade();
      } else if ((e.key === 'j' || e.key === 'J') && (e.metaKey || e.ctrlKey) && !e.altKey) {
        if (!canEdit || !s.selectedParts.length) return;
        e.preventDefault();
        combineParts(s.selectedParts);
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [canEdit]);

  const timeAt = (clientX: number) => {
    const r = lane.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (analysis?.duration ?? 0);
  };

  const seek = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const d = audioEngine.frame.duration;
    if (d) audioEngine.seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d);
  };

  const openMenu = (e: React.MouseEvent) => {
    if (!analysis || !secs.length || phone || renderOn) return;
    e.preventDefault();
    const t = timeAt(e.clientX);
    const part = sectionIndexAt(secs, t);
    const shots = hasPlan ? planShots(plan!, analysis, useStudio.getState().pace, useStudio.getState().lyrics) : [];
    const k = shotIndexAt(shots, t);
    const shot = shots[k]?.section === part ? shots[k] : null;
    // right-click a part that isn't picked: it becomes the pick (as in a file list)
    if (!useStudio.getState().selectedParts.includes(part)) {
      anchor = part;
      useStudio.getState().set({ selectedParts: [part] });
    }
    setMenu({ x: e.clientX, y: e.clientY, t, part, shot });
  };
  const closeMenu = useCallback(() => setMenu(null), []);

  // the split guide: where a split would land (on the beat), while the tool is on or the menu is open
  const guideT = menu ? menu.t : blade ? hover : null;
  const guide = guideT !== null && analysis ? splitPoint(guideT) : null;

  const drops = analysis ? dropList(analysis) : [];

  return (
    <div className={`tl tln ${blade ? 'blade' : ''}`}>
      <div className="tln-tools">
        <button
          className={`tln-tool has-tip ${blade ? 'on' : ''}`}
          aria-pressed={blade}
          aria-label="Split tool"
          disabled={!canEdit}
          data-tip={blade ? 'Split tool is on: click a part to cut it in two on the beat. Esc or click here to stop. (C)' : hasPlan ? 'Split tool: click a part to cut it in two on the beat (C)' : 'Make a video first, then you can split its parts'}
          onClick={() => toggleBlade()}
        >
          <Scissors />
        </button>
      </div>
      <div
        className="tl-lane"
        ref={lane}
        onContextMenu={openMenu}
        onPointerMove={(e) => blade && setHover(timeAt(e.clientX))}
        onPointerLeave={() => setHover(null)}
      >
        {analysis && secs.length > 0 ? (
          <PartsRow a={analysis} laneW={laneW} blade={blade} quiet={!!menu} onSplit={(x) => splitPartAt(timeAt(x))} onMenu={openMenu} />
        ) : (
          <div className="tln-parts tl-placeholder">
            {!track
              ? 'Drop a song anywhere, or pick a demo. Its parts show up here.'
              : track.source === 'mic'
                ? 'Live input: parts and looks need a song file'
                : analyzing
                  ? 'Listening to the song…'
                  : 'No parts found in this song'}
          </div>
        )}
        <div className="tl-wave" onPointerDown={seek} onPointerMove={(e) => e.buttons & 1 && seek(e)} title="Click or drag to move through the song">
          <canvas ref={canvas} />
          {analysis &&
            drops.map((d, i) => (
              <button
                key={i}
                className={`tl-drop ${d.strength >= 0.7 ? 'big' : ''}`}
                style={{ left: `${(d.t / analysis.duration) * 100}%`, ['--s' as string]: String(0.35 + 0.65 * d.strength) }}
                title={`Drop at ${fmtTime(d.t)} · strength ${Math.round(d.strength * 100)}%${d.why ? ` · ${d.why}` : ''}`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  audioEngine.seek(Math.max(0, d.t - 0.01));
                }}
              />
            ))}
        </div>
        <div className="tl-head" ref={head} />
        {guide && analysis && (
          <div className={`tln-guide ${guide.ok ? '' : 'no'}`} style={{ left: `${(guide.t / analysis.duration) * 100}%` }} aria-hidden>
            <span>{guide.ok ? fmtFine(guide.t) : (guide.why ?? '')}</span>
          </div>
        )}
        {renderOn && analysis && secs.length > 0 && <RangeOverlay a={analysis} />}
      </div>
      {side && <div className="tl-side">{side}</div>}
      {menu && analysis && <PartMenu at={menu} a={analysis} onClose={closeMenu} />}
    </div>
  );
}

/* ───────── the parts and their shots ───────── */

/** what a look being dragged from the library would do if dropped here */
function useDraggedLook() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    const start = (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (dt?.types.includes(LOOK_MIME)) setId(dt.getData(LOOK_MIME) || null);
    };
    const end = () => setId(null);
    window.addEventListener('dragstart', start);
    window.addEventListener('dragend', end);
    window.addEventListener('drop', end);
    return () => {
      window.removeEventListener('dragstart', start);
      window.removeEventListener('dragend', end);
      window.removeEventListener('drop', end);
    };
  }, []);
  return id;
}

function PartsRow({ a, laneW, blade, quiet, onSplit, onMenu }: { a: TrackAnalysis; laneW: number; blade: boolean; quiet: boolean; onSplit: (clientX: number) => void; onMenu: (e: React.MouseEvent) => void }) {
  const plan = useStudio((s) => s.plan);
  const pace = useStudio((s) => s.pace);
  const lyrics = useStudio((s) => s.lyrics);
  const selected = useStudio((s) => s.selectedParts);
  const partPops = useStudio((s) => s.partPops);
  const partHand = useStudio((s) => s.partHand);
  const partWords = useStudio((s) => s.partWords);
  const phone = useLayout((s) => s.phone);
  useStudio((s) => s.customPresets.length);
  const dragId = useDraggedLook();
  const [over, setOver] = useState<{ i: number; alt: boolean } | null>(null);
  const partEls = useRef<(HTMLDivElement | null)[]>([]);
  const shotEls = useRef<(HTMLSpanElement | null)[]>([]);
  const secs = a.sections;
  const names = sectionNames(secs);
  const hasPlan = validPlan(plan, a);
  const looks = secs.map((_, i) => (hasPlan ? (plan.looks[i] ?? null) : null));
  const shots = hasPlan ? planShots(plan, a, pace, lyrics) : NO_SHOTS;
  const dragLook = dragId ? findLook(dragId) : undefined;
  const dragging = !!dragId;
  const edits = partEdits(plan, a, partPops, partHand, partWords);
  const n = secs.length;

  // the part and the shot playing now
  useEffect(
    () =>
      onFrame(() => {
        const t = audioEngine.currentTime;
        const i = sectionIndexAt(secs, t);
        partEls.current.forEach((el, j) => el?.classList.toggle('now', j === i));
        const k = shots.length ? shotIndexAt(shots, t) : -1;
        shotEls.current.forEach((el, j) => el?.classList.toggle('now', j === k));
      }),
    [secs, shots],
  );

  useEffect(() => {
    if (!dragging) setOver(null);
  }, [dragging]);

  // a drop onto a picked part goes into every picked part; otherwise as assignLook does it: the target,
  // the parts that sound alike and share its look, and every empty part
  const multi = !!over && selected.length > 1 && selected.includes(over.i);
  const affected = (j: number) => {
    if (!over) return false;
    const i = over.i;
    if (multi) return selected.includes(j);
    if (j === i) return true;
    if (!looks[j]) return true;
    return !over.alt && secs[j].group === secs[i].group && looks[j] === looks[i];
  };
  const others = over ? secs.map((_, j) => j).filter((j) => j !== over.i && affected(j)) : [];
  const fills = multi ? 0 : others.filter((j) => !looks[j]).length;
  const alike = others.length - fills;

  const click = (e: React.MouseEvent, i: number) => {
    if (blade) {
      onSplit(e.clientX);
      return;
    }
    if (phone) {
      togglePartSheet(i);
      return;
    }
    const cur = useStudio.getState().selectedParts;
    let sel: number[];
    if (e.metaKey || e.ctrlKey) {
      sel = cur.includes(i) ? cur.filter((j) => j !== i) : [...cur, i];
      anchor = i;
    } else if (e.shiftKey && anchor !== null && anchor < n) {
      const [lo, hi] = anchor < i ? [anchor, i] : [i, anchor];
      sel = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
    } else {
      sel = [i];
      anchor = i;
    }
    pickParts(sel);
  };

  return (
    <div
      className={`tln-parts ${dragging ? 'dragging' : ''}`}
      onClick={(e) => {
        // a click between parts picks nothing
        if (e.target === e.currentTarget && !blade) pickParts([]);
      }}
    >
      {secs.map((sec, i) => {
        const look = findLook(looks[i]);
        const len = sec.end - sec.start;
        const px = (len / a.duration) * laneW;
        const size = px < 44 ? 'tiny' : px < 96 ? 'small' : '';
        const why = hasPlan ? (plan.why[i] ?? '') : '';
        const g = sec.group % GROUP_INK.length;
        const preview = over && dragLook && affected(i) ? dragLook : undefined;
        const mine = shots.map((sh, k) => ({ sh, k })).filter((x) => x.sh.section === i);
        const isSel = selected.includes(i);
        const hand = partHand?.length === n ? partHand[i] : null;
        const inter = mine.find((x) => x.sh.on === 'interlude');
        return (
          <div
            key={`${i}:${sec.start}`}
            ref={(el) => {
              partEls.current[i] = el;
            }}
            role="button"
            tabIndex={0}
            aria-pressed={isSel}
            className={`tln-part ${look || preview ? 'has-look' : 'no-look'} ${size} ${isSel ? 'sel' : ''} ${preview ? 'preview' : ''} ${over?.i === i ? 'over' : ''} ${edits[i] ? 'edited' : ''}`}
            style={{ left: `${(sec.start / a.duration) * 100}%`, width: `${(len / a.duration) * 100}%` }}
            data-part={i}
            aria-label={`${names[i]}, ${fmtTime(sec.start)} to ${fmtTime(sec.end)}, ${look ? look.name : 'no look yet'}${mine.length > 1 ? `, ${mine.length} shots` : ''}`}
            title={
              size === 'tiny' || !hasPlan
                ? `${names[i]} · ${fmtTime(sec.start)}–${fmtTime(sec.end)} · ${look ? look.name : 'no look yet'}${edits[i] ? ' · changed by you' : ''}${why ? ` · ${why}` : ''}`
                : undefined
            }
            onClick={(e) => click(e, i)}
            onDoubleClick={() => !blade && !phone && playPart(i)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                click(e as unknown as React.MouseEvent, i);
              } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
                e.preventDefault();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                onMenu({ clientX: r.left + r.width / 2, clientY: r.top + 8, preventDefault: () => {} } as React.MouseEvent);
              }
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(LOOK_MIME)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              if (over?.i !== i || over.alt !== e.altKey) setOver({ i, alt: e.altKey });
            }}
            onDragLeave={(e) => {
              if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver((o) => (o?.i === i ? null : o));
            }}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const id = e.dataTransfer.getData(LOOK_MIME);
              if (!id) return;
              const sel = useStudio.getState().selectedParts;
              if (sel.length > 1 && sel.includes(i)) {
                setPartsLook(sel, id);
                return;
              }
              const placed = findLook(id);
              if (placed) noteHandPick(placed, 'place', sec.label);
              assignLook(i, id, !e.altKey);
            }}
          >
            <span className="tln-label">
              <i style={{ background: GROUP_INK[g] }} />
              {size !== 'tiny' && <b>{names[i]}</b>}
              {size === '' && hand !== null && <HandMark on={hand} />}
              {edits[i] && <span className="tln-edit" aria-label="changed by you" />}
            </span>
            <span className="tln-shots" style={look && !preview ? lookBg(look) : preview ? lookBg(preview) : undefined}>
              {preview ? (
                <span className="tln-shot full">
                  <span className="tln-sname">{preview.name}</span>
                </span>
              ) : mine.length ? (
                mine.map(({ sh, k }, m) => {
                  const end = mine[m + 1]?.sh.t ?? sec.end;
                  const p = findLook(sh.lookId);
                  const w = ((end - sh.t) / a.duration) * laneW;
                  const mode = w >= 72 ? 'full' : w >= 16 ? 'pic' : 'tick';
                  const tip = `${p?.name ?? 'A look'} · ${fmtTime(sh.t)}–${fmtTime(end)} · ${CUT_ON[sh.on]}`;
                  return (
                    <span
                      key={k}
                      ref={(el) => {
                        shotEls.current[k] = el;
                      }}
                      className={`tln-shot ${mode} ${sh.on === 'interlude' ? 'inter' : ''}`}
                      style={{ left: `${((sh.t - sec.start) / len) * 100}%`, width: `${((end - sh.t) / len) * 100}%` }}
                      title={tip}
                      {...(p && !dragging && !blade && !quiet && !phone ? shotPeek(p, names[i], tip) : {})}
                    >
                      {mode !== 'tick' && p && <span className="tln-pic" style={lookBg(p)} />}
                      {mode === 'full' && p && <span className="tln-sname">{p.name}</span>}
                    </span>
                  );
                })
              ) : (
                <span className="tln-empty">
                  <Plus width={11} height={11} />
                  {size === 'tiny' ? '' : dragging ? 'Drop a look' : size ? 'Empty' : 'No look yet'}
                </span>
              )}
            </span>
            {inter && size === '' && !preview && <span className="tln-sr">{`Opens with ${findLook(inter.sh.lookId)?.name ?? 'a board'}`}</span>}
          </div>
        );
      })}
      {over && dragLook && (
        <div className="tl-droptip" style={{ left: `${(((secs[over.i].start + secs[over.i].end) / 2) / a.duration) * 100}%` }}>
          <b>{dragLook.name}</b> → {multi ? `${selected.length} picked parts` : names[over.i]}
          {alike > 0 && !multi && <span>+ {alike === 1 ? 'the part like it' : `${alike} parts like it`}</span>}
          {fills > 0 && <span>+ fills {fills === 1 ? 'the empty part' : `${fills} empty parts`}</span>}
          {!over.alt && alike > 0 && !multi && <em>hold ⌥ for just this part</em>}
        </div>
      )}
    </div>
  );
}

/** hover a shot: a live preview of its look over the timeline */
function shotPeek(p: Preset, part: string, tip: string) {
  return peekHandlers({
    key: `shot:${part}:${p.id}`,
    title: `${part} · ${p.name}`,
    hint: `${tip.split(' · ').slice(1).join(' · ')}. Click to pick the part, double-click to play it, right-click for more.`,
    poster: STATIC_THUMBS[p.id],
    place: 'above',
    getLook: () => (useStudio.getState().presetId === p.id ? null : presetToLook(p)),
  });
}

/** a part drawn by hand (or kept clean of it) on its own: a small pencil, struck out for off */
function HandMark({ on }: { on: boolean }) {
  return (
    <svg className="tln-hand" width="11" height="11" viewBox="0 0 12 12" aria-label={on ? 'Hand-drawn on' : 'Hand-drawn off'}>
      <title>{on ? 'Hand-drawn in this part' : 'No hand-drawn in this part'}</title>
      <path d="M2 10l.6-2.4L8.2 2l1.8 1.8-5.6 5.6L2 10z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      {!on && <path d="M1.5 1.5l9 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />}
    </svg>
  );
}

function Scissors() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
      <circle cx="4" cy="4.5" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4" cy="11.5" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.8 5.7L14 12.5M5.8 10.3L14 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/* ───────── the right-click menu ───────── */

function PartMenu({ at, a, onClose }: { at: MenuAt; a: TrackAnalysis; onClose: () => void }) {
  const s = useStudio.getState();
  const plan = s.plan;
  const hasPlan = validPlan(plan, a);
  const names = sectionNames(a.sections);
  const n = a.sections.length;
  const sel = s.selectedParts.includes(at.part) ? [...s.selectedParts].sort((x, y) => x - y) : [at.part];
  const many = sel.length > 1;
  const who = many ? `these ${sel.length} parts` : names[at.part];
  const noPlan = 'Make a video first';
  const split = splitPoint(at.t);
  const run = combineRun(sel);
  const edits = partEdits(plan, a);
  const hand = sel.map((j) => (s.partHand?.length === n ? (s.partHand[j] ?? null) : null));
  const pops = sel.map((j) => (s.partPops?.length === n ? (s.partPops[j] ?? null) : null));
  const all = <T,>(vals: T[], v: T) => vals.every((x) => x === v);
  const shotLook = at.shot ? findLook(at.shot.lookId) : undefined;

  const items: MenuItem[] = [
    { kind: 'label', label: `${many ? `${sel.length} parts` : names[at.part]}${shotLook ? ` · ${shotLook.name}` : ''} · ${fmtFine(at.t)}` },
    {
      label: 'Split here',
      hint: split.ok ? `Cut ${names[split.i]} in two at ${fmtFine(split.t)}, on the beat` : (split.why ?? ''),
      shortcut: 'C',
      disabled: !split.ok,
      onSelect: () => splitPartAt(at.t),
    },
  ];
  if (many) {
    items.push({
      label: `Combine ${sel.length} parts`,
      hint: run ? `Make them one part with ${names[run[0]]}’s look` : 'Only parts side by side can be combined',
      shortcut: `${MOD}J`,
      disabled: !hasPlan || !run,
      onSelect: () => combineParts(sel),
    });
  } else {
    const i = at.part;
    items.push(
      {
        label: 'Combine with the next part',
        hint: !hasPlan ? noPlan : i + 1 < n ? `Join ${names[i + 1]} onto ${names[i]}` : 'This is the last part',
        shortcut: `${MOD}J`,
        disabled: !hasPlan || i + 1 >= n,
        onSelect: () => combineParts([i, i + 1]),
      },
      {
        label: 'Combine with the previous part',
        hint: !hasPlan ? noPlan : i > 0 ? `Join ${names[i]} onto ${names[i - 1]}` : 'This is the first part',
        disabled: !hasPlan || i === 0,
        onSelect: () => combineParts([i - 1, i]),
      },
    );
  }
  items.push(
    { kind: 'sep' },
    { label: 'Play from here', hint: `Play the song from ${fmtFine(at.t)} (double-click a part plays it from its start)`, onSelect: () => playFrom(at.t) },
    {
      label: 'Swap look…',
      hint: hasPlan ? `Pick another look for ${who} in the Part tab` : noPlan,
      disabled: !hasPlan,
      onSelect: () => pickParts(sel),
    },
    {
      label: 'Hand-drawn',
      hint: !hasPlan ? noPlan : all(hand, null) ? 'As the video' : all(hand, true) ? 'On here' : all(hand, false) ? 'Off here' : 'Mixed',
      disabled: !hasPlan,
      submenu: [
        { label: 'As the video', hint: 'Hand-drawn when the whole video is', checked: all(hand, null), onSelect: () => setPartsHand(sel, null) },
        { label: 'On', hint: `Draw ${who} by hand`, checked: all(hand, true), onSelect: () => setPartsHand(sel, true) },
        { label: 'Off', hint: `Keep ${who} clean`, checked: all(hand, false), onSelect: () => setPartsHand(sel, false) },
      ],
    },
    {
      label: 'Pop-ups',
      hint: !hasPlan ? noPlan : all(pops, null) ? 'Auto' : all(pops, 0) ? 'Off here' : all(pops, 1) ? 'A few here' : pops.every((v) => v !== null && v >= 2) ? 'Lots here' : 'Mixed',
      disabled: !hasPlan,
      submenu: [
        { label: 'Auto', hint: 'As many as the plan gives', checked: all(pops, null), onSelect: () => setPartsPops(sel, null) },
        { label: 'Off', hint: 'No pop-up windows', checked: all(pops, 0), onSelect: () => setPartsPops(sel, 0) },
        { label: 'Few', hint: 'A window now and then', checked: all(pops, 1), onSelect: () => setPartsPops(sel, 1) },
        { label: 'Lots', hint: 'Windows on the beats and the drop', checked: pops.every((v) => v !== null && v >= 2), onSelect: () => setPartsPops(sel, 3) },
      ],
    },
    { kind: 'sep' },
    {
      label: many ? 'Reset these parts' : 'Reset this part',
      hint: sel.some((j) => edits[j]) ? 'Put back what the plan picked' : 'Nothing changed here yet',
      disabled: !hasPlan || !sel.some((j) => edits[j]),
      onSelect: () => resetParts(sel),
    },
  );
  return <ContextMenu x={at.x} y={at.y} items={items} label={`${who} menu`} onClose={onClose} />;
}

/* ───────── the waveform ───────── */

/** the song's waveform drawn once per size in both colours (played, still to come), see drawWave */
let waveCache: { a: TrackAnalysis; w: number; h: number; dpr: number; played: HTMLCanvasElement; ahead: HTMLCanvasElement; px: number } | null = null;

function waveLayer(a: TrackAnalysis, w: number, h: number, dpr: number, color: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const ov = a.overview;
  const mid = h / 2;
  g.fillStyle = color;
  for (let x = 0; x < w; x += 2) {
    const i0 = Math.floor((x / w) * ov.length);
    const i1 = Math.max(i0 + 1, Math.floor(((x + 2) / w) * ov.length));
    let v = 0;
    for (let i = i0; i < i1 && i < ov.length; i++) v = Math.max(v, ov[i]);
    const hh = Math.max(0.5, v * (h * 0.44));
    g.fillRect(x, mid - hh, 1.4, hh * 2);
  }
  // part boundaries
  g.fillStyle = 'rgba(23,23,26,0.12)';
  for (const s of a.sections.slice(1)) g.fillRect(Math.round((s.start / a.duration) * w), 0, 1, h);
  return c;
}

/**
 * The timeline waveform. For a song it's two pictures made once per size (the played part dark, the
 * rest light), and each frame only copies them in when the playhead has moved a pixel, so a playing
 * song costs almost nothing here. Before analysis it draws the live waveform.
 */
function drawWave(c: HTMLCanvasElement | null, size: { w: number; h: number }, a: TrackAnalysis | null, t: number, d: number) {
  if (!c) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const { w, h } = size;
  if (!w || !h) return;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    waveCache = null;
  }
  const g = c.getContext('2d')!;
  if (a) {
    let wc = waveCache;
    if (!wc || wc.a !== a || wc.w !== w || wc.h !== h || wc.dpr !== dpr) {
      wc = waveCache = { a, w, h, dpr, played: waveLayer(a, w, h, dpr, '#17171a'), ahead: waveLayer(a, w, h, dpr, '#c9c5bb'), px: -1 };
    }
    // the playhead in device pixels, on the 2-px bar grid the bars are drawn on
    const px = Math.round(Math.max(0, Math.min(1, d > 0 ? t / d : 0)) * w / 2) * 2 * dpr;
    if (px === wc.px) return;
    wc.px = px;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(wc.ahead, 0, 0);
    if (px > 0) g.drawImage(wc.played, 0, 0, px, c.height, 0, 0, px, c.height);
    return;
  }
  waveCache = null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (audioEngine.kind !== 'none') {
    // live waveform while analysing / mic
    const wf = audioEngine.frame.waveform;
    g.beginPath();
    for (let x = 0; x < w; x++) {
      const v = wf[Math.floor((x / w) * wf.length)] ?? 0;
      const y = h / 2 + v * h * 0.4;
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.strokeStyle = '#17171a';
    g.lineWidth = 1;
    g.stroke();
  }
}
