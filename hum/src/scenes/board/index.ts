/**
 * Hero scenes — "instrument boards". Off-white sheets of hairline panels, each a tiny live
 * instrument reading the music. Modules live in mod-*.ts; layout + static caching in engine.ts.
 */
import type { SceneDef } from '../../core/types';
import { defineBoard } from './engine';
import { footer, header } from './mod-info';
import { flow, tetris, topo, voronoi } from './mod-gen';
import { photoDissolve, photoMosaic } from './mod-photo';
import {
  bandWaves,
  chroma,
  knobs,
  lineGraph,
  meters,
  overview,
  pads,
  pianoRoll,
  radial,
  scope,
  spectrogram,
  spectrumBars,
  stepSeq,
  vectorScope,
} from './mod-signal';

const HEAD = '86px';
const FOOT = '40px';

const orbit = defineBoard({
  id: 'board-orbit',
  name: 'Board · Orbit',
  description:
    'Photo-led instrument board: a block-dissolve photo with lyric text, spectrogram, stacked band waveforms, piano roll, pads and a radial beat meter.',
  tags: ['editorial', 'clean', 'photo', 'lyric', 'minimal', 'pop', 'indie', 'electronic', 'board'],
  usesPhotos: true,
  params: [
    { id: 'glitch', label: 'Glitch amount', type: 'number', group: 'Photo', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Macroblocks on kicks' },
    { id: 'textSize', label: 'Lyric size', type: 'number', group: 'Photo', min: 0.4, max: 2, step: 0.05, default: 1 },
  ],
  modulations: [
    { source: 'kick', param: 'glitch', amount: 0.25 },
    { source: 'energy', param: 'speed', amount: 0.2 },
  ],
  templates: {
    tall: {
      cols: [1, 1, 1, 1],
      rows: [HEAD, 4.6, 1.55, 1.6, 1.5, FOOT],
      areas: [
        'head head head head',
        'photo photo photo photo',
        'spec spec wave wave',
        'roll roll radial radial',
        'pads pads radial radial',
        'foot foot foot foot',
      ],
    },
    square: {
      cols: [1, 1, 1, 1.05],
      rows: [HEAD, 1.5, 1.25, 0.95, 0.8, FOOT],
      areas: [
        'head head head head',
        'photo photo photo radial',
        'photo photo photo pads',
        'spec spec wave wave',
        'roll roll roll roll',
        'foot foot foot foot',
      ],
    },
    wide: {
      cols: [1, 1, 1, 0.8, 0.8, 1],
      rows: [HEAD, 1, 1, 1, FOOT],
      areas: [
        'head head head head head head',
        'photo photo photo spec spec radial',
        'photo photo photo wave wave radial',
        'photo photo photo roll roll pads',
        'foot foot foot foot foot foot',
      ],
    },
  },
  build: () => ({
    head: header('HUM/ORBIT', 'INSTRUMENT BOARD 01'),
    photo: photoDissolve(),
    spec: spectrogram(),
    wave: bandWaves(),
    roll: pianoRoll(),
    radial: radial(),
    pads: pads(),
    foot: footer('HUM.ORBIT'),
  }),
});

const lab = defineBoard({
  id: 'board-lab',
  name: 'Board · Lab',
  description:
    'Module-grid lab sheet: topographic contours, tetris pieces on every kick, voronoi cells per band, energy graph, pitch, LED meters and a 16-step sequencer.',
  tags: ['playful', 'technical', 'grid', 'dance', 'house', 'techno', 'hip-hop', 'board'],
  params: [
    { id: 'density', label: 'Density', type: 'number', group: 'Modules', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'Contour levels, voronoi cells' },
    { id: 'relief', label: 'Bass relief', type: 'number', group: 'Modules', min: 0, max: 2, step: 0.01, default: 0.7, hint: 'How hard the bass lifts the terrain' },
    { id: 'fall', label: 'Fall speed', type: 'number', group: 'Modules', min: 0.2, max: 3, step: 0.05, default: 1 },
  ],
  modulations: [
    { source: 'bass', param: 'relief', amount: 0.25 },
    { source: 'energy', param: 'fall', amount: 0.2 },
  ],
  defaults: { accent: 1 },
  templates: {
    tall: {
      cols: [1, 1, 1, 1],
      rows: [HEAD, 4, 1.6, 1.6, 1.15, FOOT],
      areas: [
        'head head head head',
        'topo topo tetris tetris',
        'voro voro graph graph',
        'voro voro pitch meter',
        'seq seq seq seq',
        'foot foot foot foot',
      ],
    },
    square: {
      cols: [1, 1, 1, 0.9],
      rows: [HEAD, 2, 1.15, 1, FOOT],
      areas: [
        'head head head head',
        'topo topo voro tetris',
        'graph graph pitch tetris',
        'meter seq seq seq',
        'foot foot foot foot',
      ],
    },
    wide: {
      cols: [1, 1, 1, 1, 0.8, 0.8],
      rows: [HEAD, 1.3, 1, 0.85, FOOT],
      areas: [
        'head head head head head head',
        'topo topo voro voro tetris pitch',
        'topo topo voro voro tetris meter',
        'graph graph seq seq seq seq',
        'foot foot foot foot foot foot',
      ],
    },
  },
  build: () => ({
    head: header('HUM/LAB', 'MODULE SHEET 04'),
    topo: topo(),
    tetris: tetris(),
    voro: voronoi(),
    graph: lineGraph([
      { id: 'energy', label: 'NRG', tone: 'ac' },
      { id: 'level', label: 'LVL', tone: 'fg' },
      { id: 'brightness', label: 'BRT', tone: 'ac2' },
    ]),
    pitch: chroma(),
    meter: meters(),
    seq: stepSeq(),
    foot: footer('HUM.LAB'),
  }),
});

const oto = defineBoard({
  id: 'board-oto',
  name: 'Board · Oto',
  description:
    'A large flow-field hairline sculpture combed by the music, over a knob row, track waveform, scope / spectrum / vector minis and a posterized photo mosaic.',
  tags: ['flowing', 'calm', 'ambient', 'organic', 'hair', 'editorial', 'lo-fi', 'board'],
  usesPhotos: true,
  params: [
    { id: 'density', label: 'Stroke density', type: 'number', group: 'Flow', min: 0, max: 1, step: 0.01, default: 0.55 },
    { id: 'strokeLength', label: 'Stroke length', type: 'number', group: 'Flow', min: 0.2, max: 2.5, step: 0.05, default: 1 },
    { id: 'swirl', label: 'Swirl', type: 'number', group: 'Flow', min: 0, max: 1, step: 0.01, default: 0.55, hint: 'Noise-combed ↔ vortex' },
    { id: 'mosaic', label: 'Mosaic cells', type: 'number', group: 'Photo', min: 10, max: 72, step: 1, default: 28 },
  ],
  modulations: [
    { source: 'bass', param: 'strokeLength', amount: 0.2 },
    { source: 'energy', param: 'swirl', amount: 0.2 },
  ],
  templates: {
    tall: {
      cols: [1, 1, 1, 1],
      rows: [HEAD, 5, 0.95, 0.6, 1.05, 0.9, FOOT],
      areas: [
        'head head head head',
        'flow flow flow flow',
        'knobs knobs knobs knobs',
        'wave wave wave wave',
        'scope vec photo photo',
        'spec spec photo photo',
        'foot foot foot foot',
      ],
    },
    square: {
      cols: [1, 1, 1, 1],
      rows: [HEAD, 1.45, 1, 0.75, 0.55, FOOT],
      areas: [
        'head head head head',
        'flow flow flow photo',
        'flow flow flow scope',
        'knobs knobs knobs vec',
        'wave wave spec spec',
        'foot foot foot foot',
      ],
    },
    wide: {
      cols: [1, 1, 1, 1, 0.9, 0.9],
      rows: [HEAD, 1.5, 1, 0.7, 0.68, FOOT],
      areas: [
        'head head head head head head',
        'flow flow flow flow photo photo',
        'flow flow flow flow scope vec',
        'flow flow flow flow spec spec',
        'knobs knobs knobs wave wave wave',
        'foot foot foot foot foot foot',
      ],
    },
  },
  build: () => ({
    head: header('HUM/OTO', 'FLOW INSTRUMENT 03'),
    flow: flow(),
    knobs: knobs(),
    wave: overview(),
    scope: scope(),
    vec: vectorScope(),
    spec: spectrumBars(),
    photo: photoMosaic(),
    foot: footer('HUM.OTO'),
  }),
});

export const scenes: SceneDef[] = [orbit, lab, oto];
