import type { SceneDef } from '../../core/types';
import { clayOrb } from './clayOrb';
import { pointSwarm } from './pointSwarm';
import { ridgeline } from './ridgeline';
import { ringTunnel } from './ringTunnel';
import { monolithGrid } from './monolithGrid';
import { silk } from './silk';
import { particleColumns } from './particleColumns';
import { glassPlanes } from './glassPlanes';
import { trackingHud } from './trackingHud';
import { paperVisualizer } from './paperVisualizer';
import { pixelCube } from './pixelCube';
import { flipCards } from './flipCards';
import { gradientCubes } from './gradientCubes';
import { neurones } from './neurones';
import { dotAssembly } from './dotAssembly';

export const scenes: SceneDef[] = [clayOrb, pointSwarm, ridgeline, ringTunnel, monolithGrid, silk, paperVisualizer, pixelCube, flipCards];

// inspo looks: particle columns, glass planes, tracking HUD
scenes.push(particleColumns, glassPlanes, trackingHud);

// looks built from the reference boards
scenes.push(gradientCubes, neurones, dotAssembly);
