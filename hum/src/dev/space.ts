/**
 * Dev helper: measures the room round the lyrics. Served at /solo.html?space=1&w=1080&h=1920 (solo.ts
 * hands over to this file), driven by scripts/space-check.mjs.
 *
 * For every kit × medium × test line it lays the line out with the real lyric layer at this frame
 * size, draws it over a flat picture, and reads what was drawn:
 *   ink     every glyph's real box (each fillText / strokeText is measured with the font's actual
 *           bounding box, through the canvas transform; the LED sign notes its lit dots)
 *   plates  every plate, band, panel and frame behind words (the kits note them: lyricSpace.ts)
 * and checks them against the rules in render/lyricSpace.ts: the safe area (distance to each edge as
 * a share of the frame's short side) and the plates' padding round their ink (in cap heights).
 * Also, once per voice, the font-level checks: letter pairs that touch at the voice's tracking, and
 * stacked rows whose descenders meet the next row's accented capitals.
 *
 *   await __space.ready
 *   await __space.run({ kits: ['print'], mediums: ['big'], lines: ['long'] })  → { rows, voices, sheet }
 */
import * as THREE from 'three';
import { emptyFrame } from '../audio/engine';
import { getPalette, resolvePalette } from '../core/palettes';
import { LyricLayer } from '../render/lyricLayer';
import { safeInsets, spaceLog, PAD_H, PAD_V, type SpaceItem } from '../render/lyricSpace';
import { loadKitFonts } from '../render/typeKits/fonts';
import { tapeVoice } from '../render/typeKits/tape';
import { filmVoice } from '../render/typeKits/film';
import { printVoice } from '../render/typeKits/print';
import { voiceFor, type Role, type Voice } from '../render/lyricAuto';
import { setLyricPlanOverride, PICKED_WHY, type LyricMedium, type LyricMoment } from '../state/lyricPlan';
import { useStudio, type TypeKitSetting } from '../state/store';
import type { FinishId } from '../core/direction';
import type { LyricLine } from '../core/types';
import { TEST_SONG, testAnalysis } from './testSong';

THREE.ColorManagement.enabled = false;

export const SPACE_KITS = ['clean', 'tape', 'film', 'print'] as const;
type Kit = (typeof SPACE_KITS)[number];
/** the finish each kit is checked under (Print under Ink wash: the case Nate saw) */
const FINISH: Record<Kit, FinishId> = { clean: 'clean', tape: 'tape', film: 'film', print: 'ink' };
export const SPACE_MEDIUMS = ['subtitle', 'big', 'sparse', 'sparse@low', 'knockout', 'cutout', 'big+giant', 'cutout+burst'] as const;

export const SPACE_LINES: Record<string, string> = {
  short: 'Hold on tight',
  long: 'We kept the lights on just to see the morning come back',
  longword: 'Such incomprehensibilities',
  three: 'Sky',
  accents: 'Ángel y Éloïse, jumping quietly',
};

interface RunOpts {
  kits?: string[];
  mediums?: string[];
  lines?: string[];
  /** contact sheet: every case, not just the ones that break a rule */
  all?: boolean;
  cell?: number;
}

interface Row {
  kit: string;
  medium: string;
  line: string;
  t: number;
  /** smallest distance to each edge, as a share of the short side (non-exempt ink, plates, ornaments) */
  edge: { l: number; t: number; r: number; b: number };
  /** padding round each plate's ink, in cap heights */
  plates: { label: string; t: number; b: number; l: number; r: number }[];
  offences: string[];
  exempt: string[];
}

const q = new URLSearchParams(location.search);
const W = Number(q.get('w')) || 1080;
const H = Number(q.get('h')) || 1920;
const BG = '#2b303a';

/* ───────────────────────── recording the ink ───────────────────────── */

let lyricCanvas: HTMLCanvasElement | null = null;
function patchText() {
  const proto = CanvasRenderingContext2D.prototype;
  const fill = proto.fillText;
  const stroke = proto.strokeText;
  const rec = (g: CanvasRenderingContext2D, text: string, x: number, y: number, extra: number) => {
    if (!spaceLog.on || !text.trim() || g.globalAlpha < 0.04) return;
    // (the kits' scratch canvases are drawn in elsewhere: the kit notes that ink itself)
    if (g.canvas !== lyricCanvas) return;
    const m = g.measureText(text);
    const box = { x0: x - m.actualBoundingBoxLeft - extra, x1: x + m.actualBoundingBoxRight + extra, y0: y - m.actualBoundingBoxAscent - extra, y1: y + m.actualBoundingBoxDescent + extra };
    const ls = g.letterSpacing;
    g.letterSpacing = '0px';
    const cap = g.measureText('H').actualBoundingBoxAscent;
    g.letterSpacing = ls;
    const t = g.getTransform();
    const xs: number[] = [];
    const ys: number[] = [];
    for (const [px, py] of [[box.x0, box.y0], [box.x1, box.y0], [box.x0, box.y1], [box.x1, box.y1]]) {
      xs.push(t.a * px + t.c * py + t.e);
      ys.push(t.b * px + t.d * py + t.f);
    }
    spaceLog.items.push({ kind: 'ink', x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), cap: cap * Math.hypot(t.c, t.d), label: text.slice(0, 24), exempt: spaceLog.tag });
  };
  proto.fillText = function (this: CanvasRenderingContext2D, text: string, x: number, y: number, mw?: number) {
    rec(this, text, x, y, 0);
    return mw === undefined ? fill.call(this, text, x, y) : fill.call(this, text, x, y, mw);
  };
  proto.strokeText = function (this: CanvasRenderingContext2D, text: string, x: number, y: number, mw?: number) {
    rec(this, text, x, y, this.lineWidth / 2);
    return mw === undefined ? stroke.call(this, text, x, y) : stroke.call(this, text, x, y, mw);
  };
}

/* ───────────────────────── one test line ───────────────────────── */

const AT = 34;
function testLine(text: string): LyricLine {
  const parts = text.split(' ');
  let t = AT;
  const words = parts.map((w, i) => {
    const d = i === parts.length - 1 ? 2.6 : 0.42;
    const o = { t, end: t + d * 0.92, text: w };
    t += d;
    return o;
  });
  return { t: AT, end: words[words.length - 1].end, text, words };
}

/* ───────────────────────── the checks ───────────────────────── */

const inside = (a: SpaceItem, p: SpaceItem) => {
  const cx = (a.x0 + a.x1) / 2;
  const cy = (a.y0 + a.y1) / 2;
  return cx > p.x0 && cx < p.x1 && cy > p.y0 && cy < p.y1;
};

function judgeItems(items: SpaceItem[], cw: number, ch: number) {
  const S = Math.min(cw, ch);
  const ins = safeInsets(cw, ch);
  const edge = { l: Infinity, t: Infinity, r: Infinity, b: Infinity };
  const offences: string[] = [];
  const exempt = new Set<string>();
  const tol = 0.75;
  for (const it of items) {
    if (it.exempt) {
      exempt.add(it.exempt);
      continue;
    }
    const d = { l: it.x0, t: it.y0, r: cw - it.x1, b: ch - it.y1 };
    for (const k of ['l', 't', 'r', 'b'] as const) {
      edge[k] = Math.min(edge[k], d[k] / S);
      if (d[k] < ins[k] - tol) offences.push(`${it.kind} "${it.label}" ${k} ${((d[k] / S) * 100).toFixed(1)}% < ${((ins[k] / S) * 100).toFixed(1)}%`);
    }
  }
  const plates: Row['plates'] = [];
  const inks = items.filter((i) => i.kind === 'ink');
  for (const p of items.filter((i) => i.kind === 'plate')) {
    const mine = inks.filter((i) => inside(i, p));
    if (!mine.length) continue;
    const cap = Math.max(...mine.map((i) => i.cap)) || p.cap;
    const u = { x0: Math.min(...mine.map((i) => i.x0)), y0: Math.min(...mine.map((i) => i.y0)), x1: Math.max(...mine.map((i) => i.x1)), y1: Math.max(...mine.map((i) => i.y1)) };
    const pad = { t: (u.y0 - p.y0) / cap, b: (p.y1 - u.y1) / cap, l: (u.x0 - p.x0) / cap, r: (p.x1 - u.x1) / cap };
    plates.push({ label: p.label, ...pad });
    const bad = (pad.t < PAD_V - 0.02 ? ` top ${pad.t.toFixed(2)}` : '') + (pad.b < PAD_V - 0.02 ? ` bottom ${pad.b.toFixed(2)}` : '') + (pad.l < PAD_H - 0.02 ? ` left ${pad.l.toFixed(2)}` : '') + (pad.r < PAD_H - 0.02 ? ` right ${pad.r.toFixed(2)}` : '');
    if (bad) offences.push(`plate "${p.label}" padding${bad} (caps)`);
  }
  return { edge, offences: [...new Set(offences)], plates, exempt: [...exempt] };
}

/* ───────────────────────── voices: pairs and leading ───────────────────────── */

const PAIRS = ['LT', 'AV', 'rn', 'To', 'Wa', 'TY', 'LV', 'ry'];
const ROLES: (Role | 'kicker')[] = ['caption', 'display', 'aside', 'giant', 'kicker'];

function components(img: Uint8ClampedArray, w: number, h: number, grow: number): number {
  const on = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) on[i] = img[i * 4 + 3] > 110 ? 1 : 0;
  for (let k = 0; k < grow; k++) {
    const src = on.slice();
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!src[i] && (src[i - 1] || src[i + 1] || src[i - w] || src[i + w])) on[i] = 1;
      }
  }
  const seen = new Uint8Array(w * h);
  let n = 0;
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!on[i] || seen[i]) continue;
    n++;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      for (const k of [j - 1, j + 1, j - w, j + w]) {
        if (k < 0 || k >= w * h || seen[k] || !on[k]) continue;
        seen[k] = 1;
        stack.push(k);
      }
    }
  }
  return n;
}

function voiceChecks() {
  const out: { kit: string; role: string; family: string; leading: number; rowGap: number; em: Record<string, number>; pairs: { pair: string; gap: number }[]; offences: string[] }[] = [];
  const c = document.createElement('canvas');
  const PX = 160;
  c.width = PX * 4;
  c.height = Math.round(PX * 1.8);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const font = (v: Voice) => `${v.italic ? 'italic ' : ''}${Math.round(v.weight)} ${PX}px ${v.family}`;
  const count = (text: string, v: Voice, grow: number) => {
    g.clearRect(0, 0, c.width, c.height);
    g.font = font(v);
    g.fontStretch = v.stretch ?? 'normal';
    g.letterSpacing = `${(PX * v.track).toFixed(2)}px`;
    g.fillStyle = '#fff';
    g.textBaseline = 'alphabetic';
    g.fillText(text, PX * 0.3, PX * 1.25);
    return components(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height, grow);
  };
  for (const kit of SPACE_KITS) {
    for (const role of ROLES) {
      const base = voiceFor(role, 'grotesk', 'punchy');
      const v = kit === 'tape' ? tapeVoice(role, base) : kit === 'film' ? filmVoice(role, base) : kit === 'print' ? printVoice(role, base) : base;
      const offences: string[] = [];
      const pairs: { pair: string; gap: number }[] = [];
      const cased = (s: string) => (v.case === 'upper' ? s.toUpperCase() : v.case === 'lower' ? s.toLowerCase() : s);
      for (const p0 of PAIRS) {
        const p = cased(p0);
        if (pairs.some((x) => x.pair === p)) continue;
        const alone = count(p[0], v, 0) + count(p[1], v, 0);
        let gap = -1;
        for (let r = 0; r <= 4; r++) {
          if (count(p, v, r) < alone) {
            gap = r;
            break;
          }
        }
        // r = 0 merged: touching. r: the glyphs are within about 2r px at 160 px
        const em = gap < 0 ? 9 : (gap * 2) / PX;
        pairs.push({ pair: p, gap: Math.round(em * 1000) / 1000 });
        if (gap === 0) offences.push(`"${p}" touches`);
      }
      // stacked rows: the ascenders of a row against the descenders of the row above
      g.font = font(v);
      g.fontStretch = v.stretch ?? 'normal';
      g.letterSpacing = '0px';
      const asc = g.measureText(v.case === 'upper' ? 'HT' : 'bdfhklHT').actualBoundingBoxAscent;
      const desc = g.measureText(v.case === 'upper' ? 'JQ,' : 'gjpqy').actualBoundingBoxDescent;
      const rowGap = (v.leading * PX - asc - desc) / PX;
      if (role !== 'giant' && rowGap < 0.02) offences.push(`rows touch: gap ${rowGap.toFixed(3)} em at leading ${v.leading}`);
      const cap = g.measureText('H').actualBoundingBoxAscent / PX;
      const acc = g.measureText('ÅÉ').actualBoundingBoxAscent / PX;
      out.push({ kit, role, family: v.family.split(',')[0], leading: v.leading, rowGap: Math.round(rowGap * 1000) / 1000, em: { cap: Math.round(cap * 1000) / 1000, asc: Math.round((asc / PX) * 1000) / 1000, acc: Math.round(acc * 1000) / 1000, desc: Math.round((desc / PX) * 1000) / 1000 }, pairs, offences });
    }
  }
  return out;
}

/* ───────────────────────── run ───────────────────────── */

async function mountSpace() {
  const canvas = document.getElementById('solo') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: true });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  await Promise.all(['Inter Variable', 'IBM Plex Mono', 'Playfair Display Variable', 'Oswald Variable', 'JetBrains Mono Variable', 'Caveat Variable', 'Instrument Serif', 'Fraunces Variable', 'Inter Tight Variable', 'Archivo Variable'].map((f) => document.fonts.load(`16px "${f}"`).catch(() => null)));
  await Promise.all((['tape', 'film', 'print'] as const).map((k) => loadKitFonts(k)));
  patchText();
  const pal = getPalette('midnight');
  const palette = resolvePalette({ id: 'space', name: 'space', bg: pal.bg, fg: pal.fg, accent: pal.accent, accent2: pal.accent2, muted: pal.muted });
  const an = testAnalysis();
  useStudio.setState({ track: { name: `${TEST_SONG.artist} - ${TEST_SONG.title}`, source: 'file' }, analysis: an, lyricStyle: 'auto', presetId: null, sceneId: '', lyricFont: 'auto' });
  const bg = new THREE.Color(BG);

  async function run(o: RunOpts = {}) {
    const kits = (o.kits ?? [...SPACE_KITS]) as Kit[];
    const mediums = o.mediums ?? [...SPACE_MEDIUMS];
    const lines = o.lines ?? Object.keys(SPACE_LINES);
    const rows: Row[] = [];
    const shots: { row: Row; img: HTMLCanvasElement; items: SpaceItem[] }[] = [];
    for (const kit of kits) {
      for (const med of mediums) {
        for (const lk of lines) {
          const line = testLine(SPACE_LINES[lk]);
          const [head, place] = med.split('@');
          const [medium, moment] = head.split('+');
          useStudio.setState({ typeKit: kit as TypeKitSetting, lyrics: { synced: true, source: 'pasted', title: '', artist: '', lines: [line] } });
          setLyricPlanOverride({
            seed: 7,
            family: 'grotesk',
            motion: 'punchy',
            source: 'local',
            parts: an.sections.map(() => ({ medium: medium as LyricMedium, moment: (moment as LyricMoment) || null, ...(place === 'low' ? { place: 'low' as const } : {}), why: PICKED_WHY })),
          });
          const layer = new LyricLayer();
          layer.probe.readAsync = false;
          lyricCanvas = layer.devCanvas;
          renderer.setRenderTarget(null);
          renderer.setClearColor(bg, 1);
          renderer.clear(true, true, false);
          layer.sampleScreen(renderer, W, H);
          const ws = line.words!;
          const times = medium === 'knockout' ? ws.map((w) => w.t + 0.3) : [ws[ws.length - 1].t + 1.2];
          for (const t of times) {
            const lo = { lines: [line], t, style: 'auto' as const, palette, width: W, height: H, audio: emptyFrame(), dt: 1 / 60, finish: FINISH[kit] };
            layer.prepare(lo);
            (layer as unknown as { lastKey: string }).lastKey = '';
            spaceLog.items = [];
            spaceLog.on = true;
            layer.render(renderer, lo);
            spaceLog.on = false;
            const lc = layer.devCanvas;
            const items = spaceLog.items.slice();
            const j = judgeItems(items, lc.width, lc.height);
            const row: Row = { kit, medium: med, line: lk, t, edge: j.edge, plates: j.plates, offences: j.offences, exempt: j.exempt };
            rows.push(row);
            if (o.all || row.offences.length) {
              const img = document.createElement('canvas');
              img.width = lc.width;
              img.height = lc.height;
              img.getContext('2d')!.drawImage(lc, 0, 0);
              shots.push({ row, img, items });
            }
          }
          layer.dispose();
        }
      }
    }
    return { rows, sheet: sheetOf(shots, o.cell ?? (W >= H ? 420 : 240)), size: `${W}x${H}` };
  }

  return { run, voices: voiceChecks };
}

/** a contact sheet: each case with the safe area (red), plates (cyan) and ink boxes (yellow) drawn over */
function sheetOf(shots: { row: Row; img: HTMLCanvasElement; items: SpaceItem[] }[], cw: number): string {
  const list = shots.slice(0, 120);
  if (!list.length) return '';
  const ch = Math.round((cw * H) / W);
  const cols = Math.max(1, Math.min(list.length, Math.floor(2400 / cw)));
  const rowsN = Math.ceil(list.length / cols);
  const lab = 34;
  const c = document.createElement('canvas');
  c.width = cols * cw;
  c.height = rowsN * (ch + lab);
  const g = c.getContext('2d')!;
  g.fillStyle = '#111';
  g.fillRect(0, 0, c.width, c.height);
  list.forEach((s, i) => {
    const x = (i % cols) * cw;
    const y = Math.floor(i / cols) * (ch + lab);
    const k = cw / s.img.width;
    g.fillStyle = BG;
    g.fillRect(x, y + lab, cw, ch);
    g.drawImage(s.img, x, y + lab, cw, ch);
    const ins = safeInsets(s.img.width, s.img.height);
    g.save();
    g.translate(x, y + lab);
    g.strokeStyle = 'rgba(255,60,60,0.9)';
    g.setLineDash([4, 3]);
    g.strokeRect(ins.l * k, ins.t * k, (s.img.width - ins.l - ins.r) * k, (s.img.height - ins.t - ins.b) * k);
    g.setLineDash([]);
    for (const it of s.items) {
      g.strokeStyle = it.kind === 'plate' ? 'rgba(0,220,255,0.95)' : it.kind === 'deco' ? 'rgba(200,120,255,0.8)' : it.exempt ? 'rgba(120,255,120,0.6)' : 'rgba(255,220,0,0.75)';
      g.lineWidth = 1;
      g.strokeRect(it.x0 * k, it.y0 * k, (it.x1 - it.x0) * k, (it.y1 - it.y0) * k);
    }
    g.restore();
    g.fillStyle = s.row.offences.length ? '#ff8080' : '#9f9';
    g.font = '11px ui-monospace, Menlo, monospace';
    g.fillText(`${s.row.kit} · ${s.row.medium} · ${s.row.line}${s.row.medium === 'knockout' ? ` @${s.row.t.toFixed(1)}` : ''}`, x + 4, y + 12);
    g.fillStyle = '#ddd';
    g.fillText((s.row.offences[0] ?? 'ok').slice(0, Math.floor(cw / 6.6)), x + 4, y + 27);
  });
  return c.toDataURL('image/png');
}

const ready = mountSpace();
(window as unknown as Record<string, unknown>).__space = {
  ready: ready.then(
    () => ({ ok: true }),
    (e) => ({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) }),
  ),
  run: async (o: RunOpts) => (await ready).run(o),
  voices: async () => (await ready).voices(),
};
