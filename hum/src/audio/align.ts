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

/** the words sung in the song, with times; the model stays loaded for the next song. `language` (Whisper's name) when the lyrics' script says which */
export async function listenForWords(buf: AudioBuffer, onProgress: (p: ListenProgress) => void, language?: string): Promise<HeardWord[]> {
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
      w.postMessage({ audio, language }, [audio.buffer]);
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

/* ───────────────────────── cleaning what was heard ───────────────────────── */

/**
 * Whisper loops on sung hooks ("yummy yummy yummy…", dozens stacked on one timestamp) and sometimes
 * repeats a word it already wrote. Drop the stacked copies and the rapid repeats; real repeats in a
 * song are spaced like singing.
 */
export function cleanHeard(heard: HeardWord[]): HeardWord[] {
  const sorted = heard.filter((h) => Number.isFinite(h.t) && h.text?.trim()).sort((a, b) => a.t - b.t);
  const out: HeardWord[] = [];
  const recent = new Map<string, number[]>();
  for (const h of sorted) {
    const key = tokens(h.text).join('');
    if (!key) continue;
    const prev = out[out.length - 1];
    // stacked on the same instant as the word before, with no length of its own: a loop
    if (prev && h.t - prev.t < 0.06 && h.end - h.t < 0.08) continue;
    const times = (recent.get(key) ?? []).filter((x) => h.t - x < 4);
    const last = times[times.length - 1];
    // the same word again too soon (closer still once it's already been said a few times)
    if (last !== undefined && h.t - last < (times.length >= 3 ? 0.75 : 0.3)) continue;
    times.push(h.t);
    recent.set(key, times);
    out.push({ t: h.t, end: Math.max(h.end, h.t + 0.05), text: h.text });
  }
  return out;
}

/* ───────────────────────── alignment ───────────────────────── */

export interface AlignResult {
  lines: LyricLine[];
  /** share of pasted words that matched something heard (0..1) */
  matched: number;
}

export interface AlignOptions {
  /**
   * Timings the same lines already have (LRCLIB or the file), maybe for another release. The heard
   * words decide where things are; between them, these timings place the rest (far better than
   * spreading words by length), and they keep a repeated chorus matched to the right repetition.
   */
  prior?: LyricLine[];
}

/**
 * Whisper's word stamps on singing land a little after the word starts (measured against hand-made
 * word timings on LRCLIB: 0.1–0.35 s late, about 0.2 s typical), so heard times are moved back by this.
 */
const HEARD_LAG = 0.2;

type Tok = { tok: string; line: number; word: number; prior: number };
type Heard = { tok: string; t: number; end: number };

/**
 * Global alignment (Needleman–Wunsch) of pasted tokens against heard ones; heard words before the
 * first and after the last pasted word are free (Whisper "hears" things in intros and outros).
 * `bias(i, j)` adjusts a pairing's score (the time prior). Returns, per pasted token, the heard
 * token it was paired with (a match or a substitution), or -1.
 */
function pairUp(L: Tok[], H: Heard[], bias?: (i: number, j: number) => number): Int32Array {
  const n = L.length;
  const m = H.length;
  const GAP_L = -0.6; // a pasted word Whisper missed (common)
  const GAP_H = -0.35; // a heard word that isn't in the lyrics (mishearing, ad-libs)
  const W = m + 1;
  const S = new Float32Array((n + 1) * W);
  const P = new Uint8Array((n + 1) * W); // 1 diag, 2 up (skip pasted), 3 left (skip heard)
  for (let i = 1; i <= n; i++) {
    S[i * W] = i * GAP_L;
    P[i * W] = 2;
  }
  for (let j = 1; j <= m; j++) P[j] = 3;
  for (let i = 1; i <= n; i++) {
    const li = L[i - 1].tok;
    for (let j = 1; j <= m; j++) {
      const d = S[(i - 1) * W + j - 1] + similarity(li, H[j - 1].tok) + (bias ? bias(i - 1, j - 1) : 0);
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
  let j = 0;
  for (let k = 1; k <= m; k++) if (S[n * W + k] > S[n * W + j]) j = k;
  const pair = new Int32Array(n).fill(-1);
  let i = n;
  while (i > 0 && j > 0) {
    const p = P[i * W + j];
    if (p === 1) {
      pair[i - 1] = j - 1;
      i--;
      j--;
    } else if (p === 2) i--;
    else j--;
  }
  return pair;
}

/** median of a list (NaN when empty) */
function median(a: number[]): number {
  if (!a.length) return NaN;
  const b = [...a].sort((x, y) => x - y);
  return b[Math.floor(b.length / 2)];
}

/** how far (s) a heard word may sit from where the prior (shifted) expects it */
const TOL = 1.6;

/**
 * Where the prior's lines really are, as an offset per pasted token: the offset most matches agree
 * on (an intro or a different release), and, for a long run of matches that agree on another one
 * (an edit that cut or added a part), that run's own. Each token takes the offset of the nearest
 * run. null when there are too few matches to say.
 */
function offsetPlan(anchors: { k: number; off: number }[], n: number): Float64Array | null {
  if (anchors.length < 4) return null;
  // the dominant offset: the densest 0.8 s window of offsets
  const offs = anchors.map((a) => a.off).sort((x, y) => x - y);
  let mode = offs[0];
  let best = 0;
  for (let i = 0, j = 0; i < offs.length; i++) {
    while (offs[j] < offs[i] - 0.8) j++;
    if (i - j + 1 > best) {
      best = i - j + 1;
      mode = median(offs.slice(j, i + 1));
    }
  }
  // runs of consecutive matches that agree with each other
  const runs: { from: number; to: number; off: number }[] = [];
  let cur: { k: number; off: number }[] = [];
  const close = () => {
    if (cur.length >= 6) runs.push({ from: cur[0].k, to: cur[cur.length - 1].k, off: median(cur.map((a) => a.off)) });
    cur = [];
  };
  for (const a of anchors) {
    if (cur.length && Math.abs(a.off - median(cur.map((c) => c.off))) > 1) {
      // one stray match doesn't end a run
      const next = anchors[anchors.indexOf(a) + 1];
      if (next && Math.abs(next.off - median(cur.map((c) => c.off))) <= 1) continue;
      close();
    }
    cur.push(a);
  }
  close();
  // keep the dominant offset's runs, and other runs only when they're long (a real edit)
  const keep = runs.filter((r) => Math.abs(r.off - mode) <= TOL || r.to - r.from >= 25);
  const out = new Float64Array(n).fill(mode);
  if (!keep.length) return out;
  for (let k = 0; k < n; k++) {
    let bestD = Infinity;
    for (const r of keep) {
      const d = k < r.from ? r.from - k : k > r.to ? k - r.to : 0;
      if (d < bestD) {
        bestD = d;
        out[k] = r.off;
      }
    }
  }
  return out;
}

/**
 * Line lyrics up with heard words. Matched words give the timing; heard words the alignment paired
 * with a different word ("Dazing" for "Daisy") help where they fit; everything else is placed by
 * the prior timings when there are some, otherwise spread by length between the known words.
 */
export function alignLyrics(text: string, heardRaw: HeardWord[], duration: number, opts: AlignOptions = {}): AlignResult {
  const lineTexts = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\[[^\]]*\]/g, '').trim()) // drop [Chorus]-style labels
    .filter(Boolean);
  const visible: string[][] = lineTexts.map((lt) => lt.split(/\s+/).filter(Boolean));
  // the prior only counts when it is the same lines
  const sameLine = (a: string, b: string) => tokens(a).join(' ') === tokens(b).join(' ');
  const prior = opts.prior && opts.prior.length === lineTexts.length && opts.prior.every((l, i) => sameLine(l.text, lineTexts[i])) ? opts.prior : null;
  const priorWords = prior ? prior.map((l, li) => priorWordTimes(l, visible[li])) : null;

  // pasted tokens, remembering which line and visible word each belongs to (and its prior time)
  const L: Tok[] = [];
  visible.forEach((ws, li) =>
    ws.forEach((w, wi) => {
      const tk = tokens(w);
      tk.forEach((tok, k) => {
        const pw = priorWords?.[li][wi];
        L.push({ tok, line: li, word: wi, prior: pw ? pw.t + ((pw.end - pw.t) * k) / tk.length : NaN });
      });
    }),
  );
  const H: Heard[] = [];
  for (const h of cleanHeard(heardRaw)) {
    const tk = tokens(h.text);
    const t0 = Math.max(0, h.t - HEARD_LAG);
    const span = Math.max(0.05, h.end - h.t) / tk.length;
    tk.forEach((tok, i) => H.push({ tok, t: t0 + span * i, end: t0 + span * (i + 1) }));
  }
  const n = L.length;
  if (!n) return { lines: [], matched: 0 };

  // 1. align on the words alone
  let pair = pairUp(L, H);
  // 2. with prior timings: align again, now preferring pairings near where the prior (shifted by
  //    what pass 1 found) expects them, so a chorus line lands on its own repetition
  let expect: Float64Array | null = null;
  if (prior) {
    const anchors: { k: number; off: number }[] = [];
    pair.forEach((j, k) => {
      if (j >= 0 && similarity(L[k].tok, H[j].tok) > 0 && Number.isFinite(L[k].prior)) anchors.push({ k, off: H[j].t - L[k].prior });
    });
    expect = offsetPlan(anchors, n);
    if (expect) {
      const ex = expect;
      pair = pairUp(L, H, (i, j) => {
        const dev = Math.abs(H[j].t - (L[i].prior + ex[i]));
        return dev < TOL ? 0.3 : -Math.min(4, (dev - TOL) * 0.8);
      });
    }
  }

  // known times per token: hard (matched words) and soft (substitutions that fit between them)
  const hard = new Int32Array(n).fill(-1);
  pair.forEach((j, k) => {
    if (j >= 0 && similarity(L[k].tok, H[j].tok) > 0) hard[k] = j;
  });
  if (expect) {
    // with a prior: a match far from where the offset plan expects it is a wrong repetition
    for (let k = 0; k < n; k++) if (hard[k] >= 0 && Number.isFinite(L[k].prior) && Math.abs(H[hard[k]].t - (L[k].prior + expect[k])) > TOL) hard[k] = -1;
  } else dropImplausible(hard, L, H, false);
  const known: { t: number; end: number; soft: boolean }[] = L.map((_, k) => (hard[k] >= 0 ? { t: H[hard[k]].t, end: H[hard[k]].end, soft: false } : { t: NaN, end: NaN, soft: false }));
  const matchedCount = known.filter((x) => Number.isFinite(x.t)).length;
  if (!matchedCount) {
    if (!prior) return { lines: [], matched: 0 };
    return { lines: prior.map((l) => ({ ...l, words: l.words?.map((w) => ({ ...w })) })), matched: 0 };
  }
  // substitutions: a heard word in the right place but misheard. Take its time when it sits in order
  // between the known words around it, at a plausible pace
  {
    const PACE = 0.12; // seconds a sung token needs at the least
    let prevT = -Infinity;
    let prevK = -1;
    for (let k = 0; k < n; k++) {
      if (Number.isFinite(known[k].t)) {
        prevT = known[k].t;
        prevK = k;
        continue;
      }
      const j = pair[k];
      if (j < 0) continue;
      let q = k + 1;
      while (q < n && !Number.isFinite(known[q].t)) q++;
      const nextT = q < n ? known[q].t : Infinity;
      const h = H[j];
      // room for the words before it since the last known one, and for the ones after it until the next
      if (h.t >= prevT + PACE * (k - prevK) && h.t <= nextT - PACE * (q - k)) {
        known[k] = { t: h.t, end: Math.min(h.end, nextT), soft: true };
        prevT = h.t;
        prevK = k;
      }
    }
  }

  // a time for every token: known ones as heard, the rest placed by the prior or spread by length
  const times = known.map((x) => ({ t: x.t, end: x.end }));
  if (prior) fillByPrior(times, L);
  fillByLength(times, L, visible, duration);

  // tokens → visible words
  const wordTimes = visible.map((ws) => ws.map(() => ({ t: Infinity, end: -Infinity, heard: false, heardEnd: -Infinity, heardT: Infinity })));
  L.forEach((tk, k) => {
    const wt = wordTimes[tk.line][tk.word];
    wt.t = Math.min(wt.t, times[k].t);
    wt.end = Math.max(wt.end, times[k].end);
    if (Number.isFinite(known[k].t)) {
      wt.heard = true;
      wt.heardT = Math.min(wt.heardT, known[k].t);
      wt.heardEnd = Math.max(wt.heardEnd, known[k].end);
    }
  });

  const lines: LyricLine[] = visible.map((ws, li) => {
    const words: LyricWord[] = ws.map((text, wi) => {
      const w = wordTimes[li][wi];
      return { text, t: w.t, end: Math.max(w.end, w.t + 0.05) };
    });
    // Whisper often stretches a line's first word back into the silence before it: when the heard
    // word is longer than a word that size takes to sing, start it that long before it ends
    const w0 = wordTimes[li][0];
    const maxDur = 0.25 + ws[0].length * 0.09;
    if (w0.heard && w0.heardEnd - w0.heardT > maxDur + 0.6) words[0].t = Math.max(words[0].t, w0.heardEnd - maxDur);
    return { t: words[0].t, end: words[words.length - 1].end + 0.35, text: ws.join(' '), words };
  });
  // keep everything in order and inside the song
  for (let q = 1; q < lines.length; q++) {
    if (lines[q].t < lines[q - 1].t + 0.05) shift(lines[q], lines[q - 1].t + 0.05 - lines[q].t);
    lines[q - 1].end = Math.min(lines[q - 1].end, lines[q].t);
  }
  for (const l of lines) l.end = Math.max(l.end, l.t + 0.4, l.words?.[l.words.length - 1]?.end ?? 0);
  return { lines, matched: matchedCount / n };
}

/** a prior line's word times, one per visible word (its own word stamps when they line up, else spread by length) */
function priorWordTimes(l: LyricLine, ws: string[]): { t: number; end: number }[] {
  if (l.words?.length === ws.length) return l.words.map((w) => ({ t: w.t, end: w.end }));
  const total = ws.reduce((a, w) => a + w.length + 1, 0);
  const span = Math.max(0.4, (l.end - l.t) * 0.85);
  let acc = 0;
  return ws.map((w) => {
    const t = l.t + (acc / total) * span;
    acc += w.length + 1;
    return { t, end: l.t + (acc / total) * span };
  });
}

/**
 * Remove matches that can't be right: with a prior, ones whose offset is far from their neighbours';
 * without, ones that would make the words between them impossibly fast (a short word like "you"
 * matched to the wrong place).
 */
function dropImplausible(hard: Int32Array, L: Tok[], H: Heard[], withPrior: boolean) {
  for (let round = 0; round < 3; round++) {
    const idx: number[] = [];
    hard.forEach((j, k) => j >= 0 && idx.push(k));
    if (idx.length < 3) return;
    let dropped = 0;
    if (withPrior) {
      const anchors = idx.filter((k) => Number.isFinite(L[k].prior)).map((k) => ({ p: L[k].prior, off: H[hard[k]].t - L[k].prior, k }));
      for (const a of anchors) {
        const others = anchors.filter((b) => b !== a && Math.abs(b.p - a.p) <= 25).map((b) => b.off);
        if (others.length >= 2 && Math.abs(a.off - median(others)) > 3) {
          hard[a.k] = -1;
          dropped++;
        }
      }
    } else {
      const MIN = 0.07; // seconds per token, faster than anyone sings
      for (let q = 1; q < idx.length - 1; q++) {
        const a = idx[q - 1];
        const b = idx[q];
        const c = idx[q + 1];
        const tooFastBefore = H[hard[b]].t - H[hard[a]].t < (b - a) * MIN;
        const tooFastAfter = H[hard[c]].t - H[hard[b]].t < (c - b) * MIN;
        // an outlier squeezes one side; the anchor with the shortest word goes first
        if ((tooFastBefore || tooFastAfter) && L[b].tok.length <= 4) {
          hard[b] = -1;
          dropped++;
          q++;
        }
      }
    }
    if (!dropped) return;
  }
}

/** unknown tokens placed by the prior: warped linearly between the known tokens around them */
function fillByPrior(times: { t: number; end: number }[], L: Tok[]) {
  const n = L.length;
  const knownIdx: number[] = [];
  for (let k = 0; k < n; k++) if (Number.isFinite(times[k].t) && Number.isFinite(L[k].prior)) knownIdx.push(k);
  if (!knownIdx.length) return;
  let a = -1;
  let ai = -1;
  for (let k = 0; k < n; k++) {
    if (Number.isFinite(times[k].t)) {
      if (Number.isFinite(L[k].prior)) {
        a = k;
        ai++;
      }
      continue;
    }
    const p = L[k].prior;
    if (!Number.isFinite(p)) continue;
    const b = knownIdx[ai + 1] ?? -1;
    const offA = a >= 0 ? times[a].t - L[a].prior : NaN;
    const offB = b >= 0 ? times[b].t - L[b].prior : NaN;
    let t: number;
    let rate = 1;
    if (a >= 0 && b >= 0 && L[b].prior - L[a].prior > 0.05) {
      rate = (times[b].t - times[a].t) / (L[b].prior - L[a].prior);
      // a sane stretch between the anchors: follow it; else keep the prior's own spacing from the nearer one
      if (rate > 0.6 && rate < 1.6) t = times[a].t + (p - L[a].prior) * rate;
      else {
        rate = 1;
        t = p + (p - L[a].prior < L[b].prior - p ? offA : offB);
      }
    } else t = p + (Number.isFinite(offA) ? offA : offB);
    const dur = Math.max(0.08, Math.min(1.5, (k + 1 < n && Number.isFinite(L[k + 1].prior) && L[k + 1].line === L[k].line ? L[k + 1].prior - p : 0.4) * rate));
    times[k] = { t, end: t + dur };
  }
  // keep order (a warp near a wrong anchor could cross)
  for (let k = 1; k < n; k++) {
    if (Number.isFinite(times[k].t) && Number.isFinite(times[k - 1].t) && times[k].t < times[k - 1].t + 0.02) {
      times[k].t = times[k - 1].t + 0.02;
      times[k].end = Math.max(times[k].end, times[k].t + 0.05);
    }
  }
}

/** unknown tokens with nothing to go by: spread between the known ones by length */
function fillByLength(times: { t: number; end: number }[], L: Tok[], visible: string[][], duration: number) {
  const n = L.length;
  const PER_CHAR = 0.075; // seconds per character when there is nothing to go by
  const BREAK = 8; // a line break counts as this many characters of time
  const len = (k: number) => (visible[L[k].line][L[k].word]?.length ?? 3) / Math.max(1, countTokens(L, k)) + 1;
  let k = 0;
  while (k < n) {
    if (Number.isFinite(times[k].t)) {
      k++;
      continue;
    }
    let e = k;
    while (e < n && !Number.isFinite(times[e].t)) e++;
    // weights: characters, plus a pause before each new line
    const weights: number[] = [];
    for (let q = k; q < e; q++) weights.push(len(q) + (q > 0 && L[q].line !== L[q - 1].line ? BREAK : 0));
    const total = weights.reduce((a, b) => a + b, 0);
    const natural = total * PER_CHAR * 1.5;
    const prevEnd = k > 0 ? times[k - 1].end : NaN;
    const nextStart = e < n ? times[e].t : NaN;
    let a: number;
    let b: number;
    if (Number.isFinite(prevEnd) && Number.isFinite(nextStart)) {
      a = prevEnd;
      b = nextStart;
      // much more room than the words need: an instrumental gap, which goes before a new line
      if (b - a > natural * 1.8 + 1.5) {
        const newLine = L[k].line !== L[k - 1].line;
        if (newLine) a = b - natural;
        else b = a + natural;
      }
    } else if (Number.isFinite(nextStart)) {
      b = nextStart;
      a = Math.max(0, b - natural);
    } else {
      a = Number.isFinite(prevEnd) ? prevEnd : 0;
      b = Math.min(duration, a + natural);
    }
    let acc = 0;
    for (let q = k; q < e; q++) {
      const w = weights[q - k];
      const brk = q > 0 && L[q].line !== L[q - 1].line ? BREAK : 0;
      times[q] = { t: a + ((b - a) * (acc + brk)) / total, end: a + ((b - a) * (acc + w)) / total };
      acc += w;
    }
    k = e;
  }
}

/** how many tokens the visible word of token k was split into */
function countTokens(L: Tok[], k: number) {
  let c = 0;
  for (let q = k; q >= 0 && L[q].line === L[k].line && L[q].word === L[k].word; q--) c++;
  for (let q = k + 1; q < L.length && L[q].line === L[k].line && L[q].word === L[k].word; q++) c++;
  return c;
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
