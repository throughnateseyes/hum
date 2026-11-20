import { useEffect, useRef, useState } from 'react';
import { audioEngine } from '../audio/engine';
import { tapToPlay } from '../state/oneTap';
import { useStudio } from '../state/store';
import { Play } from './Icons';

/** the mark's own breath while the song waits silently (one-tap start plays it once it's planned) */
const IDLE_BEAT = 60 / 96;

/**
 * Shown over the stage while a new song is being analysed: the Hum mark breathes with the music and
 * floats, and rings ripple out on every kick. With one-tap start (the song waits at 0:00 until its
 * video is planned) the mark breathes on a slow beat of its own, and one calm line under it says
 * what's happening, with a thin bar that paces itself by the song's length. The lyrics lookup that
 * runs alongside gets a quiet second line, never a toast.
 */
export function LoadingStage() {
  const track = useStudio((s) => s.track);
  const analyzing = useStudio((s) => s.analyzing);
  const startup = useStudio((s) => s.startup);
  const lyricsStatus = useStudio((s) => s.lyricsStatus);
  const show = !!track && track.source !== 'mic' && (analyzing || !!startup);
  const [mounted, setMounted] = useState(show);
  const ball = useRef<HTMLDivElement>(null);
  const rings = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLElement>(null);

  // stay mounted briefly after analysis ends so it can fade out
  useEffect(() => {
    if (show) {
      setMounted(true);
      return;
    }
    const id = setTimeout(() => setMounted(false), 450);
    return () => clearTimeout(id);
  }, [show]);

  useEffect(() => {
    if (!mounted) return;
    let raf = 0;
    let lvl = 0;
    let prevKick = 0;
    let beat = -1;
    const t0 = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const f = audioEngine.frame;
      let target = Math.min(1, f.level * 1.6 + f.kick * 0.5);
      let hit = f.kick > 0.7 && prevKick <= 0.5;
      prevKick = f.kick;
      if (!audioEngine.playing) {
        // silent while it waits: a slow breath of its own, a ring every other beat
        const t = (now - t0) / 1000;
        const b = Math.floor(t / IDLE_BEAT);
        const phase = (t % IDLE_BEAT) / IDLE_BEAT;
        target = 0.12 + 0.4 * Math.exp(-phase * 4) * (b % 2 === 0 ? 1 : 0.45);
        hit = b !== beat && b % 2 === 0;
        beat = b;
      }
      lvl += (target - lvl) * 0.25;
      ball.current?.style.setProperty('--lvl', lvl.toFixed(3));
      if (hit && rings.current) {
        const r = document.createElement('i');
        rings.current.appendChild(r);
        setTimeout(() => r.remove(), 1300);
      }
      // the bar: eases toward where this step should be by now, never quite reaching the end
      const st = useStudio.getState().startup;
      if (bar.current && st) {
        const secs = (now - st.since) / 1000;
        // about 4% of the song's length to analyse on a computer, more on a phone; planning is quick
        const est = st.step === 'listen' ? Math.max(1.5, (st.duration || 180) * (coarse ? 0.07 : 0.04)) : 1.2;
        const k = 1 - Math.exp(-secs / est);
        const p = st.step === 'listen' ? 0.06 + 0.74 * k : 0.82 + 0.16 * k;
        bar.current.style.transform = `scaleX(${p.toFixed(3)})`;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [mounted]);

  if (!mounted) return null;
  const step = startup?.step ?? 'listen';
  const lyricLine = track?.source === 'file' ? (lyricsStatus === 'searching' ? 'Finding the lyrics' : lyricsStatus === 'found' || lyricsStatus === 'plain' ? 'Lyrics found' : '') : '';
  return (
    <div className={`loading-stage ${show ? 'in' : 'out'} ${startup ? 'with-steps' : ''}`} role="status" aria-live="polite">
      <div className="ld-mark">
        <div className="ld-rings" ref={rings}>
          <b />
          <b />
          <b />
        </div>
        <div className="ld-ball" ref={ball} />
      </div>
      {startup && (
        <div className="ld-steps">
          <span className="ld-now">{step === 'listen' ? 'Listening to the song' : 'Planning the video'}</span>
          <span className="ld-bar">
            <i ref={bar} />
          </span>
          <span className="ld-sub">{lyricLine || ' '}</span>
        </div>
      )}
    </div>
  );
}

const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

/**
 * The song is planned but the browser wouldn't start sound without a tap (autoplay rules): one big
 * play button over the picture. One tap plays the video from the top.
 */
export function TapToPlay() {
  const needs = useStudio((s) => s.needsTap);
  const startup = useStudio((s) => s.startup);
  if (!needs || startup) return null;
  return (
    <button className="tap-play" onClick={() => void tapToPlay()} aria-label="Play the video">
      <span className="tap-play-ring">
        <Play width={30} height={30} style={{ marginLeft: 4 }} />
      </span>
      <span className="tap-play-l">Tap to play</span>
    </button>
  );
}
