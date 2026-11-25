/**
 * Draws inside shots: the clip with parts of it turned to flat colour, and words and shapes standing in
 * the place it shows, behind whatever is in front of them (what each part does: shaders.ts). One pass per
 * stage; each shot brings its own words, shapes and timing (shot.ts).
 */
import * as THREE from 'three';
import { EYE, type ClipScene } from '../depth/types';
import { at, pushCentre, type Crop, type Lens } from './place';
import { BED, FINISH, FULLSCREEN_VERT, NEARNESS, OVER } from './shaders';

/** everything that says how the clip is painted this frame */
export interface Paint {
  field0: string;
  light0: string;
  field1: string;
  light1: string;
  figure: string;
  line: string;
  ink: string;
  front: number;
  edge: number;
  far: number;
  mid: number;
  near: number;
  farCut: number;
  nearCut: number;
  airy0: number;
  airy1: number;
  figureK: number;
  groundK: number;
  grade: number;
  lineK: number;
  cuts: [number, number];
}

export interface Finish {
  zoom: number;
  smear: number;
  flash: number;
  flashColor: string;
}

/** shared by every material drawn in the place */
export interface PlaceUniforms {
  tNear: { value: THREE.Texture | null };
  /** the picture behind everything that stands in it, for a word to read its ground */
  tBed: { value: THREE.Texture | null };
  uRes: { value: THREE.Vector2 };
  uZScale: { value: number };
  tFootage: { value: THREE.Texture | null };
  uCrop: { value: THREE.Vector4 };
}

const BLANK = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat);
BLANK.needsUpdate = true;

/** a scene's maps as textures, the few that were wanted last */
class Maps {
  private readonly kept = new Map<string, { map: Uint8Array; texture: THREE.DataTexture }>();
  get(s: ClipScene, i: number): THREE.DataTexture | null {
    const map = s.maps[i];
    if (!map) return null;
    const key = `${s.id}|${i}`;
    const had = this.kept.get(key);
    if (had?.map === map) {
      this.kept.delete(key);
      this.kept.set(key, had);
      return had.texture;
    }
    had?.texture.dispose();
    const texture = new THREE.DataTexture(map, s.width, s.height, THREE.RedFormat, THREE.UnsignedByteType);
    texture.unpackAlignment = 1;
    texture.magFilter = texture.minFilter = THREE.LinearFilter;
    texture.colorSpace = THREE.NoColorSpace;
    texture.needsUpdate = true;
    this.kept.set(key, { map, texture });
    while (this.kept.size > 8) {
      const [k, old] = this.kept.entries().next().value as [string, { texture: THREE.DataTexture }];
      this.kept.delete(k);
      old.texture.dispose();
    }
    return texture;
  }
  dispose() {
    for (const k of this.kept.values()) k.texture.dispose();
    this.kept.clear();
  }
}

/** the sample nearest `want` whose map is in, looking a few either way */
function nearestRead(s: ClipScene, want: number): number {
  for (let d = 0; d < 6; d++) {
    if (s.maps[want + d]) return want + d;
    if (s.maps[want - d]) return want - d;
  }
  return -1;
}

const full = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) => new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false });
const color = () => ({ value: new THREE.Color() });

export class InsidePass {
  readonly place: PlaceUniforms;
  readonly camera = new THREE.PerspectiveCamera();
  private readonly nearRT: THREE.WebGLRenderTarget;
  private readonly bedRT: THREE.WebGLRenderTarget;
  private readonly overRT: THREE.WebGLRenderTarget;
  private readonly outRT: THREE.WebGLRenderTarget;
  private readonly quad: THREE.Mesh;
  private readonly scene = new THREE.Scene();
  private readonly flat = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly near: THREE.ShaderMaterial;
  private readonly bed: THREE.ShaderMaterial;
  private readonly over: THREE.ShaderMaterial;
  private readonly finish: THREE.ShaderMaterial;
  private readonly maps = new Maps();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    readonly width: number,
    readonly height: number,
  ) {
    const rt = (o: THREE.RenderTargetOptions = {}) => new THREE.WebGLRenderTarget(width, height, { depthBuffer: false, ...o });
    this.nearRT = rt({ type: THREE.HalfFloatType });
    this.bedRT = rt();
    this.overRT = rt({ samples: 4, depthBuffer: true });
    this.outRT = rt();
    for (const t of [this.nearRT, this.bedRT, this.overRT, this.outRT]) t.texture.colorSpace = THREE.NoColorSpace;
    this.place = {
      tNear: { value: this.nearRT.texture },
      tBed: { value: this.bedRT.texture },
      uRes: { value: new THREE.Vector2(width, height) },
      uZScale: { value: 1 },
      tFootage: { value: null },
      uCrop: { value: new THREE.Vector4(0.5, 0.5, 1, 1) },
    };
    const { tFootage, uCrop, tNear } = this.place;
    this.near = full(NEARNESS, { tFootage, uCrop, tMapA: { value: BLANK }, tMapB: { value: BLANK }, uMapMix: { value: 0 }, uHasMap: { value: 0 }, uMapSize: { value: new THREE.Vector2(1, 1) }, uClipTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) } });
    this.bed = full(BED, {
      tFootage, uCrop, tNear,
      uTexel: { value: new THREE.Vector2(1 / width, 1 / height) },
      uClipTexel: { value: new THREE.Vector2(1 / 1000, 1 / 1000) },
      uCuts: { value: new THREE.Vector2(0.35, 0.65) },
      uField0: color(), uLight0: color(), uField1: color(), uLight1: color(), uFigure: color(), uLine: color(), uInk: color(),
      uFront: { value: 0 }, uEdge: { value: 0 },
      uPaint: { value: new THREE.Vector3() },
      uFarCut: { value: 0 }, uNearCut: { value: 2 },
      uFigureK: { value: 0 }, uAiry0: { value: 0 }, uAiry1: { value: 0 }, uGroundK: { value: 0 }, uGrade: { value: 0 }, uLineK: { value: 0 },
      uGround: { value: new THREE.Vector3() },
    });
    this.over = full(OVER, { tBed: { value: this.bedRT.texture }, tOver: { value: this.overRT.texture } });
    this.finish = full(FINISH, { tPicture: { value: this.outRT.texture }, uVp: { value: new THREE.Vector2(0.5, 0.5) }, uSmear: { value: 0 }, uZoom: { value: 1 }, uFlash: { value: 0 }, uFlashC: color() });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.near);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.camera.matrixAutoUpdate = false;
  }

  private draw(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.flat);
  }

  /** put the place's camera where the clip's own is */
  aim(l: Lens) {
    const c = this.camera;
    c.projectionMatrix.copy(l.matrix);
    c.projectionMatrixInverse.copy(l.matrix).invert();
    c.matrix.makeTranslation(0, EYE, -l.ahead);
    c.matrixWorld.copy(c.matrix);
    c.matrixWorldInverse.copy(c.matrix).invert();
    c.matrixWorldAutoUpdate = false;
  }

  render(o: { scene: ClipScene | null; t: number; footage: THREE.Texture; clipAspect: number; crop: Crop; lens: Lens; paint: Paint; finish: Finish; place: THREE.Scene; target: THREE.WebGLRenderTarget | null }) {
    const r = this.renderer;
    const { scene, lens: l } = o;
    this.place.tFootage.value = o.footage;
    this.place.uCrop.value.set(o.crop.u, o.crop.v, o.crop.w, o.crop.h);
    this.place.uZScale.value = scene?.zScale ?? 1;

    const u = this.near.uniforms;
    u.uHasMap.value = 0;
    u.uClipTexel.value.set(1 / (1080 * o.clipAspect), 1 / 1080);
    if (scene) {
      const { i, j, k } = at(scene, o.t);
      const a = nearestRead(scene, i);
      const b = nearestRead(scene, j);
      if (a >= 0 || b >= 0) {
        const A = this.maps.get(scene, a >= 0 ? a : b);
        const B = this.maps.get(scene, b >= 0 ? b : a);
        u.tMapA.value = A ?? BLANK;
        u.tMapB.value = B ?? BLANK;
        u.uMapMix.value = k;
        u.uMapSize.value.set(scene.width, scene.height);
        u.uHasMap.value = A || B ? 1 : 0;
      }
    }
    this.draw(this.near, this.nearRT);

    const b = this.bed.uniforms;
    const p = o.paint;
    b.uField0.value.set(p.field0);
    b.uLight0.value.set(p.light0);
    b.uField1.value.set(p.field1);
    b.uLight1.value.set(p.light1);
    b.uFigure.value.set(p.figure);
    b.uLine.value.set(p.line);
    b.uInk.value.set(p.ink);
    b.uFront.value = p.front;
    b.uEdge.value = p.edge;
    b.uPaint.value.set(p.far, p.mid, p.near);
    b.uFarCut.value = p.farCut;
    b.uNearCut.value = p.nearCut;
    b.uFigureK.value = p.figureK;
    b.uGroundK.value = scene && scene.ground > 0.06 ? p.groundK : 0;
    b.uGrade.value = p.grade;
    b.uAiry0.value = p.airy0;
    b.uAiry1.value = p.airy1;
    b.uLineK.value = u.uHasMap.value ? p.lineK : 0;
    b.uCuts.value.set(p.cuts[0], p.cuts[1]);
    b.uClipTexel.value.set(1 / (720 * o.clipAspect), 1 / 720);
    // how near flat ground is at each point of the frame: linear, so three points settle it
    const g = (fx: number, fy: number) => groundNear(l, fx, fy, scene?.zScale ?? 1);
    const g0 = g(0, 0);
    b.uGround.value.set(g(1, 0) - g0, g(0, 1) - g0, g0);
    this.draw(this.bed, this.bedRT);

    this.aim(l);
    r.setRenderTarget(this.overRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    r.render(o.place, this.camera);
    this.draw(this.over, this.outRT);

    const f = this.finish.uniforms;
    const centre = pushCentre(l);
    f.uVp.value.set(centre.x, centre.y);
    f.uSmear.value = o.finish.smear;
    f.uZoom.value = o.finish.zoom;
    f.uFlash.value = o.finish.flash;
    f.uFlashC.value.set(o.finish.flashColor);
    this.draw(this.finish, o.target);
  }

  dispose() {
    this.maps.dispose();
    for (const t of [this.nearRT, this.bedRT, this.overRT, this.outRT]) t.dispose();
    for (const m of [this.near, this.bed, this.over, this.finish]) m.dispose();
    this.quad.geometry.dispose();
  }
}

/** the nearness flat ground would have at a frame point (negative above the horizon) */
function groundNear(l: Lens, fx: number, fy: number, zScale: number): number {
  // solve for 1/w of the ground point under (fx, fy): frame = (a·X + c·Z + ...)/w with Y = -EYE
  const e = l.matrix.elements;
  const nx = fx * 2 - 1 + e[8];
  const ny = fy * 2 - 1 + e[9];
  // nx = (e0 X + e4 Y)/w, ny = (e1 X + e5 Y)/w, Y = -EYE  → eliminate X/w
  const d = e[0] * e[5] - e[4] * e[1] || 1e-9;
  const Yw = (e[0] * ny - e[1] * nx) / d;
  return (-Yw / EYE) * zScale;
}
