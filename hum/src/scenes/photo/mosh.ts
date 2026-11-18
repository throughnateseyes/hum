import type { ClockDef } from '../shader/lib';
import { defineClockedShaderScene, kickCountClock, sinceKickClock } from '../shader/lib';
import { PHOTO_GLSL } from './common';

/** Per-frame share of a kick's shove: k·e^(−k·t)·dt sums to ≈ kick strength over ~0.25 s. */
const shoveClock = (k: number): ClockDef => ({
  step: (_v, f, s, mem) => {
    if (f.audio.kickHit) mem.kickAmp = Math.max(0.5, Math.min(1, f.audio.kick));
    return (mem.kickAmp ?? 1) * k * Math.exp(-k * s.sk) * f.dt;
  },
});

/**
 * Feedback datamosh. Every frame each macroblock either "heals" toward its target photo
 * (an I-frame refresh) or copies the previous frame shifted along a coherent motion vector
 * (a stale P-frame smear). During the last part of each 16-beat photo cycle blocks flip
 * their target to the next photo one by one, popping in hard then bleeding.
 *
 * Reactivity: kicks shove whole bands of blocks sideways (the shift accumulates through the
 * feedback, then heals); rows of blocks slide by the loudness of "their" frequency; build-ups
 * grow the blocks and stop the healing; a drop blooms everything out of the centre into mush.
 */
const fragment = /* glsl */ `
${PHOTO_GLSL}

void main() {
  vec2 res = uResolution;
  vec2 fc = vUv * res;
  float px = res.y / 1080.0;
  float cycle = floor(uPhotoIndex);
  float tens = uBuild * u_tension;
  float melt = uDrop * u_melt;
  float eg = clamp(uEnergy * 1.6, 0.0, 1.0); // quiet passages smear much less

  // two-level macroblocks (like a codec's 16×16 / 32×32 partitions); builds coarsen them
  float bs = max(4.0, floor(u_block * px * (1.0 + uDrop + tens * 1.2)));
  vec2 big = floor(fc / (bs * 2.0));
  float useBig = step(0.6 - uDrop * 0.4 - tens * 0.3, hash21(big + 3.7 + cycle * 1.3));
  float size = bs * (1.0 + useBig);
  vec2 cell = floor(fc / size);
  vec2 bid = cell + useBig * vec2(517.0, 211.0);
  vec2 bc = (cell + 0.5) * size / res;

  // block-by-block reveal of the next photo
  float tt = smoothstep(0.5, 0.94, fract(uPhotoIndex));
  float r = hash21(bid * 0.917 + cycle * 7.31);
  float thr = tt * 1.06;
  float revealed = step(r, thr - 0.0001);
  float fresh = revealed * (1.0 - step(r, thr - 0.07));
  float prelude = step(r, thr + 0.12) * (1.0 - revealed) * step(0.0001, tt);

  vec3 tgt = revealed > 0.5 ? photo2(vUv) : photo1(vUv);
  tgt = mix(tgt, triTone(luma(tgt)), u_grade);

  // motion vectors: coherent noise field, re-rolled ~10×/s per block
  float q = floor(uTime * 10.0 + hash21(bid + 9.1) * 4.0);
  float ang = snoise(bc * 2.2 + vec2(uTime * 0.04, cycle * 3.3)) * TAU;
  vec2 dir = vec2(cos(ang), sin(ang));
  float act = u_smear * (0.25 + 0.6 * eg) + uKick * 1.1 + uBass * 0.35 + uDrop * 2.0 + tens * 0.8;
  float mag = (0.3 + act * 3.2) * px * (0.4 + hash21(bid + q * 1.7));
  vec2 mv = dir * mag;
  float pSmear = clamp(0.05 + u_smear * (0.12 + 0.3 * eg) + uKick * 0.35 + uDrop * 0.8 + tens * 0.35, 0.0, 0.97);
  float smearing = step(hash21(bid * 1.31 + q), pSmear) * (1.0 - fresh);

  // spectrum rows: each band of block rows slides sideways by the loudness of its frequency
  // (lows at the bottom), alternating direction, so the music combs the photo into streaks
  float rowY = (floor(fc.y / bs) + 0.5) * bs / res.y;
  float sp = spectrum(0.03 + rowY * 0.8);
  float rowSign = mod(floor(fc.y / (bs * 2.0)), 2.0) * 2.0 - 1.0;
  mv.x += rowSign * sp * sp * u_specRows * 9.0 * px * (0.5 + 0.5 * smearing);

  // drop: a mosh bloom — everything pours out of the centre, then heals as the drop decays
  vec2 fromC = (vUv - 0.5) * vec2(uAspect, 1.0);
  float fl = length(fromC);
  mv += (fromC / max(fl, 1e-3)) * melt * (2.0 + 7.0 * fl) * px * (0.75 + 0.5 * snoise(bc * 3.0 + uTime * 0.3));

  // kick shove: whole bands of blocks lurch sideways together; the shift accumulates through
  // the feedback (~150 px at full strength) and heals back over the next second
  float bandH = bs * (2.0 + floor(hash11(u_kc * 3.1 + 0.5) * 4.0));
  float bandId = floor(fc.y / bandH);
  float bh = hash21(vec2(bandId, u_kc * 1.7 + 0.3));
  float shoved = step(0.42, bh) * step(0.0015, u_shv * u_shove);
  vec2 shoveDir = vec2(bh > 0.71 ? 1.0 : -1.0, (hash11(bandId + u_kc * 5.3) - 0.5) * 0.35);
  mv += shoveDir * u_shv * u_shove * 220.0 * px * shoved;
  smearing = max(smearing, shoved);

  vec2 puv = vUv - mv / res;
  vec3 prev = texture2D(tPrev, puv).rgb;
  vec3 c;
  if (smearing > 0.5) {
    vec2 ch = dir * u_chroma * (0.6 + uHat * 2.5 + shoved * 3.0) * px / res;
    vec3 pc = vec3(texture2D(tPrev, puv + ch).r, prev.g, texture2D(tPrev, puv - ch).b);
    vec3 mush = texture2D(tPrev, bc - mv / res).rgb; // flatten toward the block's centre colour
    pc = mix(pc, mush, u_crush * 0.12 + melt * 0.1);
    float L = mix(48.0, 5.0, clamp(u_crush + tens * 0.45, 0.0, 1.0));
    pc = floor(pc * L + 0.5) / L;
    c = mix(pc, tgt, (0.006 + u_heal * 0.01) * (1.0 - melt * 0.8));
  } else {
    float heal = 0.035 + u_heal * 0.2;
    heal *= (1.0 - tens * 0.7) * (1.0 - melt * 0.9);
    heal = mix(heal, 0.55, fresh);
    c = mix(prev, tgt, heal);
  }
  // the next photo bleeds into blocks that are about to flip
  if (prelude > 0.5) {
    c = mix(c, photo2(vUv - mv * 8.0 / res), 0.12);
  }

  // pixel-sort streaks on kicks: bright pixels melt downward in column groups
  float sortAmt = u_sort * clamp(uKick * 0.8 + uDrop + uSnare * 0.25, 0.0, 1.0);
  if (sortAmt > 0.01) {
    float cg = floor(fc.x / max(2.0, bs * 0.5));
    float seg = floor(fc.y / (bs * 6.0));
    float on = step(1.0 - sortAmt * 0.55, hash21(vec2(cg, seg) + floor(uBeatCount) * 3.17));
    if (on > 0.5) {
      float len = (24.0 + 160.0 * sortAmt) * px;
      vec3 best = c;
      float bl = luma(c);
      for (int i = 1; i <= 8; i++) {
        vec3 s = texture2D(tPrev, vUv + vec2(0.0, float(i) * len / 8.0) / res).rgb;
        float l = luma(s);
        if (l > bl && l > u_threshold) { best = s; bl = l; }
      }
      c = mix(c, best, 0.8);
    }
  }

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

export const photoMosh = defineClockedShaderScene(
  {
    id: 'photo-mosh',
    name: 'Datamosh',
    description:
      'A corrupted video stream: macroblocks smear along motion vectors and heal back to the photo; near the end of each 16-beat cycle the next photo pops in block by block. Every kick shoves whole bands of the picture sideways, rows of blocks slide by the loudness of their frequency, build-ups coarsen the blocks and stop the healing, and a drop blooms everything out of the centre into mush before it heals. Kicks also melt bright pixels into pixel-sort streaks. Quiet passages stay readable.',
    category: 'photo',
    usesPhotos: true,
    fragment,
    feedback: true,
    tags: ['glitch', 'gritty', 'chaotic', 'lo-fi', 'aggressive', 'experimental'],
    params: [
      { id: 'block', label: 'Block size', type: 'number', min: 6, max: 64, step: 1, default: 22, group: 'Shape' },
      { id: 'smear', label: 'Smear', type: 'number', min: 0, max: 1, step: 0.01, default: 0.45, group: 'Motion', hint: 'How often and how far stale blocks drift' },
      { id: 'heal', label: 'Heal', type: 'number', min: 0, max: 1, step: 0.01, default: 0.35, group: 'Motion', hint: 'How fast blocks snap back to the photo' },
      { id: 'sort', label: 'Pixel sort', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, group: 'Glitch' },
      { id: 'threshold', label: 'Sort threshold', type: 'number', min: 0, max: 1, step: 0.01, default: 0.55, group: 'Glitch' },
      { id: 'chroma', label: 'Chroma bleed', type: 'number', min: 0, max: 1, step: 0.01, default: 0.3, group: 'Glitch' },
      { id: 'crush', label: 'Block crush', type: 'number', min: 0, max: 1, step: 0.01, default: 0.35, group: 'Glitch', hint: 'Codec posterize + flatten' },
      { id: 'grade', label: 'Palette grade', type: 'number', min: 0, max: 1, step: 0.01, default: 0, group: 'Color' },
      { id: 'shove', label: 'Kick shove', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, group: 'Reactivity', hint: 'Kicks shove bands of the picture sideways' },
      { id: 'melt', label: 'Drop melt', type: 'number', min: 0, max: 1, step: 0.01, default: 0.8, group: 'Reactivity', hint: 'A drop blooms the image out of the centre' },
      { id: 'specRows', label: 'Spectrum rows', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, group: 'Reactivity', hint: 'Rows slide by the loudness of their frequency (lows at the bottom)' },
      { id: 'tension', label: 'Build tension', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, group: 'Reactivity', hint: 'Build-ups coarsen the blocks and stop the healing' },
    ],
    modulations: [
      { source: 'bass', param: 'smear', amount: 0.25 },
      { source: 'air', param: 'chroma', amount: 0.2 },
      { source: 'energy', param: 'heal', amount: -0.2 },
      { source: 'kick', param: 'crush', amount: 0.2 },
    ],
  },
  {
    sk: sinceKickClock,
    kc: kickCountClock,
    shv: shoveClock(14),
  },
);
