import { HM_LIB, defineClockedShaderScene, rateClock, sinceKickClock, type ClockDef } from './lib';

/** Per-frame share of a kick's lurch: k·e^(−k·t)·dt sums to ≈ kick strength over ~0.25 s. */
const lurchClock = (k: number): ClockDef => ({
  step: (_v, f, s, mem) => {
    if (f.audio.kickHit) mem.kickAmp = Math.max(0.5, Math.min(1, f.audio.kick));
    return (mem.kickAmp ?? 1) * k * Math.exp(-k * s.sk) * f.dt;
  },
});

const fragment = /* glsl */ `
${HM_LIB}
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 res = uResolution;
  float px = max(1.0, floor(res.y / 540.0));
  float t = u_clk;

  // plot area: history lives here; margins hold ticks + labels and are never fed back
  vec2 mg = vec2(30.0, 26.0) * px;
  bool inPlot = fc.x > mg.x && fc.x < res.x - mg.x && fc.y > mg.y && fc.y < res.y - mg.y;
  float y = clamp((fc.y - mg.y) / (res.y - 2.0 * mg.y), 0.0, 1.0);
  float tens = uBuild * u_tension;

  // scan line, bent by the live waveform (plus a slow idle sway); builds and drops bend it harder
  float bendGain = 1.0 + tens * 1.5 + uDrop * u_split * 1.5;
  float bendPx = u_bend * res.x * (0.1 * waveform(y) * (0.35 + 1.2 * uLevel) * bendGain + 0.012 * sin(y * 5.0 + t * 0.8));
  float xs0 = mix(mg.x, res.x - mg.x, u_scan) + bendPx;
  // drop: the slit splits into three that fly apart and slowly converge again (builds hint at it)
  float spread = max(uDrop * u_split, tens * 0.12) * (res.x - 2.0 * mg.x) * 0.3;
  float xs = xs0;
  if (spread > 1.0) {
    float xl = xs0 - spread - bendPx * 0.6;
    float xr = xs0 + spread + bendPx * 0.4;
    if (abs(fc.x - xl) < abs(fc.x - xs)) xs = xl;
    if (abs(fc.x - xr) < abs(fc.x - xs)) xs = xr;
  }

  // whole-pixel shift per frame keeps the streaks crisp; energy speeds it up, and every kick
  // makes the whole history lurch away from the slit (~90 px at the default strength)
  float shift = floor(u_speed * px * (1.0 + 4.0 * uEnergy) + u_lurch * u_shv * 140.0 * px + 0.5);

  // snare tears: random horizontal bands jump further this frame
  float bandH = px * 4.0 * (1.0 + floor(hash11(floor(uTime * 12.0)) * 8.0));
  float band = floor(fc.y / bandH);
  float tearSeed = hash21(vec2(band, floor(uTime * 14.0)));
  float tear = step(1.0 - 0.35 * u_tear, tearSeed) * max(smoothstep(0.12, 0.55, uSnare), tens * 0.45) * u_tear;
  float tearShift = floor(tear * (16.0 + 70.0 * tearSeed) * px);

  // history flows away from the scan line on both sides
  float side = fc.x >= xs ? 1.0 : -1.0;
  vec2 src = fc - vec2(side * (shift + tearShift), 0.0);
  // drop: column groups also slip vertically, so the history shears into diagonals
  src.y -= floor((hash11(floor(fc.x / (6.0 * px)) + 3.0) - 0.5) * 7.0 * uDrop * u_split * px + 0.5);
  vec4 prev = texture2D(tPrev, src / res);
  vec3 hist = prev.a > 0.5 ? prev.rgb : uBg;
  hist = mix(uBg, hist, u_persist);

  // the moving noise "subject" sampled along the scan line
  float row = floor(fc.y / px);
  float bodyD = (y - 0.5 - 0.28 * sin(t * 0.53) - 0.08 * sin(t * 1.7)) * (3.5 + 1.5 * sin(t * 0.31));
  float body = exp(-bodyD * bodyD);
  float n = fbm(vec2(y * u_detail, t * 0.8), 4) * 0.5 + 0.5;
  float lines = 0.6 + 0.4 * hash11(row + floor(t * 0.5) * 13.0);
  float spec = spectrum(y) * (0.35 + uMid);
  // kick print: rows where the spectrum is loud stamp solid on every kick, so the stream
  // carries away a spectrum barcode per hit
  float kprint = u_spectro * clamp(uKick * 1.3, 0.0, 1.0) * smoothstep(0.06, 0.35, spectrum(y));
  float sparks = uHat * step(0.93, hash11(row * 1.3 + floor(uTime * 30.0)));
  float subj = clamp(smoothstep(0.38, 0.78, n + body * 0.45) * lines + spec * 0.55 + sparks + kprint, 0.0, 1.0);

  vec3 col = uBg;
  float bw = shift + px;
  if (inPlot) {
    col = abs(fc.x - xs) < bw ? mix(uBg, uFg, subj) : hist;
  } else {
    // ── margins: ticks, frame, tiny data labels ──
    float ink = 0.0;
    float accent = 0.0;
    vec2 pw = res - 2.0 * mg;
    // ticks along top + bottom
    float tx = fc.x - mg.x;
    float stepX = pw.x / 40.0;
    float kx = floor(tx / stepX + 0.5);
    float dx = abs(tx - kx * stepX);
    float tlenX = (mod(kx, 5.0) < 0.5 ? 9.0 : 5.0) * px;
    float below = mg.y - fc.y;
    float above = fc.y - (res.y - mg.y);
    if (tx > -1.0 && tx < pw.x + 1.0 && dx < 0.5 * px + 0.25) {
      if ((below > 0.0 && below < tlenX) || (above > 0.0 && above < tlenX)) ink = 1.0;
    }
    // ticks along left + right
    float ty = fc.y - mg.y;
    float stepY = pw.y / 24.0;
    float ky = floor(ty / stepY + 0.5);
    float dy = abs(ty - ky * stepY);
    float tlenY = (mod(ky, 4.0) < 0.5 ? 9.0 : 5.0) * px;
    float leftD = mg.x - fc.x;
    float rightD = fc.x - (res.x - mg.x);
    if (ty > -1.0 && ty < pw.y + 1.0 && dy < 0.5 * px + 0.25) {
      if ((leftD > 0.0 && leftD < tlenY) || (rightD > 0.0 && rightD < tlenY)) ink = 1.0;
    }
    // hairline frame just outside the plot
    if ((below > 0.0 && below <= px) || (above > 0.0 && above <= px) ||
        (leftD > 0.0 && leftD <= px) || (rightD > 0.0 && rightD <= px)) {
      if (tx > -px && tx < pw.x + px && ty > -px && ty < pw.y + px) ink = max(ink, 0.45);
    }
    // left margin: tiny spectrum bars
    if (leftD > 12.0 * px && mod(row, 3.0) < 1.0) {
      float sv = spectrum(clamp(ty / pw.y, 0.0, 1.0));
      if (fc.x > 3.0 * px && fc.x < 3.0 * px + sv * 14.0 * px) ink = max(ink, 0.7);
    }
    // scan-line markers (accent) at top + bottom
    float xsb = mix(mg.x, res.x - mg.x, u_scan) + u_bend * res.x * (0.1 * waveform(0.0) * (0.35 + 1.2 * uLevel) + 0.012 * sin(t * 0.8));
    float xst = mix(mg.x, res.x - mg.x, u_scan) + u_bend * res.x * (0.1 * waveform(1.0) * (0.35 + 1.2 * uLevel) + 0.012 * sin(5.0 + t * 0.8));
    if (below > 11.0 * px && below < 15.0 * px && abs(fc.x - xsb) < (below - 10.0 * px) * 0.6) accent = 1.0;
    if (above > 11.0 * px && above < 15.0 * px && abs(fc.x - xst) < (above - 10.0 * px) * 0.6) accent = 1.0;
    // labels: time, bpm, energy, beat.phase
    if (u_labels > 0.5) {
      ink = max(ink, hmNumber(floor((fc - vec2(mg.x, 6.0 * px)) / px), uTime, 4.0));
      ink = max(ink, hmNumber(floor((fc - vec2(res.x - mg.x - 20.0 * px, 6.0 * px)) / px), uBpm, 3.0));
      ink = max(ink, hmNumber(floor((fc - vec2(mg.x, res.y - 11.0 * px)) / px), uEnergy, 1.0));
      ink = max(ink, hmNumber(floor((fc - vec2(mg.x + 16.0 * px, res.y - 11.0 * px)) / px), uSub, 1.0));
      ink = max(ink, hmNumber(floor((fc - vec2(res.x - mg.x - 24.0 * px, res.y - 11.0 * px)) / px), uBeatCount + uBeatPhase, 4.0));
    }
    col = mix(uBg, uFg, ink * 0.9);
    col = mix(col, uAccent, accent);
  }
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

export const slitSmear = defineClockedShaderScene(
  {
    id: 'slit-smear',
    name: 'Slit Smear',
    description:
      'Monochrome slit-scan time smear (TouchDesigner look): a moving noise subject is sampled along a scan line bent by the waveform, and the history streams away on both sides. Every kick makes the stream lurch and stamps a spectrum barcode into it; snares tear horizontal bands; build-ups bend the slit harder and start tearing on their own; a drop splits the slit into three that fly apart and shear the history into diagonals. Tiny tick marks and numeric readouts in the margins.',
    category: 'field',
    fragment,
    tags: ['monochrome', 'techno', 'glitch', 'experimental', 'cold', 'minimal', 'data', 'hypnotic'],
    feedback: true,
    params: [
      { id: 'speed', label: 'Smear speed', group: 'Motion', type: 'number', min: 0, max: 8, step: 0.1, default: 2, hint: 'pixels per frame' },
      { id: 'persist', label: 'Persistence', group: 'Motion', type: 'number', min: 0.9, max: 1, step: 0.001, default: 0.992 },
      { id: 'tear', label: 'Snare tear', group: 'Motion', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6 },
      { id: 'scan', label: 'Scan position', group: 'Shape', type: 'number', min: 0.05, max: 0.95, step: 0.01, default: 0.5 },
      { id: 'bend', label: 'Waveform bend', group: 'Shape', type: 'number', min: 0, max: 2, step: 0.01, default: 0.8 },
      { id: 'detail', label: 'Subject detail', group: 'Shape', type: 'number', min: 1, max: 14, step: 0.1, default: 5 },
      { id: 'labels', label: 'Labels', group: 'Overlay', type: 'bool', default: true },
      { id: 'lurch', label: 'Kick lurch', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.65, hint: 'Each kick shoves the whole stream away from the slit' },
      { id: 'spectro', label: 'Kick spectrum print', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, hint: 'Kicks stamp the loud frequencies into the stream' },
      { id: 'split', label: 'Drop split', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, hint: 'A drop splits the slit into three and shears the history' },
      { id: 'tension', label: 'Build tension', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.55, hint: 'Build-ups bend the slit and tear the stream' },
    ],
    modulations: [
      { source: 'energy', param: 'speed', amount: 0.15 },
      { source: 'sway', param: 'scan', amount: 0.08 },
      { source: 'level', param: 'bend', amount: 0.2 },
    ],
  },
  {
    clk: rateClock((f) => 0.5 + 1.0 * f.audio.energy + 0.5 * f.audio.mid),
    sk: sinceKickClock,
    shv: lurchClock(14),
  },
);
