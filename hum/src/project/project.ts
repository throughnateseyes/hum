/**
 * The project that is open: saving it, keeping it saved, and opening another.
 *
 * In a folder (Chrome, Edge) it keeps itself saved: every change is written a moment after it is made, and
 * the video as it was before a remake, and at every Save, is kept in versions/. As one file (`.hum`, every
 * browser) it is written when the person says so.
 *
 * What is on disk is never quietly lost: a folder that changed since we last wrote it (another tab, another
 * computer) is not written over until the person says which one to keep; footage taken out of the video
 * stays in the folder; and loading another song leaves the project as it was and starts a new one.
 */
import { create } from 'zustand';
import type { ClipAsset, PhotoAsset } from '../core/types';
import { audioEngine } from '../audio/engine';
import { recallNotes, bringNotes } from '../director/media';
import { bringFeeling } from '../director/feeling';
import { drawOpen } from '../draw/session';
import { download } from '../render/recorder';
import { getScene, registerScene } from '../scenes';
import { makeCustomShaderScene } from '../scenes/custom';
import { loadPhoto } from '../scenes/photo/loadPhoto';
import { forgetHistory } from '../state/history';
import { validPlan } from '../state/plan';
import { keepPlan } from '../state/planCache';
import { bringDeals } from '../state/popSeed';
import { ask, DRAWINGS } from '../state/saved';
import { cleanSettings, HAND_DEFAULT, isApplyingLook, isSoloQuiet, MAX_CLIPS, setSoloShotQuietly, useStudio, type StudioState } from '../state/store';
import { demoBlob, loadTrack, songFile, unloadSong } from '../state/tracks';
import { PRESETS } from '../presets';
import { clipFrom, collect, newId, NotAProject, readProject, unpackAnalysis, type ProjectFile } from './format';
import { allowed, cancelled, canKeepFolders, home, namesIn, noteRecent, pickFile, pickFolder, readIn, recentById, safeName, setHome, writeIn, writeTo, type Recent } from './places';
import { TooBig, unzip, zip } from './zip';

export type ProjectStatus =
  /** not saved anywhere */
  | 'none'
  /** changes that aren't saved yet */
  | 'dirty'
  | 'saving'
  | 'saved'
  /** the browser wants to be asked before it writes there again */
  | 'locked'
  /** what is on disk isn't what we last wrote: the person says which to keep */
  | 'newer'
  | 'error';

export interface ProjectState {
  id: string;
  name: string;
  place: 'folder' | 'file' | null;
  status: ProjectStatus;
  savedAt: number;
  /** one line about what is wrong, or what is needed */
  note: string;
  /** opening or packing: what, and how far */
  busy: { text: string; frac: number } | null;
  /** something else is about to be opened over work that isn't saved: what to do once they've said */
  asking: (() => void) | null;
}

const fresh = (): ProjectState => ({ id: newId(), name: '', place: null, status: 'none', savedAt: 0, note: '', busy: null, asking: null });
export const useProject = create<ProjectState>(fresh);
const put = (p: Partial<ProjectState>) => useProject.setState(p);
const now = () => useProject.getState();
const flash = (m: string) => useStudio.getState().flash(m);

/** the name it would have: its own, else the song's */
export const shownName = (p: ProjectState = now()): string => p.name || useStudio.getState().track?.name || 'Untitled';

/** is there anything to save? */
export const hasWork = (s: StudioState = useStudio.getState()): boolean => (!!s.track && s.track.source !== 'mic') || s.clips.length > 0 || s.photos.some((p) => !p.builtin);

/** would opening something else lose work? */
export const unsaved = (p: ProjectState = now()): boolean => hasWork() && p.status !== 'saved' && p.status !== 'saving';

/** do it now, or ask first when work would be lost */
export function guarded(go: () => void) {
  if (unsaved()) put({ asking: go });
  else go();
}
export const closeAsk = () => put({ asking: null });

let dir: FileSystemDirectoryHandle | null = null;
let fileAt: FileSystemFileHandle | null = null;
/** `saved` in the project.json we last read or wrote there */
let onDisk = '';
/** counts up with every edit */
let rev = 0;
let opening = false;
/** what the browser remembers is still coming back after a load: none of it is an edit */
let restoring = false;
let openDone = 0;
let timer = 0;
let chain: Promise<unknown> = Promise.resolve();

/* ───────── remembering what was open, for the next load ───────── */

const LINK = 'hum.project';
interface Link {
  id: string;
  name: string;
  place: 'folder' | 'file';
  saved: string;
  dirty: boolean;
}
function keepLink() {
  const p = now();
  try {
    if (!p.place) localStorage.removeItem(LINK);
    else localStorage.setItem(LINK, JSON.stringify({ id: p.id, name: p.name, place: p.place, saved: onDisk, dirty: p.status !== 'saved' } satisfies Link));
  } catch {
    /* storage blocked: it has to be opened again after a reload */
  }
}
function readLink(): Link | null {
  try {
    const j = JSON.parse(localStorage.getItem(LINK) ?? 'null') as Link | null;
    return j && typeof j.id === 'string' && typeof j.name === 'string' ? j : null;
  } catch {
    return null;
  }
}

/* ───────── following what the person changes ───────── */

const WATCH = ['plan', 'planOn', 'partPops', 'partHand', 'partWords', 'partShot', 'soloShot', 'tweaks', 'drawParts', 'placed', 'text', 'lyrics', 'drawings', 'drawTrash', 'clips', 'photos', 'analysis', 'aspect', 'sensitivity', 'impact', 'lyricStyle', 'lyricsOnBoards', 'lyricFont', 'typeKit', 'hand', 'popups', 'windowKind', 'songColors', 'pace', 'mix', 'smoothSlow', 'transition', 'transitionBeats', 'finish', 'drawOverlay', 'drawInScene'] as const satisfies readonly (keyof StudioState)[];

useStudio.subscribe((s, prev) => {
  if (opening) return;
  if (s.track !== prev.track && prev.track && prev.track.source !== 'mic' && (s.track?.name !== prev.track.name || s.track?.source !== prev.track.source)) {
    if (now().place) return leave(prev);
    // a name given to what isn't saved yet was that song's
    if (now().name) return reset();
  }
  if (!now().place || restoring) return;
  const changed = WATCH.some((k) => s[k] !== prev[k] && !(k === 'hand' && isApplyingLook()) && !(k === 'soloShot' && isSoloQuiet()));
  if (!changed) return;
  edited();
});

function edited() {
  rev++;
  const p = now();
  if (p.status === 'saved' || p.status === 'error') put({ status: 'dirty' });
  keepLink();
  soon();
}

/** the project changed (its name, say) */
export function rename(name: string) {
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (clean === now().name) return;
  put({ name: clean });
  if (now().place) edited();
}

const still = () => {
  const s = useStudio.getState();
  return !s.analyzing && !s.startup && !s.planning && !s.making && !s.clip && !opening;
};

function soon(ms = 1500) {
  clearTimeout(timer);
  if (now().place !== 'folder') return;
  timer = window.setTimeout(() => {
    const p = now();
    if (p.place !== 'folder' || !['dirty', 'error'].includes(p.status)) return;
    if (!still()) return soon(2000);
    void queue(() => writeFolder(useStudio.getState(), false));
  }, ms);
}

function queue<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
}

/** another song was loaded: what isn't written yet of this project is, and a new one starts */
function leave(was: StudioState) {
  clearTimeout(timer);
  const p = now();
  const song = wasSong;
  const name = shownName(p) === useStudio.getState().track?.name ? p.name || (was.track?.name ?? '') : shownName(p);
  if (p.place === 'folder' && dir && p.status === 'dirty' && was.analysis) {
    const [d, saved] = [dir, onDisk];
    void queue(() => writeInto(d, was, p, song, saved)).catch(() => undefined);
  }
  if (p.status === 'dirty' && p.place === 'file') flash(`“${name}” had changes that weren’t saved`);
  else flash(`“${name}” is saved as it was. This song starts a new project`);
  reset();
}

function reset() {
  clearTimeout(timer);
  dir = null;
  fileAt = null;
  onDisk = '';
  put(fresh());
  keepLink();
}

/* ───────── writing ───────── */

/** the song's file as of the last change (tracks.ts lets go of it as soon as another song loads) */
let wasSong: { blob: Blob } | null = null;
useStudio.subscribe((s, prev) => {
  if (s.analysis && s.analysis !== prev.analysis) wasSong = songFile();
});

class Newer extends Error {}

interface Written {
  saved: string;
  /** files that could not be copied */
  missed: number;
}

/** a project into its folder: what is new of its files, then project.json */
async function writeInto(d: FileSystemDirectoryHandle, s: StudioState, p: Pick<ProjectState, 'id' | 'name'>, song: { blob: Blob } | null, known: string, opts: { version?: boolean; over?: boolean } = {}): Promise<Written> {
  const c = await collect(s, p.id, p.name || s.track?.name || 'Untitled', song);
  const before = await readIn(d, 'project.json');
  if (before) {
    const text = await before.text();
    let was: ProjectFile | null = null;
    try {
      was = readProject(text);
    } catch {
      was = null;
    }
    if (!opts.over && known && was && was.id === p.id && was.saved !== known) throw new Newer();
    // another video is about to take its place, or the person pressed Save: this one is kept
    const other = !!was && JSON.stringify(was.video.plan?.flat?.src.looks ?? was.video.plan?.looks ?? null) !== JSON.stringify(c.file.video.plan?.flat?.src.looks ?? c.file.video.plan?.looks ?? null);
    if (opts.version || opts.over || (other && was?.video.plan)) await keepVersion(d, text, was?.saved ?? '');
  }
  let missed = 0;
  for (const m of c.media) {
    try {
      const there = await readIn(d, m.path);
      // a picture is made again to be written: once is enough. The rest is the file itself, told apart by its size
      if (there?.size && m.path.startsWith('photos/')) continue;
      const blob = await m.make();
      if (!blob) throw new Error('nothing to write');
      if (there?.size === blob.size) continue;
      await writeIn(d, m.path, blob);
    } catch (e) {
      console.warn('[hum] project: could not write', m.path, e);
      missed++;
    }
  }
  await writeIn(d, 'project.json', new Blob([JSON.stringify(c.file, null, 1)], { type: 'application/json' }));
  return { saved: c.file.saved, missed };
}

const MOST_VERSIONS = 30;
async function keepVersion(d: FileSystemDirectoryHandle, text: string, saved: string) {
  const at = new Date(saved || Date.now());
  const stamp = (Number.isNaN(at.getTime()) ? new Date() : at).toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.');
  const name = `${stamp}.json`;
  const had = (await namesIn(d, 'versions')).filter((n) => n.endsWith('.json')).sort();
  if (had.includes(name)) return;
  await writeIn(d, `versions/${name}`, new Blob([text], { type: 'application/json' }));
  const vs = await d.getDirectoryHandle('versions');
  for (const old of [...had, name].slice(0, Math.max(0, had.length + 1 - MOST_VERSIONS))) await vs.removeEntry(old).catch(() => undefined);
}

async function writeFolder(s: StudioState, byHand: boolean, over = false): Promise<boolean> {
  if (!dir) return false;
  const d = dir;
  if (!(await allowed(d, byHand))) {
    put({ status: 'locked', note: 'The browser needs your OK to keep saving there.' });
    keepLink();
    return false;
  }
  const at = rev;
  const p = now();
  put({ status: 'saving', note: '' });
  try {
    const w = await writeInto(d, s, p, songFile(), onDisk, { version: byHand, over });
    if (d !== dir) return true;
    onDisk = w.saved;
    put({ status: w.missed ? 'error' : rev !== at ? 'dirty' : 'saved', savedAt: Date.now(), note: w.missed ? `${w.missed === 1 ? 'One file' : `${w.missed} files`} couldn’t be copied into the project. Press Save to try again.` : '' });
    keepLink();
    void noteRecent({ id: p.id, name: p.name || s.track?.name || 'Untitled', at: Date.now(), handle: d });
    if (rev !== at) soon();
    return !w.missed;
  } catch (e) {
    if (d !== dir) return false;
    if (e instanceof Newer) put({ status: 'newer', note: 'This project was changed somewhere else since. Which one should be kept?' });
    else {
      console.warn('[hum] project: not saved', e);
      const full = e instanceof DOMException && e.name === 'QuotaExceededError';
      put({ status: 'error', note: full ? 'The disk is full.' : 'It couldn’t be saved. Is the folder still there?' });
    }
    keepLink();
    return false;
  }
}

/* ───────── the person's Save ───────── */

/** Save where it is, or ask where the first time */
export async function save(): Promise<void> {
  if (now().busy) return;
  if (!hasWork()) return flash('There is nothing to save yet. Open a song first');
  if (now().place === 'folder' && dir) {
    // half of a song being listened to is no state to keep
    if (!still()) return flash('One moment. Hum is still working on the video');
    if (await queue(() => writeFolder(useStudio.getState(), true))) flash('Saved');
    return;
  }
  if (now().place === 'file' && fileAt) return saveFile(false);
  return canKeepFolders() ? saveInFolder() : saveFile();
}

/** a new folder for it, inside the one projects are kept in (asked for once, or again with `ask`) */
export async function saveInFolder(choose = false): Promise<void> {
  if (!hasWork()) return flash('There is nothing to save yet. Open a song first');
  try {
    let at = choose ? null : ((await home()) ?? null);
    if (!at || !(await allowed(at, true))) at = await pickFolder();
    const s = useStudio.getState();
    const p = now();
    const named = p.name || s.track?.name || 'Untitled';
    // a project's own folder was picked: beside its files is no place for another
    const own = await projectIn(at);
    let d: FileSystemDirectoryHandle;
    if (own?.id === p.id) d = at;
    else {
      if (own) return flash('That folder is another project. Pick the folder it is in');
      d = await freshFolder(at, safeName(named), p.id);
      await setHome(at);
    }
    // saved to another place: a project of its own from here on
    if (p.place === 'folder' && dir && !(await dir.isSameEntry(d))) put({ id: newId() });
    dir = d;
    fileAt = null;
    onDisk = '';
    put({ place: 'folder', name: named, status: 'dirty' });
    if (await queue(() => writeFolder(useStudio.getState(), true))) flash(`Saved in “${at === d ? d.name : `${at.name}/${d.name}`}”. Changes save themselves from now on`);
  } catch (e) {
    if (cancelled(e)) return;
    console.warn('[hum] project: not saved', e);
    flash('It couldn’t be saved there. Pick or make another folder');
  }
}

async function projectIn(d: FileSystemDirectoryHandle): Promise<ProjectFile | null> {
  const f = await readIn(d, 'project.json');
  if (!f) return null;
  try {
    return readProject(await f.text());
  } catch {
    return null;
  }
}

/** a folder of that name with nothing in it, or this very project's */
async function freshFolder(at: FileSystemDirectoryHandle, name: string, id: string): Promise<FileSystemDirectoryHandle> {
  const taken = new Set((await namesIn(at, '')).map((n) => n.toLowerCase()));
  for (let k = 1; ; k++) {
    const n = k === 1 ? name : `${name} ${k}`;
    if (!taken.has(n.toLowerCase())) return at.getDirectoryHandle(n, { create: true });
    const d = await at.getDirectoryHandle(n).catch(() => null);
    if (d && (!(await namesIn(d, '')).length || (await projectIn(d))?.id === id)) return d;
  }
}

/** the whole project as one file. `ask` false: over the one it was saved as. */
export async function saveFile(choose = true): Promise<void> {
  if (!hasWork()) return flash('There is nothing to save yet. Open a song first');
  const s = useStudio.getState();
  const p = now();
  const named = p.name || s.track?.name || 'Untitled';
  let to = choose ? null : fileAt;
  try {
    // asked while the click still counts
    if (!to) to = (await pickFile(`${safeName(named)}.hum`)) ?? null;
    else if (!(await allowed(to, true))) return;
    const at = rev;
    put({ busy: { text: 'Packing the project', frac: 0 } });
    const c = await collect(s, p.id, named, songFile());
    const files: { path: string; blob: Blob }[] = [{ path: 'project.json', blob: new Blob([JSON.stringify(c.file, null, 1)]) }];
    let missed = 0;
    for (const m of c.media) {
      const blob = await m.make().catch(() => null);
      if (blob) files.push({ path: m.path, blob });
      else missed++;
    }
    const blob = await zip(files, (f) => put({ busy: { text: 'Packing the project', frac: f } }));
    if (to) await writeTo(to, blob);
    else download(URL.createObjectURL(blob), `${safeName(named)}.hum`);
    // a project kept in a folder stays there: this is a copy of it
    if (p.place !== 'folder') {
      fileAt = to;
      put({ place: 'file', name: named, status: rev === at ? 'saved' : 'dirty', savedAt: Date.now() });
      keepLink();
    }
    flash(missed ? `Saved, but ${missed === 1 ? 'one file' : `${missed} files`} couldn’t be read` : to ? `Saved as “${to.name}”` : 'Saved to your downloads');
  } catch (e) {
    if (cancelled(e)) return;
    console.warn('[hum] project: not packed', e);
    flash(e instanceof TooBig ? 'It’s too big for one file (4 GB). Save it as a folder in Chrome or Edge' : 'It couldn’t be saved as a file');
  } finally {
    put({ busy: null });
  }
}

/* ───────── opening ───────── */

type Read = (path: string) => Promise<Blob | null>;
const TYPES: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', jpg: 'image/jpeg', json: 'application/json' };

/** put a project on: everything is read first, so one that can't be opened leaves things as they are */
async function openWith(read: Read, where: { place: 'folder' | 'file' | null; dir?: FileSystemDirectoryHandle; file?: FileSystemFileHandle; version?: string }): Promise<boolean> {
  const step = (text: string, frac: number) => put({ busy: { text, frac } });
  step('Opening the project', 0);
  try {
    const head = await read(where.version ?? 'project.json');
    if (!head) throw new NotAProject('There is no Hum project in there.');
    const f = readProject(await head.text());
    const { song } = f;
    const missing: string[] = [];
    const blobOf = async (path: string) => {
      const b = await read(path).catch(() => null);
      if (!b) missing.push(path.replace(/^.*\//, ''));
      return b;
    };
    const songBlob = !song ? null : song.source === 'demo' ? demoBlob(song.id ?? '') : song.file ? await blobOf(song.file) : null;
    const heardText = song?.analysis ? await (await read(song.analysis).catch(() => null))?.text() : undefined;
    const clips: ClipAsset[] = [];
    for (const [i, c] of f.clips.slice(0, MAX_CLIPS).entries()) {
      step('Opening the clips', 0.1 + (0.4 * i) / f.clips.length);
      const b = await blobOf(c.file);
      if (b) clips.push(clipFrom(c, b));
    }
    const photos: PhotoAsset[] = [];
    for (const [i, ph] of f.photos.entries()) {
      step('Opening the photos', 0.5 + (0.2 * i) / f.photos.length);
      const b = await blobOf(ph.file);
      const p = b ? await loadPhoto(new File([b], `${ph.name}.jpg`, { type: 'image/jpeg' })).catch(() => null) : null;
      if (p) photos.push({ ...p, id: ph.id });
    }
    step('Opening the song', 0.75);
    await recallNotes();

    // from here on it is this project that is open
    opening = true;
    clearTimeout(openDone);
    clearTimeout(timer);
    audioEngine.pause();
    const s0 = useStudio.getState();
    if (s0.perform) s0.set({ perform: false });
    for (const x of f.shaders) {
      try {
        registerScene(makeCustomShaderScene(x));
        useStudio.setState((s) => ({ customShaders: [...s.customShaders, x] }));
      } catch (e) {
        console.warn('[hum] project: a shader was left out', e);
      }
    }
    const known = new Set([...PRESETS, ...s0.customPresets].map((p) => p.id));
    const presets = f.presets.filter((p) => !known.has(p.id) && !!getScene(p.sceneId));
    if (presets.length) useStudio.setState((s) => ({ customPresets: [...s.customPresets, ...presets] }));
    for (const c of s0.clips) URL.revokeObjectURL(c.url);
    useStudio.setState({ clips: [] });
    for (const p of s0.photos) if (!p.builtin) s0.removePhoto(p.id);
    useStudio.setState((s) => ({ clips, photos: [...s.photos, ...photos] }));
    const set = Object.fromEntries(Object.entries(cleanSettings(f.settings)).filter(([, v]) => v !== undefined));
    s0.set({ finish: 'hand', finishPicked: false, lyricStyle: 'auto', lyricStylePicked: false, hand: HAND_DEFAULT, ...set });
    await bringNotes(f.notes);
    bringDrawings(f);
    bringFeeling(f.lyrics.lyrics, f.feeling);

    if (song && songBlob) {
      const typed = songBlob.type ? songBlob : songBlob.slice(0, songBlob.size, TYPES[song.file?.split('.').pop() ?? ''] ?? '');
      const named = song.file && !(typed instanceof File) ? new File([typed], song.file.replace(/^.*\//, ''), { type: typed.type }) : typed;
      await loadTrack(named, { name: song.name, source: song.source, ...(song.source === 'demo' ? { id: song.id } : {}) }, { restored: true, project: { plan: f.video.plan, analysis: heardText ? unpackAnalysis(heardText) : null, lyrics: f.lyrics } });
    } else unloadSong();
    applyVideo(f);
    forgetHistory();

    dir = where.dir ?? null;
    fileAt = where.file ?? null;
    onDisk = where.version ? onDisk : f.saved;
    put({ id: f.id, name: f.name, place: where.place, status: where.place ? 'saved' : 'none', savedAt: Date.parse(f.saved) || 0, note: '' });
    keepLink();
    if (where.dir) void noteRecent({ id: f.id, name: f.name, at: Date.now(), handle: where.dir });
    const st = useStudio.getState();
    const lost = f.video.plan && song && songBlob && !validPlan(st.plan, st.analysis);
    if (missing.length || lost) {
      // what is missing must not be written over what is there
      put({ status: where.place === 'folder' ? 'newer' : 'dirty', note: lost ? 'Its video needs a look this Hum doesn’t have, so it wasn’t put on.' : `Missing from the project: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}.` });
      flash(lost ? 'Opened, but its video couldn’t be put on' : `Opened, but ${missing.length === 1 ? 'one file is' : `${missing.length} files are`} missing`);
    } else flash(`Opened “${f.name}”`);
    return true;
  } catch (e) {
    console.warn('[hum] project: not opened', e);
    flash(e instanceof NotAProject ? e.message : 'That project couldn’t be opened');
    return false;
  } finally {
    put({ busy: null });
    // what the song sets off by itself settles first
    openSettles();
  }
}

function openSettles() {
  clearTimeout(openDone);
  openDone = window.setTimeout(() => {
    opening = false;
    rev = 0;
  }, 300);
}

function applyVideo(f: ProjectFile) {
  const s = useStudio.getState();
  const v = f.video;
  const n = s.analysis?.sections.length ?? 0;
  const fits = <T>(a: T[] | null) => (a && a.length === n ? a : null);
  if (s.track && s.analysis) bringDeals(s.track.name, s.analysis, v.popDeals);
  s.set({ partPops: fits(v.partPops), partHand: fits(v.partHand), partWords: fits(v.partWords), partShot: fits(v.partShot), tweaks: v.tweaks, drawParts: v.drawParts, placed: v.placed, text: v.text });
  setSoloShotQuietly(v.soloShot);
  if (!v.planOn && v.look && getScene(v.look.sceneId)) {
    const look = [...useStudio.getState().customPresets, ...PRESETS].find((p) => p.id === v.look!.presetId);
    if (look) s.applyPreset(look);
    else s.setScene(v.look.sceneId);
    useStudio.setState({ planOn: false });
  } else s.reapplyLook();
  const { plan } = useStudio.getState();
  if (plan) keepPlan(plan);
}

function bringDrawings(f: ProjectFile) {
  if (!f.drawings.length) return;
  if (!drawOpen()) {
    // kept for when drawings are allowed here
    for (const d of f.drawings) void ask(DRAWINGS, 'readwrite', (s) => s.put(d));
    return;
  }
  const s = useStudio.getState();
  const song = f.song?.name;
  const mine = new Map(s.drawings.map((d) => [d.id, d]));
  const ids = new Set(f.drawings.map((d) => d.id));
  s.set({
    drawings: [...s.drawings.map((d) => (song && ids.has(d.id) && !d.songs.includes(song) && f.drawings.find((x) => x.id === d.id)?.songs.includes(song) ? { ...d, songs: [...d.songs, song] } : d)), ...f.drawings.filter((d) => !mine.has(d.id))],
    drawTrash: s.drawTrash.filter((id) => !ids.has(id)),
  });
}

/** what isn't written yet of the open project is, before another takes its place */
async function settle() {
  clearTimeout(timer);
  if (now().place === 'folder' && dir && now().status === 'dirty' && still()) await queue(() => writeFolder(useStudio.getState(), false));
  await chain;
}

const fromDir = (d: FileSystemDirectoryHandle): Read => (path) => readIn(d, path);

export async function openDir(d: FileSystemDirectoryHandle): Promise<boolean> {
  if (now().busy) return false;
  await settle();
  if (!(await allowed(d, true))) {
    flash('The browser needs your OK to open that folder');
    return false;
  }
  if (!(await readIn(d, 'project.json'))) {
    // the folder projects are kept in: the newest of them
    const inside: { d: FileSystemDirectoryHandle; at: number }[] = [];
    for (const n of await namesIn(d, '')) {
      const sub = await d.getDirectoryHandle(n).catch(() => null);
      const p = sub ? await readIn(sub, 'project.json') : null;
      if (sub && p) inside.push({ d: sub, at: p.lastModified });
    }
    if (inside.length) {
      await setHome(d);
      for (const x of inside) {
        const p = await projectIn(x.d);
        if (p) await noteRecent({ id: p.id, name: p.name, at: Date.parse(p.saved) || x.at, handle: x.d });
      }
      flash(`${inside.length === 1 ? 'One project' : `${inside.length} projects`} in there. Pick one under Recent`);
      return false;
    }
  }
  return openWith(fromDir(d), { place: 'folder', dir: d });
}

export async function openFolder(): Promise<boolean> {
  try {
    return await openDir(await pickFolder());
  } catch (e) {
    if (!cancelled(e)) flash('That folder couldn’t be opened');
    return false;
  }
}

export const openRecent = (r: Recent) => openDir(r.handle);

export async function openFile(b: Blob): Promise<boolean> {
  if (now().busy) return false;
  await settle();
  put({ busy: { text: 'Opening the project', frac: 0 } });
  const files = await unzip(b).catch(() => null);
  put({ busy: null });
  if (!files) {
    flash('That isn’t a Hum project, or it is damaged');
    return false;
  }
  const typed = (path: string, x: Blob) => x.slice(0, x.size, TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? '');
  return openWith(async (path) => (files.has(path) ? typed(path, files.get(path)!) : null), { place: 'file' });
}

/* ───────── earlier versions ───────── */

export interface Version {
  file: string;
  at: number;
}
export async function versions(): Promise<Version[]> {
  if (!dir) return [];
  return (await namesIn(dir, 'versions'))
    .filter((n) => /^\d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.json$/.test(n))
    .map((n) => ({ file: `versions/${n}`, at: Date.parse(`${n.slice(0, 10)}T${n.slice(11, 19).replace(/\./g, ':')}Z`) }))
    .sort((a, b) => b.at - a.at);
}

/** back to the video as it was; what is on now is kept as a version first */
export async function openVersion(v: Version): Promise<void> {
  const d = dir;
  if (!d || now().busy) return;
  if (!(await queue(() => writeFolder(useStudio.getState(), true)))) return;
  const name = now().name;
  if (await openWith(fromDir(d), { place: 'folder', dir: d, version: v.file })) {
    put({ name });
    window.setTimeout(edited, 400);
  }
}

/* ───────── after a reload, and when two differ ───────── */

/**
 * The project that was open before the page reloaded. True when it was put on from its folder; otherwise
 * the page brings back what it remembers itself, and the project waits to be reconnected.
 */
export async function resume(): Promise<boolean> {
  const link = readLink();
  if (!link) return false;
  put({ id: link.id, name: link.name });
  if (link.place !== 'folder') return false;
  const r = await recentById(link.id);
  if (!r) return false;
  dir = r.handle;
  onDisk = link.saved;
  if (!(await allowed(r.handle, false))) {
    put({ place: 'folder', status: 'locked', note: 'Reconnect to keep saving in its folder.' });
    restoreSettles();
    return false;
  }
  const done = await reconnected(link.dirty);
  if (!done) restoreSettles();
  return done;
}

/** what the page brings back by itself counts as no change; anything after it does */
function restoreSettles() {
  restoring = true;
  const from = performance.now();
  let quiet = 0;
  const t = window.setInterval(() => {
    quiet = useStudio.getState().track && still() ? quiet + 1 : 0;
    if (quiet < 4 && performance.now() - from < 60000) return;
    clearInterval(t);
    restoring = false;
    rev = 0;
  }, 300);
}

/** the person says yes to writing there again */
export async function reconnect(): Promise<void> {
  if (!dir || !(await allowed(dir, true))) return;
  await reconnected(readLink()?.dirty ?? false);
}

async function reconnected(dirty: boolean): Promise<boolean> {
  const d = dir!;
  const p = await projectIn(d);
  if (!p) {
    dir = null;
    put({ place: null, status: 'none' });
    keepLink();
    flash('The project’s folder is gone or was moved. Save again to keep it');
    return false;
  }
  // nothing was changed here since it was saved: what is on disk is it
  if (!dirty && rev === 0) return openWith(fromDir(d), { place: 'folder', dir: d });
  put({ place: 'folder', status: 'newer', note: p.saved === onDisk ? 'There are changes here that weren’t saved yet.' : 'This project was changed somewhere else since. Which one should be kept?' });
  return false;
}

/** keep what is on here: it is written over the one on disk, which stays under versions */
export const keepHere = () => queue(() => writeFolder(useStudio.getState(), true, true));
/** keep the one on disk: what is on here goes */
export const keepDisk = () => (dir ? openWith(fromDir(dir), { place: 'folder', dir }) : Promise.resolve(false));

/** put it all away: no song, no footage, nothing open */
export async function startNew() {
  await settle();
  opening = true;
  clearTimeout(openDone);
  const s = useStudio.getState();
  unloadSong();
  for (const c of s.clips) URL.revokeObjectURL(c.url);
  useStudio.setState({ clips: [] });
  for (const p of s.photos) if (!p.builtin) s.removePhoto(p.id);
  forgetHistory();
  reset();
  openSettles();
}

// closing the page with changes that only live here
window.addEventListener('beforeunload', (e) => {
  const p = now();
  if (p.busy || (p.place === 'folder' && (p.status === 'saving' || p.status === 'dirty'))) e.preventDefault();
});
