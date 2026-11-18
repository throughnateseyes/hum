/**
 * Playful instruments: a terminal log narrating the song, radar sweep, BPM odometer, Pong, a runner
 * that jumps on kicks, a harmonograph XY figure, a mood "weather report", a song-section minimap,
 * a lyric word cloud and a lyric typewriter. More lyric instruments live in mod-words.ts.
 *
 * Same contract as the other mod-*.ts files: factories return a Module whose state lives in the
 * closure; everything is drawn with palette ink so the boards (and the pop-up windows) re-skin.
 */
import type { LyricLine, TrackSection } from '../../core/types';
import { lineAt } from '../../audio/lyrics';
import { useStudio } from '../../state/store';
import {
  MONO,
  NOTE_NAMES,
  SANS,
  TAU,
  clamp,
  clamp01,
  crisp,
  damp,
  fmt2,
  fmtTime,
  fract,
  hash,
  labelPx,
  noise3,
  pad2,
  pad3,
  rgba,
  setFont,
  text,
} from './kit';
import type { BF, Ink, Module, RGB, Rect } from './kit';

/* ───────────────────────── shared helpers ───────────────────────── */

export const LABEL: Record<TrackSection['label'], string> = {
  intro: 'INTRO',
  verse: 'VERSE',
  chorus: 'CHORUS',
  bridge: 'BRIDGE',
  build: 'BUILD',
  drop: 'DROP',
  break: 'BREAK',
  outro: 'OUTRO',
};

export function sectionAt(bf: BF): { i: number; sec: TrackSection | null; secs: TrackSection[] } {
  const secs = bf.f.analysis?.sections ?? [];
  const t = bf.a.time;
  for (let i = secs.length - 1; i >= 0; i--) if (t >= secs[i].start) return { i, sec: secs[i], secs };
  return { i: -1, sec: null, secs };
}

/** seconds until the next section with this label (or null) */
export function untilNext(bf: BF, label: TrackSection['label']): number | null {
  const secs = bf.f.analysis?.sections ?? [];
  for (const s of secs) if (s.start > bf.a.time + 0.05 && s.label === label) return s.start - bf.a.time;
  return null;
}

/** a drop edge: the live detector, or playback crossing one of the song map's drops */
function makeDropEdge() {
  let lastDrop = 0;
  let lastT = 0;
  return (bf: BF) => {
    const a = bf.a;
    const crossed = a.time > lastT && a.time - lastT < 0.5 && !!bf.f.analysis?.drops.some((d) => d > lastT && d <= a.time);
    const hit = (a.drop > 0.6 && lastDrop <= 0.6) || crossed;
    lastDrop = a.drop;
    lastT = a.time;
    return hit;
  };
}

const bpmOf = (bf: BF) => (bf.a.bpm > 30 ? bf.a.bpm : 92);
export const barOf = (bf: BF) => Math.max(0, Math.floor(bf.a.beatCount / 4));

/** synced lyric lines when there are any (read lazily: the store imports the scene registry) */
export function syncedLines(): LyricLine[] | null {
  try {
    const l = useStudio.getState().lyrics;
    return l?.synced && l.lines.length ? l.lines : null;
  } catch {
    return null;
  }
}

/** the line being sung now: synced lyrics first, else the typed text cycled every 8 beats */
export function currentLine(bf: BF): { key: string; text: string; prog: number } | null {
  const lines = syncedLines();
  if (lines) {
    const hit = lineAt(lines, bf.a.time + 0.08);
    if (hit && bf.a.time < hit.line.end + 0.6) {
      const span = Math.max(0.5, hit.line.end - hit.line.t);
      return { key: `L${hit.i}`, text: hit.line.text, prog: clamp01(((bf.a.time - hit.line.t) / span) * 1.25) };
    }
    return null;
  }
  const raw = (bf.f.text || '').trim();
  if (!raw) return null;
  const parts = raw
    .split(/\n|\s\/\s|\s\|\s/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const beats = bf.idle ? bf.t * 1.5 : Math.max(0, bf.a.beatCount + bf.a.beatPhase);
  const li = parts.length === 1 ? 0 : Math.floor(beats / 8) % parts.length;
  return { key: `T${li}|${parts[li]}`, text: parts[li], prog: clamp01((beats % 8) / 5) };
}

export function wrapWords(ctx: CanvasRenderingContext2D, line: string, maxW: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of line.split(/\s+/).filter(Boolean)) {
    const t = cur ? `${cur} ${w}` : w;
    if (cur && ctx.measureText(t).width > maxW) {
      out.push(cur);
      cur = w;
    } else cur = t;
  }
  if (cur) out.push(cur);
  return out;
}

/* ───────────────────────── Terminal log ───────────────────────── */

interface LogLine {
  t: string;
  /** 0 normal, 1 section, 2 alert, 3 lyric */
  tone: number;
  at: string;
}

export function terminal(): Module {
  const lines: LogLine[] = [];
  let lastBar = -1;
  let lastSec = -2;
  let lastDropBars = -1;
  let lastLyric = '';
  const dropEdge = makeDropEdge();
  let lastBuild = 0;
  let bpmLogged = false;
  let typed = 0;
  let scroll = 0;
  let idleBeat = -1;

  const push = (bf: BF, t: string, tone = 0) => {
    lines.push({ t, tone, at: bf.idle ? '--:--' : fmtTime(bf.a.time) });
    if (lines.length > 80) lines.shift();
    typed = 0;
    scroll = 1;
  };
  let booted = false;
  let lastBeat = -1;
  const boot = (bf: BF) => {
    booted = true;
    const an = bf.f.analysis;
    push(bf, 'HUM OS 0.4 · BOOT');
    push(bf, 'MOUNT /dev/song … OK');
    if (an) {
      push(bf, `TRACK ${fmtTime(an.duration)} · ${Math.round(an.bpm)} BPM · ${an.sections.length} PARTS`, 1);
      push(bf, an.sections.map((x) => LABEL[x.label].slice(0, 3)).join(' ') || 'NO MAP');
      if (an.tags.length) push(bf, `MOOD ${an.tags.slice(0, 3).join(' · ').toUpperCase()}`);
    } else push(bf, 'NO MAP · LISTENING LIVE');
  };
  const IDLE = ['CALIBRATING BAND 3 … OK', 'WARMING TUBES', 'LISTENING ON ALL BANDS', 'NO TRACK · DEMO SIGNAL', 'SELF-TEST PASS', 'DROP A SONG TO BEGIN'];

  const events = (bf: BF) => {
    const a = bf.a;
    if (!booted) boot(bf);
    if (bf.idle) {
      if (a.beat && a.beatCount !== idleBeat) {
        idleBeat = a.beatCount;
        if (a.beatCount % 2 === 0) push(bf, IDLE[Math.floor(a.beatCount / 2) % IDLE.length]);
      }
      return;
    }
    if (!bpmLogged && a.bpm > 30 && a.playing) {
      bpmLogged = true;
      push(bf, `BPM ${Math.round(a.bpm)} LOCKED`, 1);
    }
    const { i, sec } = sectionAt(bf);
    if (i !== lastSec && sec) {
      lastSec = i;
      push(bf, `>> SECTION ${pad2(i + 1)} → ${LABEL[sec.label]} · NRG ${fmt2(sec.energy)}`, sec.label === 'drop' || sec.label === 'chorus' ? 2 : 1);
    }
    const bar = barOf(bf);
    if (bar !== lastBar && a.playing) {
      lastBar = bar;
      push(bf, `BAR ${pad3(bar + 1)} · KICK ${fmt2(a.kick)} · NRG ${fmt2(a.energy)}`);
      const till = untilNext(bf, 'drop');
      if (till !== null) {
        const bars = Math.ceil((till * bpmOf(bf)) / 240);
        if (bars <= 8 && bars !== lastDropBars) {
          lastDropBars = bars;
          push(bf, bars <= 1 ? 'DROP NEXT BAR — BRACE' : `DROP IN ${bars}`, 2);
        }
      }
    } else if (a.beat && a.playing && a.beatCount !== lastBeat) {
      lastBeat = a.beatCount;
      const b = ((a.beatCount % 4) + 4) % 4;
      if (b === 1) push(bf, `SUB ${fmt2(a.sub)} BAS ${fmt2(a.bass)} MID ${fmt2(a.mid)} AIR ${fmt2(a.air)}`);
      else if (b === 2) push(bf, `SNARE ${fmt2(a.snare)} ▲ HI-MID ${fmt2(a.highMid)} · HAT ${fmt2(a.hat)}`);
      else if (b === 3) {
        let pk = 0;
        for (let i = 1; i < 128; i++) if (a.spectrum[i] > a.spectrum[pk]) pk = i;
        const hz = 20 * Math.pow(1000, pk / 127);
        push(bf, `PEAK ${hz >= 1000 ? (hz / 1000).toFixed(1) + 'KHZ' : Math.round(hz) + 'HZ'} · FLUX ${fmt2(a.flux)} · BRT ${fmt2(a.brightness)}`);
      }
    }
    if (dropEdge(bf)) push(bf, '!!! DROP !!! SUB ' + fmt2(a.sub), 2);
    if (a.build > 0.5 && lastBuild <= 0.5) push(bf, 'PRESSURE RISING · BUILD ' + fmt2(a.build), 1);
    lastBuild = a.build;
    const cur = currentLine(bf);
    if (cur && cur.key !== lastLyric) {
      lastLyric = cur.key;
      push(bf, `SING "${cur.text.toLowerCase().slice(0, 48)}"`, 3);
    }
  };

  return {
    label: 'SONG.LOG',
    meta: 'TAIL -F',
    clip: true,
    draw(ctx, r, bf) {
      if (bf.live) events(bf);
      const { ink, s } = bf;
      const fs = Math.max(7, Math.min(labelPx(s) * 1.05, r.h / 9));
      const lh = fs * 1.5;
      typed += bf.dt * 70;
      scroll = damp(scroll, 0, 18, bf.dt);
      setFont(ctx, fs, 500, MONO, 0.04);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      // prompt line at the top
      ctx.fillStyle = rgba(ink.fg, 0.45);
      ctx.fillText('hum@board:~$ tail -f song.log', r.x, r.y + fs * 0.7);
      const top = r.y + lh * 1.3;
      const yBottom = r.y + r.h - lh * 0.6 + scroll * lh;
      const maxRows = Math.max(1, Math.floor((r.h - lh * 1.3) / lh));
      const stampW = ctx.measureText('00:00 ').width;
      const tones: RGB[] = [ink.fg, ink.ac2, ink.ac, ink.fg];
      for (let k = 0; k < Math.min(lines.length, maxRows + 1); k++) {
        const L = lines[lines.length - 1 - k];
        const y = yBottom - k * lh;
        if (y < top - lh * 0.4) break;
        const newest = k === 0;
        const body = newest ? L.t.slice(0, Math.floor(typed)) : L.t;
        const fade = 1 - k / (maxRows + 2);
        ctx.fillStyle = rgba(ink.fg, 0.35 * fade);
        ctx.fillText(L.at, r.x, y);
        if (L.tone === 2) {
          ctx.fillStyle = rgba(ink.ac, 0.95);
          const bw = ctx.measureText(body).width;
          ctx.fillRect(r.x + stampW - fs * 0.2, y - lh * 0.42, bw + fs * 0.4, lh * 0.84);
          ctx.fillStyle = rgba(ink.bg);
        } else ctx.fillStyle = rgba(tones[L.tone], (L.tone === 3 ? 0.7 : 0.92) * fade + 0.08);
        if (L.tone === 3) setFont(ctx, fs, 500, MONO, 0.04);
        ctx.fillText(body, r.x + stampW, y);
        if (newest && Math.floor(bf.t * 2.5) % 2 === 0) {
          const cx = r.x + stampW + ctx.measureText(body).width + fs * 0.15;
          ctx.fillStyle = rgba(L.tone === 2 ? ink.bg : ink.ac);
          ctx.fillRect(cx, y - fs * 0.55, fs * 0.6, fs * 1.1);
        }
      }
    },
  };
}

/* ───────────────────────── Radar sweep ───────────────────────── */

export function radar(): Module {
  const CAP = 90;
  const ang = new Float32Array(CAP);
  const rad = new Float32Array(CAP);
  const life = new Float32Array(CAP);
  const kind = new Uint8Array(CAP);
  const id = new Uint16Array(CAP);
  let n = 0;
  let serial = 0;
  let sweep = -Math.PI / 2;
  const add = (a: number, r: number, k: number) => {
    let i = n;
    if (n < CAP) n++;
    else {
      // overwrite the faintest
      i = 0;
      for (let j = 1; j < CAP; j++) if (life[j] < life[i]) i = j;
    }
    ang[i] = a;
    rad[i] = r;
    life[i] = 1;
    kind[i] = k;
    id[i] = ++serial % 1000;
  };
  const geo = (r: Rect) => {
    const R = Math.min(r.w, r.h) * 0.46;
    return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, R };
  };
  return {
    label: 'RADAR',
    meta: 'KICK · SNARE · HAT',
    clip: true,
    drawStatic(ctx, r, sf) {
      const { cx, cy, R } = geo(r);
      const { ink, hl, s } = sf;
      ctx.strokeStyle = rgba(ink.fg, 0.3);
      ctx.lineWidth = hl;
      for (let k = 1; k <= 4; k++) {
        ctx.beginPath();
        ctx.arc(cx, cy, (R * k) / 4, 0, TAU);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(cx - R, crisp(cy, hl));
      ctx.lineTo(cx + R, crisp(cy, hl));
      ctx.moveTo(crisp(cx, hl), cy - R);
      ctx.lineTo(crisp(cx, hl), cy + R);
      ctx.stroke();
      ctx.strokeStyle = rgba(ink.fg, 0.5);
      ctx.beginPath();
      for (let k = 0; k < 72; k++) {
        const a = (k / 72) * TAU;
        const l = k % 6 === 0 ? 7 * s + 2 : 3 * s + 1;
        ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
        ctx.lineTo(cx + Math.cos(a) * (R - l), cy + Math.sin(a) * (R - l));
      }
      ctx.stroke();
      const fs = Math.max(6.5, 8 * s);
      const c = rgba(ink.fg, 0.45);
      text(ctx, 'KCK', cx + 3 * s, cy - R * 0.25 - fs * 0.6, fs, c);
      text(ctx, 'SNR', cx + 3 * s, cy - R * 0.5 - fs * 0.6, fs, c);
      text(ctx, 'HAT', cx + 3 * s, cy - R * 0.75 - fs * 0.6, fs, c);
    },
    draw(ctx, r, bf) {
      const { cx, cy, R } = geo(r);
      const { ink, a, s, dt } = bf;
      // one turn per bar, locked to the beat
      const target = (((((a.beatCount % 4) + 4) % 4) + a.beatPhase) / 4) * TAU - Math.PI / 2;
      let d = target - sweep;
      while (d < -Math.PI) d += TAU;
      while (d > Math.PI) d -= TAU;
      sweep += d * Math.min(1, dt * 20);
      if (bf.live) {
        const jitter = () => (Math.random() - 0.5) * 0.25;
        if (a.kickHit) add(sweep + jitter() * 0.3, 0.12 + Math.random() * 0.14 + a.kick * 0.05, 0);
        if (a.snareHit) add(sweep + jitter() * 0.3, 0.38 + Math.random() * 0.14, 1);
        if (a.hatHit && Math.random() < 0.6) add(sweep + jitter() * 0.3, 0.64 + Math.random() * 0.3, 2);
        if (a.drop > 0.7 && Math.random() < 0.4) add(Math.random() * TAU, Math.random() * 0.95, 1);
      }
      // sweep wedge
      const span = 1.1;
      const g = ctx.createConicGradient(sweep - span, cx, cy);
      g.addColorStop(0, rgba(ink.ac, 0));
      g.addColorStop(span / TAU, rgba(ink.ac, 0.32 + a.kick * 0.25));
      g.addColorStop(span / TAU + 0.002, rgba(ink.ac, 0));
      g.addColorStop(1, rgba(ink.ac, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = rgba(ink.ac);
      ctx.lineWidth = Math.max(1, 1.6 * s * bf.lw);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(sweep) * R, cy + Math.sin(sweep) * R);
      ctx.stroke();
      // blips
      const fs = Math.max(6, 7.5 * s);
      setFont(ctx, fs, 500, MONO, 0.06);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      let alive = 0;
      for (let i = 0; i < n; i++) {
        if (life[i] <= 0) continue;
        life[i] -= dt * 0.33;
        if (life[i] <= 0) continue;
        alive++;
        const x = cx + Math.cos(ang[i]) * rad[i] * R;
        const y = cy + Math.sin(ang[i]) * rad[i] * R;
        const L = life[i];
        const sz = (kind[i] === 0 ? 5 : kind[i] === 1 ? 3.8 : 2.6) * s * (0.6 + L * 0.6) + 1;
        const col = kind[i] === 0 ? ink.ac : kind[i] === 1 ? ink.fg : ink.ac2;
        ctx.fillStyle = rgba(col, Math.min(1, L * 1.4));
        if (kind[i] === 1) ctx.fillRect(x - sz, y - sz, sz * 2, sz * 2);
        else {
          ctx.beginPath();
          ctx.arc(x, y, sz, 0, TAU);
          ctx.fill();
        }
        if (L > 0.75 && kind[i] === 0) {
          ctx.strokeStyle = rgba(ink.ac, (L - 0.75) * 4);
          ctx.lineWidth = Math.max(1, s);
          ctx.beginPath();
          ctx.arc(x, y, sz + (1 - L) * 60 * s, 0, TAU);
          ctx.stroke();
          ctx.fillStyle = rgba(ink.fg, 0.7);
          ctx.fillText(`K-${pad3(id[i])}`, x + sz + 3 * s, y);
        }
      }
      text(ctx, `CONTACTS ${pad2(alive)}`, r.x, r.y + r.h - fs, fs, rgba(ink.fg, 0.6));
      text(ctx, `${Math.round(bpmOf(bf))} RPM/4`, r.x + r.w, r.y + r.h - fs, fs, rgba(ink.fg, 0.6), 'right');
    },
  };
}

/* ───────────────────────── BPM odometer ───────────────────────── */

function wheel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, disp: number, digits: number, ink: Ink, hot: boolean, hl: number) {
  const fs = h * 0.78;
  setFont(ctx, fs, 600, MONO, 0);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cw = w / digits;
  for (let k = 0; k < digits; k++) {
    const base = Math.pow(10, digits - 1 - k);
    const q = disp / base;
    const d = ((Math.floor(q) % 10) + 10) % 10;
    const rem = disp - Math.floor(disp / base) * base;
    const frac = base === 1 ? fract(disp) : rem > base - 1 ? rem - (base - 1) : 0;
    const cx = x + k * cw;
    ctx.fillStyle = rgba(k === digits - 1 && hot ? ink.ac : ink.fg);
    ctx.fillRect(Math.round(cx + hl), Math.round(y), Math.round(cw - hl * 2), Math.round(h));
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx, y, cw, h);
    ctx.clip();
    ctx.fillStyle = rgba(ink.bg);
    ctx.fillText(String(d), cx + cw / 2, y + h / 2 - frac * h);
    ctx.fillText(String((d + 1) % 10), cx + cw / 2, y + h / 2 + (1 - frac) * h);
    ctx.restore();
    // split-flap seam + shading
    ctx.fillStyle = rgba(ink.bg, 0.35);
    ctx.fillRect(cx + hl, Math.round(y + h / 2), cw - hl * 2, hl);
    const sh = ctx.createLinearGradient(0, y, 0, y + h);
    sh.addColorStop(0, rgba(ink.fg, 0.55));
    sh.addColorStop(0.22, rgba(ink.fg, 0));
    sh.addColorStop(0.78, rgba(ink.fg, 0));
    sh.addColorStop(1, rgba(ink.fg, 0.55));
    ctx.fillStyle = sh;
    ctx.fillRect(cx + hl, y, cw - hl * 2, h);
  }
}

export function odometer(): Module {
  let bpm = 0;
  let bar = 0;
  let beats = 0;
  let flash = 0;
  return {
    label: 'TEMPO',
    meta: 'ODOMETER',
    clip: true,
    draw(ctx, r, bf) {
      const { a, ink, s, hl, dt } = bf;
      bpm = damp(bpm, Math.round(bpmOf(bf)), 2.5, dt);
      const tb = Math.max(0, Math.floor(a.beatCount / 4));
      bar = damp(bar, tb, 14, dt);
      beats = damp(beats, Math.max(0, a.beatCount), 16, dt);
      flash = Math.max(flash * Math.exp(-dt * 8), a.kickHit ? 1 : 0);
      const fs = labelPx(s);
      const bigH = Math.min(r.h * 0.5, (r.w * 0.62) / 3 / 0.62);
      const bigW = bigH * 0.62 * 3;
      const bx = r.x + (r.w - bigW) / 2;
      const by = r.y + Math.max(fs * 0.8, (r.h - bigH - fs * 6) * 0.35);
      wheel(ctx, bx, by, bigW, bigH, bpm, 3, ink, flash > 0.5, hl);
      text(ctx, 'BPM', bx + bigW + fs * 0.5, by + bigH - fs * 0.4, fs, rgba(ink.fg, 0.7));
      const sy = by + bigH + fs * 1.6;
      const smH = Math.min(bigH * 0.42, fs * 2.6);
      const smW = smH * 0.62;
      text(ctx, 'BAR', bx, sy + smH / 2, fs * 0.9, rgba(ink.fg, 0.55));
      wheel(ctx, bx + fs * 3, sy, smW * 3, smH, bar + 1, 3, ink, false, hl);
      const qx = bx + fs * 3 + smW * 3 + fs * 1.2;
      const q = smH * 0.6;
      const bt = ((a.beatCount % 4) + 4) % 4;
      for (let i = 0; i < 4; i++) {
        const x = qx + i * q * 1.35;
        if (i === bt) {
          ctx.fillStyle = rgba(ink.ac);
          ctx.fillRect(x, sy + (smH - q) / 2, q, q);
        } else {
          ctx.strokeStyle = rgba(ink.fg, 0.5);
          ctx.lineWidth = hl;
          ctx.strokeRect(Math.round(x) + 0.5, Math.round(sy + (smH - q) / 2) + 0.5, Math.round(q), Math.round(q));
        }
      }
      const ty = sy + smH + fs * 1.4;
      if (ty < r.y + r.h - fs * 0.5) {
        text(ctx, `BEATS ${String(Math.floor(beats)).padStart(5, '0')} · ${(60 / bpmOf(bf)).toFixed(3)} S/BEAT`, bx, ty, fs * 0.85, rgba(ink.fg, 0.5));
      }
    },
  };
}

/* ───────────────────────── Pong ───────────────────────── */

export function pong(): Module {
  let bx = 0.5;
  let by = 0.5;
  let vx = 0.6;
  let vy = 0.3;
  let pl = 0.5;
  let pr = 0.5;
  let sl = 0;
  let sr = 0;
  let freezeL = 0;
  let freezeR = 0;
  let lastDrop = 0;
  let hitFlash = 0;
  let serveT = 0;
  const trail: [number, number][] = [];
  const PH = 0.24;
  const serve = (dir: number) => {
    bx = 0.5;
    by = 0.3 + Math.random() * 0.4;
    vx = dir * 0.6;
    vy = (Math.random() - 0.5) * 0.9;
    serveT = 0.35;
    trail.length = 0;
  };
  return {
    label: 'PONG',
    meta: 'BALL ON THE BEAT',
    clip: true,
    drawStatic(ctx, r, sf) {
      const { ink, s } = sf;
      ctx.fillStyle = rgba(ink.fg, 0.25);
      const d = Math.max(2, Math.round(5 * s));
      for (let y = r.y; y < r.y + r.h; y += d * 2.2) ctx.fillRect(Math.round(r.x + r.w / 2 - d / 4), Math.round(y), Math.max(1, Math.round(d / 2)), d);
    },
    draw(ctx, r, bf) {
      const { a, ink, s, dt } = bf;
      if (bf.live) {
        // the ball crosses the court in 2 beats (1 when it's loud), so paddle hits land on beats
        const spb = 60 / bpmOf(bf);
        const cross = (a.energy > 0.62 || a.drop > 0.3 ? 1 : 2) * spb;
        const speed = 0.86 / cross;
        vx = Math.sign(vx || 1) * speed;
        if (a.drop > 0.6 && lastDrop <= 0.6) {
          if (vx > 0) freezeR = 0.9;
          else freezeL = 0.9;
        }
        lastDrop = a.drop;
        if (serveT > 0) serveT -= dt;
        else {
          bx += vx * dt;
          by += vy * dt * (0.6 + a.energy);
        }
        if (by < 0.04) {
          by = 0.04;
          vy = Math.abs(vy);
        }
        if (by > 0.96) {
          by = 0.96;
          vy = -Math.abs(vy);
        }
        const track = (p: number, frozen: number) => (frozen > 0 ? p : damp(p, by + noise3(bf.t * 0.7, p * 3, 0) * 0.08, 9, dt));
        freezeL = Math.max(0, freezeL - dt);
        freezeR = Math.max(0, freezeR - dt);
        pl = clamp(track(pl, freezeL), PH / 2, 1 - PH / 2);
        pr = clamp(track(pr, freezeR), PH / 2, 1 - PH / 2);
        if (bx < 0.06 && vx < 0) {
          if (Math.abs(by - pl) < PH / 2 + 0.03) {
            bx = 0.06;
            vx = Math.abs(vx);
            vy = (by - pl) * 5 + (Math.random() - 0.5) * 0.3;
            hitFlash = 1;
          } else if (bx < -0.02) {
            sr++;
            serve(1);
          }
        }
        if (bx > 0.94 && vx > 0) {
          if (Math.abs(by - pr) < PH / 2 + 0.03) {
            bx = 0.94;
            vx = -Math.abs(vx);
            vy = (by - pr) * 5 + (Math.random() - 0.5) * 0.3;
            hitFlash = 1;
          } else if (bx > 1.02) {
            sl++;
            serve(-1);
          }
        }
        trail.push([bx, by]);
        if (trail.length > 7) trail.shift();
      }
      hitFlash = Math.max(0, hitFlash - dt * 5);
      const X = (v: number) => r.x + v * r.w;
      const Y = (v: number) => r.y + v * r.h;
      const fs = Math.min(r.h * 0.24, r.w * 0.12);
      setFont(ctx, fs, 700, MONO, 0);
      ctx.textBaseline = 'top';
      ctx.fillStyle = rgba(ink.fg, 0.8);
      ctx.textAlign = 'right';
      ctx.fillText(pad2(sl), X(0.5) - fs * 0.5, r.y + fs * 0.15);
      ctx.textAlign = 'left';
      ctx.fillText(pad2(sr), X(0.5) + fs * 0.5, r.y + fs * 0.15);
      const pw = Math.max(3, r.w * 0.018);
      ctx.fillStyle = rgba(freezeL > 0 ? ink.mu : ink.fg);
      ctx.fillRect(X(0.04) - pw, Y(pl - PH / 2), pw, r.h * PH);
      ctx.fillStyle = rgba(freezeR > 0 ? ink.mu : ink.fg);
      ctx.fillRect(X(0.96), Y(pr - PH / 2), pw, r.h * PH);
      const bs = Math.max(4, Math.min(r.w, r.h) * (0.045 + a.kick * 0.03));
      trail.forEach(([x, y], i) => {
        ctx.fillStyle = rgba(ink.ac, ((i + 1) / trail.length) * 0.3);
        ctx.fillRect(X(x) - bs / 2, Y(y) - bs / 2, bs, bs);
      });
      ctx.fillStyle = rgba(hitFlash > 0.3 ? ink.fg : ink.ac);
      ctx.fillRect(X(bx) - bs / 2, Y(by) - bs / 2, bs, bs);
      if (freezeL > 0 || freezeR > 0) text(ctx, 'MISS!', freezeL > 0 ? X(0.2) : X(0.8), Y(0.85), labelPx(s) * 1.2, rgba(ink.ac), 'center', 700);
    },
  };
}

/* ───────────────────────── Runner ───────────────────────── */

export function runner(): Module {
  let y = 0;
  let vy = 0;
  let dist = 0;
  let coins = 0;
  let oofs = 0;
  let oofT = 0;
  let sky = 0;
  const obs: { x: number; h: number; w: number; hit: boolean }[] = [];
  const pick: { x: number; y: number; got: boolean }[] = [];
  const peaks = new Float32Array(64);
  let peakHead = 0;
  let peakAcc = 0;
  return {
    label: 'RUNNER',
    meta: 'JUMPS ON KICKS',
    clip: true,
    draw(ctx, r, bf) {
      const { a, ink, s, dt } = bf;
      const U = r.h; // world units are fractions of panel height
      const ground = 0.8;
      const rx = 0.22 * (r.w / U);
      const speed = (0.55 + a.energy * 0.9 + a.drop * 0.5) * (r.w / U) * 0.5;
      const g = 9;
      if (bf.live) {
        dist += speed * dt;
        sky += speed * dt * 0.15;
        // skyline from the spectrum, slow
        peakAcc += dt * 6;
        while (peakAcc >= 1) {
          peakAcc -= 1;
          // each building reads a different slice of the spectrum, so the skyline has a shape
          const b0 = 12 + ((peakHead * 37) % 90);
          let m = 0;
          for (let i = b0; i < b0 + 6; i++) m += a.spectrum[i] || 0;
          peaks[peakHead] = clamp01((m / 6) * (0.55 + 0.6 * hash(peakHead, 5)));
          peakHead = (peakHead + 1) % peaks.length;
        }
        const onGround = y <= 0.0001;
        const near = obs.some((o) => !o.hit && o.x - rx > 0 && o.x - rx < speed * 0.16);
        if (onGround && (a.kickHit || near)) vy = 2.3 + a.kick * 0.6;
        vy -= g * dt;
        y = Math.max(0, y + vy * dt);
        if (y === 0 && vy < 0) vy = 0;
        if ((a.snareHit || (a.beat && a.beatCount % 4 === 2)) && (!obs.length || obs[obs.length - 1].x < (r.w / U) - 0.4)) {
          obs.push({ x: r.w / U + 0.05, h: 0.1 + a.bass * 0.14, w: 0.05 + Math.random() * 0.05, hit: false });
        }
        if (a.hatHit && Math.random() < 0.35) pick.push({ x: r.w / U + 0.05, y: 0.25 + Math.random() * 0.3, got: false });
        for (const o of obs) {
          o.x -= speed * dt;
          if (!o.hit && Math.abs(o.x + o.w / 2 - rx) < o.w / 2 + 0.03 && y < o.h) {
            o.hit = true;
            oofs++;
            oofT = 0.5;
          }
        }
        for (const p of pick) {
          p.x -= speed * dt;
          if (!p.got && Math.abs(p.x - rx) < 0.05 && Math.abs(ground - 0.08 - y - (ground - p.y)) < 0.09) {
            p.got = true;
            coins++;
          }
        }
        while (obs.length && obs[0].x < -0.2) obs.shift();
        while (pick.length && pick[0].x < -0.2) pick.shift();
      }
      oofT = Math.max(0, oofT - dt);
      const X = (v: number) => r.x + v * U;
      const Y = (v: number) => r.y + v * U;
      // skyline
      ctx.fillStyle = rgba(ink.ac2, 0.35);
      const n = peaks.length;
      const bw = r.w / (n - 1);
      ctx.beginPath();
      ctx.moveTo(r.x, Y(ground));
      for (let i = 0; i < n; i++) {
        const v = peaks[(peakHead + i) % n];
        const hx = r.x + i * bw;
        const hy = Y(ground - 0.06 - v * 0.34);
        ctx.lineTo(hx, hy);
        ctx.lineTo(hx + bw, hy);
      }
      ctx.lineTo(r.x + r.w, Y(ground));
      ctx.closePath();
      ctx.fill();
      // sun / moon
      ctx.fillStyle = rgba(ink.ac, 0.85);
      ctx.beginPath();
      ctx.arc(r.x + r.w * 0.8, Y(0.2), U * (0.07 + a.bass * 0.03), 0, TAU);
      ctx.fill();
      // ground
      ctx.fillStyle = rgba(ink.fg);
      ctx.fillRect(r.x, Math.round(Y(ground)), r.w, Math.max(1, Math.round(2 * s)));
      ctx.fillStyle = rgba(ink.fg, 0.4);
      const tick = 0.09;
      for (let k = -1; k < r.w / U / tick + 1; k++) {
        const x = X(k * tick - (dist % tick));
        ctx.fillRect(Math.round(x), Math.round(Y(ground + 0.04)), Math.max(1, Math.round(6 * s)), Math.max(1, Math.round(s)));
        if (k % 3 === 0) ctx.fillRect(Math.round(x + 10 * s), Math.round(Y(ground + 0.09)), Math.max(1, Math.round(3 * s)), Math.max(1, Math.round(s)));
      }
      // obstacles: little stacks of blocks
      for (const o of obs) {
        ctx.fillStyle = rgba(o.hit ? ink.mu : ink.fg);
        ctx.fillRect(X(o.x), Y(ground - o.h), o.w * U, o.h * U);
        ctx.fillStyle = rgba(ink.bg, 0.6);
        ctx.fillRect(X(o.x) + o.w * U * 0.3, Y(ground - o.h) + 2, Math.max(1, s * 1.5), o.h * U * 0.6);
      }
      for (const p of pick) {
        if (p.got) continue;
        ctx.fillStyle = rgba(ink.ac);
        ctx.beginPath();
        const rr = U * 0.025 * (0.8 + 0.2 * Math.sin(bf.t * 10 + p.x * 9));
        ctx.ellipse(X(p.x), Y(p.y), rr * 0.6, rr, 0, 0, TAU);
        ctx.fill();
      }
      // the runner
      const hx = X(rx);
      const fy = Y(ground - y);
      const H = U * 0.2;
      const step = Math.floor(dist * 9) % 2;
      ctx.fillStyle = rgba(oofT > 0 && Math.floor(oofT * 20) % 2 ? ink.ac : ink.fg);
      const unit = H / 8;
      ctx.fillRect(hx - unit * 1.5, fy - H, unit * 3, unit * 2.6); // head
      ctx.fillRect(hx - unit, fy - H + unit * 2.8, unit * 2, unit * 3); // body
      if (y > 0.01) {
        ctx.fillRect(hx - unit * 2, fy - unit * 2.2, unit * 1.2, unit * 1.6);
        ctx.fillRect(hx + unit * 0.8, fy - unit * 2.6, unit * 1.2, unit * 1.6);
        ctx.fillRect(hx - unit * 2.6, fy - H + unit * 2.6, unit * 1.6, unit);
        ctx.fillRect(hx + unit, fy - H + unit * 2.2, unit * 1.6, unit);
      } else {
        ctx.fillRect(hx - unit * (step ? 1.6 : 0.6), fy - unit * 2.2, unit, unit * 2.2);
        ctx.fillRect(hx + unit * (step ? 0.6 : -0.2), fy - unit * 2.2, unit, unit * 2.2);
        ctx.fillRect(hx + unit, fy - H + unit * 3.2, unit * 1.4, unit);
      }
      ctx.fillStyle = rgba(ink.bg);
      ctx.fillRect(hx + unit * 0.4, fy - H + unit * 0.8, unit * 0.6, unit * 0.6); // eye
      if (oofT > 0) text(ctx, 'OOF', hx, fy - H - unit * 3, labelPx(s) * 1.1, rgba(ink.ac), 'center', 700);
      const fs = labelPx(s) * 0.85;
      text(ctx, `DIST ${String(Math.floor(dist * 10)).padStart(5, '0')}  ◆${pad2(coins)}  OOF ${pad2(oofs)}`, r.x + r.w, r.y + fs * 0.7, fs, rgba(ink.fg, 0.6), 'right');
    },
  };
}

/* ───────────────────────── Harmonograph (XY) ───────────────────────── */

const RATIOS: [number, number][] = [
  [1, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [3, 5],
  [4, 5],
  [1, 3],
  [5, 6],
  [2, 5],
  [3, 2],
  [5, 4],
  [4, 3],
];

export function harmonograph(): Module {
  let cv: HTMLCanvasElement | null = null;
  let cx: CanvasRenderingContext2D | null = null;
  let phase = 0;
  let rot = 0;
  let note = 0;
  let noteHold = 0;
  return {
    label: 'XY FIGURE',
    meta: 'HARMONOGRAPH',
    clip: true,
    draw(ctx, r, bf) {
      const { a, ink, s, dt } = bf;
      const w = Math.max(2, Math.round(r.w));
      const h = Math.max(2, Math.round(r.h));
      if (!cv || cv.width !== w || cv.height !== h) {
        cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        cx = cv.getContext('2d')!;
      }
      const c = cx!;
      // phosphor persistence
      c.globalCompositeOperation = 'source-over';
      c.fillStyle = rgba(ink.bg, bf.live ? 0.22 : 0.05);
      c.fillRect(0, 0, w, h);
      // dominant pitch class picks the frequency ratio (held a moment so it doesn't flicker)
      noteHold -= dt;
      if (noteHold <= 0) {
        const chroma = new Array(12).fill(0);
        for (let i = 20; i < 110; i++) {
          const hz = 20 * Math.pow(1000, i / 127);
          const pc = (((Math.round(12 * Math.log2(hz / 440)) + 9) % 12) + 12) % 12;
          chroma[pc] += a.spectrum[i] || 0;
        }
        let bi = 0;
        for (let i = 1; i < 12; i++) if (chroma[i] > chroma[bi]) bi = i;
        note = bi;
        noteHold = 60 / bpmOf(bf);
      }
      const [f1, f2] = RATIOS[note];
      if (bf.live) {
        phase += dt * (0.25 + a.energy * 0.6) + a.kick * dt * 2;
        rot += dt * 0.15;
      }
      const R = Math.min(w, h) * 0.44;
      const A1 = 0.55 + a.bass * 0.45;
      const A2 = 0.45 + a.mid * 0.5;
      const N = 520;
      const decay = 0.0016 + (1 - a.energy) * 0.002;
      c.strokeStyle = rgba(ink.ac, 0.9);
      c.lineWidth = Math.max(1, 1.2 * s * bf.lw);
      c.beginPath();
      for (let i = 0; i < N; i++) {
        const t = i * 0.07;
        const e = Math.exp(-decay * i * 3);
        const x = (A1 * Math.sin(f1 * t + phase) + 0.25 * Math.sin(f2 * 2 * t + rot)) * e;
        const y = (A2 * Math.sin(f2 * t + phase * 1.3 + Math.PI / 4) + 0.2 * Math.cos(f1 * 2 * t)) * e;
        const px = w / 2 + (x * Math.cos(rot) - y * Math.sin(rot)) * R * 0.85;
        const py = h / 2 + (x * Math.sin(rot) + y * Math.cos(rot)) * R * 0.85;
        if (i) c.lineTo(px, py);
        else c.moveTo(px, py);
      }
      c.stroke();
      // the raw waveform as a second, fainter XY trace
      const wv = a.waveform;
      c.strokeStyle = rgba(ink.fg, 0.35);
      c.lineWidth = Math.max(1, s * 0.8);
      c.beginPath();
      for (let i = 0; i < 448; i += 2) {
        const px = w / 2 + (wv[i] || 0) * R * 0.9;
        const py = h / 2 + (wv[i + 64] || 0) * R * 0.9;
        if (i) c.lineTo(px, py);
        else c.moveTo(px, py);
      }
      c.stroke();
      ctx.drawImage(cv, r.x, r.y);
      const fs = labelPx(s) * 0.8;
      text(ctx, `${f1}:${f2} · ${NOTE_NAMES[note]}`, r.x, r.y + r.h - fs * 0.6, fs, rgba(ink.fg, 0.6));
      text(ctx, `φ ${fract(phase).toFixed(2)}`, r.x + r.w, r.y + r.h - fs * 0.6, fs, rgba(ink.fg, 0.6), 'right');
    },
  };
}

/* ───────────────────────── Weather report ───────────────────────── */

type Sky = 'SUNNY' | 'PARTLY CLOUDY' | 'DRIZZLE' | 'FOG' | 'STORM' | 'PRESSURE RISING';

function skyFor(energy: number, bright: number, build: number, drop: number): Sky {
  if (drop > 0.45) return 'STORM';
  if (build > 0.4) return 'PRESSURE RISING';
  if (energy > 0.58 && bright > 0.42) return 'SUNNY';
  if (energy > 0.42) return 'PARTLY CLOUDY';
  if (bright < 0.36) return 'FOG';
  return 'DRIZZLE';
}
function skyForSection(s: TrackSection): Sky {
  if (s.label === 'drop') return 'STORM';
  if (s.label === 'build') return 'PRESSURE RISING';
  return skyFor(s.energy, 0.5, 0, 0);
}

function drawSky(ctx: CanvasRenderingContext2D, sky: Sky, cx: number, cy: number, R: number, ink: Ink, t: number, kick: number, lw: number) {
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  const cloud = (x: number, y: number, k: number, fill: RGB, stroke: RGB) => {
    ctx.fillStyle = rgba(fill);
    ctx.strokeStyle = rgba(stroke);
    ctx.beginPath();
    ctx.arc(x - k * 0.45, y + k * 0.1, k * 0.38, Math.PI * 0.5, Math.PI * 1.5);
    ctx.arc(x - k * 0.05, y - k * 0.22, k * 0.48, Math.PI * 1.05, Math.PI * 1.95);
    ctx.arc(x + k * 0.48, y + k * 0.05, k * 0.43, Math.PI * 1.4, Math.PI * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  };
  if (sky === 'SUNNY' || sky === 'PARTLY CLOUDY') {
    const sr = R * (sky === 'SUNNY' ? 0.42 : 0.32) * (1 + kick * 0.12);
    const sx = sky === 'SUNNY' ? cx : cx - R * 0.25;
    const sy = sky === 'SUNNY' ? cy : cy - R * 0.25;
    ctx.fillStyle = rgba(ink.ac);
    ctx.beginPath();
    ctx.arc(sx, sy, sr, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = rgba(ink.ac);
    ctx.beginPath();
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * TAU + t * 0.4;
      const r0 = sr * 1.25;
      const r1 = sr * (1.55 + (k % 2 ? 0.15 : 0.35) + kick * 0.2);
      ctx.moveTo(sx + Math.cos(a) * r0, sy + Math.sin(a) * r0);
      ctx.lineTo(sx + Math.cos(a) * r1, sy + Math.sin(a) * r1);
    }
    ctx.stroke();
    if (sky === 'PARTLY CLOUDY') cloud(cx + R * 0.15, cy + R * 0.2, R * 0.6, ink.bg, ink.fg);
  } else if (sky === 'FOG') {
    ctx.strokeStyle = rgba(ink.fg, 0.7);
    ctx.beginPath();
    for (let k = 0; k < 5; k++) {
      const y = cy - R * 0.45 + k * R * 0.22;
      const off = Math.sin(t * 0.8 + k) * R * 0.15;
      ctx.moveTo(cx - R * 0.7 + off, y);
      ctx.lineTo(cx + R * 0.6 + off, y);
    }
    ctx.stroke();
  } else {
    // a cloud with rain / lightning / wind
    if (sky === 'PRESSURE RISING') {
      ctx.strokeStyle = rgba(ink.ac2);
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const y = cy + R * (0.35 + k * 0.13);
        const x0 = cx - R * 0.8 + ((t * R * 1.5 + k * R * 0.4) % (R * 0.6));
        ctx.moveTo(x0, y);
        ctx.lineTo(x0 + R * 0.9, y);
      }
      ctx.stroke();
    }
    if (sky === 'DRIZZLE' || sky === 'STORM') {
      ctx.strokeStyle = rgba(ink.ac2);
      ctx.beginPath();
      for (let k = 0; k < 9; k++) {
        const x = cx - R * 0.55 + (k / 8) * R * 1.1;
        const ph = fract(t * (sky === 'STORM' ? 2.2 : 1.1) + hash(k, 7));
        const y = cy + R * 0.25 + ph * R * 0.65;
        ctx.moveTo(x, y);
        ctx.lineTo(x - R * 0.06, y + R * 0.12);
      }
      ctx.stroke();
    }
    cloud(cx, cy - R * 0.05, R * 0.75, sky === 'STORM' ? ink.fg : ink.bg, ink.fg);
    if (sky === 'STORM' && kick > 0.25) {
      ctx.fillStyle = rgba(ink.ac);
      ctx.beginPath();
      ctx.moveTo(cx + R * 0.05, cy + R * 0.1);
      ctx.lineTo(cx - R * 0.18, cy + R * 0.55);
      ctx.lineTo(cx - R * 0.02, cy + R * 0.52);
      ctx.lineTo(cx - R * 0.14, cy + R * 0.95);
      ctx.lineTo(cx + R * 0.2, cy + R * 0.4);
      ctx.lineTo(cx + R * 0.03, cy + R * 0.43);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.lineCap = 'butt';
}

export function weather(): Module {
  let sky: Sky = 'PARTLY CLOUDY';
  let hold = 0;
  let temp = 60;
  return {
    label: 'MOOD FORECAST',
    meta: 'LOCAL · LIVE',
    clip: true,
    draw(ctx, r, bf) {
      const { a, ink, s, dt } = bf;
      hold -= dt;
      const here = sectionAt(bf).sec;
      const want = here && a.playing && (here.label === 'drop' || here.label === 'build') ? skyForSection(here) : skyFor(a.energy, a.brightness, a.build, a.drop);
      if (want !== sky && (hold <= 0 || want === 'STORM')) {
        sky = want;
        hold = 2;
      }
      temp = damp(temp, 38 + a.energy * 62, 1.5, dt);
      const fs = labelPx(s);
      const forecastH = r.h > fs * 14 ? fs * 5.5 : 0;
      const top = { x: r.x, y: r.y, w: r.w, h: r.h - forecastH };
      const icon = Math.min(top.h * 0.9, top.w * 0.42);
      drawSky(ctx, sky, top.x + icon / 2, top.y + top.h / 2, icon / 2, ink, bf.t, a.kick, Math.max(1.2, 2.2 * s * bf.lw));
      const tx = top.x + icon + fs * 1.2;
      const big = Math.min(top.h * 0.42, (top.w - icon) * 0.3);
      setFont(ctx, big, 700, SANS, -0.04);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = rgba(ink.fg);
      const ty = top.y + top.h * 0.5;
      ctx.fillText(`${Math.round(temp)}°`, tx, ty);
      text(ctx, sky, tx, ty + fs * 1.3, fs * 1.1, rgba(sky === 'STORM' ? ink.ac : ink.fg), 'left', 700);
      const drop = untilNext(bf, 'drop');
      const chance = drop === null ? (a.build > 0.3 ? Math.round(a.build * 90) : 5) : Math.round(clamp(100 - drop * 4, 10, 99));
      const lines = [
        `WIND ${Math.round(bpmOf(bf))} BPM · GUSTS ${fmt2(a.kick)}`,
        `HUMIDITY ${Math.round(a.bass * 100)}% · UV ${Math.round(a.brightness * 11)}`,
        `PRESSURE ${Math.round(1000 + clamp01(a.build) * 40 - clamp01(a.drop) * 25)} hPa`,
        `CHANCE OF DROP ${chance}%`,
      ];
      lines.forEach((l, i) => {
        const y = ty + fs * (2.9 + i * 1.45);
        if (y < top.y + top.h - fs * 0.3) text(ctx, l, tx, y, fs * 0.85, rgba(i === 3 ? ink.ac : ink.fg, i === 3 ? 1 : 0.62));
      });
      if (!forecastH) return;
      // forecast strip: the next few sections
      const fy = r.y + r.h - forecastH;
      ctx.fillStyle = rgba(ink.fg, 0.25);
      ctx.fillRect(r.x, Math.round(fy), r.w, bf.hl);
      const { i: ci, secs } = sectionAt(bf);
      const next = secs.length ? secs.slice(Math.max(0, ci), Math.max(0, ci) + 5) : [];
      const slots = next.length || 5;
      const sw = r.w / slots;
      for (let k = 0; k < slots; k++) {
        const sec = next[k];
        const x = r.x + k * sw;
        const sk: Sky = sec ? skyForSection(sec) : (['SUNNY', 'PARTLY CLOUDY', 'DRIZZLE', 'FOG', 'SUNNY'] as Sky[])[k];
        const label = sec ? (k === 0 ? 'NOW' : LABEL[sec.label]) : `+${k}`;
        text(ctx, label, x + sw / 2, fy + fs * 1, fs * 0.8, rgba(ink.fg, k === 0 ? 0.95 : 0.55), 'center');
        drawSky(ctx, sk, x + sw / 2, fy + forecastH * 0.52, Math.min(sw, forecastH) * 0.22, ink, bf.t, 0, Math.max(1, 1.3 * s));
        text(ctx, sec ? `${Math.round(38 + sec.energy * 62)}°` : '--°', x + sw / 2, fy + forecastH - fs * 0.6, fs * 0.8, rgba(ink.fg, 0.7), 'center');
      }
    },
  };
}

/* ───────────────────────── Song minimap ───────────────────────── */

export function minimap(): Module {
  let cv: HTMLCanvasElement | null = null;
  let key = '';
  let mapRect = { x: 0, y: 0, w: 0, h: 0 };
  return {
    label: 'SONG MAP',
    meta: 'SECTIONS · PLAYHEAD',
    clip: true,
    draw(ctx, r, bf) {
      const { a, ink, s, hl } = bf;
      const an = bf.f.analysis;
      const fs = labelPx(s) * 0.85;
      const head = fs * 2;
      mapRect = { x: r.x, y: r.y + head, w: r.w, h: r.h - head };
      const dur = an?.duration || a.duration || 0;
      if (!an || !dur) {
        // no song yet: a placeholder map that scrolls
        ctx.fillStyle = rgba(ink.fg, 0.12);
        const n = 7;
        for (let k = 0; k < n; k++) {
          const x = mapRect.x + ((k / n + bf.t * 0.02) % 1) * mapRect.w;
          const hh = mapRect.h * (0.3 + 0.5 * hash(k, 3));
          ctx.fillRect(x, mapRect.y + mapRect.h - hh, mapRect.w / n - 3 * s, hh);
        }
        text(ctx, 'WAITING FOR A SONG', r.x, r.y + fs * 0.7, fs, rgba(ink.fg, 0.6));
        return;
      }
      const k = `${Math.round(r.w)}x${Math.round(r.h)}|${ink.key}|${dur}|${an.sections.length}|${an.sections[0]?.start}`;
      if (k !== key || !cv) {
        key = k;
        cv = cv ?? document.createElement('canvas');
        cv.width = Math.max(2, Math.round(mapRect.w));
        cv.height = Math.max(2, Math.round(mapRect.h));
        const c = cv.getContext('2d')!;
        const W = cv.width;
        const H = cv.height;
        c.clearRect(0, 0, W, H);
        const bandH = Math.max(fs * 1.9, H * 0.28);
        an.sections.forEach((sec) => {
          const x0 = Math.round((sec.start / dur) * W);
          const x1 = Math.round((sec.end / dur) * W);
          const hot = sec.label === 'drop' || sec.label === 'chorus';
          const tint = hot ? ink.ac : sec.group % 2 ? ink.ac2 : ink.mu;
          c.fillStyle = rgba(tint, hot ? 0.9 : 0.75);
          c.fillRect(x0 + 1, H - bandH, Math.max(1, x1 - x0 - 2), bandH);
          setFont(c, fs * 0.85, 600, MONO, 0.06);
          c.textBaseline = 'middle';
          c.textAlign = 'left';
          c.fillStyle = rgba(hot ? ink.bg : ink.fg, 0.9);
          const lab = LABEL[sec.label];
          if (c.measureText(lab).width < x1 - x0 - 6) c.fillText(lab, x0 + 4, H - bandH / 2);
        });
        // energy curve
        const curve = an.energyCurve;
        const top = H - bandH - 4;
        c.fillStyle = rgba(ink.fg, 0.12);
        c.strokeStyle = rgba(ink.fg, 0.8);
        c.lineWidth = Math.max(1, s);
        c.beginPath();
        c.moveTo(0, top);
        for (let x = 0; x < W; x++) {
          const v = curve[Math.min(curve.length - 1, Math.floor((x / W) * curve.length))] || 0;
          c.lineTo(x, top - v * top * 0.92);
        }
        c.lineTo(W, top);
        c.closePath();
        c.fill();
        c.beginPath();
        for (let x = 0; x < W; x++) {
          const v = curve[Math.min(curve.length - 1, Math.floor((x / W) * curve.length))] || 0;
          if (x) c.lineTo(x, top - v * top * 0.92);
          else c.moveTo(x, top - v * top * 0.92);
        }
        c.stroke();
        c.fillStyle = rgba(ink.ac);
        for (const d of an.drops) {
          const x = (d / dur) * W;
          c.beginPath();
          c.moveTo(x - 4 * s, 0);
          c.lineTo(x + 4 * s, 0);
          c.lineTo(x, 7 * s);
          c.fill();
        }
      }
      ctx.drawImage(cv, mapRect.x, mapRect.y);
      // played part dimmed, playhead
      const px = mapRect.x + (clamp01(a.time / dur) * mapRect.w);
      ctx.fillStyle = rgba(ink.bg, 0.45);
      ctx.fillRect(mapRect.x, mapRect.y, px - mapRect.x, mapRect.h);
      ctx.fillStyle = rgba(ink.ac);
      ctx.fillRect(Math.round(px - hl), mapRect.y, hl * 2 + 1, mapRect.h);
      ctx.beginPath();
      ctx.moveTo(px - 5 * s, mapRect.y);
      ctx.lineTo(px + 5 * s, mapRect.y);
      ctx.lineTo(px, mapRect.y + 8 * s);
      ctx.fill();
      const { sec, i, secs } = sectionAt(bf);
      const nxt = secs[i + 1];
      text(ctx, sec ? `NOW ${LABEL[sec.label]} · ${fmtTime(a.time)}` : fmtTime(a.time), r.x, r.y + fs * 0.7, fs, rgba(ink.fg, 0.85));
      if (nxt) text(ctx, `NEXT ▸ ${LABEL[nxt.label]} IN ${fmtTime(Math.max(0, nxt.start - a.time))}`, r.x + r.w, r.y + fs * 0.7, fs, rgba(nxt.label === 'drop' ? ink.ac : ink.fg, 0.85), 'right');
    },
  };
}

/* ───────────────────────── Lyric word cloud ───────────────────────── */

export const STOP = new Set(
  'the a an and or but if of to in on at by for with from up out as is are was were be been am i im i\'m you your yours me my mine we our us he she it its they them their this that these those so not no do does did dont don\'t just all oh ooh yeah la na hey ah got get gotta can cant can\'t will wont won\'t would could should there here what when where who how than then too very into over'.split(
    ' ',
  ),
);
const IDLE_WORDS = ['hum', 'bass', 'kick', 'loop', 'night', 'glow', 'signal', 'echo', 'drift', 'pulse', 'static', 'bloom', 'tape', 'wave', 'heart', 'city'];

interface Cloud {
  w: string;
  n: number;
  x: number;
  y: number;
  bw: number;
  bh: number;
  vert: boolean;
  born: number;
  placed: boolean;
  last: number;
}

export function wordCloud(): Module {
  const words = new Map<string, Cloud>();
  let lastKey = '';
  let sizeKey = '';
  let idleBar = -1;
  let seen = 0;
  const placed: Cloud[] = [];
  const hits = (c: Cloud, x: number, y: number, w: number, h: number) =>
    placed.some((p) => p !== c && p.placed && x < p.x + p.bw && p.x < x + w && y < p.y + p.bh && p.y < y + h);

  const sizeOf = (r: Rect, n: number, s: number) => Math.min(r.h * 0.24, Math.max(11 * s, Math.min(r.h, r.w * 0.7) * 0.085 * (1 + Math.log2(n) * 0.7)));
  let seeded = false;

  const place = (ctx: CanvasRenderingContext2D, c: Cloud, r: Rect, s: number) => {
    const fs = sizeOf(r, c.n, s);
    setFont(ctx, fs, 700, SANS, -0.02);
    const tw = ctx.measureText(c.w).width + fs * 0.25;
    const th = fs * 0.95;
    c.vert = c.n < 3 && hash(c.w.length, c.w.charCodeAt(0)) < 0.22;
    const w = c.vert ? th : tw;
    const h = c.vert ? tw : th;
    c.placed = false;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const ar = r.w / Math.max(1, r.h);
    const seed = hash(c.w.charCodeAt(0), c.w.length, 9) * TAU;
    for (let k = 0; k < 420; k++) {
      const t = k * 0.35;
      const rad = t * 2.2 * s + 1;
      const x = cx + Math.cos(t + seed) * rad * ar - w / 2;
      const y = cy + Math.sin(t + seed) * rad - h / 2;
      if (x < r.x || y < r.y || x + w > r.x + r.w || y + h > r.y + r.h) continue;
      if (!hits(c, x, y, w, h)) {
        c.x = x;
        c.y = y;
        c.bw = w;
        c.bh = h;
        c.placed = true;
        break;
      }
    }
    if (!placed.includes(c)) placed.push(c);
  };

  const add = (ctx: CanvasRenderingContext2D, word: string, r: Rect, bf: BF) => {
    const w = word.toLowerCase().replace(/[^\p{L}\p{N}'’-]/gu, '').replace(/^['’-]+|['’-]+$/g, '');
    if (w.length < 3 || STOP.has(w)) return;
    let c = words.get(w);
    if (!c) {
      c = { w, n: 0, x: 0, y: 0, bw: 0, bh: 0, vert: false, born: bf.t, placed: false, last: bf.t };
      words.set(w, c);
    }
    c.n++;
    c.last = bf.t;
    c.born = bf.t;
    seen++;
    place(ctx, c, r, bf.s);
    // too crowded: drop the oldest single-use words
    if (words.size > 70) {
      const old = [...words.values()].filter((x) => x.n === 1).sort((p, q) => p.last - q.last)[0];
      if (old) {
        words.delete(old.w);
        placed.splice(placed.indexOf(old), 1);
      }
    }
  };

  return {
    label: 'WORDS',
    meta: 'SUNG SO FAR',
    clip: true,
    draw(ctx, r, bf) {
      const { ink, s, a } = bf;
      const sk = `${Math.round(r.w)}x${Math.round(r.h)}`;
      if (sk !== sizeKey) {
        sizeKey = sk;
        placed.length = 0;
        for (const c of words.values()) place(ctx, c, r, s);
      }
      if (!seeded) {
        // open dense: everything already sung (or typed) goes in at once
        seeded = true;
        const lines = syncedLines();
        const past = lines ? lines.filter((l) => l.t < bf.a.time).slice(-24).map((l) => l.text) : (bf.f.text || '').split(/\n|\s\/\s|\s\|\s/);
        for (const l of past) for (const w of l.split(/\s+/)) add(ctx, w, r, bf);
        for (const c of words.values()) c.born = bf.t - 1;
      }
      const cur = currentLine(bf);
      let current = new Set<string>();
      if (cur) {
        current = new Set(cur.text.toLowerCase().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}'’-]/gu, '')));
        if (cur.key !== lastKey && bf.live) {
          lastKey = cur.key;
          for (const w of cur.text.split(/\s+/)) add(ctx, w, r, bf);
        }
      } else if (!syncedLines() && !(bf.f.text || '').trim() && bf.live) {
        // nothing to sing: drift through song words on bars
        const bar = barOf(bf);
        if (bar !== idleBar && a.beat) {
          idleBar = bar;
          const tags = bf.f.analysis?.tags ?? [];
          const pool = [...tags, ...IDLE_WORDS];
          add(ctx, pool[Math.floor(Math.random() * pool.length)], r, bf);
        }
      }
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      for (const c of words.values()) {
        if (!c.placed) continue;
        const fs = sizeOf(r, c.n, s);
        const age = bf.t - c.born;
        const pop = age < 0.25 ? 1 + (1 - age / 0.25) * 0.35 : 1;
        const hot = current.has(c.w);
        setFont(ctx, fs * pop, 700, SANS, -0.02);
        const recency = clamp01(1 - (bf.t - c.last) / 40);
        ctx.fillStyle = hot ? rgba(ink.ac) : rgba(c.n > 2 ? ink.fg : ink.ac2, 0.45 + 0.55 * Math.max(recency, c.n > 2 ? 0.8 : 0));
        ctx.save();
        if (c.vert) {
          ctx.translate(c.x + c.bw * 0.78, c.y + c.bh);
          ctx.rotate(-Math.PI / 2);
          ctx.fillText(c.w, 0, 0);
        } else {
          const bob = hot ? -a.kick * fs * 0.15 : 0;
          ctx.fillText(c.w, c.x + fs * 0.12, c.y + c.bh * 0.82 + bob);
        }
        ctx.restore();
      }
      const fs = labelPx(s) * 0.8;
      text(ctx, `${pad3(words.size)} WORDS · ${pad3(seen)} SUNG`, r.x + r.w, r.y + r.h - fs * 0.5, fs, rgba(ink.fg, 0.5), 'right');
    },
  };
}

/* ───────────────────────── Lyric typewriter ───────────────────────── */

export function typewriter(): Module {
  const history: string[] = [];
  let lastKey = '';
  let lastText = '';
  let feed = 0;
  let shownChars = 0;
  let strike = 0;
  let ding = 0;
  let lineNo = 0;
  return {
    label: 'TYPEWRITER',
    meta: 'LINE BY LINE',
    clip: true,
    drawStatic(ctx, r, sf) {
      const { ink, s, hl } = sf;
      const lh = Math.max(14, Math.min(r.h / 6.5, 46 * s));
      ctx.fillStyle = rgba(ink.fg, 0.1);
      for (let y = r.y + r.h - lh * 0.55; y > r.y; y -= lh) ctx.fillRect(r.x, Math.round(y), r.w, hl);
      ctx.fillStyle = rgba(ink.ac2, 0.7);
      ctx.fillRect(Math.round(r.x + Math.min(r.w * 0.08, 40 * s)), r.y, hl, r.h);
    },
    draw(ctx, r, bf) {
      const { ink, s, dt, a } = bf;
      const lh = Math.max(14, Math.min(r.h / 6.5, 46 * s));
      const fs = lh * 0.56;
      const margin = Math.min(r.w * 0.08, 40 * s) + fs * 0.6;
      const cur = currentLine(bf);
      if (cur && cur.key !== lastKey) {
        if (lastText) {
          history.push(lastText);
          if (history.length > 12) history.shift();
          feed = 1;
          ding = 0.6;
        }
        lastKey = cur.key;
        lastText = cur.text;
        shownChars = 0;
        lineNo++;
      }
      feed = damp(feed, 0, 12, dt);
      ding = Math.max(0, ding - dt);
      setFont(ctx, fs, 500, MONO, 0.02);
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      const maxW = r.w - margin - fs;
      const rows = lastText ? wrapWords(ctx, lastText, maxW) : [];
      const total = rows.reduce((n, x) => n + x.length + 1, 0);
      const target = cur ? (bf.a.playing || bf.idle ? Math.ceil(cur.prog * total) : total) : total;
      if (target > shownChars) {
        shownChars = Math.min(target, shownChars + Math.max(1, Math.round(dt * 40)));
        strike = 1;
      }
      strike = Math.max(0, strike - dt * 12);
      const baseY = r.y + r.h - lh * 0.7 + feed * lh;
      // current line(s), typed so far
      let left = shownChars;
      let caretX = r.x + margin;
      let caretY = baseY;
      const curRows = rows.length;
      rows.forEach((row, ri) => {
        const y = baseY - (curRows - 1 - ri) * lh;
        const vis = row.slice(0, Math.max(0, left));
        left -= row.length + 1;
        ctx.fillStyle = rgba(ink.fg);
        // the newest character lands a hair off, like a real key strike
        if (vis.length && left < 0 && strike > 0) {
          const head = vis.slice(0, -1);
          ctx.fillText(head, r.x + margin, y);
          ctx.fillStyle = rgba(ink.ac);
          ctx.fillText(vis.slice(-1), r.x + margin + ctx.measureText(head).width, y - strike * fs * 0.12);
        } else ctx.fillText(vis, r.x + margin, y);
        if (vis.length || ri === 0) {
          caretX = r.x + margin + ctx.measureText(vis).width;
          caretY = y;
        }
      });
      if (Math.floor(bf.t * 2.2) % 2 === 0 || strike > 0) {
        ctx.fillStyle = rgba(ink.ac);
        ctx.fillRect(caretX + 1, caretY - fs * 0.85, Math.max(2, fs * 0.08), fs);
      }
      // older lines above, fading up the page
      let y = baseY - curRows * lh;
      for (let k = history.length - 1; k >= 0 && y > r.y - lh; k--) {
        const hr = wrapWords(ctx, history[k], maxW);
        for (let j = hr.length - 1; j >= 0 && y > r.y - lh; j--) {
          const age = (baseY - y) / r.h;
          ctx.fillStyle = rgba(ink.fg, Math.max(0.12, 0.7 - age * 0.7));
          ctx.fillText(hr[j], r.x + margin, y);
          y -= lh;
        }
      }
      if (!lastText) text(ctx, bf.idle ? 'paste lyrics or type a line in Look → text' : '…', r.x + margin, baseY - fs * 0.3, fs * 0.8, rgba(ink.fg, 0.4));
      const ms = labelPx(s) * 0.78;
      const wpm = Math.round(bpmOf(bf) * 0.4 + a.energy * 20);
      text(ctx, `${ding > 0 ? 'DING! · ' : ''}LINE ${pad2(lineNo)} · ${wpm} WPM`, r.x + r.w, r.y + ms * 0.7, ms, rgba(ding > 0 ? ink.ac : ink.fg, 0.6), 'right');
    },
  };
}
