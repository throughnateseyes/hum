/**
 * The timeline: the song's sections as headers, one block per part under them (with one look per part,
 * every shot of the video is its own part: flatPlan.ts), the waveform under the blocks and one playhead
 * through all of it. It zooms: at fit the whole song shows and the blocks are thin (a picture, then a
 * plain colour); zoomed in each block shows its picture and its look's name.
 *
 * A block shows its look's picture, and a small mark when the person changed it (dot), liked it
 * (heart) or set it hand-drawn on its own (pencil). The section headers (Intro, Build, Drop…) span
 * the blocks that came from them.
 *
 *   click            pick a part (the Part tab comes forward; the song doesn't move)
 *   ⌘/Ctrl-click     add or take away a part      Shift-click   pick the run between
 *   click a header   pick every part of that section
 *   double-click     play the part                Esc / click an empty spot   pick nothing
 *   right-click      the part menu: skip, like, split, combine, play from here, swap, hand-drawn, pop-ups, reset
 *   C or ✂           the split tool: a guide follows the pointer, a click splits on the nearest beat
 *   ⌘/Ctrl+J         combine the picked parts (or the picked part with the next one)
 *   drag a look      from the Library onto a part (onto any picked part: all the picked parts)
 *   ⌘/Ctrl+wheel     zoom around the pointer (a trackpad pinch too); Shift+wheel or a sideways swipe pans
 *   + / − / 0        zoom in, out, fit the whole song
 *
 * While the song plays zoomed in, the view turns the page when the playhead reaches its edge.
 * On a phone a tap opens the part sheet (PartSheet.tsx) instead, and the timeline stays at fit.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { audioEngine } from '../audio/engine';
import type { Preset, TrackAnalysis } from '../core/types';
import { presetToLook } from '../presets/apply';
import { onFrame } from '../state/live';
import { combineParts, combineRun, likePart, playFrom, playPart, resetParts, setPartsHand, setPartsLook, setPartsPops, skipPart, splitPartAt, splitPoint } from '../state/partEdit';
import { assignLook, findLook, partEdits, partNames, planShots, sectionIndexAt, sectionNames, shotIndexAt, validPlan, type Shot } from '../state/plan';
import { originalOf, parentsOf } from '../state/planCache';
import { useStudio } from '../state/store';
import { withTweak } from '../state/tweaks';
import { noteHandPick } from '../state/taste';
import { ContextMenu, MOD, type MenuItem } from './ContextMenu';
import { Plus } from './Icons';
import { LOOK_MIME, STATIC_THUMBS } from './Library';
import { useLayout } from './layout';
import { togglePartSheet } from './PartSheet';
import { peekHandlers } from './Peek';
import { RangeOverlay, useRenderMode } from './RenderBar';
import { GROUP_INK, dropList, fmtTime, lookBg } from './song';
import { maxZoom, takeZoomAnchor, useTimelineZoom, zoomFit, zoomStep, zoomTo } from './timelineZoom';
import './timeline.css';

/** the split tool (the blade) is on */
export const useTimelineTool = create<{ blade: boolean }>(() => ({ blade: false }));
export const toggleBlade = (on?: boolean) => useTimelineTool.setState((s) => ({ blade: on ?? !s.blade }));

/** what a cut lands on, in plain words (block tooltips) */
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
}

/** the view's horizontal padding (timeline.css .tln-view), so the rings on the edge blocks show */
const PAD_X = 2;

export function Timeline({ side }: { side?: React.ReactNode }) {
  const track = useStudio((s) => s.track);
  const analysis = useStudio((s) => s.analysis);
  const analyzing = useStudio((s) => s.analyzing);
  const plan = useStudio((s) => s.plan);
  const renderOn = useRenderMode((s) => s.on);
  const blade = useTimelineTool((s) => s.blade);
  const phone = useLayout((s) => s.phone);
  const zoomRaw = useTimelineZoom((s) => s.zoom);
  const zoom = phone ? 1 : zoomRaw;
  const canvas = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const lane = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(600);
  const [scroll, setScroll] = useState(0);
  const scrollRef = useRef(0);
  const userScrolled = useRef(0);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const secs = analysis?.sections ?? [];
  const d = analysis?.duration ?? 0;
  const hasPlan = validPlan(plan, analysis);
  const canEdit = hasPlan && !phone && !renderOn;
  const laneW = Math.max(1, Math.round(viewW * zoom));

  useLayoutEffect(() => {
    const el = view.current!;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth - 2 * PAD_X));
    ro.observe(el);
    setViewW(el.clientWidth - 2 * PAD_X);
    return () => ro.disconnect();
  }, []);

  // a new song starts at fit
  const songId = analysis ? originalOf(analysis) : null;
  useEffect(() => {
    useTimelineZoom.setState({ zoom: 1 });
  }, [songId]);

  // after a zoom, scroll so the anchor stays put (else keep the playhead, or the middle, in place)
  const lastZoom = useRef(zoom);
  useLayoutEffect(() => {
    const el = view.current;
    if (!el || !d || lastZoom.current === zoom) return;
    const prevW = viewW * lastZoom.current;
    lastZoom.current = zoom;
    let a = takeZoomAnchor();
    if (!a) {
      const t = audioEngine.currentTime;
      const x = (t / d) * prevW - scrollRef.current;
      a = x >= 0 && x <= viewW ? { t, at: x / viewW } : { t: ((scrollRef.current + viewW / 2) / prevW) * d, at: 0.5 };
    }
    const left = Math.max(0, Math.min(laneW - viewW, (a.t / d) * laneW - a.at * viewW));
    el.scrollLeft = left;
    scrollRef.current = left;
    setScroll(left);
  }, [zoom, laneW, viewW, d]);

  // ⌘/Ctrl+wheel (and a pinch) zooms around the pointer; Shift+wheel pans. A native listener, so the
  // page's own zoom can be stopped (React's wheel handlers are passive).
  useEffect(() => {
    const el = view.current;
    if (!el || phone) return;
    const wheel = (e: WheelEvent) => {
      const dd = useStudio.getState().analysis?.duration ?? 0;
      if (!dd) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const px = Math.max(0, Math.min(r.width, e.clientX - r.left - PAD_X));
        const w = el.clientWidth - 2 * PAD_X;
        const z = useTimelineZoom.getState().zoom;
        const t = ((el.scrollLeft + px) / (w * z)) * dd;
        const step = Math.max(-60, Math.min(60, e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY));
        zoomTo(z * Math.exp(-step * 0.012), { t, at: px / w });
      } else if (e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [phone]);

  const onScroll = () => {
    const el = view.current;
    if (!el) return;
    scrollRef.current = el.scrollLeft;
    setScroll(el.scrollLeft);
  };

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

  // the visible stretch of the song, for the waveform (read by the frame loop)
  const visible = useRef({ t0: 0, t1: 1 });
  useLayoutEffect(() => {
    visible.current = { t0: laneW ? (scroll / laneW) * d : 0, t1: laneW ? ((scroll + viewW) / laneW) * d : d };
  }, [scroll, laneW, viewW, d]);

  useEffect(() => {
    let lastLeft = '';
    let lastShow = '';
    return onFrame(() => {
      const f = audioEngine.frame;
      const dur = analysis?.duration || f.duration;
      const t = audioEngine.kind === 'mic' ? 0 : audioEngine.currentTime;
      drawWave(canvas.current, waveSize.current, analysis, t, dur, visible.current);
      const el = head.current;
      if (el) {
        const show = dur > 0 && audioEngine.kind !== 'mic' ? '' : 'none';
        const left = `${dur > 0 ? Math.round((t / dur) * 100000) / 1000 : 0}%`;
        if (show !== lastShow) el.style.display = lastShow = show;
        if (left !== lastLeft) el.style.left = lastLeft = left;
      }
      // zoomed in and playing: turn the page when the playhead reaches the edge of the view (not while
      // the person is scrolling around by hand)
      const v = view.current;
      const z = useTimelineZoom.getState().zoom;
      if (v && z > 1.01 && audioEngine.playing && dur > 0 && performance.now() - userScrolled.current > 2500) {
        const w = v.clientWidth - 2 * PAD_X;
        const x = (t / dur) * w * z;
        const sl = scrollRef.current;
        if (x < sl || x > sl + w - 16) {
          const left = Math.max(0, Math.min(w * z - w, x - w * 0.08));
          v.scrollLeft = left;
          scrollRef.current = left;
        }
      }
    });
  }, [analysis]);

  // the tool and the picked parts go when they no longer make sense
  useEffect(() => {
    if (!canEdit) toggleBlade(false);
  }, [canEdit]);

  // Esc leaves the split tool, then picks nothing; C is the split tool; ⌘/Ctrl+J combines; + − 0 zoom
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typing(e.target) || useStudio.getState().perform) return;
      const s = useStudio.getState();
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      if (e.key === 'Escape') {
        if (useTimelineTool.getState().blade) toggleBlade(false);
        else if (s.selectedParts.length) pickParts([]);
        else return;
        e.preventDefault();
      } else if ((e.key === 'c' || e.key === 'C') && plain) {
        if (!canEdit) return;
        e.preventDefault();
        toggleBlade();
      } else if ((e.key === 'j' || e.key === 'J') && (e.metaKey || e.ctrlKey) && !e.altKey) {
        if (!canEdit || !s.selectedParts.length) return;
        e.preventDefault();
        combineParts(s.selectedParts);
      } else if ((e.key === '+' || e.key === '=') && plain && !phone && s.analysis) {
        e.preventDefault();
        zoomStep(1);
      } else if ((e.key === '-' || e.key === '_') && plain && !phone && s.analysis) {
        e.preventDefault();
        zoomStep(-1);
      } else if (e.key === '0' && plain && !phone && s.analysis) {
        e.preventDefault();
        zoomFit();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [canEdit, phone]);

  const timeAt = (clientX: number) => {
    const r = lane.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * d;
  };

  const seek = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const dur = audioEngine.frame.duration;
    if (dur) audioEngine.seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur);
  };

  const openMenu = (e: React.MouseEvent) => {
    if (!analysis || !secs.length || phone || renderOn) return;
    e.preventDefault();
    const t = timeAt(e.clientX);
    const part = sectionIndexAt(secs, t);
    // right-click a part that isn't picked: it becomes the pick (as in a file list)
    if (!useStudio.getState().selectedParts.includes(part)) {
      anchor = part;
      useStudio.getState().set({ selectedParts: [part] });
    }
    setMenu({ x: e.clientX, y: e.clientY, t, part });
  };
  const closeMenu = useCallback(() => setMenu(null), []);

  // the split guide: where a split would land (on the beat), while the tool is on or the menu is open
  const guideT = menu ? menu.t : blade ? hover : null;
  const guide = guideT !== null && analysis ? splitPoint(guideT) : null;
  // things drawn over the view (they'd be clipped inside it): placed by their x in the view
  const xInView = (t: number) => (d ? (t / d) * laneW - scroll + PAD_X : 0);

  const drops = analysis ? dropList(analysis) : [];

  return (
    <div className={`tl tln ${blade ? 'blade' : ''} ${zoom > 1.01 ? 'zoomed' : ''}`}>
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
      <div className="tln-stage">
        <div
          className="tln-view"
          ref={view}
          onScroll={onScroll}
          onWheel={() => (userScrolled.current = performance.now())}
          onPointerDown={() => (userScrolled.current = 0)}
        >
          <div
            className="tl-lane"
            ref={lane}
            style={{ width: laneW }}
            onContextMenu={openMenu}
            onPointerMove={(e) => blade && setHover(timeAt(e.clientX))}
            onPointerLeave={() => setHover(null)}
          >
            {analysis && secs.length > 0 ? (
              <>
                <SectionHeads a={analysis} laneW={laneW} />
                <PartsRow a={analysis} laneW={laneW} blade={blade} quiet={!!menu} onSplit={(x) => splitPartAt(timeAt(x))} onMenu={openMenu} />
              </>
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
              <canvas ref={canvas} style={{ width: viewW }} />
              {analysis &&
                drops.map((dr, i) => (
                  <button
                    key={i}
                    className={`tl-drop ${dr.strength >= 0.7 ? 'big' : ''}`}
                    style={{ left: `${(dr.t / analysis.duration) * 100}%`, ['--s' as string]: String(0.35 + 0.65 * dr.strength) }}
                    title={`Drop at ${fmtTime(dr.t)} · strength ${Math.round(dr.strength * 100)}%${dr.why ? ` · ${dr.why}` : ''}`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      audioEngine.seek(Math.max(0, dr.t - 0.01));
                    }}
                  />
                ))}
            </div>
            <div className="tl-head" ref={head} />
            {guide && analysis && <div className={`tln-guide ${guide.ok ? '' : 'no'}`} style={{ left: `${(guide.t / analysis.duration) * 100}%` }} aria-hidden />}
            {renderOn && analysis && secs.length > 0 && <RangeOverlay a={analysis} />}
          </div>
        </div>
        {/* over the view, so they aren't clipped by its scrolling */}
        {guide && analysis && (
          <span className={`tln-guide-t ${guide.ok ? '' : 'no'}`} style={{ left: xInView(guide.t) }} aria-hidden>
            {guide.ok ? fmtFine(guide.t) : (guide.why ?? '')}
          </span>
        )}
        {analysis && secs.length > 0 && !phone && <ZoomControl zoom={zoom} max={maxZoom(d)} />}
      </div>
      {side && <div className="tl-side">{side}</div>}
      {menu && analysis && <PartMenu at={menu} a={analysis} onClose={closeMenu} />}
    </div>
  );
}

/** − 4× + Fit, at the end of the timeline's header row */
function ZoomControl({ zoom, max }: { zoom: number; max: number }) {
  const label = zoom < 1.05 ? '1×' : `${zoom < 10 ? zoom.toFixed(1).replace(/\.0$/, '') : Math.round(zoom)}×`;
  return (
    <div className="tln-zoom" role="group" aria-label="Zoom the timeline">
      <button className="tln-zb has-tip" data-tip="Zoom out  −" aria-label="Zoom out" disabled={zoom <= 1.001} onClick={() => zoomStep(-1)}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <span className="tln-zr" aria-live="polite" title={`${MOD}+scroll or pinch to zoom around the pointer`}>
        {label}
      </span>
      <button className="tln-zb has-tip" data-tip="Zoom in  +" aria-label="Zoom in" disabled={zoom >= max - 0.001} onClick={() => zoomStep(1)}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 5h6M5 2v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <button className="tln-zb fit has-tip tip-end" data-tip="Show the whole song  0" aria-label="Fit the whole song" disabled={zoom <= 1.001} onClick={zoomFit}>
        Fit
      </button>
    </div>
  );
}

/* ───────── the section headers ───────── */

/** Intro, Build, Drop…: one header over the parts each section of the song gave (click: pick them all) */
function SectionHeads({ a, laneW }: { a: TrackAnalysis; laneW: number }) {
  const orig = originalOf(a);
  const names = sectionNames(orig.sections);
  const parents = parentsOf(a);
  const els = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(
    () =>
      onFrame(() => {
        const j = sectionIndexAt(orig.sections, audioEngine.currentTime);
        els.current.forEach((el, k) => el?.classList.toggle('now', k === j));
      }),
    [orig],
  );
  return (
    <div className="tln-heads">
      {orig.sections.map((sec, j) => {
        const px = ((sec.end - sec.start) / a.duration) * laneW;
        const mine = parents.map((p, k) => (p === j ? k : -1)).filter((k) => k >= 0);
        return (
          <button
            key={`${j}:${sec.start}`}
            ref={(el) => {
              els.current[j] = el;
            }}
            className={`tln-hd ${px < 30 ? 'tiny' : ''}`}
            style={{ left: `${(sec.start / a.duration) * 100}%`, width: `${((sec.end - sec.start) / a.duration) * 100}%` }}
            title={`${names[j]} · ${fmtTime(sec.start)}–${fmtTime(sec.end)}${mine.length > 1 ? ` · ${mine.length} shots. Click to pick them all.` : ''}`}
            onClick={() => mine.length && pickParts(mine)}
            onDoubleClick={() => playFrom(sec.start)}
          >
            <i style={{ background: GROUP_INK[sec.group % GROUP_INK.length] }} />
            {px >= 30 && <b>{names[j]}</b>}
          </button>
        );
      })}
    </div>
  );
}

/* ───────── the parts ───────── */

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

/** a block this wide (px) shows its picture and name; narrower, the picture; narrower still, a colour */
const FULL_PX = 72;
const PIC_PX = 14;

function PartsRow({
  a,
  laneW,
  blade,
  quiet,
  onSplit,
  onMenu,
}: {
  a: TrackAnalysis;
  laneW: number;
  blade: boolean;
  quiet: boolean;
  onSplit: (clientX: number) => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const plan = useStudio((s) => s.plan);
  const pace = useStudio((s) => s.pace);
  const lyrics = useStudio((s) => s.lyrics);
  const selected = useStudio((s) => s.selectedParts);
  const partPops = useStudio((s) => s.partPops);
  const partHand = useStudio((s) => s.partHand);
  const partWords = useStudio((s) => s.partWords);
  // looks fine-tuned for this video show as they play (state/tweaks.ts): their colours on the blocks
  const tweaks = useStudio((s) => s.tweaks);
  const tuned = (p: Preset | undefined) => (p ? withTweak(p, tweaks[p.id]) : undefined);
  const phone = useLayout((s) => s.phone);
  useStudio((s) => s.customPresets.length);
  const dragId = useDraggedLook();
  const [over, setOver] = useState<{ i: number; alt: boolean; x: number; y: number } | null>(null);
  const partEls = useRef<(HTMLDivElement | null)[]>([]);
  const shotEls = useRef<(HTMLSpanElement | null)[]>([]);
  const secs = a.sections;
  const names = partNames(a);
  const hasPlan = validPlan(plan, a);
  const flat = hasPlan && !!plan.flat;
  const looks = secs.map((_, i) => (hasPlan ? (plan.looks[i] ?? null) : null));
  const shots = hasPlan ? planShots(plan, a, pace, lyrics) : NO_SHOTS;
  const dragLook = dragId ? findLook(dragId) : undefined;
  const dragging = !!dragId;
  const edits = partEdits(plan, a, partPops, partHand, partWords);
  const n = secs.length;

  // the part and the shot playing now (classes change only when they do)
  useEffect(() => {
    let lastI = -1;
    let lastK = -1;
    return onFrame(() => {
      const t = audioEngine.currentTime;
      const i = sectionIndexAt(secs, t);
      const k = shots.length ? shotIndexAt(shots, t) : -1;
      if (i !== lastI) {
        partEls.current[lastI]?.classList.remove('now');
        partEls.current[i]?.classList.add('now');
        lastI = i;
      }
      if (k !== lastK) {
        shotEls.current[lastK]?.classList.remove('now');
        shotEls.current[k]?.classList.add('now');
        lastK = k;
      }
    });
  }, [secs, shots]);

  useEffect(() => {
    if (!dragging) setOver(null);
  }, [dragging]);

  // a drop onto a picked part goes into every picked part; one look per part: into that part only;
  // otherwise as assignLook does it: the target, the parts that sound alike and share its look, and
  // every empty part
  const multi = !!over && selected.length > 1 && selected.includes(over.i);
  const affected = (j: number) => {
    if (!over) return false;
    const i = over.i;
    if (multi) return selected.includes(j);
    if (j === i) return true;
    if (flat) return false;
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
        const look = tuned(findLook(looks[i]));
        const len = sec.end - sec.start;
        const px = (len / a.duration) * laneW;
        const size = px < PIC_PX ? 'tiny' : px < FULL_PX ? 'small' : '';
        const why = hasPlan ? (plan.why[i] ?? '') : '';
        const preview = over && dragLook && affected(i) ? dragLook : undefined;
        const mine = shots.map((sh, k) => ({ sh, k })).filter((x) => x.sh.section === i);
        const isSel = selected.includes(i);
        const hand = partHand?.length === n ? partHand[i] : null;
        const liked = hasPlan && !!plan.liked?.[i];
        const shown = preview ?? look;
        const tip = `${names[i]} · ${fmtTime(sec.start)}–${fmtTime(sec.end)} · ${look ? look.name : 'no look yet'}${liked ? ' · liked' : ''}${edits[i] ? ' · changed by you' : ''}${why ? ` · ${why}` : ''}`;
        // a plain colour when it's too thin for a picture
        const fill = shown ? (size === 'tiny' ? { background: shown.palette.accent } : lookBg(shown)) : undefined;
        return (
          <div
            key={`${i}:${sec.start}`}
            ref={(el) => {
              partEls.current[i] = el;
            }}
            role="button"
            tabIndex={0}
            aria-pressed={isSel}
            className={`tln-part ${shown ? 'has-look' : 'no-look'} ${size} ${isSel ? 'sel' : ''} ${preview ? 'preview' : ''} ${over?.i === i ? 'over' : ''} ${edits[i] ? 'edited' : ''} ${liked ? 'liked' : ''}`}
            style={{ left: `${(sec.start / a.duration) * 100}%`, width: `${(len / a.duration) * 100}%` }}
            data-part={i}
            aria-label={`${names[i]}, ${fmtTime(sec.start)} to ${fmtTime(sec.end)}, ${look ? look.name : 'no look yet'}${liked ? ', liked' : ''}${mine.length > 1 ? `, ${mine.length} shots` : ''}`}
            title={dragging || mine.length > 1 ? undefined : tip}
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
              if (over?.i !== i || over.alt !== e.altKey) {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setOver({ i, alt: e.altKey, x: r.left + r.width / 2, y: r.top });
              }
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
              if (flat) {
                setPartsLook([i], id);
                return;
              }
              const placed = findLook(id);
              if (placed) noteHandPick(placed, 'place', sec.label);
              assignLook(i, id, !e.altKey);
            }}
          >
            <span className="tln-shots" style={fill}>
              {preview ? (
                size === '' && <span className="tln-sname">{preview.name}</span>
              ) : mine.length > 1 ? (
                // a plan that isn't one look per part: its shots inside the part
                mine.map(({ sh, k }, m) => {
                  const end = mine[m + 1]?.sh.t ?? sec.end;
                  const p = tuned(findLook(sh.lookId));
                  const w = ((end - sh.t) / a.duration) * laneW;
                  const mode = w >= FULL_PX ? 'full' : w >= PIC_PX ? 'pic' : 'tick';
                  const stip = `${p?.name ?? 'A look'} · ${fmtTime(sh.t)}–${fmtTime(end)} · ${CUT_ON[sh.on]}`;
                  return (
                    <span
                      key={k}
                      ref={(el) => {
                        shotEls.current[k] = el;
                      }}
                      className={`tln-shot ${mode} ${sh.on === 'interlude' ? 'inter' : ''}`}
                      style={{ left: `${((sh.t - sec.start) / len) * 100}%`, width: `${((end - sh.t) / len) * 100}%` }}
                      title={stip}
                      {...(p && !dragging && !blade && !quiet && !phone ? shotPeek(p, names[i], stip) : {})}
                    >
                      {mode !== 'tick' && p && <span className="tln-pic" style={lookBg(p)} />}
                      {mode === 'full' && p && <span className="tln-sname">{p.name}</span>}
                    </span>
                  );
                })
              ) : look ? (
                <span
                  className="tln-one"
                  ref={(el) => {
                    if (mine[0]) shotEls.current[mine[0].k] = el;
                  }}
                  {...(!dragging && !blade && !quiet && !phone && size !== 'tiny' ? shotPeek(look, names[i], tip) : {})}
                >
                  {size === '' && <span className="tln-sname">{look.name}</span>}
                </span>
              ) : (
                <span className="tln-empty">
                  <Plus width={11} height={11} />
                  {size === '' ? (dragging ? 'Drop a look' : 'No look yet') : ''}
                </span>
              )}
            </span>
            {size !== 'tiny' && (liked || edits[i] || hand !== null) && (
              <span className="tln-marks">
                {liked && <HeartMark />}
                {hand !== null && size === '' && <HandMark on={hand} />}
                {edits[i] && <span className="tln-edit" aria-label="changed by you" />}
              </span>
            )}
          </div>
        );
      })}
      {over && dragLook && <DropTip x={over.x} y={over.y} at={over.i} look={dragLook} names={names} multi={multi ? selected.length : 0} alike={alike} fills={fills} alt={over.alt} />}
    </div>
  );
}

/** what a dragged look will do, over the part it's on (fixed to the window, so the scrolling view doesn't clip it) */
function DropTip({ x, y, at, look, names, multi, alike, fills, alt }: { x: number; y: number; at: number; look: Preset; names: string[]; multi: number; alike: number; fills: number; alt: boolean }) {
  return (
    <div className="tl-droptip tln-droptip" style={{ left: x, top: y - 8 }}>
      <b>{look.name}</b> → {multi ? `${multi} picked parts` : names[at]}
      {alike > 0 && !multi && <span>+ {alike === 1 ? 'the part like it' : `${alike} parts like it`}</span>}
      {fills > 0 && <span>+ fills {fills === 1 ? 'the empty part' : `${fills} empty parts`}</span>}
      {!alt && alike > 0 && !multi && <em>hold ⌥ for just this part</em>}
    </div>
  );
}

/** hover a block: a live preview of its look over the timeline, with this video's fine-tuning on it */
function shotPeek(p: Preset, part: string, tip: string) {
  return peekHandlers({
    key: `shot:${part}:${p.id}`,
    title: `${part} · ${p.name}`,
    hint: `${tip.split(' · ').slice(1).join(' · ')}. Click to pick the part, double-click to play it, right-click for more.`,
    poster: STATIC_THUMBS[p.id],
    place: 'above',
    getLook: () => (useStudio.getState().presetId === p.id ? null : presetToLook(withTweak(p, useStudio.getState().tweaks[p.id]))),
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

/** a part the person liked (K) */
function HeartMark() {
  return (
    <svg className="tln-heart" width="10" height="10" viewBox="0 0 24 24" aria-label="Liked">
      <title>Liked: a skip or a remake leaves it alone</title>
      <path d="M12 20s-7-4.4-9.2-8.7C1.3 8.2 3 4.8 6.4 4.4c2-.2 3.6.9 4.6 2.5 1-1.6 2.6-2.7 4.6-2.5 3.4.4 5.1 3.8 3.6 6.9C19 15.6 12 20 12 20z" fill="currentColor" />
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
  const names = partNames(a);
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
  const partLook = hasPlan ? findLook(plan.looks[at.part]) : undefined;
  const flat = hasPlan && !!plan.flat;
  const liked = hasPlan && !!plan.liked?.[at.part];

  const items: MenuItem[] = [{ kind: 'label', label: `${many ? `${sel.length} parts` : names[at.part]}${partLook && !many ? ` · ${partLook.name}` : ''} · ${fmtFine(at.t)}` }];
  if (flat && !many) {
    items.push(
      {
        label: 'Skip this look',
        hint: partLook ? `Put the best other look in place of ${partLook.name}, here only` : 'No look here yet',
        shortcut: 'X',
        disabled: !partLook,
        onSelect: () => skipPart(at.part),
      },
      {
        label: liked ? 'Take the like back' : 'Like this look',
        hint: liked ? 'A skip or a remake may change it again' : 'Keep it: a skip next to it or a remake leaves it alone',
        shortcut: 'K',
        disabled: !partLook,
        onSelect: () => likePart(at.part, !liked),
      },
      { kind: 'sep' },
    );
  }
  items.push({
    label: 'Split here',
    hint: split.ok ? `Cut ${names[split.i]} in two at ${fmtFine(split.t)}, on the beat` : (split.why ?? ''),
    shortcut: 'C',
    disabled: !split.ok,
    onSelect: () => splitPartAt(at.t),
  });
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

/** the visible stretch of the waveform drawn once per size and view in both colours (played, still to come), see drawWave */
let waveCache: { a: TrackAnalysis; w: number; h: number; dpr: number; t0: number; t1: number; played: HTMLCanvasElement; ahead: HTMLCanvasElement; px: number } | null = null;

function waveLayer(a: TrackAnalysis, w: number, h: number, dpr: number, color: string, t0: number, t1: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const ov = a.overview;
  const mid = h / 2;
  const span = Math.max(1e-6, t1 - t0);
  const toI = (x: number) => Math.floor(((t0 + (x / w) * span) / a.duration) * ov.length);
  g.fillStyle = color;
  for (let x = 0; x < w; x += 2) {
    const i0 = Math.max(0, toI(x));
    const i1 = Math.max(i0 + 1, toI(x + 2));
    let v = 0;
    for (let i = i0; i < i1 && i < ov.length; i++) v = Math.max(v, ov[i]);
    const hh = Math.max(0.5, v * (h * 0.44));
    g.fillRect(x, mid - hh, 1.4, hh * 2);
  }
  // the song's own section lines (not every shot: those show on the blocks above)
  g.fillStyle = 'rgba(23,23,26,0.12)';
  for (const s of originalOf(a).sections.slice(1)) {
    if (s.start < t0 || s.start > t1) continue;
    g.fillRect(Math.round(((s.start - t0) / span) * w), 0, 1, h);
  }
  return c;
}

/**
 * The timeline waveform: a canvas the width of the view that stays put while the song scrolls under
 * it (position: sticky), drawing only the stretch in view. That stretch is drawn once per size and
 * scroll position in both colours (the played part dark, the rest light), and each frame only copies
 * them in when the playhead has moved a pixel, so a playing song costs almost nothing here at any
 * zoom. Before analysis it draws the live waveform.
 */
function drawWave(c: HTMLCanvasElement | null, size: { w: number; h: number }, a: TrackAnalysis | null, t: number, d: number, vis: { t0: number; t1: number }) {
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
    const t0 = Math.round(vis.t0 * 1000) / 1000;
    const t1 = Math.round(vis.t1 * 1000) / 1000;
    if (!wc || wc.a !== a || wc.w !== w || wc.h !== h || wc.dpr !== dpr || wc.t0 !== t0 || wc.t1 !== t1) {
      wc = waveCache = { a, w, h, dpr, t0, t1, played: waveLayer(a, w, h, dpr, '#17171a', t0, t1), ahead: waveLayer(a, w, h, dpr, '#c9c5bb', t0, t1), px: -1 };
    }
    // the playhead in device pixels, on the 2-px bar grid the bars are drawn on
    const f = d > 0 ? (t - t0) / Math.max(1e-6, t1 - t0) : 0;
    const px = Math.round((Math.max(0, Math.min(1, f)) * w) / 2) * 2 * dpr;
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
