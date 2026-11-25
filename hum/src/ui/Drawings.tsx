/**
 * Drawings, on the Video tab (DrawingsSection) and in the Library (DrawingsTab): one button that draws the
 * song, what is being drawn right now, the drawings themselves, and what can be done with each.
 *
 * Only there for people whose access includes drawings (useCanDraw); everyone else never sees a trace.
 */
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useAllDrawings, useCanDraw, useDrawingsHere } from '../draw/hooks';
import { inksOn } from '../draw/inks';
import { cancelDrawing, cancelJob, canRedraw, drawSong, justDrawn, redraw, retryJob, SET_SIZE, useDrawJobs, type DrawJob, type JobState } from '../draw/jobs';
import { kindOf } from '../draw/kinds';
import { drawPartAt } from '../draw/parts';
import { deleteDrawing, setDrawParts, setInSong, songName } from '../draw/session';
import type { DrawingAsset } from '../draw/types';
import { getScene } from '../scenes';
import { shotOfPart } from '../shot/partShots';
import { setPartsLook, setPartsShot } from '../state/partEdit';
import { findLook, listNames, partNames, pickLook, validPlan } from '../state/plan';
import { undo } from '../state/history';
import { useStudio } from '../state/store';
import { Section, SwitchRow } from './controls';
import './drawings.css';
import { DrawnHere, placedIn } from './DrawnHere';
import { hereTarget, showMediaNote, targetWords } from './footageMedia';
import { X } from './Icons';

/** the look each kind of drawing is the whole picture of */
const PICTURE: Record<string, { id: string; name: string }> = {
  pen: { id: 'sketchbook', name: 'Sketchbook' },
  figure: { id: 'line-figures', name: 'Line figures' },
};
const playsKind = (lookId: string, kind: string) => {
  const s = getScene(findLook(lookId)?.sceneId ?? '');
  return kind === 'figure' ? !!s?.usesFigures || !!s?.usesDrawings : !!s?.usesDrawings;
};
/** how many more one press of "Draw more" makes */
const MORE = 4;

/* ───────────────────────── the picture on a tile ───────────────────────── */

/**
 * A drawing by the real pen, in the video's colours. A new one draws itself on; hovering or focusing the
 * tile draws it again.
 */
export function DrawThumb({ d, replay }: { d: DrawingAsset; replay: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const palette = useStudio((s) => s.palette);
  const inView = useRef(replay);
  useEffect(() => {
    const c = ref.current;
    const g = c?.getContext('2d');
    const kind = kindOf(d.kind);
    if (!c || !g || !kind) return;
    const px = Math.round(Math.max(96, c.clientWidth * Math.min(2, window.devicePixelRatio || 1)));
    c.width = c.height = px;
    const inks = inksOn(palette.bg, palette);
    const pad = px * 0.11;
    const paint = (progress: number, boil: number) => {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, px, px);
      kind.paint(g, d.data, { seed: d.seed, hand: d.style.hand, boil, progress, box: { x: pad, y: pad, w: px - pad * 2, h: px - pad * 2 }, inks, colour: d.style.colour, paper: palette.bg, fat: 1.5, tooth: 1 });
    };
    const seconds = kind.seconds(d.data);
    const fresh = justDrawn.get(d.id);
    const asked = replay !== inView.current;
    inView.current = replay;
    const from = asked ? performance.now() : fresh;
    if (from === undefined || performance.now() - from > seconds * 1000) {
      paint(1, 0);
      return;
    }
    let raf = 0;
    const tick = () => {
      const p = (performance.now() - from) / 1000 / seconds;
      paint(Math.min(1, p), Math.floor(p * seconds * 8));
      if (p < 1) raf = requestAnimationFrame(tick);
      else paint(1, 0);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [d, palette, replay]);
  return <canvas ref={ref} className="dr-canvas" style={{ background: palette.bg }} aria-hidden />;
}

function Tile({ d, on, busy, onPick }: { d: DrawingAsset; on: boolean; busy?: DrawJob; onPick: () => void }) {
  const [replay, setReplay] = useState(0);
  return (
    <button type="button" className={`dr-tile ${on ? 'on' : ''}`} aria-pressed={on} title={d.name} onClick={onPick} onMouseEnter={() => setReplay((x) => x + 1)}>
      <span className="dr-pic">
        <DrawThumb d={d} replay={replay} />
        {busy && <span className="dr-veil">{busy.state === 'failed' ? 'Didn’t work' : <span className="spin" />}</span>}
      </span>
      <span className="dr-name">{d.name}</span>
    </button>
  );
}

const DOING: Record<Exclude<JobState, 'failed'>, string> = { waiting: 'Waiting', drawing: 'Drawing', checking: 'Checking', fixing: 'Touching up' };

function JobTile({ j }: { j: DrawJob }) {
  const failed = j.state === 'failed';
  return (
    <div className={`dr-tile job ${failed ? 'failed' : ''}`} title={failed ? j.error : j.idea.why}>
      <span className="dr-pic">
        <span className="dr-state">
          {j.state === 'failed' ? (
            <button type="button" className="btn sm" onClick={() => retryJob(j.id)}>
              Try again
            </button>
          ) : (
            <>
              {j.state !== 'waiting' && <span className="spin" />}
              {DOING[j.state]}
            </>
          )}
        </span>
        <button type="button" className="lib-tile-del" onClick={() => cancelJob(j.id)} aria-label={failed ? `Remove ${j.idea.name}` : `Don’t draw ${j.idea.name}`} title={failed ? 'Remove' : 'Don’t draw this one'}>
          <X width={11} height={11} aria-hidden />
        </button>
      </span>
      <span className="dr-name">{j.idea.name}</span>
    </div>
  );
}

/* ───────────────────────── a shelf, and the drawing picked on it ───────────────────────── */

function Shelf({ list, jobs = [], elsewhere = false }: { list: DrawingAsset[]; jobs?: DrawJob[]; elsewhere?: boolean }) {
  const [picked, setPicked] = useState<string | null>(null);
  // one that was drawn again is still the one picked
  const d = picked === null ? undefined : (list.find((x) => x.id === picked) ?? list.find((x) => x.from === picked));
  const tiles = [...list].sort((a, b) => a.added - b.added);
  const failed = jobs.find((j) => j.state === 'failed' && !j.from);
  if (!tiles.length && !jobs.length) return null;
  return (
    <>
      <div className="dr-grid">
        {tiles.map((x) => (
          <Tile key={x.id} d={x} on={x === d} busy={jobs.find((j) => j.from === x.id)} onPick={() => setPicked(x === d ? null : x.id)} />
        ))}
        {jobs
          .filter((j) => !j.from || !tiles.some((x) => x.id === j.from))
          .map((j) => (
            <JobTile key={j.id} j={j} />
          ))}
      </div>
      {failed?.error && <p className="field-note">{failed.error}</p>}
      {d && <Detail key={d.id} d={d} elsewhere={elsewhere} job={jobs.find((j) => j.from === d.id)} />}
    </>
  );
}

const NOTES = ['Simpler', 'More detail', 'From the side', 'Bolder'];

function Detail({ d, elsewhere, job }: { d: DrawingAsset; elsewhere: boolean; job?: DrawJob }) {
  const [again, setAgain] = useState(false);
  const [note, setNote] = useState('');
  const send = (text: string) => {
    redraw(d.id, text);
    setAgain(false);
    setNote('');
  };
  return (
    <div className="dr-detail">
      <b>{d.name}</b>
      {d.why && <p>{d.why}</p>}
      {job && job.state !== 'failed' && (
        <p className="dr-busy">
          <span className="spin" /> Drawing it again
          <button type="button" className="dr-link" onClick={() => cancelJob(job.id)}>
            Stop
          </button>
        </p>
      )}
      {job?.state === 'failed' && (
        <p className="dr-busy">
          {job.error}
          <button type="button" className="dr-link" onClick={() => retryJob(job.id)}>
            Try again
          </button>
        </p>
      )}
      {again ? (
        <form
          className="dr-again"
          onSubmit={(e) => {
            e.preventDefault();
            send(note);
          }}
        >
          <div className="dr-row">
            {NOTES.map((n) => (
              <button key={n} type="button" className="chip" onClick={() => send(n)}>
                {n}
              </button>
            ))}
          </div>
          <input className="txt" autoFocus maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Or say what to change" aria-label="What to change" />
          <div className="dr-row">
            <button type="submit" className="btn sm primary">
              Draw again
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setAgain(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="dr-row">
          {elsewhere ? (
            <InSong d={d} />
          ) : (
            <UseInParts d={d} />
          )}
          {canRedraw(d) && !elsewhere && (!job || job.state === 'failed') && (
            <button type="button" className="btn sm" onClick={() => setAgain(true)}>
              Draw again
            </button>
          )}
          {!elsewhere && (
            <button type="button" className="btn sm ghost" onClick={() => setInSong(d.id, false)} title="It stays in the Library for other songs">
              Take out
            </button>
          )}
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              deleteDrawing(d.id);
              showMediaNote(`${d.name} deleted`, { label: 'Undo', run: undo });
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

function InSong({ d }: { d: DrawingAsset }) {
  const song = useStudio(songName);
  if (!song) return null;
  return (
    <button type="button" className="btn sm" onClick={() => setInSong(d.id, true)}>
      Use in this song
    </button>
  );
}

/** "Use for this shot": make it the picture of the picked parts (or the one playing) wherever a look made of drawings plays */
function UseInParts({ d }: { d: DrawingAsset }) {
  // the parts and the plan decide whether there is anywhere to put it
  useStudio((s) => s.selectedParts);
  const parts = useStudio((s) => s.drawParts);
  const a = useStudio((s) => s.analysis);
  const plan = useStudio((s) => s.plan);
  useStudio((s) => s.planOn);
  useStudio((s) => s.partShot);
  if (!a || !validPlan(plan, a)) return null;
  const target = hereTarget();
  if (target === 'solo') return null;
  // a shot the footage is a place in takes it as something standing there
  const places = target.parts.filter((i) => shotOfPart(i)?.style === 'inside');
  if (places.length === target.parts.length) {
    const stands = places.every((i) => shotOfPart(i)?.drawn?.id === d.id);
    return (
      <button
        type="button"
        className="btn sm"
        onClick={() => {
          const t = hereTarget();
          if (t === 'solo') return;
          setPartsShot(t.parts, { drawn: stands ? null : { id: d.id, put: 'between', size: 'medium', enter: 'draw' } });
          if (!stands) showMediaNote(`${d.name} stands in ${t.parts.length > 1 ? `${t.parts.length} shots` : 'this shot'}`);
        }}
      >
        {stands ? `Take out of ${targetWords(target)}` : `Use for ${targetWords(target)}`}
      </button>
    );
  }
  const spans = target.parts.map((i) => a.sections[i]);
  const own = spans.every((p) => drawPartAt(parts, (p.start + p.end) / 2)?.ids?.includes(d.id));
  if (own)
    return (
      <button type="button" className="btn sm" title="Hum chooses the drawings here again" onClick={() => setDrawParts(spans, { ids: undefined })}>
        Don’t use for {targetWords(target)}
      </button>
    );
  return (
    <button
      type="button"
      className="btn sm"
      title="⌘-click adds it to the ones chosen there"
      onClick={(e) => {
        // asked again at the click: the part that plays has moved on since this was drawn
        const t = hereTarget();
        if (t === 'solo') return;
        const at = t.parts.map((i) => a.sections[i]);
        const was = e.metaKey || e.ctrlKey ? (drawPartAt(useStudio.getState().drawParts, (at[0].start + at[0].end) / 2)?.ids ?? []) : [];
        setDrawParts(at, { ids: [...was.filter((x) => x !== d.id), d.id] });
        const names = partNames(a);
        const no = t.parts.filter((i) => !playsKind(plan?.looks[i] ?? '', d.kind));
        const who = (is: number[]) => (is.length > 2 ? `${is.length} parts` : listNames(is.map((i) => names[i])));
        if (!no.length) showMediaNote(`${d.name} is the picture of ${who(t.parts)}`);
        else
          showMediaNote(`${who(no)} ${no.length > 1 ? 'don’t' : 'doesn’t'} play a look made of drawings yet.`, {
            label: `Switch to ${PICTURE[d.kind].name}`,
            run: () => setPartsLook(no, PICTURE[d.kind].id),
          });
      }}
    >
      Use for {targetWords(target)}
    </button>
  );
}

/* ───────────────────────── the button and the progress ───────────────────────── */

const working = (j: DrawJob) => j.state !== 'failed';

/** why the song can't be drawn yet, or null */
function useNotYet(): string | null {
  return useStudio((s) =>
    !s.track
      ? 'Load a song first.'
      : s.track.source === 'mic'
        ? 'Drawings need a song file, not live sound.'
        : !s.analysis
          ? 'Listening to the song…'
          : s.lyricsStatus === 'searching'
            ? 'Looking for the words…'
            : null,
  );
}

/** "3 of 8 drawn", while something is being drawn */
function Progress() {
  const thinking = useDrawJobs((s) => s.thinking);
  const done = useDrawJobs((s) => s.done);
  const total = useDrawJobs((s) => s.total);
  const busy = useDrawJobs((s) => s.jobs.filter(working).length);
  const other = useDrawJobs((s) => s.jobs.find(working)?.song);
  const song = useStudio(songName);
  if (!thinking && !busy) return null;
  return (
    <div className="dr-progress" role="status">
      <span className="spin" />
      <span className="dr-grow">
        {thinking && !busy ? 'Choosing what to draw' : `${done} of ${total} drawn`}
        {other && other !== song ? ` for ${other}` : ''}
      </span>
      <button type="button" className="btn sm ghost" onClick={cancelDrawing}>
        Stop
      </button>
    </div>
  );
}

/** what a press of the button makes; kept while the app is open */
const useDrawStyle = create<{ kind: 'pen' | 'figure' }>(() => ({ kind: 'pen' }));

function DrawButton({ wide = false }: { wide?: boolean }) {
  const list = useDrawingsHere();
  const kind = useDrawStyle((s) => s.kind);
  const here = list.filter((d) => d.kind === kind).length;
  const busy = useDrawJobs((s) => s.thinking || s.jobs.some(working));
  const error = useDrawJobs((s) => s.error);
  const notYet = useNotYet();
  if (busy) return null;
  return (
    <>
      <div className="seg full dr-style" role="group" aria-label="Kind of drawing">
        {(['pen', 'figure'] as const).map((k) => (
          <button key={k} type="button" className={k === kind ? 'on' : ''} aria-pressed={k === kind} onClick={() => useDrawStyle.setState({ kind: k })}>
            {k === 'pen' ? 'Pen' : 'Line figures'}
          </button>
        ))}
      </div>
      <button type="button" className={`btn ${wide || !list.length ? 'dr-wide' : ''}`} disabled={!!notYet} onClick={() => void drawSong({ kind, ...(here ? { count: MORE } : {}) })}>
        {here ? `Draw ${MORE} more` : 'Draw this song'}
      </button>
      {error ? (
        <p className="field-note dr-error">{error}</p>
      ) : notYet ? (
        <p className="field-note">{notYet}</p>
      ) : (
        !here && (
          <p className="field-note">
            {kind === 'pen'
              ? `Claude picks about ${SET_SIZE} things that belong to this song and draws each one in pen. It takes a few minutes, and you can carry on meanwhile.`
              : `Claude picks about ${SET_SIZE} things that belong to this song and builds each one as a small 3D figure whose parts move on the beat. It takes longer than pen, and you can carry on meanwhile.`}
          </p>
        )
      )}
    </>
  );
}

/* ───────────────────────── where they show ───────────────────────── */

function useJobsHere(): DrawJob[] {
  const song = useStudio(songName);
  const jobs = useDrawJobs((s) => s.jobs);
  return jobs.filter((j) => j.song === song || (j.from !== undefined && !!song));
}

/** the Video tab's section */
export function DrawingsSection() {
  return useCanDraw() ? <Panel /> : null;
}

function Panel() {
  const here = useDrawingsHere();
  const jobs = useJobsHere();
  const overlay = useStudio((s) => s.drawOverlay);
  const inScene = useStudio((s) => s.drawInScene);
  useStudio((s) => s.plan);
  useStudio((s) => s.partShot);
  const stand = new Set(placedIn(useStudio.getState()).map((p) => p.drawn.id)).size;
  // the kinds this song has whose own look isn't already up
  const sceneId = useStudio((s) => s.sceneId);
  const sc = getScene(sceneId);
  const shows = Object.keys(PICTURE).filter((k) => here.some((d) => d.kind === k) && !(k === 'figure' ? sc?.usesFigures : sc?.usesDrawings));
  return (
    <Section id="video.drawings" title="Drawings" sub="Made for this song. They draw themselves as it plays." value={jobs.some((j) => j.state !== 'failed') ? 'Drawing…' : stand ? `${stand} in this video` : here.length ? `${here.length} made` : inScene ? 'On' : 'Off'} collapsible defaultOpen={false}>
      <div className="dr-panel">
        <Progress />
        <DrawnHere thumb={(d) => <DrawThumb d={d} replay={0} />} />
        <Shelf list={here} jobs={jobs} />
        <SwitchRow
          label="Draw into the scene"
          note="When you make a video from your footage, Claude picks a few drawings with a job in the story, uses yours where they fit, and stands them in the shots"
          on={inScene}
          onChange={(v) => useStudio.getState().set({ drawInScene: v })}
        />
        {here.length > 0 && (
          <>
            <SwitchRow label="Beside the words" note="A small one comes up with the line it belongs to" on={overlay} onChange={(v) => useStudio.getState().set({ drawOverlay: v })} />
            {overlay && <PartSwitch />}
          </>
        )}
        <div className={here.length ? 'dr-row' : ''}>
          {shows.map((k) => (
            <button
              key={k}
              type="button"
              className="btn"
              title="The drawings become the picture, with the words beside them"
              onClick={() => {
                const p = findLook(PICTURE[k].id);
                if (p) pickLook(p);
              }}
            >
              {shows.length > 1 || k === 'figure' ? `Show ${PICTURE[k].name}` : 'Show as the picture'}
            </button>
          ))}
          <DrawButton />
        </div>
      </div>
    </Section>
  );
}

/** with parts picked on the timeline: drawings beside the words, there only */
function PartSwitch() {
  const a = useStudio((s) => s.analysis);
  const sel = useStudio((s) => s.selectedParts);
  const parts = useStudio((s) => s.drawParts);
  const picked = a ? sel.filter((i) => i >= 0 && i < a.sections.length) : [];
  if (!a || !picked.length) return null;
  const spans = picked.map((i) => a.sections[i]);
  const names = partNames(a);
  const on = !spans.every((p) => drawPartAt(parts, (p.start + p.end) / 2)?.off);
  return <SwitchRow label={`Also in ${picked.length > 2 ? `these ${picked.length} parts` : listNames(picked.map((i) => names[i]))}`} on={on} onChange={(v) => setDrawParts(spans, { off: !v })} />;
}

/** the Library's shelf */
export function DrawingsTab() {
  const here = useDrawingsHere();
  const all = useAllDrawings();
  const jobs = useJobsHere();
  const others = all.filter((d) => !here.includes(d));
  return (
    <>
      <div className="lib-head">
        <p className="lib-note">Drawings made for your songs. Click one to use it, draw it again or use it in another song.</p>
        <Progress />
        <DrawButton wide />
      </div>
      <div className="dr-panel">
        <Shelf list={here} jobs={jobs} />
      </div>
      {others.length > 0 && (
        <>
          <div className="section-h">
            <span className="label">From other songs</span>
            <span className="label">{others.length}</span>
          </div>
          <div className="dr-panel">
            <Shelf list={others} elsewhere />
          </div>
        </>
      )}
    </>
  );
}
