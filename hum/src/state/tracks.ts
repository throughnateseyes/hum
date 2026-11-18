import { audioEngine } from '../audio/engine';
import { analyzeTrack } from '../audio/analysis';
import { DEMO_TRACKS } from '../audio/demoTracks';
import { PRESETS } from '../presets';
import { loadPhoto } from '../scenes/photo/loadPhoto';
import { useStudio, type TrackInfo } from './store';

const demoCache = new Map<string, Blob>();
let loadToken = 0;

/** Load audio, start playing, analyse it, then theme the stage from the analysis. */
export async function loadTrack(blob: Blob, info: TrackInfo, opts: { autoTheme?: boolean } = {}) {
  const token = ++loadToken;
  const st = useStudio.getState();
  st.set({ track: info, analysis: null, analyzing: true });
  const ctx = audioEngine.ensureContext();
  try {
    await audioEngine.loadFile(blob, null);
    void audioEngine.play().catch(() => {});
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (token !== loadToken) return;
    const analysis = await analyzeTrack(
      buf,
      [...PRESETS, ...useStudio.getState().customPresets].map((p) => ({ id: p.id, tags: p.tags })),
    );
    if (token !== loadToken) return;
    audioEngine.setAnalysis(analysis);
    useStudio.getState().set({ analysis, analyzing: false });
    if (opts.autoTheme !== false) {
      const pick = analysis.suggestedPresets.map((id) => PRESETS.find((p) => p.id === id)).find(Boolean);
      if (pick) {
        useStudio.getState().applyPreset(pick);
        useStudio.getState().flash(`Heard ${analysis.tags.slice(0, 3).join(', ')} · ${Math.round(analysis.bpm)} bpm → “${pick.name}”`);
      }
    }
  } catch (e) {
    console.error(e);
    if (token === loadToken) {
      useStudio.getState().set({ analyzing: false });
      useStudio.getState().flash('Could not read that audio file');
    }
  }
}

export async function loadDemo(id: string) {
  const d = DEMO_TRACKS.find((t) => t.id === id);
  if (!d) return;
  audioEngine.ensureContext();
  let blob = demoCache.get(id);
  if (!blob) {
    blob = d.render();
    demoCache.set(id, blob);
  }
  await loadTrack(blob, { name: d.name, source: 'demo', id });
}

export async function useMic() {
  try {
    await audioEngine.startMic();
    useStudio.getState().set({ track: { name: 'Microphone', source: 'mic' }, analysis: null, analyzing: false });
  } catch {
    useStudio.getState().flash('Microphone permission was denied');
  }
}

export async function handleFiles(files: FileList | File[]) {
  const list = Array.from(files);
  const audio = list.find((f) => f.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i.test(f.name));
  const images = list.filter((f) => f.type.startsWith('image/'));
  if (images.length) {
    const photos = (await Promise.all(images.map((f) => loadPhoto(f).catch(() => null)))).filter((p) => p !== null);
    if (photos.length) {
      useStudio.getState().addPhotos(photos);
      useStudio.getState().flash(`${photos.length} photo${photos.length > 1 ? 's' : ''} added — try a Photo scene`);
    }
  }
  if (audio) await loadTrack(audio, { name: audio.name.replace(/\.[^.]+$/, ''), source: 'file' });
}
