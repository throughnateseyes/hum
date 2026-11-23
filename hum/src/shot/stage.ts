/**
 * Draws a run of shots (see src/shot/sequence.ts; used by the footage looks and src/dev/shot.ts).
 *
 * For any song time it finds the shot on screen and draws, back to front:
 *   the mask   the style's windows (red and green), when it cuts any
 *   the bed    the footage, region by region in the tones the style asks for; one of Hum's looks full
 *              frame; or a flat ink card
 *   the frame  the style's shapes and type, pinned to the picture on its grid
 *
 * Every shot has its own colours (a footage shot's come from its clip; a card or a look borrows the
 * colours of the footage next to it), its own style arrangement and its own speed curve.
 */
import * as THREE from 'three';
import { dryRun } from '../render/warmup';
import { FULLSCREEN_VERT } from '../core/glsl';
import type { Palette, TrackAnalysis } from '../core/types';
import type { Footage, FootageState } from './footage';
import { FootagePass } from './footage';
import { frameGrid } from './grid';
import { CAM_Z, FOV, frameSize, toneOf, type Bed, type Labels, type StyleContext, type StyleShot } from './kit';
import { LookPlayer } from './lookPlayer';
import { schemeFor, type Scheme, type ShotPalette } from './palette';
import { planFootage, type Sequence, type Shot, type ShotCurve } from './sequence';
import { STYLES } from './styles';
import { clamp01, dice, easeInCubic, smooth } from './time';
import type { TreatmentId } from './treatments';
import { unit, type TreatFrame } from './treatments/common';
import type { MoshPlan, MoshSegment } from './treatments/mosh';
import { TreatPass } from './treatments/pass';

export interface StageClip {
  /** the video behind it; null for a still stand-in picture */
  footage: Footage | null;
  texture: THREE.Texture;
  aspect: number;
  /** seconds (a still lasts for ever) */
  duration: number;
  palette: ShotPalette;
  /** a still of a video clip (its library thumbnail), for a treatment that cuts fragments of it (Collage) */
  still?: THREE.Texture | null;
}

export interface StageOptions {
  seq: Sequence;
  analysis: TrackAnalysis;
  /** at least one; footage shots take them in turn */
  clips: StageClip[];
  /** the song's title, for small type */
  title: string;
  /** the built-in look a 'look' shot cuts to full frame */
  lookId: string;
  /** false inside the app, where the store already knows the song (the dev page has to tell it) */
  tellStore?: boolean;
  /**
   * The shot's own clip opened a second time, for a style that shows two moments of it at once (Split)
   * when there is only one clip. `index` is the clip's place in `clips`. Null: no second player.
   */
  echo?: (index: number) => StageClip | null;
  /** true inside the app: a look starts from the moment it is first drawn, not from the start of its
   *  shot (replaying seconds of a look to catch up would stall the cut) */
  live?: boolean;
  /** the footage shot just before this run, when it is one (a moshed cut is pushed by its motion) */
  before?: { start: number; end: number; layout: number; treatment: TreatmentId };
}

interface Rig {
  shot: Shot;
  curve: ShotCurve;
  palette: ShotPalette;
  scheme: Scheme;
  clip: StageClip | null;
  /** the second clip some of the style's regions show (Split), or null */
  alt: StageClip | null;
  look: LookPlayer | null;
  frame: THREE.Group;
  mask: THREE.Group | null;
  style: StyleShot | null;
  /** how the picture is broken down ('none' for a card or a look) */
  treatment: TreatmentId;
  /** Collage: the pictures its fragments are cut from */
  pieces: StageClip[];
}

/** the shot's colours as one of Hum's palettes, so a look can be dressed in them */
const asLookPalette = (s: Scheme): Palette => ({ id: 'shot', name: 'shot', bg: s.paper, fg: s.ink, accent: s.accent, accent2: s.second, muted: s.mid });

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export class ShotStage {
  /** anything that went wrong building the shots (an unknown look id, a look that failed to start) */
  errors: string[] = [];
  /** which picture steers the clips live, when pictures share players (newer pictures get larger numbers) */
  who = 0;
  private rigs: Rig[] = [];
  private readonly looks: LookPool = new Map();
  private seq: Sequence | null = null;
  private active: Rig | null = null;
  private readonly pass = new FootagePass();
  private readonly frameScene = new THREE.Scene();
  private readonly maskScene = new THREE.Scene();
  private readonly frameCam: THREE.PerspectiveCamera;
  private maskRT: THREE.WebGLRenderTarget | null = null;
  private readonly blit: { scene: THREE.Scene; camera: THREE.Camera; material: THREE.ShaderMaterial };
  private readonly clear = new THREE.Color();
  private readonly black = new THREE.Color(0, 0, 0);
  private readonly bed: Bed = { tone: [0, 0, 0], rect: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()], zoom: [1, 1, 1], src: [0, 0, 0] };
  /** breaks a treated shot's picture down; made when a shot first needs it */
  private treat: TreatPass | null = null;
  private analysis: TrackAnalysis | null = null;
  private labels: Labels = { title: '', part: '', time: '', tempo: '' };

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly width: number,
    private readonly height: number,
  ) {
    this.frameCam = new THREE.PerspectiveCamera(FOV, width / height, 0.1, 80);
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

  get shots(): { shot: Shot; curve: ShotCurve; palette: ShotPalette; scheme: Scheme }[] {
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
    const grid = frameGrid(halfW, halfH);
    const footageShots = seq.shots.filter((s) => s.kind === 'footage');
    const clipOf = (s: Shot) => o.clips[s.footageIndex % o.clips.length];
    const altOf = (s: Shot): StageClip | null => {
      if (s.kind !== 'footage' || s.alt === undefined) return null;
      const i = s.alt % o.clips.length;
      return s.altEcho ? (o.echo?.(i) ?? null) : o.clips[i];
    };
    const labels: Labels = { title: o.title, part: seq.part, time: clock(seq.partStart), tempo: `${Math.round(60 / seq.beat)} BPM` };
    this.labels = labels;
    this.analysis = o.analysis;

    for (const shot of seq.shots) {
      // a card takes the colours of the footage it leads into; a look, of the footage it follows
      const neighbour = shot.kind === 'card' ? (footageShots.find((s) => s.start >= shot.end) ?? footageShots[0]) : ([...footageShots].reverse().find((s) => s.end <= shot.start) ?? footageShots[0]);
      const clip = shot.kind === 'footage' ? clipOf(shot) : null;
      const alt = altOf(shot);
      const palette = (clip ?? (neighbour ? clipOf(neighbour) : o.clips[0])).palette;
      const scheme = schemeFor(palette);
      const curve = curves[shot.index];

      // one player per look, kept from one build to the next: starting a look costs a scene and its
      // render targets, and a part of the song should not pay that again
      let look: LookPlayer | null = null;
      if (shot.kind === 'look' && o.lookId) {
        // in the app the players are shared by every stage on this renderer (a new look instance is
        // made at every cut, and each would otherwise start the look again); elsewhere, by this stage
        const pool = o.live ? sharedLooks(this.renderer) : this.looks;
        const key = `${o.lookId}|${this.width}x${this.height}`;
        const had = pool.get(key);
        look = had && had.analysis === o.analysis ? had.look : null;
        if (!look) {
          try {
            had?.look.dispose();
            look = new LookPlayer(this.renderer, o.lookId, this.width, this.height, o.analysis, asLookPalette(scheme), o.tellStore ?? true);
            if (o.live) look.catchUp = 0;
            else look.start(shot.start);
            pool.set(key, { look, analysis: o.analysis });
          } catch (err) {
            look = null;
            pool.delete(key);
            this.errors.push(`look "${o.lookId}": ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      const frame = new THREE.Group();
      frame.visible = false;
      this.frameScene.add(frame);
      let style: StyleShot | null = null;
      let mask: THREE.Group | null = null;
      const factory = shot.kind === 'card' ? STYLES.card : shot.kind === 'footage' && shot.style ? STYLES[shot.style] : null;
      if (factory) {
        const ctx: StyleContext = {
          halfW,
          halfH,
          width: this.width,
          height: this.height,
          grid,
          scheme,
          beat: seq.beat,
          start: shot.start,
          end: shot.end,
          partStart: seq.partStart,
          layout: shot.layout,
          rnd: dice(shot.layout + 7),
          words: seq.words,
          word: shot.word,
          labels,
          tone: toneOf(shot.colour),
          colour: shot.colour,
          energy: seq.energy,
          arrive: shot.arrive,
          leave: shot.leave,
          freeze: curve.freeze,
          clipFrom: curve.footage(shot.start),
          altFrom: alt ? (shot.altFrom ?? (curve.footage(shot.start) + alt.duration * 0.5) % Math.max(0.25, alt.duration - 0.25)) : null,
        };
        try {
          style = factory(ctx);
          frame.add(style.object);
          if (style.mask) {
            mask = new THREE.Group();
            mask.visible = false;
            mask.add(style.mask);
            this.maskScene.add(mask);
          }
        } catch (err) {
          style = null;
          this.errors.push(`style "${shot.style || shot.kind}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const treatment: TreatmentId = shot.kind === 'footage' ? (shot.treatment ?? 'none') : 'none';
      const pieces = treatment === 'collage' ? (shot.extra ?? []).map((i) => o.clips[i % o.clips.length]).filter((c) => c && c !== clip) : [];
      this.rigs.push({ shot, curve, palette, scheme, clip, alt, look, frame, mask, style, treatment, pieces });
    }
    if (this.rigs.some((r) => r.treatment !== 'none')) {
      this.treat ??= new TreatPass(this.renderer, this.width, this.height);
      const b = o.before;
      this.treat.setMoshPlan(this.moshPlan(o), `${seq.start}|${seq.end}|${seq.shots.map((x) => `${x.start}:${x.layout}:${x.treatment ?? ''}`).join(',')}|${b ? `${b.start}:${b.layout}:${b.treatment}` : ''}`);
    }
  }

  /** the timeline the mosh's drag field is worked along: the shot before this run, and its shots */
  private moshPlan(o: StageOptions): MoshPlan {
    const a = o.analysis;
    const seq = o.seq;
    const segments: MoshSegment[] = [];
    if (o.before && o.before.end <= seq.start + 0.05) segments.push({ start: o.before.start, end: o.before.end, layout: o.before.layout, mosh: o.before.treatment === 'mosh', speed: () => 1 });
    for (const r of this.rigs) {
      if (r.shot.kind !== 'footage') continue;
      segments.push({ start: r.shot.start, end: r.shot.end, layout: r.shot.layout, mosh: r.treatment === 'mosh', speed: (t) => r.curve.speed(t) });
    }
    let kicks = (a.layers?.kick ?? []).filter((k, i, all) => i === 0 || k - all[i - 1] > seq.beat * 0.45);
    if (kicks.length < 4) kicks = seq.kicks;
    return { segments, beat: seq.beat, kicks, loud: (t) => loudAt(a, t) };
  }

  private rigAt(t: number): Rig {
    return this.rigs.find((r) => t < r.shot.end) ?? this.rigs[this.rigs.length - 1];
  }

  /** Live: keep the clip on screen where its curve wants it, and have the next shot's clip waiting on its first frame */
  follow(t: number, playing: boolean) {
    if (!this.rigs.length) return;
    const rig = this.rigAt(t);
    const mine = rig.clip?.footage ?? null;
    mine?.follow(rig.curve.footage(t), rig.curve.rate(t), playing, this.who);
    const second = rig.alt?.footage ?? null;
    if (second && second !== mine) second.follow(this.altTime(rig, t), rig.curve.rate(t), playing, this.who);
    const next = this.rigs.find((r) => r.shot.index > rig.shot.index && r.clip?.footage);
    const theirs = next?.clip?.footage;
    if (next && theirs && theirs !== mine && theirs !== second && next.shot.start - t < 2.5) theirs.follow(next.curve.footage(next.shot.start), 0, false, this.who);
  }

  /** the players follow() is steering at song time t (the shot's clips, and the next shot's when cued) */
  steering(t: number): Set<Footage> {
    const out = new Set<Footage>();
    if (!this.rigs.length) return out;
    const rig = this.rigAt(t);
    if (rig.clip?.footage) out.add(rig.clip.footage);
    if (rig.alt?.footage) out.add(rig.alt.footage);
    const next = this.rigs.find((r) => r.shot.index > rig.shot.index && r.clip?.footage);
    if (next?.clip?.footage && next.shot.start - t < 2.5) out.add(next.clip.footage);
    return out;
  }

  /** which second of the second clip is on screen */
  private altTime(rig: Rig, t: number): number {
    if (rig.shot.altFrom !== undefined) return rig.curve.alt(t);
    // a second clip the run didn't place (a section cut by the scene itself): half way along it
    const d = Math.max(0.5, rig.alt?.duration ?? 1);
    return (rig.curve.footage(t) + d * 0.5) % (d - 0.25);
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
    const second = rig.alt?.footage;
    await Promise.all([rig.clip?.footage?.seek(rig.curve.footage(t)), second && second !== rig.clip?.footage ? second.seek(this.altTime(rig, t)) : undefined]);
  }

  private footageState(rig: Rig, t: number): FootageState {
    const { shot, curve } = rig;
    const tau = t - shot.start;
    const beat = this.seq!.beat;
    const hit = shot.arrive === 'hit';
    const ramp = shot.leave === 'ramp' ? clamp01((t - (shot.end - shot.rampBeats * beat)) / (shot.rampBeats * beat)) : 0;
    const settle = shot.leave === 'settle' ? smooth(shot.end - beat * 2.5, shot.end - beat * 0.5, t) : 0;
    return {
      // a shot opens on the clip as it is and takes its colours within the first fifth of a second
      treat: smooth(0, 0.18, tau - curve.freeze) * (1 - settle),
      blur: clamp01((curve.speed(t) - 1.2) / 2.2),
      punch: (hit ? 0.12 * Math.exp(-tau / 0.3) : 0) + 0.1 * easeInCubic(ramp),
      // a full white-out only where the part lands; the cuts on the beat inside a loud part get a glint
      flash: hit ? (tau < 1 / 30 ? 1 : 0.5 * Math.exp(-(tau - 1 / 30) / 0.05)) * (Math.abs(shot.start - this.seq!.hit) < 1e-3 ? 1 : 0.3) : 0,
      flip: curve.flip,
      ...this.stillMotion(rig, t),
    };
  }

  /**
   * A still never stands frozen: it pushes in slowly and drifts, faster where the shot speeds up (the
   * curve's clip seconds, which run with the speed), in a direction its arrangement picks.
   */
  private stillMotion(rig: Rig, t: number): { grow: number; drift: [number, number] } {
    if (!rig.clip || rig.clip.footage) return { grow: 1, drift: [0, 0] };
    const { shot, curve } = rig;
    const run = Math.max(0, curve.footage(t) - curve.footage(shot.start)) + Math.max(0, t - shot.start) * 0.25;
    const grow = 1 + Math.min(0.22, run * 0.016);
    const a = unit(shot.layout, 17) * Math.PI * 2;
    // the drift stays inside the room the push-in makes, so the picture never runs off its edge
    const room = (1 - 1 / grow) * 0.45;
    return { grow, drift: [Math.cos(a) * room, Math.sin(a) * room] };
  }

  private copy(texture: THREE.Texture, target: THREE.WebGLRenderTarget | null, flash = 0) {
    this.blit.material.uniforms.tMap.value = texture;
    this.blit.material.uniforms.uFlash.value = flash;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.blit.scene, this.blit.camera);
  }

  private maskTarget(): THREE.WebGLRenderTarget {
    this.maskRT ??= new THREE.WebGLRenderTarget(this.width, this.height, { depthBuffer: false });
    return this.maskRT;
  }

  /**
   * Draw song time `t` into `target` (the canvas when null). `focus` is 0..1 from the bottom-left of
   * the picture; `zoom` pushes the picture in (1 fits the frame).
   */
  draw(t: number, focus: { x: number; y: number }, target: THREE.WebGLRenderTarget | null = null, zoom = 1) {
    const r = this.renderer;
    if (!this.rigs.length || !this.seq) return;
    const rig = this.rigAt(t);
    const { shot, scheme } = rig;
    if (rig !== this.active) {
      for (const other of this.rigs) {
        other.frame.visible = other === rig;
        if (other.mask) other.mask.visible = other === rig;
      }
      this.pass.setScheme(scheme);
      if (rig.clip) this.pass.setSource(rig.clip.texture, rig.clip.aspect);
      this.pass.setAlt(rig.alt?.texture ?? null, rig.alt?.aspect ?? 1);
      rig.look?.setPalette(asLookPalette(scheme));
      this.active = rig;
    }
    const tau = t - shot.start;
    const beat = this.seq.beat;

    // the camera pushes in a little as a shot speeds up into its cut, and snaps back on a hit; the
    // frame's graphics ride it, so they land with the picture
    const ramp = shot.leave === 'ramp' ? clamp01((t - (shot.end - shot.rampBeats * beat)) / (shot.rampBeats * beat)) : 0;
    const push = -0.25 * easeInCubic(ramp) + (shot.arrive === 'hit' ? 0.3 * Math.exp(-tau / 0.25) : 0);
    this.frameCam.position.set(0, 0, CAM_Z + push);

    // the style places its graphics and says how the footage is drawn under them
    const bed = this.bed;
    bed.tone[0] = bed.tone[1] = bed.tone[2] = toneOf(shot.colour);
    for (const v of bed.rect) v.set(0, 0, 1, 1);
    bed.zoom[0] = bed.zoom[1] = bed.zoom[2] = 1;
    bed.src[0] = bed.src[1] = bed.src[2] = 0;
    rig.style?.update({ t, focusU: focus.x, focusV: focus.y }, bed);

    const autoClear = r.autoClear;
    r.autoClear = false;
    let mask: THREE.Texture | null = null;
    if (rig.mask && shot.kind === 'footage') {
      const m = this.maskTarget();
      r.setRenderTarget(m);
      r.setClearColor(this.black, 1);
      r.clear(true, false, false);
      r.render(this.maskScene, this.frameCam);
      mask = m.texture;
    }

    // the bed
    rig.look?.render(t);
    r.setRenderTarget(target);
    r.setClearColor(this.clear.set(shot.kind === 'card' ? scheme.ink : scheme.paper), 1);
    r.clear(true, true, false);
    if (shot.kind === 'footage' && rig.treatment !== 'none' && this.treat) {
      // a treated shot: the bed goes to the treatment, which breaks it down into the target
      const state = this.footageState(rig, t);
      const flash = state.flash;
      state.flash = 0;
      r.setRenderTarget(this.treat.bedTarget());
      r.clear(true, false, false);
      this.pass.render(r, this.width, this.height, focus, state, bed, mask, { zoom, alpha: true, raw: rig.treatment === 'cells' || rig.treatment === 'readout' });
      const pictures = rig.pieces.map((c) => ({ texture: c.still ?? c.texture, aspect: c.aspect }));
      this.treat.render(rig.treatment, this.treatFrame(rig, t, focus, flash), target, { still: !rig.clip?.footage, pictures });
      r.setRenderTarget(target);
    } else if (shot.kind === 'footage') {
      this.pass.render(r, this.width, this.height, focus, this.footageState(rig, t), bed, mask, { zoom, alpha: false, raw: false });
    } else if (shot.kind === 'look' && rig.look) {
      this.copy(rig.look.texture, target, tau < 1 / 30 ? 0.6 : 0);
    }

    // the frame
    r.clearDepth();
    r.render(this.frameScene, this.frameCam);
    r.autoClear = autoClear;
  }

  private treatFrame(rig: Rig, t: number, focus: { x: number; y: number }, flash: number): TreatFrame {
    const seq = this.seq!;
    const { shot } = rig;
    return {
      t,
      tau: t - shot.start,
      beat: seq.beat,
      shotStart: shot.start,
      shotEnd: shot.end,
      partStart: seq.partStart,
      layout: shot.layout,
      kicks: seq.kicks,
      snares: seq.snares,
      hats: seq.hats ?? seq.kicks,
      loud: this.analysis ? loudAt(this.analysis, t) : seq.energy,
      scheme: rig.scheme,
      palette: rig.palette,
      colour: shot.colour,
      flash,
      labels: this.labels,
      focus,
      speed: rig.curve.speed(t),
    };
  }

  /** how many drag-field ticks the last moshed frame worked (for checks) */
  get moshTicks(): number {
    return this.treat?.mosh.lastTicks ?? 0;
  }

  /** Draw every shot once into `target`: compiles everything the shots are made of */
  drawAll(target: THREE.WebGLRenderTarget) {
    for (const rig of this.rigs) this.draw(rig.shot.start + (rig.shot.end - rig.shot.start) * 0.5, { x: 0.5, y: 0.5 }, target);
  }

  /** free what the stage itself holds (after dispose(), when the stage is finished with) */
  release() {
    for (const { look } of this.looks.values()) look.dispose();
    this.looks.clear();
    this.maskRT?.dispose();
    this.maskRT = null;
    this.blit.material.dispose();
    this.treat?.dispose();
    this.treat = null;
  }

  dispose() {
    for (const rig of this.rigs) {
      rig.style?.dispose();
      this.frameScene.remove(rig.frame);
      if (rig.mask) this.maskScene.remove(rig.mask);
    }
    this.rigs = [];
    this.active = null;
  }
}

/** how loud the song is at t, 0..1 (its energy curve) */
export function loudAt(a: TrackAnalysis, t: number): number {
  const e = a.energyCurve;
  if (!e?.length || !a.duration) return 0.5;
  const x = Math.min(e.length - 1, Math.max(0, (t / a.duration) * e.length));
  const i = Math.floor(x);
  const j = Math.min(e.length - 1, i + 1);
  return Math.min(1, Math.max(0, e[i] + (e[j] - e[i]) * (x - i)));
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
 * without this each part would compile its styles again and the cut would stall. A small stage with
 * one shot of every style (and a card) is drawn once and then held on to for as long as the renderer
 * lives.
 *
 * Inside the app's warm-up (render/warmup.ts, dryRun) the draw calls become background compiles.
 */
export function warmShots(renderer: THREE.WebGLRenderer, analysis: TrackAnalysis, clip: StageClip) {
  if (anchors.has(renderer)) return;
  const stage = new ShotStage(renderer, 96, 96);
  const target = new THREE.WebGLRenderTarget(96, 96, { depthBuffer: true });
  anchors.set(renderer, { stage, target });
  const ids = Object.keys(STYLES).filter((id) => id !== 'card') as Shot['style'][];
  // one shot of every style, and one of every treatment (each on a style, so the pair compiles too)
  const treats: TreatmentId[] = ['mosh', 'sort', 'cells', 'readout', 'collage'];
  const shots: Shot[] = [
    ...ids.map((style, i): Shot => ({ index: 0, kind: 'footage', start: i, end: i + 1, footageIndex: 0, arrive: 'hit', leave: 'ramp', rampBeats: 1, colour: 'tinted', style, layout: i, word: 'HUM' })),
    ...treats.map((treatment, i): Shot => ({ index: 0, kind: 'footage', start: ids.length + i, end: ids.length + i + 1, footageIndex: 0, arrive: 'cold', leave: 'cut', rampBeats: 1, colour: 'clean', style: ids[i % ids.length], layout: i, word: 'HUM', treatment, extra: [0] })),
  ];
  shots.push({ index: 0, kind: 'card', start: shots.length, end: shots.length + 1, footageIndex: -1, arrive: 'cold', leave: 'cut', rampBeats: 1, colour: 'clean', style: '', layout: 0, word: 'HUM HUM' });
  shots.forEach((s, i) => (s.index = i));
  const end = shots.length;
  try {
    stage.build({ seq: { start: 0, hit: 0, end, beat: 0.25, kicks: [], snares: [], hats: [], shots, part: 'HUM', partStart: 0, energy: 0.8, words: ['HUM'] }, analysis, clips: [clip], title: 'HUM', lookId: '', tellStore: false, live: true });
    const was = renderer.getRenderTarget();
    // compile in the background (KHR_parallel_shader_compile) rather than on this frame: every style and
    // treatment at once is dozens of programs, which on Windows/Direct3D can hold a frame for seconds.
    // The warm stage stays anchored to the renderer, so the programs stay alive for the real shots.
    void dryRun(renderer, () => stage.drawAll(target));
    renderer.setRenderTarget(was);
  } catch (err) {
    console.warn('[hum] could not warm the footage shots', err);
  }
}
