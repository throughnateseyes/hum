import * as THREE from 'three';
import { FULLSCREEN_VERT, GLSL_COMMON, GLSL_HEADER, paramUniformDecls } from './glsl';
import { createBaseUniforms, updateBaseUniforms, updateParamUniforms } from './uniforms';
import type { FrameContext, SceneDef, SceneInit, SceneInstance } from './types';

type Meta = Omit<SceneDef, 'create'>;

/* ───────────────────────── Full-screen quad utility ───────────────────────── */

export function createFullscreenQuad(material: THREE.Material) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geo = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return {
    scene,
    camera,
    mesh,
    render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null) {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
    },
    dispose() {
      geo.dispose();
    },
  };
}

export function makeRenderTarget(w: number, h: number, opts: Partial<THREE.RenderTargetOptions> = {}) {
  return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    ...opts,
  });
}

/** Keeps a slowly advancing "photo cursor": whole numbers = which photo, fraction = transition progress. */
export function createPhotoClock() {
  let beats = 0;
  return (frame: FrameContext) => {
    const bps = frame.audio.bpm > 0 ? frame.audio.bpm / 60 : 2;
    beats += frame.dt * bps * (frame.audio.playing ? 1 : 0.35);
    return beats / 16; // a new photo every 16 beats (4 bars)
  };
}

/* ───────────────────────── Shader scenes ───────────────────────── */

export interface ShaderSceneOptions extends Meta {
  /**
   * Fragment shader with `void main()`. Gets GLSL_HEADER + GLSL_COMMON + param uniforms
   * + uImage/uImageSize/uImage2/uImage2Size/uPhotoIndex + tPrev (see src/core/glsl.ts).
   */
  fragment: string;
  /** when true, tPrev = the previous frame of this scene (ping-pong) */
  feedback?: boolean;
  /** render scale for the feedback buffers (0.25..1). Default 1. */
  scale?: number;
}

export function buildSceneFragment(fragment: string, params: SceneDef['params']) {
  return `${GLSL_HEADER}
uniform sampler2D uImage; uniform vec2 uImageSize;
uniform sampler2D uImage2; uniform vec2 uImage2Size;
uniform float uPhotoIndex;
uniform sampler2D tPrev;
${paramUniformDecls(params)}
${GLSL_COMMON}
${fragment}`;
}

export function defineShaderScene(opts: ShaderSceneOptions): SceneDef {
  const { fragment, feedback, scale = 1, ...meta } = opts;
  return {
    ...meta,
    create(init: SceneInit): SceneInstance {
      const uniforms = {
        ...createBaseUniforms(init.shared, meta.params),
        uImage: { value: null as THREE.Texture | null },
        uImageSize: { value: new THREE.Vector2(1, 1) },
        uImage2: { value: null as THREE.Texture | null },
        uImage2Size: { value: new THREE.Vector2(1, 1) },
        uPhotoIndex: { value: 0 },
        tPrev: { value: null as THREE.Texture | null },
      };
      const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: buildSceneFragment(fragment, meta.params),
        depthTest: false,
        depthWrite: false,
      });
      const quad = createFullscreenQuad(material);
      const photoClock = createPhotoClock();
      let rtA: THREE.WebGLRenderTarget | null = null;
      let rtB: THREE.WebGLRenderTarget | null = null;
      const ensureRTs = (w: number, h: number) => {
        const sw = Math.max(1, Math.round(w * scale));
        const sh = Math.max(1, Math.round(h * scale));
        if (!rtA || rtA.width !== sw || rtA.height !== sh) {
          rtA?.dispose();
          rtB?.dispose();
          rtA = makeRenderTarget(sw, sh);
          rtB = makeRenderTarget(sw, sh);
        }
      };

      return {
        render(frame, target) {
          updateBaseUniforms(uniforms, frame);
          updateParamUniforms(uniforms, meta.params, frame.params);
          const pc = photoClock(frame);
          const n = frame.photos.length;
          const i = Math.floor(pc) % n;
          const p1 = frame.photos[i];
          const p2 = frame.photos[(i + 1) % n];
          uniforms.uImage.value = p1.texture;
          uniforms.uImageSize.value.set(p1.width, p1.height);
          uniforms.uImage2.value = p2.texture;
          uniforms.uImage2Size.value.set(p2.width, p2.height);
          uniforms.uPhotoIndex.value = pc;

          if (feedback) {
            ensureRTs(frame.width, frame.height);
            const a = rtA!;
            const b = rtB!;
            uniforms.tPrev.value = a.texture;
            (material.uniforms.uResolution.value as THREE.Vector2).set(b.width, b.height);
            quad.render(frame.renderer, b);
            frame.shared.blit(b.texture, target);
            rtA = b;
            rtB = a;
          } else {
            quad.render(frame.renderer, target);
          }
        },
        dispose() {
          material.dispose();
          quad.dispose();
          rtA?.dispose();
          rtB?.dispose();
        },
      };
    },
  };
}

/* ───────────────────────── Canvas 2D scenes ───────────────────────── */

export interface CanvasSceneOptions<S> extends Meta {
  /** called once (and again after resize) — return any state you want to keep */
  setup?: (ctx: CanvasRenderingContext2D, w: number, h: number) => S;
  /** draw one frame. Canvas is sized to the render target in device px. */
  draw: (ctx: CanvasRenderingContext2D, frame: FrameContext, state: S) => void;
  /** render scale (0.25..1) for heavy canvases. Default 1. */
  scale?: number;
}

export function defineCanvasScene<S = undefined>(opts: CanvasSceneOptions<S>): SceneDef {
  const { setup, draw, scale = 1, ...meta } = opts;
  return {
    ...meta,
    create(): SceneInstance {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { alpha: false })!;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.NoColorSpace; // color management is off app-wide: pass-through
      texture.minFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      let state: S = undefined as S;
      let ready = false;
      return {
        render(frame, target) {
          const w = Math.max(1, Math.round(frame.width * scale));
          const h = Math.max(1, Math.round(frame.height * scale));
          if (canvas.width !== w || canvas.height !== h || !ready) {
            canvas.width = w;
            canvas.height = h;
            state = setup ? setup(ctx, w, h) : (undefined as S);
            ready = true;
          }
          draw(ctx, { ...frame, width: w, height: h, aspect: w / h }, state);
          texture.needsUpdate = true;
          frame.shared.blit(texture, target);
        },
        dispose() {
          texture.dispose();
        },
      };
    },
  };
}

/* ───────────────────────── three.js scenes ───────────────────────── */

/**
 * Convenience for classic three.js scenes. `build` returns the scene, camera and an
 * update callback; the helper handles aspect/resize and rendering into the target.
 */
export interface ThreeSceneOptions extends Meta {
  build: (init: SceneInit) => {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
    update: (frame: FrameContext) => void;
    dispose?: () => void;
  };
}

export function defineThreeScene(opts: ThreeSceneOptions): SceneDef {
  const { build, ...meta } = opts;
  return {
    ...meta,
    create(init) {
      const built = build(init);
      return {
        render(frame, target) {
          const cam = built.camera;
          if (cam instanceof THREE.PerspectiveCamera && Math.abs(cam.aspect - frame.aspect) > 1e-4) {
            cam.aspect = frame.aspect;
            cam.updateProjectionMatrix();
          }
          built.update(frame);
          frame.renderer.setRenderTarget(target);
          frame.renderer.render(built.scene, cam);
        },
        dispose() {
          built.dispose?.();
          built.scene.traverse((o) => {
            const m = o as THREE.Mesh;
            m.geometry?.dispose?.();
            const mat = m.material as THREE.Material | THREE.Material[] | undefined;
            if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
            else mat?.dispose?.();
          });
        },
      };
    },
  };
}
