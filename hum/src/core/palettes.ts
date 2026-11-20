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
  // inspo looks: text wall, particle columns, glass planes, tracking HUD
  { id: 'redact', name: 'Redact', bg: '#000000', fg: '#f4f4f4', accent: '#ff3b1f', accent2: '#2333ff', muted: '#3b3b3b' },
  { id: 'ice', name: 'Ice', bg: '#010406', fg: '#f2fbff', accent: '#3fc8e6', accent2: '#0f5d78', muted: '#0b1d24' },
  { id: 'glasshouse', name: 'Glasshouse', bg: '#04080b', fg: '#d6f1ff', accent: '#dcff6b', accent2: '#3a8db0', muted: '#0f2530' },
  { id: 'hud-blue', name: 'HUD Blue', bg: '#04050a', fg: '#eef5ff', accent: '#2f63ff', accent2: '#3fdcff', muted: '#121726' },
  // inspo looks: paper visualizer, glyph mosaic, pixel cube, flip cards
  { id: 'paper-red', name: 'Paper / Red', bg: '#f4f2ee', fg: '#2a2a2c', accent: '#b8232c', accent2: '#e06a5a', muted: '#cfcac3' },
  { id: 'cobalt', name: 'Cobalt', bg: '#f6f6f1', fg: '#0f1a66', accent: '#1238ff', accent2: '#8ea0ff', muted: '#c9d0f5' },
  { id: 'pistachio', name: 'Pistachio Poster', bg: '#dde4a3', fg: '#141414', accent: '#1d3bff', accent2: '#f2d70c', muted: '#f7f7f0' },
  { id: 'bubblegum', name: 'Bubblegum Poster', bg: '#ffc9de', fg: '#161616', accent: '#ff5a1f', accent2: '#2b44ff', muted: '#ffffff' },
  { id: 'flip-night', name: 'Flip Night', bg: '#000000', fg: '#f4f0e6', accent: '#ffd400', accent2: '#ff6b2b', muted: '#4e0a7a' },
  // nature looks: gilded clouds, canopy, above the clouds, still water
  { id: 'gilded-sky', name: 'Gilded Sky', bg: '#7f9cb8', fg: '#2c4766', accent: '#f4e8cc', accent2: '#d8b26a', muted: '#b4c4d0' },
  { id: 'canopy', name: 'Canopy', bg: '#7fb3e3', fg: '#1d3520', accent: '#a7cf4f', accent2: '#fff6dc', muted: '#4f7d33' },
  { id: 'golden-hour', name: 'Golden Hour', bg: '#231d33', fg: '#ffeccb', accent: '#eda54a', accent2: '#c46a5e', muted: '#4b4361' },
  { id: 'still-water', name: 'Still Water', bg: '#1e4c56', fg: '#e8f4ef', accent: '#7fc7c0', accent2: '#d6a15c', muted: '#2e6a6f' },
  // laminar: dusk garden, night plaza, studio
  { id: 'laminar-dusk', name: 'Laminar Dusk', bg: '#2b3b5e', fg: '#fff0dc', accent: '#a6eaff', accent2: '#eea56a', muted: '#2f4032' },
  { id: 'laminar-night', name: 'Laminar Night', bg: '#0b0f1a', fg: '#ffe9cc', accent: '#5fd4ff', accent2: '#ffad5c', muted: '#232838' },
  { id: 'laminar-studio', name: 'Laminar Studio', bg: '#cdd1d4', fg: '#ffffff', accent: '#bfe6ff', accent2: '#e8c39a', muted: '#6c7276' },
  /* looks built from the reference boards */
  // gradient cubes
  { id: 'toy-box', name: 'Toy Box', bg: '#7d5a50', fg: '#ff8de4', accent: '#ff431a', accent2: '#2247e6', muted: '#7cc63f' },
  { id: 'sorbet-cream', name: 'Sorbet / Cream', bg: '#f1e8d8', fg: '#f7a8c4', accent: '#ff9a76', accent2: '#8fb8ee', muted: '#9fd8b0' },
  // neurones
  { id: 'neon-synapse', name: 'Neon Synapse', bg: '#050508', fg: '#ffec80', accent: '#ff7ac6', accent2: '#4dfcae', muted: '#3d4bff' },
  { id: 'pressed-fern', name: 'Pressed Fern', bg: '#f1eadb', fg: '#1c2420', accent: '#3f6e4c', accent2: '#b5532f', muted: '#6a5a48' },
  // willow
  { id: 'willow-green', name: 'Willow Green', bg: '#10a06c', fg: '#0b0f0a', accent: '#6aa72a', accent2: '#d6e24c', muted: '#1b5523' },
  { id: 'willow-moon', name: 'Willow Moon', bg: '#1f5088', fg: '#050914', accent: '#3f83bd', accent2: '#cfe6f2', muted: '#122f5e' },
  // wing
  { id: 'wing-blush', name: 'Wing Blush', bg: '#050404', fg: '#f5e6d8', accent: '#f2554a', accent2: '#2e8dff', muted: '#c47a2a' },
  { id: 'wing-moon-moth', name: 'Moon Moth', bg: '#05070c', fg: '#d3dbe8', accent: '#7d8fbc', accent2: '#f3cf8a', muted: '#56617a' },
  { id: 'wing-morpho', name: 'Morpho', bg: '#02030a', fg: '#58c4ff', accent: '#2b3bff', accent2: '#eaf6ff', muted: '#16245c' },
  // halftone flow
  { id: 'ochre-teal-night', name: 'Ochre Teal Night', bg: '#050507', fg: '#f5e8cc', accent: '#e0812a', accent2: '#2a9fb8', muted: '#4338a8' },
  { id: 'riso-coral-teal', name: 'Riso Coral Teal', bg: '#efe6d2', fg: '#1b1a2e', accent: '#e4572e', accent2: '#1f7a8c', muted: '#2d2a6e' },
  // dot assembly
  { id: 'marbles', name: 'Marbles', bg: '#000000', fg: '#ffd21f', accent: '#ff3b1a', accent2: '#33a7f2', muted: '#a78be0' },
  { id: 'riso-confetti', name: 'Riso Confetti', bg: '#f2ead8', fg: '#1b2a6b', accent: '#ef4a2c', accent2: '#19a67a', muted: '#f4b62f' },
  // signal scan
  { id: 'scan-mono', name: 'Scan Mono', bg: '#000000', fg: '#f4f4f2', accent: '#2f5bff', accent2: '#f4f4f2', muted: '#5c5f66' },
  { id: 'scan-paper', name: 'Scan Paper', bg: '#e9e6dd', fg: '#111114', accent: '#e2362a', accent2: '#111114', muted: '#b8b4a8' },
  // soft orbs
  { id: 'milk-neon', name: 'Milk Neon', bg: '#000000', fg: '#fffaf0', accent: '#ff2ed1', accent2: '#ffd500', muted: '#8ec9f2' },
  { id: 'ink-on-cream', name: 'Ink on Cream', bg: '#f2ecdf', fg: '#1c1a22', accent: '#e5432b', accent2: '#f0b23a', muted: '#8fa6bf' },
  { id: 'amber-lamps', name: 'Amber Lamps', bg: '#070302', fg: '#ffe8c2', accent: '#ff5a1f', accent2: '#ffb300', muted: '#c4703c' },
  // bead fire
  { id: 'hot-rod-beads', name: 'Hot Rod Beads', bg: '#b3140f', fg: '#0d0705', accent: '#f0a53a', accent2: '#fff3d6', muted: '#6e0b0c' },
  { id: 'gas-flame-beads', name: 'Gas Flame Beads', bg: '#0d1f4a', fg: '#03050c', accent: '#39a0ff', accent2: '#eafcff', muted: '#071230' },
  // night windows
  { id: 'blue-hour-windows', name: 'Blue Hour Windows', bg: '#3c5a93', fg: '#ffd766', accent: '#f0643c', accent2: '#59c7d6', muted: '#1b2547' },
  { id: 'pink-dawn-windows', name: 'Pink Dawn Windows', bg: '#e79aa6', fg: '#ffe9a8', accent: '#ff7a4d', accent2: '#7fd6d0', muted: '#3a2a5c' },
  { id: 'neon-rain-windows', name: 'Neon Rain Windows', bg: '#12303a', fg: '#ff4fa3', accent: '#ffb23e', accent2: '#3df0ff', muted: '#0b1420' },
  // signal forest
  { id: 'signal-night', name: 'Signal Night', bg: '#04050b', fg: '#fff4c2', accent: '#35e8e0', accent2: '#ff4fae', muted: '#6f7cf0' },
  { id: 'signal-dawn', name: 'Signal Dawn', bg: '#140c0a', fg: '#ffe9cf', accent: '#ffb347', accent2: '#ff5d4a', muted: '#b9806e' },
  // confetti
  { id: 'confetti-paper', name: 'Confetti Paper', bg: '#fbfaf6', fg: '#1b2a8f', accent: '#2f8fe6', accent2: '#e8283c', muted: '#f7c62a' },
  { id: 'confetti-neon', name: 'Confetti Neon', bg: '#0a0a14', fg: '#f6f2ff', accent: '#19c8ff', accent2: '#ff2e7a', muted: '#ffdf3a' },
  // word drop
  { id: 'pocket-note', name: 'Pocket Note', bg: '#d9ceb7', fg: '#2a2a27', accent: '#e8951d', accent2: '#1f4e9e', muted: '#b3281f' },
  { id: 'midnight-letter', name: 'Midnight Letter', bg: '#14182b', fg: '#f3ead8', accent: '#ff6b5a', accent2: '#f2b84b', muted: '#5c6fd6' },
  // prism
  { id: 'pearl-taupe', name: 'Pearl Taupe', bg: '#4d473f', fg: '#fff5e6', accent: '#35b8b0', accent2: '#f29a4a', muted: '#a89d8c' },
  { id: 'abyss-glass', name: 'Abyss Glass', bg: '#03121c', fg: '#d9fbff', accent: '#19c8d8', accent2: '#7a6bff', muted: '#0e3a4c' },
  // specimen tiles
  { id: 'specimen-ink', name: 'Specimen Ink', bg: '#ede0c4', fg: '#18203a', accent: '#f0702a', accent2: '#d2376b', muted: '#e7b13f' },
  { id: 'night-lab', name: 'Night Lab', bg: '#0f1218', fg: '#e8e2d0', accent: '#35c9b8', accent2: '#7b5cf0', muted: '#f2b84b' },
  // jellies
  { id: 'moon-tank', name: 'Moon Tank', bg: '#03112a', fg: '#ecfbff', accent: '#56d8f2', accent2: '#b67cff', muted: '#1b4f86' },
  { id: 'scope-black', name: 'Scope Black', bg: '#030404', fg: '#f1f1ec', accent: '#c9d6d2', accent2: '#ffd98f', muted: '#474d52' },
  // shoal
  { id: 'deep-shoal', name: 'Deep Shoal', bg: '#030a12', fg: '#e2e9f0', accent: '#43d3e6', accent2: '#ff7448', muted: '#1f4466' },
  { id: 'morning-shallows', name: 'Morning Shallows', bg: '#2a6f7a', fg: '#fff4dc', accent: '#ffd27a', accent2: '#ff8a5c', muted: '#7cc4c0' },
  // observer
  { id: 'webcam-sky', name: 'Webcam Sky', bg: '#040407', fg: '#d8dbe4', accent: '#5f9dff', accent2: '#d58cff', muted: '#7f89b0' },
  { id: 'green-phosphor', name: 'Green Phosphor', bg: '#020604', fg: '#c4f2cf', accent: '#2fbf74', accent2: '#a6e85a', muted: '#3f6a55' },
  // retro desktop
  { id: 'desktop-sky', name: 'Desktop Sky', bg: '#3f86e0', fg: '#101218', accent: '#4f9e2c', accent2: '#e8382c', muted: '#c3c3c0' },
  { id: 'after-midnight', name: 'After Midnight', bg: '#0f1838', fg: '#efe8d6', accent: '#245c45', accent2: '#ff5d4a', muted: '#3a3e58' },
  // orrery
  { id: 'seraph-white', name: 'Seraph White', bg: '#f3efec', fg: '#2b2328', accent: '#c4907f', accent2: '#7aa6cf', muted: '#b8b2b4' },
  { id: 'gilded-night', name: 'Gilded Night', bg: '#0e1322', fg: '#05060b', accent: '#d6a85c', accent2: '#f0a63c', muted: '#3c4766' },
  // night train
  { id: 'night-carriage', name: 'Night Carriage', bg: '#0c1024', fg: '#f4e4c4', accent: '#ff8a3d', accent2: '#c98a9c', muted: '#3f6070' },
  { id: 'pocket-green', name: 'Pocket Green', bg: '#0e1c12', fg: '#d6ec9e', accent: '#b4d66a', accent2: '#6e9a4e', muted: '#35583a' },
  { id: 'dawn-carriage', name: 'Dawn Carriage', bg: '#1b2a3e', fg: '#fbe7d3', accent: '#f6a57a', accent2: '#9cc3d9', muted: '#6f8aa6' },
  // ribbon type
  { id: 'gig-poster', name: 'Gig Poster', bg: '#ff4a26', fg: '#141210', accent: '#f6a8e2', accent2: '#d3ec7c', muted: '#8f86f7' },
  { id: 'after-hours-tape', name: 'After Hours Tape', bg: '#0f1016', fg: '#f3eee3', accent: '#ff5b37', accent2: '#e8dfcb', muted: '#4a43d6' },
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
  { id: 'level', label: 'Level', short: 'Level', group: 'shape', hint: 'Overall loudness' },
  { id: 'sub', label: 'Sub', short: 'Sub', group: 'bands', hint: '20–60 Hz · the low end you feel' },
  { id: 'bass', label: 'Bass', short: 'Bass', group: 'bands', hint: '60–250 Hz · kick body, bassline' },
  { id: 'lowMid', label: 'Low mid', short: 'Lo mid', group: 'bands', hint: '250–500 Hz · warmth' },
  { id: 'mid', label: 'Mid', short: 'Mid', group: 'bands', hint: '500 Hz–2 kHz · vocals, leads' },
  { id: 'highMid', label: 'High mid', short: 'Hi mid', group: 'bands', hint: '2–6 kHz · presence, attack' },
  { id: 'air', label: 'Air', short: 'Air', group: 'bands', hint: '6–20 kHz · hats, shimmer' },
  { id: 'kick', label: 'Kick', short: 'Kick', group: 'hits', hint: 'Low transients' },
  { id: 'snare', label: 'Snare', short: 'Snare', group: 'hits', hint: 'Mid transients' },
  { id: 'hat', label: 'Hats', short: 'Hats', group: 'hits', hint: 'High transients' },
  { id: 'energy', label: 'Energy', short: 'Energy', group: 'shape', hint: 'Section intensity (slow)' },
  { id: 'brightness', label: 'Brightness', short: 'Bright', group: 'shape', hint: 'Dark ↔ bright timbre' },
  { id: 'flux', label: 'Flux', short: 'Flux', group: 'shape', hint: 'How fast the sound changes' },
  { id: 'build', label: 'Build', short: 'Build', group: 'time', hint: 'Rises during build-ups' },
  { id: 'drop', label: 'Drop', short: 'Drop', group: 'time', hint: 'Fires when the drop hits' },
  { id: 'beatPhase', label: 'Beat phase', short: 'Beat', group: 'time', hint: '0→1 every beat' },
  { id: 'sway', label: 'Sway', short: 'Sway', group: 'time', hint: 'Slow bar-locked sine' },
];
