/** Every motif a shot can ask for, by id (prototype; the contract is in src/shot/kit.ts). */
import type { MotifFactory } from '../kit';
import { arcs, bars, blocks, burst, cardType, guides, ruler, word } from './core';
import { floor } from './floor';
import { ribbons, threads } from './ribbons';
import { typeStack } from './typeStack';

export const MOTIFS: Record<string, MotifFactory> = { arcs, bars, blocks, burst, cardType, floor, guides, ribbons, ruler, threads, typeStack, word };
