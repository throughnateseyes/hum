import * as THREE from 'three';
import { FULLSCREEN_VERT, GLSL_COMMON, GLSL_HEADER, paramUniformDecls } from '../core/glsl';
import { createFullscreenQuad, makeRenderTarget } from '../core/sceneHelpers';
import { createBaseUniforms, updateBaseUniforms, updateParamUniforms } from '../core/uniforms';
import type { AudioFrame, EffectDef, EffectInstance, ParamValues, ResolvedPalette, SharedResources } from '../core/types';

interface Compiled {
  def: EffectDef;
  mat: THREE.ShaderMaterial;
  fb?: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  /** feedback buffers not yet seeded with an input frame */
  fresh?: boolean;
}

export function buildEffectFragment(def: EffectDef) {
  return `${GLSL_HEADER}
uniform sampler2D tInput;
uniform sampler2D tPrev;
${paramUniformDecls(def.params)}
${GLSL_COMMON}
${def.fragment}`;
}

export class FxChain {
  private compiled = new Map<string, Compiled>();
  private rtA: THREE.WebGLRenderTarget;
  private rtB: THREE.WebGLRenderTarget;
  private quad = createFullscreenQuad(new THREE.MeshBasicMaterial());
  failed = new Set<string>();
  /** instance id currently being drawn — used to attribute shader compile errors */
  current: string | null = null;

  constructor(private shared: SharedResources) {
    this.rtA = makeRenderTarget(2, 2);
    this.rtB = makeRenderTarget(2, 2);
  }

  setSize(w: number, h: number) {
    if (this.rtA.width === w && this.rtA.height === h) return;
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
    for (const c of this.compiled.values()) c.fb?.forEach((rt) => rt.setSize(w, h));
  }

  private get(inst: EffectInstance, def: EffectDef, w: number, h: number): Compiled {
    let c = this.compiled.get(inst.instanceId);
    if (c && c.def === def) return c;
    if (c) this.disposeOne(inst.instanceId);
    const uniforms = {
      ...createBaseUniforms(this.shared, def.params),
      tInput: { value: null as THREE.Texture | null },
      tPrev: { value: null as THREE.Texture | null },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: buildEffectFragment(def),
      depthTest: false,
      depthWrite: false,
    });
    c = { def, mat };
    if (def.feedback) {
      c.fb = [makeRenderTarget(w, h), makeRenderTarget(w, h)];
      c.fresh = true;
    }
    this.compiled.set(inst.instanceId, c);
    return c;
  }

  /**
   * Run the enabled effects over `input`. Returns the final texture (input itself if no effects).
   */
  run(
    renderer: THREE.WebGLRenderer,
    input: THREE.Texture,
    instances: { inst: EffectInstance; def: EffectDef; params: ParamValues }[],
    o: { width: number; height: number; time: number; audio: AudioFrame; palette: ResolvedPalette },
  ): THREE.Texture {
    let src = input;
    let flip = false;
    for (const { inst, def, params } of instances) {
      if (!inst.enabled || this.failed.has(inst.instanceId)) continue;
      const c = this.get(inst, def, o.width, o.height);
      const u = c.mat.uniforms;
      updateBaseUniforms(u, o);
      updateParamUniforms(u, def.params, params);
      u.tInput.value = src;
      let dst: THREE.WebGLRenderTarget;
      if (c.fb) {
        if (c.fresh) {
          // seed history with the current frame so trails don't fade in from black
          this.shared.blit(src, c.fb[0]);
          c.fresh = false;
        }
        u.tPrev.value = c.fb[0].texture;
        dst = c.fb[1];
        c.fb = [c.fb[1], c.fb[0]];
      } else {
        dst = flip ? this.rtB : this.rtA;
        flip = !flip;
      }
      this.quad.mesh.material = c.mat;
      this.current = inst.instanceId;
      this.quad.render(renderer, dst);
      this.current = null;
      src = dst.texture;
    }
    return src;
  }

  /** drop compiled materials for instances that no longer exist */
  prune(liveIds: Set<string>) {
    for (const id of [...this.compiled.keys()]) if (!liveIds.has(id)) this.disposeOne(id);
  }

  private disposeOne(id: string) {
    const c = this.compiled.get(id);
    if (!c) return;
    c.mat.dispose();
    c.fb?.forEach((rt) => rt.dispose());
    this.compiled.delete(id);
    this.failed.delete(id);
  }

  dispose() {
    for (const id of [...this.compiled.keys()]) this.disposeOne(id);
    this.rtA.dispose();
    this.rtB.dispose();
    this.quad.dispose();
  }
}
