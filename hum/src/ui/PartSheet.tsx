/**
 * The part sheet: tap a part on the song map to change it right where you see it. A popover over the
 * part on a computer, a bottom sheet on a phone (swipe it down, tap outside or Esc to close).
 *
 *   Play this part   jump there and play
 *   Look             a few families that fit this part and sit well with its neighbours (fit.ts),
 *                    filtered by mood; More looks… lists every family for the part, with a search
 *   Version          the other takes of the part's look, one tap each
 *   Lyrics           the part's lyric style (songs with timed lyrics)
 *   Pop-ups          Off / Few / Lots
 *
 * Changes go into the plan (state/partEdit.ts), are saved for the song, survive a re-plan, and show on
 * the song map; Reset this part puts the planner's pick back and Undo takes back the last change.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import type { Preset, TrackAnalysis } from '../core/types';
import { bestTake, familyIdOf, familyOf, fitScore, neighbourScore, relationsOf, takeName, withCustom, type LookFamily } from '../presets/fit';
import { inMood, moodById, type MoodId } from '../presets/moods';
import { profileFor } from '../render/lyricProfiles';
import { getScene } from '../scenes';
import { vocalDensity, type LyricMedium } from '../state/lyricPlan';
import { playPart, resetPart, setPartLook, setPartLyric, setPartPopsLevel, undoLabel, undoPartEdit, onUndoChange } from '../state/partEdit';
import { findLook, LABEL_NAME, makeVideo, partEdits, partEnergy, popsOf, sectionNames, validPlan } from '../state/plan';
import { useStudio } from '../state/store';
import { Play, X } from './Icons';
import { STATIC_THUMBS, Thumb } from './Library';
import { MoodChips } from './Moods';
import { hidePeek, peekHandlers } from './Peek';
import { presetToLook } from '../presets/apply';
import { useRenderMode } from './RenderBar';
import { fmtTime, lookBg } from './song';
import './partSheet.css';

export const usePartSheet = create<{ index: number | null }>(() => ({ index: null }));
/** open the sheet for part i (or close it when it's already open there) */
export const togglePartSheet = (i: number) => usePartSheet.setState((s) => ({ index: s.index === i ? null : i }));
export const closePartSheet = () => usePartSheet.setState({ index: null });

const PHONE = '(max-width: 760px)';
function usePhone() {
  const [on, setOn] = useState(() => matchMedia(PHONE).matches);
  useEffect(() => {
    const mq = matchMedia(PHONE);
    const f = () => setOn(mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, []);
  return on;
}
const canHover = () => matchMedia('(hover: hover)').matches;
/** run an action whose button may vanish (Reset, Undo), then keep focus in the sheet if it fell out */
function refocus(act: () => void) {
  act();
  requestAnimationFrame(() => {
    const sheet = document.querySelector('.ps');
    if (sheet && !sheet.contains(document.activeElement)) sheet.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
  });
}
const partEl = (i: number) => document.querySelector<HTMLElement>(`.tl-sec[data-part="${i}"]`);

/** where the popover stands: over part i, its arrow on the part's middle, inside the window */
function popoverAt(i: number): { left: number; width: number; bottom: number; maxH: number; arrow: number } | null {
  const el = partEl(i);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const width = Math.min(356, window.innerWidth - 16);
  const cx = r.left + r.width / 2;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, cx - width / 2));
  return { left, width, bottom: window.innerHeight - r.top + 10, maxH: Math.max(240, r.top - 20), arrow: Math.max(18, Math.min(width - 18, cx - left)) };
}

export function PartSheet() {
  const index = usePartSheet((s) => s.index);
  const analysis = useStudio((s) => s.analysis);
  const renderOn = useRenderMode((s) => s.on);
  // a new song, or the song map turning into the render picker, closes it
  useEffect(() => closePartSheet(), [analysis]);
  useEffect(() => {
    if (renderOn) closePartSheet();
  }, [renderOn]);
  if (index === null || !analysis?.sections[index]) return null;
  return <SheetFrame key={index} i={index} a={analysis} />;
}

/* ───────── the frame: where it sits, focus, closing, swipe ───────── */

function SheetFrame({ i, a }: { i: number; a: TrackAnalysis }) {
  const phone = usePhone();
  const box = useRef<HTMLDivElement>(null);
  // placed from the first render, so it never shows (or takes focus) anywhere else
  const [pos, setPos] = useState(() => (phone ? null : popoverAt(i)));
  const [dy, setDy] = useState(0);
  const drag = useRef<{ y0: number; t0: number; id: number; on: boolean } | null>(null);
  const headingId = `ps-h-${i}`;

  // a popover over the part on a computer
  useLayoutEffect(() => {
    if (phone) return;
    const place = () => {
      const p = popoverAt(i);
      if (p) setPos(p);
    };
    place();
    const row = document.querySelector('.tl-secs');
    const ro = new ResizeObserver(place);
    if (row) ro.observe(row);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [i, phone]);

  // focus moves in; on close it goes back to the part (when it was still inside). A layout effect, so
  // the cleanup runs while the sheet is still in the page and can tell where focus was
  useLayoutEffect(() => {
    const el = box.current;
    // a tap on a phone counts as hovering the part too: drop the preview it started
    hidePeek();
    const raf = requestAnimationFrame(() => el?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(raf);
      const inside = !!el && (el.contains(document.activeElement) || document.activeElement === document.body);
      // only when focus has nowhere else to be: a click outside on a field or a button keeps its focus
      const lost = () => !document.activeElement || document.activeElement === document.body;
      if (inside) requestAnimationFrame(() => lost() && partEl(i)?.focus({ preventScroll: true }));
      hidePeek();
    };
  }, [i]);

  // Esc closes it even when focus has fallen out (a Reset or Undo button that went away takes it along)
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as Element | null;
      if (t && t !== document.body && !box.current?.contains(t)) return;
      e.preventDefault();
      closePartSheet();
    };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, []);

  // a click outside closes it (another part's own click opens that part instead)
  useEffect(() => {
    if (phone) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || box.current?.contains(t) || t.closest('.tl-sec') || t.closest('.peek') || t.closest('.toast')) return;
      closePartSheet();
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [phone]);

  const onKey = (e: React.KeyboardEvent) => {
    // keys typed in the sheet stay in the sheet (space is a button press here, not play / pause)
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      closePartSheet();
    } else if (e.key === 'Tab' && box.current) {
      const f = [...box.current.querySelectorAll<HTMLElement>('button:not([disabled]), input, [tabindex="0"]')].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  // swipe the sheet down to close it (phone): from the handle or the header
  const grab = {
    onPointerDown: (e: React.PointerEvent) => {
      if (!phone || e.button !== 0) return;
      drag.current = { y0: e.clientY, t0: performance.now(), id: e.pointerId, on: false };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      const v = Math.max(0, e.clientY - d.y0);
      if (!d.on && v > 6) {
        d.on = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }
      if (d.on) setDy(v);
    },
    onPointerUp: (e: React.PointerEvent) => {
      const d = drag.current;
      drag.current = null;
      if (!d?.on) return;
      const v = Math.max(0, e.clientY - d.y0);
      const speed = v / Math.max(1, performance.now() - d.t0);
      if (v > 90 || (speed > 0.5 && v > 24)) closePartSheet();
      else setDy(0);
    },
    onPointerCancel: () => {
      drag.current = null;
      setDy(0);
    },
  };

  const style: React.CSSProperties = phone
    ? { transform: dy ? `translateY(${dy}px)` : undefined, transition: drag.current?.on ? 'none' : undefined }
    : pos
      ? { left: pos.left, width: pos.width, bottom: pos.bottom, maxHeight: pos.maxH, ['--arrow' as string]: `${pos.arrow}px` }
      : { visibility: 'hidden' };

  return (
    <>
      {phone && <div className="ps-backdrop" onClick={closePartSheet} aria-hidden style={{ opacity: dy ? Math.max(0, 1 - dy / 300) : undefined }} />}
      <div ref={box} className={`ps ${phone ? 'ps-phone' : 'ps-pop'}`} role="dialog" aria-modal={phone} aria-labelledby={headingId} style={style} onKeyDown={onKey}>
        {phone && (
          <div className="ps-grab" {...grab} aria-hidden>
            <i />
          </div>
        )}
        <PartBody i={i} a={a} headingId={headingId} grab={phone ? grab : undefined} />
      </div>
    </>
  );
}

/* ───────── what's in it ───────── */

const POP_LEVELS: { label: string; v: number; tip: string }[] = [
  { label: 'Off', v: 0, tip: 'No pop-up windows in this part' },
  { label: 'Few', v: 1, tip: 'A window pops up now and then' },
  { label: 'Lots', v: 3, tip: 'Windows pop in on the beats and on the drop' },
];
const LYRIC_OPTS: { m: LyricMedium; label: string; tip: string }[] = [
  { m: 'subtitle', label: 'Subtitles', tip: 'A quiet caption low in the picture' },
  { m: 'big', label: 'Big words', tip: 'One big line at a time, each word rising in as it’s sung' },
  { m: 'sparse', label: 'A word or two', tip: 'The line small and quiet in a margin' },
  { m: 'own', label: 'The look’s own', tip: 'This look writes the words itself; the overlay stands down' },
];
const SHORT_LIST = 5;

interface Ranked {
  f: LookFamily;
  take: Preset;
  score: number;
  why: string;
}

function PartBody({ i, a, headingId, grab }: { i: number; a: TrackAnalysis; headingId: string; grab?: Record<string, (e: React.PointerEvent) => void> }) {
  const plan = useStudio((s) => s.plan);
  const custom = useStudio((s) => s.customPresets);
  const lyrics = useStudio((s) => s.lyrics);
  const lyricStyle = useStudio((s) => s.lyricStyle);
  const popups = useStudio((s) => s.popups);
  const planning = useStudio((s) => s.planning);
  const busy = useStudio((s) => !!s.clip);
  const undoText = useSyncExternalStore(onUndoChange, undoLabel);
  const hasPlan = validPlan(plan, a);
  const [mood, setMood] = useState<MoodId | 'all'>(() => (hasPlan && plan.mood) || 'all');
  const [more, setMore] = useState(false);
  const [query, setQuery] = useState('');

  const sec = a.sections[i];
  const names = sectionNames(a.sections);
  const name = names[i];
  const look = hasPlan ? findLook(plan.looks[i]) : undefined;
  const edit = hasPlan ? partEdits(plan, a)[i] : null;
  const { families } = useMemo(() => withCustom(custom), [custom]);
  const fam = look ? (families.find((f) => f.id === familyIdOf(look)) ?? familyOf(look)) : null;

  // families that fit this part and sit with the parts either side, best first
  const ranked = useMemo((): Ranked[] => {
    const energy = partEnergy(a, i);
    const prev = hasPlan ? findLook(plan.looks[i - 1]) : undefined;
    const next = hasPlan ? findLook(plan.looks[i + 1]) : undefined;
    const sug = a.suggestedPresets;
    const m = mood === 'all' ? undefined : moodById(mood);
    const label = LABEL_NAME[sec.label].toLowerCase();
    const part = `${/^[aeiou]/.test(label) ? 'an' : 'a'} ${label}`;
    const out: Ranked[] = [];
    for (const f of families) {
      if (f.id === fam?.id || f.fit.themes[0] === 'board') continue;
      const takes = f.takes.filter((p) => getScene(p.sceneId) && (!m || inMood(p, m)));
      if (!takes.length) continue;
      const take = bestTake({ ...f, takes }, sug);
      const fit = fitScore(take, sec.label, energy);
      const nb = (prev ? neighbourScore(take, prev) : 0) + (next ? neighbourScore(take, next) : 0);
      const r = sug.findIndex((id) => takes.some((p) => p.id === id));
      const score = fit + 0.45 * nb + (r >= 0 ? 0.3 * (1 - r / Math.max(1, sug.length)) : 0);
      const rel = relationsOf(f.id);
      const bits = [fit >= 0.9 ? `Made for ${part}` : fit >= 0.35 ? `Fits ${part}` : `A stretch for ${part}`];
      if (prev && rel.pairs.includes(familyIdOf(prev))) bits.push(`sits well after ${familyOf(prev).name}`);
      else if (next && rel.pairs.includes(familyIdOf(next))) bits.push(`leads well into ${familyOf(next).name}`);
      else if ((prev && rel.clashes.includes(familyIdOf(prev))) || (next && rel.clashes.includes(familyIdOf(next)))) bits.push('fights a neighbour');
      out.push({ f, take, score, why: bits.join(' · ') });
    }
    return out.sort((x, y) => y.score - x.score || (x.f.name < y.f.name ? -1 : 1));
  }, [a, i, hasPlan, plan, families, fam, mood, sec.label]);

  const q = query.trim().toLowerCase();
  const shown = more ? ranked.filter((r) => !q || `${r.f.name} ${r.f.blurb} ${r.f.takes.map((p) => `${p.name} ${p.tags.join(' ')}`).join(' ')}`.toLowerCase().includes(q)) : ranked.slice(0, SHORT_LIST);

  const synced = !!lyrics?.synced && lyrics.lines.length > 0;
  const sung = synced && vocalDensity(lyrics!.lines, sec).lines > 0;
  const medium = hasPlan ? (plan.lyricPlan?.parts[i]?.medium ?? null) : null;
  const sc = look ? getScene(look.sceneId) : undefined;
  const ownOk = !!look && profileFor(look.id, sc?.category, !!sc?.showsLyrics).own !== 'none';
  const pops = hasPlan ? popsOf(plan, a, i) : null;
  const changedWhat = edit ? [edit.look && 'look', edit.lyric && 'lyrics', edit.pops && 'pop-ups'].filter(Boolean).join(', ') : '';
  const peek = canHover();

  const pickLookHere = (p: Preset) => {
    hidePeek();
    setPartLook(i, p.id);
  };

  return (
    <div className="ps-body">
      <div className="ps-head" {...(grab ?? {})}>
        <span className="ps-pic" style={look ? lookBg(look) : undefined} aria-hidden />
        <div className="ps-title">
          <h2 id={headingId}>{name}</h2>
          <span className="ps-sub">
            {fmtTime(sec.start)}–{fmtTime(sec.end)} · {look ? (fam && fam.takes.length > 1 ? `${fam.name} · ${takeName(look)}` : look.name) : 'No look yet'}
          </span>
        </div>
        <button className="btn icon sm ghost ps-x" onClick={closePartSheet} aria-label="Close" title="Close (Esc)">
          <X width={13} height={13} />
        </button>
      </div>

      <div className="ps-actions">
        <button className="btn sm" data-autofocus onClick={() => playPart(i)} disabled={busy} title={`Jump to ${name} and play it`}>
          <Play width={11} height={11} />
          Play this part
        </button>
        {edit && (
          <button className="btn sm ghost" onClick={() => refocus(() => resetPart(i))} disabled={busy} title="Put back what the plan picked for this part">
            Reset this part
          </button>
        )}
        {undoText && (
          <button className="btn sm ghost" onClick={() => refocus(undoPartEdit)} disabled={busy} title={`Undo ${undoText}`}>
            Undo
          </button>
        )}
      </div>
      {changedWhat && <p className="ps-note">You changed the {changedWhat} here. A new plan keeps it.</p>}
      {busy && <p className="ps-note">A render is running: changes wait until it’s done.</p>}

      {!hasPlan && (
        <div className="ps-noplan">
          <p>No video plan yet. Make one, or pick a look for this part and the song map starts from it.</p>
          <button className="btn sm primary" disabled={planning || busy} onClick={() => void makeVideo('')}>
            {planning ? 'Planning…' : 'Make a video'}
          </button>
        </div>
      )}

      <section className="ps-sec" aria-labelledby={`${headingId}-look`}>
        <div className="ps-h">
          <h3 id={`${headingId}-look`}>{hasPlan ? 'Swap the look' : 'Pick a look'}</h3>
          <span>{more ? `${shown.length} looks` : 'Best for this part'}</span>
        </div>
        <MoodChips value={mood} onChange={setMood} label="Show looks from one mood" />
        {more && (
          <input className="txt ps-search" type="search" placeholder="Search looks…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search looks for this part" />
        )}
        <ul className={`ps-looks ${more ? 'all' : ''}`}>
          {shown.map((r) => (
            <li key={r.f.id}>
              <button
                className="ps-look"
                disabled={busy}
                onClick={() => pickLookHere(r.take)}
                {...(peek
                  ? peekHandlers({ key: `ps:${r.take.id}`, title: r.f.takes.length > 1 ? `${r.f.name} · ${takeName(r.take)}` : r.f.name, hint: `Click to use it in ${name}`, poster: STATIC_THUMBS[r.take.id], getLook: () => presetToLook(r.take) })
                  : {})}
              >
                <span className="ps-thumb">
                  <Thumb p={r.take} />
                </span>
                <span className="ps-lt">
                  {/* a mood can hold only some of a family's versions: name the one it picks */}
                  <b>{mood !== 'all' && r.f.takes.length > 1 && r.take.id !== r.f.takes[0].id ? `${r.f.name} · ${takeName(r.take)}` : r.f.name}</b>
                  <span>{r.why}</span>
                </span>
              </button>
            </li>
          ))}
          {!shown.length && <li className="ps-empty">{q ? 'No looks match.' : 'No looks of this mood for this part. Try All.'}</li>}
        </ul>
        {ranked.length > SHORT_LIST && (
          <button className="ps-more" onClick={() => setMore(!more)} aria-expanded={more}>
            {more ? 'Fewer looks' : `More looks… (${ranked.length})`}
          </button>
        )}
      </section>

      {fam && fam.takes.length > 1 && (
        <section className="ps-sec" aria-labelledby={`${headingId}-take`}>
          <div className="ps-h">
            <h3 id={`${headingId}-take`}>Version</h3>
            <span>{fam.name}</span>
          </div>
          <div className="ps-takes" role="group" aria-label={`Versions of ${fam.name}`}>
            {fam.takes.map((p) => (
              <button key={p.id} className={`ps-take ${p.id === look?.id ? 'on' : ''}`} aria-pressed={p.id === look?.id} disabled={busy} title={`${takeName(p)}: ${p.description}`} onClick={() => pickLookHere(p)}>
                <span className="ps-thumb">
                  <Thumb p={p} />
                </span>
                <span className="ps-tn">{takeName(p)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {hasPlan && synced && (
        <section className="ps-sec" aria-labelledby={`${headingId}-lyr`}>
          <div className="ps-h">
            <h3 id={`${headingId}-lyr`}>Lyrics</h3>
            {!sung && <span>No words here</span>}
          </div>
          {sung ? (
            <div className="seg grid2 ps-seg" role="group" aria-label={`How the lyrics show in ${name}`}>
              {LYRIC_OPTS.filter((o) => o.m !== 'own' || ownOk || medium === 'own').map((o) => (
                <button key={o.m} className={medium === o.m ? 'on' : ''} aria-pressed={medium === o.m} disabled={busy} title={o.tip} onClick={() => setPartLyric(i, o.m)}>
                  {o.label}
                </button>
              ))}
            </div>
          ) : (
            <p className="ps-note">No words are sung in this part.</p>
          )}
          {sung && lyricStyle !== 'auto' && <p className="ps-note">Lyrics are set for the whole song right now. Picking a style here switches them to Auto.</p>}
        </section>
      )}

      {hasPlan && pops !== null && (
        <section className="ps-sec" aria-labelledby={`${headingId}-pop`}>
          <div className="ps-h">
            <h3 id={`${headingId}-pop`}>Pop-ups</h3>
          </div>
          <div className="seg full ps-seg" role="group" aria-label={`Pop-up windows in ${name}`}>
            {POP_LEVELS.map((o) => {
              const on = o.v === 0 ? pops === 0 : o.v === 1 ? pops === 1 : pops >= 2;
              return (
                <button key={o.label} className={on ? 'on' : ''} aria-pressed={on} disabled={busy} title={o.tip} onClick={() => setPartPopsLevel(i, o.v)}>
                  {o.label}
                </button>
              );
            })}
          </div>
          {popups === 'off' && <p className="ps-note">Pop-ups are switched off for now (the Pop-ups switch by the song map).</p>}
        </section>
      )}
    </div>
  );
}
