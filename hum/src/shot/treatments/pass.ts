/**
 * Runs a shot's treatment: the stage draws the bed (the footage as the style prints it) into this
 * pass's bed target, and the pass breaks it down into the stage's target. One per stage; the
 * treatments' materials are made once and kept, so a cut into a treated part compiles nothing.
 */
import * as THREE from 'three';
import { Cells } from './cells';
import { Collage, type CollagePicture } from './collage';
import { Quad, type TreatFrame } from './common';
import type { TreatmentId } from './index';
import { Mosh, type MoshPlan } from './mosh';
import { Readout } from './readout';
import { Sort } from './sort';

export class TreatPass {
  private bedRT: THREE.WebGLRenderTarget | null = null;
  private readonly quad = new Quad();
  readonly mosh = new Mosh();
  private readonly sort = new Sort();
  private readonly cells = new Cells();
  private readonly readout = new Readout();
  private readonly collage = new Collage();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly width: number,
    private readonly height: number,
  ) {}

  /** where the stage draws the bed for a treated shot */
  bedTarget(): THREE.WebGLRenderTarget {
    this.bedRT ??= new THREE.WebGLRenderTarget(this.width, this.height, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    return this.bedRT;
  }

  setMoshPlan(plan: MoshPlan, key: string) {
    this.mosh.setPlan(plan, key);
  }

  private head(m: THREE.ShaderMaterial, f: TreatFrame) {
    const u = m.uniforms;
    u.tBed.value = this.bedTarget().texture;
    (u.uRes.value as THREE.Vector2).set(this.width, this.height);
    u.uFlash.value = f.flash;
    (u.uPaper.value as THREE.Color).set(f.scheme.paper);
  }

  /** break the bed down into `target` */
  render(kind: TreatmentId, f: TreatFrame, target: THREE.WebGLRenderTarget | null, extra: { still: boolean; pictures: CollagePicture[] }) {
    const r = this.renderer;
    const w = this.width;
    const h = this.height;
    const was = r.getRenderTarget();
    let m: THREE.ShaderMaterial;
    switch (kind) {
      case 'mosh':
        this.mosh.advance(r, this.quad, f.t, w, h);
        this.mosh.update(f, w, h, extra.still);
        m = this.mosh.material;
        break;
      case 'sort':
        this.sort.update(f, w, h);
        m = this.sort.material;
        break;
      case 'cells':
        this.cells.update(f, w, h);
        m = this.cells.material;
        break;
      case 'readout':
        this.head(this.readout.coarse, f);
        this.readout.update(f, w, h, r, this.bedTarget().texture, (mat, rt) => this.quad.draw(r, mat, rt));
        m = this.readout.material;
        break;
      case 'collage':
        this.collage.update(f, w, h, extra.pictures);
        m = this.collage.material;
        break;
      default:
        return;
    }
    this.head(m, f);
    r.setRenderTarget(was);
    this.quad.draw(r, m, target);
  }

  /** every treatment's material, for compiling them ahead of the first cut */
  materials(): THREE.Material[] {
    return [this.mosh.material, this.mosh.tick, this.sort.material, this.cells.material, this.readout.coarse, this.readout.material, this.collage.material];
  }

  dispose() {
    this.bedRT?.dispose();
    this.bedRT = null;
    this.mosh.dispose();
    this.sort.dispose();
    this.cells.dispose();
    this.readout.dispose();
    this.collage.dispose();
    this.quad.dispose();
  }
}
