import * as THREE from 'three';
import { beginThings, noteWords } from '../arrange/things';
import { audioEngine } from '../audio/engine';
import { FeelTracker } from '../core/feel';
import { FULLSCREEN_VERT } from '../core/glsl';
import { createNoiseTexture } from '../core/noise';
import { resolvePalette } from '../core/palettes';
import { createFullscreenQuad, makeRenderTarget } from '../core/sceneHelpers';
import type { AudioFrame, EffectDef, EffectInstance, FrameContext, LayerId, Modulation, Palette, ParamValues, PhotoAsset, ResolvedPalette, SceneDef, SceneInstance, SharedResources } from '../core/types';
import { TRANSITIONS, type TransitionId } from '../core/transitionList';
import { transitionForNow, type ResolvedTransition } from '../state/transitionPick';
import { TransitionPass } from './transitions';
import { getEffect } from '../fx';
import { getScene } from '../scenes';
import { createPlaceholderPhoto } from '../scenes/photo/placeholder';
import { resolveParams } from '../state/modulation';
import { useStudio, type StudioState } from '../state/store';
import { autopilotTick } from '../state/autopilot';
import { findLook, planShots, planTick, popLevelAt, shotIndexAt, validPlan } from '../state/plan';
import { FxChain } from './fxChain';
import { DrawOverlay } from '../draw/overlay';
import { LyricLayer } from './lyricLayer';
import { NO_KEEP_OUT } from './legibility';
import { HandPass } from './handPass';
import { FinishPass } from './finishPass';
import { activeFinish, partWordsAt } from '../state/direction';
import { chosenPhotosAt } from '../state/partEdit';
import { PopupLayer, type DealtPop, type PopPart } from './popups';
import { SceneWindows, windowLevels } from './sceneWindows';
import { lineAt } from '../audio/lyrics';
import { takePush } from '../inside/reading';
import { live as liveState } from '../state/live';
import type { HandStyle } from '../core/types';
import { FULL, quality, type QualityRung } from './quality';
import { dryRun, warmEffects } from './warmup';
import { perfMonitor } from './perfMonitor';
import { maybeShowOverlay, maybeShowSoftwareNote } from './perfReport';

THREE.ColorManagement.enabled = false;

const BLIT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tMap;
void main(){ gl_FragColor = vec4(texture2D(tMap, vUv).rgb, 1.0); }`;

/**
 * The impact pass runs after every look's own effects, so every look hits: a punch on kicks, a split
 * on snares, a hit on the drop (zoom, shake, a brief inversion flash) and tension during build-ups
 * (a slow push-in while the edges close in). uAmt is the Impact amount (0..2).
 */
const IMPACT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tMap;
uniform float uKick, uSnare, uDrop, uBuild, uTime, uAmt, uAspect, uMost;
float h(float x){ return fract(sin(x * 91.17) * 43758.5453); }
void main(){
  float a = min(uAmt, 1.6);
  float hit = smoothstep(0.62, 1.0, uDrop);            // strongest in the first ~0.4 s of a drop
  vec2 c = vUv - 0.5;
  float zoom = min((0.028 * uKick + 0.07 * hit + 0.025 * uBuild) * a, uMost); // words in the picture stay in the frame
  float f = floor(uTime * 30.0);
  vec2 shake = (vec2(h(f), h(f + 7.31)) - 0.5) * (0.005 * uBuild + 0.012 * hit) * a;
  vec2 uv = c * (1.0 - zoom) + 0.5 + shake;
  vec2 dir = normalize(c + 1e-4) * (0.0018 * uSnare + 0.006 * hit) * a;
  vec3 col = vec3(texture2D(tMap, uv + dir).r, texture2D(tMap, uv).g, texture2D(tMap, uv - dir).b);
  col *= 1.0 + 0.1 * uKick * a;
  col = mix(col, 1.0 - col, smoothstep(0.86, 1.0, uDrop) * min(uAmt, 1.0) * 0.85);
  vec2 q = c * vec2(max(uAspect, 1.0), max(1.0 / uAspect, 1.0));
  col *= 1.0 - smoothstep(0.3, 0.85, length(q) * 1.25) * uBuild * 0.38 * a;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

/** layers the Impact amount shapes (time signals like beat phase and sway stay as they are) */
const SHAPED: (keyof AudioFrame & LayerId)[] = ['level', 'sub', 'bass', 'lowMid', 'mid', 'highMid', 'air', 'kick', 'snare', 'hat', 'energy', 'flux', 'build', 'drop'];

/** a look shown in the small hover preview window, rendered alongside the main stage */
export interface PeekLook {
  sceneId: string;
  sceneParams: ParamValues;
  effects: EffectInstance[];
  modulations: Modulation[];
  palette: Palette;
}

interface Live {
  id: string;
  def: SceneDef;
  inst: SceneInstance;
  born: number;
  params: ParamValues;
}

/** what a look is made of, kept so the outgoing look can keep playing during a transition */
interface LookSnap {
  sceneParams: ParamValues;
  effects: EffectInstance[];
  modulations: Modulation[];
  palette: Palette;
}

interface Running extends ResolvedTransition {
  start: number;
  /** extra progress from kicks (breathing transitions), and what it eases towards */
  boost: number;
  target: number;
  breathes: boolean;
  dir: [number, number];
  center: [number, number];
}

/**
 * One frame of a render (render/timeline.ts): the render's own clock and the song's sound at that
 * moment stand in for the wall clock and the live engine, so the same frame comes out every time.
 */
export interface OfflineTick {
  /** the render clock (ms); the scenes' time is (now − the clock's origin) / 1000 */
  now: number;
  /** seconds since the last frame */
  dt: number;
  /** what the song sounds like at this frame */
  audio: AudioFrame;
  /** called before each layer draws (scene, windows, pop-ups, lyrics), so a render can keep each layer's dice its own */
  phase?: (layer: 'scene' | 'windows' | 'popups' | 'lyrics') => void;
}

/** what the first half of a frame (Stage.advance) hands the second (Stage.draw) */
interface FrameStep {
  o: OfflineTick | undefined;
  now: number;
  dt: number;
  s: StudioState;
  finish: ReturnType<typeof activeFinish>;
  handOn: boolean;
  audio: AudioFrame;
  feel: FrameContext['feel'];
  time: number;
  /** a hand-drawn frame that re-shows the last drawing (no scene draws) */
  hold: boolean;
}

/** how long a render waits for one scene's prepare (real ms) before drawing the frame without it */
const PREPARE_TIMEOUT_MS = 4000;
/** the longest it waits for what a prepare asked to be held for (PrepareContext.hold) before doing the same */
const HOLD_TIMEOUT_MS = 180000;
/** how far ahead of a cut the next look starts compiling (see Stage.lookAhead) */
const LOOK_AHEAD_S = 7;

const BREATHES = new Set<TransitionId>(TRANSITIONS.filter((t) => t.breathes).map((t) => t.id));
const tmpColor = new THREE.Color();

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly shared: SharedResources;
  private sceneRT: THREE.WebGLRenderTarget;
  private prevRT: THREE.WebGLRenderTarget;
  private mixRT: THREE.WebGLRenderTarget;
  private fx: FxChain;
  private blitMat: THREE.ShaderMaterial;
  private blitQuad: ReturnType<typeof createFullscreenQuad>;
  private current: Live | null = null;
  /** the look being transitioned away from: still playing (live) or a frozen frame (live = null) */
  private out: { live: Live | null; look: LookSnap; pal: ResolvedPalette } | null = null;
  private tr: Running | null = null;
  private trPass = new TransitionPass();
  /** the outgoing look's effect chain (swapped with `fx` when a transition starts, so its trails carry on) */
  private fxOut: FxChain;
  private fxOutParams = new Map<string, ParamValues>();
  private stillRT: THREE.WebGLRenderTarget;
  /** the look on screen last frame */
  private seen: LookSnap | null = null;
  private seenPreset: string | null = null;
  /** set before a look change to choose its transition once (else it's picked from the setting and the music) */
  nextTransition: ResolvedTransition | null = null;
  private raf = 0;
  private last = performance.now();
  private t0 = performance.now();
  /** the clock of the frame being drawn (ms): the wall clock live, the render's clock in a render */
  private clockNow = performance.now();
  private frameNo = 0;
  private palette: ResolvedPalette;
  private placeholder: PhotoAsset | null = null;
  private fxParams = new Map<string, ParamValues>();
  private compilingScene = false;
  private snapshotResolvers: ((url: string) => void)[] = [];
  private impactRT: THREE.WebGLRenderTarget;
  private impactMat: THREE.ShaderMaterial;
  private impactQuad: ReturnType<typeof createFullscreenQuad>;
  private shaped = {} as AudioFrame;
  /** the song's emotional state and the shared world, the same for every look on this stage */
  private feel = new FeelTracker();
  private shapedLayers = {} as Record<LayerId, number>;
  /** the next section's scene, created and drawn once ahead of time so a cut lands without a compile stall */
  private warm: Live | null = null;
  private warmFresh = false;
  private lyricLayer = new LyricLayer();
  /** small drawings beside the sung words (only with drawings in the song) */
  private drawOverlay = new DrawOverlay();
  /** little board windows that pop in over the picture (after effects, under lyrics) */
  private popups = new PopupLayer();
  /** windows that play other looks live, under the instrument pop-ups */
  private sceneWindows = new SceneWindows();
  private peekLook: PeekLook | null = null;
  private peekOut: HTMLCanvasElement | null = null;
  private peekCss = { w: 256, h: 160 };
  private peekLive: Live | null = null;
  private peekRT: THREE.WebGLRenderTarget;
  private peekFx: FxChain;
  private peekFxParams = new Map<string, ParamValues>();
  private peekPalette: ResolvedPalette;
  /** hand-drawn finish: the last drawing is held here between new drawings */
  private hand = new HandPass();
  private holdRT: THREE.WebGLRenderTarget;
  private holdReady = false;
  private lastDrawing = -1;
  private drawingNo = 0;
  private prevHit = { kick: 0, snare: 0, drop: 0 };
  /** the video's finish (film, riso, ink wash, tape) over the finished picture; see present() */
  private finishPass: FinishPass;
  width = 2;
  height = 2;
  fps = 60;

  constructor(readonly canvas: HTMLCanvasElement) {
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.autoClear = true;
    this.renderer = renderer;
    // what this machine is, counted from here on (Video › More › Performance), and its remembered detail level
    perfMonitor.attach(renderer);
    maybeShowSoftwareNote();
    maybeShowOverlay();

    const spectrumTex = new THREE.DataTexture(new Float32Array(128 * 4), 128, 1, THREE.RGBAFormat, THREE.FloatType);
    spectrumTex.magFilter = spectrumTex.minFilter = THREE.LinearFilter;
    spectrumTex.needsUpdate = true;
    const waveformTex = new THREE.DataTexture(new Float32Array(512 * 4), 512, 1, THREE.RGBAFormat, THREE.FloatType);
    waveformTex.magFilter = waveformTex.minFilter = THREE.LinearFilter;
    waveformTex.needsUpdate = true;

    this.blitMat = new THREE.ShaderMaterial({
      uniforms: { tMap: { value: null } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BLIT_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.blitQuad = createFullscreenQuad(this.blitMat);
    this.impactMat = new THREE.ShaderMaterial({
      uniforms: {
        tMap: { value: null },
        uKick: { value: 0 },
        uSnare: { value: 0 },
        uDrop: { value: 0 },
        uBuild: { value: 0 },
        uTime: { value: 0 },
        uAmt: { value: 1 },
        uAspect: { value: 1 },
        uMost: { value: 1 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: IMPACT_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.impactQuad = createFullscreenQuad(this.impactMat);
    this.impactRT = makeRenderTarget(2, 2);
    this.holdRT = makeRenderTarget(2, 2);

    this.shared = {
      spectrumTex,
      waveformTex,
      noiseTex: createNoiseTexture(),
      blit: (texture, target) => {
        this.blitMat.uniforms.tMap.value = texture;
        this.blitQuad.render(this.renderer, target);
      },
    };
    this.finishPass = new FinishPass(this.shared.noiseTex);
    const sceneOpts = { depthBuffer: true, samples: 4 } as const;
    this.sceneRT = makeRenderTarget(2, 2, sceneOpts);
    this.prevRT = makeRenderTarget(2, 2, sceneOpts);
    this.mixRT = makeRenderTarget(2, 2);
    this.stillRT = makeRenderTarget(2, 2);
    this.fx = new FxChain(this.shared);
    this.fxOut = new FxChain(this.shared);
    this.palette = resolvePalette(useStudio.getState().palette);
    this.peekRT = makeRenderTarget(2, 2, sceneOpts);
    this.peekFx = new FxChain(this.shared);
    this.peekPalette = resolvePalette(useStudio.getState().palette);

    renderer.debug.onShaderError = (gl, program, vs, fs) => {
      const log = (s: WebGLShader) => gl.getShaderInfoLog(s) || '';
      const msg = (log(fs) || log(vs) || gl.getProgramInfoLog(program) || 'Shader failed to compile').trim();
      console.warn('[hum] shader error\n' + msg);
      const chain = this.fx.current ? this.fx : this.fxOut.current ? this.fxOut : null;
      if (chain?.current) {
        const id = chain.current;
        chain.failed.add(id);
        const inst = useStudio.getState().effects.find((e) => e.instanceId === id);
        useStudio.getState().flash(`Effect “${inst?.effectId ?? '?'}” failed to compile and was skipped`);
      } else if (this.compilingScene) {
        useStudio.getState().set({ shaderError: msg.slice(0, 1200) });
      }
    };
    // start at the governor's level for this machine (not full detail), so the first layout is already the right size
    this.applyRung();
  }

  private css = { w: 2, h: 2 };
  private outSize: { w: number; h: number } | null = null;

  /**
   * Render at exactly w×h pixels whatever the stage's size on screen (clip export), or null to go back
   * to following the screen. The canvas keeps its on-screen CSS size; only the drawing buffer changes.
   */
  setOutputSize(size: { w: number; h: number } | null) {
    this.outSize = size;
    this.width = 0;
    this.setSize(this.css.w, this.css.h);
  }

  setSize(cssW: number, cssH: number) {
    this.css = { w: cssW, h: cssH };
    let w: number;
    let h: number;
    if (this.outSize) {
      w = this.outSize.w;
      h = this.outSize.h;
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(w, h, false);
    } else {
      // the screen's own pixels (capped at devicePixelRatio 2, times the Render quality ceiling), then
      // the governor's pixel budget: a 4K monitor draws ~1080p by default and the browser scales it up
      const q = useStudio.getState().quality;
      const screenDpr = Math.min(window.devicePixelRatio || 1, 2) * q;
      const screenPx = cssW * screenDpr * cssH * screenDpr;
      quality.setScreen(screenPx);
      const dpr = screenPx > this.rung.maxPx ? screenDpr * Math.sqrt(this.rung.maxPx / screenPx) : screenDpr;
      this.renderer.setPixelRatio(dpr);
      this.renderer.setSize(cssW, cssH, false);
      w = Math.max(2, Math.round(cssW * dpr));
      h = Math.max(2, Math.round(cssH * dpr));
    }
    // quality governor: the main look (and maybe its effects) can draw smaller than the output
    const sw = Math.max(2, Math.round(w * this.rung.sceneScale));
    const sh = Math.max(2, Math.round(h * this.rung.sceneScale));
    const fw = this.rung.fxAtSceneScale ? sw : w;
    const fh = this.rung.fxAtSceneScale ? sh : h;
    if (w === this.width && h === this.height && sw === this.sceneW && sh === this.sceneH && fw === this.fxW && fh === this.fxH) return;
    this.width = w;
    this.height = h;
    // MSAA on the look's target: ×4 when it's small, ×2 around 1080p, none past that (the pixels are
    // small enough already, and on Direct3D the multisampled target and its resolve cost bandwidth on
    // every frame). A render at a fixed output size keeps ×4, so exports look as they always have.
    const px = sw * sh;
    const samples = this.outSize ? 4 : px <= 1.6e6 ? 4 : px <= 2.4e6 ? 2 : 0;
    if (samples !== this.sceneRT.samples) {
      for (const rt of [this.sceneRT, this.prevRT]) {
        rt.dispose();
        rt.samples = samples;
      }
    }
    this.sceneW = sw;
    this.sceneH = sh;
    this.fxW = fw;
    this.fxH = fh;
    this.sceneRT.setSize(sw, sh);
    this.prevRT.setSize(sw, sh);
    this.mixRT.setSize(w, h);
    this.stillRT.setSize(w, h);
    this.fxOut.setSize(fw, fh);
    this.impactRT.setSize(w, h);
    this.holdRT.setSize(w, h);
    this.holdReady = false;
    this.fx.setSize(fw, fh);
    this.current?.inst.resize?.(sw, sh);
    this.out?.live?.inst.resize?.(sw, sh);
    this.warm?.inst.resize?.(sw, sh);
  }

  /* ── quality governor (src/render/quality.ts) ── */
  private rung: QualityRung = FULL;
  private sceneW = 2;
  private sceneH = 2;
  private fxW = 2;
  private fxH = 2;
  private handLite: HandStyle | null = null;

  /** take the governor's rung for this frame (full detail while rendering at a fixed output size) */
  private applyRung() {
    const want = this.outSize && quality.forced === null ? FULL : quality.current();
    if (want === this.rung) return;
    const resize = want.maxPx !== this.rung.maxPx || want.sceneScale !== this.rung.sceneScale || want.fxAtSceneScale !== this.rung.fxAtSceneScale;
    this.rung = want;
    this.sceneWindows.cap = want.windows;
    this.sceneWindows.effects = want.windowFx;
    if (resize) this.setSize(this.css.w, this.css.h);
  }

  /** the hand-drawn style to draw with: the person's, or a lighter copy when the governor asks */
  private handStyle(chosen: HandStyle): HandStyle {
    // a scene that needs more inks to read (its key colour on a role the default 3 inks leave out) gets them
    const need = this.current?.def.handInks ?? 0;
    const style = chosen.inks > 0 && chosen.inks < need ? this.withInks(chosen, need as HandStyle['inks']) : chosen;
    if (!this.rung.handLite || style.misprint === 0) return style;
    if (this.handLite?.wobble !== style.wobble || this.handLite.inks !== style.inks || this.handLite.paper !== style.paper || this.handLite.lines !== style.lines) this.handLite = { ...style, misprint: 0 };
    return this.handLite;
  }

  private handInked: HandStyle | null = null;
  private withInks(style: HandStyle, inks: HandStyle['inks']): HandStyle {
    const h = this.handInked;
    if (!h || h.inks !== inks || h.wobble !== style.wobble || h.paper !== style.paper || h.lines !== style.lines || h.misprint !== style.misprint || h.fps !== style.fps) this.handInked = { ...style, inks };
    return this.handInked!;
  }

  start() {
    let lastRaf = -1;
    let lastDraw = -1e9;
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      if (lastRaf >= 0) quality.refreshSample(now - lastRaf);
      lastRaf = now;
      // a 120/144/240 Hz screen calls us that often: draw about 60 pictures a second (every 2nd, 3rd
      // or 4th refresh), not a full frame on every one. Drawn/Choppy frames still hold inside that.
      const every = quality.drawEvery;
      if (every > 1) {
        const ri = 1000 / quality.refreshHz;
        if (now - lastDraw < every * ri - ri / 2) {
          perfMonitor.skip();
          return;
        }
      }
      lastDraw = now;
      // only frames shown on screen teach the quality governor (not captures or offline renders)
      quality.sample(now);
      const t0 = performance.now();
      this.tick();
      perfMonitor.frame(now, performance.now() - t0);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /**
   * Start compiling the next shot's look LOOK_AHEAD_S before its cut (the song map itself asks 2.5 s
   * ahead). On Windows the browser translates every shader to Direct3D, and a big raymarching shader
   * can take seconds there; started this early, the background compile is done before the cut instead
   * of the cut frame waiting for the rest of it. Checked twice a second.
   */
  private lookAhead(audio: AudioFrame) {
    if (!audio.playing || this.frameNo % 30) return;
    const s = useStudio.getState();
    if (!s.planOn || !s.plan || !s.analysis || !validPlan(s.plan, s.analysis)) return;
    const shots = planShots(s.plan, s.analysis, s.pace, s.lyrics);
    const next = shots[shotIndexAt(shots, audio.time) + 1];
    if (!next || next.t - audio.time > LOOK_AHEAD_S) return;
    const nl = findLook(next.lookId);
    if (nl && nl.id !== s.presetId && this.warm?.id !== nl.sceneId) this.prewarm(nl.sceneId, nl.effects);
  }

  /** the look's render target size and MSAA (for the performance report) */
  sceneSize() {
    return { w: this.sceneW, h: this.sceneH, samples: this.sceneRT.samples };
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  /** resolves with a PNG data URL of the next rendered frame */
  snapshot(): Promise<string> {
    return new Promise((res) => this.snapshotResolvers.push(res));
  }

  /**
   * Show a look in a small window (`out`, sized cssW×cssH) without touching the main stage. Each frame
   * the look is drawn into a corner of the stage canvas, copied out, then covered by the main frame.
   */
  setPeek(look: PeekLook | null, out: HTMLCanvasElement | null, cssW = 256, cssH = 160) {
    this.peekLook = look;
    this.peekOut = look ? out : null;
    this.peekCss = { w: cssW, h: cssH };
  }

  private renderPeek(base: Omit<FrameContext, 'params'>, impact: number, now: number) {
    const look = this.peekLook;
    const out = this.peekOut;
    if (!look || !out) return;
    const r = this.renderer;
    const pr = r.getPixelRatio();
    const cw = Math.min(this.peekCss.w, this.width / pr);
    const ch = Math.min(this.peekCss.h, this.height / pr);
    const w = Math.max(2, Math.round(cw * pr));
    const h = Math.max(2, Math.round(ch * pr));
    if (this.peekRT.width !== w || this.peekRT.height !== h) {
      this.peekRT.setSize(w, h);
      this.peekLive?.inst.resize?.(w, h);
    }
    this.peekFx.setSize(w, h);

    if (this.peekLive?.id !== look.sceneId) {
      const def = getScene(look.sceneId);
      if (!def) return;
      this.peekLive?.inst.dispose();
      this.peekLive = null;
      try {
        this.peekLive = { id: look.sceneId, def, inst: def.create({ renderer: r, width: w, height: h, shared: this.shared }), born: now, params: {} };
      } catch (e) {
        console.warn('[hum] preview failed', e);
        return;
      }
    }
    const pl = this.peekLive;
    resolvePalette(look.palette, this.peekPalette);
    const ctx = { ...base, width: w, height: h, aspect: w / h, palette: this.peekPalette };
    const params = resolveParams(pl.def.params, look.sceneParams, look.modulations, 'scene', base.audio.layers, pl.params);
    r.setRenderTarget(this.peekRT);
    r.setClearColor(this.peekPalette.c.bg, 1);
    r.clear(true, true, false);
    try {
      pl.inst.render({ ...ctx, params }, this.peekRT);
    } catch (e) {
      console.warn(e);
    }

    const chain: { inst: EffectInstance; def: EffectDef; params: ParamValues }[] = [];
    const ids = new Set<string>();
    for (const inst of look.effects) {
      ids.add(inst.instanceId);
      const def = getEffect(inst.effectId);
      if (!def) continue;
      let p = this.peekFxParams.get(inst.instanceId);
      if (!p) this.peekFxParams.set(inst.instanceId, (p = {}));
      resolveParams(def.params, inst.params, look.modulations, `fx.${inst.instanceId}`, base.audio.layers, p);
      chain.push({ inst, def, params: p });
    }
    this.peekFx.prune(ids);
    for (const k of this.peekFxParams.keys()) if (!ids.has(k)) this.peekFxParams.delete(k);
    const tex = this.peekFx.run(r, this.peekRT.texture, chain, { width: w, height: h, time: base.time, audio: base.audio, palette: this.peekPalette });

    // draw into the bottom-left corner of the canvas, then copy that region out
    const size = r.getSize(new THREE.Vector2());
    r.setViewport(0, 0, w / pr, h / pr);
    if (impact > 0.001) {
      this.setImpactUniforms(tex, base.audio, base.time, impact, w / h);
      this.impactQuad.render(r, null);
    } else {
      this.shared.blit(tex, null);
    }
    r.setViewport(0, 0, size.x, size.y);
    if (out.width !== w || out.height !== h) {
      out.width = w;
      out.height = h;
    }
    out.getContext('2d')?.drawImage(this.canvas, 0, this.canvas.height - h, w, h, 0, 0, w, h);
  }

  private setImpactUniforms(tex: THREE.Texture, audio: AudioFrame, time: number, amt: number, aspect: number) {
    const u = this.impactMat.uniforms;
    u.tMap.value = tex;
    u.uKick.value = audio.kick;
    u.uSnare.value = audio.snare;
    u.uDrop.value = audio.drop;
    u.uBuild.value = audio.build;
    u.uTime.value = time;
    u.uAmt.value = amt;
    u.uAspect.value = aspect;
    u.uMost.value = Math.max(0, 1 - 1 / takePush());
  }

  /**
   * Render a frame now and copy it, centre-cropped, into a small 2D canvas. Synchronous, so it works
   * without preserveDrawingBuffer (and without image decoding, which stalls in hidden tabs).
   */
  capture(w: number, h: number): HTMLCanvasElement {
    this.tick();
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const src = this.canvas;
    const s = Math.min(src.width / w, src.height / h);
    c.getContext('2d')!.drawImage(src, (src.width - w * s) / 2, (src.height - h * s) / 2, w * s, h * s, 0, 0, w, h);
    return c;
  }

  /**
   * Create a scene now (buffers allocate, shaders compile in the background, see warmup.ts) so
   * switching to it later is instant. `effects`: the look's effects, compiled ahead too.
   */
  prewarm(id: string, effects: readonly { effectId: string }[] = []) {
    this.prewarmEffects(effects);
    if (this.warm?.id === id || this.width <= 2) return;
    const def = getScene(id);
    if (!def) return;
    this.warm?.inst.dispose();
    this.warm = null;
    try {
      this.warm = { id, def, inst: perfMonitor.during(`${id} (ahead)`, () => def.create({ renderer: this.renderer, width: this.sceneW, height: this.sceneH, shared: this.shared })), born: this.clockNow, params: {} };
      this.warmFresh = true;
    } catch (e) {
      console.warn('[hum] prewarm failed', e);
    }
  }

  private fxWarm: { key: string; dispose: () => void } | null = null;

  /** compile the next look's effects in the background (kept until the next look's are warmed) */
  private prewarmEffects(effects: readonly { effectId: string }[]) {
    const defs = effects.map((e) => getEffect(e.effectId)).filter((d): d is EffectDef => !!d);
    const key = defs.map((d) => d.id).join(',');
    if (this.fxWarm?.key === key) return;
    this.fxWarm?.dispose();
    this.fxWarm = defs.length ? { key, dispose: perfMonitor.during(`effects ${key} (ahead)`, () => warmEffects(this.renderer, this.shared, defs, this.mixRT)).dispose } : null;
  }

  /** a new instance of scene `id` (the prewarmed one when it matches) */
  private makeLive(id: string, now: number): Live | null {
    const def = getScene(id);
    if (!def) return null;
    let inst: SceneInstance;
    try {
      if (this.warm?.id === id) {
        inst = this.warm.inst;
        this.warm = null;
      } else inst = def.create({ renderer: this.renderer, width: this.sceneW, height: this.sceneH, shared: this.shared });
    } catch (e) {
      console.error(e);
      useStudio.getState().set({ shaderError: String(e) });
      return null;
    }
    return { id, def, inst, born: now, params: {} };
  }

  /**
   * Notice a look change and start its transition. The outgoing look keeps playing with its own
   * params, palette and effects while the transition pass blends it into the new one; a look on the
   * same scene gets a fresh instance so both can play at once. A change in the middle of a
   * transition freezes what is on screen and transitions from that.
   */
  private syncLook(s: StudioState, audio: AudioFrame, now: number) {
    const cur = this.current;
    const want = this.nextTransition;
    this.nextTransition = null; // only for a change made this frame
    if (!cur) {
      this.current = this.makeLive(s.sceneId, now);
      this.seenPreset = s.presetId;
      return;
    }
    if (s.sceneId === cur.id && s.presetId === this.seenPreset) return;
    if (!getScene(s.sceneId)) return;
    this.seenPreset = s.presetId;
    const tr = want ?? transitionForNow('manual', audio.playing ? audio.time : null);
    const was = this.seen;
    if (tr.id === 'cut' || tr.ms <= 1 || !was) {
      this.endTransition();
      if (s.sceneId !== cur.id) {
        const next = this.makeLive(s.sceneId, now);
        if (!next) return;
        cur.inst.dispose();
        this.current = next;
      }
      return;
    }
    if (this.tr) {
      // already mid-transition: freeze what is on screen as the outgoing picture
      this.shared.blit(this.mixRT.texture, this.stillRT);
      this.endTransition();
      if (s.sceneId !== cur.id) {
        const next = this.makeLive(s.sceneId, now);
        if (!next) return;
        cur.inst.dispose();
        this.current = next;
      }
      this.out = { live: null, look: was, pal: resolvePalette(was.palette) };
    } else {
      const next = this.makeLive(s.sceneId, now);
      if (!next) return;
      this.out = { live: cur, look: was, pal: resolvePalette(was.palette) };
      // the outgoing effects keep their chain (and its trails); the new look gets the spare one
      [this.fx, this.fxOut] = [this.fxOut, this.fx];
      [this.fxParams, this.fxOutParams] = [this.fxOutParams, this.fxParams];
      this.current = next;
    }
    const r = (k: number) => {
      const x = Math.sin(tr.seed * 12.9898 + k * 78.233) * 43758.5453;
      return x - Math.floor(x);
    };
    const ang = Math.floor(r(1) * 8) * (Math.PI / 4);
    this.tr = {
      ...tr,
      start: now,
      boost: 0,
      target: 0,
      breathes: BREATHES.has(tr.id),
      dir: [Math.cos(ang), Math.sin(ang)],
      center: [0.5 + (r(2) - 0.5) * 0.3, 0.5 + (r(3) - 0.5) * 0.3],
    };
  }

  private endTransition() {
    if (this.out?.live && this.out.live !== this.current) this.out.live.inst.dispose();
    this.out = null;
    this.tr = null;
    this.fxOut.prune(new Set());
    this.fxOutParams.clear();
  }

  /** Start the render clock at `originMs` (scene time 0), for a stage that a render drives. */
  resetClock(originMs: number) {
    this.t0 = this.last = this.clockNow = originMs;
    this.frameNo = 0;
  }

  /** Draw one frame of a render at the render's time with the song's sound then (no wall clock, no live engine). */
  renderFrame(o: OfflineTick) {
    this.tick(o);
  }

  /** Let the song's Feel (tension, afterglow, wind) catch up through a stretch that isn't drawn: a render's run-up. */
  primeFeel(audio: AudioFrame, dt: number) {
    this.feel.update(audio, useStudio.getState().analysis, dt);
  }

  /**
   * A render's frame in three steps, so a scene can get ready between the look change and the draw:
   * beginFrame (sequencers run and any cut or transition lands, nothing is drawn), then
   * `await prepareFrame(songTime)` outside the render's fake clock, then finishFrame (the draw).
   * The result is the same frame renderFrame draws; renderFrame stays for callers that don't prepare.
   */
  beginFrame(o: OfflineTick) {
    this.pendingStep = this.advance(o);
  }

  /** Draw the frame beginFrame started. `phase` replaces the tick's own (the dice may live in a new world by now). */
  finishFrame(phase?: OfflineTick['phase']) {
    const f = this.pendingStep;
    this.pendingStep = null;
    if (!f) return;
    if (phase && f.o) f.o = { ...f.o, phase };
    this.draw(f);
  }

  /**
   * Let every scene that will draw this frame get ready for song time `songTime` (a video seeking to
   * its exact frame), and wait for them. Call it after beginFrame, so a scene cut to on this frame is
   * already live and gets prepared too. Scenes without `prepare` cost nothing. Who gets prepared:
   * the current look and, while a transition is still running, the outgoing one. Not the prewarmed
   * next look (its warm-up draw renders nothing), not the hover preview (never set on a render's
   * stage), and not the scene windows' looks (SceneWindows owns those and opens them mid-draw).
   */
  async prepareFrame(songTime: number): Promise<void> {
    const f = this.pendingStep;
    // a held hand-drawn frame re-shows the last drawing without drawing any scene
    if (f?.hold) return;
    const lives = new Set<Live>();
    if (this.current) lives.add(this.current);
    const tr = this.tr;
    const outLive = this.out?.live;
    // runTransition ends a transition whose time is up before drawing the outgoing look
    if (tr && outLive && (this.clockNow - tr.start) / tr.ms < 1) lives.add(outLive);
    const waits: Promise<void>[] = [];
    for (const l of lives) if (l.inst.prepare) waits.push(this.prepareOne(l, songTime));
    if (waits.length) await Promise.all(waits);
  }

  private pendingStep: FrameStep | null = null;
  /** told when a prepare begins and ends a wait the frame is held for (a render's progress) */
  onHold: ((on: boolean) => void) | null = null;
  private prepState = new WeakMap<SceneInstance, { pending: boolean; warned: boolean }>();

  /**
   * One scene's prepare, made safe: an error is logged once and the frame draws anyway, and a
   * prepare that takes longer than PREPARE_TIMEOUT_MS (real time, not counting what it asked the frame
   * to be held for) is given up on for this frame.
   * While one is still stuck we don't call it again, so a hung scene costs one wait, not one per frame.
   */
  private async prepareOne(live: Live, songTime: number): Promise<void> {
    const inst = live.inst;
    let st = this.prepState.get(inst);
    if (!st) this.prepState.set(inst, (st = { pending: false, warned: false }));
    if (st.pending) return;
    const state = st;
    const warn = (why: string, e?: unknown) => {
      if (state.warned) return;
      state.warned = true;
      console.warn(`[hum] scene “${live.id}” ${why}; drawing the frame anyway`, e ?? '');
    };
    state.pending = true;
    // a prepare that throws straight away becomes a rejection here
    // what render() is about to get: a look cut to on this frame has not drawn yet, so it can't know
    const st0 = useStudio.getState();
    if (!this.placeholder) this.placeholder = createPlaceholderPhoto();
    const frame = {
      params: live === this.current ? st0.sceneParams : (this.out?.look.sceneParams ?? live.params),
      analysis: st0.analysis,
      // the photos the person chose for the part playing (or the look on its own), else all of them
      photos: chosenPhotosAt(st0, songTime) ?? (st0.photos.length ? st0.photos : [this.placeholder]),
      hold: async (p: Promise<unknown>) => {
        clearTimeout(timer);
        if (!over) arm(HOLD_TIMEOUT_MS);
        this.onHold?.(true);
        try {
          await p;
        } finally {
          this.onHold?.(false);
          clearTimeout(timer);
          if (!over) arm(PREPARE_TIMEOUT_MS);
        }
      },
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let over = false;
    let giveUp = () => {};
    const arm = (ms: number) => {
      timer = setTimeout(() => {
        warn(`took over ${ms / 1000} s to get ready`);
        giveUp();
      }, ms);
    };
    const timeout = new Promise<void>((res) => (giveUp = res));
    arm(PREPARE_TIMEOUT_MS);
    const run = new Promise<void>((res) => res(inst.prepare!(songTime, frame))).then(
      () => {
        state.pending = false;
      },
      (e: unknown) => {
        state.pending = false;
        warn('failed to get ready', e);
      },
    );
    try {
      await Promise.race([run, timeout]);
    } finally {
      over = true;
      clearTimeout(timer);
    }
  }

  private tick(o?: OfflineTick) {
    const f = this.advance(o);
    if (f) this.draw(f);
  }

  /**
   * The first half of a frame: clocks, sound, the sequencers, Feel, and the look change (a cut makes
   * the new scene here). Draws nothing except the shared audio textures. Null when nothing will draw.
   */
  private advance(o?: OfflineTick): FrameStep | null {
    const now = o ? o.now : performance.now();
    const dt = o ? o.dt : Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.clockNow = now;
    this.fps = this.fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;
    this.frameNo++;
    if (!o) audioEngine.sensitivity = useStudio.getState().sensitivity;
    const raw = o ? o.audio : audioEngine.update(dt);
    autopilotTick(raw);
    planTick(raw);
    if (!o) this.lookAhead(raw);
    // read the state after the sequencers, so a look they switch to (and its transition) lands this frame
    const s = useStudio.getState();
    // the finish follows the part being drawn (a part can be set hand-drawn or not on its own)
    const finish = activeFinish(s, raw.time);
    const handOn = finish === 'hand';
    const audio = this.shape(raw, s.impact);
    const feel = this.feel.update(raw, s.analysis, dt);

    // shared audio textures
    const sd = this.shared.spectrumTex.image.data as Float32Array;
    for (let i = 0; i < 128; i++) sd[i * 4] = audio.spectrum[i];
    this.shared.spectrumTex.needsUpdate = true;
    const wd = this.shared.waveformTex.image.data as Float32Array;
    for (let i = 0; i < 512; i++) wd[i * 4] = audio.waveform[i] * 0.5 + 0.5;
    this.shared.waveformTex.needsUpdate = true;

    resolvePalette(s.palette, this.palette);
    if (!s.sceneId || this.width <= 2) return null; // wait for the first real layout size
    this.applyRung();
    this.syncLook(s, audio, now);
    this.seen = { sceneParams: s.sceneParams, effects: s.effects, modulations: s.modulations, palette: s.palette };
    if (!this.current) return null;
    const time = (now - this.t0) / 1000;

    // Drawn and Choppy frames, under any finish: a new picture only every 1/fps s (held in between,
    // like animation on 2s or 3s), except that a kick, snare or drop always gets a fresh one so hits
    // land on time.
    const hit = this.hitEdge(audio);
    const hold = s.hand.fps < 60 && this.holdReady && time - this.lastDrawing < 1 / s.hand.fps - 0.004 && !hit;
    return { o, now, dt, s, finish, handOn, audio, feel, time, hold };
  }

  /** the pop-ups and look windows of the part playing as they come up now (Arrange changes them by hand) */
  dealtPops(): { part: PopPart; pops: DealtPop[] } | null {
    const p = this.popups.dealt();
    const w = this.sceneWindows.dealt();
    if (!p || !w || Math.abs(p.part.start - w.part.start) > 1e-3) return null;
    return { part: p.part, pops: [...p.pops, ...w.pops].sort((a, b) => a.from - b.from) };
  }

  /** The second half of a frame: draw everything for the step advance() made. */
  private draw(f: FrameStep) {
    const { o, now, dt, s, finish, handOn, audio, feel, time } = f;
    if (!this.current) return;
    if (f.hold) {
      this.shared.blit(this.holdRT.texture, null);
      this.resolveSnapshots();
      return;
    }
    this.lastDrawing = time;
    if (!o) beginThings();
    if (!handOn && s.hand.fps >= 60) this.holdReady = false;

    // (what a window or a warm-up noted since the last frame isn't this picture's)
    takePush();
    if (!this.placeholder) this.placeholder = createPlaceholderPhoto();
    // the photos the person chose for the part playing (or the look on its own), in their order: one
    // keeps the look on it, several rotate among just those; nothing chosen, every photo as before
    const photos = chosenPhotosAt(s, audio.time) ?? (s.photos.length ? s.photos : [this.placeholder]);
    const base: Omit<FrameContext, 'params'> = {
      renderer: this.renderer,
      time,
      dt,
      frame: this.frameNo,
      width: this.width,
      height: this.height,
      aspect: this.width / this.height,
      audio,
      feel,
      palette: this.palette,
      photos,
      shared: this.shared,
      analysis: s.analysis,
      // scenes that show text (the boards) get the part's own words, else the typed text, else the line being sung
      text: partWordsAt(s, audio.time) || s.text || (s.lyrics?.synced ? (lineAt(s.lyrics.lines, audio.time)?.line.text ?? '') : ''),
    };

    const r = this.renderer;
    const drawScene = (live: Live, target: THREE.WebGLRenderTarget, params: ParamValues, palette = this.palette) => {
      r.setRenderTarget(target);
      r.setClearColor(palette.c.bg, 1);
      r.clear(true, true, false);
      this.compilingScene = live === this.current;
      try {
        live.inst.render({ ...base, width: this.sceneW, height: this.sceneH, palette, params }, target);
      } catch (e) {
        console.error(e);
      }
      this.compilingScene = false;
    };

    // compile a prewarmed scene's shaders in the background before its cut: it goes through one
    // render that draws nothing (warmup.ts), so this frame doesn't wait for the compile either
    if (this.warm && this.warmFresh) {
      this.warmFresh = false;
      const warm = this.warm;
      const defaults: ParamValues = {};
      for (const d of warm.def.params) defaults[d.id] = d.default;
      r.setRenderTarget(this.prevRT);
      void perfMonitor.during(`${warm.id} (ahead)`, () => dryRun(r, () => warm.inst.render({ ...base, width: this.sceneW, height: this.sceneH, params: defaults }, this.prevRT)));
    }

    o?.phase?.('scene');
    const curParams = resolveParams(this.current.def.params, s.sceneParams, s.modulations, 'scene', audio.layers, this.current.params);
    liveState.scene = curParams;
    liveState.fx = this.fxParams;
    if (s.shaderError && this.current.def.category === 'code') {
      r.setRenderTarget(this.sceneRT);
      r.setClearColor(this.palette.c.bg, 1);
      r.clear();
    } else {
      drawScene(this.current, this.sceneRT, curParams);
    }

    // effects
    const live: { inst: EffectInstance; def: EffectDef; params: ParamValues }[] = [];
    const ids = new Set<string>();
    for (const inst of s.effects) {
      ids.add(inst.instanceId);
      const def = getEffect(inst.effectId);
      if (!def) continue;
      let out = this.fxParams.get(inst.instanceId);
      if (!out) this.fxParams.set(inst.instanceId, (out = {}));
      resolveParams(def.params, inst.params, s.modulations, `fx.${inst.instanceId}`, audio.layers, out);
      live.push({ inst, def, params: out });
    }
    this.fx.prune(ids);
    let finalTex = this.fx.run(r, this.sceneRT.texture, live, { width: this.fxW, height: this.fxH, time, audio, feel, palette: this.palette });
    finalTex = this.runTransition(finalTex, base, audio, time, dt, now);
    // the hover preview borrows a corner of the canvas before the main frame covers it
    this.renderPeek(base, s.impact, now);

    // how busy each kind of pop-up window is right now, split by the "Windows show" setting
    // (none over the footage looks: their graphics are bare shapes in the picture, and windows would bury the clips)
    // Each part's windows are dealt from its own level (the same every time it plays); what's on screen now
    // only limits how many of them show: none over footage, drawings or a look that is its own words (they
    // would land on its text), the odd one over a board look
    const kind = s.windowKind;
    const board = this.current.def.category === 'board';
    const clips = !!this.current.def.usesClips || !!this.current.def.usesDrawings || !!this.current.def.usesFigures;
    const wordy = !board && !!this.current.def.showsLyrics;
    const pops = {
      instruments: (t: number) => windowLevels(popLevelAt(t), kind, false).instruments,
      looks: (t: number) => windowLevels(popLevelAt(t), kind, false).looks,
      showInstruments: clips || wordy ? 0 : board ? 1 : 4,
      showLooks: clips || wordy ? 0 : board ? 1 : 3,
    };
    const winOpts = { level: pops.looks, show: pops.showLooks, mainPresetId: s.presetId, mainSceneId: s.sceneId };
    const showLyrics = !!s.lyrics?.synced && s.lyricStyle !== 'off';
    const lyricOpts = showLyrics ? { lines: s.lyrics!.lines, t: audio.time, style: s.lyricStyle, palette: s.palette, width: this.width, height: this.height, audio, finish } : null;
    // the line is laid out first, so the windows and pop-ups know where the words go and keep clear
    if (lyricOpts) this.lyricLayer.prepare(lyricOpts);
    const keep = this.drawOverlay.prepare(s, audio.time, this.width, this.height, lyricOpts ? this.lyricLayer.keepOut() : NO_KEEP_OUT);
    if (lyricOpts && keep.now) noteWords(this.lyricLayer.keepOut().now ?? keep.now);
    // after they draw: where they are (words on one get the halo), and the legibility guard reads
    // what the words will really sit on, windows and pop-ups included (a tiny readback every other frame)
    const beforeLyrics = (rt: THREE.WebGLRenderTarget | null) => {
      if (!lyricOpts) return;
      this.lyricLayer.setOccluders([...this.sceneWindows.occupied(), ...this.popups.occupied()]);
      if (rt) this.lyricLayer.sample(r, rt.texture, this.shared.blit);
      else this.lyricLayer.sampleScreen(r, this.width, this.height);
    };
    if (handOn) {
      // everything (lyrics too) goes through the hand-drawn finish, then is held until the next drawing
      if (s.impact > 0.001) {
        this.setImpactUniforms(finalTex, audio, time, s.impact, this.width / this.height);
        this.impactQuad.render(r, this.impactRT);
      } else {
        this.shared.blit(finalTex, this.impactRT);
      }
      o?.phase?.('windows');
      this.sceneWindows.render(r, base, { ...winOpts, target: this.impactRT, keep });
      o?.phase?.('popups');
      this.popups.render(r, base, this.impactRT, pops.instruments, keep, pops.showInstruments);
      beforeLyrics(this.impactRT);
      o?.phase?.('lyrics');
      this.drawOverlay.render(r, this.impactRT);
      if (lyricOpts) this.lyricLayer.render(r, lyricOpts, this.impactRT);
      // smooth: every frame is drawn, but the lines and paper re-draw on a 12-a-second clock
      const drawing = s.hand.fps >= 60 ? Math.floor(time * 12) : this.drawingNo++;
      this.hand.render(r, this.impactRT.texture, this.holdRT, { style: this.handStyle(s.hand), palette: this.palette, width: this.width, height: this.height, drawing });
      this.holdReady = true;
      this.shared.blit(this.holdRT.texture, null);
    } else if (lyricOpts && this.lyricLayer.underFinish(lyricOpts)) {
      // a type kit's lettering (render/typeKits) goes in BEFORE the finish, so the finish's grain,
      // bleed and wear work on the words too; windows and pop-ups still go over the finished frame.
      // The guard reads the picture without this frame's windows (it has last frame's boxes).
      const held = s.hand.fps < 60 ? this.holdRT : null;
      if (s.impact > 0.001) {
        this.setImpactUniforms(finalTex, audio, time, s.impact, this.width / this.height);
        this.impactQuad.render(r, this.impactRT);
      } else {
        this.shared.blit(finalTex, this.impactRT);
      }
      beforeLyrics(this.impactRT);
      o?.phase?.('lyrics');
      this.drawOverlay.render(r, this.impactRT);
      this.lyricLayer.render(r, lyricOpts, this.impactRT);
      this.present(this.impactRT.texture, finish, base, held);
      o?.phase?.('windows');
      this.sceneWindows.render(r, base, held ? { ...winOpts, target: held, keep } : { ...winOpts, keep });
      o?.phase?.('popups');
      this.popups.render(r, base, held, pops.instruments, keep, pops.showInstruments);
      if (held) {
        this.holdReady = true;
        this.shared.blit(held.texture, null);
      }
    } else {
      // with Drawn or Choppy frames the whole finished picture (windows, pop-ups and lyrics too) is
      // put together in the held frame, and the screen shows that until the next drawing is due
      const held = s.hand.fps < 60 ? this.holdRT : null;
      if (s.impact > 0.001) {
        this.setImpactUniforms(finalTex, audio, time, s.impact, this.width / this.height);
        this.impactQuad.render(r, this.impactRT);
        this.present(this.impactRT.texture, finish, base, held);
      } else {
        this.present(finalTex, finish, base, held);
      }
      o?.phase?.('windows');
      this.sceneWindows.render(r, base, held ? { ...winOpts, target: held, keep } : { ...winOpts, keep });
      o?.phase?.('popups');
      this.popups.render(r, base, held, pops.instruments, keep, pops.showInstruments);
      beforeLyrics(held);
      o?.phase?.('lyrics');
      this.drawOverlay.render(r, held);
      if (lyricOpts) this.lyricLayer.render(r, lyricOpts, held ?? undefined);
      if (held) {
        this.holdReady = true;
        this.shared.blit(held.texture, null);
      }
    }
    this.resolveSnapshots();
  }

  /**
   * Finish hook (Direction): put the finished picture on screen through the video's finish, or as it
   * is for Clean. Pop-ups, scene windows and lyrics go over it afterwards. The finish reads time,
   * audio and Feel from the frame context only.
   */
  private present(tex: THREE.Texture, finish: ReturnType<typeof activeFinish>, base: Omit<FrameContext, 'params'>, target: THREE.WebGLRenderTarget | null = null) {
    const drawn = this.finishPass.render(this.renderer, tex, target, finish, { time: base.time, dt: base.dt, audio: base.audio, feel: base.feel, palette: base.palette, width: base.width, height: base.height });
    if (!drawn) this.shared.blit(tex, target);
  }

  /** blend the outgoing look into `inTex` while a transition runs; returns what goes on screen */
  private runTransition(inTex: THREE.Texture, base: Omit<FrameContext, 'params'>, audio: AudioFrame, time: number, dt: number, now: number): THREE.Texture {
    const tr = this.tr;
    const out = this.out;
    if (!tr || !out) return inTex;
    const lin = Math.min(1, Math.max(0, (now - tr.start) / tr.ms));
    // breathing transitions take a small step forward on each kick; the clock still ends them on time
    if (tr.breathes && audio.playing && audio.kickHit) tr.target = Math.min(0.45, tr.target + 0.06 + 0.08 * audio.kick);
    tr.boost += (tr.target - tr.boost) * Math.min(1, dt * 12);
    const p = lin + tr.boost * (1 - lin);
    if (lin >= 1) {
      this.endTransition();
      return inTex;
    }
    const r = this.renderer;
    let outTex: THREE.Texture = this.stillRT.texture;
    if (out.live) {
      const look = out.look;
      const params = resolveParams(out.live.def.params, look.sceneParams, look.modulations, 'scene', audio.layers, out.live.params);
      r.setRenderTarget(this.prevRT);
      r.setClearColor(out.pal.c.bg, 1);
      r.clear(true, true, false);
      try {
        out.live.inst.render({ ...base, width: this.sceneW, height: this.sceneH, palette: out.pal, params }, this.prevRT);
      } catch (e) {
        console.error(e);
      }
      const chain: { inst: EffectInstance; def: EffectDef; params: ParamValues }[] = [];
      for (const inst of look.effects) {
        const def = getEffect(inst.effectId);
        if (!def) continue;
        let o = this.fxOutParams.get(inst.instanceId);
        if (!o) this.fxOutParams.set(inst.instanceId, (o = {}));
        resolveParams(def.params, inst.params, look.modulations, `fx.${inst.instanceId}`, audio.layers, o);
        chain.push({ inst, def, params: o });
      }
      outTex = this.fxOut.run(r, this.prevRT.texture, chain, { width: this.fxW, height: this.fxH, time, audio, palette: out.pal });
    }
    const t = Math.min(1, Math.max(0, (p - 0.3) / 0.4));
    this.trPass.render(r, tr.id, outTex, inTex, this.mixRT, {
      p,
      seed: tr.seed % 97,
      time,
      kick: audio.kick,
      bass: audio.bass,
      aspect: this.width / this.height,
      width: this.width,
      height: this.height,
      dir: tr.dir,
      center: tr.center,
      bg: tmpColor.copy(out.pal.c.bg).lerp(this.palette.c.bg, t * t * (3 - 2 * t)),
      accent: this.palette.c.accent,
    });
    return this.mixRT.texture;
  }

  /** the transition running now (for tests and the UI), or null */
  get transition(): { id: TransitionId; p: number; ms: number } | null {
    const tr = this.tr;
    if (!tr) return null;
    const lin = Math.min(1, (this.clockNow - tr.start) / tr.ms);
    return { id: tr.id, p: lin + tr.boost * (1 - lin), ms: tr.ms };
  }

  private resolveSnapshots() {
    if (!this.snapshotResolvers.length) return;
    const url = this.canvas.toDataURL('image/png');
    this.snapshotResolvers.splice(0).forEach((f) => f(url));
  }

  /** true on the frame a kick, snare or drop starts (the rising edge of its envelope) */
  private hitEdge(a: AudioFrame): boolean {
    const p = this.prevHit;
    const hit = (a.kick > 0.7 && p.kick <= 0.55) || (a.snare > 0.7 && p.snare <= 0.55) || (a.drop > 0.9 && p.drop <= 0.8);
    p.kick = a.kick;
    p.snare = a.snare;
    p.drop = a.drop;
    return hit;
  }

  /** Impact shaping: v → 1 − (1 − v)^k keeps 0..1, lifts and lengthens hits for k > 1, softens them for k < 1, k = 0 is still. */
  private shape(a: AudioFrame, k: number): AudioFrame {
    const o = Object.assign(this.shaped, a);
    o.layers = Object.assign(this.shapedLayers, a.layers);
    if (Math.abs(k - 1) < 1e-3) return o;
    for (const key of SHAPED) {
      const v = Math.min(1, Math.max(0, a[key] as number));
      const s = k <= 0.001 ? 0 : 1 - Math.pow(1 - v, k);
      (o as unknown as Record<string, number>)[key] = s;
      o.layers[key] = s;
    }
    return o;
  }

  dispose() {
    this.stop();
    this.impactRT.dispose();
    this.holdRT.dispose();
    this.hand.dispose();
    this.finishPass.dispose();
    this.peekLive?.inst.dispose();
    this.warm?.inst.dispose();
    this.fxWarm?.dispose();
    this.drawOverlay.dispose();
    this.lyricLayer.dispose();
    this.popups.dispose();
    this.sceneWindows.dispose();
    this.peekFx.dispose();
    this.peekRT.dispose();
    this.endTransition();
    this.current?.inst.dispose();
    this.trPass.dispose();
    this.fx.dispose();
    this.fxOut.dispose();
    this.stillRT.dispose();
    this.sceneRT.dispose();
    this.prevRT.dispose();
    this.mixRT.dispose();
    this.renderer.dispose();
  }
}
