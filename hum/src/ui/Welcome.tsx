/**
 * The start screen: the island that sits on the stage before there's a song.
 *
 * Branded with the Hum mark (the blue sphere) sending halftone ripples through a field of glyphs
 * (the blue glyph-mosaic texture the looks use), on a beat of its own so it moves before any music
 * plays. Choosing audio is the one big action; demos, the microphone and a tab are quiet extras.
 */
import { useEffect, useRef } from 'react';
import { DEMO_TRACKS } from '../audio/demoTracks';
import { useStudio } from '../state/store';
import { canListenToTab, handleFiles, loadDemo, useMic, useTab } from '../state/tracks';
import { BrowserTab, Mic, Upload } from './Icons';

/** the island's own tempo: a relaxed 112 bpm */
const BEAT = 60 / 112;
const TAGS = ['sub', 'kick', 'air', 'drop'];

export function Welcome() {
  const card = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLCanvasElement>(null);
  const mark = useRef<HTMLDivElement>(null);
  const rings = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  /** 0 → 1: how excited the field is (hovering the button, a file over the page) */
  const heat = useRef(0);
  const hot = useRef(false);

  useEffect(() => {
    const cv = field.current!;
    const box = card.current!;
    const ctx = cv.getContext('2d')!;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let W = 0;
    let H = 0;
    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = box.clientWidth;
      H = box.clientHeight;
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);

    // ripples start at the mark, one per beat
    const ripples: number[] = [];
    let beat = -1;
    let beat2 = -1;
    const t0 = performance.now();
    const CELL = 11;
    // a fixed shape for each cell, so the mosaic reads as glyphs and not noise
    const hash = (x: number, y: number) => {
      const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
      return s - Math.floor(s);
    };

    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      const dragging = document.querySelector('.app.dropzone-over') !== null;
      const want = dragging ? 1 : hot.current ? 0.65 : 0;
      heat.current += (want - heat.current) * 0.08;
      const h = heat.current;

      // the beat: tags light in turn, the mark pulses, a ring and a ripple go out
      const b = Math.floor(t / BEAT);
      const phase = (t % BEAT) / BEAT;
      if (b !== beat) {
        beat = b;
        box.dataset.tag = String(b % TAGS.length);
      }
      // a ripple and a ring only every other beat: it should breathe, not shout
      if (b !== beat2 && b % 2 === 0) {
        beat2 = b;
        ripples.push(t);
        if (ripples.length > 3) ripples.shift();
        if (rings.current && !still) {
          const r = document.createElement('i');
          rings.current.appendChild(r);
          window.setTimeout(() => r.remove(), 1400);
        }
      }
      const pulse = Math.exp(-phase * 5) * (b % 2 === 0 ? 1 : 0.4);
      mark.current?.style.setProperty('--lvl', (pulse * (0.35 + h * 0.5)).toFixed(3));
      box.style.setProperty('--pulse', pulse.toFixed(3));

      // the mark's centre, in the card's space
      const mr = mark.current?.getBoundingClientRect();
      const cr = box.getBoundingClientRect();
      const mx = mr ? mr.left - cr.left + mr.width / 2 : W - 60;
      const my = mr ? mr.top - cr.top + mr.height / 2 : 50;
      // the field lives in the band above the button, so the small print stays on clean paper
      const btn = box.querySelector('.wl-choose')?.getBoundingClientRect();
      const floor = btn ? btn.top - cr.top + btn.height * 0.5 : H * 0.55;

      ctx.clearRect(0, 0, W, H);
      const reach = Math.hypot(W, H) * (0.4 + h * 0.3);
      for (let y = CELL / 2; y < floor; y += CELL) {
        const band = Math.min(1, (floor - y) / 34);
        for (let x = CELL / 2; x < W; x += CELL) {
          const d = Math.hypot(x - mx, y - my);
          if (d > reach) continue;
          // falls off away from the mark, so the words stay on clean paper
          const fall = Math.max(0, 1 - d / reach);
          let v = 0.3 + 0.3 * Math.sin(x * 0.045 + t * 0.5) * Math.cos(y * 0.06 - t * 0.35);
          for (const rt of ripples) {
            const r = (t - rt) * 170;
            const age = Math.max(0, 1 - (t - rt) / 2.4);
            v += Math.exp(-(((d - r) / 18) ** 2)) * 0.5 * age;
          }
          v = Math.min(1, v * (0.5 + h * 0.7)) * fall * fall * band;
          if (v < 0.08) continue;
          const k = hash(x, y);
          const s = CELL * (0.18 + v * 0.42);
          ctx.fillStyle = `rgba(47, 75, 255, ${((0.18 + v * 0.5) * (1 + h * 0.6)).toFixed(3)})`;
          ctx.strokeStyle = ctx.fillStyle;
          ctx.lineWidth = 1.4;
          if (h > 0.5 && v > 0.62 && k > 0.45) {
            ctx.fillRect(x - s, y - s, s * 2, s * 2); // solid tile
          } else if (k < 0.34) {
            ctx.beginPath(); // plus
            ctx.moveTo(x - s, y);
            ctx.lineTo(x + s, y);
            ctx.moveTo(x, y - s);
            ctx.lineTo(x, y + s);
            ctx.stroke();
          } else if (k < 0.6) {
            ctx.beginPath(); // cross
            ctx.moveTo(x - s * 0.8, y - s * 0.8);
            ctx.lineTo(x + s * 0.8, y + s * 0.8);
            ctx.moveTo(x + s * 0.8, y - s * 0.8);
            ctx.lineTo(x - s * 0.8, y + s * 0.8);
            ctx.stroke();
          } else {
            ctx.beginPath(); // dot
            ctx.arc(x, y, s * 0.75, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    };

    let raf = 0;
    if (still) draw(t0 + 600);
    else {
      const loop = (now: number) => {
        raf = requestAnimationFrame(loop);
        if (document.hidden) return;
        draw(now);
      };
      raf = requestAnimationFrame(loop);
    }
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <div className="welcome" ref={card}>
      <canvas className="wl-field" ref={field} aria-hidden />
      <div className="wl-grain" aria-hidden />

      <div className="wl-head">
        <div>
          <h2 className="wl-word">hum</h2>
          <p className="wl-tags" aria-label="Hum listens for the sub, the kick, the air and the drop, then paints with them">
            <span>listens for the</span>
            {TAGS.map((t, i) => (
              <b key={t} data-i={i}>
                {t}
              </b>
            ))}
          </p>
        </div>
        <div className="wl-mark" aria-hidden>
          <div className="wl-rings" ref={rings} />
          <div className="ld-ball wl-ball" ref={mark} />
        </div>
      </div>

      <button
        className="wl-choose"
        onClick={() => input.current?.click()}
        onPointerEnter={() => (hot.current = true)}
        onPointerLeave={() => (hot.current = false)}
        onFocus={() => (hot.current = true)}
        onBlur={() => (hot.current = false)}
      >
        <span className="wl-eq" aria-hidden>
          {Array.from({ length: 7 }, (_, i) => (
            <i key={i} style={{ animationDelay: `${(-i * 0.13).toFixed(2)}s` }} />
          ))}
        </span>
        <span className="wl-label">
          <b>Choose audio</b>
          <span className="wl-drag">Let go to play it</span>
        </span>
        <Upload width={18} height={18} className="wl-up" />
      </button>
      <p className="wl-hint">or drop a song anywhere · mp3, wav, m4a, flac, even a music video</p>

      <div className="wl-more">
        <span className="wl-more-h">Try</span>
        {DEMO_TRACKS.map((d) => (
          <button key={d.id} className="wl-chip has-tip" data-tip={d.description} onClick={() => void loadDemo(d.id)}>
            {d.name}
          </button>
        ))}
        <span className="wl-gap" />
        <button className="wl-chip ghost" onClick={() => void useMic()} aria-label="Use the microphone">
          <Mic width={13} height={13} /> Mic
        </button>
        {canListenToTab() && (
          <button className="wl-chip ghost has-tip" data-tip="A song playing in another tab" onClick={() => void useTab()} aria-label="Listen to a tab">
            <BrowserTab width={13} height={13} /> Tab
          </button>
        )}
      </div>

      <input
        ref={input}
        type="file"
        accept="audio/*,video/*,image/*"
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

/** the start screen only shows before there's a song */
export function WelcomeLayer() {
  const track = useStudio((s) => s.track);
  if (track) return null;
  return (
    <div className="empty">
      <Welcome />
    </div>
  );
}
