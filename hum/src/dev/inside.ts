/**
 * Dev helper (served at /inside.html by `npm run dev`, not part of the build): inside shots (src/inside)
 * drawn over clips whose reading was dumped to footage.local/scenes, laid out as a contact sheet.
 * scripts/inside-sheet.mjs drives it.
 *
 *   await __inside.sheet([{ clip, moment, layout, palette, words, sung, at: [seconds into the shot], from, beats, … }], { w, h, cols, cell })
 */
import '../index.css';
import * as THREE from 'three';
import type { ClipScene } from '../depth/types';
import { InsidePass } from '../inside/pass';
import { insidePalette } from '../inside/palettes';
import { InsideShot, type InsideSpec } from '../inside/shot';
import { paletteFromPixels, schemeFor } from '../shot/palette';

THREE.ColorManagement.enabled = false;
const canvas = document.createElement('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: true });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(1);
renderer.autoClear = false;
const errors: string[] = [];
renderer.debug.onShaderError = (gl, program, vs, fs) => {
  const log = (s: WebGLShader) => gl.getShaderInfoLog(s) || '';
  errors.push((log(fs) || log(vs) || gl.getProgramInfoLog(program) || 'shader').trim().slice(0, 600));
};

// maps concatenated, in order
const sceneFromDump = (j: Omit<ClipScene, 'maps'>, b: ArrayBuffer): ClipScene => ({ ...j, maps: j.times.map((_, i) => new Uint8Array(b, i * j.width * j.height, j.width * j.height)) });

interface Clip {
  video: HTMLVideoElement;
  texture: THREE.VideoTexture;
  aspect: number;
  scene: ClipScene | null;
  cuts: [number, number];
}
const clips = new Map<string, Clip>();
async function clip(name: string): Promise<Clip> {
  const had = clips.get(name);
  if (had) return had;
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = `/footage.local/in/${name}.mp4`;
  await new Promise((r, j) => {
    video.onloadeddata = r;
    video.onerror = () => j(new Error(`no clip ${name}`));
  });
  const texture = new THREE.VideoTexture(video);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  let scene: ClipScene | null = null;
  const j = await fetch(`/footage.local/scenes/${name}.json`);
  if (j.ok && j.headers.get('content-type')?.includes('json')) scene = sceneFromDump(await j.json(), await (await fetch(`/footage.local/scenes/${name}.bin`)).arrayBuffer());
  const c2 = document.createElement('canvas');
  c2.width = 160;
  c2.height = 90;
  const g = c2.getContext('2d')!;
  g.drawImage(video, 0, 0, 160, 90);
  const pal = paletteFromPixels(g.getImageData(0, 0, 160, 90).data);
  const made: Clip = { video, texture, aspect: video.videoWidth / video.videoHeight, scene, cuts: schemeFor(pal).cuts as [number, number] };
  clips.set(name, made);
  return made;
}
async function seek(c: Clip, t: number) {
  const v = c.video;
  if (Math.abs(v.currentTime - t) > 1e-4) {
    await new Promise<void>((r) => {
      v.onseeked = () => r();
      v.currentTime = Math.min(v.duration - 0.05, Math.max(0, t));
    });
  }
  c.texture.needsUpdate = true;
}

interface Cell extends Partial<Omit<InsideSpec, 'palette' | 'words' | 'scene' | 'beat'>> {
  clip: string;
  words?: string;
  palette?: string;
  from?: number;
  beats?: number;
  bpm?: number;
  at?: number[];
  noScene?: boolean;
}
let pass: InsidePass | null = null;
async function shotOf(c: Cell, w: number, h: number) {
  const k = await clip(c.clip);
  if (!pass || pass.width !== w || pass.height !== h) {
    pass?.dispose();
    renderer.setSize(w, h, false);
    pass = new InsidePass(renderer, w, h);
  }
  const beat = 60 / (c.bpm ?? 128);
  const start = 10;
  const end = start + (c.beats ?? 8) * beat;
  const texts = (c.words ?? '').split(' ').filter(Boolean);
  const span = (end - start) * 0.8;
  const words = texts.map((text, i) => ({ text: text.toUpperCase(), t: start + (span * i) / texts.length, end: start + (span * (i + 0.9)) / texts.length }));
  const beats = Array.from({ length: c.beats ?? 8 }, (_, i) => start + i * beat);
  const { clip: _, words: __, palette, from = 0, at: ___, ...rest } = c;
  void _;
  void __;
  void ___;
  const spec: InsideSpec = { scene: c.noScene ? null : k.scene, clipAspect: k.aspect, aspect: w / h, start, end, beat, kicks: beats, snares: beats.filter((_, i) => i % 2), partStart: start, energy: 0.6, layout: 1, arrive: 'hit', leave: 'ramp', cuts: k.cuts, sung: true, clipAt: (t) => from + (t - start), focus: { x: 0.5, y: 0.5 }, zoom: 1, flip: false, ...rest, words, palette: insidePalette(palette, 0) };
  return { k, spec, shot: new InsideShot(pass, spec) };
}
const api = {
  async scenes() {
    const out: Record<string, unknown> = {};
    for (const n of ['bridge', 'crosswalk', 'gate', 'crowd', 'crossing']) {
      const s = (await clip(n)).scene;
      out[n] = s && { aspect: s.aspect, size: [s.width, s.height], n: s.times.length, focal: s.focal, zScale: s.zScale, view0: s.views[0], viewN: s.views[s.views.length - 1], slideN: s.slides[s.slides.length - 1], ahead: s.ahead[s.ahead.length - 1], sure: s.sure, sky: s.sky, ground: s.ground, near: s.near, splits: s.splits, camera: s.camera };
    }
    return out;
  },
  async sheet(cells: Cell[], o: { w?: number; h?: number; cols?: number; cell?: number } = {}) {
    const w = o.w ?? 1280;
    const h = o.h ?? 720;
    const cw = o.cell ?? 480;
    const ch = Math.round((cw * h) / w);
    const list = cells.flatMap((c) => (c.at ?? [0.5]).map((at) => ({ c, at })));
    const cols = o.cols ?? 4;
    const sheet = document.createElement('canvas');
    sheet.width = cols * cw;
    sheet.height = Math.ceil(list.length / cols) * (ch + 16);
    const g = sheet.getContext('2d')!;
    g.fillStyle = '#111';
    g.fillRect(0, 0, sheet.width, sheet.height);
    const info: unknown[] = [];
    let i = 0;
    for (const c of cells) {
      const { k, spec, shot } = await shotOf(c, w, h);
      for (const at of c.at ?? [0.5]) {
        const t = spec.start + at;
        await seek(k, spec.clipAt(t));
        const t0 = performance.now();
        shot.render(t, { footage: k.texture, grow: 1, flash: 0, speed: 1, target: null });
        const x = (i % cols) * cw;
        const y = Math.floor(i / cols) * (ch + 16);
        g.drawImage(canvas, x, y, cw, ch);
        g.fillStyle = '#ddd';
        g.font = '11px system-ui';
        g.fillText(`${c.clip} ${c.moment ?? ''} #${spec.layout} +${at.toFixed(2)} ${(performance.now() - t0).toFixed(0)}ms`, x + 4, y + ch + 12);
        i++;
      }
      info.push({ clip: c.clip, moment: c.moment, puts: shot.puts() });
      shot.dispose();
    }
    return { sheet: sheet.toDataURL('image/jpeg', 0.88), info, errors };
  },
  /** a shot frame by frame, for a film: each picture is handed to `out` */
  async film(c: Cell, fps: number, w: number, h: number) {
    const { k, spec, shot } = await shotOf(c, w, h);
    const n = Math.floor((spec.end - spec.start) * fps);
    const out = (window as unknown as { __frame: (jpg: string) => Promise<void> }).__frame;
    for (let i = 0; i < n; i++) {
      const t = spec.start + i / fps;
      await seek(k, spec.clipAt(t));
      shot.render(t, { footage: k.texture, grow: 1, flash: 0, speed: 1, target: null });
      await out(canvas.toDataURL('image/jpeg', 0.9));
    }
    shot.dispose();
    return n;
  },
};
declare global {
  interface Window {
    __inside: typeof api;
    __ready: boolean;
  }
}
window.__inside = api;
void (async () => {
  await document.fonts.load('900 100px "Archivo Variable"');
  window.__ready = true;
})();
