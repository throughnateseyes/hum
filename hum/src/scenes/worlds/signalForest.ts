import { HM_LIB, defineClockedShaderScene, kickCountClock, speedClock, type ClockDef } from '../shader/lib';
import type { FrameContext } from '../../core/types';

/**
 * Signal Forest: a glade at night being read by an instrument.
 *
 * Tall trees with soft foliage stand on a black floor seen in perspective. The floor is never
 * filled in, only measured: fine contour lines flow round the trunks and climb each one as a
 * stack of bright rings (the floor really rises there: a flared cone per tree, found by a short
 * ray march), while a second family of lines fans out from the trunks like field lines.
 * Dot-matrix scan columns pass over the picture and turn whatever they cross into rows of
 * dashes, a column of small readouts runs down the left edge, and ferns close the bottom.
 *
 * The feeling is awe with a little unease: nature heard as signal. The trees stay quiet and
 * natural; everything the song does happens in the line work.
 *
 * Audio: each tree is a voice (nearest = bass, next = mids, far = highs) and its ring stack
 * grows with its band. Every kick sends a ring out across the floor from the bass tree and the
 * contours bunch as it passes; the waveform rides the lines; a scan sweeps across once a bar,
 * hats sparkle dashes inside the columns and snares tear one vertically. Energy spreads the
 * colour out from the trunks, a build closes the scan in from both sides and winds the rings
 * higher and tighter, the drop bursts them across the whole floor while the trees flash to
 * negative, and a break drains the colour back to the trunks.
 *
 * Palette roles: bg = the night (sky and floor), fg = contour lines and readouts, muted =
 * foliage and mist, accent and accent2 = the two ends of the ring colours (the rings cycle
 * accent → fg → accent2 → a pale muted → accent, so they hold up on any palette).
 */
const fragment = /* glsl */ `
${HM_LIB}

const float SF_F = 1.1;    // focal length, in screen heights
const float SF_EYE = 1.0;  // eye height above the floor
const float SF_R = 1.8;    // rim radius of the nearest ring cone

// Seven trees, far → near. 6 = bass, 4 = mids, 2 = highs; the others fill the glade in landscape.
const float SF_Z[7] = float[7](30.0, 22.0, 15.0, 11.0, 8.0, 6.0, 4.0);
const float SF_XL[7] = float[7](0.0, -0.55, 0.55, 0.80, 0.24, -0.80, -0.30);     // foot, screen x, 16:9
const float SF_XP[7] = float[7](-0.23, -0.01, 0.21, 0.50, 0.08, -0.62, -0.085); // foot, screen x, 9:16
const float SF_H[7] = float[7](8.5, 7.2, 6.0, 5.2, 4.6, 4.0, 3.6);
const float SF_NR[7] = float[7](0.0, 0.0, 16.0, 12.0, 22.0, 18.0, 34.0);           // field lines each trunk feeds

float sfVoice(int i) {
  if (i == 6) return u_v0;
  if (i == 4) return u_v1;
  if (i == 2) return u_v2;
  if (i == 5) return u_v2 * 0.6;
  if (i == 3) return u_v0 * 0.6;
  if (i == 1) return u_v1 * 0.6;
  return u_v2 * 0.5;
}

// ring colours: accent → fg → accent2 → pale muted → accent
vec3 sfSpec(float t) {
  t = fract(t) * 4.0;
  vec3 c3 = mix(uMuted, uFg, 0.35);
  if (t < 1.0) return mix(uAccent, uFg, t);
  if (t < 2.0) return mix(uFg, uAccent2, t - 1.0);
  if (t < 3.0) return mix(uAccent2, c3, t - 2.0);
  return mix(c3, uAccent, t - 3.0);
}

float sfN2(vec2 p) { return (vnoise(p) + 0.5 * vnoise(p * 2.03 + 11.7)) / 1.5; }

// ring cone profile: 1 at the trunk, a long flat skirt out to the rim
float sfFlare(float r, float r0, float rim) {
  float k = 1.0 - clamp((r - r0) / (rim - r0), 0.0, 1.0);
  return k * k * k * sqrt(k);
}

// hairlines at whole values of L (fw = change of L per pixel); where they would merge they
// dissolve into an even tone instead of aliasing
float sfLine(float L, float fw, float lw) {
  float d = abs(fract(L + 0.5) - 0.5) / fw;
  float ln = 1.0 - smoothstep(lw * 0.5 - 0.5, lw * 0.5 + 0.5, d);
  return mix(ln, min(lw * fw, 0.3), smoothstep(0.3, 0.8, fw));
}

// One tree. q = across / up in tree heights from the foot. Returns alpha, shade, envelope
// (crown + trunk, gaps included: used for the negative flash).
vec3 sfTreeSprite(vec2 q, float seed, float leafF, float aa, float tt) {
  float h1 = hash11(seed * 1.7 + 0.3);
  float h2 = hash11(seed * 2.9 + 0.7);
  float lean = (h1 - 0.5) * 0.08;
  float cx = lean * q.y + 0.008 * sin(q.y * 5.0 + seed * 9.0);
  float dx = q.x - cx;
  // trunk, lit from the right
  float tw = mix(0.015, 0.003, smoothstep(0.0, 0.95, q.y)) + 0.008 * exp(-q.y * 18.0);
  float trunk = (1.0 - smoothstep(tw - aa, tw + aa, abs(dx))) * step(q.y, 0.9);
  float lit0 = smoothstep(-tw * 0.3, tw, dx);
  // three limbs reaching into the crown
  if (q.y > 0.3 && abs(dx) < 0.3) {
    for (int k = 0; k < 3; k++) {
      float sgn = k == 1 ? -1.0 : 1.0;
      if (h2 > 0.5) sgn = -sgn;
      vec2 a0 = vec2(cx, 0.36 + 0.12 * float(k) + 0.06 * h2);
      vec2 dir = vec2(sgn * (0.5 + 0.35 * h1), 1.0) * (0.24 - 0.04 * float(k));
      vec2 pa = q - a0;
      float hh = clamp(dot(pa, dir) / dot(dir, dir), 0.0, 1.0);
      float bw = 0.005 * (1.0 - 0.8 * hh);
      float limb = 1.0 - smoothstep(bw - aa, bw + aa, length(pa - dir * hh));
      if (limb > trunk) { trunk = limb; lit0 = 0.35; }
    }
  }
  float alpha = trunk;
  float env = trunk;
  float shade = 0.0;
  if (trunk > 0.0) shade = (0.10 + 0.55 * lit0) * (0.65 + 0.7 * vnoise(vec2(dx * 300.0 + seed, q.y * 12.0)));
  // crown: two domes broken into pads, leaves as thresholded speckle, lit from the upper right
  vec2 c = vec2(lean * 0.7 + (h2 - 0.5) * 0.05, 0.66);
  vec2 e = (q - c) / vec2(0.26 + 0.06 * h1, 0.36);
  vec2 e2 = (q - c - vec2((h2 - 0.5) * 0.4, -0.08)) / vec2(0.2, 0.2);
  float dome = 1.0 - min(dot(e, e), dot(e2, e2));
  if (dome > -0.8) {
    // the crown sways on the shared wind (tt is its phase here) and leans downwind as it gusts
    vec2 qq = q - vec2(sin(tt * 0.6 + q.y * 4.0 + seed) * (0.004 + 0.003 * uFeelGust) + 0.007 * u_lean * smoothstep(0.3, 1.0, q.y), 0.0);
    vec2 np = qq * vec2(7.0, 8.5) + seed * 13.1;
    float n1 = sfN2(np);
    float dens = dome * 0.9 + (n1 - 0.5) * 1.9;
    float cenv = smoothstep(0.08, 0.32, dens);
    if (cenv > 0.0) {
      float n1b = sfN2(np + vec2(0.2, 0.26));
      float l1 = 0.5 + 0.5 * snoise(qq * leafF * 0.55 + seed * 3.0);
      float l2 = vnoise(rot2(0.6) * qq * leafF * 2.1 - seed * 5.0);
      float leafA = smoothstep(0.42, 0.56, l1 * 0.62 + l2 * 0.38 + (dens - 0.5) * 0.4) * cenv;
      float lit = clamp(0.42 + (n1 - n1b) * 2.4 + e.x * 0.3 + e.y * 0.24, 0.0, 1.0);
      float ls = (0.08 + 0.92 * lit) * (0.3 + 0.9 * l2 * l2 + 0.55 * l1 * l1);
      shade = mix(shade, ls, leafA);
      alpha = max(alpha, leafA);
      env = max(env, smoothstep(0.1, 0.16, dens));
    }
  }
  return vec3(alpha, shade, env);
}

// Undergrowth: fern rosettes in front of a bushy mass. Returns alpha, shade.
vec2 sfFerns(vec2 p, float aa, float tt) {
  float y = p.y + 0.5;
  if (y > 0.24) return vec2(0.0);
  float leafN = vnoise(p * 150.0);
  float ridge = 0.045 + 0.04 * vnoise(vec2(p.x * 9.0, 3.0)) + 0.016 * vnoise(vec2(p.x * 41.0, 7.0));
  float alpha = 1.0 - smoothstep(ridge - 0.014, ridge + 0.004, y + (leafN - 0.5) * 0.03);
  float shade = 0.04 + 0.32 * leafN * leafN * smoothstep(ridge - 0.05, ridge, y);
  float cell = 0.13;
  float ci = floor(p.x / cell + 0.5);
  for (int k = -1; k <= 1; k++) {
    float id = ci + float(k);
    float hl = hash11(id * 7.7 + 1.0);
    vec2 o = vec2((id + (hash11(id * 3.1 + 5.0) - 0.5) * 0.8) * cell, -0.52);
    float len = 0.12 + 0.11 * hl;
    vec2 d = p - o;
    float rho = length(d);
    if (rho > len || d.y < 0.0) continue;
    float u = rho / len;
    float phi = atan(d.y, d.x);
    // fronds arch outward and nod with the bar
    float phi0 = phi + (0.8 + 0.12 * sin(tt * 0.8 + id * 2.0)) * u * u * cos(phi) + 0.12 * u_lean * u * u;
    float fa = phi0 / PI * 7.0 + hl;
    float fi = floor(fa);
    float across = (fract(fa) - 0.5) / 7.0 * PI * rho;
    float uu = u / (0.6 + 0.4 * hash11(fi * 5.3 + id * 11.0));
    if (uu < 1.0) {
      float blade = len * 0.085 * pow(sin(PI * uu), 0.7) * (1.0 - 0.5 * uu);
      float ax = abs(across) / max(blade, 1e-4);
      float comb = abs(sin(uu * 24.0 - ax * 1.4 + fi * 1.7)); // pinnae, swept back
      comb *= comb;
      float w = blade * comb + 0.001;
      float fA = 1.0 - smoothstep(w - aa, w + aa, abs(across));
      float fS = 0.1 + 0.85 * (1.0 - 0.7 * ax) * (0.3 + 0.7 * uu) * (0.45 + 0.55 * hash11(fi * 3.1 + id));
      shade = mix(shade, fS, fA);
      alpha = max(alpha, fA);
    }
  }
  return vec2(alpha, shade);
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  float hw = 0.5 * uAspect;
  float wide = smoothstep(0.7, 1.6, uAspect);
  float g1 = max(1.0, floor(uResolution.y / 720.0 + 0.5)); // one readout pixel
  float aaPx = 1.0 / uResolution.y;
  float en = u_en;
  float bld = u_bld;
  float tt = u_clk;

  // ── which columns are being read ────────────────────────────────────────────────────────
  float cellH = max(3.0, floor(uResolution.y / 180.0));
  float cellW = floor(cellH * 1.5);
  vec2 cellSz = vec2(cellW, cellH);
  vec2 cellI = floor(fc / cellSz);
  vec2 cellUv = fract(fc / cellSz);
  float xc = (cellI.x + 0.5) * cellW / uResolution.x;
  float strip = floor(cellI.x / 4.0);
  // the sweep: one pass per bar, a solid head and a wake that thins out behind it
  float back = fract(u_scanX) * 1.4 - 0.2 - xc;
  float headW = 0.03 + 0.06 * uLevel;
  float sweep = 0.0;
  if (back > 0.0) {
    sweep = back < headW ? 1.0 : step(hash11(cellI.x * 1.31 + floor(u_scanX) * 7.0), exp(-(back - headW) * (10.0 - 6.0 * en)));
  }
  // standing columns, re-dealt every beat, more of them when it is loud
  float standing = step(hash11(strip * 3.17 + floor(u_scanX * 4.0) * 0.71), 0.02 + 0.28 * en * en * (0.4 + 0.6 * uLevel));
  // a build closes the scan in from both sides
  float edge = abs(xc - 0.5) * 2.0 + (hash11(strip * 9.1) - 0.5) * 0.14;
  float closing = step(1.0 - bld * 0.95, edge) * step(0.02, bld);
  float sc = max(max(sweep, standing) * step(hash11(strip * 5.3 + 2.0), u_scan * 1.6), closing * step(0.001, u_scan));
  // a snare tears one column vertically
  float tearX = hash11(u_snareN * 3.71 + 0.5);
  float inTear = step(abs(xc - tearX), 0.015 + 0.03 * hash11(u_snareN * 1.3)) * step(0.001, u_scan);
  float tear = inTear * (hash11(strip * 1.7 + u_snareN) - 0.5) * 0.36 * uSnare * uSnare;
  sc = max(sc, inTear * step(0.06, uSnare));
  // the readout column stays clear
  sc *= 1.0 - u_readout * step(fc.x, 66.0 * g1) * step(0.17 * uResolution.y, fc.y);

  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  p.y += tear;
  // inside a column the trees are sampled once per dash
  vec2 pc = ((cellI + 0.5) * cellSz / uResolution - 0.5) * vec2(uAspect, 1.0);
  pc.y += tear;
  vec2 pt = mix(p, pc, sc);

  // ── the glade ───────────────────────────────────────────────────────────────────────────
  float hz = mix(0.13, 0.10, wide);                // horizon
  float camX = sin(tt * 0.33) * 0.3 + uSway * 0.03; // the eye drifts sideways: parallax
  vec2 tb[7];  // foot on the floor, relative to the eye
  float tA[7]; // ring cone height
  float tR[7]; // ring cone rim
  for (int i = 0; i < 7; i++) {
    float far = pow(SF_Z[i] * 0.25, 0.25); // far cones are a little larger so they still read
    tb[i] = vec2(mix(SF_XP[i], SF_XL[i], wide) * SF_Z[i] / SF_F - camX, SF_Z[i]);
    tA[i] = min(0.93, (0.24 + 0.6 * sfVoice(i) + (i == 6 ? 0.1 * uKick : 0.0)) * u_rings * (1.0 + 0.6 * bld) * far);
    tR[i] = SF_R * (1.0 - 0.3 * bld) * far;
  }

  vec3 mistCol = mix(uBg, uMuted, 0.36);
  float mn = 2.0 * vnoise(vec2(p.x * 2.4 - u_mistX * 0.06, p.y * 7.0 - tt * 0.03)) - 1.0; // drifts downwind
  float dyh = p.y - hz;
  float mistA = u_mist * exp(-abs(dyh) * (dyh > 0.0 ? 8.0 : 22.0)) * (0.55 + 0.25 * mn) * (0.7 + 0.3 * en);

  // night sky with a soft light low on the right
  vec3 col = uBg;
  vec2 gl = (p - vec2(hw * 0.8, hz + 0.06)) * vec2(1.0, 2.0);
  col = mix(col, mix(uMuted, uFg, 0.2), 0.3 * u_mist * exp(-length(gl) * 2.6));

  // ── the floor: ray → plane, then the ring cones in front of it ─────────────────────────
  float a = p.x / SF_F;
  float b = (p.y - hz) / SF_F;
  float zHit = 1e5;
  float isFloor = 0.0;
  if (b < -0.0004) {
    isFloor = 1.0;
    zHit = -SF_EYE / b;
    float qa = a * a + 1.0;
    for (int i = 0; i < 7; i++) {
      vec2 c = tb[i];
      float hb = a * c.x + c.y;
      float rim = tR[i];
      float disc = hb * hb - qa * (dot(c, c) - rim * rim);
      if (disc <= 0.0) continue;
      float zc = hb / qa;
      float zw = sqrt(disc) / qa;
      if (zc - zw >= zHit || zc + zw <= 0.0) continue;
      float r0 = 0.014 * SF_H[i];
      float zPrev = zc - zw;
      float found = -1.0;
      for (int k = 1; k <= 8; k++) {
        float u = -1.0 + float(k) * 0.25;
        float z = min(zc + zw * u * (0.25 + 0.75 * u * u), zHit);
        float gap = SF_EYE + b * z - tA[i] * sfFlare(length(vec2(a * z - c.x, z - c.y)), r0, rim);
        if (gap < 0.0) { found = z; break; }
        zPrev = z;
      }
      if (found > 0.0) {
        float lo = zPrev;
        float hi = found;
        for (int k = 0; k < 6; k++) {
          float z = 0.5 * (lo + hi);
          float gap = SF_EYE + b * z - tA[i] * sfFlare(length(vec2(a * z - c.x, z - c.y)), r0, rim);
          if (gap < 0.0) hi = z; else lo = z;
        }
        zHit = 0.5 * (lo + hi);
      }
    }
  }

  // the measured field at the hit point
  vec2 P = vec2(a * zHit, zHit);           // relative to the eye
  float Y = max(SF_EYE + b * zHit, 0.0);   // height on a cone, 0 on the open floor
  float wells = 0.0;
  float ringF = 0.0;
  float G = 0.0;
  float cAmt = 0.0;
  float reach = (0.3 + 5.0 * u_flood * u_flood) * u_colour * 1.4;
  float burstF = 0.0;
  float sd = u_sinceDrop;
  if (isFloor > 0.5) {
    for (int i = 0; i < 7; i++) {
      vec2 d = P - tb[i];
      float r = length(d);
      float v = sfVoice(i);
      wells += (0.5 + 0.7 * v) / (1.0 + r * r * 0.09);
      ringF += 46.0 * sqrt(4.0 / SF_Z[i]) * (1.0 + 0.7 * bld) * tA[i] * sfFlare(r, 0.014 * SF_H[i], tR[i]);
      if (SF_NR[i] > 0.0) G += SF_NR[i] * atan(d.y, d.x) / TAU;
      cAmt = max(cAmt, (1.0 - smoothstep(0.5 * reach * tR[i], reach * tR[i], r)) * (0.6 + 0.6 * v));
      float bf = r - sd * 9.0;
      burstF += exp(-bf * bf * 0.6);
    }
  }
  burstF *= u_burst * exp(-sd * 1.3);
  cAmt = clamp(cAmt, 0.0, 1.0);

  // kick rings run out from the bass tree; the contours bunch as each passes
  float rB = length(P - tb[6]);
  float rip = 0.0;
  float ringLine = 0.0;
  float wake = 0.0;
  float rw = fwidth(rB) * 1.6 + 0.008;
  for (int s = 0; s < 4; s++) {
    float age = s == 0 ? u_k0Age : s == 1 ? u_k1Age : s == 2 ? u_k2Age : u_k3Age;
    float amp = s == 0 ? u_k0Amp : s == 1 ? u_k1Amp : s == 2 ? u_k2Amp : u_k3Amp;
    float front = rB - 0.25 - age * 3.4;
    float fade = amp * exp(-age * 1.3) * (1.0 - smoothstep(1.5, 1.95, age));
    rip += fade * exp(-front * front * 5.0);
    ringLine += fade * (1.0 - smoothstep(0.0, rw, abs(front)));
    wake += fade * exp(min(front, 0.0) * 2.6) * step(front, 0.0);
  }
  rip *= u_ripple;
  ringLine *= min(u_ripple, 1.0) * isFloor;
  wake *= min(u_ripple, 1.0) * isFloor;

  float nz = snoise(vec2(P.x * 0.13 + camX * 0.13 + tt * 0.05, P.y * 0.09 - tt * 0.03));
  float nz2 = snoise(vec2(P.x * 0.1 + 7.0 + camX * 0.1, P.y * 0.07 - tt * 0.1));
  float wv = waveform(0.25 + 0.5 * vUv.x) * u_wave * (0.25 + 0.75 * uLevel);
  float L1 = u_density * (5.0 * nz + 7.0 * wells + ringF) + 2.4 * rip + 4.0 * burstF + 0.8 * wv;
  float L2 = G + 0.7 * nz2 + 0.5 * rip;
  float fw1 = max(fwidth(L1), 1e-4);
  vec2 gv = vec2(cos(TAU * L2), sin(TAU * L2)); // derivative of an angle without its branch cut
  float fw2 = max((length(dFdx(gv)) + length(dFdy(gv))) / TAU, 1e-4);

  if (isFloor > 0.5) {
    float lw = max(1.0, uResolution.y / 1080.0);
    float fog = exp(-zHit * 0.022 * (0.4 + 1.2 * u_mist));
    float onCone = smoothstep(0.0, 0.04, Y);
    float idx = floor(L1 + 0.5);
    vec3 ringInk = mix(uFg, sfSpec(idx * 0.37 + 0.13), cAmt);
    float l1 = sfLine(L1, fw1, lw * (1.0 + 0.5 * cAmt));
    float l2 = sfLine(L2, fw2, lw);
    float quiet = (0.34 + 0.6 * en + 0.12 * uKick) * (1.0 - 0.45 * bld);
    col = uBg;
    col = mix(col, sfSpec(idx * 0.37 + 0.13), 0.06 * cAmt * (0.4 + en) * fog); // faint glow under the colour
    col = mix(col, mix(uFg, ringInk, 0.5), l2 * mix(quiet * 0.55, 0.5, onCone * cAmt) * fog);
    col = mix(col, ringInk, l1 * mix(quiet, 1.0, max(onCone * 0.75, cAmt)) * fog);
    // the kick ring, and the lines it has just passed still lit in its colour
    vec3 kickCol = mix(sfSpec(u_kickN * 0.31), uFg, 0.25);
    col = mix(col, kickCol, clamp(wake * (0.07 + 0.8 * l1 + 0.4 * l2), 0.0, 1.0) * fog);
    col = mix(col, kickCol, clamp(ringLine, 0.0, 1.0) * fog);
    // the drop: every ring thrown outward at once
    col = mix(col, mix(sfSpec(idx * 0.37 + 0.13), uFg, 0.35), clamp(burstF * (l1 + 0.1), 0.0, 1.0) * fog);
  }

  // ── trees, near → far (stop once the picture is covered), mist between the layers ────
  float neg = u_burst * (1.0 - smoothstep(0.07, 0.2, sd));
  vec3 acc = vec3(0.0);
  float tLeft = 1.0;
  for (int k = 0; k < 7; k++) {
    int i = 6 - k;
    float z = SF_Z[i];
    if (z - 0.03 * SF_H[i] > zHit || tLeft < 0.03) break; // the trunk stands a little proud of its cone
    if (i == 2) {
      acc += tLeft * mistA * 0.7 * mistCol;
      tLeft *= 1.0 - mistA * 0.7;
    }
    float s = SF_H[i] * SF_F / z;
    vec2 q = (pt - vec2(tb[i].x * SF_F / z, hz - SF_F * SF_EYE / z)) / s;
    if (abs(q.x) > 0.5 || q.y < -0.02 || q.y > 1.06) continue;
    float leafF = min(90.0, s * uResolution.y / 3.0);
    vec3 tr = sfTreeSprite(q, float(i) + 1.0, leafF, aaPx / s, uFeelWindPhase);
    if (tr.z <= 0.0) continue;
    float v = sfVoice(i);
    float haze = 1.0 - exp(-z * 0.06 * (0.3 + 1.4 * u_mist));
    float sh = tr.y * (0.85 + 0.25 * v + 0.15 * en);
    vec3 tc = uMuted * sh * 1.15;
    tc = mix(tc, uFg, 0.4 * pow(clamp(sh, 0.0, 1.0), 4.0));
    tc = mix(tc, mistCol, haze * 0.85);
    // the drop: an instant of negative
    float ng = neg * tr.z;
    tc = mix(tc, mix(uFg, uBg, tr.x * (0.3 + 0.7 * clamp(sh, 0.0, 1.0))), ng);
    float al = max(tr.x, ng);
    acc += tLeft * al * tc;
    tLeft *= 1.0 - al;
  }
  col = mix(col, mistCol, mistA * (zHit > 12.0 ? 1.0 : 0.45 * step(dyh, 0.0)));
  col = acc + tLeft * col;

  // ── level tags at the three voice trees ────────────────────────────────────────────────
  for (int k = 0; k < 3; k++) {
    int i = 6 - 2 * k;
    float z = SF_Z[i];
    vec2 foot = (vec2(tb[i].x * SF_F / z, hz - SF_F * SF_EYE / z) / vec2(uAspect, 1.0) + 0.5) * uResolution;
    vec2 dk = fc - foot - vec2(tR[i] * 0.55 * SF_F / z * uResolution.y + 6.0 * g1, -3.0 * g1);
    float tag = hmNumber(floor(dk / g1) - vec2(10.0, 0.0), sfVoice(i) * 99.9, 2.0);
    if (dk.x > 0.0 && dk.x < 7.0 * g1 && abs(dk.y - 2.0 * g1) < 0.5 * g1 + 0.25) tag = 1.0;
    col = mix(col, uFg, tag * 0.7 * u_readout);
  }

  // ── spectrum bars standing in the undergrowth ──────────────────────────────────────────
  float fy = p.y + 0.5;
  if (fy < 0.3) {
    float sp = spectrum(0.02 + 0.8 * abs(xc - 0.5) * 2.0);
    float barH = (0.015 + 0.13 * sp) * (0.35 + 0.65 * en);
    float cy = (cellI.y + 0.5) * cellH / uResolution.y - 0.06;
    float on = step(0.0, cy) * step(cy, barH) * step(0.2, cellUv.x) * step(cellUv.x, 0.8) * step(0.25, cellUv.y) * step(cellUv.y, 0.75);
    on *= step(hash21(cellI + 3.0), 0.82);
    col = mix(col, mix(uAccent2, uFg, clamp(cy / max(barH, 1e-3), 0.0, 1.0) * 0.6), on * (0.3 + 0.45 * en));
  }

  // ── scan columns: the picture read out as dashes ───────────────────────────────────────
  float dash = step(0.16, cellUv.x) * step(cellUv.x, 0.84) * step(0.25, cellUv.y) * step(cellUv.y, 0.75);
  if (sc > 0.0) {
    float hc = hash21(cellI + floor(u_scanX * 8.0) * 0.37);
    float keep = dash * step(0.08, hc) * (0.8 + 0.6 * hc);
    vec3 read = col * 1.3 + mistCol * 0.035;
    // hats sparkle single dashes
    float spark = step(hash21(cellI * 1.7 + u_hatN * 13.0), 0.07 * uHat * (0.5 + en));
    read = mix(read, sfSpec(hc * 3.0 + u_hatN * 0.21), spark);
    // a little of the reading glitches into ring colour
    read = mix(read, sfSpec(hc * 5.0) * (0.15 + luma(read) * 2.0), step(0.95, hc) * u_colour);
    col = mix(col, read * keep + col * 0.3, sc);
  }
  // the head of the sweep is a hairline
  col = mix(col, uFg, 0.3 * u_scan * step(abs(back), 0.6 * cellW / uResolution.x) * step(mod(cellI.y, 2.0), 0.5));

  // ── ferns close the bottom ─────────────────────────────────────────────────────────────
  vec2 fr = sfFerns(pt + vec2(camX * 0.24, 0.0), aaPx, uFeelWindPhase + uSway);
  vec3 fernCol = uMuted * fr.y * (0.9 + 0.3 * en);
  fernCol = mix(fernCol, uFg, 0.3 * pow(clamp(fr.y, 0.0, 1.0), 3.0));
  fernCol *= mix(1.0, 0.4 + dash, sc);
  col = mix(col, fernCol, fr.x);

  // ── readouts down the left edge ────────────────────────────────────────────────────────
  if (u_readout > 0.001) {
    float pitch = 9.0 * g1;
    vec2 rp = vec2(fc.x - 12.0 * g1, uResolution.y - fc.y - 14.0 * g1);
    float row = floor(rp.y / pitch);
    vec2 lc = floor(vec2(rp.x, pitch - 1.0 - (rp.y - row * pitch)) / g1); // glyph px, y up
    float rid = row + u_kickN;
    float hr = hash11(rid * 1.37 + 0.2);
    float ink = 0.0;
    vec3 inkCol = uFg;
    if (rp.x >= 0.0 && rp.y >= 0.0 && fc.y > uResolution.y * 0.17 && lc.x < 52.0) {
      float body = step(1.0, lc.y) * step(lc.y, 5.0);
      if (lc.x < 4.0) {
        // a small swatch per row
        if (hr > 0.25) { ink = body; inkCol = sfSpec(hr * 7.0); }
      } else if (mod(rid, 5.0) < 0.5) {
        // every fifth row is a live number
        float sel = mod(floor(rid / 5.0), 4.0);
        float val = sel < 0.5 ? u_v0 * 99.9 : sel < 1.5 ? u_v1 * 99.9 : sel < 2.5 ? u_v2 * 99.9 : mod(u_scanX, 100.0);
        ink = hmNumber(lc - vec2(7.0, 1.0), val, 2.0);
      } else {
        // greeked text: runs of dashes
        float cx2 = floor((lc.x - 7.0) / 2.0);
        float lenR = 6.0 + floor(hr * 16.0);
        if (cx2 >= 0.0 && cx2 < lenR) ink = step(2.0, lc.y) * step(lc.y, 4.0) * step(0.32, hash21(vec2(floor(cx2 / 1.0), rid)));
      }
      float blink = step(hash11(rid * 3.3 + u_hatN), 0.12 * uHat);
      col = mix(col, inkCol, ink * u_readout * (0.34 + 0.2 * en + 0.5 * blink + 0.3 * step(mod(rid, 5.0), 0.5)));
    }
  }

  col += hmGrain(fc, uTime) * 0.03;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/* ───────────────────────── clocks ───────────────────────── */

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** one-pole follower with separate rise and fall rates (per second) */
const follow = (target: (f: FrameContext) => number, up: number, down: number, init = 0): ClockDef => ({
  init,
  step: (v, f) => {
    const t = target(f);
    return v + (t - v) * (1 - Math.exp(-f.dt * (t > v ? up : down)));
  },
});
const counter = (hit: (f: FrameContext) => boolean): ClockDef => ({ step: (v, f) => (hit(f) ? (v + 1) % 997 : v) });

/* Four kick rings alive at once: kick n lands in slot n % 4 (kickN is stepped first). */
const slotHit = (i: number, f: FrameContext, s: Record<string, number>) => f.audio.kickHit && Math.round(s.kickN) % 4 === i;
const kickSlot = (i: number): Record<string, ClockDef> => ({
  [`k${i}Age`]: { init: 100, step: (v, f, s) => (slotHit(i, f, s) ? 0 : Math.min(v + f.dt, 100)) },
  [`k${i}Amp`]: { step: (v, f, s) => (slotHit(i, f, s) ? 0.55 + clamp01(f.audio.kick) * 0.45 : v) },
});

export const signalForest = defineClockedShaderScene(
  {
    id: 'signal-forest',
    name: 'Signal Forest',
    description:
      'A forest glade at night being read by an instrument: quiet blue-violet trees on a black floor drawn only as fine contour lines that climb each trunk in a stack of bright spectral rings, with dot-matrix scan columns, a column of readouts and ferns along the bottom. Each tree is a voice (bass, mids, highs) and its rings grow with its band; kicks send a ring across the floor, a scan sweeps once a bar, hats sparkle and snares tear a column. A build closes the scan in and winds the rings tight, the drop floods the whole floor with colour as the trees flash to negative, and a break drains it back to the trunks.',
    category: 'form',
    style: 'world',
    fragment,
    tags: ['dark', 'nature', 'electronic', 'cinematic', 'spacious', 'hypnotic', 'glitch', 'futuristic', 'experimental', 'ambient', 'dreamy', 'cold'],
    params: [
      { id: 'density', label: 'Line density', group: 'Shape', type: 'number', min: 0.4, max: 2, step: 0.01, default: 1 },
      { id: 'rings', label: 'Ring stacks', group: 'Shape', type: 'number', min: 0, max: 1.5, step: 0.01, default: 1, hint: 'How high the rings climb each trunk' },
      { id: 'mist', label: 'Mist', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.55, hint: 'Haze at the horizon; far trees fade into it' },
      { id: 'scan', label: 'Scan columns', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 0.65, hint: 'How much of the picture is read out as dashes' },
      { id: 'readout', label: 'Readouts', group: 'Shape', type: 'number', min: 0, max: 1, step: 0.01, default: 1, hint: 'The column of small numbers and the level tags at the trees' },
      { id: 'speed', label: 'Drift', group: 'Motion', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'How fast the contours flow and the view drifts sideways' },
      { id: 'ripple', label: 'Kick rings', group: 'Reactivity', type: 'number', min: 0, max: 2, step: 0.01, default: 1, hint: 'Each kick sends a ring out from the nearest tree' },
      { id: 'wave', label: 'Waveform', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, hint: 'The waveform rides the contour lines' },
      { id: 'burst', label: 'Drop burst', group: 'Reactivity', type: 'number', min: 0, max: 1, step: 0.01, default: 1, hint: 'The drop throws the rings across the floor and flashes the trees to negative' },
      { id: 'colour', label: 'Colour reach', group: 'Color', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7, hint: 'How far the ring colours spread from the trunks' },
    ],
    modulations: [
      { source: 'energy', param: 'density', amount: 0.1 },
      { source: 'sway', param: 'mist', amount: 0.08 },
    ],
  },
  {
    // contour flow and sideways drift: slow in silence, a little quicker when it is loud
    clk: speedClock('speed', 1, (f) => 0.5 + 0.7 * f.audio.energy + 0.6 * Math.max(f.audio.build, f.feel.tension) * (1 - f.audio.drop)),
    // scan sweep, in bars: a slow pass every four bars when quiet, one per bar when the song is up
    scanX: {
      step: (v, f) => {
        const bps = f.audio.bpm > 0 ? f.audio.bpm / 60 : 2;
        const up = clamp01((f.audio.energy - 0.12) / 0.3);
        return (v + f.dt * (bps / 4) * (0.25 + 0.75 * up)) % 1000;
      },
    },
    en: follow((f) => f.audio.energy, 1.4, 0.8),
    bld: follow((f) => Math.max(f.audio.build, f.feel.tension) * (1 - clamp01(f.audio.drop * 1.5)), 5, 12),
    // the shared wind: a signed downwind lean (eased, so a change of wind swings the crowns across) …
    lean: {
      step: (v, f, _s, mem) => {
        const t = f.feel.windX * f.feel.gust;
        if (!mem.leanInit) {
          mem.leanInit = 1;
          return t;
        }
        return v + (t - v) * (1 - Math.exp(-f.dt * 1.2));
      },
    },
    // … and how far the mist has drifted along it (integrates the wind's travel, so it never jumps)
    mistX: {
      step: (v, f, _s, mem) => {
        const ph = f.feel.windPhase;
        let d = ph - (mem.mistPh ?? ph);
        mem.mistPh = ph;
        if (d < 0 || d > 1) d = 0;
        return (v + d * f.feel.windX) % 1000;
      },
    },
    // the three voices: quick to swell, slow to settle
    v0: follow((f) => clamp01(f.audio.bass * 0.85 + f.audio.sub * 0.4), 14, 2.6),
    v1: follow((f) => clamp01(f.audio.mid * 0.8 + f.audio.lowMid * 0.4), 12, 2.6),
    v2: follow((f) => clamp01(f.audio.highMid * 0.7 + f.audio.air * 0.6), 12, 2.6),
    // how far colour has spread from the trunks: gathers in a build, jumps on the drop, drains in a break
    flood: follow(
      (f) => clamp01(Math.max(clamp01((f.audio.energy - 0.25) / 0.55) * 0.8 * (1 - 0.7 * Math.max(f.audio.build, f.feel.tension)), f.audio.drop * 1.2)),
      6,
      0.7,
      0.05,
    ),
    sinceDrop: {
      init: 100,
      step: (v, f, _s, mem) => {
        const d = f.audio.drop;
        const edge = d > 0.6 && (mem.dropPrev ?? 0) <= 0.6;
        mem.dropPrev = d;
        return edge ? 0 : Math.min(v + f.dt, 100);
      },
    },
    kickN: kickCountClock,
    ...kickSlot(0),
    ...kickSlot(1),
    ...kickSlot(2),
    ...kickSlot(3),
    snareN: counter((f) => f.audio.snareHit),
    hatN: counter((f) => f.audio.hatHit),
  },
);
