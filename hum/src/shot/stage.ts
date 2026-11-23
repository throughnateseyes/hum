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
  /** false inside the app, where the store already knows the song (the dev page has to tell it) */
  tellStore?: boolean;
  /** true inside the app: a look that shows through starts from the moment it is first drawn, not from
   *  the start of its shot (replaying seconds of a look to catch up would stall the cut) */
  live?: boolean;
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
  private readonly looks: LookPool = new Map();
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

      // one player per look, kept from one build to the next: starting a look costs a scene and its
      // render targets, and a part of the song should not pay that again
      let look: LookPlayer | null = null;
      const lookId = shot.kind === 'look' ? o.lookId : shot.kind === 'footage' && shot.treat === 'look' ? o.fillId : '';
      if (lookId) {
        // in the app the players are shared by every footage look on this renderer (a new look instance
        // is made at every cut, and each would otherwise start the look again); elsewhere, by this stage
        const pool = o.live ? sharedLooks(this.renderer) : this.looks;
        const key = `${lookId}|${this.width}x${this.height}`;
        const had = pool.get(key);
        look = had && had.analysis === o.analysis ? had.look : null;
        if (!look) {
          try {
            had?.look.dispose();
            look = new LookPlayer(this.renderer, lookId, this.width, this.height, o.analysis, asLookPalette(palette), o.tellStore ?? true);
            if (o.live) look.catchUp = 0;
            else look.start(shot.start);
            pool.set(key, { look, analysis: o.analysis });
          } catch (err) {
            look = null;
            pool.delete(key);
            this.errors.push(`look "${lookId}": ${err instanceof Error ? err.message : String(err)}`);
          }
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
          rnd: dice(Math.round(shot.start * 37) + shot.index * 101 + j * 17 + 3),
          fill: look && shot.kind === 'footage' ? this.fillRT.texture : null,
          word: shot.word,
          caption: o.caption,
          arrive: shot.arrive,
          leave: shot.leave,
          freeze: curve.freeze,
          rampBeats: shot.rampBeats,
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
    const ramp = shot.leave === 'ramp' ? clamp01((t - (shot.end - shot.rampBeats * beat)) / (shot.rampBeats * beat)) : 0;
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
  }

  /** Draw song time `t` into `target` (the canvas when null). `focus` is 0..1 from the bottom-left of the picture. */
  draw(t: number, focus: { x: number; y: number }, target: THREE.WebGLRenderTarget | null = null) {
    const r = this.renderer;
    if (!this.rigs.length || !this.seq) return;
    const rig = this.rigAt(t);
    const { shot, curve, palette } = rig;
    if (rig !== this.active) {
      for (const other of this.rigs) other.world.visible = other.frame.visible = other === rig;
      this.pass.setPalette(palette);
      if (rig.clip) this.pass.setSource(rig.clip.texture, rig.clip.aspect);
      rig.look?.setPalette(asLookPalette(palette));
      this.active = rig;
    }
    const tau = t - shot.start;
    const beat = this.seq.beat;

    // the bed
    const autoClear = r.autoClear;
    r.autoClear = false;
    rig.look?.render(t);
    if (shot.kind === 'footage' && rig.look) this.copy(rig.look.texture, this.fillRT);
    r.setRenderTarget(target);
    r.setClearColor(this.clear.set(shot.kind === 'card' ? palette.ink : palette.paper), 1);
    r.clear(true, true, false);
    if (shot.kind === 'footage') {
      this.pass.render(r, this.width, this.height, focus, this.footageState(rig, t), rig.look ? this.fillRT.texture : null);
    } else if (shot.kind === 'look' && rig.look) {
      this.copy(rig.look.texture, target, tau < 1 / 30 ? 0.6 : 0);
    }

    // the camera pushes in as a shot speeds up into its cut, and snaps back on a hit
    const ramp = shot.leave === 'ramp' ? clamp01((t - (shot.end - shot.rampBeats * beat)) / (shot.rampBeats * beat)) : 0;
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
    r.autoClear = autoClear;
  }

  /** Draw every shot once into `target`: compiles everything the shots are made of */
  drawAll(target: THREE.WebGLRenderTarget) {
    for (const rig of this.rigs) this.draw(rig.shot.start + (rig.shot.end - rig.shot.start) * 0.5, { x: 0.5, y: 0.5 }, target);
  }

  /** free what the stage itself holds (after dispose(), when the stage is finished with) */
  release() {
    for (const { look } of this.looks.values()) look.dispose();
    this.looks.clear();
    this.fillRT.dispose();
    this.blit.material.dispose();
  }

  dispose() {
    for (const rig of this.rigs) {
      for (const m of rig.motifs) m.dispose();
      this.worldScene.remove(rig.world);
      this.frameScene.remove(rig.frame);
    }
    this.rigs = [];
    this.active = null;
  }
}

/* ───────── compiled once, kept ───────── */

/** look players by look id and size, with the song each was started for */
type LookPool = Map<string, { look: LookPlayer; analysis: TrackAnalysis }>;
const lookPools = new WeakMap<THREE.WebGLRenderer, LookPool>();
/** the look players every stage on this renderer shares; they live as long as the renderer does */
function sharedLooks(renderer: THREE.WebGLRenderer): LookPool {
  let pool = lookPools.get(renderer);
  if (!pool) lookPools.set(renderer, (pool = new Map()));
  return pool;
}

const anchors = new WeakMap<THREE.WebGLRenderer, { stage: ShotStage; target: THREE.WebGLRenderTarget }>();

/**
 * Compile, once per renderer, every shader a shot can use, and keep them: three.js frees a program
 * when the last material using it is disposed, and shots are rebuilt for every part of the song, so
 * without this each part would compile its motifs again and the cut would stall. A small stage with
 * one of everything is drawn once and then held on to for as long as the renderer lives.
 *
 * Inside the app's warm-up (render/warmup.ts, dryRun) the draw calls become background compiles.
 */
export function warmShots(renderer: THREE.WebGLRenderer, analysis: TrackAnalysis, clip: StageClip, fillId: string) {
  if (anchors.has(renderer)) return;
  const stage = new ShotStage(renderer, 96, 96);
  const target = new THREE.WebGLRenderTarget(96, 96, { depthBuffer: true });
  anchors.set(renderer, { stage, target });
  const shot = (kind: Shot['kind'], start: number, end: number, motifs: string[], rest: Partial<Shot> = {}): Shot => ({ index: 0, kind, start, end, footageIndex: kind === 'footage' ? 0 : -1, arrive: 'hit', leave: 'ramp', rampBeats: 2, treat: 'look', motifs, word: 'HUM', ...rest });
  const shots = [shot('footage', 0, 2, Object.keys(MOTIFS).filter((id) => id !== 'cardType' && id !== 'ruler')), shot('card', 2, 3, ['cardType'], { word: 'HUM HUM' })];
  shots.forEach((s, i) => (s.index = i));
  try {
    stage.build({ seq: { start: 0, hit: 0, end: 3, beat: 0.5, kicks: [0, 0.5, 1, 1.5], snares: [0.5, 1.5], shots }, analysis, clips: [clip], caption: 'HUM', lookId: fillId, fillId, tellStore: false, live: true });
    const was = renderer.getRenderTarget();
    stage.drawAll(target);
    renderer.setRenderTarget(was);
  } catch (err) {
    console.warn('[hum] could not warm the footage shots', err);
  }
}
