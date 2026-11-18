import * as THREE from 'three';
import type { AudioFrame, LyricLine, Palette } from '../core/types';
import { createFullscreenQuad } from '../core/sceneHelpers';
import { indexAt } from '../audio/lyrics';
import type { LyricStyle } from '../state/store';

/**
 * Timed lyrics drawn over the finished frame, so they are in recordings and stills too.
 * Text is laid out on a 2D canvas (only redrawn when something visible changes) and composited
 * with one blended quad.
 *
 *   subtitle: the current line low in the frame; sung words brighten as they're sung
 *   big:      one huge line in the middle; words land one by one, the current word in the accent
 */

const FONT = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const FADE_IN = 0.14;
const FADE_OUT = 0.3;
/** show the next line slightly early so the eye arrives with the voice */
const LEAD = 0.08;

interface Word {
  text: string;
  t: number;
  end: number;
}

/** word timings: real ones when the lyrics have them, otherwise spread across the line by length */
function wordsOf(line: LyricLine): Word[] {
  if (line.words?.length) return line.words;
  const parts = line.text.split(/\s+/).filter(Boolean);
  const total = parts.reduce((a, w) => a + w.length + 1, 0);
  const span = Math.max(0.4, (line.end - line.t) * 0.82);
  let acc = 0;
  return parts.map((text) => {
    const t = line.t + (acc / total) * span;
    acc += text.length + 1;
    return { text, t, end: line.t + (acc / total) * span };
  });
}

/** greedy wrap into lines that fit maxW */
function wrap(ctx: CanvasRenderingContext2D, words: Word[], maxW: number, maxLines: number): Word[][] {
  const rows: Word[][] = [[]];
  const space = ctx.measureText(' ').width;
  let w = 0;
  for (const word of words) {
    const ww = ctx.measureText(word.text).width;
    const row = rows[rows.length - 1];
    if (row.length && w + space + ww > maxW && rows.length < maxLines) {
      rows.push([word]);
      w = ww;
    } else {
      row.push(word);
      w += (row.length > 1 ? space : 0) + ww;
    }
  }
  return rows;
}

export class LyricLayer {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private tex = new THREE.CanvasTexture(this.canvas);
  private mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false });
  private quad = createFullscreenQuad(this.mat);
  private lastKey = '';
  private empty = true;

  constructor() {
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.generateMipmaps = false;
  }

  /** draw the lyrics for time t over whatever is on the screen */
  render(r: THREE.WebGLRenderer, o: { lines: LyricLine[]; t: number; style: LyricStyle; palette: Palette; width: number; height: number; audio: AudioFrame }) {
    if (o.style === 'off' || !o.lines.length) return;
    const t = o.t + LEAD;
    // the line on screen: the one being sung, or the one that just ended (fading out)
    const i = indexAt(o.lines, t);
    const cur = i >= 0 && t < o.lines[i].end + FADE_OUT ? { i, line: o.lines[i] } : null;
    const scale = Math.min(1, 1600 / Math.max(o.width, 1));
    const W = Math.max(2, Math.round(o.width * scale));
    const H = Math.max(2, Math.round(o.height * scale));
    if (!cur) {
      if (!this.empty) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.empty = true;
        this.lastKey = '';
      }
      return;
    }
    const line = cur.line;
    const alpha = Math.min(1, (t - line.t) / FADE_IN, 1 - (t - line.end) / FADE_OUT);
    const words = wordsOf(line);
    const sung = words.filter((w) => w.t <= t).length;
    const pop = o.style === 'big' ? Math.round(Math.max(0, 1 - (t - (words[sung - 1]?.t ?? -9)) / 0.18) * 8) : 0;
    const key = `${o.style}|${cur.i}|${sung}|${pop}|${Math.round(alpha * 20)}|${W}x${H}|${o.palette.fg}${o.palette.accent}${o.palette.bg}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      if (this.canvas.width !== W || this.canvas.height !== H) {
        this.canvas.width = W;
        this.canvas.height = H;
      }
      this.draw(words, sung, pop / 8, Math.max(0, alpha), W, H, o.style, o.palette);
      this.tex.needsUpdate = true;
      this.empty = false;
    }
    const ac = r.autoClear;
    r.autoClear = false;
    this.quad.render(r, null);
    r.autoClear = ac;
  }

  private draw(words: Word[], sung: number, pop: number, alpha: number, W: number, H: number, style: LyricStyle, pal: Palette) {
    const g = this.ctx;
    g.clearRect(0, 0, W, H);
    if (alpha <= 0.01) return;
    const big = style === 'big';
    const size = Math.round(big ? Math.min(H * 0.11, W * 0.075) : Math.max(13, Math.min(H * 0.045, W * 0.032)));
    g.font = `${big ? 800 : 600} ${size}px ${FONT}`;
    g.textBaseline = 'alphabetic';
    const rows = wrap(g, words, W * (big ? 0.84 : 0.8), big ? 3 : 2);
    const lh = size * (big ? 1.04 : 1.22);
    const space = g.measureText(' ').width;
    const blockH = lh * rows.length;
    const top = big ? (H - blockH) / 2 + size * 0.82 : H * 0.9 - blockH + size * 0.82;

    // a soft shadow in the background colour keeps text readable on any frame
    g.shadowColor = hexA(pal.bg, big ? 0.55 : 0.75);
    g.shadowBlur = size * (big ? 0.5 : 0.45);
    let idx = 0;
    rows.forEach((row, ri) => {
      const widths = row.map((w) => g.measureText(w.text).width);
      const rowW = widths.reduce((a, b) => a + b, 0) + space * (row.length - 1);
      let x = (W - rowW) / 2;
      const y = top + ri * lh;
      row.forEach((w, wi) => {
        const isSung = idx < sung;
        const isCurrent = idx === sung - 1;
        let a: number;
        let color = pal.fg;
        if (big) {
          a = isSung ? 1 : 0.16;
          if (isCurrent) color = pal.accent;
        } else a = isSung ? 1 : 0.58;
        g.globalAlpha = a * alpha;
        g.fillStyle = color;
        if (big && isCurrent && pop > 0) {
          const s = 1 + 0.07 * pop;
          g.save();
          g.translate(x + widths[wi] / 2, y - size * 0.35);
          g.scale(s, s);
          g.fillText(w.text, -widths[wi] / 2, size * 0.35);
          g.restore();
        } else g.fillText(w.text, x, y);
        x += widths[wi] + space;
        idx++;
      });
    });
    g.globalAlpha = 1;
    g.shadowBlur = 0;
  }

  dispose() {
    this.tex.dispose();
    this.mat.dispose();
    this.quad.dispose();
  }
}

function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
