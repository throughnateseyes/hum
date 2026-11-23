/**
 * Draws a run of shots (prototype, see src/dev/shot.ts and src/shot/sequence.ts).
 *
 * For any song time it finds the shot on screen and draws, back to front:
 *   the bed      footage (with its colour treatment), one of Hum's looks full frame, or a flat card
 *   the world    that shot's 3D motifs, in a space that slides toward the camera as the footage runs
 *   the frame    that shot's motifs pinned to the picture (type, the ruler)
 *
 * Every shot has its own palette (a footage shot's comes from its clip; a card or a look borrows the
 * palette of the footage next to it), its own motifs and its own speed curve.
 */
import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../core/glsl';
import type { Palette, TrackAnalysis } from '../core/types';
import type { Footage, FootageState } from './footage';
import { FootagePass } from './footage';
import { CAM_Z, FOV, frameSize, type Motif, type MotifContext, type MotifFrame } from './kit';
import { LookPlayer } from './lookPlayer';
import { MOTIFS } from './motifs';
import type { ShotPalette } from './palette';
import { planFootage, type Sequence, type Shot, type ShotCurve } from './sequence';
import { clamp01, dice, easeInCubic, easeOutCubic, smooth } from './time';

export interface StageClip {
  /** the video behind it; null for a still stand-in picture */
  footage: Footage | null;
  texture: THREE.Texture;
  aspect: number;
  /** seconds (a still lasts for ever) */
  duration: number;
  palette: ShotPalette;
}

export interface StageOptions {
  seq: Sequence;
  analysis: TrackAnalysis;
  /** at least one; footage shots take them in turn */
  clips: StageClip[];
  caption: string;
  /** built-in look ids: the full-frame cutaway, and the one that shows through footage and shapes */
  lookId: string;
  fillId: string;
}

interface Rig {
  shot: Shot;
  curve: ShotCurve;
  palette: ShotPalette;
  clip: StageClip | null;
  look: LookPlayer | null;
  world: THREE.Group;
  frame: THREE.Group;
  motifs: Motif[];
}

const BANDS = [1, 0.2, 0, 0.25, 1];
const LOOK_BANDS = [1, 0.12, 0, 0.12, 1];
const LOOK_FILL = [1, 0, 0, 0, 1];
const NONE = [0, 0, 0, 0, 0];

/** the shot's colours as one of Hum's palettes, so a look can be dressed in them */
const asLookPalette = (p: ShotPalette): Palette => ({ id: 'shot', name: 'shot', bg: p.paper, fg: p.ink, accent: p.flats[0], accent2: p.flats[3], muted: p.flats[1] });

export class ShotStage {
  /** anything that went wrong building the shots (an unknown look id, a look that failed to start) */
  errors: string[] = [];
  private rigs: Rig[] = [];
  private seq: Sequence | null = null;
  private active: Rig | null = null;
  private readonly pass = new FootagePass();
  private readonly worldScene = new THREE.Scene();
  private readonly frameScene = new THREE.Scene();
  private readonly worldCam: THREE.PerspectiveCamera;
  private readonly frameCam: THREE.PerspectiveCamera;
  private readonly fillRT: THREE.WebGLRenderTarget;
  private readonly blit: { scene: THREE.Scene; camera: THREE.Camera; material: THREE.ShaderMaterial };
  private readonly clear = new THREE.Color();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly width: number,
    private readonly height: number,
  ) {
    const aspect = width / height;
    this.worldCam = new THREE.PerspectiveCamera(FOV, aspect, 0.1, 80);
    this.frameCam = new THREE.PerspectiveCamera(FOV, aspect, 0.1, 80);
    this.fillRT = new THREE.WebGLRenderTarget(width, height, { depthBuffer: false });
    const material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `precision highp float; varying vec2 vUv; uniform sampler2D tMap; uniform float uFlash; void main() { gl_FragColor = vec4(mix(texture2D(tMap, vUv).rgb, vec3(1.0), uFlash), 1.0); }`,
      uniforms: { tMap: { value: null }, uFlash: { value: 0 } },
      depthTest: false,
      depthWrite: false,
    });
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    mesh.frustumCulled = false;
    scene.add(mesh);
    this.blit = { scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), material };
  }

  get shots(): { shot: Shot; curve: ShotCurve; palette: ShotPalette }[] {
    return this.rigs;
  }

  build(o: StageOptions) {
    this.dispose();
    this.errors = [];
    this.seq = o.seq;
    const { seq } = o;
    const curves = planFootage(
      seq,
      o.clips.map((c) => c.duration),
    );
    const { halfW, halfH } = frameSize(this.width / this.height);
    const footageShots = seq.shots.filter((s) => s.kind === 'footage');
    const clipOf = (s: Shot) => o.clips[s.footageIndex % o.clips.length];

    for (const shot of seq.shots) {
      // a card takes the colours of the footage it leads into; a look, of the footage it follows
      const neighbour = shot.kind === 'card' ? (footageShots.find((s) => s.start >= shot.end) ?? footageShots[0]) : ([...footageShots].reverse().find((s) => s.end <= shot.start) ?? footageShots[0]);
      const clip = shot.kind === 'footage' ? clipOf(shot) : null;
      const palette = (clip ?? clipOf(neighbour)).palette;
      const curve = curves[shot.index];

      let look: LookPlayer | null = null;
      const lookId = shot.kind === 'look' ? o.lookId : shot.kind === 'footage' && shot.treat === 'look' ? o.fillId : '';
      if (lookId) {
        try {
          look = new LookPlayer(this.renderer, lookId, this.width, this.height, o.analysis, asLookPalette(palette));
          look.start(shot.start);
        } catch (err) {
          this.errors.push(`look "${lookId}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const world = new THREE.Group();
      const frame = new THREE.Group();
      world.visible = frame.visible = false;
      this.worldScene.add(world);
      this.frameScene.add(frame);
      const motifs: Motif[] = [];
      shot.motifs.forEach((id, j) => {
        const make = MOTIFS[id];
        if (!make) {
          this.errors.push(`no motif called "${id}"`);
          return;
        }
        const ctx: MotifContext = {
          halfW,
          halfH,
          width: this.width,
          height: this.height,
          palette,
          beat: seq.beat,
          start: shot.start,
          end: shot.end,
          kicks: seq.kicks,
          snares: seq.snares,
          travel: curve.travel,
          depth: curve.depth,
          rnd: dice(shot.index * 101 + j * 17 + 3),
          fill: look && shot.kind === 'footage' ? this.fillRT.texture : null,
          word: shot.word,
          caption: o.caption,
          arrive: shot.arrive,
          leave: shot.leave,
          freeze: curve.freeze,
          run: { start: seq.start, hit: seq.hit, end: seq.end },
        };
        const m = make(ctx);
        (m.space === 'world' ? world : frame).add(m.object);
        motifs.push(m);
      });
      this.rigs.push({ shot, curve, palette, clip, look, world, frame, motifs });
    }
  }

  private rigAt(t: number): Rig {
    return this.rigs.find((r) => t < r.shot.end) ?? this.rigs[this.rigs.length - 1];
  }

  /** Live: keep the clip on screen where its curve wants it, and have the next shot's clip waiting on its first frame */
  follow(t: number, playing: boolean) {
    if (!this.rigs.length) return;
    const rig = this.rigAt(t);
    const mine = rig.clip?.footage ?? null;
    mine?.follow(rig.curve.footage(t), rig.curve.rate(t), playing);
    const next = this.rigs.find((r) => r.shot.index > rig.shot.index && r.clip?.footage);
    const theirs = next?.clip?.footage;
    if (next && theirs && theirs !== mine && next.shot.start - t < 2.5) theirs.follow(next.curve.footage(next.shot.start), 0, false);
  }

  /** how far the clip on screen is from where its curve wants it (s), or null when the shot has no clip */
  drift(t: number): number | null {
    if (!this.rigs.length) return null;
    const rig = this.rigAt(t);
    const f = rig.clip?.footage;
    return f ? f.video.currentTime - rig.curve.footage(t) : null;
  }

  /** Stills: put the clip on screen on exactly the right frame, and wait for it */
  async settle(t: number) {
    if (!this.rigs.length) return;
    const rig = this.rigAt(t);
    await rig.clip?.footage?.seek(rig.curve.footage(t));
  }

  private footageState(rig: Rig, t: number): FootageState {
    const { shot, curve } = rig;
    const beat = this.seq!.beat;
    const tau = t - shot.start;
    const u = tau / beat;
    const hit = shot.arrive === 'hit';
    const treated = shot.treat !== 'clean';
    const ramp = shot.leave === 'ramp' ? clamp01((t - (shot.end - 4 * beat)) / (4 * beat)) : 0;
    const settle = shot.leave === 'settle' ? smooth(shot.end - beat * 2.5, shot.end - beat * 0.5, t) : 0;
    // the colours step round the bands once a beat for the first bar, then every other beat
    const base = u < 4 ? u : 4 + (u - 4) / 2;
    const n = Math.floor(base);
    const sinceStep = (base - n) * (u < 4 ? 1 : 2);
    return {
      treat: treated ? smooth(0, 0.18, tau) * (1 - settle) : 0,
      shift: treated ? n - 1 + easeOutCubic(clamp01(sinceStep / 0.22)) : 0,
      blur: clamp01((curve.speed(t) - 1.2) / 2.2),
      punch: (hit ? 0.16 * Math.exp(-tau / 0.35) : 0) + 0.12 * easeInCubic(ramp),
      flash: hit ? (tau < 1 / 30 ? 1 : 0.55 * Math.exp(-(tau - 1 / 30) / 0.06)) : 0,
      flip: curve.flip,
      keep: shot.treat === 'look' ? LOOK_BANDS : BANDS,
      fill: shot.treat === 'look' ? LOOK_FILL : NONE,
    };
  }

  private copy(texture: THREE.Texture, target: THREE.WebGLRenderTarget | null, flash = 0) {
    this.blit.material.uniforms.tMap.value = texture;
    this.blit.material.uniforms.uFlash.value = flash;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.blit.scene, this.blit.camera);
    this.renderer.setRenderTarget(null);
  }

  /** `focus` is 0..1 from the bottom-left of the picture */
  draw(t: number, focus: { x: number; y: number }) {
    const r = this.renderer;
    if (!this.rigs.length || !this.seq) return;
    const rig = this.rigAt(t);
    const { shot, curve, palette } = rig;
    if (rig !== this.active) {
      for (const other of this.rigs) other.world.visible = other.frame.visible = other === rig;
      this.pass.setPalette(palette);
      if (rig.clip) this.pass.setSource(rig.clip.texture, rig.clip.aspect);
      this.active = rig;
    }
    const tau = t - shot.start;
    const beat = this.seq.beat;

    // the bed
    rig.look?.render(t);
    r.setRenderTarget(null);
    r.setClearColor(this.clear.set(shot.kind === 'card' ? palette.ink : palette.paper), 1);
    r.clear(true, true, false);
    if (shot.kind === 'footage') {
      if (rig.look) this.copy(rig.look.texture, this.fillRT);
      this.pass.render(r, this.width, this.height, focus, this.footageState(rig, t), rig.look ? this.fillRT.texture : null);
    } else if (shot.kind === 'look' && rig.look) {
      this.copy(rig.look.texture, null, tau < 1 / 30 ? 0.6 : 0);
    }

    // the camera pushes in as a shot speeds up into its cut, and snaps back on a hit
    const ramp = shot.leave === 'ramp' ? clamp01((t - (shot.end - 4 * beat)) / (4 * beat)) : 0;
    const push = -0.8 * easeInCubic(ramp) + (shot.arrive === 'hit' ? 0.55 * Math.exp(-tau / 0.28) : 0);
    const { halfW, halfH } = frameSize(this.width / this.height);
    this.worldCam.position.set(halfW * 0.09 * Math.sin(t * 0.5), halfH * 0.05 * Math.sin(t * 0.37 + 1), CAM_Z + push);
    this.worldCam.lookAt(0, 0, 0);
    this.frameCam.position.set(0, 0, CAM_Z + push * 0.35);

    const travel = curve.travel(t);
    const f: MotifFrame = { t, travel, rush: clamp01((curve.speed(t) - 1) / 2.4), focusX: (focus.x * 2 - 1) * halfW, focusY: (focus.y * 2 - 1) * halfH, camera: this.worldCam };
    for (const m of rig.motifs) m.update(f);
    rig.world.position.z = travel;
    r.clearDepth();
    r.render(this.worldScene, this.worldCam);
    r.render(this.frameScene, this.frameCam);
  }

  dispose() {
    for (const rig of this.rigs) {
      for (const m of rig.motifs) m.dispose();
      rig.look?.dispose();
      this.worldScene.remove(rig.world);
      this.frameScene.remove(rig.frame);
    }
    this.rigs = [];
    this.active = null;
  }
}
