/**
 * Shared bits for the snow looks (src/scenes/snow/*).
 */

/**
 * A procedural snowflake design: six-fold (mirror twelve-fold) distance field in the unit disc, so
 * every seed is a different crystal. Types run from plates to dendrites, and `bias` (0 plates … 1
 * dendrites) tilts which ones a seed picks, so the weather of the song can change what falls:
 *
 *   sectored plate · stellar plate (broad arms) · plate with branched arms · needle star ·
 *   stellar dendrite · fern dendrite
 *
 * flakeSDF(p, seed, bias, forceType) (forceType −1 = let the seed pick) returns x = signed distance (negative inside; the flake reaches radius ~1),
 * y = ridge height 0..1 (centre lines of arms and branches, growth rings, plate rims).
 * Needs the prelude (hash11).
 */
export const FLAKE_LIB = /* glsl */ `
float fkH(float s, float i) { return hash11(s * 7.13 + i * 1.731 + 0.37); }
float fkSeg(vec2 p, vec2 a, vec2 dir, float len, float w0, float w1, out float cl) {
  vec2 pa = p - a;
  float t = clamp(dot(pa, dir), 0.0, len);
  float dd = length(pa - dir * t);
  float w = mix(w0, w1, t / max(len, 1e-4));
  cl = 1.0 - smoothstep(0.0, w * 0.55 + 0.003, dd);
  return dd - w;
}
vec2 flakeSDF(vec2 p, float sd, float bias, float forceType) {
  float r = length(p);
  float a = atan(p.y, p.x);
  float a6 = mod(a + 0.5235988, 1.0471976) - 0.5235988;
  float af = abs(a6);
  vec2 q = r * vec2(cos(af), sin(af));

  // type: 0 sectored plate, 1 stellar plate, 2 plate + branched arms, 3 needle star, 4 stellar dendrite, 5 fern
  float u = fkH(sd, 0.0);
  float type = forceType >= 0.0 ? forceType : floor(clamp(u * 0.78 + bias * 0.42 - 0.12, 0.0, 0.999) * 6.0);
  float h1 = fkH(sd, 1.0), h2 = fkH(sd, 2.0), h3 = fkH(sd, 3.0), h4 = fkH(sd, 4.0), h5 = fkH(sd, 5.0);
  float L = 0.9 + 0.1 * h1;
  float P = 0.0, w0 = 0.03, w1 = 0.02, bl = 0.0, bw = 0.015, tip = 0.0, ring = 0.0, notch = 0.0, sec = 0.0, x0 = 0.12;
  int K = 0;
  float env = 0.0;
  if (type < 0.5) { P = 0.8 + 0.15 * h2; w0 = 0.02; w1 = 0.02; ring = 0.7; notch = 0.05 + 0.08 * h3; L = P; }
  else if (type < 1.5) { P = 0.18 + 0.12 * h2; w0 = 0.07 + 0.04 * h3; w1 = 0.16 + 0.1 * h4; ring = 0.6; K = int(2.0 + 2.0 * h5); bl = 0.1; bw = 0.02; x0 = P + 0.05; }
  else if (type < 2.5) { P = 0.3 + 0.15 * h2; w0 = 0.035; w1 = 0.025; ring = 0.8; K = int(3.0 + 3.0 * h3); bl = 0.22 + 0.15 * h4; bw = 0.022; tip = h5 > 0.4 ? 0.07 + 0.05 * h1 : 0.0; x0 = P + 0.06; env = 2.0; }
  else if (type < 3.5) { P = 0.1; w0 = 0.022; w1 = 0.012; K = int(1.0 + 2.0 * h2); bl = 0.12 + 0.1 * h3; bw = 0.014; tip = h4 > 0.5 ? 0.06 : 0.0; sec = 0.45 + 0.35 * h5; x0 = 0.55; env = 1.0; }
  else if (type < 4.5) { P = 0.06 + 0.1 * h2; w0 = 0.032; w1 = 0.022; K = int(4.0 + 4.0 * h3); bl = 0.3 + 0.2 * h4; bw = 0.024; tip = h5 > 0.55 ? 0.08 : 0.0; x0 = 0.12 + P; env = 0.0; }
  else { P = 0.05; w0 = 0.024; w1 = 0.014; K = int(9.0 + 3.0 * h3); bl = 0.2 + 0.18 * h4; bw = 0.013; x0 = 0.1; env = 1.0; }

  float d = 1e3;
  float ridge = 0.0;
  // the main arm, with a pointed (60°) tip
  float wq = mix(w0, w1, clamp(q.x / L, 0.0, 1.0));
  d = min(d, max(q.y - wq, q.x + q.y * 0.577 - L));
  ridge = max(ridge, (1.0 - smoothstep(0.0, wq * 0.45 + 0.003, q.y)) * step(q.x, L));
  // the central plate: a hexagon with its corners on the arms
  float hexR = dot(q, vec2(0.8660254, 0.5)) / 0.8660254;
  if (P > 0.0) {
    float dP = (hexR - P) * 0.8660254;
    dP += notch * (1.0 - smoothstep(0.0, 0.12, 0.5235988 - af)) * smoothstep(P * 0.35, P, r);
    d = min(d, dP);
    ridge = max(ridge, ring * exp(-pow((hexR - P * 0.55) / 0.014, 2.0)));
    ridge = max(ridge, 0.75 * exp(-pow((hexR - P + 0.025) / 0.01, 2.0)) * step(hexR, P));
    // a sectored plate: ribs at 60° off each arm, out to the plate's edge
    if (type < 0.5) {
      float fr = 4.0 + 3.0 * h4;
      float s60 = q.x - q.y * 0.577;
      float rib = abs(fract(s60 * fr) - 0.5) / fr * 0.866;
      ridge = max(ridge, 0.3 * (1.0 - smoothstep(0.0, 0.01, rib)) * step(hexR, P - 0.03) * step(0.1, s60));
    }
  }
  // side branches at 60° off the arm
  float cl;
  for (int k = 0; k < 12; k++) {
    if (k >= K) break;
    float fk = (float(k) + 0.5) / float(K);
    float xk = mix(x0, L * 0.93, fk) + (fkH(sd, 10.0 + float(k)) - 0.5) * 0.03;
    float e = env < 0.5 ? sin(fk * 3.14159) : env < 1.5 ? 1.0 - 0.75 * fk : 0.35 + 0.65 * fk;
    float lk = bl * e * (0.75 + 0.25 * fkH(sd, 30.0 + float(k)));
    lk = min(lk, (L - xk) * 1.15 + 0.04);
    d = min(d, fkSeg(q, vec2(xk, 0.0), vec2(0.5, 0.8660254), lk, bw, bw * 0.45, cl));
    ridge = max(ridge, cl * 0.8);
  }
  // little plates on the tips
  if (tip > 0.0) {
    vec2 aq = abs(q - vec2(L * 0.97, 0.0));
    float dT = max(aq.x * 0.8660254 + aq.y * 0.5, aq.y) - tip * 0.8660254;
    d = min(d, dT);
    ridge = max(ridge, 0.6 * exp(-pow(dT / 0.012 + 1.2, 2.0)));
  }
  // shorter needles between the arms (a twelve-pointed star)
  if (sec > 0.0) {
    float as = 0.5235988 - af;
    vec2 sq = r * vec2(cos(as), sin(as));
    d = min(d, max(sq.y - w1 * 0.8, sq.x + sq.y * 0.577 - L * sec));
    ridge = max(ridge, (1.0 - smoothstep(0.0, 0.006, sq.y)) * step(sq.x, L * sec));
  }
  // the hub
  d = min(d, (hexR - 0.06) * 0.8660254);
  return vec2(d, ridge);
}
`;

/** a phone or tablet: grow smaller crystals, draw fewer flakes */
export function isCoarse(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
}

/**
 * Soft, out-of-focus snow over a picture (linear light). `nearL` 0 = far layers (small, many, behind
 * the subject), 1 = near layers (a few big soft discs in front). `t` is the fall travel (integrated by
 * the scene so gusts speed it up without jumps), `wind` the shared wind direction. Needs the prelude.
 */
export const SNOW_LIB = /* glsl */ `
vec3 snowLayers(vec3 col, vec2 uv, float t, float nearL, float amt, vec3 light, float aspect, vec2 wind) {
  if (amt <= 0.0) return col;
  bool nearOn = nearL > 0.5;
  for (int L = 0; L < 3; L++) {
    if (nearOn && L == 2) break;
    float fl = float(L);
    float sc = nearOn ? 2.0 + fl * 1.7 : 6.5 + fl * 5.0;
    float spd = nearOn ? 0.26 - fl * 0.05 : 0.1 - fl * 0.025;
    vec2 p = vec2(uv.x * aspect, uv.y) * sc;
    p.y += t * spd * sc;
    p.x -= wind.x * t * spd * sc * 0.7;
    vec2 id = floor(p);
    vec2 fp = fract(p);
    vec2 h = hash22(id + fl * 17.0 + nearL * 31.0);
    float present = step(nearOn ? 0.62 : 0.3, hash21(id * 1.7 + fl + nearL * 5.0));
    vec2 c = nearOn ? 0.32 + 0.36 * h : 0.25 + 0.5 * h;
    c.x += (nearOn ? 0.05 : 0.08) * sin(t * (1.1 + h.y) * 2.0 + h.y * 6.28);
    float r = nearOn ? 0.25 : 0.06 + 0.1 * h.x;
    vec2 dv = (fp - c) / r;
    // out-of-focus discs keep a hint of the lens's hexagonal aperture
    vec2 ad = abs(dv);
    float d = mix(length(dv), max(ad.x * 0.866 + ad.y * 0.5, ad.y), 0.35);
    float soft = nearOn ? 0.9 : 0.45 + 0.4 * h.y;
    float a = (1.0 - smoothstep(1.0 - soft, 1.0, d)) * present;
    // a brighter rim on the bokeh, like a real lens
    a *= 0.75 + 0.35 * smoothstep(0.5, 0.95, d);
    float br = (nearOn ? 0.09 : 0.32 - fl * 0.08) * amt;
    col += light * a * br;
  }
  return col;
}
`;
