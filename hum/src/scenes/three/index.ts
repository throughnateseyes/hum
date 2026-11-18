import type { SceneDef } from '../../core/types';
import { clayOrb } from './clayOrb';
import { pointSwarm } from './pointSwarm';
import { ridgeline } from './ridgeline';
import { ringTunnel } from './ringTunnel';
import { monolithGrid } from './monolithGrid';
import { silk } from './silk';

export const scenes: SceneDef[] = [clayOrb, pointSwarm, ridgeline, ringTunnel, monolithGrid, silk];
