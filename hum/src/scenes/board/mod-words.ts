/**
 * Lyric instruments. A song's words are known as soon as it's imported, so these read the whole
 * lyric sheet, not just the line being sung:
 *
 *   upNext     "now singing": the sung line, word by word on time, and a countdown between lines
 *   ticker     a news crawl of the whole lyric sheet, scrolled in time with the song
 *   topWords   the most-sung words as a hi-score table, counting up as they're sung
 *
 * Without timed lyrics each falls back to something that still reads the music (the typed text,
 * the song map, live hit counters), the way the typewriter does.
 */
import type { LyricLine } from '../../core/types';
import { LABEL, STOP, barOf, currentLine, sectionAt, syncedLines, wrapWords } from './mod-fun';
import { MONO, SANS, clamp01, damp, fmtTime, labelPx, pad2, pad3, rgba, setFont, text } from './kit';
import type { BF, Module } from './kit';
import { LEAD, noteLineWindow, showingNow, showings } from '../../render/lyricTiming';

/** typed text split into lines, the way currentLine() cycles them */
function typedParts(bf: BF): string[] {
  return (bf.f.text || '')
    .split(/\n|\s\/\s|\s\|\s/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** index of the first line that starts after t (lines.length when none) */
function nextIndex(lines: LyricLine[], t: number) {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (lines[m].t <= t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** fit up to `maxRows` wrapped rows of `s` into w × h, largest size first */
function fitRows(ctx: CanvasRenderingContext2D, s: string, w: number, h: number, maxPx: number, maxRows: number, weight = 700, family = SANS) {
  let px = maxPx;
  let rows: string[] = [];
  for (let k = 0; k < 10; k++) {
    setFont(ctx, px, weight, family, -0.01);
    rows = wrapWords(ctx, s, w);
    if (rows.length <= maxRows && rows.length * px * 1.12 <= h && rows.every((r) => ctx.measureText(r).width <= w)) break;
    px *= 0.86;
  }
  return { px, rows: rows.slice(0, maxRows) };
}

function ellipsize(ctx: CanvasRenderingContext2D, s: string, w: number) {
  if (ctx.measureText(s).width <= w) return s;
  let t = s;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > w) t = t.slice(0, -1);
  return `${t}…`;
}

/* ───────────────────────── Up next ───────────────────────── */

/**
 * The line being sung, big, each word appearing as it's sung (never before), held until the line is
 * read, the same moments the lyric overlay uses (render/lyricTiming.ts). Between lines: a countdown
 * to the next one, without its words. While this window is open with synced lyrics it tells the
 * lyric layer, which stands down: the words are in one place at a time.
 *
 * It used to show the NEXT line big, which read as the lyrics arriving early and moving on before
 * they were sung.
 */
export function upNext(): Module {
  let shown = '';
  let slide = 0;
  return {
    label: 'NOW SINGING',
    meta: 'THE SUNG LINE',
    clip: true,
    draw(ctx, r, bf) {
      const lines = syncedLines();
      if (lines) {
        // one place for the words: the lyric overlay stands down while this window is open
        noteLineWindow();
        drawSung(ctx, r, bf, lines);
        return;
      }
      // no synced lyrics: the typed text, or the next part of the song
      const { ink, s, dt } = bf;
      let now = '';
      let next = '';
      let left = '';
      let frac = 0;
      let foot = '';
      const parts = typedParts(bf);
      if (parts.length) {
        // typed text cycles every 8 beats (see currentLine): the next one is the line after
        const cur = currentLine(bf);
        const i = Math.max(0, parts.findIndex((p) => cur?.text === p));
        now = parts[i];
        next = parts[(i + 1) % parts.length];
        frac = cur?.prog ?? 0;
        foot = `LINE ${pad2(i + 1)} / ${pad2(parts.length)}`;
      } else {
        const { i, secs } = sectionAt(bf);
        const nx = secs[i + 1];
        if (nx) {
          next = `${LABEL[nx.label].toLowerCase()} coming up`;
          const from = i >= 0 ? secs[i].start : 0;
          frac = clamp01((bf.a.time - from) / Math.max(0.5, nx.start - from));
          left = `IN ${fmtTime(Math.max(0, nx.start - bf.a.time))}`;
          foot = `PART ${pad2(i + 2)} / ${pad2(secs.length)}`;
        } else {
          next = bf.idle ? 'paste lyrics to see the words here' : 'no words in this one';
          foot = 'NO LYRICS';
        }
      }
      if (next !== shown) {
        shown = next;
        slide = 1;
      }
      slide = damp(slide, 0, 10, dt);

      const lp = labelPx(s);
      setFont(ctx, lp * 0.95, 500, MONO, 0.04);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillStyle = rgba(ink.fg, 0.5);
      if (now) ctx.fillText(ellipsize(ctx, `NOW · ${now.toUpperCase()}`, r.w), r.x, r.y + lp * 0.6);
      const top = r.y + lp * 1.6;
      const bot = r.y + r.h - lp * 1.9;
      const fit = fitRows(ctx, next, r.w, bot - top, Math.min(r.h * 0.3, 54 * s), 3);
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = rgba(ink.fg, 1 - slide * 0.8);
      const lh = fit.px * 1.1;
      const y0 = top + (bot - top - lh * fit.rows.length) / 2 + fit.px * 0.92 + slide * lh * 0.6;
      fit.rows.forEach((row, k) => ctx.fillText(row, r.x, y0 + k * lh));
      footBar(ctx, r, bf, frac, foot, left);
    },
  };
}

/** the bar and small print along the bottom of the window */
function footBar(ctx: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }, bf: BF, frac: number, foot: string, right: string) {
  const { ink, s } = bf;
  const lp = labelPx(s);
  const by = r.y + r.h - lp * 1.2;
  const bh = Math.max(2, lp * 0.32);
  ctx.fillStyle = rgba(ink.fg, 0.12);
  ctx.fillRect(r.x, by, r.w, bh);
  ctx.fillStyle = rgba(ink.ac);
  ctx.fillRect(r.x, by, r.w * clamp01(frac), bh);
  const ms = lp * 0.8;
  text(ctx, foot, r.x, r.y + r.h - ms * 0.4, ms, rgba(ink.fg, 0.5), 'left');
  if (right) text(ctx, right, r.x + r.w, r.y + r.h - ms * 0.4, ms, rgba(ink.ac, 0.9), 'right', 600);
}

/** how long a word takes to rise in, and how long the line fades (s) */
const WORD_IN = 0.12;
const LINE_FADE = 0.25;

/**
 * The sung line, word by word, as a pure function of song time: the showing on screen is the one the
 * lyric overlay would show (lyricTiming.showingNow), each word appears on its sung time and the newest
 * is in the accent until the next one arrives. Between lines: how long until the next one.
 */
function drawSung(ctx: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }, bf: BF, lines: LyricLine[]) {
  const { ink, s } = bf;
  const t = bf.a.time;
  const lp = labelPx(s);
  const shows = showings(lines);
  const cur = showingNow(lines, t);
  const { i: si, secs } = sectionAt(bf);
  const part = si >= 0 && secs[si] ? LABEL[secs[si].label] : '';
  if (part) text(ctx, part, r.x + r.w, r.y + lp * 0.6, lp * 0.8, rgba(ink.fg, 0.5), 'right', 600);

  if (!cur) {
    // between lines: a countdown, no words (they show when they're sung)
    const ni = shows.findIndex((sh) => sh.t > t);
    if (ni < 0) {
      text(ctx, 'that was the last line', r.x, r.y + r.h * 0.5, lp * 1.1, rgba(ink.fg, 0.45), 'left');
      footBar(ctx, r, bf, 1, `${pad2(shows.length)} / ${pad2(shows.length)}`, '');
      return;
    }
    const from = ni > 0 ? shows[ni - 1].end : 0;
    const wait = Math.max(0, shows[ni].t - t);
    text(ctx, 'NEXT LINE', r.x, r.y + r.h * 0.42, lp, rgba(ink.fg, 0.45), 'left', 600);
    text(ctx, `${wait.toFixed(1)}S`, r.x, r.y + r.h * 0.42 + lp * 1.6, lp * 1.6, rgba(ink.ac, 0.85), 'left', 600);
    footBar(ctx, r, bf, (t - from) / Math.max(0.5, shows[ni].t - from), `LINE ${pad2(ni + 1)} / ${pad2(shows.length)}`, '');
    return;
  }

  const sh = cur.line;
  const words = sh.words;
  const lineA = clamp01(Math.min((t + LEAD - sh.t) / 0.1, (sh.end - t) / LINE_FADE + 1));
  // fitted as a whole line, so nothing reflows as the words arrive
  const top = r.y + lp * 1.6;
  const bot = r.y + r.h - lp * 1.9;
  const fit = fitRows(ctx, sh.text, r.w, bot - top, Math.min(r.h * 0.3, 54 * s), 3);
  setFont(ctx, fit.px, 700, SANS, -0.01);
  const space = ctx.measureText(' ').width;
  const rows: { i: number; x: number }[][] = [[]];
  let x = 0;
  words.forEach((w, i) => {
    const ww = ctx.measureText(w.text).width;
    if (x > 0 && x + space + ww > r.w) {
      rows.push([]);
      x = 0;
    }
    rows[rows.length - 1].push({ i, x: x > 0 ? x + space : 0 });
    x = (x > 0 ? x + space : 0) + ww;
  });
  const lh = fit.px * 1.1;
  const y0 = top + (bot - top - lh * rows.length) / 2 + fit.px * 0.92;
  let newest = -1;
  words.forEach((w, i) => {
    if (w.t <= t) newest = i;
  });
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  rows.forEach((row, k) => {
    for (const { i, x: wx } of row) {
      const age = t - words[i].t;
      if (age < 0) continue;
      const p = clamp01(age / WORD_IN);
      ctx.fillStyle = rgba(i === newest ? ink.ac : ink.fg, lineA * (0.3 + 0.7 * p));
      ctx.fillText(words[i].text, r.x + wx, y0 + k * lh + (1 - p) * fit.px * 0.25);
    }
  });
  const sung = newest + 1;
  footBar(ctx, r, bf, words.length ? sung / words.length : 0, `LINE ${pad2(cur.i + 1)} / ${pad2(shows.length)}`, '');
}

/* ───────────────────────── Bulletin ticker ───────────────────────── */

interface Run {
  text: string;
  x: number;
  w: number;
  t: number;
}

export function ticker(label = 'BULLETIN'): Module {
  let runs: Run[] = [];
  let runsKey = '';
  let total = 0;
  let free = 0;
  let pos = 0;
  const SEP = '   ◆   ';
  return {
    label,
    meta: 'THE WHOLE SONG',
    clip: true,
    draw(ctx, r, bf) {
      const { ink, s, dt, a } = bf;
      const px = Math.min(r.h * 0.46, 40 * s);
      setFont(ctx, px, 600, MONO, 0.02);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const lines = syncedLines();
      const head = r.x + r.w * 0.18;
      const y = r.y + r.h / 2;

      // the crawl: every lyric line once, or song facts when there are no lyrics
      let items: { text: string; t: number }[];
      if (lines) items = lines.map((l) => ({ text: l.text.toUpperCase(), t: l.t }));
      else {
        const an = bf.f.analysis;
        const typed = typedParts(bf);
        items = (
          typed.length
            ? typed
            : [
                an ? `${Math.round(an.bpm)} BPM` : 'LIVE SIGNAL',
                an ? `${an.sections.length} PARTS: ${an.sections.map((x) => LABEL[x.label]).join(' · ')}` : 'NO SONG MAP YET',
                an?.tags.length ? `MOOD ${an.tags.slice(0, 4).join(', ').toUpperCase()}` : 'MOOD UNKNOWN',
                an ? `RUNS ${fmtTime(an.duration)}` : 'DROP A SONG TO BEGIN',
                bf.idle ? 'NO LYRICS · PASTE SOME IN THE LYRICS CHIP' : 'NO WORDS IN THIS ONE',
              ]
        ).map((text) => ({ text: text.toUpperCase(), t: -1 }));
      }
      const key = `${ctx.font}|${items.length}|${items[0]?.text}|${items[items.length - 1]?.text}|${items[items.length - 1]?.t}`;
      if (key !== runsKey) {
        runsKey = key;
        let x = 0;
        const sepW = ctx.measureText(SEP).width;
        runs = items.map((it) => {
          const w = ctx.measureText(it.text).width;
          const run = { text: it.text, x, w, t: it.t };
          x += w + sepW;
          return run;
        });
        total = Math.max(1, x);
      }

      let cur = -1;
      if (lines && runs.length) {
        // in time with the song: each line's start reaches the read head as it's sung
        const t = a.time + 0.08;
        const ni = nextIndex(lines, t);
        cur = ni - 1;
        let target: number;
        if (cur < 0) target = runs[0].x - (head - r.x) * clamp01(1 - t / Math.max(0.5, lines[0].t));
        else if (ni >= runs.length) target = runs[cur].x + runs[cur].w * clamp01((t - lines[cur].t) / Math.max(0.5, lines[cur].end - lines[cur].t));
        else target = runs[cur].x + (runs[ni].x - runs[cur].x) * clamp01((t - lines[cur].t) / Math.max(0.3, lines[ni].t - lines[cur].t));
        pos = Math.abs(target - pos) > r.w ? target : damp(pos, target, 8, dt);
      } else {
        // a steady crawl, nudged on kicks
        free += dt * (60 * s + a.kick * 40 * s) * (bf.live ? 1 : 0.4);
        pos = free % total;
      }

      const off = head - pos;
      for (const loop of lines ? [0] : [0, total]) {
        runs.forEach((run, k) => {
          const x = off + run.x + loop;
          if (x > r.x + r.w || x + run.w < r.x) return;
          // with lyrics, nothing is shown before it's sung: lines still to come are left off, and the
          // line being sung grows word by word on its words' times
          if (lines && k > cur) return;
          let shownText = run.text;
          let whole = true;
          if (lines && k === cur) {
            const ws = lines[k].words;
            if (ws?.length) {
              const sung = ws.filter((w) => w.t <= a.time).length;
              whole = sung >= ws.length;
              shownText = ws.slice(0, sung).map((w) => w.text.toUpperCase()).join(' ');
            }
          }
          ctx.fillStyle = k === cur ? rgba(ink.ac) : lines && k < cur ? rgba(ink.fg, 0.38) : rgba(ink.fg, 0.88);
          if (shownText) ctx.fillText(shownText, x, y);
          if (!whole) return;
          const sx = x + run.w;
          if (sx < r.x + r.w) {
            ctx.fillStyle = rgba(ink.ac2, 0.8);
            ctx.fillText(SEP, sx, y);
          }
        });
      }
      // live dot at the left edge
      const lp = labelPx(s);
      ctx.fillStyle = rgba(ink.bg, 0.92);
      ctx.fillRect(r.x, r.y, lp * 5.2, r.h);
      const on = Math.floor(bf.t * 1.6) % 2 === 0;
      ctx.fillStyle = rgba(ink.ac, on ? 1 : 0.35);
      ctx.beginPath();
      ctx.arc(r.x + lp * 0.6, y, lp * 0.36, 0, Math.PI * 2);
      ctx.fill();
      text(ctx, lines ? 'LIVE' : 'WIRE', r.x + lp * 1.3, y, lp * 0.95, rgba(ink.fg, 0.8), 'left', 600);
    },
  };
}

/* ───────────────────────── Hi-scores (most-sung words) ───────────────────────── */

interface Score {
  w: string;
  /** when each occurrence is sung */
  at: number[];
}

const clean = (w: string) =>
  w
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'’-]/gu, '')
    .replace(/^['’-]+|['’-]+$/g, '');

function tally(lines: LyricLine[]): Score[] {
  const map = new Map<string, Score>();
  for (const l of lines) {
    const words = l.words?.length ? l.words : l.text.split(/\s+/).map((text) => ({ text, t: l.t }));
    for (const wd of words) {
      const w = clean(wd.text);
      if (w.length < 3 || STOP.has(w)) continue;
      let sc = map.get(w);
      if (!sc) map.set(w, (sc = { w, at: [] }));
      sc.at.push(wd.t);
    }
  }
  const all = [...map.values()];
  const repeated = all.filter((x) => x.at.length > 1);
  return (repeated.length >= 3 ? repeated : all).sort((p, q) => q.at.length - p.at.length || p.at[0] - q.at[0]);
}

const RANKS = ['1ST', '2ND', '3RD', '4TH', '5TH', '6TH', '7TH', '8TH', '9TH'];

export function topWords(label = 'HI-SCORES'): Module {
  let src: LyricLine[] | null = null;
  let scores: Score[] = [];
  // fallback: live hit counters
  const hits = { kicks: 0, snares: 0, beats: 0, bars: 0, drops: 0 };
  let lastBar = -1;
  let lastDrop = 0;
  const flash = new Map<string, number>();
  return {
    label,
    meta: 'MOST SUNG',
    clip: true,
    draw(ctx, r, bf) {
      const { ink, s, a, dt } = bf;
      const lines = syncedLines();
      if (lines !== src) {
        src = lines;
        scores = lines ? tally(lines) : [];
      }
      let rows: { name: string; n: number; of: number; hot: boolean }[];
      let foot: string;
      if (scores.length) {
        const t = a.time + 0.08;
        const cur = currentLine(bf);
        const now = new Set((cur?.text ?? '').split(/\s+/).map(clean));
        rows = scores.map((sc) => {
          let n = 0;
          while (n < sc.at.length && sc.at[n] <= t) n++;
          return { name: sc.w.toUpperCase(), n, of: sc.at.length, hot: now.has(sc.w) };
        });
        const sung = rows.reduce((acc, x) => acc + x.n, 0);
        const all = rows.reduce((acc, x) => acc + x.of, 0);
        foot = `${pad3(sung)} / ${pad3(all)} SUNG`;
      } else {
        if (bf.live) {
          if (a.kickHit) hits.kicks++;
          if (a.snareHit) hits.snares++;
          if (a.beat) hits.beats++;
          const bar = barOf(bf);
          if (bar !== lastBar) {
            lastBar = bar;
            hits.bars++;
          }
          if (a.drop > 0.6 && lastDrop <= 0.6) hits.drops++;
          lastDrop = a.drop;
        }
        if (a.kickHit) flash.set('KICKS', 1);
        if (a.snareHit) flash.set('SNARES', 1);
        rows = [
          { name: 'KICKS', n: hits.kicks, of: 0, hot: (flash.get('KICKS') ?? 0) > 0.3 },
          { name: 'BEATS', n: hits.beats, of: 0, hot: false },
          { name: 'SNARES', n: hits.snares, of: 0, hot: (flash.get('SNARES') ?? 0) > 0.3 },
          { name: 'BARS', n: hits.bars, of: 0, hot: false },
          { name: 'DROPS', n: hits.drops, of: 0, hot: false },
        ].sort((p, q) => q.n - p.n);
        foot = bf.idle ? 'NO LYRICS · COUNTING HITS' : 'NO WORDS · COUNTING HITS';
      }
      for (const [k, v] of flash) flash.set(k, Math.max(0, v - dt * 4));

      const lp = labelPx(s);
      const footH = lp * 1.3;
      const n = Math.max(1, Math.min(rows.length, RANKS.length, Math.floor((r.h - footH) / Math.max(lp * 1.6, 14))));
      const rh = (r.h - footH) / n;
      // sized so "8TH" + a seven-letter word + "00/00" fit the panel's width
      const px = Math.min(rh * 0.6, 30 * s, r.w / 12);
      const fixed = scores.length > 0;
      for (let k = 0; k < n; k++) {
        const row = rows[k];
        const y = r.y + rh * (k + 0.5);
        const col = row.hot ? ink.ac : ink.fg;
        setFont(ctx, px, 600, MONO, 0.04);
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillStyle = rgba(col, row.hot ? 1 : 0.55);
        ctx.fillText(RANKS[k], r.x, y);
        const nameX = r.x + ctx.measureText('8TH ').width;
        const score = fixed ? `${pad2(row.n)}/${pad2(row.of)}` : pad3(row.n);
        const scoreW = ctx.measureText(score).width;
        setFont(ctx, px, 700, SANS, 0.01);
        const name = ellipsize(ctx, row.name, Math.max(10, r.w - (nameX - r.x) - scoreW - px));
        ctx.fillStyle = rgba(col, fixed && row.n === 0 ? 0.35 : 1);
        ctx.fillText(name, nameX, y);
        // dotted leader to the score
        const lx0 = nameX + ctx.measureText(name).width + px * 0.4;
        const lx1 = r.x + r.w - scoreW - px * 0.4;
        ctx.fillStyle = rgba(ink.fg, 0.25);
        for (let x = lx0; x < lx1; x += px * 0.45) ctx.fillRect(x, y + px * 0.25, Math.max(1, px * 0.1), Math.max(1, px * 0.1));
        setFont(ctx, px, 600, MONO, 0.04);
        ctx.textAlign = 'right';
        ctx.fillStyle = rgba(row.hot ? ink.ac : ink.fg, 0.9);
        ctx.fillText(score, r.x + r.w, y);
        // how much of it has been sung, as a hairline under the row
        if (fixed && row.of) {
          ctx.fillStyle = rgba(ink.ac2, 0.7);
          ctx.fillRect(nameX, y + rh * 0.4, (r.x + r.w - nameX) * (row.n / row.of), Math.max(1, bf.hl));
        }
      }
      text(ctx, foot, r.x + r.w, r.y + r.h - footH * 0.4, lp * 0.8, rgba(ink.fg, 0.5), 'right');
    },
  };
}
