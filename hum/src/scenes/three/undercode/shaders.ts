import { GLSL_ATLAS } from './atlas';
import { PRIMS } from './rig';

/**
 * Undercode's passes:
 *   FIGURE   the mannequin raymarched at a third of the output size: coverage, light, distance, rim
 *   RAIN     the code: three depths of glyph rain, the figure drawn by its own finer stream, the sung
 *            words assembling out of the rain, ripples and shockwaves bending the grid. HDR out.
 *   OBJECTS  instanced quads: rounds, glyph shards, droplets of code, wake rings (additive)
 *   BLOOM    quarter-size bright pass + a separable blur (the phosphor glow)
 *   COMPOSE  glow, snare tears, flash, scanlines, the halftone print and its floating grey dots
 */

/* ───────── figure ───────── */

export const FIGURE_FRAG = /* glsl */ `
#define UC_PRIMS ${PRIMS}
uniform vec4 uPA[UC_PRIMS];
uniform vec4 uPB[UC_PRIMS];
uniform vec3 uCamPos, uCamR, uCamU, uCamF;
uniform float uTanH, uShift;
uniform vec3 uBMin, uBMax;
uniform vec3 uKey;

float ucRC(vec3 p, vec3 a, vec3 b, float r1, float r2) {
  vec3 ba = b - a;
  float l2 = dot(ba, ba);
  float rr = r1 - r2;
  float a2 = l2 - rr * rr;
  float il2 = 1.0 / l2;
  vec3 pa = p - a;
  float y = dot(pa, ba);
  float z = y - l2;
  vec3 xv = pa * l2 - ba * y;
  float x2 = dot(xv, xv);
  float y2 = y * y * l2;
  float z2 = z * z * l2;
  float k = sign(rr) * rr * rr * x2;
  if (sign(z) * a2 * z2 > k) return sqrt(x2 + z2) * il2 - r2;
  if (sign(y) * a2 * y2 < k) return sqrt(x2 + y2) * il2 - r1;
  return (sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}
float ucSmin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
float ucMap(vec3 p) {
  float d = 1e5;
  for (int i = 0; i < UC_PRIMS; i++) d = ucSmin(d, ucRC(p, uPA[i].xyz, uPB[i].xyz, uPA[i].w, uPB[i].w), 0.034);
  return d;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uCamF + uCamR * (ndc.x - uShift) * uTanH * uAspect + uCamU * ndc.y * uTanH);
  vec3 ro = uCamPos;
  vec3 inv = 1.0 / rd;
  vec3 t0 = (uBMin - 0.06 - ro) * inv, t1 = (uBMax + 0.06 - ro) * inv;
  vec3 tn = min(t0, t1), tf = max(t0, t1);
  float ta = max(max(tn.x, tn.y), tn.z), tb = min(min(tf.x, tf.y), tf.z);
  vec4 o = vec4(0.0, 0.0, 1.0, 0.0);
  if (ta < tb && tb > 0.0) {
    float t = max(ta, 0.0);
    bool hit = false;
    for (int i = 0; i < 60; i++) {
      float d = ucMap(ro + rd * t);
      if (d < 0.0012 * t) { hit = true; break; }
      t += d;
      if (t > tb) break;
    }
    if (hit) {
      vec3 p = ro + rd * t;
      vec2 e = vec2(0.0025, -0.0025);
      vec3 n = normalize(e.xyy * ucMap(p + e.xyy) + e.yyx * ucMap(p + e.yyx) + e.yxy * ucMap(p + e.yxy) + e.xxx * ucMap(p + e.xxx));
      float key = max(dot(n, uKey), 0.0);
      float fill = 0.5 + 0.5 * n.y;
      float rim = pow(1.0 - max(dot(n, -rd), 0.0), 2.4);
      float light = clamp(0.06 + 0.8 * key + 0.16 * fill, 0.0, 1.0);
      o = vec4(1.0, light, t / 16.0, rim);
    }
  }
  gl_FragColor = o;
}
`;

/* ───────── rain ───────── */

export const RAIN_FRAG = /* glsl */ `
${GLSL_ATLAS}
uniform sampler2D uFig;
uniform sampler2D uWords;
uniform vec4 uWordBox;     // left px, top px (from the bottom), cell w, cell h
uniform vec2 uWordDims;    // cols, rows
uniform float uWordT;      // song time, for the reveals
uniform float uRainT, uMutT, uGrav, uStretch, uDensity, uPool, uDepth;
uniform vec4 uCells;       // cell heights in px: far, mid, near, figure
uniform vec3 uPar;         // parallax offsets in px: far, mid, near
uniform vec4 uKickW;       // centre px, radius px, amplitude px
uniform vec4 uDropW;       // the drop's concentric rings: centre px, radius px, amplitude px
uniform vec4 uRip[6];      // wakes round the rounds: centre px, radius px, amplitude px
uniform float uSparkle, uSparkleSeed;
uniform float uFigAmt, uAssemble, uDissolve, uFigDir, uFigHalftone;
uniform float uFigBottom, uFigTop;   // the figure's screen extent (0..1 of the height), for assembling / dissolving
uniform float uTrailK, uBright;
uniform float uFreeze;     // 0..1: time is stopped (the world dims, the moment glows)
uniform vec3 uFigGrid;     // the figure's own glyph grid: anchor px (it scales with the body on screen), cell height px
uniform vec4 uFigBox;      // the figure's box on screen: centre px, half size px

vec2 ucRing(vec2 p, vec4 w, float width, float freq) {
  vec2 d = p - w.xy;
  float r = length(d) + 1e-3;
  float x = (r - w.z) / width;
  return d / r * w.w * sin(x * freq) * exp(-x * x);
}

// one depth of rain; returns colour (rgb) and coverage (a)
vec4 ucLayer(vec2 q, float cellH, float seed, float speed, float dens, float lodBias, float spark) {
  float cw = cellH * 0.62;
  float ch = cellH * uStretch;
  vec2 g = vec2(q.x / cw, q.y / ch);
  float col = floor(g.x);
  float row = floor(-g.y);
  vec2 lu = fract(g);
  float h1 = hash21(vec2(col, seed));
  float h2 = hash21(vec2(col + 31.7, seed * 1.3 + 7.0));
  float h3 = hash21(vec2(col * 0.71 + 5.3, seed + 11.0));
  float on = step(h2, dens);
  float spd = speed * (0.5 + h1);
  float trail = mix(5.0, 24.0, h3) * uTrailK;
  float gap = mix(6.0, 34.0, hash21(vec2(col - 9.1, seed + 3.0))) * (1.5 - dens);
  float period = trail + gap;
  float head = uRainT * spd + h1 * 131.0;
  float m = mod(head - row, period);
  float b = on * (m < trail ? pow(1.0 - m / trail, 1.6) : 0.0);
  float isHead = on * step(m, 1.0);
  float hc = hash21(vec2(col * 1.31 + seed, row * 0.77));
  float mt = floor(uMutT * mix(0.3, 2.6, hc) + hc * 17.0) + isHead * floor(uMutT * 8.0);
  float sp = step(hash21(vec2(col, row) + uSparkleSeed * vec2(1.7, 3.1) + seed), 0.022 * spark);
  b = max(b, sp * 0.95);
  isHead = max(isHead, sp);
  float gi = ucPoolGlyph(hash21(vec2(col + mt * 0.137, row + seed * 3.0 + mt * 1.91)), uPool);
  float lod = max(0.0, log2(90.0 / cellH) + lodBias);
  float cov = ucGlyph(gi, lu, lod);
  vec3 c = mix(uAccent2, uAccent, smoothstep(0.08, 0.7, b));
  c = mix(c, uFg, isHead);
  float a = cov * smoothstep(0.0, 0.14, b);
  return vec4(c * (1.0 + isHead * 0.9), a);
}

void main() {
  vec2 p = vUv * uResolution;
  float S = uResolution.y;
  // air: the kick's shockwave, the drop's frozen rings, the wakes of the rounds
  vec2 warp = ucRing(p, uKickW, S * 0.045, 2.2) + ucRing(p, uDropW, S * 0.2, 13.0);
  for (int i = 0; i < 6; i++) warp += ucRing(p, uRip[i], max(4.0, uRip[i].z * 0.35), 6.0);
  vec2 pw = p + warp;
  float ringGlow = exp(-pow((length(p - uKickW.xy) - uKickW.z) / (S * 0.03), 2.0)) * clamp(uKickW.w / (S * 0.02), 0.0, 1.0);
  // the drop's rings, visible in the air while time stands still
  float dx = (length(p - uDropW.xy) - uDropW.z) / (S * 0.2);
  float dropGlow = pow(max(0.0, sin(dx * 13.0)), 10.0) * exp(-dx * dx) * clamp(uDropW.w / (S * 0.006), 0.0, 1.0);

  // gravity: the rain's world turns round the centre (the figure and the words don't)
  vec2 c0 = uResolution * 0.5;
  float cg = cos(uGrav), sg = sin(uGrav);
  vec2 qr = mat2(cg, sg, -sg, cg) * (pw - c0) + c0;

  vec3 col = uBg;
  // far and mid rain
  vec4 far = ucLayer(qr + vec2(uPar.x, 0.0), uCells.x, 3.0, 0.55, uDensity * 0.9, 0.25, 0.0);
  vec4 mid = ucLayer(qr + vec2(uPar.y, 0.0), uCells.y, 7.0, 0.8, uDensity, 0.0, uSparkle);
  float fogF = 0.62 * uDepth;
  // the figure stands in a pocket of quieter rain, so the body reads first
  vec2 fb = (pw - uFigBox.xy) / (uFigBox.zw * vec2(1.6, 1.15));
  float pocket = smoothstep(1.0, 0.25, length(fb)) * min(1.0, uFigAmt) * uAssemble;
  float poster = uFigHalftone;
  col = mix(col, mix(far.rgb, uBg, fogF), far.a * (0.35 + 0.65 * uDepth) * 0.8 * (1.0 - 0.6 * pocket) * (1.0 - 0.55 * poster));
  col = mix(col, mid.rgb, mid.a * 0.82 * (1.0 - 0.5 * pocket) * (1.0 - 0.45 * poster));
  // the rain parts a little around the body: a dark halo hugging the silhouette
  {
    vec2 hr = vec2(uFigBox.w * 0.05) / uResolution;
    vec2 hu = pw / uResolution;
    float halo = max(max(texture2D(uFig, hu + hr).r, texture2D(uFig, hu - hr).r),
                     max(texture2D(uFig, hu + vec2(hr.x, -hr.y)).r, texture2D(uFig, hu + vec2(-hr.x, hr.y)).r));
    col = mix(col, uBg, smoothstep(0.05, 0.5, halo) * 0.7 * min(1.0, uFigAmt) * uAssemble * (1.0 - uDissolve));
  }
  col += uAccent * ringGlow * 0.25 * (mid.a + 0.3);
  // frozen: the rain drops back into the dark so the moment reads
  col = mix(col, mix(uBg, col, 0.42), uFreeze);
  col += mix(uAccent, uFg, 0.4) * dropGlow * (0.06 + 0.16 * uFreeze);

  // the figure, drawn by its own finer stream
  float fc = uFigGrid.z;
  vec2 fcell = vec2(fc * 0.62, fc);
  vec2 gf = (pw - uFigGrid.xy) / fcell;
  vec2 cell = floor(gf);
  vec2 cuv = ((cell + 0.5) * fcell + uFigGrid.xy) / uResolution;
  vec4 F = texture2D(uFig, cuv);
  float fy = clamp((cuv.y - uFigBottom) / max(0.05, uFigTop - uFigBottom), 0.0, 1.0);
  float hcell = hash21(cell * 0.913 + 4.1);
  float vis = step(hcell * 0.55 + fy * 0.45, uAssemble) * step(uDissolve, hcell * 0.5 + (1.0 - fy) * 0.5);
  float fcov = F.r * vis * min(1.0, uFigAmt);
  if (poster > 0.5) {
    // screen print: a sharp edge, and the shadow plate printed a little off register
    fcov = smoothstep(0.3, 0.6, texture2D(uFig, pw / uResolution).r) * vis * min(1.0, uFigAmt);
    float off = texture2D(uFig, cuv + vec2(0.007, -0.011) * uResolution.y / uResolution).r;
    col = mix(col, uAccent2 * 0.75, smoothstep(0.3, 0.6, off) * vis * min(1.0, uFigAmt) * 0.85);
  }
  if (fcov > 0.01) {
    float frow = floor(-gf.y * uFigDir);
    float h1 = hash21(vec2(cell.x, 71.0));
    float period = mix(6.0, 15.0, h1);
    float head = uRainT * (0.55 + 0.6 * h1) + h1 * 53.0;
    float m = mod(head - frow, period);
    float trail = period * 0.8;
    float b = m < trail ? pow(1.0 - m / trail, 1.1) : 0.0;
    float isHead = step(m, 1.0);
    float light = F.g;
    float rim = F.a;
    float hc = hash21(cell * 1.7 + 2.3);
    float mt = floor(uMutT * mix(0.5, 3.0, hc) + hc * 11.0) + isHead * floor(uMutT * 8.0);
    float gi = ucPoolGlyph(hash21(cell + vec2(mt * 0.31, mt * 0.17)), uPool);
    vec2 lu = fract(gf);
    if (poster > 0.5) {
      // the print take: a flat body plate, with the code knocked out of it as a halftone,
      // big glyphs in the shade and small ones in the light
      float tone = clamp(light * 0.85 + rim * 0.55 - 0.12, 0.0, 1.0);
      float gs = mix(0.22, 1.3, pow(1.0 - tone, 0.6));
      lu = (lu - 0.5) / gs + 0.5;
      float inCell = step(abs(lu.x - 0.5), 0.5) * step(abs(lu.y - 0.5), 0.5);
      float k = ucGlyph(gi, lu, max(0.0, log2(90.0 / (fc * gs)))) * inCell;
      vec3 plate = mix(uAccent2, uAccent, smoothstep(0.12, 0.3, tone));
      plate = mix(plate, uFg, smoothstep(0.82, 0.95, tone) * 0.75);
      // the falling heads print in the light ink, so the code still runs down the body
      vec3 ink = mix(uBg, uFg, isHead * 0.9);
      col = mix(col, mix(plate, ink, k * 0.94), fcov);
    } else {
      float gcov = ucGlyph(gi, lu, max(0.0, log2(90.0 / fc)));
      float lum = (0.3 + 0.9 * light) * (0.45 + 0.55 * b) + rim * 0.6 * (0.4 + 0.6 * b);
      lum *= 1.2 + 0.35 * uFreeze;
      vec3 fcCol = mix(uAccent2, uAccent, smoothstep(0.05, 0.5, light + rim * 0.4));
      fcCol = mix(fcCol, uFg, clamp(isHead * (0.4 + light) + smoothstep(0.6, 1.0, light) * 0.6 + rim * 0.45, 0.0, 1.0));
      // the body hides the rain behind it
      col = mix(col, uBg, fcov * 0.88);
      col = mix(col, fcCol * (1.0 + isHead * 0.6) * max(1.0, uFigAmt), clamp(gcov * fcov * min(1.0, lum * 1.6), 0.0, 1.0));
    }
  }
  // a breath of light inside the body, so the form reads between glyphs
  vec4 Fs = texture2D(uFig, (pw) / uResolution);
  col += uAccent * Fs.r * (0.03 + 0.05 * Fs.g) * uFigAmt * vis * (1.0 - uFigHalftone);

  // near rain: big, sparse, out of focus, in front of everything
  vec4 near = ucLayer(qr + vec2(uPar.z, 0.0), uCells.z, 13.0, 1.25, uDensity * 0.32, 1.6, uSparkle * 0.5);
  col = mix(col, near.rgb * 0.9, near.a * 0.75 * (1.0 - poster));

  // the sung words, assembled out of the rain
  vec2 wq = vec2((p.x - uWordBox.x) / uWordBox.z, (uWordBox.y - p.y) / uWordBox.w);
  if (wq.x > -0.3 && wq.y > -0.3 && wq.x < uWordDims.x + 0.3 && wq.y < uWordDims.y + 0.3) {
    vec2 wc = clamp(floor(wq), vec2(0.0), uWordDims - 1.0);
    vec4 W = texture2D(uWords, (wc + 0.5) / uWordDims);
    if (W.r >= 0.0) {
      float t = uWordT;
      float pre = smoothstep(W.g - 0.42, W.g - 0.12, t);          // decoding
      float lock = step(W.g, t);
      float after = smoothstep(W.b, W.b + 1.1, t);                   // dissolving back into rain
      float present = pre * (1.0 - after);
      if (present > 0.001) {
        vec2 lu = fract(wq);
        lu.y = 1.0 - lu.y;
        // falls a little as it dissolves
        lu.y += after * after * 1.4 * (0.5 + hash21(wc));
        float hc = hash21(wc + 0.7);
        float flick = floor(t * 22.0 + hc * 9.0);
        float rnd = ucPoolGlyph(hash21(wc + vec2(flick * 0.13, flick * 0.71)), uPool);
        float useWord = lock * (1.0 - step(0.5, after) * step(hash21(wc + flick), after));
        float gi = useWord > 0.5 ? W.r : rnd;
        float inCell = step(0.0, lu.y) * step(lu.y, 1.0);
        float gcov = ucGlyph(gi, lu, max(0.0, log2(90.0 / uWordBox.w))) * inCell;
        float landed = exp(-max(0.0, t - W.g) * 5.0) * lock;
        // a dark plate behind each letter cell so the words read over the rain
        float plate = present * smoothstep(0.62, 0.42, max(abs(fract(wq.x) - 0.5), abs(fract(wq.y) - 0.5)) - 0.0);
        col = mix(col, uBg, clamp(present * 0.82, 0.0, 1.0));
        vec3 wcol = mix(uAccent, uFg, lock * (1.0 - after * 0.8));
        float wb = (useWord > 0.5 ? 1.0 : 0.55 * pre) * (1.0 - after * 0.6);
        col = mix(col, wcol * (1.0 + landed * 1.6), clamp(gcov * wb, 0.0, 1.0));
        col += uFg * landed * 0.12 * plate;
      }
    }
  }

  gl_FragColor = vec4(col * uBright, 1.0);
}
`;

/* ───────── objects ───────── */

export const OBJ_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iDir;
attribute vec4 iData;   // kind (0 round, 1 shard, 2 droplet, 3 wake ring), size (m), alpha, glyph
attribute vec4 iExtra;  // streak (0 = still), spin, -, seed
varying vec2 vQ;
varying float vKind, vAlpha, vGlyph, vDist, vStreak, vSeed;
void main() {
  float kind = iData.x;
  float size = iData.y;
  vec2 q = position.xy;
  vKind = kind; vAlpha = iData.z; vGlyph = iData.w; vStreak = iExtra.x; vSeed = iExtra.w;
  vDist = length(iPos - cameraPosition);
  vec4 v0 = viewMatrix * vec4(iPos, 1.0);
  if (kind < 0.5) {
    // a round: a capsule laid along its flight on screen, a streak behind it when it moves
    vec4 v1 = viewMatrix * vec4(iPos + iDir * 0.1, 1.0);
    vec2 sd = (v1.xy / max(0.05, -v1.z)) - (v0.xy / max(0.05, -v0.z));
    sd = length(sd) > 1e-5 ? normalize(sd) : vec2(1.0, 0.0);
    vec2 sn = vec2(-sd.y, sd.x);
    float len = size * (1.0 + iExtra.x);
    // the bullet sits at the front of the quad; the streak trails behind it
    vec2 off = sd * (q.x * len - (len - size) * 0.5) + sn * q.y * size * 0.4;
    vQ = vec2((q.x + 0.5) * (1.0 + iExtra.x) - iExtra.x - 0.5, q.y);
    gl_Position = projectionMatrix * vec4(v0.xyz + vec3(off, 0.0), 1.0);
  } else if (kind < 2.5) {
    float a = iExtra.y;
    mat2 R = mat2(cos(a), sin(a), -sin(a), cos(a));
    float flip = kind < 1.5 ? max(0.2, abs(cos(a * 0.7 + iExtra.w * 6.0))) : 1.0;
    vec2 o = R * (q * vec2(flip, 1.0) * size);
    vQ = q;
    gl_Position = projectionMatrix * vec4(v0.xyz + vec3(o, 0.0), 1.0);
  } else {
    // a wake ring in the plane across the flight
    vec3 n = normalize(iDir);
    vec3 t = normalize(cross(n, abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 b = cross(n, t);
    vec3 wp = iPos + (t * q.x + b * q.y) * size * 2.0;
    vQ = q;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
}
`;

export const OBJ_FRAG = /* glsl */ `
${GLSL_ATLAS}
uniform sampler2D uFig;
varying vec2 vQ;
varying float vKind, vAlpha, vGlyph, vDist, vStreak, vSeed;
void main() {
  // hidden behind the body
  vec4 F = texture2D(uFig, gl_FragCoord.xy / uResolution);
  if (F.r > 0.5 && F.b * 16.0 < vDist - 0.04) discard;
  vec3 c = vec3(0.0);
  float a = 0.0;
  if (vKind < 0.5) {
    // the round: a short bullet (flat base, rounded nose) lit along its top, a thin faint streak behind
    // it when it moves. vQ.x runs from the tail of the streak to the nose (+0.5 at the nose)
    float tailLen = vStreak;
    float bx = (vQ.x - 0.5) / 1.0 + 1.0;            // 0..1 along the bullet itself (nose at 1)
    vec2 qb = vec2(bx - 0.5, vQ.y);
    float nose = smoothstep(0.62, 0.5, length(vec2(max(0.0, qb.x - 0.12) * 1.35, qb.y * 1.0)) + 0.12 * step(0.0, qb.x - 0.12));
    float shaft = step(abs(qb.y), 0.36) * step(-0.5, qb.x) * step(qb.x, 0.14);
    float body = max(shaft * smoothstep(0.38, 0.3, abs(qb.y)), smoothstep(0.42, 0.34, length(vec2(max(0.0, qb.x - 0.1) * 1.6, qb.y))));
    body *= step(-0.5, qb.x);
    float top = smoothstep(0.36, -0.1, abs(qb.y - 0.14));   // the highlight running along it
    vec3 metal = mix(uAccent2, uAccent, 0.55 + 0.45 * top) + uFg * pow(top, 3.0) * 0.9;
    float streak = tailLen > 0.01 ? smoothstep(0.12, 0.0, abs(vQ.y)) * smoothstep(-tailLen - 0.5, 0.0, vQ.x) * step(vQ.x, 0.0) * 0.35 : 0.0;
    c = metal * body * 1.25 + uAccent * streak;
    a = 1.0;
  } else if (vKind < 1.5) {
    float g = ucGlyph(vGlyph, vQ + 0.5, 0.6);
    c = mix(uAccent, uFg, 0.35) * g * 1.5;
    a = 1.0;
  } else if (vKind < 2.5) {
    // a droplet of code: a sphere of tiny glyphs, lit from above, with a bright rim
    float r = length(vQ) * 2.0;
    if (r > 1.0) discard;
    float z0 = sqrt(max(0.0, 1.0 - r * r));
    vec2 sq = vQ / (0.55 + 0.45 * z0);            // the glyphs wrap round the ball
    vec2 cell = floor((sq + 0.5) * 7.0);
    float gi = ucPoolGlyph(hash21(cell + vSeed * 13.0), 0.0);
    float g = ucGlyph(gi, fract((sq + 0.5) * 7.0), 1.8);
    float z = sqrt(max(0.0, 1.0 - r * r));
    float lit = clamp(0.25 + 0.75 * dot(normalize(vec3(vQ * 2.0, z)), normalize(vec3(-0.4, 0.6, 0.7))), 0.0, 1.0);
    float rim = smoothstep(0.82, 0.97, r) * smoothstep(1.0, 0.96, r);
    c = mix(uAccent2, uAccent, lit) * g * (0.35 + 0.9 * lit) * smoothstep(1.0, 0.85, r) + uAccent * rim * 0.3;
    a = 1.0;
  } else {
    // a wake ring: a thin glowing ellipse, dashed like a line of code
    float r = length(vQ) * 2.0;
    float ring = exp(-pow((r - 0.86) / 0.05, 2.0));
    float ang = atan(vQ.y, vQ.x);
    float dash = 0.55 + 0.45 * step(0.35, fract(ang * 6.0 / 3.14159 + vSeed));
    c = mix(uAccent, uFg, 0.3) * ring * dash * 1.1;
    a = 1.0;
  }
  gl_FragColor = vec4(c * vAlpha * a, 1.0);
}
`;

/* ───────── bloom ───────── */

export const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uTexel;
void main() {
  vec3 c = texture2D(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(uSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
         + texture2D(uSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(uSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  float l = luma(c) - luma(uBg);
  gl_FragColor = vec4(c * smoothstep(0.08, 0.7, l), 1.0);
}
`;

export const BLUR_FRAG = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uDir;
void main() {
  vec3 c = texture2D(uSrc, vUv).rgb * 0.2270270;
  c += (texture2D(uSrc, vUv + uDir * 1.3846153).rgb + texture2D(uSrc, vUv - uDir * 1.3846153).rgb) * 0.3162162;
  c += (texture2D(uSrc, vUv + uDir * 3.2307692).rgb + texture2D(uSrc, vUv - uDir * 3.2307692).rgb) * 0.0702703;
  gl_FragColor = vec4(c, 1.0);
}
`;

/* ───────── compose ───────── */

export const COMPOSE_FRAG = /* glsl */ `
${GLSL_ATLAS}
uniform sampler2D uScene, uBloom;
uniform vec4 uBill;        // the poster's billing block: centre x px, baseline px, cell height px, rows
uniform float uTear, uTearSeed, uFlash, uGlowAmt, uScan, uPrint, uDots, uDotT, uGrainAmt;
void main() {
  vec2 uv = vUv;
  // the snare: a scan tear, a few bands of the picture thrown sideways
  float band = floor(uv.y * 23.0 + uTearSeed * 7.0);
  float tearOn = step(0.74, hash11(band * 1.37 + uTearSeed)) * uTear;
  uv.x += tearOn * (hash11(band + 9.1 + uTearSeed) - 0.5) * 0.12;
  uv.x += step(0.94, hash11(floor(uv.y * 170.0) + uTearSeed * 3.0)) * uTear * 0.018;
  float ab = tearOn * 0.004;
  vec3 col = vec3(texture2D(uScene, uv + vec2(ab, 0.0)).r, texture2D(uScene, uv).g, texture2D(uScene, uv - vec2(ab, 0.0)).b);
  vec3 bl = texture2D(uBloom, uv).rgb;
  col += bl * uGlowAmt;
  // the drop's flash
  col = mix(col, uFg * 1.2, uFlash * 0.85);
  // scanlines, faint, every 3 px of a 1080p frame
  float sl = 0.5 + 0.5 * sin(gl_FragCoord.y * 3.14159 * (1080.0 / max(360.0, uResolution.y)) / 1.5);
  col *= 1.0 - uScan * 0.22 * sl;
  // vignette
  vec2 vq = vUv - 0.5;
  vq.x *= uAspect;
  col = mix(col, uBg, smoothstep(0.45, 1.25, length(vq)) * 0.55);

  if (uPrint > 0.5) {
    // the printed poster: a coarse paper tooth and the grey dots floating over the print
    vec2 pp = vec2(vUv.x * uAspect, vUv.y);
    vec3 dots = vec3(0.0);
    float dm = 0.0;
    for (int i = 0; i < 22; i++) {
      float fi = float(i);
      vec2 h = hash22(vec2(fi * 1.13, 3.7));
      float sz = mix(0.006, 0.052, pow(hash11(fi * 7.1 + 1.0), 2.4));
      float spd = 0.012 + 0.05 * hash11(fi + 2.0);
      vec2 c = vec2(h.x * (uAspect + 0.2) - 0.1, fract(h.y + uDotT * spd) * 1.2 - 0.1);
      c.x += 0.02 * sin(uDotT * 0.4 + fi);
      float d = length(pp - c) - sz;
      float m = smoothstep(1.2 / uResolution.y, -1.2 / uResolution.y, d);
      // misregistered a hair, like a second plate
      dm = max(dm, m * (0.75 + 0.25 * hash11(fi + 9.0)));
    }
    col = mix(col, uMuted, dm * uDots);
    // a printed frame and a billing block set in the machine script (nobody's credits)
    vec2 px = gl_FragCoord.xy;
    float m = uResolution.y * 0.035;
    vec2 e = min(px, uResolution - px);
    float frame = step(m, min(e.x, e.y)) * step(min(e.x, e.y), m + max(1.0, uResolution.y / 540.0));
    col = mix(col, uMuted, frame * 0.8);
    float bc = uBill.z;
    vec2 bq = vec2((px.x - uBill.x) / (bc * 0.62), (px.y - uBill.y) / bc);
    float rowsN = uBill.w;
    float bRow = floor(bq.y);
    float halfW = floor(mix(34.0, 18.0, step(0.5, bRow)) * min(1.0, uAspect));
    if (bRow >= 0.0 && bRow < rowsN && abs(bq.x) < halfW) {
      float bCol = floor(bq.x);
      float word = hash21(vec2(floor((bCol + 40.0) / (3.0 + floor(hash11(bRow + 3.0) * 4.0))), bRow));
      float gap = step(0.86, hash21(vec2(bCol, bRow * 7.0 + 1.0))) + step(0.8, word) * step(0.5, hash21(vec2(bCol * 0.5, bRow)));
      float gi = ucPoolGlyph(hash21(vec2(bCol, bRow) + 17.0), 1.0);
      float g = ucGlyph(gi, fract(bq), max(0.0, log2(90.0 / bc))) * (1.0 - min(1.0, gap));
      col = mix(col, mix(uMuted, uFg, step(rowsN - 1.0, bRow) * 0.6), g * 0.9);
    }
    float tooth = hash21(floor(gl_FragCoord.xy / max(1.0, uResolution.y / 540.0)) + 0.5);
    col = mix(col, uBg, step(0.93, tooth) * 0.35);
  } else if (uDots > 0.001) {
    vec2 pp = vec2(vUv.x * uAspect, vUv.y);
    float dm = 0.0;
    for (int i = 0; i < 14; i++) {
      float fi = float(i);
      vec2 h = hash22(vec2(fi * 1.13, 5.7));
      float sz = mix(0.004, 0.03, pow(hash11(fi * 7.1 + 3.0), 2.4));
      vec2 c = vec2(h.x * uAspect, fract(h.y + uDotT * (0.01 + 0.04 * hash11(fi + 4.0))) * 1.2 - 0.1);
      dm = max(dm, smoothstep(1.2 / uResolution.y, -1.2 / uResolution.y, length(pp - c) - sz));
    }
    col = mix(col, uMuted, dm * uDots * 0.8);
  }
  col += (hash21(gl_FragCoord.xy + fract(uTime * 7.3) * 91.0) - 0.5) * uGrainAmt;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
