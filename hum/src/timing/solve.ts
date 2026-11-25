/**
 * Landing what happens in the clips on the song, for every footage part of a video at once.
 *
 * The song has places to land on (accents): where a part comes in, the words the picture waits for,
 * the bars inside a part, and the cut out of it. A clip has things that happen (events). Each part may
 * take one of its clip's events to one of its accents, with a ramp that serves both, or leave the clip
 * as it was. What is best is found over the whole run of parts (a beam search), so a clip's same
 * seconds are not shown twice, one shot's movement leads into the next one's, a wind-up grows, and the
 * speed isn't pulled about in every shot.
 *
 * Where nobody chose the pictures, the clip is chosen here too. Where Claude did, its clip stays, its
 * chosen second is kept near, and an event it named is landed if it can be.
 *
 * Pure: the same song, cut and clips always give the same answer.
 */
import type { MediaNotes, PartShot, TrackAnalysis } from '../core/types';
import type { Curves } from '../feeling';
import { dropAt, isMoment, type MomentId } from '../moments';
import { footageNeed, footageUpTo, type RampId, type Sequence, type Shot } from '../shot/sequence';
import { slowedToFit } from '../shot/run';
import { camOf } from './events';
import type { ClipEvent, ClipMotion, EventKind } from './types';

export type AccentKind = 'in' | 'word' | 'bar' | 'out';

/** what Claude asked to land: a second of the clip, and which accent */
export interface Wanted {
  clip: number;
  on?: AccentKind;
}

export interface TimedPart {
  /** null: nothing to time (a graphic part, a photo, a part the person set) */
  shot: PartShot | null;
  /** its run of shots as it would play now, and which clip it shows (an id; '' when it isn't a clip) */
  seq: Sequence | null;
  clip: string;
  /** the clips it may show instead (none: the one it has) */
  free?: string[];
  wanted?: Wanted;
  /** its clip and second are the person's: they are cut around, never changed */
  fixed?: boolean;
}

export interface TimingInput {
  /** the song cut at the parts */
  analysis: TrackAnalysis;
  parts: TimedPart[];
  /** a clip's length (s), how it moves (null: not read), what was seen in it */
  clipOf: (id: string) => { length: number; motion: ClipMotion | null; notes?: MediaNotes };
  feel: Curves | null;
  /** how well a clip suits a moment, from what was seen in it (0 when it wasn't) */
  fits?: (n: MediaNotes, m: MomentId) => number;
}

interface Option {
  clip: string;
  /** what lands (null: the clip just starts at `from`) */
  hit: { clip: number; on: number; ramp: RampId } | null;
  from: number;
  to: number;
  cost: number;
  big: boolean;
}

const BEAM = 40;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/* ───────── what lands where ───────── */

/** how well each kind of event sits on each kind of accent */
const SITS: Record<EventKind, Record<AccentKind, number>> = {
  // where a shot comes in, the thing has to happen right then: it begins, it flashes, it is at its height
  start: { in: 1, word: 0.5, bar: 0.55, out: 0.85 },
  peak: { in: 0.8, word: 0.8, bar: 1, out: 0.9 },
  stop: { in: 0.35, word: 1, bar: 1, out: 0.25 },
  turn: { in: 0.5, word: 0.9, bar: 0.9, out: 0.5 },
  flash: { in: 0.9, word: 0.4, bar: 0.9, out: 0.6 },
  cut: { in: 0, word: 0, bar: 0, out: 0 },
};

/** how much a moment wants its clip pulled about by a beat inside it */
const PULLS: Partial<Record<MomentId, number>> = { fury: 1, rush: 0.95, release: 0.95, lift: 0.75, drift: 0.55, glow: 0.5, reveal: 0.5, float: 0.2 };

function rampFor(kind: EventKind, accent: AccentKind, m: MomentId): RampId {
  if (accent === 'word') return 'sink';
  if (accent !== 'bar' || !(PULLS[m]! > 0.3)) return 'ride';
  return kind === 'start' ? 'burst' : 'land';
}

interface Accent {
  kind: AccentKind;
  on: number;
  weight: number;
}

function accentsOf(a: TrackAnalysis, i: number, seq: Sequence, m: MomentId, feel: Curves | null): Accent[] {
  const sec = a.sections[i];
  const len = sec.end - sec.start;
  const { beat } = seq;
  const out: Accent[] = [];
  const drop = dropAt(a, sec.start);
  out.push({ kind: 'in', on: 0, weight: drop >= 0.3 ? 0.9 + 0.6 * drop : seq.hit >= 0 ? 0.85 : 0.4 + 0.25 * sec.energy });
  const next = a.sections[i + 1];
  if (next && len > beat * 2.5) out.push({ kind: 'out', on: len, weight: (dropAt(a, next.start) >= 0.3 ? 0.7 : 0.3) * (m === 'hush' || m === 'ache' || m === 'aftermath' ? 0.4 : 1) });
  for (const l of feel?.held ?? []) {
    const on = l.at - sec.start;
    if (on > 0.35 && on < len - 0.45) out.push({ kind: 'word', on, weight: 0.55 + 0.65 * l.weight });
  }
  const pull = PULLS[m] ?? 0;
  if (pull > 0.1) {
    const bar = beat * 4;
    const near = (xs: number[] | undefined, t: number) => (xs ?? []).find((x) => Math.abs(x - t) < 0.1);
    // the bars inside it, as the section counts them; a stronger landing of the song's own inside it counts for more
    for (let k = Math.ceil((sec.start - seq.partStart) / bar + 1e-3); ; k++) {
      const t0 = seq.partStart + k * bar;
      if (t0 > sec.end - Math.max(0.6, beat * 1.6)) break;
      if (t0 < sec.start + Math.max(0.8, beat * 2)) continue;
      const t = near(seq.kicks, t0) ?? near(seq.snares, t0) ?? t0;
      const d = dropAt(a, t);
      out.push({ kind: 'bar', on: t - sec.start, weight: pull * (0.5 + 0.3 * sec.energy + (t !== t0 ? 0.1 : 0) + 0.5 * d) });
    }
  }
  // never on a word of a line that is being held
  return out.map((x) => (x.kind === 'bar' && feel && feel.hold(sec.start + x.on) > 0.2 ? { ...x, weight: x.weight * 0.3 } : x));
}

/* ───────── what a clip does over a stretch ───────── */

const stepAt = (m: ClipMotion, t: number) => Math.max(0, Math.min(m.act.length - 1, Math.floor(t / m.step)));

function over(m: ClipMotion, from: number, to: number, get: (i: number) => number): number {
  const i0 = stepAt(m, Math.min(from, to));
  const i1 = stepAt(m, Math.max(from, to) - 1e-6);
  let s = 0;
  for (let i = i0; i <= i1; i++) s += get(i);
  return s / (i1 - i0 + 1);
}

/** the way a clip goes about one of its seconds: as a direction on screen, and how bright and busy it is */
function heading(m: ClipMotion | null, t: number) {
  if (!m) return null;
  const a = t - 0.25;
  const b = t + 0.25;
  const x = over(m, a, b, (i) => m.camX[i] + m.goX[i] * 0.7);
  const y = over(m, a, b, (i) => m.camY[i] + m.goY[i] * 0.7);
  return { x, y, bright: over(m, a, b, (i) => m.bright[i]), act: over(m, a, b, (i) => m.act[i] + Math.min(0.6, camOf({ camX: m.camX[i], camY: m.camY[i], push: m.push[i] }) * 0.6)) };
}

/** how much the clip's own cuts and the ends of it spoil a stretch */
function torn(m: ClipMotion | null, from: number, to: number): number {
  return m ? m.events.filter((e) => e.kind === 'cut' && e.at > from + 0.06 && e.at < to - 0.06).length * 1.4 : 0;
}

/** the events to land: what was measured, with what was seen in it by name counting for more */
export function eventsOf(m: ClipMotion | null, n?: MediaNotes): (ClipEvent & { what?: string })[] {
  if (!m) return [];
  return m.events
    .filter((e) => e.kind !== 'cut')
    .map((e) => {
      const named = n?.hits?.find((h) => Math.abs(h.at - e.at) < 0.06);
      // looked at and passed over: it was nothing
      if (n?.hits?.length && !named) return { ...e, strength: e.strength * 0.55 };
      return named ? { ...e, strength: clamp01(0.25 + 0.75 * named.hard), what: named.what } : e;
    });
}

/* ───────── the options of one part ───────── */

/** what a shot would play through, with and without each ramp: worked out once for a part and an accent */
function reach(seq: Sequence, shot: Shot, at: number, ramp: RampId): { before: number; after: number } {
  const bent: Shot = { ...shot, hit: { at, clip: 0, ramp } };
  const before = footageUpTo(seq, bent, at);
  return { before, after: footageNeed(seq, bent) - before };
}

function optionsOf(i: number, p: TimedPart, o: TimingInput): Option[] {
  const { shot, seq } = p;
  if (!shot || !seq || !seq.shots.length || !p.clip) return [];
  const first = seq.shots[0];
  const m: MomentId = isMoment(shot.moment) ? shot.moment : 'drift';
  const still = first.motion === 'reverse' || first.motion === 'stutter';
  const accents = p.fixed || still ? [] : accentsOf(o.analysis, i, seq, m, o.feel);
  const ids = p.fixed || !p.free?.length ? [p.clip] : p.free;
  const out: Option[] = [];
  const spans = new Map<string, { before: number; after: number }>();
  for (const id of ids) {
    const { length, motion, notes } = o.clipOf(id);
    const usable = Math.max(0.5, length - 0.25);
    const base = p.free?.length && notes && o.fits ? -0.8 * o.fits(notes, m) : 0;
    const need = footageNeed(seq, first);
    const start = (from: number, cost: number) => {
      const f = Math.max(0.05, Math.min(from, usable - need));
      const to = Math.min(usable, f + need);
      // a picture that does nothing in a part that should move (and the other way about)
      const busy = motion ? over(motion, f, to, (k) => motion.act[k]) : 0.4;
      const e = o.analysis.sections[i].energy;
      out.push({ clip: id, hit: null, from: f, to, cost: base + cost + torn(motion, f, to) + 0.3 * Math.abs(busy - clamp01(e)), big: false });
    };
    if (id === p.clip && first.clipFrom !== undefined) start(first.clipFrom, 0);
    if (p.fixed) continue;
    if (p.free?.length) {
      const ins = notes?.ins.length ? notes.ins.map((x) => x.at) : [0.05, usable * 0.34, usable * 0.67];
      ins.forEach((at, k) => start(at, notes?.ins.length ? 0.04 * k : 0.05));
    }
    for (const acc of accents) {
      // the shot of the part it falls in, when the part is cut inside
      const at = seq.start + acc.on;
      const j = Math.max(0, seq.shots.findIndex((s) => at < s.end - 0.02 || s === seq.shots[seq.shots.length - 1]));
      const s = seq.shots[j];
      if (j > 0 && s.footageIndex !== first.footageIndex) continue;
      for (const e of eventsOf(motion, notes)) {
        const sits = SITS[e.kind][acc.kind];
        if (!sits) continue;
        const ramp = rampFor(e.kind, acc.kind, m);
        const key = `${acc.kind}${acc.on}${ramp}`;
        let sp = spans.get(key);
        if (!sp) spans.set(key, (sp = reach(seq, s, at, ramp)));
        const k = slowedToFit(sp.before, sp.after, e.at, length);
        if (k < 0.42) continue;
        const from = e.at - sp.before * k;
        const to = e.at + sp.after * k;
        const asked = p.wanted && Math.abs(p.wanted.clip - e.at) < 0.45 ? 0.55 + (p.wanted.on === acc.kind ? 0.4 : p.wanted.on ? 0 : 0.2) : 0;
        // the second that was chosen is kept near, unless what lands was named
        const off = shot.from !== undefined && id === p.clip && !asked ? Math.max(0, Math.abs(from - shot.from) - 0.6) * 0.22 : 0;
        const bent = ramp !== 'ride';
        const gain = acc.weight * sits * (0.3 + 0.9 * e.strength) * (e.of === 'camera' ? 0.8 : 1);
        if (gain + asked < 0.2) continue;
        const busy = motion ? over(motion, from, to, (q) => motion.act[q]) : 0.4;
        out.push({
          clip: id,
          hit: { clip: r3(e.at), on: r3(acc.on), ramp },
          from,
          to,
          cost: base - gain - asked + off + (1 - k) * 0.9 + (bent ? 0.14 : 0.02) + torn(motion, from, to) + 0.3 * Math.abs(busy - clamp01(o.analysis.sections[i].energy)),
          big: bent && ramp !== 'sink',
        });
      }
    }
  }
  return out.sort((x, y) => x.cost - y.cost).slice(0, p.free?.length ? 48 : 24);
}

/* ───────── the whole run ───────── */

interface State {
  cost: number;
  picks: (Option | null)[];
  /** the seconds of each clip already shown */
  shown: Map<string, [number, number][]>;
  uses: Map<string, number>;
  /** what has landed already */
  landed: string[];
}

const eventKey = (b: Option) => (b.hit ? `${b.clip}@${b.hit.clip}` : '');

/** what a cut from one option to the next costs */
function across(a: Option, b: Option, i: number, o: TimingInput, touching: boolean): number {
  let c = 0;
  if (a.clip === b.clip) {
    const on = b.from - a.to;
    // the same shot going on is a jump in time at least, or a cut that isn't one
    c += on > -0.2 && on < 0.25 ? 0.35 : 0.6;
  }
  if (a.big && b.big) c += 0.22;
  if (!touching) return c;
  const x = heading(o.clipOf(a.clip).motion, a.to);
  const y = heading(o.clipOf(b.clip).motion, b.from + 0.15);
  if (!x || !y) return c;
  const lx = Math.hypot(x.x, x.y);
  const ly = Math.hypot(y.x, y.y);
  if (lx > 0.08 && ly > 0.08) c -= 0.28 * ((x.x * y.x + x.y * y.y) / (lx * ly)) * clamp01(Math.min(lx, ly) / 0.5);
  const jump = Math.abs(x.bright - y.bright);
  const t = o.analysis.sections[i].start;
  // a landing may flare out of the dark; elsewhere a lurch in brightness is only a lurch
  c += dropAt(o.analysis, t) >= 0.3 ? -0.4 * jump : Math.max(0, jump - 0.25) * 0.5;
  // through a wind-up each shot has more going on than the last
  if (o.feel && o.feel.wind(t) > 0.1) c += 0.5 * Math.max(0, x.act - y.act);
  return c;
}

interface Kept {
  part: number;
  clip: string;
  from: number;
  to: number;
}

/** how much of b a stretch covers, 0..1 */
const shared = (f: number, t: number, b: { from: number; to: number }) => Math.max(0, Math.min(t, b.to) - Math.max(f, b.from)) / Math.max(0.3, b.to - b.from);

/**
 * What the song's biggest landings would show, the biggest choosing first: kept for them, so the best
 * thing in a clip isn't used up on the way there.
 */
function keepForLandings(all: Option[][], o: TimingInput): Kept[] {
  const out: Kept[] = [];
  const order = o.parts
    .flatMap((p, i) => (p.seq && all[i].length && !p.fixed && i > 0 ? [{ i, d: dropAt(o.analysis, o.analysis.sections[i].start) }] : []))
    .filter((x) => x.d >= 0.3)
    .sort((x, y) => y.d - x.d || x.i - y.i);
  for (const { i } of order) {
    const b = all[i].find((x) => x.hit && !out.some((k) => k.clip === x.clip && shared(k.from, k.to, x) > 0.2));
    if (b) out.push({ part: i, clip: b.clip, from: b.from, to: b.to });
  }
  return out;
}

/** what showing a stretch costs, for what was shown of its clip before and what is kept for others */
function again(s: State, b: Option, i: number, kept: Kept[]): number {
  let c = 0;
  for (const k of kept) if (k.clip === b.clip) c += k.part === i ? (Math.abs(k.from - b.from) < 0.05 ? -0.4 : 0) : 0.6 * shared(k.from, k.to, b);
  for (const [f, t] of s.shown.get(b.clip) ?? []) {
    c += 0.7 * shared(f, t, b);
  }
  // the same thing doesn't happen twice (unless one shot cuts out on it and the next comes in on it)
  const key = eventKey(b);
  if (key) s.landed.forEach((k, n) => (c += k === key && !(n === s.landed.length - 1 && b.hit!.on === 0) ? 0.4 : 0));
  return Math.min(1.8, c);
}

/** The parts' choices with what lands, or as they were. Same order as `parts`; null where there is nothing to time. */
export function timeParts(o: TimingInput): (PartShot | null)[] {
  let beam: State[] = [{ cost: 0, picks: [], shown: new Map(), uses: new Map(), landed: [] }];
  let total = 0;
  const all = o.parts.map((p, i) => optionsOf(i, p, o));
  const kept = keepForLandings(all, o);
  o.parts.forEach((p, i) => {
    const opts = all[i];
    if (!opts.length) {
      for (const s of beam) s.picks.push(null);
      return;
    }
    total++;
    const next: { s: State; b: Option; cost: number }[] = [];
    for (const s of beam) {
      let k = i - 1;
      while (k >= 0 && !s.picks[k]) k--;
      const a = k >= 0 ? s.picks[k] : null;
      for (const b of opts) {
        let cost = s.cost + b.cost + again(s, b, i, kept);
        if (a) cost += across(a, b, i, o, k === i - 1);
        // dealing: the clips are all seen before any has been seen far more than its share
        if (p.free?.length) cost += 0.45 * Math.max(0, (s.uses.get(b.clip) ?? 0) - (total - 1) / p.free.length);
        next.push({ s, b, cost });
      }
    }
    next.sort((x, y) => x.cost - y.cost);
    beam = [];
    const seen = new Set<string>();
    for (const { s, b, cost } of next) {
      // states that end the same way with nearly the same past are one
      const tail = [...s.picks.slice(-2), b].map((q) => (q ? `${q.clip}@${q.from.toFixed(1)}` : '-')).join('|');
      if (seen.has(tail)) continue;
      seen.add(tail);
      const shown = new Map(s.shown);
      shown.set(b.clip, [...(shown.get(b.clip) ?? []), [b.from, b.to]]);
      const uses = new Map(s.uses);
      uses.set(b.clip, (uses.get(b.clip) ?? 0) + 1);
      beam.push({ cost, picks: [...s.picks, b], shown, uses, landed: [...s.landed, eventKey(b)] });
      if (beam.length >= BEAM) break;
    }
  });
  const best = beam[0];
  return o.parts.map((p, i) => {
    const b = best.picks[i];
    if (!p.shot) return null;
    if (!b || p.fixed) return p.shot;
    const { from: _f, hit: _h, on: _o, ramp: _r, ...rest } = p.shot;
    const n = b.clip !== p.clip ? o.clipOf(b.clip).notes : undefined;
    return {
      ...rest,
      media: b.clip === p.clip && rest.media?.length ? rest.media : [b.clip],
      ...(n ? { focusX: n.focusX, focusY: n.focusY } : {}),
      from: r2(Math.max(0, b.from)),
      ...(b.hit ? { hit: b.hit.clip, on: b.hit.on, ramp: b.hit.ramp } : {}),
    };
  });
}
