/**
 * Dev-only frame-cost probe (browser console: `await __hum.perf.sweep()`, `await __hum.perf.moments()`).
 *
 * It pauses the stage's own loop, renders frames back to back at a fixed output size (1080p by
 * default) and waits for the GPU after each one by reading one pixel back, so the number is the real
 * cost of a frame on this machine (CPU + GPU), not the 16.7 ms a 60 Hz screen would report. The
 * stage loop starts again when it's done.
 */
import { live } from '../state/live';
import { useStudio } from '../state/store';
import { PRESETS } from '../presets';
import { localPlan } from '../state/plan';
import type { Preset } from '../core/types';
import { LADDER, quality } from '../render/quality';

type StageLike = {
  renderer: import('three').WebGLRenderer;
  stop(): void;
  start(): void;
  setOutputSize(s: { w: number; h: number } | null): void;
};

const stage = () => live.stage as unknown as (StageLike & { tick(): void }) | null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FrameStats {
  avg: number;
  p50: number;
  p95: number;
  max: number;
  n: number;
}

function stats(ms: number[]): FrameStats {
  const s = [...ms].sort((a, b) => a - b);
  const q = (k: number) => s[Math.min(s.length - 1, Math.floor(k * s.length))];
  const r = (v: number) => Math.round(v * 100) / 100;
  return { avg: r(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)), p50: r(q(0.5)), p95: r(q(0.95)), max: r(s[s.length - 1] ?? 0), n: s.length };
}

/** render `n` frames back to back (after `warm` untimed ones) and time each one, GPU included */
export async function measure(n = 90, warm = 20, size = { w: 1920, h: 1080 }): Promise<FrameStats> {
  const st = stage();
  if (!st) throw new Error('no stage');
  const gl = st.renderer.getContext();
  const px = new Uint8Array(4);
  st.stop();
  st.setOutputSize(size);
  const ms: number[] = [];
  try {
    for (let i = 0; i < warm + n; i++) {
      const t0 = performance.now();
      st.tick();
      gl.finish();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      if (i >= warm) ms.push(performance.now() - t0);
      // let the audio clock and the browser breathe between frames, like a real loop would
      if (i % 10 === 9) await wait(0);
    }
  } finally {
    st.setOutputSize(null);
    st.start();
  }
  return stats(ms);
}

/**
 * Where a frame's time goes: wraps the stage's layers (effects, scene windows, pop-ups, lyrics,
 * hand-drawn, transitions, impact) so each one waits for the GPU before and after, and adds up what
 * each costs. "scene + rest" is everything else (mostly the look itself). The syncs add a little
 * overhead of their own, so compare the parts, not the total, with `measure()`.
 */
export async function profile(n = 90, size = { w: 1920, h: 1080 }): Promise<Record<string, number>> {
  const st = stage() as unknown as Record<string, unknown> & StageLike & { tick(): void };
  if (!st) throw new Error('no stage');
  const gl = st.renderer.getContext();
  const px = new Uint8Array(4);
  const sync = () => {
    gl.finish();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  };
  const spent: Record<string, number> = {};
  const undo: (() => void)[] = [];
  const wrap = (obj: Record<string, unknown> | undefined, method: string, label: string) => {
    if (!obj || typeof obj[method] !== 'function') return;
    const orig = obj[method] as (...a: unknown[]) => unknown;
    const own = Object.prototype.hasOwnProperty.call(obj, method);
    undo.push(() => (own ? (obj[method] = orig) : delete obj[method]));
    obj[method] = (...args: unknown[]) => {
      sync();
      const t0 = performance.now();
      const r = orig.apply(obj, args);
      sync();
      spent[label] = (spent[label] ?? 0) + performance.now() - t0;
      return r;
    };
  };
  const o = (k: string) => st[k] as Record<string, unknown> | undefined;
  wrap(o('fx'), 'run', 'effects');
  wrap(o('fxOut'), 'run', 'effects');
  wrap(o('sceneWindows'), 'render', 'scene windows');
  wrap(o('popups'), 'render', 'pop-ups');
  wrap(o('lyricLayer'), 'render', 'lyrics');
  wrap(o('lyricLayer'), 'sample', 'lyrics');
  wrap(o('hand'), 'render', 'hand-drawn');
  wrap(o('trPass'), 'render', 'transition');
  wrap(o('impactQuad'), 'render', 'impact');
  st.stop();
  st.setOutputSize(size);
  let total = 0;
  try {
    for (let i = 0; i < 15; i++) st.tick();
    sync();
    for (const k of Object.keys(spent)) delete spent[k];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      st.tick();
      sync();
      total += performance.now() - t0;
      if (i % 10 === 9) await wait(0);
    }
  } finally {
    undo.forEach((f) => f());
    st.setOutputSize(null);
    st.start();
  }
  const out: Record<string, number> = {};
  let parts = 0;
  for (const [k, v] of Object.entries(spent)) {
    out[k] = Math.round((v / n) * 100) / 100;
    parts += v;
  }
  out['scene + rest'] = Math.round(((total - parts) / n) * 100) / 100;
  out.total = Math.round((total / n) * 100) / 100;
  return out;
}

/** a quiet stage: no pop-ups, no hand-drawn finish, no lyrics, the song map off */
function plain() {
  const s = useStudio.getState();
  s.set({ popups: 'off', planOn: false, hand: { ...s.hand, on: false }, lyricStyle: 'off' });
}

/** frame cost of every built-in look on a plain stage, slowest first */
export async function sweep(n = 30): Promise<{ id: string; avg: number; p95: number }[]> {
  plain();
  const out: { id: string; avg: number; p95: number }[] = [];
  for (const p of PRESETS) {
    useStudio.getState().applyPreset(p);
    await wait(30);
    const r = await measure(n, 8);
    out.push({ id: p.id, avg: r.avg, p95: r.p95 });
  }
  return out.sort((a, b) => b.avg - a.avg);
}

/** fake timed lyrics over the whole song so the lyric layer has work to do */
function fakeLyrics(duration: number) {
  const words = 'every light in the city is waiting for the drop to come down on me tonight'.split(' ');
  const lines = [];
  for (let t = 1; t < duration - 2; t += 2.5) {
    const text = Array.from({ length: 6 }, (_, k) => words[(Math.floor(t) + k) % words.length]).join(' ');
    lines.push({ t, end: t + 2.3, text });
  }
  return { lines, synced: true, source: 'pasted' as const };
}

/**
 * The three moments from the brief: a light look, a heavy look, and a busy moment (the heavy look
 * with scene windows and instrument pop-ups at their busiest, the hand-drawn finish and big lyrics).
 */
export async function moments(light = 'mono-grid', heavy?: string, n = 120) {
  const s = useStudio.getState();
  const find = (id: string) => PRESETS.find((p) => p.id === id);
  plain();
  const L = find(light) ?? PRESETS[0];
  let H: Preset | undefined = heavy ? find(heavy) : undefined;
  if (!H) {
    const slow = await sweep(12);
    H = find(slow[0].id);
  }
  useStudio.getState().applyPreset(L);
  await wait(50);
  const lightR = await measure(n);
  useStudio.getState().applyPreset(H!);
  await wait(50);
  const heavyR = await measure(n);
  // busy: a plan with pop level 3 everywhere, windows show both kinds, hand-drawn, big lyrics
  const a = s.analysis;
  if (a && H) {
    const plan = localPlan(a);
    plan.looks = plan.looks.map(() => H.id);
    plan.rotate = plan.looks.map(() => [H.id]);
    plan.pops = plan.looks.map(() => 3);
    plan.interludes = plan.looks.map(() => null);
    useStudio.getState().set({ plan, planOn: true, lyrics: fakeLyrics(a.duration) });
  }
  busy(H!.id);
  await wait(300);
  openWindows(2);
  const busyR = await measure(n, 30);
  openWindows(2);
  const parts = await profile(n);
  plain();
  return { light: { id: L.id, ...lightR }, heavy: { id: H!.id, ...heavyR }, busy: { id: `${H!.id} + windows + pop-ups + hand-drawn + lyrics`, ...busyR }, busyParts: parts };
}

/** the busy moment at every rung of the quality governor's ladder (see src/render/quality.ts) */
export async function rungs(id = 'prism-pearl', n = 90) {
  busy(id);
  await wait(300);
  const out: { rung: number; avg: number; p95: number; max: number }[] = [];
  try {
    for (let k = 0; k < LADDER.length; k++) {
      quality.force(k);
      openWindows(2);
      const r = await measure(n, 30);
      out.push({ rung: k, avg: r.avg, p95: r.p95, max: r.max });
    }
  } finally {
    quality.force(null);
    plain();
  }
  return out;
}

/**
 * The hitch when the song map cuts to a look whose shaders were never compiled: the worst frame
 * around the cut, with the look prewarmed 2.5 s ahead the way the song map does it (background
 * compile, warmup.ts) and without. Each run uses looks not drawn before in this page, since a
 * compiled shader stays compiled.
 */
export async function hitch(ids: string[], mode: 'none' | 'sync' | 'async', size = { w: 1920, h: 1080 }) {
  const st = stage() as unknown as StageLike & { tick(): void; prewarm(id: string, fx?: readonly { effectId: string }[]): void };
  const gl = st.renderer.getContext();
  const px = new Uint8Array(4);
  plain();
  const out: { id: string; worst: number; worstBefore: number }[] = [];
  // 'sync' = how prewarming worked before: the scene drawn once right away (the compile stalls that
  // frame instead of the cut), effects not prewarmed
  const r = st.renderer as unknown as { render: (s: unknown, c: unknown) => void; compileAsync: (s: unknown, c: unknown) => Promise<unknown> };
  const realAsync = r.compileAsync;
  const realRender = r.render;
  if (mode === 'sync') r.compileAsync = (s, c) => (realRender.call(r, s, c), Promise.resolve());
  st.stop();
  st.setOutputSize(size);
  const frame = () => {
    const t0 = performance.now();
    st.tick();
    gl.finish();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return performance.now() - t0;
  };
  try {
    for (const id of ids) {
      const p = PRESETS.find((x) => x.id === id);
      if (!p) continue;
      let worstBefore = 0;
      if (mode !== 'none') {
        st.prewarm(p.sceneId, mode === 'async' ? p.effects : []);
        // frames before the cut, like the song map (real time passes, so background compiles finish)
        for (let i = 0; i < 40; i++) {
          worstBefore = Math.max(worstBefore, frame());
          await wait(16);
        }
      } else for (let i = 0; i < 10; i++) worstBefore = Math.max(worstBefore, frame());
      useStudio.getState().applyPreset(p);
      let worst = 0;
      for (let i = 0; i < 8; i++) worst = Math.max(worst, frame());
      out.push({ id, worst: Math.round(worst * 10) / 10, worstBefore: Math.round(worstBefore * 10) / 10 });
    }
  } finally {
    r.compileAsync = realAsync;
    st.setOutputSize(null);
    st.start();
  }
  return out;
}

/** open scene windows now (they normally open on new parts and phrases), so a busy moment is busy */
export function openWindows(k = 2) {
  const st = live.stage as unknown as { t0: number; sceneWindows?: { queue: { at: number; trail: boolean }[] } } | null;
  const sw = st?.sceneWindows;
  if (!st || !sw) return;
  const now = (performance.now() - st.t0) / 1000;
  for (let i = 0; i < k; i++) sw.queue.push({ at: now + i * 0.05, trail: true });
}

/** the same plain-text report as Video › More › Performance › Copy report */
export { perfReport as report } from '../render/perfReport';

/** set up the busy moment on look `id` (and leave it running, to watch the quality governor work) */
export function busy(id = 'prism-pearl') {
  const s = useStudio.getState();
  const H = PRESETS.find((p) => p.id === id);
  const a = s.analysis;
  if (!H || !a) return false;
  const plan = localPlan(a);
  plan.looks = plan.looks.map(() => H.id);
  plan.rotate = plan.looks.map(() => [H.id]);
  plan.pops = plan.looks.map(() => 3);
  plan.interludes = plan.looks.map(() => null);
  s.set({ plan, planOn: true, lyrics: fakeLyrics(a.duration), popups: 'video', windowKind: 'both', hand: { ...s.hand, on: true, fps: 60 }, lyricStyle: 'big' });
  useStudio.getState().applyPreset(H);
  return true;
}
