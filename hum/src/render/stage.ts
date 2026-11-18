import * as THREE from 'three';
import { audioEngine } from '../audio/engine';
import { FULLSCREEN_VERT } from '../core/glsl';
import { resolvePalette } from '../core/palettes';
import { createFullscreenQuad, makeRenderTarget } from '../core/sceneHelpers';
import type { EffectDef, EffectInstance, FrameContext, ParamValues, PhotoAsset, ResolvedPalette, SceneDef, SceneInstance, SharedResources } from '../core/types';
import { getEffect } from '../fx';
import { getScene } from '../scenes';
import { createPlaceholderPhoto } from '../scenes/photo/placeholder';
import { resolveParams } from '../state/modulation';
import { useStudio } from '../state/store';
import { autopilotTick } from '../state/autopilot';
import { FxChain } from './fxChain';
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
  private raf = 0;
  private last = performance.now();
  private t0 = performance.now();
  private frameNo = 0;
  private palette: ResolvedPalette;
  private placeholder: PhotoAsset | null = null;
  private fxParams = new Map<string, ParamValues>();
  private compilingScene = false;
  private snapshotResolvers: ((url: string) => void)[] = [];
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
    this.fx.setSize(w, h);
    this.current?.inst.resize?.(w, h);
    this.prev?.inst.resize?.(w, h);
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

  private ensureScene(id: string, now: number) {
    if (this.current?.id === id) return;
    const def = getScene(id);
    if (!def) return;
    let inst: SceneInstance;
    try {
      inst = def.create({ renderer: this.renderer, width: this.width, height: this.height, shared: this.shared });
    } catch (e) {
      console.error(e);
      useStudio.getState().set({ shaderError: String(e) });
      return;
    }
    if (this.prev) this.prev.inst.dispose();
    this.prev = this.current;
    this.fadeStart = now;
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
    const audio = audioEngine.update(dt);
    autopilotTick(audio);

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
    if (!this.current) return;

    if (!this.placeholder) this.placeholder = createPlaceholderPhoto();
    const photos = s.photos.length ? s.photos : [this.placeholder];
    const time = (now - this.t0) / 1000;
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
      text: s.text,
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
    const fade = (now - this.fadeStart) / 900;
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

    this.shared.blit(finalTex, null);

    if (this.snapshotResolvers.length) {
      const url = this.canvas.toDataURL('image/png');
      this.snapshotResolvers.splice(0).forEach((f) => f(url));
    }
  }

  dispose() {
    this.stop();
    this.current?.inst.dispose();
    this.prev?.inst.dispose();
    this.fx.dispose();
    this.sceneRT.dispose();
    this.prevRT.dispose();
    this.mixRT.dispose();
    this.renderer.dispose();
  }
}
