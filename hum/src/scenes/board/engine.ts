/**
 * Board engine: turns a set of modules + aspect templates into a Canvas 2D scene.
 * Static chrome (paper, panel hairlines, labels, guides) is cached into an offscreen canvas
 * and only re-rendered when size / layout / line weight / palette / fonts change.
 */
import { defineCanvasScene } from '../../core/sceneHelpers';
import { bool, num, str } from '../../core/uniforms';
import type { AudioFrame, ModulationSeed, ParamDef, SceneDef } from '../../core/types';
import { clamp, createIdleAudio, crisp, labelPx, makeInk, pad2, rgba, setFont } from './kit';
import type { BF, Ink, Module, Rect, SF } from './kit';
import { pickOrient, solveLayout } from './layout';
import type { Templates } from './layout';

export interface BoardOptions {
  id: string;
  name: string;
  description: string;
  tags: string[];
  /** board-specific params (appended after the shared layout/style params) */
  params: ParamDef[];
  modulations?: ModulationSeed[];
  usesPhotos?: boolean;
  /** the board already shows the sung words (typewriter, word cloud, lyric text over a photo) */
  showsLyrics?: boolean;
  templates: Templates;
  defaults?: { padding?: number; lineWeight?: number; accent?: number; speed?: number };
  /** create fresh module instances (called on setup / resize) */
  build: () => Record<string, Module>;
}

export function boardParams(d: BoardOptions['defaults'] = {}): ParamDef[] {
  return [
    {
      id: 'layout',
      label: 'Layout',
      type: 'select',
      group: 'Layout',
      options: [
        { value: 'auto', label: 'Auto (fit aspect)' },
        { value: 'vertical', label: 'Vertical 9:16' },
        { value: 'square', label: 'Square / 4:5' },
        { value: 'horizontal', label: 'Horizontal 16:9' },
      ],
      default: 'auto',
    },
    { id: 'padding', label: 'Padding', type: 'number', group: 'Layout', min: 0, max: 2, step: 0.05, default: d.padding ?? 1, hint: 'Sheet margin and gutters' },
    { id: 'lineWeight', label: 'Line weight', type: 'number', group: 'Style', min: 0.5, max: 3, step: 0.05, default: d.lineWeight ?? 1 },
    { id: 'labels', label: 'Labels', type: 'bool', group: 'Style', default: true },
    { id: 'accent', label: 'Accent', type: 'number', group: 'Style', min: 0, max: 1, step: 0.01, default: d.accent ?? 0.9, hint: '0 = monochrome ink' },
    { id: 'speed', label: 'Scroll speed', type: 'number', group: 'Motion', min: 0.25, max: 2.5, step: 0.05, default: d.speed ?? 1, hint: 'History panels scroll rate' },
  ];
}

interface State {
  mods: Record<string, Module>;
  cache: HTMLCanvasElement;
  cctx: CanvasRenderingContext2D;
  key: string;
  content: [string, Rect][];
  hasPlayed: boolean;
  idle: (t: number) => AudioFrame;
  tick: number;
  fonts: string;
}

function fontsKey(): string {
  try {
    const fs = document.fonts;
    if (!fs) return 'na';
    return `${fs.status}${fs.check("12px 'IBM Plex Mono'") ? 1 : 0}${fs.check("12px 'Inter Variable'") ? 1 : 0}`;
  } catch {
    return 'na';
  }
}

function renderStatic(st: State, o: BoardOptions, rects: Map<string, Rect>, sf: SF, margin: number) {
  const c = st.cctx;
  const { w, h, s, hl, ink } = sf;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.fillStyle = rgba(ink.bg);
  c.fillRect(0, 0, w, h);

  // registration marks in the margin
  if (margin > 16 * s) {
    c.strokeStyle = rgba(ink.fg, 0.35);
    c.lineWidth = hl;
    const m = margin * 0.5;
    const L = Math.round(5 * s) + 2;
    c.beginPath();
    for (const [x, y] of [
      [m, m],
      [w - m, m],
      [m, h - m],
      [w - m, h - m],
    ]) {
      const cx = crisp(x, hl);
      const cy = crisp(y, hl);
      c.moveTo(cx - L, cy);
      c.lineTo(cx + L, cy);
      c.moveTo(cx, cy - L);
      c.lineTo(cx, cy + L);
    }
    c.stroke();
  }

  st.content = [];
  let idx = 0;
  const lp = labelPx(s);
  const ip = Math.round(10 * s) + 2;
  for (const [name, r] of rects) {
    const mod = st.mods[name];
    if (!mod) continue;
    let cr: Rect;
    if (mod.chrome === false) cr = { ...r };
    else {
      idx++;
      c.strokeStyle = rgba(ink.line);
      c.lineWidth = hl;
      const x0 = crisp(r.x, hl);
      const y0 = crisp(r.y, hl);
      const x1 = crisp(r.x + r.w, hl);
      const y1 = crisp(r.y + r.h, hl);
      c.strokeRect(x0, y0, x1 - x0, y1 - y0);
      if (mod.bleed) {
        cr = { x: r.x + hl, y: r.y + hl, w: r.w - 2 * hl, h: r.h - 2 * hl };
      } else if (sf.labels && (mod.label || mod.meta)) {
        const lh = Math.round(lp * 2.4);
        setFont(c, lp, 500);
        c.textBaseline = 'middle';
        c.textAlign = 'left';
        c.fillStyle = rgba(ink.fg, 0.85);
        const lab = `${pad2(idx)}  ${mod.label ?? ''}`;
        c.fillText(lab, r.x + ip, r.y + lh * 0.58);
        if (mod.meta) {
          const room = r.w - 3 * ip - c.measureText(lab).width;
          if (c.measureText(mod.meta).width < room) {
            c.textAlign = 'right';
            c.fillStyle = rgba(ink.fg, 0.42);
            c.fillText(mod.meta, r.x + r.w - ip, r.y + lh * 0.58);
          }
        }
        cr = { x: r.x + ip, y: r.y + lh, w: r.w - 2 * ip, h: r.h - lh - ip };
      } else {
        cr = { x: r.x + ip, y: r.y + ip, w: r.w - 2 * ip, h: r.h - 2 * ip };
      }
    }
    cr = { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.w), h: Math.round(cr.h) };
    if (cr.w < 4 || cr.h < 4) continue;
    st.content.push([name, cr]);
    if (mod.drawStatic) {
      c.save();
      mod.drawStatic(c, cr, sf);
      c.restore();
    }
  }
}

export function defineBoard(o: BoardOptions): SceneDef {
  return defineCanvasScene<State>({
    id: o.id,
    name: o.name,
    description: o.description,
    category: 'board',
    tags: o.tags,
    light: true,
    usesPhotos: o.usesPhotos,
    showsLyrics: o.showsLyrics,
    modulations: o.modulations,
    params: [...boardParams(o.defaults), ...o.params],
    setup: (_ctx, w, h) => {
      const cache = document.createElement('canvas');
      cache.width = w;
      cache.height = h;
      return {
        mods: o.build(),
        cache,
        cctx: cache.getContext('2d', { alpha: false })!,
        key: '',
        content: [],
        hasPlayed: false,
        idle: createIdleAudio(),
        tick: 0,
        fonts: '',
      };
    },
    draw: (ctx, frame, st) => {
      const p = frame.params;
      const w = frame.width;
      const h = frame.height;
      const s = Math.min(w, h) / 1080;
      const orient = pickOrient(str(p, 'layout', 'auto'), w / h);
      const lw = clamp(num(p, 'lineWeight', 1), 0.25, 4);
      const hl = Math.max(1, Math.round(lw * s));
      const pad = clamp(num(p, 'padding', 1), 0, 3);
      const labels = bool(p, 'labels', true);
      const ink: Ink = makeInk(frame.palette, num(p, 'accent', 0.9));
      if (st.tick++ % 30 === 0) st.fonts = fontsKey();

      const pal = frame.palette;
      const key = `${w}x${h}|${orient}|${lw.toFixed(2)}|${pad.toFixed(2)}|${labels}|${pal.bg}${pal.fg}${pal.muted}|${st.fonts}`;
      const sf: SF = { s, hl, lw, ink, labels, w, h };
      if (key !== st.key) {
        st.key = key;
        if (st.cache.width !== w || st.cache.height !== h) {
          st.cache.width = w;
          st.cache.height = h;
        }
        const margin = Math.round((34 * pad + 6) * s);
        const gap = Math.round(14 * pad * s);
        const outer = { x: margin, y: margin, w: w - 2 * margin, h: h - 2 * margin };
        renderStatic(st, o, solveLayout(o.templates[orient], outer, gap, s), sf, margin);
      }

      const real = frame.audio;
      if (real.playing) st.hasPlayed = true;
      const idle = !real.playing && !st.hasPlayed;
      const a = idle ? st.idle(frame.time) : real;
      const bf: BF = {
        ...sf,
        f: frame,
        a,
        live: real.playing || idle,
        idle,
        t: frame.time,
        dt: clamp(frame.dt, 0, 0.1),
        speed: clamp(num(p, 'speed', 1), 0, 4),
      };

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.drawImage(st.cache, 0, 0);
      for (const [name, r] of st.content) {
        const m = st.mods[name];
        ctx.save();
        if (m.clip) {
          ctx.beginPath();
          ctx.rect(r.x, r.y, r.w, r.h);
          ctx.clip();
        }
        m.draw(ctx, r, bf);
        ctx.restore();
      }
    },
  });
}
