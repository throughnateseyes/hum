import { create } from 'zustand';
import type {
  CustomShaderSpec,
  EffectInstance,
  LayerId,
  Modulation,
  Palette,
  ParamValue,
  PhotoAsset,
  Preset,
  TrackAnalysis,
} from '../core/types';
import { PALETTES } from '../core/palettes';
import { getEffect } from '../fx';
import { getScene, registerScene } from '../scenes';
import { makeCustomShaderScene } from '../scenes/custom';
import { presetToLook, lookToPreset, type LookState } from '../presets/apply';
import { uid } from './modulation';

export type Aspect = 'fill' | '16:9' | '9:16' | '1:1' | '4:5';
export type InspectorTab = 'scene' | 'fx' | 'layers' | 'look';

export interface TrackInfo {
  name: string;
  source: 'demo' | 'file' | 'mic';
  id?: string;
}

export interface StudioState extends LookState {
  presetId: string | null;
  track: TrackInfo | null;
  analysis: TrackAnalysis | null;
  analyzing: boolean;
  photos: PhotoAsset[];
  text: string;
  aspect: Aspect;
  inspectorTab: InspectorTab;
  perform: boolean;
  autoPilot: boolean;
  sensitivity: number;
  quality: number;
  customPresets: Preset[];
  customShaders: CustomShaderSpec[];
  shaderError: string | null;
  toast: string | null;
  recording: boolean;

  applyPreset: (p: Preset) => void;
  setScene: (id: string) => void;
  setSceneParam: (id: string, v: ParamValue) => void;
  addEffect: (effectId: string) => void;
  removeEffect: (instanceId: string) => void;
  toggleEffect: (instanceId: string) => void;
  moveEffect: (instanceId: string, dir: -1 | 1) => void;
  setEffectParam: (instanceId: string, id: string, v: ParamValue) => void;
  addModulation: (source: LayerId, target: string, amount?: number) => void;
  updateModulation: (id: string, patch: Partial<Modulation>) => void;
  removeModulation: (id: string) => void;
  setPalette: (p: Palette) => void;
  setPaletteColor: (key: keyof Omit<Palette, 'id' | 'name'>, hex: string) => void;
  addPhotos: (p: PhotoAsset[]) => void;
  removePhoto: (id: string) => void;
  saveCurrentAsPreset: (name: string) => Preset;
  deleteCustomPreset: (id: string) => void;
  addCustomShader: (spec: CustomShaderSpec) => void;
  set: (patch: Partial<StudioState>) => void;
  flash: (msg: string) => void;
}

const LS_KEY = 'hum.v1';
function loadPersisted(): Partial<StudioState> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const j = JSON.parse(raw);
    return {
      customPresets: Array.isArray(j.customPresets) ? j.customPresets : [],
      customShaders: Array.isArray(j.customShaders) ? j.customShaders : [],
      aspect: j.aspect ?? undefined,
      sensitivity: typeof j.sensitivity === 'number' ? j.sensitivity : undefined,
      quality: typeof j.quality === 'number' ? j.quality : undefined,
    };
  } catch {
    return {};
  }
}
function persist(s: StudioState) {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ customPresets: s.customPresets, customShaders: s.customShaders, aspect: s.aspect, sensitivity: s.sensitivity, quality: s.quality }),
    );
  } catch {
    /* storage may be unavailable */
  }
}

const persisted = loadPersisted();
for (const spec of persisted.customShaders ?? []) {
  try {
    registerScene(makeCustomShaderScene(spec));
  } catch {
    /* ignore */
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useStudio = create<StudioState>((set, get) => ({
  sceneId: '',
  sceneParams: {},
  effects: [],
  modulations: [],
  palette: PALETTES[0],
  presetId: null,
  track: null,
  analysis: null,
  analyzing: false,
  photos: [],
  text: '',
  aspect: (persisted.aspect as Aspect) ?? 'fill',
  inspectorTab: 'scene',
  perform: false,
  autoPilot: false,
  sensitivity: persisted.sensitivity ?? 1,
  quality: persisted.quality ?? 1,
  customPresets: persisted.customPresets ?? [],
  customShaders: persisted.customShaders ?? [],
  shaderError: null,
  toast: null,
  recording: false,

  applyPreset: (p) => {
    const look = presetToLook(p);
    if (!getScene(look.sceneId)) return;
    set({ ...look, presetId: p.id, shaderError: null });
  },

  setScene: (id) => {
    const def = getScene(id);
    if (!def) return;
    const sceneParams: Record<string, ParamValue> = {};
    for (const d of def.params) sceneParams[d.id] = d.default;
    // keep fx routings, replace scene routings with the scene's suggestions
    const keep = get().modulations.filter((m) => !m.target.startsWith('scene.'));
    const seeds: Modulation[] = (def.modulations ?? []).map((m) => ({
      id: uid('mod'),
      source: m.source,
      target: `scene.${m.param}`,
      amount: m.amount,
      enabled: true,
    }));
    set({ sceneId: id, sceneParams, modulations: [...keep, ...seeds], presetId: null, shaderError: null });
  },

  setSceneParam: (id, v) => set((s) => ({ sceneParams: { ...s.sceneParams, [id]: v } })),

  addEffect: (effectId) => {
    const def = getEffect(effectId);
    if (!def) return;
    const params: Record<string, ParamValue> = {};
    for (const d of def.params) params[d.id] = d.default;
    const inst: EffectInstance = { instanceId: uid('fx'), effectId, enabled: true, params };
    set((s) => ({ effects: [...s.effects, inst] }));
  },
  removeEffect: (instanceId) =>
    set((s) => ({
      effects: s.effects.filter((e) => e.instanceId !== instanceId),
      modulations: s.modulations.filter((m) => !m.target.startsWith(`fx.${instanceId}.`)),
    })),
  toggleEffect: (instanceId) =>
    set((s) => ({ effects: s.effects.map((e) => (e.instanceId === instanceId ? { ...e, enabled: !e.enabled } : e)) })),
  moveEffect: (instanceId, dir) =>
    set((s) => {
      const i = s.effects.findIndex((e) => e.instanceId === instanceId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= s.effects.length) return {};
      const arr = s.effects.slice();
      [arr[i], arr[j]] = [arr[j], arr[i]];
      return { effects: arr };
    }),
  setEffectParam: (instanceId, id, v) =>
    set((s) => ({
      effects: s.effects.map((e) => (e.instanceId === instanceId ? { ...e, params: { ...e.params, [id]: v } } : e)),
    })),

  addModulation: (source, target, amount = 0.5) =>
    set((s) => ({ modulations: [...s.modulations, { id: uid('mod'), source, target, amount, enabled: true }] })),
  updateModulation: (id, patch) =>
    set((s) => ({ modulations: s.modulations.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
  removeModulation: (id) => set((s) => ({ modulations: s.modulations.filter((m) => m.id !== id) })),

  setPalette: (p) => set({ palette: { ...p } }),
  setPaletteColor: (key, hex) => set((s) => ({ palette: { ...s.palette, id: 'custom', name: 'Custom', [key]: hex } })),

  addPhotos: (p) => set((s) => ({ photos: [...s.photos, ...p] })),
  removePhoto: (id) =>
    set((s) => {
      const ph = s.photos.find((x) => x.id === id);
      ph?.texture.dispose();
      return { photos: s.photos.filter((x) => x.id !== id) };
    }),

  saveCurrentAsPreset: (name) => {
    const s = get();
    const p = lookToPreset(s, { id: uid('preset'), name, description: 'Saved from the studio', tags: ['custom'] });
    set({ customPresets: [p, ...s.customPresets], presetId: p.id });
    persist(get());
    return p;
  },
  deleteCustomPreset: (id) => {
    set((s) => ({ customPresets: s.customPresets.filter((p) => p.id !== id) }));
    persist(get());
  },
  addCustomShader: (spec) => {
    registerScene(makeCustomShaderScene(spec));
    set((s) => ({ customShaders: [spec, ...s.customShaders.filter((x) => x.id !== spec.id)] }));
    persist(get());
  },

  set: (patch) => {
    set(patch);
    if ('aspect' in patch || 'sensitivity' in patch || 'quality' in patch) persist(get());
  },
  flash: (msg) => {
    clearTimeout(toastTimer);
    set({ toast: msg });
    toastTimer = setTimeout(() => set({ toast: null }), 2600);
  },
}));
