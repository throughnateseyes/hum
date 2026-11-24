/**
 * Flat canvases laid over the frame. A sprite repaints only when what it shows changes (its key), so a
 * drawing costs its redraw rate, not the frame rate, while it can still move smoothly every frame.
 */
import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uMap;
uniform float uAlpha;
void main() { gl_FragColor = texture2D(uMap, vUv) * uAlpha; }
`;

/** the longest side a sprite's canvas may have */
const MAX_EDGE = 1700;

export class Sprite {
  readonly mesh: THREE.Mesh;
  private canvas = document.createElement('canvas');
  private tex: THREE.CanvasTexture | null = null;
  private mat: THREE.ShaderMaterial;
  private key = '';

  constructor(geo: THREE.PlaneGeometry) {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uMap: { value: null }, uAlpha: { value: 1 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** paint w×h frame pixels if `key` is new; `draw` gets a context in those pixels and the device scale */
  paint(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D, scale: number) => void) {
    if (key === this.key) return;
    this.key = key;
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    const cw = Math.max(2, Math.ceil(w * scale));
    const ch = Math.max(2, Math.ceil(h * scale));
    const c = this.canvas;
    if (c.width !== cw || c.height !== ch) {
      c.width = cw;
      c.height = ch;
      this.tex?.dispose();
      this.tex = null;
    }
    const g = c.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cw, ch);
    g.setTransform(scale, 0, 0, scale, 0, 0);
    draw(g, scale);
    if (!this.tex) {
      const t = new THREE.CanvasTexture(c);
      t.flipY = false;
      t.premultiplyAlpha = true;
      t.generateMipmaps = false;
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.colorSpace = THREE.NoColorSpace;
      this.tex = t;
      this.mat.uniforms.uMap.value = t;
    }
    this.tex.needsUpdate = true;
  }

  /** show it with its middle at x, y */
  put(x: number, y: number, w: number, h: number, turn = 0, alpha = 1) {
    this.mesh.position.set(x, y, 0);
    this.mesh.scale.set(w, h, 1);
    this.mesh.rotation.z = turn;
    this.mat.uniforms.uAlpha.value = alpha;
    this.mesh.visible = alpha > 0.003;
  }

  hide() {
    this.mesh.visible = false;
  }

  dispose() {
    this.tex?.dispose();
    this.mat.dispose();
    this.canvas.width = this.canvas.height = 0;
  }
}
