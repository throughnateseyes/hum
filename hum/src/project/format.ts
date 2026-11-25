/**
 * What a project is made of.
 *
 *   project.json            the video and every choice in it, the words, the settings, the drawings, what
 *                           Claude saw in the clips (so opening it asks for nothing again)
 *   song/…                  the song's file, and analysis.json: what Hum heard in it
 *   clips/…  photos/…       the footage, as it was added
 *   versions/…              project.json as it was at earlier saves
 *
 * Everything the video needs is in it: it opens on another computer as it was. What was read of each
 * clip's depth isn't (it is big, and read again when needed).
 *
 * A project may come from someone else: whatever is read here is checked, and what doesn't hold is left out.
 */
import type { ClipAsset, ClipPalette, CustomShaderSpec, Lyrics, MediaNotes, Palette, PartShot, Preset, TrackAnalysis } from '../core/types';
import { cleanPlaced, type Placed } from '../arrange/types';
import { feelingFor } from '../director/feeling';
import { notesOf, recallNotes } from '../director/media';
import { cleanAsset } from '../draw/session';
import type { DrawingAsset, DrawPart } from '../draw/types';
import { cleanDrawParts } from '../draw/parts';
import type { SongFeeling } from '../feeling';
import { getScene } from '../scenes';
import { dealsHere } from '../state/popSeed';
import { okShot, originalOf } from '../state/planCache';
import type { VideoPlan } from '../state/plan';
import { photoBlob } from '../state/saved';
import { settingsOf, type StudioState } from '../state/store';
import type { TweakTable } from '../state/tweaks';
import { safeName } from './places';

export const FORMAT = 1;

export interface ProjectMedia {
  id: string;
  name: string;
  file: string;
}
export interface ProjectClip extends ProjectMedia {
  duration: number;
  width: number;
  height: number;
  thumb: string;
  palette: ClipPalette;
}

export interface ProjectFile {
  hum: number;
  id: string;
  name: string;
  saved: string;
  song: { name: string; source: 'file' | 'demo'; id?: string; file?: string; duration: number; analysis?: string } | null;
  clips: ProjectClip[];
  photos: ProjectMedia[];
  video: {
    plan: VideoPlan | null;
    planOn: boolean;
    look: { presetId: string | null; sceneId: string; sceneParams: Record<string, unknown>; palette: Palette } | null;
    partPops: (number | null)[] | null;
    partHand: (boolean | null)[] | null;
    partWords: (string | null)[] | null;
    partShot: (PartShot | null)[] | null;
    soloShot: PartShot | null;
    tweaks: TweakTable;
    drawParts: DrawPart[];
    placed: Placed;
    popDeals: Record<string, number>;
    text: string;
  };
  lyrics: { lyrics: Lyrics | null; status: string; note: string; matched: number | null };
  settings: Record<string, unknown>;
  drawings: DrawingAsset[];
  notes: MediaNotes[];
  feeling: SongFeeling | null;
  presets: Preset[];
  shaders: CustomShaderSpec[];
}

/* ───────── putting one together ───────── */

const EXT: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
const extOf = (b: Blob, or: string) => (b instanceof File ? /\.([a-z0-9]{2,5})$/i.exec(b.name)?.[1]?.toLowerCase() : undefined) ?? EXT[b.type] ?? or;
/** two files of one name stay apart, and one file keeps its name from save to save */
const fileName = (name: string, id: string, ext: string) => `${safeName(name, 40)} ${id.slice(-4)}.${ext}`;

/** settings that are the person's or the machine's rather than this video's */
const NOT_OURS = new Set(['customPresets', 'customShaders', 'chat', 'volume', 'muted', 'quality', 'directorOpen', 'directorHeight', 'lyricsAutoSync', 'oneTap']);

export interface Collected {
  file: ProjectFile;
  /** the files beside project.json; each is only made if it has to be written */
  media: { path: string; make: () => Promise<Blob | null> }[];
}

/** does a drawing belong to this video: it is in the song, or stands in one of its shots */
function drawingIds(s: StudioState): Set<string> {
  const ids = new Set<string>();
  for (const d of s.drawParts) for (const id of d.ids ?? []) ids.add(id);
  // the plan's shots, its cues and the person's own choices all name drawings by id
  const text = JSON.stringify([s.plan, s.partShot, s.placed.drawings]);
  for (const d of s.drawings) if (text.includes(`"${d.id}"`)) ids.add(d.id);
  return ids;
}

export async function collect(s: StudioState, id: string, name: string, song: { blob: Blob } | null): Promise<Collected> {
  await recallNotes();
  const media: Collected['media'] = [];
  const add = (path: string, make: () => Promise<Blob | null>) => {
    media.push({ path, make });
    return path;
  };
  const track = s.track && s.track.source !== 'mic' ? s.track : null;
  const a = s.analysis ? originalOf(s.analysis) : null;
  let songPart: ProjectFile['song'] = null;
  if (track) {
    songPart = { name: track.name, source: track.source === 'demo' ? 'demo' : 'file', duration: a?.duration ?? 0, ...(track.id ? { id: track.id } : {}) };
    if (track.source === 'file' && song) songPart.file = add(`song/${safeName(track.name)}.${extOf(song.blob, 'mp3')}`, async () => song.blob);
    if (a) songPart.analysis = add(`song/${safeName(track.name)} analysis.json`, async () => new Blob([packAnalysis(a)], { type: 'application/json' }));
  }
  const clips = s.clips.map((c): ProjectClip => ({ id: c.id, name: c.name, duration: c.duration, width: c.width, height: c.height, thumb: c.thumb, palette: c.palette, file: add(`clips/${fileName(c.name, c.id, extOf(c.file, 'mp4'))}`, async () => c.file) }));
  const photos = s.photos.filter((p) => !p.builtin).map((p): ProjectMedia => ({ id: p.id, name: p.name, file: add(`photos/${fileName(p.name, p.id, 'jpg')}`, () => photoBlob(p)) }));
  const wanted = drawingIds(s);
  const gone = new Set(s.drawTrash);
  const used = new Set([...(s.plan?.looks ?? []), ...(s.plan?.flat?.src.looks ?? []), ...(s.plan?.flat?.src.rotate ?? []).flat(), s.presetId]);
  const presets = s.customPresets.filter((p) => used.has(p.id));
  const scenes = new Set([...presets.map((p) => p.sceneId), s.sceneId]);
  return {
    file: {
      hum: FORMAT,
      id,
      name,
      saved: new Date().toISOString(),
      song: songPart,
      clips,
      photos,
      video: {
        plan: s.plan,
        planOn: s.planOn,
        look: s.planOn ? null : { presetId: s.presetId, sceneId: s.sceneId, sceneParams: s.sceneParams, palette: s.palette },
        partPops: s.partPops,
        partHand: s.partHand,
        partWords: s.partWords,
        partShot: s.partShot,
        soloShot: s.soloShot,
        tweaks: s.tweaks,
        drawParts: s.drawParts,
        placed: s.placed,
        popDeals: track && s.analysis ? dealsHere(track.name, s.analysis) : {},
        text: s.text,
      },
      lyrics: { lyrics: s.lyrics, status: s.lyricsStatus, note: s.lyricsNote, matched: s.lyricsMatched },
      settings: Object.fromEntries(Object.entries(settingsOf(s)).filter(([k]) => !NOT_OURS.has(k))),
      drawings: s.drawings.filter((d) => !gone.has(d.id) && (wanted.has(d.id) || (track && d.songs.includes(track.name)))),
      notes: [...clips, ...photos].flatMap((m) => notesOf(m.id) ?? []),
      feeling: feelingFor(s.lyrics),
      presets,
      shaders: s.customShaders.filter((x) => scenes.has(x.id)),
    },
    media,
  };
}

/* ───────── what Hum heard in the song ───────── */

const F32 = '$f32';
const toText = (f: Float32Array) => {
  const b = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(s);
};

export function packAnalysis(a: TrackAnalysis): string {
  return JSON.stringify(a, (_, v: unknown) => (v instanceof Float32Array ? { [F32]: toText(v) } : v));
}

/** null when it isn't an analysis (the song is then listened to again) */
export function unpackAnalysis(text: string): TrackAnalysis | null {
  try {
    const a = JSON.parse(text, (_, v: unknown) => {
      const s = v && typeof v === 'object' ? (v as Record<string, unknown>)[F32] : undefined;
      return typeof s === 'string' ? new Float32Array(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer) : v;
    }) as TrackAnalysis;
    const curves = [a.overview, a.energyCurve, a.lowCurve, a.midCurve, a.highCurve];
    const ok =
      Number.isFinite(a.duration) &&
      a.duration > 0 &&
      Number.isFinite(a.bpm) &&
      curves.every((c) => c instanceof Float32Array && c.length > 0) &&
      Array.isArray(a.drops) &&
      Array.isArray(a.tags) &&
      !!a.mood &&
      Array.isArray(a.suggestedPresets) &&
      typeof a.summary === 'string' &&
      Array.isArray(a.sections) &&
      a.sections.length <= 400 &&
      a.sections.every((s) => s && typeof s.label === 'string' && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
    return ok ? a : null;
  } catch {
    return null;
  }
}

/* ───────── reading one ───────── */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, most: number, or = '') => (typeof v === 'string' ? v.slice(0, most) : or);
const num = (v: unknown, lo: number, hi: number, or: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : or);
const list = (v: unknown, most: number): unknown[] => (Array.isArray(v) ? v.slice(0, most) : []);
/** a path inside the project, in one of its own folders */
const pathIn = (v: unknown, folder: string) => {
  const s = str(v, 200);
  return s.startsWith(`${folder}/`) && !s.includes('..') && s.split('/').length === 2 ? s : '';
};
const colours = (v: unknown, n: number): string[] | null => (Array.isArray(v) && v.length === n && v.every((c) => typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c)) ? (v as string[]) : null);

function cleanClip(v: unknown): ProjectClip | null {
  if (!isObj(v) || !isObj(v.palette)) return null;
  const id = str(v.id, 60);
  const file = pathIn(v.file, 'clips');
  const p = v.palette;
  const flats = colours(p.flats, 5);
  if (!id || !file || !flats || typeof p.ink !== 'string' || typeof p.paper !== 'string') return null;
  return {
    id,
    file,
    name: str(v.name, 120, 'clip'),
    duration: num(v.duration, 0.05, 36000, 1),
    width: num(v.width, 2, 16384, 1280),
    height: num(v.height, 2, 16384, 720),
    thumb: typeof v.thumb === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(v.thumb) && v.thumb.length < 400_000 ? v.thumb : '',
    palette: p as unknown as ClipPalette,
  };
}

function cleanLyrics(v: unknown): Lyrics | null {
  if (!isObj(v) || !Array.isArray(v.lines)) return null;
  const word = (w: unknown) => (isObj(w) && Number.isFinite(w.t) && Number.isFinite(w.end) && typeof w.text === 'string' ? [{ t: w.t as number, end: w.end as number, text: w.text.slice(0, 80) }] : []);
  const lines = list(v.lines, 3000).flatMap((l) =>
    isObj(l) && Number.isFinite(l.t) && Number.isFinite(l.end) && typeof l.text === 'string' ? [{ t: l.t as number, end: l.end as number, text: l.text.slice(0, 400), ...(Array.isArray(l.words) ? { words: list(l.words, 120).flatMap(word) } : {}) }] : [],
  );
  return {
    lines,
    synced: v.synced === true,
    source: v.source === 'file' || v.source === 'lrclib' ? v.source : 'pasted',
    ...(typeof v.title === 'string' ? { title: v.title.slice(0, 200) } : {}),
    ...(typeof v.artist === 'string' ? { artist: v.artist.slice(0, 200) } : {}),
    ...(typeof v.plain === 'string' ? { plain: v.plain.slice(0, 40_000) } : {}),
    ...(v.instrumental === true ? { instrumental: true } : {}),
  };
}

/** its shots and cues are read as settings of footage, so they must look like them */
function cleanPlan(v: unknown): VideoPlan | null {
  if (!isObj(v) || !Array.isArray(v.looks) || v.looks.length > 400 || !v.looks.every((x) => x === null || typeof x === 'string')) return null;
  const p = { ...v } as unknown as VideoPlan & Record<string, unknown>;
  p.title = str(v.title, 200, 'Video');
  p.note = str(v.note, 2000);
  p.why = list(v.why, 400).map((w) => str(w, 400));
  p.source = v.source === 'claude' ? 'claude' : 'local';
  if (!Number.isFinite(v.duration)) return null;
  if (v.shots !== undefined) p.shots = list(v.shots, 400).map((x) => (okShot(x, 400) ? (x as PartShot) : null));
  if (v.bounds !== undefined && !(Array.isArray(v.bounds) && v.bounds.every((b) => Number.isFinite(b)))) delete p.bounds;
  if (v.kept !== undefined && !(Array.isArray(v.kept) && v.kept.length === v.looks.length && v.kept.every((k) => typeof k === 'boolean'))) delete p.kept;
  if (v.flat !== undefined) {
    const src = isObj(v.flat) ? cleanPlan(v.flat.src) : null;
    if (!src) return null;
    p.flat = { ...(v.flat as unknown as NonNullable<VideoPlan['flat']>), src };
  }
  return p;
}

const cleanPreset = (v: unknown): v is Preset => isObj(v) && typeof v.id === 'string' && v.id.length < 80 && typeof v.name === 'string' && typeof v.sceneId === 'string' && Array.isArray(v.tags) && Array.isArray(v.effects) && Array.isArray(v.modulations) && isObj(v.palette);
const cleanShader = (v: unknown): v is CustomShaderSpec => isObj(v) && typeof v.id === 'string' && v.id.length < 80 && !getScene(v.id) && typeof v.name === 'string' && typeof v.fragment === 'string' && v.fragment.length < 60_000 && Array.isArray(v.params);
const perPart = <T>(v: unknown, ok: (x: unknown) => boolean): (T | null)[] | null => (Array.isArray(v) && v.length <= 400 && v.every((x) => x === null || ok(x)) ? (v as (T | null)[]) : null);

export class NotAProject extends Error {}

export function readProject(text: string): ProjectFile {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new NotAProject('That project file is damaged.');
  }
  if (!isObj(j) || typeof j.hum !== 'number') throw new NotAProject('That isn’t a Hum project.');
  if (j.hum > FORMAT) throw new NotAProject('That project was made by a newer Hum. Reload the page to update.');
  const v = isObj(j.video) ? j.video : {};
  const ly = isObj(j.lyrics) ? j.lyrics : {};
  const look = isObj(v.look) && typeof v.look.sceneId === 'string' && isObj(v.look.palette) ? v.look : null;
  const song = isObj(j.song) && typeof j.song.name === 'string' ? j.song : null;
  return {
    hum: FORMAT,
    id: str(j.id, 60) || newId(),
    name: str(j.name, 80, 'Untitled'),
    saved: str(j.saved, 40),
    song: song
      ? {
          name: str(song.name, 200),
          source: song.source === 'demo' ? 'demo' : 'file',
          ...(typeof song.id === 'string' ? { id: song.id } : {}),
          ...(pathIn(song.file, 'song') ? { file: pathIn(song.file, 'song') } : {}),
          ...(pathIn(song.analysis, 'song') ? { analysis: pathIn(song.analysis, 'song') } : {}),
          duration: num(song.duration, 0, 36000, 0),
        }
      : null,
    clips: list(j.clips, 40).flatMap((c) => cleanClip(c) ?? []),
    photos: list(j.photos, 200).flatMap((p) => (isObj(p) && str(p.id, 60) && pathIn(p.file, 'photos') ? [{ id: str(p.id, 60), name: str(p.name, 120, 'photo'), file: pathIn(p.file, 'photos') }] : [])),
    video: {
      plan: cleanPlan(v.plan),
      planOn: v.planOn !== false,
      look: look as ProjectFile['video']['look'],
      partPops: perPart<number>(v.partPops, (x) => typeof x === 'number' && x >= 0 && x <= 3),
      partHand: perPart<boolean>(v.partHand, (x) => typeof x === 'boolean'),
      partWords: perPart<string>(v.partWords, (x) => typeof x === 'string' && x.length <= 200),
      partShot: perPart<PartShot>(v.partShot, okShot),
      soloShot: okShot(v.soloShot) ? (v.soloShot as PartShot) : null,
      tweaks: isObj(v.tweaks) ? (v.tweaks as TweakTable) : {},
      drawParts: cleanDrawParts(v.drawParts),
      placed: cleanPlaced(v.placed),
      popDeals: isObj(v.popDeals) ? Object.fromEntries(Object.entries(v.popDeals).filter((e): e is [string, number] => /^\d{1,9}$/.test(e[0]) && typeof e[1] === 'number')) : {},
      text: str(v.text, 400),
    },
    lyrics: { lyrics: cleanLyrics(ly.lyrics), status: str(ly.status, 20), note: str(ly.note, 400), matched: typeof ly.matched === 'number' ? ly.matched : null },
    settings: isObj(j.settings) ? Object.fromEntries(Object.entries(j.settings).filter(([k]) => !NOT_OURS.has(k))) : {},
    drawings: list(j.drawings, 200).flatMap((d) => cleanAsset(d) ?? []),
    notes: list(j.notes, 250).filter((n): n is MediaNotes & object => isObj(n) && typeof n.id === 'string' && typeof n.v === 'number' && isObj(n.measure) && typeof n.subject === 'string'),
    feeling: isObj(j.feeling) ? (j.feeling as unknown as SongFeeling) : null,
    presets: list(j.presets, 60).filter(cleanPreset),
    shaders: list(j.shaders, 60).filter(cleanShader),
  };
}

export const newId = () => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** a clip as the store has it, from what the project says of it and its file */
export const clipFrom = (c: ProjectClip, blob: Blob): ClipAsset => ({ id: c.id, name: c.name, duration: c.duration, width: c.width, height: c.height, thumb: c.thumb, palette: c.palette, file: blob, url: URL.createObjectURL(blob) });
