/** The moments inside a clip that a cut can land on. `x`, `y`: where, 0..1 from the left and the bottom. */
export type EventKind =
  /** the strongest movement round here (a swing, a splash, a jump's push) */
  | 'peak'
  /** movement that ends suddenly (a landing, a catch, the camera coming to rest) */
  | 'stop'
  /** movement that begins suddenly */
  | 'start'
  /** what moves turns back (the top of a jump, a bounce, a whip of the camera) */
  | 'turn'
  /** the picture lights up, or goes dark */
  | 'flash'
  /** the clip itself cuts to something else */
  | 'cut';

export interface ClipEvent {
  /** second of the clip */
  at: number;
  kind: EventKind;
  /** whether the subject did it or the camera */
  of: 'subject' | 'camera';
  /** 0..1: how clearly it happens */
  strength: number;
  x: number;
  y: number;
}

/** How a clip moves, step by step. Every list has one entry per step; entry i is the second `(i + 0.5) * step`. */
export interface ClipMotion {
  v: number;
  step: number;
  duration: number;
  /** frames a second the clip was shot at, as near as could be told */
  fps: number;
  /** how much moves besides the camera, about 0..1 */
  act: number[];
  /** the camera's slide, in frame heights a second (+x: the picture moves right), and its push in, a second */
  camX: number[];
  camY: number[];
  push: number[];
  /** which way what moves goes, in frame heights a second (0: nothing clear) */
  goX: number[];
  goY: number[];
  /** 0..1 */
  bright: number[];
  /** in time order; `cut`s included */
  events: ClipEvent[];
}

const SAW: Record<EventKind, string> = { peak: 'a burst of movement', stop: 'movement ends', start: 'movement begins', turn: 'movement turns back', flash: 'the light changes', cut: 'the clip cuts' };

/** an event in a few words, as measured (what it really is takes looking at it) */
export function sawOf(e: ClipEvent): string {
  if (e.of === 'camera') return e.kind === 'stop' ? 'the camera comes to rest' : e.kind === 'start' ? 'the camera moves off' : e.kind === 'turn' ? 'the camera turns back' : 'the camera moves fast';
  const x = e.x < 0.36 ? 'left' : e.x > 0.64 ? 'right' : 'middle';
  const y = e.y < 0.36 ? 'low' : e.y > 0.64 ? 'high' : '';
  return `${SAW[e.kind]}, ${[y, x].filter(Boolean).join(' ')}`;
}
