/**
 * The ground under a footage shot's type: the picture about to be written on, shrunk to a few dozen
 * cells. A line of type over the picture reads it in its own shader and draws a keyline and a soft
 * glow in the scheme's other ink just where its own colour wouldn't hold (type.ts), so nothing is
 * read back and nothing has to be remembered from frame to frame: the same frame always looks the same.
 */
import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../core/glsl';
import { GROUND } from './type';

const CELLS = 64;

export class Ground {
  private rt: THREE.WebGLRenderTarget | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material = new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tMap;
uniform vec2 uCell;
void main() {
  // a cell's average, from 16 spread taps (each already the mean of four pixels)
  vec3 c = vec3(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) c += texture2D(tMap, vUv + (vec2(float(i), float(j)) - 1.5) * 0.25 * uCell).rgb;
  gl_FragColor = vec4(c / 16.0, 1.0);
}`,
    uniforms: { tMap: { value: null }, uCell: { value: new THREE.Vector2() } },
    depthTest: false,
    depthWrite: false,
  });

  constructor() {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  /** read the picture in `texture` (w × h) for the type drawn next */
  read(r: THREE.WebGLRenderer, texture: THREE.Texture, w: number, h: number) {
    const cw = w >= h ? CELLS : Math.max(8, Math.round((CELLS * w) / h));
    const ch = w >= h ? Math.max(8, Math.round((CELLS * h) / w)) : CELLS;
    if (!this.rt || this.rt.width !== cw || this.rt.height !== ch) {
      this.rt?.dispose();
      this.rt = new THREE.WebGLRenderTarget(cw, ch, { depthBuffer: false });
    }
    const was = r.getRenderTarget();
    this.material.uniforms.tMap.value = texture;
    (this.material.uniforms.uCell.value as THREE.Vector2).set(1 / cw, 1 / ch);
    r.setRenderTarget(this.rt);
    r.render(this.scene, this.camera);
    r.setRenderTarget(was);
    GROUND.tGround.value = this.rt.texture;
    GROUND.uSize.value.set(w, h);
    GROUND.uGround.value = 1;
  }

  dispose() {
    this.rt?.dispose();
    this.rt = null;
    this.material.dispose();
    GROUND.tGround.value = null;
    GROUND.uGround.value = 0;
  }
}
