import * as THREE from 'three';
import type { FrameContext } from '../core/types';
import { createFullscreenQuad } from '../core/sceneHelpers';
import { lum, makeInk, mix, rgba, setFont, MONO } from '../scenes/board/kit';
import type { BF, Ink, Module, Rect, SF } from '../scenes/board/kit';
import { harmonograph, minimap, odometer, pong, radar, runner, terminal, typewriter, weather, wordCloud } from '../scenes/board/mod-fun';
import { ticker, topWords, upNext } from '../scenes/board/mod-words';
import { tetris } from '../scenes/board/mod-gen';
import { chroma, radial, scope, spectrogram, stepSeq } from '../scenes/board/mod-signal';
import { getScene } from '../scenes';
import { popLevelAt, sectionIndexAt } from '../state/plan';
import { useStudio } from '../state/store';

/**
 * Pop-ups: little framed board windows (one instrument each, with a title bar) that pop in over
 * whatever is playing — on section changes, drops and some bars — and snap shut a few bars later.
 * Drawn on a 2D canvas and composited into the frame, so they are
 * in recordings too. How busy it gets comes from popLevelAt() (the video plan, or the Always mode).
 */

interface Kind {
  title: string;
  make: () => Module;
  /** size in units of min(width, height) × 0.36 */
  w: number;
  h: number;
  needs?: 'words' | 'map';
}

const KINDS: Kind[] = [
  { title: 'SONG.LOG', make: terminal, w: 1.3, h: 0.85 },
  { title: 'RADAR', make: radar, w: 0.95, h: 0.95 },
  { title: 'TEMPO', make: odometer, w: 1.05, h: 0.78 },
  { title: 'PONG.EXE', make: pong, w: 1.15, h: 0.78 },
  { title: 'RUNNER', make: runner, w: 1.35, h: 0.62 },
  { title: 'XY.SCOPE', make: harmonograph, w: 0.9, h: 0.9 },
  { title: 'FORECAST', make: weather, w: 1.35, h: 0.78 },
  { title: 'SONG MAP', make: minimap, w: 1.45, h: 0.52, needs: 'map' },
  { title: 'WORDS', make: wordCloud, w: 1.15, h: 0.85, needs: 'words' },
  { title: 'TYPEWRITER', make: typewriter, w: 1.4, h: 0.62, needs: 'words' },
  { title: 'UP NEXT', make: upNext, w: 1.3, h: 0.62, needs: 'words' },
  { title: 'NEWS.WIRE', make: () => ticker('WIRE'), w: 1.6, h: 0.34, needs: 'words' },
  { title: 'HI-SCORES', make: () => topWords('MOST SUNG'), w: 1, h: 0.85, needs: 'words' },
  { title: 'TETRIS', make: tetris, w: 0.72, h: 1.05 },
  { title: 'SPECTROGRAM', make: spectrogram, w: 1.25, h: 0.62 },
  { title: 'BEAT', make: radial, w: 0.95, h: 0.95 },
  { title: 'SCOPE', make: scope, w: 1.05, h: 0.6 },
  { title: 'SEQUENCER', make: stepSeq, w: 1.45, h: 0.5 },
  { title: 'PITCH', make: chroma, w: 1, h: 0.62 },
];

interface Win {
  kind: Kind;
  mod: Module;
  x: number;
  y: number;
  w: number;
  h: number;
  born: number;
  /** when it starts closing */
  until: number;
  closing: number;
  /** title bar: 0 striped, 1 accent, 2 ink */
  style: number;
  cache: HTMLCanvasElement | null;
  cacheKey: string;
  bumpX: number;
  bumpY: number;
}

/** on a dark palette the windows land as light paper sheets, so they pop off the picture */
function paperInk(ink: Ink): Ink {
  if (ink.light) return ink;
  const bg = mix(ink.fg, [250, 247, 238], 0.55);
  const fg = mix(ink.bg, [0, 0, 0], 0.4);
  const deepen = (c: typeof bg) => (lum(c) > 0.5 ? mix(c, fg, 0.42) : c);
  return { ...ink, bg, fg, ac: deepen(ink.ac), ac2: deepen(ink.ac2), mu: mix(bg, fg, 0.28), line: mix(bg, fg, 0.3), paper: bg, light: true, key: `${ink.key}|paper` };
}

const IN_STEP = 0.045;
const IN_SCALES = [0.35, 1.14, 0.95, 1];
const OUT_TIME = 0.16;
const MAX_OPEN = [0, 2, 3, 4];
const BAR_CHANCE = [0, 0.1, 0.22, 0.42];

export class PopupLayer {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private tex = new THREE.CanvasTexture(this.canvas);
  private mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false });
  private quad = createFullscreenQuad(this.mat);
  private wins: Win[] = [];
  private queue: number[] = [];
  private lastSec = -1;
  private lastBar = -1;
  private lastDrop = 0;
  private lastT = 0;
  private empty = true;
  private sceneKey = '';

  constructor() {
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.generateMipmaps = false;
  }

  render(r: THREE.WebGLRenderer, base: Omit<FrameContext, 'params'>, target: THREE.WebGLRenderTarget | null = null) {
    const a = base.audio;
    const t = base.time;
    let level = popLevelAt(a.time);
    // a board look is already busy: keep it to the odd window
    const s = useStudio.getState();
    if (getScene(s.sceneId)?.category === 'board') level = Math.min(level, 1);

    const scale = Math.min(1, 1920 / Math.max(base.width, base.height, 1));
    const W = Math.max(2, Math.round(base.width * scale));
    const H = Math.max(2, Math.round(base.height * scale));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
      this.wins.length = 0;
    }

    this.schedule(base, level, W, H);
    for (const w of this.wins) if (w.closing < 0 && (t >= w.until || level === 0)) w.closing = t;
    this.wins = this.wins.filter((w) => w.closing < 0 || t - w.closing < OUT_TIME);

    if (!this.wins.length) {
      if (!this.empty) {
        this.ctx.clearRect(0, 0, W, H);
        this.empty = true;
      }
      return;
    }
    this.draw(base, W, H);
    this.tex.needsUpdate = true;
    this.empty = false;
    const ac = r.autoClear;
    r.autoClear = false;
    this.quad.render(r, target);
    r.autoClear = ac;
  }

  /** decide when windows open: section changes, drops, some bars (staggered a beat apart) */
  private schedule(base: Omit<FrameContext, 'params'>, level: number, W: number, H: number) {
    const a = base.audio;
    const t = base.time;
    const spb = 60 / (a.bpm > 30 ? a.bpm : 110);
    const secs = base.analysis?.sections ?? [];
    const si = secs.length ? sectionIndexAt(secs, a.time) : -1;
    const bar = Math.floor(Math.max(0, a.beatCount) / 4);
    // the live drop detector, or playback crossing one of the song map's drops
    const crossed = a.time > this.lastT && a.time - this.lastT < 0.5 && !!base.analysis?.drops.some((d) => d > this.lastT && d <= a.time);
    const dropEdge = (a.drop > 0.6 && this.lastDrop <= 0.6) || crossed;
    this.lastDrop = a.drop;
    this.lastT = a.time;
    if (level <= 0 || !a.playing) {
      this.queue.length = 0;
      this.lastSec = si;
      this.lastBar = bar;
      return;
    }
    if (si !== this.lastSec) {
      if (this.lastSec !== -1 || a.time > 1) for (let k = 0; k < level; k++) this.queue.push(t + k * spb);
      this.lastSec = si;
    }
    if (dropEdge) {
      for (let k = 0; k < Math.min(3, level + 1); k++) this.queue.push(t + k * spb * 0.5);
    }
    if (bar !== this.lastBar) {
      this.lastBar = bar;
      const chance = BAR_CHANCE[level] + (bar % 4 === 0 ? 0.15 * level : 0);
      if (Math.random() < chance) this.queue.push(t);
    }
    this.queue.sort((x, y) => x - y);
    const open = this.wins.filter((w) => w.closing < 0).length;
    if (this.queue.length && this.queue[0] <= t) {
      this.queue.shift();
      if (open >= MAX_OPEN[level]) {
        // full: retire the oldest so the newest still lands on the beat
        const oldest = this.wins.find((w) => w.closing < 0);
        if (oldest) oldest.closing = t;
      }
      this.spawn(base, W, H, spb);
    }
    if (this.queue.length > 8) this.queue.splice(0, this.queue.length - 8);
  }

  private spawn(base: Omit<FrameContext, 'params'>, W: number, H: number, spb: number) {
    const t = base.time;
    const s = useStudio.getState();
    const hasWords = !!(s.lyrics?.synced && s.lyrics.lines.length) || !!base.text.trim();
    const hasMap = !!base.analysis?.sections.length;
    const openKinds = new Set(this.wins.map((w) => w.kind));
    const pool = KINDS.filter((k) => !openKinds.has(k) && (k.needs !== 'words' || hasWords) && (k.needs !== 'map' || hasMap));
    if (!pool.length) return;
    // lyric windows come up more often when there are words
    const weighted = pool.flatMap((k) => (k.needs === 'words' ? [k, k] : [k]));
    const kind = weighted[Math.floor(Math.random() * weighted.length)];
    const U = Math.min(W, H) * 0.36;
    const w = Math.round(Math.min(W * 0.62, kind.w * U));
    const h = Math.round(Math.min(H * 0.62, kind.h * U + U * 0.1));
    const m = Math.min(W, H) * 0.04;
    let best: { x: number; y: number; cost: number } | null = null;
    for (let k = 0; k < 24; k++) {
      const x = m + Math.random() * Math.max(1, W - w - 2 * m);
      const y = m + Math.random() * Math.max(1, H - h - 2 * m);
      let cost = 0;
      for (const o of this.wins) {
        if (o.closing >= 0) continue;
        const ix = Math.max(0, Math.min(x + w, o.x + o.w) - Math.max(x, o.x));
        const iy = Math.max(0, Math.min(y + h, o.y + o.h) - Math.max(y, o.y));
        cost += ix * iy;
      }
      // keep the middle of the picture mostly clear
      const cx = (x + w / 2) / W - 0.5;
      const cy = (y + h / 2) / H - 0.5;
      cost += Math.max(0, 0.22 - Math.hypot(cx, cy)) * w * h * 3;
      if (!best || cost < best.cost) best = { x, y, cost };
    }
    const bars = 2 + Math.floor(Math.random() * 3);
    this.wins.push({
      kind,
      mod: kind.make(),
      x: Math.round(best!.x),
      y: Math.round(best!.y),
      w,
      h,
      born: t,
      until: t + Math.min(11, Math.max(3, bars * 4 * spb)),
      closing: -1,
      style: Math.floor(Math.random() * 3),
      cache: null,
      cacheKey: '',
      bumpX: 0,
      bumpY: 0,
    });
  }

  private draw(base: Omit<FrameContext, 'params'>, W: number, H: number) {
    const g = this.ctx;
    const t = base.time;
    const a = base.audio;
    const ink = paperInk(makeInk(base.palette, 0.95));
    const s = Math.min(W, H) / 1080;
    const hl = Math.max(1, Math.round(s * 1.2));
    const sf: SF = { s, hl, lw: 1, ink, labels: true, w: W, h: H };
    const frame = { ...base, width: W, height: H, aspect: W / H, params: {} } as FrameContext;
    const bf: BF = { ...sf, f: frame, a, live: a.playing, idle: false, t, dt: Math.min(0.1, Math.max(0, base.dt)), speed: 1 };
    const sk = `${ink.key}|${W}x${H}`;
    if (sk !== this.sceneKey) {
      this.sceneKey = sk;
      for (const w of this.wins) w.cacheKey = '';
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.clearRect(0, 0, W, H);
    for (const w of this.wins) {
      if (a.kickHit) {
        w.bumpX = (Math.random() - 0.5) * 5 * s;
        w.bumpY = (Math.random() - 0.5) * 5 * s;
      } else {
        w.bumpX *= 0.6;
        w.bumpY *= 0.6;
      }
      this.drawWin(g, w, bf, ink);
    }
  }

  private chrome(w: Win, sf: SF, ink: Ink): { cr: Rect; tb: number } {
    const { s } = sf;
    const tb = Math.round(Math.max(14, 24 * s));
    const pad = Math.round(Math.max(5, 9 * s));
    const key = `${w.w}x${w.h}|${sf.ink.key}|${w.style}`;
    const cr: Rect = { x: pad, y: tb + pad, w: w.w - pad * 2, h: w.h - tb - pad * 2 };
    if (w.cacheKey === key && w.cache) return { cr, tb };
    w.cacheKey = key;
    const shadow = Math.round(Math.max(3, 7 * s));
    const c = w.cache ?? document.createElement('canvas');
    w.cache = c;
    c.width = w.w + shadow;
    c.height = w.h + shadow;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    const bw = Math.max(1.5, Math.round(2 * s));
    // hard offset shadow, body, frame
    g.fillStyle = rgba(ink.fg);
    g.fillRect(shadow, shadow, w.w, w.h);
    g.fillStyle = rgba(ink.bg);
    g.fillRect(0, 0, w.w, w.h);
    g.fillStyle = rgba(ink.fg);
    g.fillRect(0, tb - bw, w.w, bw);
    // title bar
    const title = w.kind.title;
    setFont(g, Math.max(8, tb * 0.48), 700, MONO, 0.1);
    g.textBaseline = 'middle';
    const tw = g.measureText(title).width;
    if (w.style === 0) {
      g.fillStyle = rgba(ink.fg, 0.85);
      const n = 5;
      const gap = (tb - bw) / (n + 1);
      for (let k = 1; k <= n; k++) g.fillRect(bw * 2, Math.round(k * gap), w.w - bw * 4, Math.max(1, Math.round(s)));
      g.fillStyle = rgba(ink.bg);
      g.fillRect(w.w / 2 - tw / 2 - tb * 0.4, 0, tw + tb * 0.8, tb - bw);
      g.fillStyle = rgba(ink.fg);
      g.textAlign = 'center';
      g.fillText(title, w.w / 2, (tb - bw) / 2 + 1);
    } else {
      g.fillStyle = rgba(w.style === 1 ? ink.ac : ink.fg);
      g.fillRect(0, 0, w.w, tb - bw);
      g.fillStyle = rgba(ink.bg);
      g.textAlign = 'left';
      g.fillText(`■ ${title}`, tb * 0.4, (tb - bw) / 2 + 1);
    }
    // close box on the right
    const bx = w.w - tb * 0.85;
    const by = tb * 0.2;
    const bs = tb * 0.5;
    g.fillStyle = rgba(ink.bg);
    g.fillRect(bx - 2, by - 2, bs + 4, bs + 4);
    g.strokeStyle = rgba(ink.fg);
    g.lineWidth = Math.max(1, s * 1.2);
    g.strokeRect(bx + 0.5, by + 0.5, bs, bs);
    g.beginPath();
    g.moveTo(bx + bs * 0.25, by + bs * 0.25);
    g.lineTo(bx + bs * 0.75, by + bs * 0.75);
    g.moveTo(bx + bs * 0.75, by + bs * 0.25);
    g.lineTo(bx + bs * 0.25, by + bs * 0.75);
    g.stroke();
    g.strokeStyle = rgba(ink.fg);
    g.lineWidth = bw;
    g.strokeRect(bw / 2, bw / 2, w.w - bw, w.h - bw);
    if (w.mod.drawStatic) {
      g.save();
      w.mod.drawStatic(g, cr, sf);
      g.restore();
    }
    return { cr, tb };
  }

  private drawWin(g: CanvasRenderingContext2D, w: Win, bf: BF, ink: Ink) {
    const t = bf.t;
    const age = t - w.born;
    let sx = 1;
    let sy = 1;
    if (w.closing >= 0) {
      // snap shut: squash to a line, then pinch to a dot
      const k = (t - w.closing) / OUT_TIME;
      if (k < 0.6) sy = Math.max(0.02, 1 - k / 0.6);
      else {
        sy = 0.02;
        sx = Math.max(0, 1 - (k - 0.6) / 0.4);
      }
    } else {
      const step = Math.floor(age / IN_STEP);
      const v = IN_SCALES[Math.min(IN_SCALES.length - 1, step)];
      sx = sy = v;
    }
    if (sx <= 0.001) return;
    const { cr } = this.chrome(w, bf, ink);
    const cx = w.x + w.w / 2 + w.bumpX;
    const cy = w.y + w.h / 2 + w.bumpY;
    g.save();
    g.translate(cx, cy);
    g.scale(sx, sy);
    g.translate(-w.w / 2, -w.h / 2);
    g.drawImage(w.cache!, 0, 0);
    if (w.closing < 0 && age < IN_STEP) {
      // first frame: a solid flash of accent, like a window being stamped on
      g.fillStyle = rgba(ink.ac);
      g.fillRect(0, 0, w.w, w.h);
    } else if (sy > 0.2) {
      g.beginPath();
      g.rect(cr.x, cr.y, cr.w, cr.h);
      g.clip();
      try {
        w.mod.draw(g, cr, bf);
      } catch (e) {
        console.warn('[hum] pop-up failed', e);
        w.closing = t;
      }
    }
    g.restore();
  }

  dispose() {
    this.tex.dispose();
    this.mat.dispose();
    this.quad.dispose();
  }
}
