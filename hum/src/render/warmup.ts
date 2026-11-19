/**
 * Compiling shaders without the stall.
 *
 * The first time three.js draws with a new shader it compiles and links it right there, and the
 * frame waits for it: a new look, a window opening or an effect switching on can hold one frame for
 * 50–150 ms, which you see as a hitch. These helpers compile ahead of time instead, through
 * `renderer.compileAsync`, which uses KHR_parallel_shader_compile (when the GPU has it) to let the
 * driver compile in the background while frames keep coming. Once the program exists, three.js
 * reuses it for any material with the same shader code, so the real draw later costs nothing extra.
 */
import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../core/glsl';
import { createFullscreenQuad } from '../core/sceneHelpers';
import { createBaseUniforms } from '../core/uniforms';
import type { EffectDef, SharedResources } from '../core/types';
import { buildEffectFragment } from './fxChain';

/**
 * Run `draw` (a scene's render, say) without drawing anything: every `renderer.render(scene, camera)`
 * it makes is turned into a background compile of what that call would have drawn. Resolves once all
 * of them are ready. Render targets it binds and clears are left as they were drawn by `draw`.
 */
export function dryRun(renderer: THREE.WebGLRenderer, draw: () => void): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const real = renderer.render;
  renderer.render = (scene: THREE.Object3D, camera: THREE.Camera) => {
    pending.push(renderer.compileAsync(scene, camera).catch(() => undefined));
  };
  try {
    draw();
  } catch {
    /* a scene that throws here throws again when it's really drawn, where it's reported */
  } finally {
    renderer.render = real;
  }
  return Promise.all(pending).then(() => undefined);
}

/**
 * Compile a look's effects ahead of its cut. Keep the returned handle until the look is on screen
 * (three.js frees a program when no material uses it), then dispose it.
 */
export function warmEffects(renderer: THREE.WebGLRenderer, shared: SharedResources, defs: EffectDef[], target: THREE.WebGLRenderTarget): { ready: Promise<void>; dispose: () => void } {
  // three.js compiles a slightly different shader for the screen than for a render target, so compile
  // for a target, like the effect chain draws
  const was = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  const quads = defs.map((def) => {
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...createBaseUniforms(shared, def.params), tInput: { value: null }, tPrev: { value: null } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: buildEffectFragment(def),
      depthTest: false,
      depthWrite: false,
    });
    return { mat, quad: createFullscreenQuad(mat) };
  });
  const ready = Promise.all(quads.map(({ quad }) => renderer.compileAsync(quad.scene, quad.camera).catch(() => undefined))).then(() => undefined);
  renderer.setRenderTarget(was);
  return {
    ready,
    dispose: () => {
      for (const { mat, quad } of quads) {
        mat.dispose();
        quad.dispose();
      }
    },
  };
}
