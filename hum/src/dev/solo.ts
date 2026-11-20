/**
 * Dev helper (served at /solo.html by `npm run dev`, not part of the build): plays ONE scene against
 * the scripted test song (src/dev/testSong.ts) and hands back frames, so a look can be built and
 * checked without loading audio or clicking through the app. A headless browser drives it:
 *
 *   /solo.html?scene=<id>                    a registered scene, or
 *   /solo.html?mod=/src/scenes/x/y.ts&export=name   a scene file that is not registered yet
 *     &preset=<lookId>                       use a built-in look's params, effects and palette, or
 *     &look=<json>                           { palette: id | {bg,fg,accent,accent2,muted}, sceneParams, effects, modulations }
 *     &w=1280&h=720
 *     &windows=1                             scene windows on (other looks playing in windows over this one)
 *     &popups=1                              instrument pop-ups on (little board windows, popups.ts)
 *     &pops=0..3                             how busy windows and pop-ups get (default: from each part of the song)
 *     &seed=7                                the pop-ups' dice (Math.random is seeded here, so sheets repeat)
 *     &dodge=0                               windows don't keep clear of the words (to look at the halo words get
 *                                            when they sit on a window); each cell's label names the lyric backing
 *     &lyrics=auto | subtitle | big | cutout | <json>   draw lyric type over the look (test lyrics sung in every
 *                                            part, see testLyricsSung). The json fixes the Auto plan so shots compare:
 *                                            { style: 'auto', family: 'serif', motion: 'tender',
 *                                              parts: ['sparse', 'subtitle', 'sparse', 'big+giant', 'sparse', 'subtitle'] }
 *                                            (one per section: intro, verse, build, drop, break, outro; "+giant" / "+burst"
 *                                            adds a moment). The look json may carry the same as `lyrics`.
 *     &finish=film                           a finish over the picture (clean, film, riso, ink, tape, hand);
 *                                            several (finish=clean,film,riso) put each one side by side for
 *                                            every time on the sheet. Also `finish` in the look JSON.
 *
 *   shots() also returns finishMs: what each finish pass alone costs per frame at this size.
 *
 *   await __solo.ready                       → { ok, errors }
 *   await __solo.shots({ times: [4, 16, 32.1], from: 0 })  → { sheet: <png data url>, errors, ms }
 */
import '../index.css';
import * as THREE from 'three';
import { emptyFrame } from '../audio/engine';
import { FeelTracker } from '../core/feel';
import { FULLSCREEN_VERT } from '../core/glsl';
import { createNoiseTexture } from '../core/noise';
import { getPalette, resolvePalette } from '../core/palettes';
import { createFullscreenQuad, makeRenderTarget } from '../core/sceneHelpers';
import type { EffectDef, EffectInstance, FrameContext, Palette, ParamValues, Preset, SceneDef, SceneInstance, SharedResources } from '../core/types';
import { getEffect } from '../fx';
import { PRESETS } from '../presets';
import { presetToLook, type LookState } from '../presets/apply';
import { FxChain } from '../render/fxChain';
import { FinishPass, isGpuFinish, type FinishContext } from '../render/finishPass';
import { HandPass } from '../render/handPass';
import { isFinishId, type FinishId } from '../core/direction';
import { SceneWindows, windowLevels } from '../render/sceneWindows';
import { PopupLayer } from '../render/popups';
import { getScene, registerScene } from '../scenes';
import { createPlaceholderPhoto } from '../scenes/photo/placeholder';
import { resolveParams } from '../state/modulation';
import { popLevelAt } from '../state/plan';
import { HAND_DEFAULT, useStudio } from '../state/store';
import { LyricLayer } from '../render/lyricLayer';
import type { Treatment } from '../render/lyricAuto';
import { setLyricPlanOverride, type LyricMedium, type LyricMoment, type TypeFamily } from '../state/lyricPlan';
import type { LyricStyle } from '../state/store';
import { TEST_SONG, sectionAt, testAnalysis, testFrame, testLyrics, testLyricsSung } from './testSong';

THREE.ColorManagement.enabled = false;

interface LyricSpec {
  style?: LyricStyle;
  family?: TypeFamily;
  motion?: Treatment;
  parts?: string[];
  seed?: number;
}
interface LookSpec {
  finish?: string | string[];
  lyrics?: string | LyricSpec;
  palette?: string | Palette;
  sceneParams?: ParamValues;
  effects?: Preset['effects'];
  modulations?: Preset['modulations'];
}
interface ShotOptions {
  /** song times (s) to capture, ascending */
  times: number[];
  /** where the scene starts playing (s). Default 0. */
  from?: number;
  cols?: number;
  /** width of each picture on the sheet (px) */
  cell?: number;
}

const errors: string[] = [];
const note = (m: string) => {
  if (errors.length < 12 && !errors.includes(m)) errors.push(m);
};
window.addEventListener('error', (e) => note(`error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => note(`rejection: ${String(e.reason)}`));

const q = new URLSearchParams(location.search);
const W = Number(q.get('w')) || 1280;
const H = Number(q.get('h')) || 720;

// the pop-ups roll dice with Math.random: seed it so two sheets of the same look line up
{
  let a = (Number(q.get('seed')) || 7) >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function loadScene(): Promise<SceneDef> {
  const mod = q.get('mod');
  if (mod) {
    const m = (await import(/* @vite-ignore */ mod)) as Record<string, unknown>;
    const name = q.get('export');
    const def = (name ? m[name] : Object.values(m).find((v) => !!v && typeof v === 'object' && 'create' in v && 'params' in v)) as SceneDef | undefined;
    if (!def) throw new Error(`no scene export found in ${mod}`);
    registerScene(def);
    return def;
  }
  const id = q.get('scene') ?? PRESETS.find((p) => p.id === q.get('preset'))?.sceneId ?? '';
  const def = getScene(id);
  if (!def) throw new Error(`unknown scene "${id}"`);
  return def;
}

function buildLook(def: SceneDef): LookState {
  const presetId = q.get('preset');
  const preset = presetId ? PRESETS.find((p) => p.id === presetId) : undefined;
  if (presetId && !preset) throw new Error(`unknown look "${presetId}"`);
  const spec = (q.get('look') ? JSON.parse(q.get('look')!) : {}) as LookSpec;
  const palette = typeof spec.palette === 'string' ? getPalette(spec.palette) : (spec.palette ?? preset?.palette ?? getPalette(def.light ? 'paper-blue' : 'midnight'));
  return presetToLook({
    id: 'solo',
    name: 'solo',
    description: '',
    tags: [],
    sceneId: def.id,
    sceneParams: { ...preset?.sceneParams, ...spec.sceneParams },
    effects: spec.effects ?? preset?.effects ?? [],
    modulations: spec.modulations ?? preset?.modulations ?? (def.modulations ?? []).map((m) => ({ source: m.source, target: `scene.${m.param}`, amount: m.amount })),
    palette: { id: 'solo', name: 'solo', bg: palette.bg, fg: palette.fg, accent: palette.accent, accent2: palette.accent2, muted: palette.muted },
  });
}

/** the lyrics option: from the url, else from the look json */
function lyricSpec(): LyricSpec | null {
  const raw = q.get('lyrics') ?? (q.get('look') ? ((JSON.parse(q.get('look')!) as LookSpec).lyrics ?? null) : null);
  if (!raw) return null;
  if (typeof raw !== 'string') return raw;
  return raw.trim().startsWith('{') ? (JSON.parse(raw) as LyricSpec) : { style: raw as LyricStyle };
}

async function boot() {
  const canvas = document.getElementById('solo') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: true });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    const log = (s: WebGLShader) => gl.getShaderInfoLog(s) || '';
    note(`shader: ${(log(fs) || log(vs) || gl.getProgramInfoLog(program) || 'failed to compile').trim().slice(0, 900)}`);
  };

  const dataTex = (n: number) => {
    const t = new THREE.DataTexture(new Float32Array(n * 4), n, 1, THREE.RGBAFormat, THREE.FloatType);
    t.magFilter = t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  };
  const blitMat = new THREE.ShaderMaterial({
    uniforms: { tMap: { value: null } },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: `precision highp float; varying vec2 vUv; uniform sampler2D tMap; void main(){ gl_FragColor = vec4(texture2D(tMap, vUv).rgb, 1.0); }`,
    depthTest: false,
    depthWrite: false,
  });
  const blitQuad = createFullscreenQuad(blitMat);
  const shared: SharedResources = {
    spectrumTex: dataTex(128),
    waveformTex: dataTex(512),
    noiseTex: createNoiseTexture(),
    blit: (texture, target) => {
      blitMat.uniforms.tMap.value = texture;
      blitQuad.render(renderer, target);
    },
  };

  // the song facts scenes read from the store (title, lyrics, sections)
  const withWindows = q.get('windows') === '1';
  const withPopups = q.get('popups') === '1';
  const popsQ = q.get('pops');
  const popsFixed = popsQ !== null ? Math.max(0, Math.min(3, Math.round(Number(popsQ)))) : null;
  if (withWindows || withPopups) useStudio.setState({ popups: 'always', windowKind: withWindows && withPopups ? 'both' : withWindows ? 'looks' : 'instruments' });
  useStudio.setState({ track: { name: `${TEST_SONG.artist} - ${TEST_SONG.title}`, source: 'file' }, lyrics: testLyrics(), analysis: testAnalysis() });
  await Promise.all(['Inter Variable', 'IBM Plex Mono', 'Playfair Display Variable', 'Oswald Variable', 'JetBrains Mono Variable', 'Caveat Variable', 'Instrument Serif', 'italic 16px "Instrument Serif', 'Fraunces Variable', 'italic 16px "Fraunces Variable', 'Inter Tight Variable', 'Archivo Variable'].map((f) => document.fonts.load(f.startsWith('italic') ? `${f}"` : `16px "${f}"`).catch(() => null)));

  const def = await loadScene();
  const look = buildLook(def);
  const palette = resolvePalette(look.palette);
  const lyr = lyricSpec();
  const lyricLayer = lyr ? new LyricLayer() : null;
  if (lyr && lyricLayer) {
    lyricLayer.probe.readAsync = false;
    const lyrics = testLyricsSung();
    useStudio.setState({ lyrics, lyricStyle: lyr.style ?? 'auto', presetId: q.get('preset'), sceneId: def.id });
    if (lyr.parts) {
      setLyricPlanOverride({
        seed: lyr.seed ?? 7,
        family: lyr.family ?? 'grotesk',
        motion: lyr.motion ?? 'punchy',
        source: 'local',
        parts: testAnalysis().sections.map((_, i) => {
          const [medium, moment] = (lyr.parts![i] ?? 'subtitle').split('+');
          return { medium: medium as LyricMedium, moment: (moment as LyricMoment) || null, why: 'fixed by the solo harness' };
        }),
      });
    }
  }
  const sceneRT = makeRenderTarget(W, H, { depthBuffer: true, samples: 4 });
  const fx = new FxChain(shared);
  fx.setSize(W, H);
  const photos = [createPlaceholderPhoto()];
  const analysis = testAnalysis();
  const audio = emptyFrame();
  const sceneParams: ParamValues = {};
  const fxParams = new Map<string, ParamValues>();
  const chain = look.effects
    .map((inst: EffectInstance) => ({ inst, def: getEffect(inst.effectId) }))
    .filter((c): c is { inst: EffectInstance; def: EffectDef } => !!c.def)
    .map((c) => ({ ...c, params: fxParams.set(c.inst.instanceId, {}).get(c.inst.instanceId)! }));

  // finishes to show (see the header): the first is drawn every frame, the rest side by side on captures
  const spec = (q.get('look') ? JSON.parse(q.get('look')!) : {}) as LookSpec;
  const rawFinish = q.get('finish') ?? (Array.isArray(spec.finish) ? spec.finish.join(',') : spec.finish) ?? 'clean';
  const finishIds = rawFinish.split(',').map((x) => x.trim()).filter(isFinishId);
  if (!finishIds.length) finishIds.push('clean');
  const finishes = new Map<FinishId, FinishPass>(finishIds.filter(isGpuFinish).map((id) => [id, new FinishPass(shared.noiseTex)]));
  const hand = new HandPass();
  // as on the stage, the hand-drawn finish goes over everything (windows, pop-ups and lyrics too):
  // the frame is put together here first, then drawn by hand
  const frameRT = makeRenderTarget(W, H);
  const fin: { tex: THREE.Texture | null; ctx: FinishContext | null } = { tex: null, ctx: null };
  const present = (id: FinishId) => {
    const { tex, ctx } = fin;
    if (!tex || !ctx) return;
    // as on the stage: a scene that needs more inks (handInks) gets them
    const inks = Math.max(HAND_DEFAULT.inks, def.handInks ?? 0) as typeof HAND_DEFAULT.inks;
    if (id === 'hand') hand.render(renderer, id === finishIds[0] ? frameRT.texture : tex, null, { style: { ...HAND_DEFAULT, inks }, palette, width: W, height: H, drawing: Math.floor(ctx.time * 12) });
    else if (!finishes.get(id)?.render(renderer, tex, null, id, ctx)) shared.blit(tex, null);
  };

  let inst: SceneInstance | null = null;
  let windows: SceneWindows | null = null;
  let popups: PopupLayer | null = null;
  let feel = new FeelTracker();
  let t = 0;
  let born = 0;
  let frameNo = 0;

  const start = (from: number) => {
    inst?.dispose();
    inst = def.create({ renderer, width: W, height: H, shared });
    windows?.dispose();
    windows = withWindows ? new SceneWindows() : null;
    popups?.dispose();
    popups = withPopups ? new PopupLayer() : null;
    t = born = from;
    feel = new FeelTracker();
    frameNo = 0;
  };

  const step = (dt: number) => {
    const prev = t;
    t += dt;
    testFrame(audio, t, prev);
    const sd = shared.spectrumTex.image.data as Float32Array;
    for (let i = 0; i < 128; i++) sd[i * 4] = audio.spectrum[i];
    shared.spectrumTex.needsUpdate = true;
    const wd = shared.waveformTex.image.data as Float32Array;
    for (let i = 0; i < 512; i++) wd[i * 4] = audio.waveform[i] * 0.5 + 0.5;
    shared.waveformTex.needsUpdate = true;

    const ctx: FrameContext = {
      renderer,
      time: t - born,
      dt,
      frame: frameNo++,
      width: W,
      height: H,
      aspect: W / H,
      audio,
      feel: feel.update(audio, analysis, dt),
      params: resolveParams(def.params, look.sceneParams, look.modulations, 'scene', audio.layers, sceneParams),
      palette,
      photos,
      shared,
      analysis,
      text: '',
    };
    renderer.setRenderTarget(sceneRT);
    renderer.setClearColor(palette.c.bg, 1);
    renderer.clear(true, true, false);
    try {
      inst!.render(ctx, sceneRT);
    } catch (e) {
      note(`render threw: ${e instanceof Error ? `${e.message}\n${(e.stack ?? '').split('\n').slice(1, 4).join('\n')}` : String(e)}`);
    }
    for (const c of chain) resolveParams(c.def.params, c.inst.params, look.modulations, `fx.${c.inst.instanceId}`, audio.layers, c.params);
    const tex = fx.run(renderer, sceneRT.texture, chain, { width: W, height: H, time: ctx.time, audio, feel: ctx.feel, palette });
    // finishes: every one steps its own state each frame; the first is drawn (the others when captured)
    fin.tex = tex;
    fin.ctx = { time: ctx.time, dt, audio, feel: ctx.feel, palette, width: W, height: H };
    for (const p of finishes.values()) p.advance(fin.ctx);
    // the same order as the stage: picture (and finish), windows, pop-ups, lyrics; hand-drawn over all of it
    const handOn = finishIds[0] === 'hand';
    const target = handOn ? frameRT : null;
    if (handOn) shared.blit(tex, frameRT);
    else present(finishIds[0]);
    const { params: _p, ...base } = ctx;
    void _p;
    const s = useStudio.getState();
    const levels = windowLevels(popsFixed ?? popLevelAt(audio.time), s.windowKind, def.category === 'board');
    const lyricOpts = { lines: s.lyrics?.lines ?? [], t, style: s.lyricStyle, palette, width: W, height: H, audio, dt };
    if (lyricLayer) lyricLayer.prepare(lyricOpts);
    const keep = q.get('dodge') === '0' ? undefined : lyricLayer?.keepOut();
    if (windows) windows.render(renderer, base, { level: levels.looks, mainPresetId: q.get('preset'), mainSceneId: def.id, target, keep });
    if (popups) popups.render(renderer, base, target, levels.instruments, keep);
    if (lyricLayer) {
      lyricLayer.setOccluders([...(windows?.occupied() ?? []), ...(popups?.occupied() ?? [])]);
      if (target) lyricLayer.sample(renderer, target.texture, shared.blit);
      else lyricLayer.sampleScreen(renderer, W, H);
      lyricLayer.render(renderer, lyricOpts, target);
    }
    if (handOn) present('hand');
  };

  const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;

  async function shots(o: ShotOptions) {
    const times = [...o.times].sort((a, b) => a - b);
    // several finishes: each time gets a cell per finish, side by side
    const nf = finishIds.length;
    const cells = times.length * nf;
    const cols = o.cols ?? (nf > 1 ? nf : Math.min(times.length, W >= H ? 3 : 6));
    const cw = o.cell ?? (W >= H ? 560 : 300);
    const ch = Math.round((cw * H) / W);
    const rows = Math.ceil(cells / cols);
    const sheet = document.createElement('canvas');
    sheet.width = cols * cw;
    sheet.height = rows * (ch + 22);
    const g = sheet.getContext('2d')!;
    g.fillStyle = '#111';
    g.fillRect(0, 0, sheet.width, sheet.height);
    g.font = '13px ui-monospace, Menlo, monospace';
    g.textBaseline = 'middle';

    start(o.from ?? 0);
    let n = 0;
    for (let i = 0; i < times.length; i++) {
      while (t < times[i] - 1e-6) {
        // far from the next picture, step in 30ths to get there sooner
        const left = times[i] - t;
        step(left > 1.5 ? 1 / 30 : Math.min(1 / 60, left));
        if (++n % 40 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      for (let k = 0; k < nf; k++) {
        const cell = i * nf + k;
        if (k > 0) present(finishIds[k]);
        const x = (cell % cols) * cw;
        const y = Math.floor(cell / cols) * (ch + 22);
        g.drawImage(canvas, 0, 0, W, H, x, y + 22, cw, ch);
        g.fillStyle = '#ddd';
        g.fillText(`${fmt(times[i])}  ${sectionAt(times[i]).label}${audio.kick > 0.6 ? '  kick' : ''}${audio.drop > 0.5 ? '  DROP' : ''}${nf > 1 || finishIds[0] !== 'clean' ? `  · ${finishIds[k]}` : ''}${lyricLayer?.legibilityNow() ? `  · ${lyricLayer.legibilityNow()!.backing}` : ''}`, x + 6, y + 11);
      }
      if (nf > 1) present(finishIds[0]);
    }

    // rough cost of one frame at this size: 60 frames, then wait for the GPU by reading a pixel back
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    const drain = () => {
      const s0 = performance.now();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return performance.now() - s0;
    };
    drain();
    const idle = drain();
    const t0 = performance.now();
    for (let i = 0; i < 60; i++) step(1 / 60);
    drain();
    const ms = Math.max(0, performance.now() - t0 - idle) / 60;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    // each finish alone: 120 draws of it over the last frame ('clean' is the plain copy it replaces)
    const finishMs: Record<string, number> = {};
    for (const id of ['clean', ...finishIds.filter((x) => x !== 'clean')] as FinishId[]) {
      present(id);
      drain();
      const f0 = performance.now();
      for (let i = 0; i < 120; i++) present(id);
      drain();
      finishMs[id] = Math.round((Math.max(0, performance.now() - f0 - idle) / 120) * 100) / 100;
    }
    return { sheet: sheet.toDataURL('image/png'), errors, ms: Math.round(ms * 10) / 10, gpu, finishMs };
  }

  return { shots, scene: def.id };
}

const booted = boot();
(window as unknown as Record<string, unknown>).__solo = {
  ready: booted.then(
    (b) => ({ ok: true, scene: b.scene, errors }),
    (e) => {
      note(`boot failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, errors };
    },
  ),
  shots: async (o: ShotOptions) => (await booted).shots(o),
};
