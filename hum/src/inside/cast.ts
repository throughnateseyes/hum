/**
 * Which drawing stands in an inside shot: the one its part was given, once it has been drawn (one redrawn
 * since stands in for it). Only where drawings are allowed, and never one that was deleted.
 */
import { drawingNow, drawingsHere } from '../draw/session';
import type { Shot } from '../shot/sequence';
import type { Drawn } from './drawn';
import { cleanDrawn } from './drawnIds';

export function drawnIn(shot: Shot): Drawn | null {
  const d = cleanDrawn(shot.drawn);
  if (!d) return null;
  const asset = drawingNow(d.id, drawingsHere());
  return asset ? { asset, put: d.put, size: d.size, enter: d.enter, ...(d.spots ? { spots: d.spots } : {}), arrives: shot.index === 0 } : null;
}
