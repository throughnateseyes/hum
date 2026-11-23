/**
 * Footage: the person's own video clips as the picture, cut, coloured and sped up to the song.
 *
 * Each part of the song becomes a short run of shots (src/shot/sequence.ts, partSequence): the part
 * is cut on the beat, every cut moves to the next clip, a part that lands on a drop arrives with a
 * flash and a few frozen frames, loud parts speed up into their cuts, and the footage ramps into the
 * next part when that one hits. The graphics on top are drawn in one of a few styles (src/shot/styles:
 * Caption, Poster, Window, Slab, Grid, Split), placed on the frame's grid; "Auto" picks one per part,
 * and the Arrangement number lays the same style out another way. Colour sets how far the clips are
 * printed in the paper, ink and accent taken from them (src/shot/palette.ts).
 *
 * Clips come from the store (drop videos on the page, or Library → Footage). With none, the look
 * runs on the photos instead, as stills.
 *
 * Every picture that plays this look (the stage, a render, a window) opens its own players on the
 * clips, so they never fight over one. Live, a clip follows its speed curve by playback rate; in a
 * frame-by-frame render, prepare() puts it on the exact frame first.
 */
import * as THREE from 'three';
import type { ClipAsset, FrameContext, ParamDef, ParamValues, PhotoAsset, PrepareContext, SceneDef, SceneInit, SceneInstance, TrackAnalysis } from '../../core/types';
import { bool, num, str } from '../../core/uniforms';
import { Footage } from '../../shot/footage';
import { paletteFromPixels } from '../../shot/palette';
import type { Colour } from '../../shot/kit';
import { partSequence, type PartOptions } from '../../shot/sequence';
import { ShotStage, warmShots, type StageClip } from '../../shot/stage';
import { STYLE_IDS, STYLE_NAMES } from '../../shot/styles';
import { useStudio } from '../../state/store';

const params: ParamDef[] = [
  {
    id: 'style',
    label: 'Style',
    type: 'select',
    default: 'auto',
    hint: 'How the graphics sit on your clips. Auto picks one for each part of the song.',
    options: [{ value: 'auto', label: 'Auto' }, ...STYLE_IDS.map((id) => ({ value: id, label: STYLE_NAMES[id] }))],
  },
  { id: 'seed', label: 'Arrangement', type: 'number', min: 1, max: 999, step: 1, default: 1, hint: 'The same style laid out another way. Every number is a different arrangement.' },
  {
    id: 'colour',
    label: 'Colour',
    type: 'select',
    default: 'tinted',
    hint: 'How far your clips take on the colours of the graphics.',
    options: [
      { value: 'clean', label: 'Clean' },
      { value: 'tinted', label: 'Tinted' },
      { value: 'flat', label: 'Flat' },
    ],
  },
  {
    id: 'pace',
    label: 'Beats per shot',
    type: 'select',
    default: '8',
    options: [
      { value: '4', label: '4' },
      { value: '8', label: '8' },
      { value: '16', label: '16' },
    ],
  },
  { id: 'words', label: 'Title in type', type: 'bool', default: true },
  { id: 'focusX', label: 'Focus across', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
  { id: 'focusY', label: 'Focus up', type: 'number', min: 0, max: 1, step: 0.01, default: 0.55 },
];

/** looks saved before the styles carried the old settings: read them the nearest new way */
function colourOf(p: ParamValues): Colour {
  const c = str(p, 'colour', '');
  if (c === 'clean' || c === 'tinted' || c === 'flat') return c;
  const old = str(p, 'treat', '');
  return old === 'clean' ? 'clean' : old ? 'flat' : 'tinted';
}

/** how many clips one picture opens players for */
const MAX_OPEN = 6;

/** the song's title, without the artist */
function songTitle(): string {
  const name = useStudio.getState().track?.name ?? '';
  return (name.includes(' - ') ? name.split(' - ').slice(1).join(' - ') : name).replace(/\.[a-z0-9]{2,4}$/i, '').trim();
}

/** the song's title as words for the type, when no lyrics are being shown (the lyric layer owns those) */
function titleWords(): string[] {
  if (useStudio.getState().lyrics?.lines.length) return [];
  return songTitle()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .split(/[\s_\-–—]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}'’!?&]/gu, '').toUpperCase())
    .filter((w) => w.length > 0 && w.length <= 14)
    .slice(0, 4);
}

function stillClip(p: PhotoAsset): StageClip {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(p.image, 0, 0, 64, 64);
  return { footage: null, texture: p.texture, aspect: p.width / Math.max(1, p.height), duration: 1e6, palette: paletteFromPixels(g.getImageData(0, 0, 64, 64).data) };
}

class FootageLook implements SceneInstance {
  private readonly renderer: THREE.WebGLRenderer;
  private width: number;
  private height: number;
  private stage: ShotStage;
  /** the clips this picture has players open on, by clip id */
  private readonly open = new Map<string, { footage: Footage; ready: boolean }>();
  private deck: StageClip[] = [];
  private deckKey = '';
  /** what the stage was last built for: the part of the song, the look's settings and the clips */
  private builtKey = '';
  /** song time prepare() last put the clips on (a render), or null */
  private preparedFor: number | null = null;
  private readonly focus = { x: 0.5, y: 0.55 };

  constructor(init: SceneInit) {
    this.renderer = init.renderer;
    this.width = init.width;
    this.height = init.height;
    this.stage = new ShotStage(init.renderer, init.width, init.height);
  }

  /** The clips to cut between: the person's videos once their players are ready, else the photos as stills */
  private syncDeck(clips: ClipAsset[], photos: PhotoAsset[]) {
    const wanted = clips.slice(0, MAX_OPEN);
    for (const c of wanted) {
      if (this.open.has(c.id)) continue;
      const entry = { footage: new Footage(), ready: false };
      this.open.set(c.id, entry);
      entry.footage.load(c.url).then(
        () => {
          entry.ready = true;
        },
        () => this.open.delete(c.id),
      );
    }
    for (const [id, entry] of this.open) {
      if (wanted.some((c) => c.id === id)) continue;
      entry.footage.close();
      this.open.delete(id);
    }
    const ready = wanted.filter((c) => this.open.get(c.id)?.ready);
    const key = ready.length ? `c:${ready.map((c) => c.id).join(',')}` : `p:${photos.map((p) => p.id).join(',')}`;
    if (key === this.deckKey) return;
    this.deckKey = key;
    this.deck = ready.length
      ? ready.map((c) => {
          const f = this.open.get(c.id)!.footage;
          return { footage: f, texture: f.texture, aspect: f.aspect, duration: f.duration, palette: c.palette };
        })
      : photos.slice(0, MAX_OPEN).map(stillClip);
  }

  private partIndex(a: TrackAnalysis, t: number): number {
    const i = a.sections.findIndex((s) => t < s.end);
    return i < 0 ? a.sections.length - 1 : i;
  }

  /** (Re)build the shots when the song moves to another part, or the look's settings or the clips change */
  private sync(a: TrackAnalysis | null, p: ParamValues, photos: PhotoAsset[], t: number): boolean {
    if (!a?.sections.length) return false;
    this.syncDeck(useStudio.getState().clips, photos);
    if (!this.deck.length) return false;
    const index = this.partIndex(a, t);
    const words = bool(p, 'words', true) ? titleWords() : [];
    const o: PartOptions = {
      style: str(p, 'style', 'auto'),
      seed: Math.max(1, Math.round(num(p, 'seed', 1))),
      colour: colourOf(p),
      shotBeats: Number(str(p, 'pace', '8')) || 8,
      words,
      card: words.length > 0,
    };
    const title = songTitle().toUpperCase();
    const key = `${a.duration}|${a.sections.length}|${index}|${o.style}|${o.seed}|${o.colour}|${o.shotBeats}|${words.join(' ')}|${title}|${this.deckKey}|${this.width}x${this.height}`;
    // the first footage look on this renderer compiles every shader the shots use, once
    warmShots(this.renderer, a, this.deck[0]);
    if (key !== this.builtKey) {
      this.builtKey = key;
      this.stage.build({ seq: partSequence(a, index, o), analysis: a, clips: this.deck, title, lookId: '', tellStore: false, live: true });
    }
    this.focus.x = num(p, 'focusX', 0.5);
    this.focus.y = num(p, 'focusY', 0.55);
    return true;
  }

  render(ctx: FrameContext, target: THREE.WebGLRenderTarget) {
    const t = ctx.audio.time;
    if (!this.sync(ctx.analysis, ctx.params, ctx.photos, t)) return;
    // a render has already put the clips on this exact frame; live, they follow their speed curves
    if (this.preparedFor === null || Math.abs(this.preparedFor - t) > 1e-3) this.stage.follow(t, ctx.audio.playing);
    this.stage.draw(t, this.focus, target);
  }

  async prepare(songTime: number, frame: PrepareContext) {
    this.preparedFor = songTime;
    // a render's first frames arrive before the players have opened: start them and wait
    this.syncDeck(useStudio.getState().clips, frame.photos);
    const waiting = [...this.open.values()].filter((e) => !e.ready).map((e) => e.footage.whenLoaded);
    if (waiting.length) await Promise.allSettled(waiting);
    if (!this.sync(frame.analysis, frame.params, frame.photos, songTime)) return;
    await this.stage.settle(songTime);
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.stage.dispose();
    this.stage.release();
    this.stage = new ShotStage(this.renderer, width, height);
    this.builtKey = '';
  }

  dispose() {
    this.stage.dispose();
    this.stage.release();
    for (const entry of this.open.values()) entry.footage.close();
    this.open.clear();
  }
}

export const footage: SceneDef = {
  id: 'footage',
  name: 'Footage',
  description: 'Your own video clips as the picture: cut on the beat, sped up into every cut, with bold shapes and type set on a grid over them.',
  category: 'photo',
  style: 'photo',
  tags: ['footage', 'video', 'photo', 'cinematic', 'personal', 'graphic', 'editorial'],
  params,
  usesClips: true,
  // the hand-drawn finish redraws the whole picture in a few inks: footage shows clean until a finish is picked
  prefersClean: true,
  create: (init) => new FootageLook(init),
};

export const scenes: SceneDef[] = [footage];
