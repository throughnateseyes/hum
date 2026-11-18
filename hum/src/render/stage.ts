import * as THREE from 'three';
import { audioEngine } from '../audio/engine';
import { FULLSCREEN_VERT } from '../core/glsl';
import { resolvePalette } from '../core/palettes';
import { createFullscreenQuad, makeRenderTarget } from '../core/sceneHelpers';
import type { AudioFrame, EffectDef, EffectInstance, FrameContext, LayerId, Modulation, Palette, ParamValues, PhotoAsset, ResolvedPalette, SceneDef, SceneInstance, SharedResources } from '../core/types';
import { getEffect } from '../fx';
import { getScene } from '../scenes';
import { createPlaceholderPhoto } from '../scenes/photo/placeholder';
import { resolveParams } from '../state/modulation';
import { useStudio } from '../state/store';
import { autopilotTick } from '../state/autopilot';
import { planTick } from '../state/plan';
import { FxChain } from './fxChain';
import { LyricLayer } from './lyricLayer';
import { HandPass } from './handPass';
import { PopupLayer } from './popups';
import { lineAt } from '../audio/lyrics';
import { live as liveState } from '../state/live';

THREE.ColorManagement.enabled = false;

const MIX_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tA;
uniform sampler2D tB;
uniform float uMix;
uniform float uTime;
float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
void main(){
  // dithered dissolve crossfade — reads as a deliberate transition, not a blur
  float n = h(floor(gl_FragCoord.xy / 3.0) + floor(uTime * 30.0) * 0.0);
  float m = smoothstep(n - 0.25, n + 0.25, uMix * 1.5 - 0.25);
  gl_FragColor = vec4(mix(texture2D(tA, vUv).rgb, texture2D(tB, vUv).rgb, m), 1.0);
}`;

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
uniform float uKick, uSnare, uDrop, uBuild, uTime, uAmt, uAspect;
float h(float x){ return fract(sin(x * 91.17) * 43758.5453); }
void main(){
  float a = min(uAmt, 1.6);
  float hit = smoothstep(0.62, 1.0, uDrop);            // strongest in the first ~0.4 s of a drop
  vec2 c = vUv - 0.5;
  float zoom = (0.028 * uKick + 0.07 * hit + 0.025 * uBuild) * a;
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

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly shared: SharedResources;
  private sceneRT: THREE.WebGLRenderTarget;
  private prevRT: THREE.WebGLRenderTarget;
  private mixRT: THREE.WebGLRenderTarget;
  private fx: FxChain;
  private blitMat: THREE.ShaderMaterial;
  private blitQuad: ReturnType<typeof createFullscreenQuad>;
  private mixMat: THREE.ShaderMaterial;
  private mixQuad: ReturnType<typeof createFullscreenQuad>;
  private current: Live | null = null;
  private prev: Live | null = null;
  private fadeStart = 0;
  private fadeDur = 900;
  /** set before a look change to use a different crossfade length once (1 = a hard cut) */
  nextFadeMs: number | null = null;
  private raf = 0;
  private last = performance.now();
  private t0 = performance.now();
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
  private shapedLayers = {} as Record<LayerId, number>;
  /** the next section's scene, created and drawn once ahead of time so a cut lands without a compile stall */
  private warm: Live | null = null;
  private warmFresh = false;
  private lyricLayer = new LyricLayer();
  /** little board windows that pop in over the picture (after effects, under lyrics) */
  private popups = new PopupLayer();
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
    this.mixMat = new THREE.ShaderMaterial({
      uniforms: { tA: { value: null }, tB: { value: null }, uMix: { value: 0 }, uTime: { value: 0 } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: MIX_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.mixQuad = createFullscreenQuad(this.mixMat);
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
      blit: (texture, target) => {
        this.blitMat.uniforms.tMap.value = texture;
        this.blitQuad.render(this.renderer, target);
      },
    };
    const sceneOpts = { depthBuffer: true, samples: 4 } as const;
    this.sceneRT = makeRenderTarget(2, 2, sceneOpts);
    this.prevRT = makeRenderTarget(2, 2, sceneOpts);
    this.mixRT = makeRenderTarget(2, 2);
    this.fx = new FxChain(this.shared);
    this.palette = resolvePalette(useStudio.getState().palette);
    this.peekRT = makeRenderTarget(2, 2, sceneOpts);
    this.peekFx = new FxChain(this.shared);
    this.peekPalette = resolvePalette(useStudio.getState().palette);

    renderer.debug.onShaderError = (gl, program, vs, fs) => {
      const log = (s: WebGLShader) => gl.getShaderInfoLog(s) || '';
      const msg = (log(fs) || log(vs) || gl.getProgramInfoLog(program) || 'Shader failed to compile').trim();
      console.warn('[hum] shader error\n' + msg);
      if (this.fx.current) {
        this.fx.failed.add(this.fx.current);
        const inst = useStudio.getState().effects.find((e) => e.instanceId === this.fx.current);
        useStudio.getState().flash(`Effect “${inst?.effectId ?? '?'}” failed to compile and was skipped`);
      } else if (this.compilingScene) {
        useStudio.getState().set({ shaderError: msg.slice(0, 1200) });
      }
    };
  }

  setSize(cssW: number, cssH: number) {
    const q = useStudio.getState().quality;
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * q;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(cssW, cssH, false);
    const w = Math.max(2, Math.round(cssW * dpr));
    const h = Math.max(2, Math.round(cssH * dpr));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.sceneRT.setSize(w, h);
    this.prevRT.setSize(w, h);
    this.mixRT.setSize(w, h);
    this.impactRT.setSize(w, h);
    this.holdRT.setSize(w, h);
    this.holdReady = false;
    this.fx.setSize(w, h);
    this.current?.inst.resize?.(w, h);
    this.prev?.inst.resize?.(w, h);
    this.warm?.inst.resize?.(w, h);
  }

  start() {
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.tick();
    };
    this.raf = requestAnimationFrame(loop);
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

  /** Create a scene now (shaders compile, buffers allocate) so switching to it later is instant. */
  prewarm(id: string) {
    if (this.current?.id === id || this.warm?.id === id || this.width <= 2) return;
    const def = getScene(id);
    if (!def) return;
    this.warm?.inst.dispose();
    this.warm = null;
    try {
      this.warm = { id, def, inst: def.create({ renderer: this.renderer, width: this.width, height: this.height, shared: this.shared }), born: performance.now(), params: {} };
      this.warmFresh = true;
    } catch (e) {
      console.warn('[hum] prewarm failed', e);
    }
  }

  private ensureScene(id: string, now: number) {
    if (this.current?.id === id) return;
    const def = getScene(id);
    if (!def) return;
    let inst: SceneInstance;
    try {
      if (this.warm?.id === id) {
        inst = this.warm.inst;
        this.warm = null;
      } else inst = def.create({ renderer: this.renderer, width: this.width, height: this.height, shared: this.shared });
    } catch (e) {
      console.error(e);
      useStudio.getState().set({ shaderError: String(e) });
      return;
    }
    if (this.prev) this.prev.inst.dispose();
    this.prev = this.current;
    this.fadeStart = now;
    this.fadeDur = Math.max(1, this.nextFadeMs ?? 900);
    this.nextFadeMs = null;
    this.current = { id, def, inst, born: now, params: {} };
  }

  private tick() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.fps = this.fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;
    this.frameNo++;
    const s = useStudio.getState();
    audioEngine.sensitivity = s.sensitivity;
    const raw = audioEngine.update(dt);
    autopilotTick(raw);
    planTick(raw);
    const audio = this.shape(raw, s.impact);

    // shared audio textures
    const sd = this.shared.spectrumTex.image.data as Float32Array;
    for (let i = 0; i < 128; i++) sd[i * 4] = audio.spectrum[i];
    this.shared.spectrumTex.needsUpdate = true;
    const wd = this.shared.waveformTex.image.data as Float32Array;
    for (let i = 0; i < 512; i++) wd[i * 4] = audio.waveform[i] * 0.5 + 0.5;
    this.shared.waveformTex.needsUpdate = true;

    resolvePalette(s.palette, this.palette);
    if (!s.sceneId || this.width <= 2) return; // wait for the first real layout size
    this.ensureScene(s.sceneId, now);
    this.nextFadeMs = null; // only for a change made this frame
    if (!this.current) return;
    const time = (now - this.t0) / 1000;

    // Hand-drawn: a new drawing only every 1/fps s (held in between, like animation on 2s or 3s),
    // except that a kick, snare or drop always gets a fresh drawing so hits land on time.
    const hit = this.hitEdge(audio);
    if (s.hand.on && s.hand.fps < 60 && this.holdReady && time - this.lastDrawing < 1 / s.hand.fps - 0.004 && !hit) {
      this.shared.blit(this.holdRT.texture, null);
      this.resolveSnapshots();
      return;
    }
    this.lastDrawing = time;
    if (!s.hand.on) this.holdReady = false;

    if (!this.placeholder) this.placeholder = createPlaceholderPhoto();
    const photos = s.photos.length ? s.photos : [this.placeholder];
    const base: Omit<FrameContext, 'params'> = {
      renderer: this.renderer,
      time,
      dt,
      frame: this.frameNo,
      width: this.width,
      height: this.height,
      aspect: this.width / this.height,
      audio,
      palette: this.palette,
      photos,
      shared: this.shared,
      analysis: s.analysis,
      // scenes that show text (the boards) get the line being sung when no text is typed in
      text: s.text || (s.lyrics?.synced ? (lineAt(s.lyrics.lines, audio.time)?.line.text ?? '') : ''),
    };

    const r = this.renderer;
    const drawScene = (live: Live, target: THREE.WebGLRenderTarget, params: ParamValues) => {
      r.setRenderTarget(target);
      r.setClearColor(this.palette.c.bg, 1);
      r.clear(true, true, false);
      this.compilingScene = live === this.current;
      try {
        live.inst.render({ ...base, params }, target);
      } catch (e) {
        console.error(e);
      }
      this.compilingScene = false;
    };

    // draw a prewarmed scene once (into the spare buffer) so its shaders are compiled before the cut
    if (this.warm && this.warmFresh && !this.prev) {
      this.warmFresh = false;
      const defaults: ParamValues = {};
      for (const d of this.warm.def.params) defaults[d.id] = d.default;
      drawScene(this.warm, this.prevRT, defaults);
    }

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

    let sceneTex: THREE.Texture = this.sceneRT.texture;
    const fade = (now - this.fadeStart) / this.fadeDur;
    if (this.prev) {
      if (fade >= 1) {
        this.prev.inst.dispose();
        this.prev = null;
      } else {
        drawScene(this.prev, this.prevRT, this.prev.params);
        this.mixMat.uniforms.tA.value = this.prevRT.texture;
        this.mixMat.uniforms.tB.value = this.sceneRT.texture;
        this.mixMat.uniforms.uMix.value = fade;
        this.mixMat.uniforms.uTime.value = time;
        this.mixQuad.render(r, this.mixRT);
        sceneTex = this.mixRT.texture;
      }
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
    const finalTex = this.fx.run(r, sceneTex, live, { width: this.width, height: this.height, time, audio, palette: this.palette });
    // the hover preview borrows a corner of the canvas before the main frame covers it
    this.renderPeek(base, s.impact, now);

    const showLyrics = !!s.lyrics?.synced && s.lyricStyle !== 'off';
    const lyricOpts = showLyrics ? { lines: s.lyrics!.lines, t: audio.time, style: s.lyricStyle, palette: s.palette, width: this.width, height: this.height, audio } : null;
    if (s.hand.on) {
      // everything (lyrics too) goes through the hand-drawn finish, then is held until the next drawing
      if (s.impact > 0.001) {
        this.setImpactUniforms(finalTex, audio, time, s.impact, this.width / this.height);
        this.impactQuad.render(r, this.impactRT);
      } else {
        this.shared.blit(finalTex, this.impactRT);
      }
      this.popups.render(r, base, this.impactRT);
      if (lyricOpts) this.lyricLayer.render(r, lyricOpts, this.impactRT);
      // smooth: every frame is drawn, but the lines and paper re-draw on a 12-a-second clock
      const drawing = s.hand.fps >= 60 ? Math.floor(time * 12) : this.drawingNo++;
      this.hand.render(r, this.impactRT.texture, this.holdRT, { style: s.hand, palette: this.palette, width: this.width, height: this.height, drawing });
      this.holdReady = true;
      this.shared.blit(this.holdRT.texture, null);
    } else {
      if (s.impact > 0.001) {
        this.setImpactUniforms(finalTex, audio, time, s.impact, this.width / this.height);
        this.impactQuad.render(r, this.impactRT);
        this.shared.blit(this.impactRT.texture, null);
      } else {
        this.shared.blit(finalTex, null);
      }
      this.popups.render(r, base);
      if (lyricOpts) this.lyricLayer.render(r, lyricOpts);
    }
    this.resolveSnapshots();
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
    this.peekLive?.inst.dispose();
    this.warm?.inst.dispose();
    this.lyricLayer.dispose();
    this.popups.dispose();
    this.peekFx.dispose();
    this.peekRT.dispose();
    this.current?.inst.dispose();
    this.prev?.inst.dispose();
    this.fx.dispose();
    this.sceneRT.dispose();
    this.prevRT.dispose();
    this.mixRT.dispose();
    this.renderer.dispose();
  }
}
