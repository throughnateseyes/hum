/**
 * The performance report a person can copy (Video › More › Performance › Copy report), the small live
 * overlay that `?perf=1` in the address shows, and the one-time note when the browser is drawing
 * without a graphics card.
 *
 * The overlay and the note are plain DOM built here, so they work from the stage alone, with no part of
 * the app's layout knowing about them.
 */
import { live } from '../state/live';
import { useStudio } from '../state/store';
import { LADDER, quality } from './quality';
import { perfMonitor } from './perfMonitor';

type StageInfo = { canvas: HTMLCanvasElement; width: number; height: number; sceneSize: () => { w: number; h: number; samples: number } };
const stage = () => live.stage as unknown as StageInfo | null;

const r1 = (v: number) => Math.round(v * 10) / 10;

function browserLine(): string {
  const ua = navigator.userAgent;
  const nav = navigator as Navigator & { userAgentData?: { brands?: { brand: string; version: string }[]; platform?: string } };
  const brands = nav.userAgentData?.brands?.filter((b) => !/not.?a.?brand/i.test(b.brand)).map((b) => `${b.brand} ${b.version}`) ?? [];
  const browser = brands.length ? brands.join(', ') : (ua.match(/(Edg|Chrome|Firefox|Safari)\/[\d.]+/)?.[0] ?? 'unknown');
  const os = nav.userAgentData?.platform || (/Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown');
  return `${browser} on ${os}`;
}

function rungLine(k: number): string {
  const r = LADDER[k];
  const px = r.maxPx === Infinity ? "screen's own pixels" : `≤ ${(r.maxPx / 1e6).toFixed(1)} Mpx`;
  const parts = [px];
  if (r.windows < 3) parts.push(r.windows ? `${r.windows} scene window` : 'no scene windows');
  if (r.sceneScale < 1) parts.push(`look at ${Math.round(r.sceneScale * 100)}%`);
  if (r.fxAtSceneScale) parts.push('effects at look size');
  if (r.handLite) parts.push('light hand-drawn');
  return parts.join(', ');
}

/** three short lines for the panel */
export function perfSummary(): string[] {
  const g = perfMonitor.gpu;
  const s = perfMonitor.stats();
  const st = stage();
  const gpu = g ? `${shortGpu(g.renderer)} · ${g.backend.replace(' (through ANGLE)', '')}${g.software ? ' · SOFTWARE' : ''}` : 'graphics not started';
  const frames = s.n ? `${Math.round(s.fps)} fps · ${r1(s.p50)} ms typical, ${r1(s.p95)} ms slow frames` : 'not playing yet';
  const size = st ? `Drawing ${st.canvas.width}×${st.canvas.height} · detail step ${quality.level} (0 = most) · ${quality.refreshHz} Hz` : '';
  return [gpu, frames, size];
}

/** "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)" → "NVIDIA GeForce RTX 3060" */
function shortGpu(r: string): string {
  const m = r.match(/^ANGLE \(([^,]+), (.+?)(?: Direct3D| \(0x| vs_| OpenGL|, ANGLE Metal|, Unspecified|\)|,)/);
  if (m) return m[2].replace(/^ANGLE Metal Renderer: /, '');
  return r.length > 48 ? r.slice(0, 48) + '…' : r;
}

/** the full plain-text report */
export function perfReport(): string {
  const g = perfMonitor.gpu;
  const s = perfMonitor.stats();
  const rt = perfMonitor.rates();
  const st = stage();
  const studio = useStudio.getState();
  const L: string[] = [];
  L.push('Hum performance report');
  L.push(`Time: ${new Date().toISOString()}  ·  open for ${Math.round((performance.now() - perfMonitor.start) / 1000)} s`);
  L.push(`Browser: ${browserLine()}`);
  L.push(`User agent: ${navigator.userAgent}`);
  L.push(`CPU threads: ${navigator.hardwareConcurrency ?? '?'}  ·  memory: ${(navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? '?'} GB (browser's rough figure)`);
  L.push('');
  L.push('— Graphics —');
  if (g) {
    L.push(`GPU: ${g.renderer}`);
    L.push(`Vendor: ${g.vendor}`);
    L.push(`Backend: ${g.backend}`);
    if (g.software) L.push('WARNING: this is a SOFTWARE renderer. The browser is not using the graphics card at all, so every picture is drawn by the processor. Turn on "Use graphics acceleration when available" in the browser settings (System) and restart it.');
    L.push(`${g.webgl}  ·  parallel shader compile: ${g.parallelCompile ? 'yes' : 'NO'}  ·  float targets: ${g.floatTargets ? 'yes' : 'no'}  ·  max texture ${g.maxTexture}  ·  max MSAA ${g.maxSamples}`);
    if (/integrated|intel\(r\) (uhd|hd|iris)|radeon\(tm\) graphics|vega \d+ graphics/i.test(g.renderer)) L.push('Note: this looks like an integrated GPU. On a laptop with two GPUs, Windows may be giving the browser the weaker one (Settings › System › Display › Graphics › choose the browser › High performance).');
  } else L.push('GPU: not started');
  L.push('');
  L.push('— Screen —');
  L.push(`Screen: ${screen.width}×${screen.height} CSS px  ·  devicePixelRatio ${window.devicePixelRatio}  ·  refresh ≈ ${quality.refreshHz} Hz (measured)  ·  drawing every ${quality.drawEvery} refresh${quality.drawEvery > 1 ? 'es' : ''}`);
  L.push(`Window: ${window.innerWidth}×${window.innerHeight}  ·  full screen: ${studio.perform ? 'yes' : 'no'}  ·  Render quality setting ${Math.round(studio.quality * 100)}%`);
  if (st) {
    const sc = st.sceneSize();
    L.push(`Canvas: ${st.canvas.clientWidth}×${st.canvas.clientHeight} on the page, drawing ${st.canvas.width}×${st.canvas.height} (${r1((st.canvas.width * st.canvas.height) / 1e6)} Mpx)`);
    L.push(`Look target: ${sc.w}×${sc.h}, MSAA ×${sc.samples || 0}`);
  }
  L.push('');
  L.push('— Detail level (quality governor) —');
  L.push(`Now: level ${quality.level} of ${LADDER.length - 1} (${rungLine(quality.level)})${quality.forced !== null ? `  ·  FORCED to ${quality.forced}` : ''}`);
  L.push(`Started from: ${quality.startedFrom}`);
  const hist = quality.history.slice(-12);
  if (hist.length) for (const h of hist) L.push(`  ${r1(h.at / 1000)} s → level ${h.level}: ${h.why}`);
  else L.push('  no changes');
  L.push('');
  L.push('— Frames (last 30 s, drawn frames only) —');
  if (s.n) {
    L.push(`${s.n} frames · ${r1(s.fps)} fps · interval median ${r1(s.p50)} ms · p95 ${r1(s.p95)} ms · worst ${r1(s.worst)} ms (on time = ${r1(quality.target)} ms)`);
    L.push(`Stage JavaScript per frame: median ${r1(s.js50)} ms · p95 ${r1(s.js95)} ms  (the rest of a slow frame is the GPU or the browser)`);
  } else L.push('No frames yet: play the song for a minute first.');
  L.push(`Playing: ${studio.track ? 'a song' : 'nothing'}  ·  look now: ${studio.presetId || '?'}  ·  video plan: ${studio.planOn && studio.plan ? 'on' : 'off'}`);
  const longs = perfMonitor.recentLong();
  L.push(`Long frames (> 50 ms) in the last minute: ${longs.length}`);
  for (const l of longs.slice(-12)) L.push(`  ${r1(l.at / 1000)} s · ${l.ms} ms · ${l.look}${l.cut ? ' · just after a look change' : ''}${l.compile > 1 ? ` · ${l.compile} ms compiling shaders` : ''}`);
  L.push('');
  L.push('— Shaders —');
  const cs = perfMonitor.compiles;
  L.push(`Programs compiled this session: ${cs.length}  ·  page blocked compiling: ${Math.round(perfMonitor.compileTotal)} ms in all`);
  const slow = [...cs].sort((a, b) => b.ms - a.ms).slice(0, 5);
  for (const c of slow) L.push(`  ${r1(c.ms)} ms · ${c.look} · ${c.fragChars} chars`);
  L.push('');
  L.push('— Per second (last 10 s) —');
  L.push(`Synchronous readbacks: ${r1(rt.reads)}/s  ·  async readbacks: ${r1(rt.asyncReads)}/s`);
  L.push(`Canvas uploads: ${r1(rt.uploads)}/s, ${r1(rt.uploadMpx)} Mpx/s, ${r1(rt.uploadMs)} ms/s on the main thread`);
  L.push(`Shader programs linked: ${r1(rt.compiles)}/s  ·  refreshes skipped (high-refresh screen): ${perfMonitor.skipped}`);
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  if (mem) L.push(`JS heap: ${Math.round(mem.usedJSHeapSize / 1e6)} MB of ${Math.round(mem.jsHeapSizeLimit / 1e6)} MB`);
  return L.join('\n');
}

/* ───────── ?perf=1 overlay ───────── */

let overlay: HTMLDivElement | null = null;

/** show the live overlay when the address has ?perf=1 */
export function maybeShowOverlay() {
  if (overlay || typeof location === 'undefined' || new URLSearchParams(location.search).get('perf') !== '1') return;
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  Object.assign(el.style, {
    position: 'fixed',
    left: '8px',
    bottom: '8px',
    zIndex: '9999',
    font: '11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    color: '#e8f5e9',
    background: 'rgba(0,0,0,0.72)',
    padding: '6px 8px',
    borderRadius: '6px',
    pointerEvents: 'none',
    whiteSpace: 'pre',
  });
  document.body.appendChild(el);
  overlay = el;
  const update = () => {
    const s = perfMonitor.stats();
    const st = stage();
    const g = perfMonitor.gpu;
    const longs = perfMonitor.recentLong().length;
    el.textContent = [
      `${r1(s.p50)} ms  p95 ${r1(s.p95)}  worst ${Math.round(s.worst)}  (${Math.round(s.fps)} fps)`,
      `js ${r1(s.js50)} ms  long/min ${longs}  level ${quality.level}${quality.forced !== null ? ' (forced)' : ''}`,
      st ? `draw ${st.canvas.width}×${st.canvas.height}  look ${st.sceneSize().w}×${st.sceneSize().h} ×${st.sceneSize().samples}  ${quality.refreshHz} Hz/${quality.drawEvery}` : '',
      g ? shortGpu(g.renderer) + (g.software ? '  SOFTWARE' : '') : '',
    ].join('\n');
  };
  update();
  window.setInterval(update, 250);
}

/* ───────── software renderer note ───────── */

const NOTE_KEY = 'hum.softwareNote';

/** tell the person once, plainly, that the browser is drawing without the graphics card */
export function maybeShowSoftwareNote() {
  if (!perfMonitor.gpu?.software) return;
  try {
    if (localStorage.getItem(NOTE_KEY)) return;
    localStorage.setItem(NOTE_KEY, '1');
  } catch {
    /* storage blocked: show it this time anyway */
  }
  const el = document.createElement('div');
  el.setAttribute('role', 'status');
  Object.assign(el.style, {
    position: 'fixed',
    left: '50%',
    top: '16px',
    transform: 'translateX(-50%)',
    zIndex: '9999',
    maxWidth: 'min(560px, calc(100vw - 32px))',
    font: '13px/1.45 system-ui, sans-serif',
    color: '#1a1a1a',
    background: '#fff8e1',
    border: '1px solid #e0c060',
    boxShadow: '0 6px 24px rgba(0,0,0,0.25)',
    padding: '12px 14px',
    borderRadius: '8px',
  });
  const p = document.createElement('div');
  p.textContent =
    'Your browser is drawing Hum without your graphics card (a "software renderer"), so it will stutter on any computer. To fix it: open the browser settings, go to System, switch on "Use graphics acceleration when available" (Chrome) or "Use hardware acceleration when available" (Edge), then restart the browser.';
  const b = document.createElement('button');
  b.textContent = 'Got it';
  Object.assign(b.style, { marginTop: '8px', font: 'inherit', padding: '4px 12px', borderRadius: '6px', border: '1px solid #c9a640', background: '#fff', cursor: 'pointer' });
  b.onclick = () => el.remove();
  el.append(p, b);
  document.body.appendChild(el);
}
