import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { audioEngine } from '../audio/engine';
import { chordPace } from '../audio/harmony';
import type { TrackAnalysis, TrackHarmony, TrackNote } from '../core/types';
import { curvesFor, curvesNow } from '../director/feeling';
import type { Curves } from '../feeling';
import { onFrame } from '../state/live';
import { sectionNames } from '../state/plan';
import { originalOf } from '../state/planCache';
import { useStudio } from '../state/store';
import { X } from './Icons';
import { useLandings, type Landing } from './landings';
import { GROUP_INK, GROUP_TINT, dropList, fmtTime } from './song';

/**
 * The song breakdown: everything Hum heard in the song, laid out on one time axis — the waveform,
 * energy and the three bands, the parts and drops, the drum hits, the bass and lead notes as a piano
 * roll, where the voice is, and the harmony: the chords, and how far from home they are. The playhead runs across it; click or drag anywhere to move.
 */

export const useBreakdown = create<{ open: boolean }>(() => ({ open: false }));
export const toggleBreakdown = () => useBreakdown.setState((s) => ({ open: !s.open }));

const C = {
  ink: '#1b1b1a',
  ink2: '#5d5c57',
  ink3: '#9a988f',
  line: '#e7e5df',
  line2: '#d9d6ce',
  panel2: '#f3f2ee',
  accent: '#2f4bff',
  head: '#ff3b30',
  low: '#e2620b',
  mid: '#2b8a55',
  high: '#8f47c4',
  vocal: '#c94040',
};

type LaneId = 'feel' | 'lands' | 'ruler' | 'parts' | 'drops' | 'wave' | 'energy' | 'chords' | 'tension' | 'low' | 'mid' | 'high' | 'kick' | 'snare' | 'hat' | 'bass' | 'lead' | 'vocal';
interface Lane {
  id: LaneId;
  label: string;
  sub?: string;
  h: number;
  y: number;
}
const GAP = 6;

export function Breakdown() {
  const open = useBreakdown((s) => s.open);
  const analysis = useStudio((s) => s.analysis);
  const analyzing = useStudio((s) => s.analyzing);
  const track = useStudio((s) => s.track);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return;
      if (e.key === 'Escape' && useBreakdown.getState().open) {
        e.stopPropagation();
        useBreakdown.setState({ open: false });
      } else if ((e.key === 'b' || e.key === 'B') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        toggleBreakdown();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!open) return null;
  return (
    <section className="bd" role="dialog" aria-label="Song breakdown">
      {analysis ? (
        // the song's own sections, not the video's shots (every shot is a part of its own: flatPlan.ts)
        <BreakdownBody a={originalOf(analysis)} name={track?.name ?? 'This song'} />
      ) : (
        <>
          <BdHeader title={track?.name ?? 'No song yet'} />
          <div className="bd-empty">
            {!track
              ? 'Load a song (drop a file anywhere, or pick a demo) and Hum will take it apart here.'
              : track.source === 'mic'
                ? 'Live input has no breakdown: Hum needs the whole song to take it apart.'
                : analyzing
                  ? 'Listening to the song… the breakdown appears as soon as Hum is done.'
                  : 'Hum couldn’t take this song apart.'}
          </div>
        </>
      )}
    </section>
  );
}

function BdHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <header className="bd-head">
      <div className="bd-title">
        <span className="bd-kicker">How Hum hears it</span>
        <b>{title}</b>
      </div>
      {children}
      <div className="spacer" />
      <button className="btn icon sm ghost" onClick={() => useBreakdown.setState({ open: false })} title="Close (esc)">
        <X width={13} height={13} />
      </button>
    </header>
  );
}

function BreakdownBody({ a, name }: { a: TrackAnalysis; name: string }) {
  const [view, setView] = useState<'song' | 'close'>('song');
  const canvas = useRef<HTMLCanvasElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const hover = useRef<number | null>(null);
  const viewRef = useRef<[number, number]>([0, a.duration]);
  const L = a.layers;
  // the feeling the playing video was made with, else what is known now
  const lyrics = useStudio((s) => s.lyrics);
  const plan = useStudio((s) => s.plan);
  const making = useStudio((s) => !!s.making);
  const feel = useMemo(() => (making ? null : curvesFor(plan, a, lyrics)) ?? curvesNow(a, lyrics), [plan, a, lyrics, making]);
  const lands = useLandings();
  const drops = dropList(a);
  const names = useMemo(() => sectionNames(a.sections), [a]);
  const harm = a.harmony;
  const harmonyNote = useMemo(() => (harm ? harmonyWords(harm, a, names) : ''), [harm, a, names]);
  const ch = a.character;

  const lanes = useMemo(() => {
    const spec: Omit<Lane, 'y'>[] = [
      { id: 'ruler', label: '', h: 16 },
      { id: 'parts', label: 'Parts', sub: 'alike = same colour', h: 30 },
      { id: 'drops', label: 'Drops', sub: 'size = how big', h: 24 },
      { id: 'feel', label: 'Feeling', sub: 'bright up, dark down', h: 52 },
      ...(lands.length ? [{ id: 'lands' as const, label: 'Your clips', sub: 'what lands when', h: 30 }] : []),
      { id: 'wave', label: 'Waveform', sub: 'loudness', h: 64 },
      { id: 'energy', label: 'Energy', sub: 'intensity', h: 38 },
      { id: 'low', label: 'Low', sub: 'sub, bass, kick', h: 26 },
      { id: 'mid', label: 'Mid', sub: 'voice, keys, leads', h: 26 },
      { id: 'high', label: 'High', sub: 'hats, air', h: 26 },
    ];
    if (harm) {
      // right under the energy: the chords, and how far from home they are
      const at = spec.findIndex((l) => l.id === 'energy') + 1;
      spec.splice(at, 0, { id: 'chords', label: 'Chords', sub: `${harm.changes.length} changes`, h: 26 }, { id: 'tension', label: 'Tension', sub: 'far from home', h: 26 });
    }
    if (L) {
      spec.push(
        { id: 'kick', label: 'Kick', sub: `${L.kick.length} hits`, h: 18 },
        { id: 'snare', label: 'Snare', sub: `${L.snare.length} hits`, h: 18 },
        { id: 'hat', label: 'Hats', sub: `${L.hat.length} hits`, h: 18 },
        { id: 'bass', label: 'Bass', sub: noteRange(L.bass), h: rollHeight(L.bass, 60) },
        { id: 'lead', label: 'Lead', sub: noteRange(L.lead), h: rollHeight(L.lead, 80) },
        { id: 'vocal', label: 'Voice', sub: L.vocal.length ? 'where it sings' : 'none heard', h: 18 },
      );
    }
    let y = 0;
    return spec.map((l) => {
      const lane = { ...l, y };
      y += l.h + GAP;
      return lane;
    });
  }, [L, harm, lands.length]);
  const H = lanes.length ? lanes[lanes.length - 1].y + lanes[lanes.length - 1].h : 0;

  useLayoutEffect(() => {
    const el = area.current!;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(
    () =>
      onFrame(() => {
        const t = audioEngine.currentTime;
        const d = a.duration;
        let v0 = 0;
        let v1 = d;
        if (view === 'close') {
          // eight bars around the playhead, so every hit and note is readable
          const win = Math.max(6, Math.min(24, (8 * 4 * 60) / (a.bpm || 120)));
          v0 = Math.max(0, Math.min(d - win, t - win * 0.3));
          v1 = Math.min(d, v0 + win);
        }
        viewRef.current = [v0, v1];
        draw(canvas.current, a, lanes, H, v0, v1, t, hover.current, names, feel, lands);
      }),
    [a, lanes, H, view, names, feel, lands],
  );

  const toTime = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const [v0, v1] = viewRef.current;
    return v0 + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (v1 - v0);
  };

  const mood = ch?.mood || a.tags.slice(0, 3).join(', ');

  return (
    <>
      <BdHeader title={name}>
        <div className="seg bd-view">
          <button className={view === 'song' ? 'on' : ''} onClick={() => setView('song')}>
            Whole song
          </button>
          <button className={view === 'close' ? 'on' : ''} onClick={() => setView('close')} title="Eight bars around the playhead, following it">
            Close-up
          </button>
        </div>
      </BdHeader>
      <div className="bd-facts">
        <Fact cap k="Genre" v={ch ? `${ch.genre}` : '—'} note={ch ? `${Math.round(ch.confidence * 100)}% sure` : 'not judged yet'} />
        <Fact cap k="Mood" v={mood || '—'} />
        <Fact k="Tempo" v={`${Math.round(a.bpm)} bpm`} />
        {harm && <Fact k="Key" v={harm.key.name} note={harmonyNote} />}
        <Fact k="Length" v={fmtTime(a.duration)} note={`${a.sections.length} parts · ${drops.length} drop${drops.length === 1 ? '' : 's'}`} />
        <div className="bd-fact wide">
          <span className="k">Instruments</span>
          {ch?.instruments.length ? (
            <span className="bd-chips">
              {ch.instruments.map((x) => (
                <i key={x}>{x}</i>
              ))}
            </span>
          ) : (
            <span className="v quiet">Not picked out yet</span>
          )}
        </div>
        <div className="bd-fact bd-mood">
          <MoodBar k="Intensity" v={a.mood.arousal} />
          <MoodBar k="Brightness" v={a.mood.brightness} />
          <MoodBar k="Busyness" v={a.mood.density} />
          <MoodBar k="Low end" v={a.mood.lowEnd} />
        </div>
      </div>
      <div className="bd-scroll">
        <div className="bd-grid">
          <div className="bd-labels" style={{ height: H }}>
            {lanes.map((l) =>
              l.label ? (
                <div key={l.id} className={`bd-lab lab-${l.id}`} style={{ top: l.y, height: l.h }}>
                  <b>{l.label}</b>
                  {l.sub && l.h >= 24 && <span>{l.sub}</span>}
                </div>
              ) : null,
            )}
          </div>
          <div className="bd-area" ref={area}>
            <canvas
              ref={canvas}
              style={{ width: w, height: H }}
              onPointerDown={(e) => {
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                audioEngine.seek(toTime(e));
              }}
              onPointerMove={(e) => {
                hover.current = toTime(e);
                if (e.buttons & 1) audioEngine.seek(toTime(e));
              }}
              onPointerLeave={() => {
                hover.current = null;
              }}
            />
          </div>
        </div>
        {!L && (
          <p className="bd-note">
            Drum hits, bass and lead notes and where the voice comes in will appear here once Hum’s deeper listening has run on this song. For now you see the
            loudness, the bands and the parts.
          </p>
        )}
        {drops.length > 0 && (
          <div className="bd-drops">
            <h4>Drops</h4>
            {drops.map((d, i) => (
              <button key={i} className="bd-drop" onClick={() => audioEngine.seek(Math.max(0, d.t - 2))} title="Jump to just before it">
                <span className="t">{fmtTime(d.t)}</span>
                <span className="bar">
                  <i style={{ width: `${Math.round(d.strength * 100)}%` }} />
                </span>
                <span className="pct">{Math.round(d.strength * 100)}%</span>
                <span className="why">{d.why || (a.dropInfo ? '' : 'a big jump in energy after a build')}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function Fact({ k, v, note, cap }: { k: string; v: string; note?: string; cap?: boolean }) {
  return (
    <div className="bd-fact">
      <span className="k">{k}</span>
      <span className={`v ${cap ? 'cap' : ''}`}>{v}</span>
      {note && <span className="n">{note}</span>}
    </div>
  );
}

function MoodBar({ k, v }: { k: string; v: number }) {
  return (
    <div className="bd-mb" title={`${k}: ${Math.round(v * 100)}%`}>
      <span>{k}</span>
      <i>
        <u style={{ width: `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%` }} />
      </i>
    </div>
  );
}

const NOTE = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const noteName = (m: number) => `${NOTE[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
function noteRange(ns: TrackNote[]) {
  if (!ns.length) return 'none heard';
  let lo = 127;
  let hi = 0;
  for (const n of ns) {
    lo = Math.min(lo, n.midi);
    hi = Math.max(hi, n.midi);
  }
  return `${ns.length} notes · ${noteName(lo)}–${noteName(hi)}`;
}

/** about 4px a semitone, within reason */
function rollHeight(ns: TrackNote[], min: number) {
  if (!ns.length) return 24;
  let lo = 127;
  let hi = 0;
  for (const n of ns) {
    lo = Math.min(lo, n.midi);
    hi = Math.max(hi, n.midi);
  }
  return Math.max(min, Math.min(150, (hi - lo + 3) * 4));
}

/* ───────────────────────── drawing ───────────────────────── */

function draw(
  c: HTMLCanvasElement | null,
  a: TrackAnalysis,
  lanes: Lane[],
  H: number,
  v0: number,
  v1: number,
  t: number,
  hover: number | null,
  names: string[],
  feel: Curves,
  lands: Landing[],
) {
  if (!c) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = c.clientWidth;
  if (!w || !H) return;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(H * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(H * dpr);
  }
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, H);
  const span = Math.max(0.001, v1 - v0);
  const X = (s: number) => ((s - v0) / span) * w;
  const visible = (s: number, e = s) => e >= v0 && s <= v1;
  const lane = (id: LaneId) => lanes.find((l) => l.id === id);
  const d = a.duration;
  const drops = dropList(a);
  g.font = '500 10.5px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
  g.textBaseline = 'middle';

  // lane backgrounds
  for (const l of lanes) {
    if (l.id === 'ruler') continue;
    g.fillStyle = C.panel2;
    g.fillRect(0, l.y, w, l.h);
  }

  // ruler: a tick every few seconds
  const ru = lane('ruler')!;
  const step = niceStep(span / Math.max(1, w / 70));
  g.fillStyle = C.ink3;
  g.textAlign = 'left';
  for (let s = Math.ceil(v0 / step) * step; s <= v1; s += step) {
    const x = X(s);
    g.fillRect(Math.round(x), ru.y + ru.h - 4, 1, 4);
    if (x < w - 26) g.fillText(step < 1 ? s.toFixed(1) : fmtTime(s), x + 3, ru.y + ru.h / 2 - 1);
  }

  // parts
  const pa = lane('parts')!;
  a.sections.forEach((s, i) => {
    if (!visible(s.start, s.end)) return;
    const x0 = Math.max(0, X(s.start));
    const x1 = Math.min(w, X(s.end));
    const gi = s.group % GROUP_TINT.length;
    g.fillStyle = GROUP_TINT[gi];
    g.fillRect(x0 + 1, pa.y, Math.max(1, x1 - x0 - 2), pa.h);
    g.fillStyle = GROUP_INK[gi];
    g.fillRect(x0 + 1, pa.y, Math.max(1, x1 - x0 - 2), 2);
    if (x1 - x0 > 30) {
      g.save();
      g.beginPath();
      g.rect(x0 + 1, pa.y, x1 - x0 - 6, pa.h);
      g.clip();
      g.fillStyle = C.ink;
      g.fillText(names[i], x0 + 7, pa.y + pa.h / 2 + 1);
      g.restore();
    }
  });

  // part boundaries through every lane below
  g.fillStyle = 'rgba(27,27,26,0.07)';
  for (const s of a.sections.slice(1)) if (visible(s.start)) g.fillRect(Math.round(X(s.start)), pa.y + pa.h, 1, H - pa.y - pa.h);

  // drops: a line through everything, a dot sized by strength
  const dr = lane('drops')!;
  g.textAlign = 'left';
  for (const p of drops) {
    if (!visible(p.t)) continue;
    const x = X(p.t);
    g.fillStyle = `rgba(47,75,255,${0.1 + 0.25 * p.strength})`;
    g.fillRect(Math.round(x), dr.y + dr.h / 2, 1, H - dr.y - dr.h / 2);
    const r = 3 + 6 * p.strength;
    g.beginPath();
    g.arc(x, dr.y + dr.h / 2, r, 0, Math.PI * 2);
    g.fillStyle = C.accent;
    g.globalAlpha = 0.35 + 0.65 * p.strength;
    g.fill();
    g.globalAlpha = 1;
    g.fillStyle = C.ink2;
    g.fillText(`${Math.round(p.strength * 100)}%`, x + r + 4, dr.y + dr.h / 2 + 1);
  }

  // waveform: max of each column, played part dark
  const wv = lane('wave')!;
  const ov = a.overview;
  const mid = wv.y + wv.h / 2;
  for (let x = 0; x < w; x += 2) {
    const i0 = Math.floor(((v0 + (x / w) * span) / d) * ov.length);
    const i1 = Math.max(i0 + 1, Math.floor(((v0 + ((x + 2) / w) * span) / d) * ov.length));
    let v = 0;
    for (let i = Math.max(0, i0); i < i1 && i < ov.length; i++) v = Math.max(v, ov[i]);
    const hh = Math.max(0.5, v * (wv.h * 0.46));
    g.fillStyle = v0 + (x / w) * span < t ? C.ink : '#c9c5bb';
    g.fillRect(x, mid - hh, 1.4, hh * 2);
  }

  // energy and bands: filled curves
  curve(g, a.energyCurve, lane('energy')!, C.accent, v0, span, d, w);
  curve(g, a.lowCurve, lane('low')!, C.low, v0, span, d, w);
  curve(g, a.midCurve, lane('mid')!, C.mid, v0, span, d, w);
  curve(g, a.highCurve, lane('high')!, C.high, v0, span, d, w);

  // harmony: a box per chord (minor chords a shade darker), resolutions as a dot, tension as a curve
  const HM = a.harmony;
  const cl = lane('chords');
  if (HM && cl) {
    for (const c of HM.chords) {
      if (c.root < 0 || !visible(c.t, c.end)) continue;
      const x0 = Math.max(0, X(c.t));
      const x1 = Math.min(w, X(c.end));
      const on = t >= c.t && t < c.end;
      g.fillStyle = c.minor ? 'rgba(143,71,196,0.16)' : 'rgba(47,75,255,0.12)';
      if (on) g.fillStyle = c.minor ? 'rgba(143,71,196,0.32)' : 'rgba(47,75,255,0.26)';
      g.fillRect(x0 + 0.5, cl.y + 3, Math.max(1, x1 - x0 - 1), cl.h - 6);
      if (x1 - x0 > 18) {
        g.fillStyle = C.ink;
        g.textAlign = 'left';
        g.fillText(c.name, x0 + 4, cl.y + cl.h / 2 + 1);
      }
    }
    for (const r of HM.resolutions) {
      if (!visible(r.t)) continue;
      g.beginPath();
      g.arc(X(r.t), cl.y + cl.h - 3, 1.5 + 1.5 * r.strength, 0, Math.PI * 2);
      g.fillStyle = C.mid;
      g.fill();
    }
    curve(g, HM.tension, lane('tension')!, C.vocal, v0, span, d, w);
  }

  feeling(g, feel, lane('feel')!, X, v0, v1, span, t, w);
  const la = lane('lands');
  if (la) landings(g, lands, la, X, v0, v1, t, w);

  const L = a.layers;
  if (L) {
    ticks(g, L.kick, lane('kick')!, C.ink, 1, X, v0, v1, t);
    ticks(g, L.snare, lane('snare')!, C.accent, 0.8, X, v0, v1, t);
    ticks(g, L.hat, lane('hat')!, C.ink3, 0.55, X, v0, v1, t);
    roll(g, L.bass, lane('bass')!, C.low, X, v0, v1, t, w);
    roll(g, L.lead, lane('lead')!, C.accent, X, v0, v1, t, w);
    const vo = lane('vocal')!;
    for (const [s, e] of L.vocal) {
      if (!visible(s, e)) continue;
      const on = t >= s && t < e;
      g.fillStyle = C.vocal;
      g.globalAlpha = on ? 0.85 : 0.45;
      const x0 = X(s);
      roundRect(g, x0, vo.y + 4, Math.max(2, X(e) - x0), vo.h - 8, 4);
      g.globalAlpha = 1;
    }
    for (const id of ['kick', 'snare', 'hat', 'vocal'] as const) {
      const empty = id === 'vocal' ? !L.vocal.length : !L[id].length;
      if (empty) quiet(g, lane(id)!, 'none heard');
    }
    if (!L.bass.length) quiet(g, lane('bass')!, 'no bass notes heard');
    if (!L.lead.length) quiet(g, lane('lead')!, 'no lead notes heard');
  }

  // hover line
  if (hover != null && visible(hover)) {
    const x = X(hover);
    g.fillStyle = 'rgba(27,27,26,0.25)';
    g.fillRect(Math.round(x), ru.y + ru.h, 1, H - ru.h);
    g.fillStyle = C.ink;
    g.textAlign = x > w - 50 ? 'right' : 'left';
    g.fillText(fmtTime(hover), x + (x > w - 50 ? -4 : 4), ru.y + ru.h / 2 - 1);
  }

  // the playhead
  if (visible(t)) {
    const x = X(t);
    g.fillStyle = C.head;
    g.fillRect(x - 0.75, ru.y + ru.h - 2, 1.5, H - ru.h + 2);
    g.beginPath();
    g.moveTo(x - 4, ru.y + ru.h - 6);
    g.lineTo(x + 4, ru.y + ru.h - 6);
    g.lineTo(x, ru.y + ru.h);
    g.fill();
  }
}

/** "chords change every 2 beats in the chorus · lifts up a step at 2:41", in plain words */
function harmonyWords(H: TrackHarmony, a: TrackAnalysis, names: string[]): string {
  const parts: string[] = [];
  const rated = H.sections.map((s, i) => ({ i, b: s.beatsPerChord, len: a.sections[i].end - a.sections[i].start })).filter((x) => x.b > 0);
  if (rated.length) {
    // the part that matters most for the picture: the chorus or drop if there is one, else the longest
    const big = rated.filter((x) => a.sections[x.i].label === 'chorus' || a.sections[x.i].label === 'drop');
    const pick = (big.length ? big : rated).sort((p, q) => q.len - p.len)[0];
    const where = big.length ? ` in the ${names[pick.i].replace(/ \d+$/, '').toLowerCase()}` : '';
    parts.push(`chords change ${chordPace(pick.b)}${where}`);
  }
  for (const k of H.keyChanges.slice(0, 2)) parts.push(k.lift ? `lifts ${k.semitones === 1 ? 'a half step' : 'a step'} at ${fmtTime(k.t)}` : `to ${k.to} at ${fmtTime(k.t)}`);
  if (H.key.confidence < 0.3) parts.push('not sure of the key');
  return parts.join(' · ');
}

function niceStep(raw: number) {
  for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60, 120]) if (s >= raw) return s;
  return 300;
}

/** bright above the line and dark below it, the wind-ups to each landing, and the words the picture waits for */
function feeling(g: CanvasRenderingContext2D, c: Curves, l: Lane, X: (s: number) => number, v0: number, v1: number, span: number, t: number, w: number) {
  const mid = l.y + l.h / 2;
  const reach = l.h / 2 - 3;
  const y = (x: number) => mid - Math.max(-1, Math.min(1, (c.tone(v0 + (x / w) * span) - 0.5) * 2.4)) * reach;
  for (const k of c.winds) {
    if (k.to < v0 || k.from > v1) continue;
    g.fillStyle = C.accent;
    g.globalAlpha = 0.1 + 0.1 * k.strength;
    g.beginPath();
    g.moveTo(X(k.from), l.y + l.h);
    g.lineTo(X(k.to), l.y + l.h);
    g.lineTo(X(k.to), l.y + l.h - (l.h - 2) * (0.4 + 0.6 * k.strength));
    g.fill();
  }
  for (const up of [true, false]) {
    g.save();
    g.beginPath();
    g.rect(0, up ? l.y : mid, w, l.h / 2);
    g.clip();
    g.beginPath();
    g.moveTo(0, mid);
    for (let x = 0; x <= w; x += 2) g.lineTo(x, y(x));
    g.lineTo(w, mid);
    g.closePath();
    g.fillStyle = up ? C.low : C.accent;
    g.globalAlpha = 0.5;
    g.fill();
    g.restore();
  }
  g.globalAlpha = 1;
  let free = -1e9;
  for (const h of c.held) {
    if (h.at < v0 || h.at > v1) continue;
    const x = X(h.at);
    const on = t >= h.t && t < h.end;
    g.fillStyle = on ? C.head : C.ink;
    g.fillRect(x - 0.5, l.y + 2, 1, l.h - 4);
    const wide = g.measureText(h.word).width;
    if (x > free && x + wide + 4 < w) {
      g.fillText(h.word, x + 4, h.tone < 0 ? l.y + 9 : l.y + l.h - 9);
      free = x + wide + 10;
    }
  }
}

/** a mark where something in a clip lands, with what it is where there is room */
function landings(g: CanvasRenderingContext2D, all: Landing[], l: Lane, X: (s: number) => number, v0: number, v1: number, t: number, w: number) {
  const mid = l.y + l.h / 2;
  const seen = all.filter((x) => x.at >= v0 && x.at <= v1);
  seen.forEach((m, i) => {
    const x = X(m.at);
    const r = m.on === 'drop' ? 6 : m.on === 'word' ? 5 : 4;
    g.fillStyle = Math.abs(t - m.at) < 0.25 ? C.head : C.accent;
    g.beginPath();
    g.moveTo(x, mid - r);
    g.lineTo(x + r, mid);
    g.lineTo(x, mid + r);
    g.lineTo(x - r, mid);
    g.fill();
    const room = (i + 1 < seen.length ? X(seen[i + 1].at) - 8 : w) - (x + r + 5);
    if (!m.what || room < 40) return;
    g.save();
    g.beginPath();
    g.rect(x + r + 5, l.y, room, l.h);
    g.clip();
    g.fillStyle = C.ink2;
    g.fillText(m.what, x + r + 5, mid + 1);
    g.restore();
  });
}

function curve(g: CanvasRenderingContext2D, arr: Float32Array, l: Lane, color: string, v0: number, span: number, d: number, w: number) {
  if (!arr.length) return;
  g.beginPath();
  g.moveTo(0, l.y + l.h);
  for (let x = 0; x <= w; x += 2) {
    const i = Math.min(arr.length - 1, Math.max(0, Math.floor(((v0 + (x / w) * span) / d) * arr.length)));
    g.lineTo(x, l.y + l.h - Math.max(0, Math.min(1, arr[i])) * (l.h - 3));
  }
  g.lineTo(w, l.y + l.h);
  g.closePath();
  g.fillStyle = color;
  g.globalAlpha = 0.22;
  g.fill();
  g.globalAlpha = 0.9;
  g.strokeStyle = color;
  g.lineWidth = 1.2;
  g.beginPath();
  for (let x = 0; x <= w; x += 2) {
    const i = Math.min(arr.length - 1, Math.max(0, Math.floor(((v0 + (x / w) * span) / d) * arr.length)));
    const y = l.y + l.h - Math.max(0, Math.min(1, arr[i])) * (l.h - 3);
    if (x === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
  g.globalAlpha = 1;
}

/** drum hits as ticks; the ones just played flash */
function ticks(g: CanvasRenderingContext2D, hits: number[], l: Lane, color: string, size: number, X: (s: number) => number, v0: number, v1: number, t: number) {
  const hh = l.h * size;
  const y = l.y + (l.h - hh) / 2;
  const tw = (v1 - v0) < 40 ? 2 : 1;
  for (const s of hits) {
    if (s < v0 || s > v1) continue;
    const ago = t - s;
    const flash = ago >= 0 && ago < 0.15;
    g.fillStyle = flash ? C.head : color;
    g.fillRect(Math.round(X(s)), flash ? l.y : y, flash ? 3 : tw, flash ? l.h : hh);
  }
}

/** a piano roll: one row per semitone across the notes' range, C rows marked */
function roll(g: CanvasRenderingContext2D, ns: TrackNote[], l: Lane, color: string, X: (s: number) => number, v0: number, v1: number, t: number, w: number) {
  if (!ns.length) return;
  let lo = 127;
  let hi = 0;
  for (const n of ns) {
    lo = Math.min(lo, n.midi);
    hi = Math.max(hi, n.midi);
  }
  lo -= 1;
  hi += 1;
  const rows = hi - lo + 1;
  const rh = l.h / rows;
  // staff: a faint line on each C and on E/G (like a stave), labels on the Cs
  g.textAlign = 'left';
  for (let m = lo; m <= hi; m++) {
    const y = l.y + l.h - (m - lo + 1) * rh;
    const pc = ((m % 12) + 12) % 12;
    if (pc === 0) {
      g.fillStyle = 'rgba(27,27,26,0.16)';
      g.fillRect(0, Math.round(y + rh), w, 1);
      if (rh * 3 > 9) {
        g.fillStyle = C.ink3;
        g.fillText(noteName(m), 3, y + rh / 2 + 0.5);
      }
    } else if ([1, 3, 6, 8, 10].includes(pc)) {
      g.fillStyle = 'rgba(27,27,26,0.03)';
      g.fillRect(0, y, w, rh);
    }
  }
  for (const n of ns) {
    if (n.end < v0 || n.t > v1) continue;
    const x0 = X(n.t);
    const x1 = X(n.end);
    const y = l.y + l.h - (n.midi - lo + 1) * rh;
    const on = t >= n.t && t < n.end;
    g.fillStyle = on ? C.head : color;
    g.globalAlpha = on ? 1 : 0.35 + 0.65 * Math.max(0, Math.min(1, n.v));
    roundRect(g, x0, y + 0.5, Math.max(2, x1 - x0 - 0.5), Math.max(2, rh - 1), Math.min(2, rh / 2));
  }
  g.globalAlpha = 1;
}

function quiet(g: CanvasRenderingContext2D, l: Lane, text: string) {
  g.fillStyle = C.ink3;
  g.textAlign = 'left';
  g.fillText(text, 8, l.y + l.h / 2 + 1);
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
  g.fill();
}
