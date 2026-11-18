/**
 * Sync pasted lyrics to a song: listen for the sung words on this computer (Whisper, in a worker),
 * then line the pasted words up with the heard ones. Whisper mishears singing a lot, so it's only
 * used for anchors: words that match give the timing, everything between them is spread by length.
 */
import type { LyricLine, LyricWord } from '../core/types';

export interface HeardWord {
  t: number;
  end: number;
  text: string;
}

export type ListenProgress = { stage: 'download' | 'listening'; frac: number };

let worker: Worker | null = null;
let busy = false;

/** 16 kHz mono with the lows and highs trimmed (the voice sits in between) */
async function prepare(buf: AudioBuffer): Promise<Float32Array> {
  const rate = 16000;
  const ctx = new OfflineAudioContext(1, Math.ceil(buf.duration * rate), rate);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 120;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 7000;
  src.connect(hp).connect(lp).connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  return out.getChannelData(0).slice();
}

/** the words sung in the song, with times; the model stays loaded for the next song */
export async function listenForWords(buf: AudioBuffer, onProgress: (p: ListenProgress) => void): Promise<HeardWord[]> {
  if (busy) throw new Error('Already listening to a song');
  busy = true;
  try {
    const audio = await prepare(buf);
    worker ??= new Worker(new URL('./listen.worker.ts', import.meta.url), { type: 'module' });
    const w = worker;
    return await new Promise<HeardWord[]>((resolve, reject) => {
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'download' || m.type === 'listening') onProgress({ stage: m.type, frac: m.frac });
        else if (m.type === 'done') resolve(m.words);
        else if (m.type === 'error') reject(new Error(m.message));
      };
      w.onerror = (e) => reject(new Error(e.message || 'The listening model failed to start'));
      w.postMessage({ audio }, [audio.buffer]);
    });
  } finally {
    busy = false;
  }
}

/* ───────────────────────── text ───────────────────────── */

const CJK = /[぀-ヿ㐀-鿿가-힯]/;

/** lower-case, no accents or punctuation; CJK text becomes one token per character */
function tokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\s+/)) {
    const w = raw
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, '');
    if (!w) continue;
    if (CJK.test(w)) out.push(...[...w]);
    else out.push(w);
  }
  return out;
}

function lev(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/** 2 = same word, 1 = sounds close enough ("gonna"/"going"), negative = different */
function similarity(a: string, b: string): number {
  if (a === b) return 2;
  const d = lev(a, b) / Math.max(a.length, b.length);
  return d <= 0.34 ? 1 : -1;
}

/* ───────────────────────── alignment ───────────────────────── */

export interface AlignResult {
  lines: LyricLine[];
  /** share of pasted words that matched something heard (0..1) */
  matched: number;
}

/**
 * Line pasted lyrics up with heard words (Needleman–Wunsch, free to skip heard words at the start
 * and end, since Whisper also "hears" things in intros and outros).
 */
export function alignLyrics(text: string, heard: HeardWord[], duration: number): AlignResult {
  const lineTexts = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\[[^\]]*\]/g, '').trim()) // drop [Chorus]-style labels
    .filter(Boolean);
  // pasted words, remembering which line and which visible word each token belongs to
  const L: { tok: string; line: number; word: number }[] = [];
  const visible: string[][] = [];
  lineTexts.forEach((lt, li) => {
    const ws = lt.split(/\s+/).filter(Boolean);
    visible.push(ws);
    ws.forEach((w, wi) => tokens(w).forEach((tok) => L.push({ tok, line: li, word: wi })));
  });
  const H: { tok: string; t: number; end: number }[] = [];
  for (const h of heard) {
    const tk = tokens(h.text);
    tk.forEach((tok, i) => {
      const span = (h.end - h.t) / tk.length;
      H.push({ tok, t: h.t + span * i, end: h.t + span * (i + 1) });
    });
  }

  const n = L.length;
  const m = H.length;
  const GAP_L = -0.6; // a pasted word Whisper missed (common)
  const GAP_H = -0.35; // a heard word that isn't in the lyrics (common: mishearing, ad-libs)
  const W = m + 1;
  const S = new Float32Array((n + 1) * W);
  const P = new Uint8Array((n + 1) * W); // 1 diag, 2 up (skip pasted), 3 left (skip heard)
  for (let i = 1; i <= n; i++) {
    S[i * W] = i * GAP_L;
    P[i * W] = 2;
  }
  for (let j = 1; j <= m; j++) P[j] = 3; // leading heard words are free
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const d = S[(i - 1) * W + j - 1] + similarity(L[i - 1].tok, H[j - 1].tok);
      const u = S[(i - 1) * W + j] + GAP_L;
      const l = S[i * W + j - 1] + GAP_H;
      if (d >= u && d >= l) {
        S[i * W + j] = d;
        P[i * W + j] = 1;
      } else if (u >= l) {
        S[i * W + j] = u;
        P[i * W + j] = 2;
      } else {
        S[i * W + j] = l;
        P[i * W + j] = 3;
      }
    }
  }
  // trailing heard words are free too: end wherever the last row scores best
  let j = 0;
  for (let k = 1; k <= m; k++) if (S[n * W + k] > S[n * W + j]) j = k;
  const match = new Int32Array(n).fill(-1);
  let i = n;
  while (i > 0 && j > 0) {
    const p = P[i * W + j];
    if (p === 1) {
      if (similarity(L[i - 1].tok, H[j - 1].tok) > 0) match[i - 1] = j - 1;
      i--;
      j--;
    } else if (p === 2) i--;
    else j--;
  }

  // a time for every visible word: matched ones from Whisper, the rest filled in between
  const wordTimes: { t: number; end: number; known: boolean }[][] = visible.map((ws) => ws.map(() => ({ t: NaN, end: NaN, known: false })));
  let matched = 0;
  L.forEach((tk, k) => {
    if (match[k] < 0) return;
    matched++;
    const h = H[match[k]];
    const wt = wordTimes[tk.line][tk.word];
    wt.t = wt.known ? Math.min(wt.t, h.t) : h.t;
    wt.end = wt.known ? Math.max(wt.end, h.end) : h.end;
    wt.known = true;
  });
  if (matched === 0) return { lines: [], matched: 0 };

  // flatten, then fill unknown words by spreading them between the known ones by length
  const flat: { t: number; end: number; known: boolean; len: number; line: number }[] = [];
  wordTimes.forEach((ws, li) => ws.forEach((w, wi) => flat.push({ ...w, len: visible[li][wi].length + 1, line: li })));
  const PER_CHAR = 0.075; // seconds per character when there is nothing to go by
  let k = 0;
  while (k < flat.length) {
    if (flat[k].known) {
      k++;
      continue;
    }
    let e = k;
    while (e < flat.length && !flat[e].known) e++;
    const run = flat.slice(k, e);
    const chars = run.reduce((a, w) => a + w.len, 0);
    const prevEnd = k > 0 ? flat[k - 1].end : NaN;
    const nextStart = e < flat.length ? flat[e].t : NaN;
    let a: number;
    let b: number;
    if (Number.isFinite(prevEnd) && Number.isFinite(nextStart)) {
      // words between two anchors; a long instrumental gap goes before a new line, not inside it
      a = prevEnd;
      b = nextStart;
      const natural = chars * PER_CHAR * 1.6;
      if (b - a > natural + 1.5) {
        const newLine = run[0].line !== flat[k - 1].line;
        if (newLine) a = b - natural;
        else b = a + natural;
      }
    } else if (Number.isFinite(nextStart)) {
      b = nextStart;
      a = Math.max(0, b - chars * PER_CHAR * 1.4);
    } else {
      a = prevEnd;
      b = Math.min(duration, a + chars * PER_CHAR * 1.4);
    }
    let acc = 0;
    for (const w of run) {
      w.t = a + ((b - a) * acc) / chars;
      acc += w.len;
      w.end = a + ((b - a) * acc) / chars;
    }
    k = e;
  }

  const lines: LyricLine[] = visible.map((ws, li) => {
    const own = flat.filter((w) => w.line === li);
    const words: LyricWord[] = ws.map((text, wi) => ({ text, t: own[wi].t, end: own[wi].end }));
    // Whisper often stretches a line's first word back into the silence before it ("And" starting
    // a second early): keep it no longer than a word that size takes to say
    if (words.length > 1) {
      const maxDur = 0.15 + words[0].text.length * 0.07;
      if (words[1].t - words[0].t > maxDur + 0.25) words[0].t = words[1].t - maxDur;
    }
    return { t: words[0].t, end: words[words.length - 1].end + 0.35, text: ws.join(' '), words };
  });
  // keep everything in order and inside the song
  for (let q = 1; q < lines.length; q++) {
    if (lines[q].t < lines[q - 1].t + 0.05) shift(lines[q], lines[q - 1].t + 0.05 - lines[q].t);
    lines[q - 1].end = Math.min(lines[q - 1].end, lines[q].t);
  }
  for (const l of lines) l.end = Math.max(l.end, l.t + 0.4);
  return { lines, matched: matched / n };
}

/** move a line (and its words) by dt seconds */
export function shift(l: LyricLine, dt: number) {
  l.t += dt;
  l.end += dt;
  l.words?.forEach((w) => {
    w.t += dt;
    w.end += dt;
  });
}

/** no listening at all: spread the lines evenly over the song, ready to be tapped into place */
export function spreadLyrics(text: string, duration: number): LyricLine[] {
  const lineTexts = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\[[^\]]*\]/g, '').trim())
    .filter(Boolean);
  const start = Math.min(10, duration * 0.08);
  const step = (duration - start) / Math.max(1, lineTexts.length);
  return lineTexts.map((text, i) => ({ t: start + i * step, end: start + i * step + Math.min(step, 4), text }));
}

/* ───────────────────────── re-timing by the shape of the vocals ───────────────────────── */

/**
 * Lyrics timed to another release of the song (a music video with an intro, a radio edit) need
 * moving. Without listening for words, the best clue is the vocal band: it's busy while lines are
 * sung and quieter in the gaps. Slide the lines' on/off pattern along the file's voice-band energy
 * and keep the offset where they agree most. `lo`..`hi` bounds the search (seconds).
 */
export async function offsetByVocals(buf: AudioBuffer, lines: LyricLine[], lo: number, hi: number): Promise<number> {
  const rate = 8000;
  const hop = 0.1;
  const ctx = new OfflineAudioContext(2, Math.ceil(buf.duration * rate), rate);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 300;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 3400;
  const merge = ctx.createChannelMerger(2);
  src.connect(hp).connect(lp).connect(merge, 0, 0);
  src.connect(merge, 0, 1);
  merge.connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  const mid = out.getChannelData(0);
  const full = out.getChannelData(1);
  const per = Math.round(rate * hop);
  const n = Math.floor(mid.length / per);
  const v = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let a = 0;
    let b = 0;
    for (let i = k * per; i < (k + 1) * per; i++) {
      a += mid[i] * mid[i];
      b += full[i] * full[i];
    }
    // voice-band share of the sound, on a log scale (louder sections don't dominate)
    v[k] = Math.log(Math.sqrt(a / per) + 1e-4) - 0.5 * Math.log(Math.sqrt(b / per) + 1e-4);
  }
  // remove slow trends (6 s), then normalise
  const w = Math.round(6 / hop);
  const pre = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) pre[k + 1] = pre[k] + v[k];
  const z = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k - w);
    const b = Math.min(n, k + w + 1);
    z[k] = v[k] - (pre[b] - pre[a]) / (b - a);
  }
  let sd = 0;
  for (let k = 0; k < n; k++) sd += z[k] * z[k];
  sd = Math.sqrt(sd / Math.max(1, n)) || 1;
  for (let k = 0; k < n; k++) z[k] /= sd;
  // the lines' pattern in the other release's time: +1 while singing, −1 between lines
  const last = lines[lines.length - 1]?.end ?? 0;
  const m = Math.ceil(last / hop) + 1;
  const on = new Float32Array(m).fill(-1);
  for (const l of lines) for (let k = Math.max(0, Math.floor(l.t / hop)); k < Math.min(m, Math.ceil(l.end / hop)); k++) on[k] = 1;
  const first = Math.max(0, Math.floor((lines[0]?.t ?? 0) / hop) - Math.round(4 / hop));
  let best = 0;
  let bestScore = -Infinity;
  for (let o = lo; o <= hi; o += hop) {
    const shiftK = Math.round(o / hop);
    let s = 0;
    let c = 0;
    for (let k = first; k < m; k++) {
      const j = k + shiftK;
      if (j < 0 || j >= n) continue;
      s += on[k] * z[j];
      c++;
    }
    if (c < m * 0.5) continue;
    const score = s / c;
    if (score > bestScore) {
      bestScore = score;
      best = o;
    }
  }
  return Math.round(best * 100) / 100;
}
