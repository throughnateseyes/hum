import { useCallback, useEffect, useRef, useState } from 'react';
import { audioEngine } from '../audio/engine';
import { indexAt } from '../audio/lyrics';
import { useStudio } from '../state/store';
import { saveLyrics, tapLine } from '../state/tracks';

/** people tap a little after they hear a line start */
const REACTION = 0.12;

/**
 * Fix lyric timing by tapping: play the song and tap (or press Space) as each line starts. Each tap
 * moves that line, and every line after it, by the same amount, so a few taps fix any drift.
 */
export function TapSync() {
  const open = useStudio((s) => s.tapSync);
  const lyrics = useStudio((s) => s.lyrics);
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [next, setNext] = useState(0);
  const [taps, setTaps] = useState(0);
  const flash = useRef<HTMLButtonElement>(null);

  const lines = lyrics?.lines ?? [];
  /** the next line to tap: the first one that hasn't started yet */
  const nextFrom = useCallback((t: number) => Math.min(lines.length - 1, Math.max(0, indexAt(lines, t + 0.15) + 1)), [lines]);

  // follow the playhead (a timer, so it keeps going when the page is in the background)
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => {
      setNow(audioEngine.currentTime);
      setPlaying(audioEngine.playing);
    }, 50);
    return () => clearInterval(id);
  }, [open]);
  useEffect(() => {
    if (open) {
      setNext(nextFrom(audioEngine.currentTime));
      setTaps(0);
    }
    // only when the panel opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const tap = useCallback(() => {
    const t = Math.max(0, audioEngine.currentTime - REACTION);
    const i = next;
    if (i < 0 || i >= lines.length) return;
    tapLine(i, t);
    setNext(Math.min(lines.length - 1, i + 1));
    setTaps((n) => n + 1);
    const b = flash.current;
    if (b) {
      b.classList.remove('hit');
      void b.offsetWidth;
      b.classList.add('hit');
    }
  }, [next, lines.length]);

  const close = useCallback(() => {
    saveLyrics();
    useStudio.getState().set({ tapSync: false });
    if (taps) useStudio.getState().flash('Timing saved');
  }, [taps]);

  // Space taps while the panel is open (instead of play/pause); Esc closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!e.repeat) tap();
      } else if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, tap, close]);

  if (!open || !lines.length) return null;
  const cur = indexAt(lines, now);
  const singing = cur >= 0 && now < lines[cur].end ? lines[cur] : null;
  const upcoming = lines[next];
  const after = lines[next + 1];
  const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

  return (
    <div className="tap" role="dialog" aria-label="Tap lyric timing">
      <div className="tap-head">
        <b>Tap timing</b>
        <span>Tap or press Space as each line starts</span>
        <button className="btn sm ghost" onClick={close}>
          Done
        </button>
      </div>
      <div className="tap-lines">
        <div className="tap-now">{singing ? singing.text : '…'}</div>
        <div className="tap-next">
          <span className="tap-k">Next · line {next + 1} of {lines.length}</span>
          {upcoming?.text}
        </div>
        {after && <div className="tap-after">{after.text}</div>}
      </div>
      <div className="tap-ctrl">
        <button
          className="btn sm"
          onClick={() => {
            const t = Math.max(0, audioEngine.currentTime - 5);
            audioEngine.seek(t);
            setNext(nextFrom(t));
          }}
        >
          Back 5 s
        </button>
        <button className="btn sm" onClick={() => (audioEngine.playing ? audioEngine.pause() : void audioEngine.play())}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <span className="tap-time">{fmt(now)}</span>
        <button className="tap-btn" ref={flash} onClick={tap} disabled={!upcoming}>
          Tap
        </button>
        <button className="btn sm ghost" onClick={() => setNext((n) => Math.max(0, n - 1))} disabled={next === 0}>
          Previous line
        </button>
        <button className="btn sm ghost" onClick={() => setNext((n) => Math.min(lines.length - 1, n + 1))} disabled={next >= lines.length - 1}>
          Skip line
        </button>
      </div>
    </div>
  );
}
