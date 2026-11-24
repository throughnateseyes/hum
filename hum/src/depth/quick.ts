/**
 * The first look at a clip (or the only look at a photo): a handful of frames spread over it. Enough to
 * say where its horizon is, what is sky, ground and near, how it splits into layers and how its camera
 * moves, and to fix the one scale all of its maps are kept on. Pure, like stretch.ts.
 */
import { findLines, fitGround, focalFor, headLine, horizonOf, layersOf, vanishing, type Ground, type Line } from './geometry';
import { ratioOf, Stretch, type Scale } from './stretch';
import type { View3 } from './track';
import { EYE, type ClipScene } from './types';

export interface QuickIn {
  t: number;
  /** nearness as the model gives it */
  map: Float32Array;
  luma: Float32Array;
  /** the frames just after it, a tenth of a second apart */
  next?: { t: number; luma: Float32Array }[];
}

export interface QuickOut {
  focal: number;
  scale: Scale;
  /** the maps on the clip's scale, 0..1 */
  maps: Float32Array[];
  views: View3[];
  zScale: number;
  sure: ClipScene['sure'];
  sky: number;
  ground: number;
  near: number;
  splits: number[];
  camera: ClipScene['camera'];
  /** world units a second, when the camera moves ahead */
  speed: number;
}

const mid = (a: number[]) => (a.length ? [...a].sort((p, q) => p - q)[a.length >> 1] : 0);

/** nearness as the byte it is kept as, and back */
export const toByte = (n: number) => Math.min(255, Math.max(0, Math.round(255 * Math.sqrt(Math.min(1, Math.max(0, n))))));
export const fromByte = (b: number) => (b / 255) ** 2;

export function quickRead(frames: QuickIn[], w: number, h: number, photo: boolean): QuickOut {
  const aspect = w / h;
  const focal = focalFor(aspect, photo);
  const grounds = frames.map((f) => fitGround([f.map], w, h));
  const steep = (g: Ground) => Math.hypot(g.a, g.b);
  const believable = grounds.filter((g): g is Ground => !!g && g.sure > 0.4);
  const byGround = believable.length * 2 >= frames.length && believable.length > 0;
  const slope = byGround ? mid(believable.map(steep)) : 0;

  // one scale for all of them: the ground is as steep in each, or else what stayed put is as near in each
  const ks: number[] = [];
  frames.forEach((f, i) => {
    const g = grounds[i];
    if (byGround && g && g.sure > 0.4) ks.push(slope / steep(g));
    else {
      let k: number | null = null;
      for (let j = i - 1; j >= 0 && k === null; j--) {
        const r = ratioOf(frames[j].map, f.map, frames[j].luma, f.luma, 0.15) ?? ratioOf(frames[j].map, f.map, null, null, 0.15);
        if (r !== null && Math.abs(Math.log(r)) < 0.8) k = r * ks[j];
      }
      ks.push(k ?? 1);
    }
  });
  let max = 0;
  frames.forEach((f, i) => {
    const some: number[] = [];
    for (let p = 2; p < f.map.length; p += 5) some.push(f.map[p]);
    some.sort((a, b) => a - b);
    max = Math.max(max, some[Math.floor(some.length * 0.997)] * ks[i]);
  });
  max = Math.max(1e-3, max * 1.06);
  const scale: Scale = { max, slope };

  // how the camera moves, from short bursts
  const kinds: ClipScene['camera'][] = [];
  const speeds: number[] = [];
  const slides: number[] = [];
  let aheadSure = 0;
  const turnedTo: View3[] = [];
  for (const f of frames) {
    if (!f.next?.length) continue;
    const s = new Stretch(w, h, focal, scale);
    s.push({ t: f.t, map: f.map, luma: f.luma });
    for (const x of f.next) s.push({ t: x.t, map: null, luma: x.luma });
    const r = s.finish();
    kinds.push(r.camera);
    slides.push(r.sure.slide);
    if (r.camera === 'ahead') {
      speeds.push(mid(r.speeds));
      turnedTo.push(r.views[0]);
      aheadSure = Math.max(aheadSure, r.sure.ahead);
    }
  }
  const many = (k: ClipScene['camera']) => kinds.filter((x) => x === k).length;
  const camera: ClipScene['camera'] = !kinds.length ? 'still' : many('ahead') * 2 >= kinds.length ? 'ahead' : many('pan') * 2 > kinds.length ? 'pan' : many('handheld') * 2 >= kinds.length ? 'handheld' : 'still';

  const maps = frames.map((f, i) => Float32Array.from(f.map, (v) => Math.min(1, (v * ks[i]) / max)));

  // where the horizon is in each, and the vanishing point: one for the clip if the camera stays put
  const own = grounds.map((g) => (g && g.sure > 0.15 ? { ...horizonOf(g), w: g.sure ** 2 } : null));
  const known = own.filter((o): o is { y: number; roll: number; w: number } => !!o);
  const my = mid(known.map((o) => o.y));
  const mr = mid(known.map((o) => o.roll));
  const groundSure = known.length ? (mid(grounds.map((g) => g?.sure ?? 0)) * known.length) / frames.length : 0;
  // a crowd hides the ground: what is farthest at each place over the clip shows where its heads stop
  let heads: number | null = null;
  if (groundSure < 0.1) {
    const back = Float32Array.from(maps[0]);
    for (const m of maps) for (let i = 0; i < back.length; i++) if (m[i] < back[i]) back[i] = m[i];
    heads = headLine(back, w, h);
  }
  const lines = frames.map((f) => findLines(f.luma, w, h));
  const placed = camera === 'still' || camera === 'handheld';
  const all: Line[] = lines.flat();
  const pooled = placed && groundSure > 0.15 ? vanishing(all, aspect, { y: my, roll: mr }, 0.04) : null;
  const views = frames.map((_, i): View3 => {
    const o = own[i];
    const roll = o && groundSure > 0.15 ? (placed ? mr : o.roll) : 0;
    const y = heads ?? (groundSure < 0.1 ? 0 : o ? (placed ? my * 0.6 + o.y * 0.4 : o.y) : my);
    if (camera === 'ahead' && turnedTo.length) {
      const x = turnedTo.reduce((s, v) => s + v.x, 0) / turnedTo.length;
      return { x, y: y + x * Math.tan(roll), roll };
    }
    const v = groundSure > 0.15 ? (pooled ?? vanishing(lines[i], aspect, { y, roll }, 0.04)) : null;
    const x = v && v.sure > 0.25 && Math.abs(v.x) < 0.8 * aspect ? v.x : 0;
    return { x, y: y + x * Math.tan(roll), roll };
  });

  // what the picture is made of
  let sky = 0;
  let ground = 0;
  let near = 0;
  const counts = new Float64Array(256);
  const seen: number[] = [];
  maps.forEach((m, i) => {
    const g = grounds[i];
    const k = ks[i] / max;
    const v = views[i];
    for (let y = 0; y < h; y += 2)
      for (let x = 0; x < w; x += 2) {
        const n = m[y * w + x];
        counts[toByte(n)]++;
        if (n > 0.01) seen.push(n);
        const X = ((x + 0.5) / w - 0.5) * aspect;
        const Y = (y + 0.5) / h - 0.5;
        const hz = v.y + (X - v.x) * Math.tan(v.roll);
        if (n < 0.004 && Y > hz - 0.02) sky++;
        else if (g && g.sure > 0.15 && Y < hz) {
          const p = (g.a * X + g.b * Y + g.c) * k;
          const raw = frames[i].map[y * w + x] * k;
          if (Math.abs(raw - p) < 0.08 * p) ground++;
        }
      }
  });
  const total = maps.length * Math.ceil(w / 2) * Math.ceil(h / 2);
  seen.sort((a, b) => a - b);
  const typical = seen.length ? seen[seen.length >> 1] : 0.2;
  const onGround = groundSure > 0.1 && slope > 0;
  const zScale = onGround ? (focal * EYE * slope) / max : 12 * typical;
  // near: closer than six steps, standing up (not the ground itself)
  const close = onGround ? zScale / 6 : 0.35;
  maps.forEach((m, i) => {
    const g = grounds[i];
    const k = ks[i] / max;
    for (let y = 0; y < h; y += 2)
      for (let x = 0; x < w; x += 2) {
        const n = m[y * w + x];
        if (n < close) continue;
        const X = ((x + 0.5) / w - 0.5) * aspect;
        const Y = (y + 0.5) / h - 0.5;
        const p = g && g.sure > 0.15 ? (g.a * X + g.b * Y + g.c) * k : 0;
        if (n > p * 1.12) near++;
      }
  });
  const spread = mid(known.map((o) => Math.abs(o.y - my)));
  const horizon = groundSure * (placed ? Math.min(1, Math.max(0, 1 - (spread - 0.015) / 0.06)) : 1);
  return {
    focal,
    scale,
    maps,
    views,
    zScale,
    sure: { horizon: heads === null ? horizon : 0.25, slide: mid(slides), ahead: camera === 'ahead' ? aheadSure : groundSure > 0.25 ? 0.7 : 0.4 },
    sky: sky / total,
    ground: ground / total,
    near: near / total,
    splits: layersOf(counts).map(fromByte),
    camera,
    speed: mid(speeds),
  };
}
