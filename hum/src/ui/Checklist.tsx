import { useRef } from 'react';
import { makeVideo, validPlan } from '../state/plan';
import { useStudio, type StudioState } from '../state/store';
import { handleFiles } from '../state/tracks';
import { changeLyrics } from './lyricsOpen';

type StepId = 'song' | 'clips' | 'lyrics' | 'made' | 'rendered';

interface Step {
  id: StepId;
  label: string;
  /** what it shows after the label: ✓, a count, or — */
  mark: string;
  done: boolean;
  /** optional steps are never the next one (a video needs no footage) */
  optional?: boolean;
  /** said under the row when this is the next step, and on hover */
  next: string;
  tip: string;
}

const LYRICS_DONE = new Set(['found', 'plain', 'instrumental']);

function steps(s: StudioState): Step[] {
  const song = !!s.track && !!s.analysis;
  const clips = s.clips.length + s.photos.filter((p) => !p.builtin).length;
  const lyricsDone = LYRICS_DONE.has(s.lyricsStatus);
  const made = validPlan(s.plan, s.analysis);
  const rendered = !!s.track && s.rendered === s.track;
  return [
    {
      id: 'song',
      label: 'Song',
      mark: song ? '✓' : s.track ? '…' : '—',
      done: song,
      next: s.track ? 'Listening to the song…' : 'Next: choose a song.',
      tip: s.track ? (song ? s.track.name : 'Listening to the song…') : 'Choose a song file',
    },
    {
      id: 'clips',
      label: 'Clips',
      mark: clips ? String(clips) : '—',
      done: clips > 0,
      optional: true,
      next: '',
      tip: clips ? `${s.clips.length} clips and ${clips - s.clips.length} photos of your own. Click to add more.` : 'Add your own clips or photos (optional: Hum’s looks can carry the whole video)',
    },
    {
      id: 'lyrics',
      label: 'Lyrics',
      mark: lyricsDone ? '✓' : s.lyricsStatus === 'searching' ? '…' : '—',
      done: lyricsDone,
      // once the video is made, missing words aren't what's next any more (plenty of videos go without)
      optional: made,
      next: s.lyricsStatus === 'searching' ? 'Looking for the words…' : 'Next: add the lyrics (or make the video without them).',
      tip: s.lyricsStatus === 'found' ? 'Synced lyrics. Click to change them.' : s.lyricsStatus === 'plain' ? 'Words without timing. Click to change them.' : s.lyricsStatus === 'instrumental' ? 'No words: an instrumental.' : s.lyricsStatus === 'searching' ? 'Looking for the words…' : 'No lyrics yet. Click to add them.',
    },
    {
      id: 'made',
      label: 'Made',
      mark: made ? '✓' : s.planning ? '…' : '—',
      done: made,
      next: s.planning ? 'Making the video…' : 'Next: make the video.',
      tip: made ? 'The video is made. Remake it with the button below.' : 'Make the video',
    },
    {
      id: 'rendered',
      label: 'Rendered',
      mark: rendered ? '✓' : '—',
      done: rendered,
      next: 'Next: render it to a file in the Render tab.',
      tip: rendered ? 'Saved to a file this visit. Click to render again.' : 'Render it to a file',
    },
  ];
}

/**
 * Where the video stands, at the top of the Video tab: Song · Clips · Lyrics · Made · Rendered, the next
 * one marked and said under the row. Each step goes where it's done (a file picker, the lyrics, Make, the
 * Render tab).
 */
export function Checklist() {
  // redrawn only when what the row says changes (the store changes many times a second while it plays)
  useStudio((st) => `${steps(st).map((x) => x.mark + x.tip).join('|')}|${!!st.clip}|${st.planning}|${!!st.analysis?.sections.length}`);
  const s = useStudio.getState();
  const songInput = useRef<HTMLInputElement>(null);
  const clipInput = useRef<HTMLInputElement>(null);
  const list = steps(s);
  const next = list.find((x) => !x.done && !x.optional);
  const busy = !!s.clip || s.planning;

  const go = (id: StepId) => {
    const st = useStudio.getState();
    if (id === 'song') return songInput.current?.click();
    // with no song yet a video would become the song, so clips wait for one
    if (id === 'clips') return st.track ? clipInput.current?.click() : songInput.current?.click();
    if (id === 'lyrics') return changeLyrics();
    if (id === 'made') return void makeVideo('', { fresh: validPlan(st.plan, st.analysis) });
    st.set({ inspectorTab: 'render' });
  };
  const canGo = (x: Step) => {
    if (busy) return false;
    if (x.id === 'song') return !s.track;
    if (x.id === 'lyrics') return !!s.analysis;
    if (x.id === 'made') return !x.done && !!s.analysis?.sections.length;
    if (x.id === 'rendered') return validPlan(s.plan, s.analysis);
    return true;
  };

  return (
    <div className="vp-check">
      <ol className="vp-steps" aria-label="Where the video stands">
        {list.map((x) => (
          <li key={x.id}>
            <button
              type="button"
              className={`vp-stepbtn ${x.done ? 'done' : ''} ${next?.id === x.id ? 'next' : ''}`}
              disabled={!canGo(x)}
              onClick={() => go(x.id)}
              title={x.tip}
              aria-label={`${x.label}: ${x.tip}`}
            >
              <span>{x.label}</span>
              <b>{x.mark}</b>
            </button>
          </li>
        ))}
      </ol>
      {next?.next && <p className="vp-nextstep">{next.next}</p>}
      <input
        ref={songInput}
        type="file"
        accept="audio/*,video/*,.hum"
        hidden
        onChange={(e) => {
          if (e.target.files) void handleFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={clipInput}
        type="file"
        accept="video/*,image/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void handleFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
