/**
 * Plays one of Hum's built-in looks into a texture (prototype, see src/dev/shot.ts).
 *
 * A shot can cut to a look full-frame, or use it as the picture that shapes and bands of the footage
 * are windows onto. Either way it needs the look as a texture at a given song time. This runs the
 * look's scene and effect chain against an AudioFrame built from the analysis (songFrame.ts), on its
 * own clock, the same way src/dev/solo.ts does. No finishes, pop-ups, windows or lyrics.
 */
import * as THREE from 'three';
import { emptyFrame } from '../audio/engine';
import { FeelTracker } from '../core/feel';
import { FULLSCREEN_VERT } from '../core/glsl';
import { createNoiseTexture } from '../core/noise';
import { resolvePalette } from '../core/palettes';
import { createFullscreenQuad, makeRenderTarget } from '../core/sceneHelpers';
import type { AudioFrame, EffectDef, EffectInstance, FrameContext, Palette, ParamValues, PhotoAsset, ResolvedPalette, SceneDef, SceneInstance, SharedResources, TrackAnalysis } from '../core/types';
import { getEffect } from '../fx';
import { PRESETS } from '../presets';
import { presetToLook, type LookState } from '../presets/apply';
import { FxChain } from '../render/fxChain';
import { getScene } from '../scenes';
import { createPlaceholderPhoto } from '../scenes/photo/placeholder';
import { resolveParams } from '../state/modulation';
import { useStudio } from '../state/store';
import { frameFromAnalysis } from './songFrame';

const STEP = 1 / 60;
/** a jump further ahead than this is caught up in fixed steps instead of one big one */
const MAX_STEP = 0.25;
/** how far back a backwards jump restarts from */
const REWIND = 3;
/** asked for a time this little behind the current one, the look just holds its frame */
const BACKSTEP = 0.1;

interface ChainItem {
  inst: EffectInstance;
  def: EffectDef;
  params: ParamValues;
}

export class LookPlayer {
  /** the last error a scene threw while rendering (the last good picture is kept) */
  error: string | null = null;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly def: SceneDef;
  private readonly look: LookState;
  private readonly palette: ResolvedPalette;
  private readonly analysis: TrackAnalysis;
  private readonly width: number;
  private readonly height: number;
  private readonly shared: SharedResources;
  private readonly blitMat: THREE.ShaderMaterial;
  private readonly blitQuad: ReturnType<typeof createFullscreenQuad>;
  private readonly sceneRT: THREE.WebGLRenderTarget;
  private readonly fx: FxChain;
  private readonly chain: ChainItem[];
  private readonly photos: PhotoAsset[];
  private readonly audio: AudioFrame = emptyFrame();
  private readonly sceneParams: ParamValues = {};
  private inst: SceneInstance | null = null;
  private feel = new FeelTracker();
  private out: THREE.Texture;
  /** song time of the latest step, when the look was (re)started, and frames since */
  private t = 0;
  private born = 0;
  private frameNo = 0;
  private started = false;

  constructor(renderer: THREE.WebGLRenderer, presetId: string, width: number, height: number, analysis: TrackAnalysis, palette?: Palette) {
    const preset = PRESETS.find((p) => p.id === presetId);
    if (!preset) throw new Error(`unknown look "${presetId}"`);
    const def = getScene(preset.sceneId);
    if (!def) throw new Error(`look "${presetId}" uses unknown scene "${preset.sceneId}"`);
    this.renderer = renderer;
    this.def = def;
    this.analysis = analysis;
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));

    // as solo.ts's buildLook: the look's own params, effects and modulations, with the palette swapped
    // when one is given
    const pal = palette ?? preset.palette;
    this.look = presetToLook({
      ...preset,
      palette: { id: 'shot', name: 'shot', bg: pal.bg, fg: pal.fg, accent: pal.accent, accent2: pal.accent2, muted: pal.muted },
    });
    this.palette = resolvePalette(this.look.palette);

    // some scenes read song facts from the store; give them the analysis (lyrics stay as they are)
    const s = useStudio.getState();
    useStudio.setState({ analysis, track: s.track ?? { name: 'Shot', source: 'file' } });

    const dataTex = (n: number) => {
      const t = new THREE.DataTexture(new Float32Array(n * 4), n, 1, THREE.RGBAFormat, THREE.FloatType);
      t.magFilter = t.minFilter = THREE.LinearFilter;
      t.needsUpdate = true;
      return t;
    };
    this.blitMat = new THREE.ShaderMaterial({
      uniforms: { tMap: { value: null } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: `precision highp float; varying vec2 vUv; uniform sampler2D tMap; void main(){ gl_FragColor = vec4(texture2D(tMap, vUv).rgb, 1.0); }`,
      depthTest: false,
      depthWrite: false,
    });
    this.blitQuad = createFullscreenQuad(this.blitMat);
    this.shared = {
      spectrumTex: dataTex(128),
      waveformTex: dataTex(512),
      noiseTex: createNoiseTexture(),
      blit: (texture, target) => {
        this.blitMat.uniforms.tMap.value = texture;
        this.blitQuad.render(renderer, target);
      },
    };

    this.sceneRT = makeRenderTarget(this.width, this.height, { depthBuffer: true, samples: 4 });
    this.out = this.sceneRT.texture;
    this.fx = new FxChain(this.shared);
    this.fx.setSize(this.width, this.height);
    this.photos = [createPlaceholderPhoto()];
    this.chain = this.look.effects
      .map((inst) => ({ inst, def: getEffect(inst.effectId) }))
      .filter((c): c is { inst: EffectInstance; def: EffectDef } => !!c.def)
      .map((c) => ({ ...c, params: {} }));
  }

  /** the finished picture (scene + its effect chain) for the latest step */
  get texture(): THREE.Texture {
    return this.out;
  }

  /** (re)start the look as if it had just been cut to at song time `t` */
  start(t: number): void {
    this.inst?.dispose();
    this.inst = null;
    try {
      this.inst = this.def.create({ renderer: this.renderer, width: this.width, height: this.height, shared: this.shared });
      this.error = null;
    } catch (e) {
      this.error = `create threw: ${e instanceof Error ? e.message : String(e)}`;
    }
    this.t = this.born = t;
    this.feel = new FeelTracker();
    this.frameNo = 0;
    this.started = true;
  }

  /**
   * Advance to song time `t` and render. Looks keep their own state and integrate dt, so a jump
   * backwards or far ahead is caught up in 1/60 s steps (a backwards jump restarts from up to 3 s
   * earlier), so a still at any time looks the way it would in playback.
   */
  render(t: number): void {
    if (!this.started) this.start(t);
    const r = this.renderer;
    // leave the renderer as we found it
    const prevTarget = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    const prevAutoClear = r.autoClear;
    r.autoClear = true;
    try {
      if (t <= this.t && t >= this.t - BACKSTEP) {
        // a clock that wobbles back a few milliseconds is not a rewind: keep the frame we have
      } else if (t < this.t) {
        // (before the cut itself: start right there)
        this.start(Math.min(t, Math.max(this.born, t - REWIND)));
        while (this.t < t - 1e-6) this.step(Math.min(STEP, t - this.t));
      } else if (t - this.t > MAX_STEP) {
        while (this.t < t - 1e-6) this.step(Math.min(STEP, t - this.t));
      } else if (t > this.t) {
        this.step(t - this.t);
      }
      // just started and asked for that same time: one tiny step so there is a picture
      if (this.frameNo === 0) this.step(1e-4);
    } finally {
      r.setRenderTarget(prevTarget);
      r.setClearColor(prevClear, prevAlpha);
      r.autoClear = prevAutoClear;
    }
  }

  private step(dt: number): void {
    const prev = this.t;
    this.t += dt;
    const audio = frameFromAnalysis(this.audio, this.analysis, this.t, prev);
    const sd = this.shared.spectrumTex.image.data as Float32Array;
    for (let i = 0; i < 128; i++) sd[i * 4] = audio.spectrum[i];
    this.shared.spectrumTex.needsUpdate = true;
    const wd = this.shared.waveformTex.image.data as Float32Array;
    for (let i = 0; i < 512; i++) wd[i * 4] = audio.waveform[i] * 0.5 + 0.5;
    this.shared.waveformTex.needsUpdate = true;
    if (!this.inst) return;

    const { renderer, width: W, height: H, look, palette } = this;
    const ctx: FrameContext = {
      renderer,
      time: this.t - this.born,
      dt,
      frame: this.frameNo++,
      width: W,
      height: H,
      aspect: W / H,
      audio,
      feel: this.feel.update(audio, this.analysis, dt),
      params: resolveParams(this.def.params, look.sceneParams, look.modulations, 'scene', audio.layers, this.sceneParams),
      palette,
      photos: this.photos,
      shared: this.shared,
      analysis: this.analysis,
      text: '',
    };
    try {
      renderer.setRenderTarget(this.sceneRT);
      renderer.setClearColor(palette.c.bg, 1);
      renderer.clear(true, true, false);
      this.inst.render(ctx, this.sceneRT);
      for (const c of this.chain) resolveParams(c.def.params, c.inst.params, look.modulations, `fx.${c.inst.instanceId}`, audio.layers, c.params);
      this.out = this.fx.run(renderer, this.sceneRT.texture, this.chain, { width: W, height: H, time: ctx.time, audio, feel: ctx.feel, palette });
    } catch (e) {
      // keep the last good picture; the scene's own state may be half-stepped, but it keeps going
      this.error = `render threw: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  dispose(): void {
    this.inst?.dispose();
    this.inst = null;
    this.fx.dispose();
    this.sceneRT.dispose();
    this.shared.spectrumTex.dispose();
    this.shared.waveformTex.dispose();
    this.shared.noiseTex.dispose();
    this.blitMat.dispose();
    this.blitQuad.dispose();
    for (const p of this.photos) p.texture.dispose();
    this.started = false;
  }
}
