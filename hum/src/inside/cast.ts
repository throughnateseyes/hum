/**
 * Which drawing stands in an inside shot: the one its part was given, once it has been drawn (one redrawn
 * since stands in for it). Only where drawings are allowed, and never one that was deleted.
 */
import { drawingNow, drawingsHere } from '../draw/session';
import type { Shot } from '../shot/sequence';
import type { Drawn } from './drawn';

export function drawnIn(shot: Shot): Drawn | null {
  if (!shot.drawn) return null;
  const asset = drawingNow(shot.drawn.id, drawingsHere());
  return asset ? { asset, put: shot.drawn.put, size: shot.drawn.size, enter: shot.drawn.enter, arrives: shot.index === 0 } : null;
}
