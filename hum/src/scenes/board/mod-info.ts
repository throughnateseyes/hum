/** Header + footer strips: title, section, BPM, time, progress, live readouts. */
import { MONO, clamp01, fmt2, fmtTime, fract, rgba, setFont } from './kit';
import type { BF, Module } from './kit';
import type { LayerId } from '../../core/types';

function sectionLabel(bf: BF): string {
  if (bf.idle) return 'STANDBY';
  const a = bf.a;
  let sec = '';
  const an = bf.f.analysis;
  if (an) for (const s of an.sections) if (a.time >= s.start && a.time < s.end) sec = s.label.toUpperCase();
  if (!sec) sec = a.drop > 0.5 ? 'DROP' : a.build > 0.5 ? 'BUILD' : 'LIVE';
  return a.playing ? sec : `PAUSED · ${sec}`;
}

export function header(title: string, sub: string): Module {
  let pulse = 0;
  return {
    chrome: false,
    drawStatic(ctx, r, sf) {
      const { ink, s, hl } = sf;
      const tp = Math.round(r.h * 0.34);
      setFont(ctx, tp, 600, MONO, 0.01);
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.fillStyle = rgba(ink.fg);
      ctx.fillText(title, r.x, r.y + tp);
      const tw = ctx.measureText(title).width;
      setFont(ctx, Math.max(7, tp * 0.36), 500, MONO, 0.12);
      ctx.fillStyle = rgba(ink.fg, 0.5);
      ctx.fillText(sub, r.x + tw + tp * 0.45, r.y + tp);
      const py = r.y + r.h - Math.round(8 * s);
      ctx.fillStyle = rgba(ink.fg, 0.22);
      ctx.fillRect(r.x, py, r.w, hl);
    },
    draw(ctx, r, bf) {
      const { ink, s, a, hl } = bf;
      const tp = Math.round(r.h * 0.34);
      const fs = Math.max(7, tp * 0.4);
      const an = bf.f.analysis;
      const dur = a.duration || an?.duration || 0;

      // time, right
      setFont(ctx, tp * 0.66, 500, MONO, 0.02);
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'right';
      ctx.fillStyle = rgba(ink.fg);
      ctx.fillText(bf.idle ? '--:-- / --:--' : `${fmtTime(a.time)} / ${dur ? fmtTime(dur) : '--:--'}`, r.x + r.w, r.y + tp);

      // section + bpm, middle
      pulse = Math.max(pulse * Math.exp(-bf.dt * 7), a.kick);
      const mx = r.x + r.w * 0.47;
      const dotR = fs * 0.3;
      ctx.fillStyle = rgba(ink.ac, 0.35 + 0.65 * pulse);
      ctx.beginPath();
      ctx.arc(mx + dotR, r.y + tp - fs * 0.34, dotR * (1 + 0.35 * pulse), 0, Math.PI * 2);
      ctx.fill();
      setFont(ctx, fs, 500, MONO, 0.12);
      ctx.textAlign = 'left';
      ctx.fillStyle = rgba(ink.fg);
      ctx.fillText(sectionLabel(bf), mx + fs * 1.1, r.y + tp);
      const y2 = r.y + tp + fs * 1.7;
      const bpmTxt = `${a.bpm > 0 ? Math.round(a.bpm) : '---'} BPM`;
      ctx.fillStyle = rgba(ink.fg, 0.55);
      ctx.fillText(bpmTxt, mx, y2);
      const bw = ctx.measureText(bpmTxt).width;
      const q = fs * 0.55;
      const beat = ((a.beatCount % 4) + 4) % 4;
      for (let i = 0; i < 4; i++) {
        const x = mx + bw + fs * 0.9 + i * q * 1.6;
        if (i === beat) {
          ctx.fillStyle = rgba(ink.ac);
          ctx.fillRect(x, y2 - q * 0.85, q, q);
        } else {
          ctx.strokeStyle = rgba(ink.fg, 0.4);
          ctx.lineWidth = hl;
          ctx.strokeRect(Math.round(x) + 0.5, Math.round(y2 - q * 0.85) + 0.5, Math.round(q) - 1, Math.round(q) - 1);
        }
      }

      // tags, left second row
      const tags = bf.idle ? 'DEMO SIGNAL · DROP A TRACK' : an?.tags?.length ? an.tags.slice(0, 3).join(' · ').toUpperCase() : 'LIVE INPUT';
      setFont(ctx, fs * 0.9, 500, MONO, 0.12);
      ctx.fillStyle = rgba(ink.fg, 0.42);
      ctx.fillText(tags, r.x, y2);

      // progress
      const py = r.y + r.h - Math.round(8 * s);
      const prog = dur > 0 ? clamp01(a.time / dur) : bf.idle ? fract(bf.t / 40) : 0;
      ctx.fillStyle = rgba(ink.fg);
      ctx.fillRect(r.x, py - hl, r.w * prog, hl * 3);
      const tick = Math.round(4 * s) + 1;
      setFont(ctx, Math.max(6.5, 8.5 * s), 500, MONO, 0.1);
      ctx.textBaseline = 'bottom';
      if (an && dur > 0 && an.sections.length) {
        let lastX = -1e9;
        for (const sec of an.sections) {
          const x = Math.round(r.x + (r.w * sec.start) / dur);
          const cur = a.time >= sec.start && a.time < sec.end;
          ctx.fillStyle = rgba(ink.fg, cur ? 0.9 : 0.35);
          ctx.fillRect(x, py - tick, hl, tick * 2 + hl);
          if (x - lastX > 54 * s && x < r.x + r.w - 40 * s) {
            ctx.fillText(sec.label.toUpperCase(), x + 3 * s, py - tick * 0.4);
            lastX = x;
          }
        }
      } else {
        for (let i = 0; i <= 4; i++) {
          const x = Math.round(r.x + (r.w * i) / 4) - (i === 4 ? hl : 0);
          ctx.fillStyle = rgba(ink.fg, 0.35);
          ctx.fillRect(x, py - tick, hl, tick * 2 + hl);
        }
      }
      const px = r.x + r.w * prog;
      ctx.fillStyle = rgba(ink.ac);
      ctx.fillRect(Math.round(px - hl), py - tick * 1.6, hl * 2 + 1, tick * 3.2 + hl);
    },
  };
}

const READOUTS: [string, LayerId][] = [
  ['SUB', 'sub'],
  ['BAS', 'bass'],
  ['MID', 'mid'],
  ['AIR', 'air'],
  ['NRG', 'energy'],
  ['BRT', 'brightness'],
];

export function footer(tag: string): Module {
  return {
    chrome: false,
    drawStatic(ctx, r, sf) {
      ctx.fillStyle = rgba(sf.ink.fg, 0.22);
      ctx.fillRect(r.x, r.y, r.w, sf.hl);
    },
    draw(ctx, r, bf) {
      const { ink, s, a } = bf;
      const fs = Math.max(6.5, Math.min(r.h * 0.3, 11 * s));
      const y = r.y + r.h * 0.58;
      setFont(ctx, fs, 500, MONO, 0.08);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      let x = r.x;
      const maxLeft = r.x + r.w * 0.5;
      for (const [lab, id] of READOUTS) {
        const v = fmt2(a[id]);
        const lw = ctx.measureText(lab + ' ').width;
        const vw = ctx.measureText(v).width;
        if (x + lw + vw > maxLeft) break;
        ctx.fillStyle = rgba(ink.fg, 0.42);
        ctx.fillText(lab, x, y);
        ctx.fillStyle = rgba(ink.fg, 0.9);
        ctx.fillText(v, x + lw, y);
        x += lw + vw + fs * 1.4;
      }
      const right = `${tag} · ${bf.w}×${bf.h} · F${String(bf.f.frame % 1e6).padStart(6, '0')}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = rgba(ink.fg, 0.42);
      ctx.fillText(right, r.x + r.w, y);
      const rw = ctx.measureText(right).width;
      // spectrum barcode between the two text blocks
      const x0 = x + 10 * s;
      const x1 = r.x + r.w - rw - 16 * s;
      if (x1 - x0 > 50 * s) {
        const step = Math.max(2, 4 * s);
        const n = Math.floor((x1 - x0) / step);
        ctx.strokeStyle = rgba(ink.fg, 0.75);
        ctx.lineWidth = Math.max(1, s);
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const v = a.spectrum[Math.min(127, 4 + Math.floor((i / n) * 112))] || 0;
          const hh = r.h * (0.08 + 0.36 * v);
          const bx = Math.round(x0 + i * step) + 0.5;
          ctx.moveTo(bx, y - hh);
          ctx.lineTo(bx, y + hh);
        }
        ctx.stroke();
      }
    },
  };
}
