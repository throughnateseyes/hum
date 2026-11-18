import type { PhotoAsset } from '../../core/types';
import { makePhotoTexture } from './common';

const W = 1024;
const H = 1280;

/** Small deterministic PRNG so the placeholder looks the same every load. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Head-and-shoulders silhouette path (three-quarter profile facing the sun). */
function portraitPath() {
  const cx = W * 0.34;
  const p = new Path2D();
  // shoulders / torso
  p.moveTo(-40, H + 20);
  p.bezierCurveTo(-20, H * 0.86, cx - 260, H * 0.8, cx - 120, H * 0.765);
  p.bezierCurveTo(cx - 70, H * 0.75, cx - 62, H * 0.72, cx - 66, H * 0.69); // neck back
  // back of head
  p.bezierCurveTo(cx - 175, H * 0.66, cx - 190, H * 0.47, cx - 110, H * 0.4);
  p.bezierCurveTo(cx - 40, H * 0.345, cx + 90, H * 0.35, cx + 128, H * 0.43); // crown → brow
  // face profile (facing right, towards the sun)
  p.bezierCurveTo(cx + 140, H * 0.465, cx + 132, H * 0.49, cx + 150, H * 0.515); // nose
  p.bezierCurveTo(cx + 156, H * 0.53, cx + 132, H * 0.54, cx + 134, H * 0.555); // lips
  p.bezierCurveTo(cx + 136, H * 0.575, cx + 118, H * 0.6, cx + 92, H * 0.612); // chin
  p.bezierCurveTo(cx + 60, H * 0.625, cx + 40, H * 0.66, cx + 44, H * 0.7); // throat
  p.bezierCurveTo(cx + 70, H * 0.75, cx + 230, H * 0.78, cx + 330, H * 0.86); // front shoulder
  p.bezierCurveTo(cx + 420, H * 0.92, cx + 440, H, cx + 450, H + 20);
  p.closePath();
  return p;
}

/**
 * Built-in photo: golden hour over the sea, a soft-focus portrait silhouette rim-lit by the sun,
 * light cloud bands, film grain and a gentle vignette. Strong tonal structure so every photo
 * scene (points, mosaic, mosh, ripples) has something to bite on.
 */
export function createPlaceholderPhoto(): PhotoAsset {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const rand = mulberry32(7);
  const horizon = H * 0.66;
  const sunX = W * 0.7;
  const sunY = horizon - H * 0.07;

  // sky
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, '#1b2152');
  sky.addColorStop(0.32, '#3d4f9e');
  sky.addColorStop(0.62, '#a98fb8');
  sky.addColorStop(0.86, '#efb79a');
  sky.addColorStop(1, '#ffd9a8');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, horizon + 2);

  // sun glow
  const glow = ctx.createRadialGradient(sunX, sunY, 10, sunX, sunY, W * 0.75);
  glow.addColorStop(0, 'rgba(255,236,200,0.95)');
  glow.addColorStop(0.08, 'rgba(255,205,150,0.6)');
  glow.addColorStop(0.3, 'rgba(255,160,130,0.18)');
  glow.addColorStop(1, 'rgba(255,150,130,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, horizon + 2);

  // cloud bands (soft, elongated)
  ctx.save();
  ctx.filter = 'blur(14px)';
  for (let i = 0; i < 14; i++) {
    const y = H * (0.1 + rand() * 0.42);
    const x = rand() * W;
    const rx = 120 + rand() * 260;
    const ry = 8 + rand() * 18;
    const warm = y / horizon;
    ctx.fillStyle = `rgba(${Math.round(200 + warm * 55)},${Math.round(170 + warm * 40)},${Math.round(200 - warm * 30)},${0.12 + rand() * 0.16})`;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // sun disc
  ctx.save();
  ctx.filter = 'blur(2px)';
  ctx.fillStyle = '#fff3dc';
  ctx.beginPath();
  ctx.arc(sunX, sunY, 46, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // distant headland
  ctx.save();
  ctx.filter = 'blur(1.5px)';
  ctx.fillStyle = '#5b4a6e';
  ctx.beginPath();
  ctx.moveTo(0, horizon);
  for (let x = 0; x <= W * 0.48; x += 16) {
    const t = x / (W * 0.48);
    const y = horizon - Math.sin(t * Math.PI) * 38 - Math.sin(t * 17) * 3 - (1 - t) * 14;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(W * 0.48, horizon);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // sea
  const sea = ctx.createLinearGradient(0, horizon, 0, H);
  sea.addColorStop(0, '#c99a9c');
  sea.addColorStop(0.12, '#6f6a9a');
  sea.addColorStop(0.5, '#2c2f63');
  sea.addColorStop(1, '#12142e');
  ctx.fillStyle = sea;
  ctx.fillRect(0, horizon, W, H - horizon);

  // sun path glitter on the water
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 520; i++) {
    const t = Math.pow(rand(), 1.6);
    const y = horizon + 3 + t * (H - horizon);
    const spread = 18 + t * 260;
    const x = sunX + (rand() - 0.5) * 2 * spread * (0.4 + rand() * 0.6);
    const len = 6 + t * 46 * rand();
    const a = (1 - t) * 0.5 * rand();
    ctx.fillStyle = `rgba(255,${Math.round(200 + rand() * 40)},${Math.round(150 + rand() * 50)},${a})`;
    ctx.fillRect(x - len / 2, y, len, 1 + t * 2.5);
  }
  ctx.restore();

  // portrait silhouette, soft focus (shallow depth of field)
  const path = portraitPath();
  ctx.save();
  ctx.filter = 'blur(5px)';
  const body = ctx.createLinearGradient(W * 0.05, 0, W * 0.62, 0);
  body.addColorStop(0, '#0b0a14');
  body.addColorStop(0.7, '#1d1626');
  body.addColorStop(1, '#3a2730');
  ctx.fillStyle = body;
  ctx.fill(path);
  ctx.restore();

  // rim light on the sun-facing edge
  ctx.save();
  ctx.beginPath();
  ctx.rect(W * 0.3, 0, W, H);
  ctx.clip();
  ctx.filter = 'blur(3px)';
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = 'rgba(255,184,130,0.55)';
  ctx.lineWidth = 7;
  ctx.stroke(path);
  ctx.filter = 'blur(10px)';
  ctx.strokeStyle = 'rgba(255,150,120,0.25)';
  ctx.lineWidth = 22;
  ctx.stroke(path);
  ctx.restore();

  // a few loose hair strands catching the light
  ctx.save();
  ctx.filter = 'blur(0.8px)';
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 26; i++) {
    const x0 = W * 0.34 - 60 + rand() * 170;
    const y0 = H * 0.355 + rand() * 30;
    ctx.strokeStyle = `rgba(255,${Math.round(180 + rand() * 50)},150,${0.1 + rand() * 0.2})`;
    ctx.lineWidth = 0.8 + rand();
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.bezierCurveTo(x0 + 20 + rand() * 40, y0 - 30 - rand() * 40, x0 + 60 + rand() * 60, y0 - 10, x0 + 70 + rand() * 90, y0 + 20 + rand() * 40);
    ctx.stroke();
  }
  ctx.restore();

  // vignette
  const vig = ctx.createRadialGradient(W * 0.55, H * 0.5, H * 0.25, W * 0.5, H * 0.5, H * 0.78);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(8,6,20,0.45)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);

  // film grain (monochrome, slightly stronger in the shadows)
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722) / 255;
    const g = (rand() + rand() - 1) * (16 + (1 - l) * 10);
    d[i] = Math.max(0, Math.min(255, d[i] + g));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + g));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + g));
  }
  ctx.putImageData(img, 0, 0);

  return {
    id: 'builtin-golden-hour',
    name: 'Golden hour (built-in)',
    texture: makePhotoTexture(canvas),
    image: canvas,
    width: W,
    height: H,
    builtin: true,
  };
}
