import * as THREE from 'three';
import type { LayerId, Palette, ResolvedPalette } from './types';

/** Curated palettes. The light ones echo the off-white "instrument board" references. */
export const PALETTES: Palette[] = [
  { id: 'paper-blue', name: 'Paper / Ultramarine', bg: '#f2f0ea', fg: '#16161a', accent: '#2f4bff', accent2: '#9db4ff', muted: '#c9c6bd' },
  { id: 'cream-violet', name: 'Cream / Violet', bg: '#ece8d6', fg: '#1d1b22', accent: '#6b4cff', accent2: '#ff7a3d', muted: '#cfc9b3' },
  { id: 'bone-ink', name: 'Bone / Ink', bg: '#efede6', fg: '#0d0d0f', accent: '#0d0d0f', accent2: '#8a877e', muted: '#d6d3ca' },
  { id: 'sky-film', name: 'Sky Film', bg: '#eef2f7', fg: '#1a2230', accent: '#5b8cff', accent2: '#c7d8ff', muted: '#cdd6e2' },
  { id: 'clay', name: 'Clay', bg: '#e9e2d8', fg: '#2b2420', accent: '#c4673f', accent2: '#e8b48a', muted: '#cbbfb0' },
  { id: 'mint-lab', name: 'Mint Lab', bg: '#eef3ef', fg: '#132019', accent: '#13a36b', accent2: '#ffcf3d', muted: '#c9d6cd' },
  { id: 'midnight', name: 'Midnight', bg: '#07080c', fg: '#e8ecf5', accent: '#5b7cff', accent2: '#c56bff', muted: '#20232e' },
  { id: 'sodium', name: 'Sodium', bg: '#0b0806', fg: '#ffe9cf', accent: '#ff7a1a', accent2: '#ffd166', muted: '#2a1f17' },
  { id: 'acid', name: 'Acid', bg: '#050505', fg: '#f4f4f4', accent: '#c6ff1a', accent2: '#1affd5', muted: '#1c1c1c' },
  { id: 'bruise', name: 'Bruise', bg: '#0c0a14', fg: '#ece6ff', accent: '#7a3cff', accent2: '#ff3c8a', muted: '#231d33' },
  { id: 'rain', name: 'Rain', bg: '#111418', fg: '#cfd8e3', accent: '#7f97b3', accent2: '#3e5470', muted: '#232a33' },
  { id: 'marble', name: 'Marble (blue/gold)', bg: '#140f3d', fg: '#f5e9c8', accent: '#3b2dd6', accent2: '#e8b13a', muted: '#2a2270' },
  { id: 'mono', name: 'Mono', bg: '#000000', fg: '#ffffff', accent: '#bdbdbd', accent2: '#5c5c5c', muted: '#1a1a1a' },
  { id: 'blush', name: 'Blush', bg: '#f6ecea', fg: '#2a1a1d', accent: '#ff5a7a', accent2: '#ffb38a', muted: '#e2cfcb' },
];

export function getPalette(id: string): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}

export function resolvePalette(p: Palette, into?: ResolvedPalette): ResolvedPalette {
  const r = into ?? {
    ...p,
    c: { bg: new THREE.Color(), fg: new THREE.Color(), accent: new THREE.Color(), accent2: new THREE.Color(), muted: new THREE.Color() },
  };
  Object.assign(r, p);
  r.c.bg.set(p.bg);
  r.c.fg.set(p.fg);
  r.c.accent.set(p.accent);
  r.c.accent2.set(p.accent2);
  r.c.muted.set(p.muted);
  return r;
}

export function isLightPalette(p: Palette): boolean {
  const c = new THREE.Color(p.bg);
  return c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722 > 0.5;
}

/** Display metadata for audio layers. */
export const LAYERS: { id: LayerId; label: string; short: string; group: 'bands' | 'hits' | 'shape' | 'time'; hint: string }[] = [
  { id: 'level', label: 'Level', short: 'LVL', group: 'shape', hint: 'Overall loudness' },
  { id: 'sub', label: 'Sub', short: 'SUB', group: 'bands', hint: '20–60 Hz · the low end you feel' },
  { id: 'bass', label: 'Bass', short: 'BAS', group: 'bands', hint: '60–250 Hz · kick body, bassline' },
  { id: 'lowMid', label: 'Low mid', short: 'LMD', group: 'bands', hint: '250–500 Hz · warmth' },
  { id: 'mid', label: 'Mid', short: 'MID', group: 'bands', hint: '500 Hz–2 kHz · vocals, leads' },
  { id: 'highMid', label: 'High mid', short: 'HMD', group: 'bands', hint: '2–6 kHz · presence, attack' },
  { id: 'air', label: 'Air', short: 'AIR', group: 'bands', hint: '6–20 kHz · hats, shimmer' },
  { id: 'kick', label: 'Kick', short: 'KCK', group: 'hits', hint: 'Low transients' },
  { id: 'snare', label: 'Snare', short: 'SNR', group: 'hits', hint: 'Mid transients' },
  { id: 'hat', label: 'Hats', short: 'HAT', group: 'hits', hint: 'High transients' },
  { id: 'energy', label: 'Energy', short: 'NRG', group: 'shape', hint: 'Section intensity (slow)' },
  { id: 'brightness', label: 'Brightness', short: 'BRT', group: 'shape', hint: 'Dark ↔ bright timbre' },
  { id: 'flux', label: 'Flux', short: 'FLX', group: 'shape', hint: 'How fast the sound changes' },
  { id: 'build', label: 'Build', short: 'BLD', group: 'time', hint: 'Rises during build-ups' },
  { id: 'drop', label: 'Drop', short: 'DRP', group: 'time', hint: 'Fires when the drop hits' },
  { id: 'beatPhase', label: 'Beat phase', short: 'PHS', group: 'time', hint: '0→1 every beat' },
  { id: 'sway', label: 'Sway', short: 'SWY', group: 'time', hint: 'Slow bar-locked sine' },
];
