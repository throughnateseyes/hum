/**
 * Text Wall — a black page filled edge to edge with the song's words. Words get knocked out,
 * dimmed, underlined or boxed; highlight boxes snap onto words on the beat, the line being sung
 * lights up wherever it appears on the wall, and a drop floods the page with colour.
 *
 * Canvas 2D: word widths are measured once per layout, each frame only draws the visible words.
 */
import { defineCanvasScene } from '../../core/sceneHelpers';
import { num, str } from '../../core/uniforms';
import type { FrameContext, LyricLine, ParamDef } from '../../core/types';
import { useStudio } from '../../state/store';

const SANS = "'Inter Variable', Inter, 'Helvetica Neue', Arial, sans-serif";
const GLYPHS = ['●', '■', '◆', '▲', '◇', '○', '□', '△', '✦', '⬢', '◐', '⌘', '✕', '◼', '▶', '◀'];

const params: ParamDef[] = [
  { id: 'rows', label: 'Rows', group: 'Layout', type: 'number', min: 12, max: 60, step: 1, default: 30, hint: 'Lines of text from top to bottom' },
  { id: 'gaps', label: 'Knock-outs', group: 'Layout', type: 'number', min: 0, max: 0.6, step: 0.01, default: 0.2, hint: 'Share of words left blank' },
  { id: 'dim', label: 'Dimmed words', group: 'Layout', type: 'number', min: 0, max: 0.8, step: 0.01, default: 0.3 },
  { id: 'drift', label: 'Row drift', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.2, hint: 'Rows slide sideways, alternating directions' },
  { id: 'jolt', label: 'Kick jolt', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.35, hint: 'Kicks shove a few rows sideways' },
  { id: 'boxes', label: 'Beat highlights', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.55, hint: 'How many words get boxed on each beat' },
  { id: 'hold', label: 'Highlight hold', group: 'Reactivity', type: 'number', min: 0.2, max: 3, step: 0.05, default: 1, hint: 'Beats a highlight stays on' },
  { id: 'flood', label: 'Drop flood', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.8 },
  { id: 'sung', label: 'Sung words glow', group: 'Lyrics', type: 'number', min: 0, max: 1, step: 0.01, default: 1, hint: 'The line being sung lights up everywhere it appears' },
  {
    id: 'colors',
    label: 'Highlight colours',
    group: 'Color',
    type: 'select',
    options: [
      { value: 'signal', label: 'Signal (red, yellow, blue, cyan)' },
      { value: 'palette', label: 'Palette only' },
      { value: 'mono', label: 'Greys only' },
    ],
    default: 'signal',
  },
];

interface Tok {
  text: string;
  /** left edge within the row */
  x: number;
  w: number;
  /** lyric line + word index this token came from (-1 for fallback words) */
  line: number;
  word: number;
  /** base style: 0 normal, 1 dim, 2 knocked out, 3 underline, 4 italic, 5 coloured text, 6 grey box, 7 blank block, 8 glyph run */
  style: number;
  shade: number;
  /** highlight colour index (-1 = none), time it snapped on, seconds left */
  hl: number;
  hlAt: number;
  hlLeft: number;
}
interface Row {
  toks: Tok[];
  width: number;
  x: number;
  speed: number;
  kick: number;
  kickV: number;
}
interface St {
  key: string;
  rows: Row[];
  rowH: number;
  px: number;
  space: number;
  t: number;
  beatT: number;
  prevDrop: number;
  rng: number;
}

/** small deterministic rng so layouts are stable across rebuilds */
function rng(st: St) {
  st.rng = (st.rng * 1664525 + 1013904223) >>> 0;
  return st.rng / 4294967296;
}

function lyricLines(): LyricLine[] | null {
  try {
    const l = useStudio.getState().lyrics;
    return l && l.lines.length ? l.lines : null;
  } catch {
    return null;
  }
}

/** words to fill the wall with, each tagged with where it came from in the lyrics */
function sourceWords(f: FrameContext): { text: string; line: number; word: number }[] {
  const lines = lyricLines();
  if (lines) {
    const out: { text: string; line: number; word: number }[] = [];
    lines.forEach((ln, li) => ln.text.split(/\s+/).filter(Boolean).forEach((w, wi) => out.push({ text: w, line: li, word: wi })));
    if (out.length) return out;
  }
  const typed = (f.text || '').split(/\s+/).filter(Boolean);
  if (typed.length > 3) return typed.map((t) => ({ text: t, line: -1, word: -1 }));
  // no lyrics: the song's own facts
  let title = '';
  try {
    title = useStudio.getState().track?.name ?? '';
  } catch {
    /* */
  }
  const a = f.analysis;
  const words: string[] = [];
  const push = (s: string | undefined) => s && words.push(...s.split(/\s+/).filter(Boolean));
  push(title.replace(/\.[a-z0-9]{2,4}$/i, ''));
  push(typed.join(' '));
  if (a) {
    push(a.character?.genre);
    push(a.character?.mood);
    a.character?.instruments.forEach(push);
    a.tags.forEach(push);
    push(`${Math.round(a.bpm)} bpm`);
    a.sections.forEach((s) => push(s.label));
    if (a.drops.length) push(`${a.drops.length} drops`);
  }
  if (words.length < 6) push('hum listen closer turn it up the room is breathing bass in the floor hands up again');
  return words.map((t) => ({ text: t, line: -1, word: -1 }));
}

function pickStyle(st: St, gaps: number, dim: number) {
  const r = rng(st);
  let c = gaps;
  if (r < c) return 2;
  c += dim;
  if (r < c) return 1;
  c += 0.035;
  if (r < c) return 3;
  c += 0.02;
  if (r < c) return 4;
  c += 0.03;
  if (r < c) return 5;
  c += 0.04;
  if (r < c) return 6;
  c += 0.012;
  if (r < c) return 7;
  c += 0.012;
  if (r < c) return 8;
  return 0;
}

function glyphRun(st: St) {
  const n = 3 + Math.floor(rng(st) * 5);
  let s = '';
  for (let i = 0; i < n; i++) s += GLYPHS[Math.floor(rng(st) * GLYPHS.length)];
  return s;
}

function build(ctx: CanvasRenderingContext2D, f: FrameContext, st: St, key: string) {
  const w = f.width;
  const h = f.height;
  const nRows = Math.round(num(f.params, 'rows', 30));
  st.rowH = h / nRows;
  st.px = st.rowH * 0.66;
  ctx.font = `500 ${st.px.toFixed(1)}px ${SANS}`;
  ctx.letterSpacing = '0px';
  st.space = Math.max(2, st.px * 0.42);
  st.key = key;
  st.rng = 12345;
  const words = sourceWords(f);
  const gaps = num(f.params, 'gaps', 0.2);
  const dim = num(f.params, 'dim', 0.3);
  const widths = new Map<string, number>();
  const measure = (s: string) => {
    let v = widths.get(s);
    if (v === undefined) {
      v = ctx.measureText(s).width;
      widths.set(s, v);
    }
    return v;
  };
  st.rows = [];
  let cursor = 0;
  for (let r = 0; r < nRows + 1; r++) {
    const toks: Tok[] = [];
    let width = 0;
    // each row starts somewhere else in the song so the wall doesn't read as one column
    cursor = (cursor + 7 + Math.floor(rng(st) * 23)) % words.length;
    while (width < w * 1.6 || toks.length < 6) {
      const src = words[cursor % words.length];
      cursor++;
      const style = pickStyle(st, gaps, dim);
      const text = style === 8 ? glyphRun(st) : src.text;
      const tw = style === 7 ? st.px * (2 + rng(st) * 4) : measure(text);
      toks.push({ text, x: width, w: tw, line: src.line, word: src.word, style, shade: rng(st), hl: -1, hlAt: 0, hlLeft: 0 });
      // mostly single spaces, now and then a wide gap like a knocked-out phrase
      width += tw + st.space * (1.25 + (rng(st) < 0.12 ? 3 + rng(st) * 7 : 0));
      if (toks.length > 400) break;
    }
    const dir = r % 2 === 0 ? 1 : -1;
    st.rows.push({ toks, width, x: -rng(st) * width, speed: dir * (0.35 + rng(st) * 0.9) * (rng(st) < 0.25 ? 0 : 1), kick: 0, kickV: 0 });
  }
}

const SIGNAL = ['#ff3b1f', '#ffe100', '#2333ff', '#19dcff'];

function hlColors(f: FrameContext): string[] {
  const p = f.palette;
  const mode = str(f.params, 'colors', 'signal');
  if (mode === 'mono') return [p.muted, '#8a8a8a', p.fg, '#5a5a5a'];
  if (mode === 'palette') return [p.accent, p.accent2, p.muted, p.fg];
  return [...SIGNAL, p.muted, p.fg];
}

function lum(hex: string) {
  const v = parseInt(hex.slice(1), 16);
  return (((v >> 16) & 255) * 0.2126 + ((v >> 8) & 255) * 0.7152 + (v & 255) * 0.0722) / 255;
}

/** which lyric line / word is being sung now */
function sungNow(t: number): { line: number; word: number; prog: number } {
  let synced = false;
  try {
    synced = !!useStudio.getState().lyrics?.synced;
  } catch {
    /* */
  }
  const lines = synced ? lyricLines() : null;
  if (!lines) return { line: -1, word: -1, prog: 0 };
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (lines[m].t <= t) lo = m + 1;
    else hi = m;
  }
  const i = lo - 1;
  if (i < 0) return { line: -1, word: -1, prog: 0 };
  const ln = lines[i];
  const end = Math.max(ln.end, ln.t + 0.5);
  if (t > end + 0.4) return { line: -1, word: -1, prog: 0 };
  const prog = Math.min(1, (t - ln.t) / Math.max(0.4, end - ln.t));
  if (ln.words?.length) {
    let w = 0;
    for (let k = 0; k < ln.words.length; k++) if (ln.words[k].t <= t) w = k;
    return { line: i, word: w, prog };
  }
  // no word timings: walk through the words weighted by their length
  const ws = ln.text.split(/\s+/).filter(Boolean);
  const total = ws.reduce((s, x) => s + x.length + 1, 0);
  let acc = 0;
  let w = 0;
  for (let k = 0; k < ws.length; k++) {
    acc += ws[k].length + 1;
    if (acc / total > prog * 1.08) {
      w = k;
      break;
    }
    w = k;
  }
  return { line: i, word: w, prog };
}

export const textWall = defineCanvasScene<St>({
  id: 'text-wall',
  name: 'Text Wall',
  description:
    'A black page packed edge to edge with the song’s lyrics, repeated. Words are knocked out, dimmed or underlined; red, yellow, blue and cyan boxes snap onto words on the beat, the line being sung lights up white everywhere it appears, and a drop floods the wall with highlights. Without lyrics it fills with the song’s title, genre, mood and section names.',
  category: 'field',
  style: 'type',
  tags: ['lyrics', 'typographic', 'glitch', 'experimental', 'hip hop', 'indie', 'driving', 'dark', 'pop'],
  params,
  showsLyrics: true,
  modulations: [{ source: 'energy', param: 'boxes', amount: 0.2 }],
  setup: () => ({ key: '', rows: [], rowH: 0, px: 0, space: 0, t: 0, beatT: 0, prevDrop: 0, rng: 1 }),
  draw(ctx, f, st) {
    const a = f.audio;
    const dt = Math.min(Math.max(f.dt, 0), 1 / 20);
    st.t += dt;
    const lines = lyricLines();
    const key = [
      f.width,
      f.height,
      Math.round(num(f.params, 'rows', 30)),
      num(f.params, 'gaps', 0.2).toFixed(2),
      num(f.params, 'dim', 0.3).toFixed(2),
      lines ? `${lines.length}:${lines[0].text}:${lines[lines.length - 1].text}` : `x${f.analysis?.bpm ?? 0}:${f.text}`,
      (() => {
        try {
          return useStudio.getState().track?.name ?? '';
        } catch {
          return '';
        }
      })(),
    ].join('|');
    if (key !== st.key) build(ctx, f, st, key);

    const W = f.width;
    const H = f.height;
    const p = f.palette;
    const cols = hlColors(f);
    const bps = a.bpm > 0 ? a.bpm / 60 : 2;
    const hold = num(f.params, 'hold', 1) / bps;
    const boxes = num(f.params, 'boxes', 0.55);
    const sungAmt = num(f.params, 'sung', 1);
    const now = st.t;

    // ── events: pick visible tokens and snap highlights onto them ──
    const visible: Tok[] = [];
    for (let r = 0; r < st.rows.length; r++) {
      const row = st.rows[r];
      for (const t of row.toks) if (t.style !== 2) visible.push(t);
    }
    const snap = (n: number, life: number, colorBias = -1) => {
      for (let k = 0; k < n && visible.length; k++) {
        const t = visible[Math.floor(Math.random() * visible.length)];
        t.hl = colorBias >= 0 && Math.random() < 0.6 ? colorBias : Math.floor(Math.random() * cols.length);
        t.hlAt = now;
        t.hlLeft = life * (0.6 + Math.random() * 0.9);
      }
    };
    const scale = visible.length / 400;
    // idle pulse so the wall breathes when paused
    st.beatT += dt;
    const beat = a.beat || (!a.playing && st.beatT > 1.1);
    if (beat) {
      st.beatT = 0;
      snap(Math.round((2 + boxes * 10 * (0.4 + a.energy)) * scale), hold * 1.5);
    }
    if (a.kickHit) snap(Math.round(boxes * 8 * scale), hold, 0);
    if (a.snareHit) {
      snap(Math.round(boxes * 4 * scale), hold * 0.7, 2);
      // snares re-style a few words (underline / colour / dim swaps)
      for (let k = 0; k < 6 * scale; k++) {
        const t = visible[Math.floor(Math.random() * visible.length)];
        if (t && t.style !== 7 && t.style !== 8) t.style = [0, 1, 3, 5, 4, 0][Math.floor(Math.random() * 6)];
      }
    }
    if (a.hatHit) {
      for (let k = 0; k < 3; k++) {
        const t = visible[Math.floor(Math.random() * visible.length)];
        if (t?.style === 8) t.text = glyphRun(st);
        else if (t) t.shade = Math.random();
      }
    }
    const dropEdge = a.drop > 0.6 && st.prevDrop <= 0.6;
    st.prevDrop = a.drop;
    if (dropEdge) {
      const flood = num(f.params, 'flood', 0.8);
      snap(Math.round(visible.length * 0.9 * flood), 1.6 + hold * 2);
    }
    // kicks shove a couple of rows
    const jolt = num(f.params, 'jolt', 0.35);
    if (a.kickHit && jolt > 0) {
      for (let k = 0; k < 3; k++) {
        const row = st.rows[Math.floor(Math.random() * st.rows.length)];
        row.kickV += (Math.random() < 0.5 ? -1 : 1) * jolt * st.px * 60 * (0.5 + a.kick);
      }
    }

    const drift = num(f.params, 'drift', 0.2);
    for (const row of st.rows) {
      row.x += row.speed * drift * st.px * 2.2 * dt * (0.6 + a.energy * 0.8);
      // springy jolt
      const acc = -row.kick * 220 - row.kickV * 18;
      row.kickV += acc * dt;
      row.kick += row.kickV * dt;
    }

    const cur = sungNow(a.time + 0.05);
    // no lyrics: the name of the part playing now lights up instead (intro, build, drop…)
    let secWord = '';
    if (!lines && f.analysis) {
      for (const sec of f.analysis.sections) if (a.time >= sec.start && a.time < sec.end) secWord = sec.label;
    }

    // ── draw ──
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = p.bg;
    ctx.fillRect(0, 0, W, H);
    const font = `500 ${st.px.toFixed(1)}px ${SANS}`;
    const fontI = `italic 500 ${st.px.toFixed(1)}px ${SANS}`;
    const fontB = `700 ${st.px.toFixed(1)}px ${SANS}`;
    ctx.font = font;
    ctx.letterSpacing = '0px';
    ctx.textBaseline = 'middle';
    const padX = st.px * 0.12;
    const boxH = st.rowH * 0.86;
    const light = lum(p.bg) > 0.5;
    const greys = [p.fg, mix(p.fg, p.bg, 0.42), mix(p.fg, p.bg, 0.62), mix(p.fg, p.bg, 0.78)];
    const greyBox = mix(p.fg, p.bg, light ? 0.75 : 0.8);

    for (let r = 0; r < st.rows.length; r++) {
      const row = st.rows[r];
      const y = r * st.rowH + st.rowH * 0.5 - st.rowH * 0.3;
      if (y - st.rowH > H) break;
      let ox = (row.x + row.kick) % row.width;
      if (ox > 0) ox -= row.width;
      for (let rep = 0; ox + rep * row.width < W; rep++) {
        const base = ox + rep * row.width;
        for (const t of row.toks) {
          const x = base + t.x;
          if (x > W) break;
          if (x + t.w < 0) continue;
          drawTok(t, x, y);
        }
      }
    }

    function drawTok(t: Tok, x: number, y: number) {
      const secHit = secWord !== '' && t.line < 0 && t.text === secWord;
      const sung = sungAmt > 0 && ((t.line >= 0 && t.line === cur.line) || secHit);
      const sungWord = sung && (secHit || t.word === cur.word);
      const sungPast = sung && t.word < cur.word;
      const hlOn = t.hl >= 0 && now - t.hlAt < t.hlLeft;
      if (!hlOn && t.hl >= 0 && now - t.hlAt >= t.hlLeft) t.hl = -1;
      const style = t.style;

      if (sungWord) {
        // the word being sung: a solid page-colour-inverted block
        ctx.fillStyle = p.fg;
        ctx.fillRect(x - padX, y - boxH / 2, t.w + padX * 2, boxH);
        ctx.fillStyle = p.bg;
        ctx.font = fontB;
        ctx.fillText(t.text, x, y);
        ctx.font = font;
        return;
      }
      if (hlOn) {
        const col = cols[t.hl % cols.length];
        const g = Math.min(1, (now - t.hlAt) / 0.07);
        const fade = Math.min(1, (t.hlLeft - (now - t.hlAt)) / 0.12);
        ctx.globalAlpha = fade;
        ctx.fillStyle = col;
        ctx.fillRect(x - padX, y - boxH / 2, (t.w + padX * 2) * g, boxH);
        ctx.globalAlpha = 1;
        if (style !== 7) {
          ctx.fillStyle = lum(col) > 0.55 ? (light ? p.fg : '#000') : (light ? p.bg : '#fff');
          if (lum(col) > 0.55 && col === p.fg) ctx.fillStyle = p.bg;
          if (style === 4) ctx.font = fontI;
          ctx.fillText(t.text, x, y);
          if (style === 4) ctx.font = font;
        }
        return;
      }
      if (sung) {
        ctx.fillStyle = p.fg;
        ctx.globalAlpha = sungPast ? 1 : 0.55 + 0.45 * sungAmt;
        ctx.font = fontB;
        ctx.fillText(t.text, x, y);
        ctx.font = font;
        ctx.globalAlpha = 1;
        return;
      }
      switch (style) {
        case 2:
          return;
        case 1:
          ctx.fillStyle = greys[1 + Math.floor(t.shade * 3)];
          ctx.fillText(t.text, x, y);
          return;
        case 3:
          ctx.fillStyle = p.fg;
          ctx.fillText(t.text, x, y);
          ctx.fillRect(x, y + st.px * 0.52, t.w, Math.max(1, st.px * 0.07));
          return;
        case 4:
          ctx.font = fontI;
          ctx.fillStyle = p.fg;
          ctx.fillText(t.text, x, y);
          ctx.font = font;
          return;
        case 5: {
          // coloured text; on paper only the darker inks stay readable
          const c = cols[Math.floor(t.shade * 4) % 4];
          ctx.fillStyle = c === p.fg || (light && lum(c) > 0.55) ? p.accent : c;
          ctx.fillText(t.text, x, y);
          return;
        }
        case 6:
          ctx.fillStyle = greyBox;
          ctx.fillRect(x - padX, y - boxH / 2, t.w + padX * 2, boxH);
          ctx.fillStyle = greys[t.shade < 0.5 ? 2 : 1];
          ctx.fillText(t.text, x, y);
          return;
        case 7:
          ctx.fillStyle = t.shade < 0.5 ? p.fg : greyBox;
          ctx.fillRect(x - padX, y - boxH / 2, t.w + padX * 2, boxH);
          return;
        case 8:
          ctx.fillStyle = greys[t.shade < 0.6 ? 0 : 1];
          ctx.fillText(t.text, x, y);
          return;
        default:
          ctx.fillStyle = greys[0];
          ctx.fillText(t.text, x, y);
      }
    }
  },
});

const mixCache = new Map<string, string>();
function mix(a: string, b: string, t: number) {
  const k = `${a}${b}${t}`;
  let v = mixCache.get(k);
  if (v) return v;
  const A = parseInt(a.slice(1), 16);
  const B = parseInt(b.slice(1), 16);
  const ch = (s: number) => Math.round(((A >> s) & 255) * (1 - t) + ((B >> s) & 255) * t);
  v = `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
  if (mixCache.size > 200) mixCache.clear();
  mixCache.set(k, v);
  return v;
}
