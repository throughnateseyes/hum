/**
 * What Hum knows about a clip (or photo) as a place: how far away everything in it is, where its
 * horizon is, and how its camera moves. Made once per clip by read.ts, in the browser, and kept.
 *
 * Coordinates. u runs 0..1 left to right and v 0..1 bottom to top (texture coordinates). Distances in
 * the picture are in frame heights: x = (u - 0.5) * aspect, y = v - 0.5. The camera looks down -z, its
 * focal length is `focal` frame heights, and it stands EYE world units above the ground.
 *
 * Depth. Every sample is a small map of bytes; nearness n = (byte / 255)^2 (0 is the sky or as good as,
 * 1 is the nearest thing in the clip; squared so far things keep their detail). World distance is
 * z = zScale / n. On flat ground that agrees with the horizon: a ground point y below it is
 * focal * EYE / y away.
 */
export const EYE = 1.5;

/** where the clip's vanishing point and horizon are at one sample */
export interface View {
  /** the vanishing point: where lines running straight ahead meet */
  u: number;
  v: number;
  /** the horizon's tilt, radians, anticlockwise */
  roll: number;
}

/** how the background sits at one sample, against the clip's first: a turn, a scale and a slide (frame heights) about the frame's centre */
export interface Slide {
  x: number;
  y: number;
  scale: number;
  turn: number;
}

export interface ClipScene {
  /** the media item's id */
  id: string;
  aspect: number;
  /** seconds; 0 for a photo */
  duration: number;
  /** depth maps are this size, rows bottom to top */
  width: number;
  height: number;
  /** clip seconds of each depth sample, rising. A photo has one, at 0 */
  times: number[];
  /** the maps, one per entry of times; null for a sample not read yet (see ClipReader.need) */
  maps: (Uint8Array | null)[];
  /** the straight lines of every other sample (edges.ts); missing or null where they have not been looked for */
  edges?: (Int16Array | null)[];
  /** seconds of clip a depth map can stand in for when the one wanted has not been read */
  step: number;
  focal: number;
  zScale: number;
  /** per sample */
  views: View[];
  slides: Slide[];
  /** world units the camera has moved straight ahead since the first sample, per sample */
  ahead: number[];
  /** how sure each part of the reading is, 0..1 */
  sure: { horizon: number; slide: number; ahead: number };
  /** how much of the picture, over the clip, is sky; flat ground; people or things close by (0..1) */
  sky: number;
  ground: number;
  near: number;
  /** nearness values that split the picture into layers with clear gaps between them, far to near (0 to 3 of them) */
  splits: number[];
  /** the camera: still, carried (shake), turning across, or moving straight ahead */
  camera: 'still' | 'handheld' | 'pan' | 'ahead';
}
