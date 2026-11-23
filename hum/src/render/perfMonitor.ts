/**
 * The performance monitor: what this machine is and how the stage runs on it, kept cheaply all the
 * time so a person on a slow PC can press "Copy report" (Video › More › Performance) and send us the
 * truth. Nothing here changes what is drawn.
 *
 * It records:
 *   - the graphics card and how the browser reaches it (WEBGL_debug_renderer_info: ANGLE names the
 *     backend, Direct3D11 / Metal / OpenGL, and the GPU), and whether it is a software renderer
 *   - every drawn frame's interval and how long the stage's own JavaScript took (last 30 s)
 *   - long frames (over 50 ms) in the last minute, with the look on screen and whether it had just
 *     changed or a shader had just compiled
 *   - shader compiles: the time the page was blocked compiling and linking each program, and the look
 *   - synchronous readPixels, PBO (asynchronous) reads and 2D-canvas texture uploads, per second
 *
 * The counters come from wrapping a handful of methods on the stage's own WebGL context (not the
 * prototype, so other contexts are untouched); each wrapper is a counter and a clock read.
 */
import type * as THREE from 'three';
import { useStudio } from '../state/store';
import { quality } from './quality';

export interface GpuInfo {
  vendor: string;
  renderer: string;
  backend: string;
  software: boolean;
  webgl: string;
  parallelCompile: boolean;
  floatTargets: boolean;
  halfFloatLinear: boolean;
  timerQuery: boolean;
  maxTexture: number;
  maxSamples: number;
}

export interface LongFrame {
  at: number;
  ms: number;
  look: string;
  /** the look had changed within half a second before this frame */
  cut: boolean;
  /** ms the page spent blocked on shader compiles inside this frame */
  compile: number;
}

export interface CompileRecord {
  look: string;
  ms: number;
  fragChars: number;
}

const WINDOW_MS = 30_000;
const LONG_MS = 50;

/** names a renderer string uses when there is no GPU behind it */
const SOFTWARE = /swiftshader|basic render|llvmpipe|softpipe|software|mesa offscreen|microsoft basic/i;

function backendOf(r: string): string {
  if (/swiftshader/i.test(r)) return 'SwiftShader (software, no GPU)';
  if (/direct3d11|d3d11/i.test(r)) return 'Direct3D 11 (through ANGLE)';
  if (/direct3d9|d3d9/i.test(r)) return 'Direct3D 9 (through ANGLE)';
  if (/vulkan/i.test(r)) return 'Vulkan (through ANGLE)';
  if (/metal/i.test(r)) return 'Metal (through ANGLE)';
  if (/opengl/i.test(r)) return 'OpenGL (through ANGLE)';
  return 'unknown';
}

class PerfMonitor {
  gpu: GpuInfo | null = null;
  readonly start = performance.now();
  /** drawn frames: time, interval, the stage's JavaScript (ms) */
  private fAt: number[] = [];
  private fDt: number[] = [];
  private fJs: number[] = [];
  readonly long: LongFrame[] = [];
  readonly compiles: CompileRecord[] = [];
  compileTotal = 0;
  private compileThisFrame = 0;
  private lastLook = '';
  private lookChangedAt = -1e9;
  private lastDraw = -1;
  /** counters since the page opened, and a snapshot every second for rates */
  private count = { reads: 0, asyncReads: 0, uploads: 0, uploadPx: 0, uploadMs: 0, compiles: 0 };
  private snaps: { at: number; c: PerfMonitor['count'] }[] = [];
  skipped = 0;
  drawn = 0;
  /** what is being compiled right now, when it isn't the look on screen (a warm-up of the next look) */
  label = '';

  /** run `f` with compiles counted against `label` (the stage's warm-ups use this) */
  during<T>(label: string, f: () => T): T {
    const was = this.label;
    this.label = label;
    try {
      return f();
    } finally {
      this.label = was;
    }
  }

  /** look at the context once, and start counting on it */
  attach(renderer: THREE.WebGLRenderer) {
    const gl = renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const rendererName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    const vendor = dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR));
    const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    this.gpu = {
      vendor,
      renderer: rendererName,
      backend: backendOf(rendererName),
      software: SOFTWARE.test(rendererName),
      webgl: isGL2 ? 'WebGL 2' : 'WebGL 1',
      parallelCompile: !!gl.getExtension('KHR_parallel_shader_compile'),
      floatTargets: !!gl.getExtension('EXT_color_buffer_float'),
      halfFloatLinear: !!gl.getExtension('OES_texture_half_float_linear') || isGL2,
      timerQuery: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      maxSamples: isGL2 ? ((gl as WebGL2RenderingContext).getParameter((gl as WebGL2RenderingContext).MAX_SAMPLES) as number) : 0,
    };
    quality.setMachine(rendererName);
    if (this.gpu.software) quality.startAt(9, 'software renderer: lowest detail');
    this.wrap(gl);
  }

  private wrap(gl: WebGLRenderingContext | WebGL2RenderingContext) {
    const g = gl as unknown as Record<string, (...a: unknown[]) => unknown>;
    const c = this.count;
    const progLook = new WeakMap<object, CompileRecord>();
    const shaderLen = new WeakMap<object, number>();
    /** blocking time per shader (compile and status queries), and the program record it ends up in */
    const shaderMs = new WeakMap<object, number>();
    const shaderRec = new WeakMap<object, CompileRecord>();
    const onShader = (sh: object, ms: number) => {
      const rec = shaderRec.get(sh);
      if (rec) rec.ms += ms;
      else shaderMs.set(sh, (shaderMs.get(sh) ?? 0) + ms);
    };
    const attached = new WeakMap<object, object[]>();
    const timed = (name: string, after?: (a: unknown[], ms: number) => void) => {
      const f = g[name];
      if (typeof f !== 'function') return;
      g[name] = (...a: unknown[]) => {
        const t0 = performance.now();
        const r = f.apply(gl, a);
        const ms = performance.now() - t0;
        this.compileTotal += ms;
        this.compileThisFrame += ms;
        after?.(a, ms);
        return r;
      };
    };
    const src = g.shaderSource;
    g.shaderSource = (sh: unknown, s: unknown) => {
      shaderLen.set(sh as object, String(s).length);
      return src.call(gl, sh, s);
    };
    const att = g.attachShader;
    g.attachShader = (p: unknown, sh: unknown) => {
      const l = attached.get(p as object) ?? [];
      l.push(sh as object);
      attached.set(p as object, l);
      return att.call(gl, p, sh);
    };
    timed('compileShader', (a, ms) => onShader(a[0] as object, ms));
    timed('linkProgram', (a, ms) => {
      const p = a[0] as object;
      const shs = attached.get(p) ?? [];
      const frag = Math.max(0, ...shs.map((s) => shaderLen.get(s) ?? 0));
      const rec = { look: this.label || useStudio.getState().presetId || '?', ms, fragChars: frag };
      for (const sh of shs) {
        rec.ms += shaderMs.get(sh) ?? 0;
        shaderRec.set(sh, rec);
      }
      progLook.set(p, rec);
      this.compiles.push(rec);
      if (this.compiles.length > 400) this.compiles.shift();
      c.compiles++;
    });
    timed('getShaderParameter', (a, ms) => onShader(a[0] as object, ms));
    timed('getProgramParameter', (a, ms) => {
      const rec = progLook.get(a[0] as object);
      if (rec) rec.ms += ms;
    });
    // three.js reads the logs right after linking, which is where a driver that compiles lazily waits
    timed('getShaderInfoLog', (a, ms) => onShader(a[0] as object, ms));
    timed('getProgramInfoLog', (a, ms) => {
      const rec = progLook.get(a[0] as object);
      if (rec) rec.ms += ms;
    });
    // the first draw with a program is where some drivers really compile: count it too
    const use = g.useProgram;
    const used = new WeakSet<object>();
    g.useProgram = (p: unknown) => {
      if (!p || used.has(p as object)) return use.call(gl, p);
      used.add(p as object);
      const t0 = performance.now();
      const r = use.call(gl, p);
      const ms = performance.now() - t0;
      this.compileTotal += ms;
      this.compileThisFrame += ms;
      const rec = progLook.get(p as object);
      if (rec) rec.ms += ms;
      return r;
    };
    const read = g.readPixels;
    g.readPixels = (...a: unknown[]) => {
      // with a pixel-pack buffer bound the last argument is an offset and the read doesn't wait
      if (typeof a[6] === 'number') c.asyncReads++;
      else c.reads++;
      return read.apply(gl, a);
    };
    for (const name of ['texImage2D', 'texSubImage2D']) {
      const f = g[name];
      g[name] = (...a: unknown[]) => {
        const last = a[a.length - 1];
        const isCanvas = (typeof HTMLCanvasElement !== 'undefined' && last instanceof HTMLCanvasElement) || (typeof OffscreenCanvas !== 'undefined' && last instanceof OffscreenCanvas);
        if (!isCanvas) return f.apply(gl, a);
        const t0 = performance.now();
        const r = f.apply(gl, a);
        c.uploadMs += performance.now() - t0;
        c.uploads++;
        c.uploadPx += (last as HTMLCanvasElement).width * (last as HTMLCanvasElement).height;
        return r;
      };
    }
  }

  /** a display refresh the stage skipped (high-refresh screens draw every 2nd or 3rd) */
  skip() {
    this.skipped++;
  }

  /** after each drawn frame: when it started (rAF time) and how long the stage's JavaScript took */
  frame(now: number, jsMs: number) {
    this.drawn++;
    const look = useStudio.getState().presetId || '';
    if (look !== this.lastLook) {
      this.lastLook = look;
      this.lookChangedAt = now;
    }
    const dt = this.lastDraw < 0 ? 0 : now - this.lastDraw;
    this.lastDraw = now;
    if (dt > 0 && dt < 5000) {
      this.fAt.push(now);
      this.fDt.push(dt);
      this.fJs.push(jsMs);
      // the frame that took long is the one before this callback: the look, compile and cut belong to it
      if (dt > LONG_MS) {
        this.long.push({ at: now, ms: Math.round(dt), look: this.prevLook, cut: now - this.prevChange < 600, compile: Math.round(this.prevCompile) });
        if (this.long.length > 200) this.long.shift();
      }
    }
    this.prevLook = look;
    this.prevChange = this.lookChangedAt;
    this.prevCompile = this.compileThisFrame;
    this.compileThisFrame = 0;
    // drop what's older than the window (in chunks, so this stays cheap)
    if (this.fAt.length > 64 && now - this.fAt[63] > WINDOW_MS) {
      let k = 0;
      while (k < this.fAt.length && now - this.fAt[k] > WINDOW_MS) k++;
      this.fAt.splice(0, k);
      this.fDt.splice(0, k);
      this.fJs.splice(0, k);
    }
    const lastSnap = this.snaps[this.snaps.length - 1];
    if (!lastSnap || now - lastSnap.at >= 1000) {
      this.snaps.push({ at: now, c: { ...this.count } });
      if (this.snaps.length > 61) this.snaps.shift();
    }
  }
  private prevLook = '';
  private prevChange = -1e9;
  private prevCompile = 0;

  /** frame interval and JavaScript time over the last 30 s */
  stats() {
    const q = (arr: number[], k: number) => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(k * s.length))];
    };
    const span = this.fAt.length > 1 ? (this.fAt[this.fAt.length - 1] - this.fAt[0]) / 1000 : 0;
    return {
      n: this.fDt.length,
      fps: span > 0 ? (this.fDt.length - 1) / span : 0,
      p50: q(this.fDt, 0.5),
      p95: q(this.fDt, 0.95),
      worst: this.fDt.length ? Math.max(...this.fDt) : 0,
      js50: q(this.fJs, 0.5),
      js95: q(this.fJs, 0.95),
    };
  }

  /** readbacks, uploads and compiles per second over the last ~10 s */
  rates() {
    const s = this.snaps;
    if (s.length < 2) return { reads: 0, asyncReads: 0, uploads: 0, uploadMpx: 0, uploadMs: 0, compiles: 0 };
    const a = s[Math.max(0, s.length - 11)];
    const b = s[s.length - 1];
    const T = Math.max(0.001, (b.at - a.at) / 1000);
    return {
      reads: (b.c.reads - a.c.reads) / T,
      asyncReads: (b.c.asyncReads - a.c.asyncReads) / T,
      uploads: (b.c.uploads - a.c.uploads) / T,
      uploadMpx: (b.c.uploadPx - a.c.uploadPx) / T / 1e6,
      uploadMs: (b.c.uploadMs - a.c.uploadMs) / T,
      compiles: (b.c.compiles - a.c.compiles) / T,
    };
  }

  /** long frames in the last minute */
  recentLong(now = performance.now()) {
    return this.long.filter((l) => now - l.at < 60_000);
  }
}

export const perfMonitor = new PerfMonitor();
