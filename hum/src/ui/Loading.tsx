import { useEffect, useRef, useState } from 'react';
import { audioEngine } from '../audio/engine';
import { useStudio } from '../state/store';

/**
 * Shown over the stage while a new song is being analysed: the Hum mark breathes with the music
 * (it is already playing) and floats, and rings ripple out on every kick. No text, just the mark.
 */
export function LoadingStage() {
  const track = useStudio((s) => s.track);
  const analyzing = useStudio((s) => s.analyzing);
  const show = !!track && track.source !== 'mic' && analyzing;
  const [mounted, setMounted] = useState(show);
  const ball = useRef<HTMLDivElement>(null);
  const rings = useRef<HTMLDivElement>(null);

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
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const f = audioEngine.frame;
      const target = Math.min(1, f.level * 1.6 + f.kick * 0.5);
      lvl += (target - lvl) * 0.25;
      ball.current?.style.setProperty('--lvl', lvl.toFixed(3));
      const hit = f.kick > 0.7 && prevKick <= 0.5;
      prevKick = f.kick;
      if (hit && rings.current) {
        const r = document.createElement('i');
        rings.current.appendChild(r);
        setTimeout(() => r.remove(), 1300);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [mounted]);

  if (!mounted) return null;
  return (
    <div className={`loading-stage ${show ? 'in' : 'out'}`}>
      <div className="ld-mark">
        <div className="ld-rings" ref={rings}>
          <b />
          <b />
          <b />
        </div>
        <div className="ld-ball" ref={ball} />
      </div>
    </div>
  );
}
