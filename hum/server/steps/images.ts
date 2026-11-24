/**
 * Pictures in a request: `body.images`, JPEGs as plain base64. They are untrusted and cost money by the
 * pixel, so each must really be a JPEG and fit in MAX_EDGE (read from its header, not from the request).
 */
export const MAX_EDGE = 1600;
const MAX_IMAGE_CHARS = 400_000;

export interface StepImage {
  media_type: 'image/jpeg';
  data: string;
}

/** width and height from a JPEG's start-of-frame marker, or null when it isn't a readable JPEG */
export function jpegSize(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) {
      i++;
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/** the checked images, or a sentence saying what's wrong */
export function readImages(raw: unknown, max: number): StepImage[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return 'images must be a list.';
  if (raw.length > max) return `At most ${max} pictures in this request.`;
  const out: StepImage[] = [];
  for (const x of raw) {
    if (typeof x !== 'string') return 'Each picture must be base64 text.';
    const data = x.replace(/^data:image\/jpeg;base64,/, '');
    if (data.length > MAX_IMAGE_CHARS || !/^[A-Za-z0-9+/]+=*$/.test(data)) return 'A picture is too large or not base64.';
    const size = jpegSize(Buffer.from(data, 'base64'));
    if (!size || size.w < 1 || size.h < 1) return 'A picture isn’t a JPEG.';
    if (size.w > MAX_EDGE || size.h > MAX_EDGE) return `A picture is larger than ${MAX_EDGE} px.`;
    out.push({ media_type: 'image/jpeg', data });
  }
  return out;
}
