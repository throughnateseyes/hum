/**
 * Compact instructions for an LLM writing new Hum shader scenes (used in the AI director's
 * system prompt). Keep in sync with src/core/glsl.ts.
 */
export const SHADER_AUTHORING_GUIDE = `# Writing a Hum shader scene

You write ONE full-screen GLSL fragment shader: just helper functions (optional) and \`void main()\`. Write it WebGL1-style: \`texture2D(...)\`, \`gl_FragColor = vec4(col, 1.0)\`. The engine prepends the header, uniforms, a common library and one uniform per param, and compiles it as GLSL ES 3.00 (WebGL2), so \`fwidth\`/\`dFdx\` work.

## Already declared (never redeclare)
- \`varying vec2 vUv\` — 0..1, origin bottom-left. \`gl_FragCoord.xy\` = pixel coords.
- \`uResolution\` (vec2 px), \`uTime\` (seconds, always advances, also when paused), \`uAspect\` (w/h).
- Audio, 0..1 and already smoothed: \`uLevel, uSub, uBass, uLowMid, uMid, uHighMid, uAir\` (bands); \`uKick, uSnare, uHat\` (hit envelopes: jump to 1, decay); \`uEnergy\` (slow section intensity), \`uBrightness\`, \`uFlux\`, \`uBuild\` (rises in build-ups), \`uDrop\` (fires on a drop, decays), \`uBeatPhase\` (0→1 sawtooth per beat), \`uSway\` (-1..1 slow sine per bar), \`uBeat\` (1.0 only on a beat frame), \`uBeatCount\`, \`uBpm\`.
- \`uSpectrum\`, \`uWaveform\` samplers (use the functions below).
- Palette: \`vec3 uBg, uFg, uAccent, uAccent2, uMuted\`. ALL colours must come from these (mix/scale them). Palettes can be light (cream bg, dark fg) or dark; look good on both.
- \`uImage, uImage2\` (sampler2D) with \`uImageSize, uImage2Size\` (vec2 px), \`uPhotoIndex\` — current/next photo.
- \`tPrev\` (sampler2D): your own previous frame. Referencing \`tPrev\` turns feedback on automatically. It starts empty (alpha 0): guard with \`prev.a > 0.5 ? prev.rgb : uBg\`, and always output alpha 1.0.
- One uniform per param: \`u_<paramId>\` — number, bool (0/1) and select (option index) are \`float\`, color is \`vec3\`. A param \`{ "id": "density" }\` is read as \`u_density\`. Param values arrive already modulated by the user's audio routings.

## Library (call, never redefine)
\`\`\`
float hash11(float); float hash21(vec2); vec2 hash22(vec2);      // 0..1
float vnoise(vec2);                         // value noise 0..1
float snoise(vec2); float snoise(vec3);     // simplex -1..1
float fbm(vec2 p, int oct); float fbm3(vec3 p, int oct);  // ~-1..1, oct <= 8
float luma(vec3); mat2 rot2(float a);
vec3 cosPalette(float t, vec3 a, vec3 b, vec3 c, vec3 d);
vec3 paletteRamp(float t);                  // uBg → uAccent → uAccent2 → uFg
float spectrum(float x);                    // 0..1, x 0..1 low → high
float waveform(float x);                    // -1..1
vec2 coverUv(vec2 uv, vec2 texSize, float aspect);   // object-fit: cover
vec2 containUv(vec2 uv, vec2 texSize, float aspect);
float sdBox(vec2 p, vec2 b); float sdCircle(vec2 p, float r);
float bayer8(vec2 fragCoord);               // ordered-dither threshold 0..1
PI, TAU                                     // #defines
\`\`\`
Name your own helpers distinctly (e.g. prefix \`my\`) so nothing collides.

## Rules / pitfalls
- No \`#version\`, no \`precision\` line, no \`uniform\`/\`varying\` declarations, no \`#extension\`. Don't redefine library functions or PI/TAU.
- Float literals need a dot: \`1.0\`, \`0.5\`, never \`1\` in float math. No implicit int↔float: write \`float(i)\`, \`int(u_steps)\`.
- Loops need constant bounds: \`for (int i = 0; i < 8; i++) { if (float(i) >= u_count) break; ... }\`.
- No recursion. Declare functions above their use. Arrays only with constant size.
- Don't use reserved/built-in names as variables: \`texture\`, \`sample\`, \`input\`, \`output\`, \`filter\`, \`smooth\`, \`flat\`, \`layout\`, \`active\`, \`cross\`, \`dot\`, \`step\`, \`mix\`, \`length\`, \`distance\`, \`cameraPosition\`, \`viewMatrix\`.
- Never multiply uTime by an audio value (\`uTime * uBass\`): the phase jumps every time the level changes. Use \`uTime * speedParam\` and ADD audio as offsets or amplitudes (\`sin(x + uTime * 0.5) * (0.2 + uBass)\`).
- Keep it cheap: 60 fps at 4K device pixels. Under ~30 noise calls per pixel; raymarch ≤ 64 steps.
- Correct aspect: \`vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);\`
- Scale pixel-sized details with \`max(1.0, uResolution.y / 1080.0)\`.
- Silence must look beautiful (slow idle motion from uTime/uSway). Music must be felt: bands → size/displacement/density; uKick/uSnare/uHat → impulses, flashes, ripples (radius \`(1.0 - uKick)\` works as "time since hit"); uEnergy/uBuild/uDrop → section-level changes.
- smoothstep needs edge0 < edge1 (reversed edges are undefined): write \`1.0 - smoothstep(a, b, x)\`.
- Clamp the final colour; add a little grain (\`hash21(gl_FragCoord.xy + fract(uTime) * 100.0) - 0.5\`) to stop banding.

## Params
4–8 number params with sensible min/max/default, e.g. \`{ "id": "scale", "label": "Scale", "type": "number", "min": 0.5, "max": 4, "step": 0.01, "default": 1.5 }\`. Optional \`modulations\`: \`{ "source": "bass", "param": "scale", "amount": 0.2 }\` (amount is a fraction of the param's range).

## Example 1 — pulsing rings (params: density, thickness)
\`\`\`glsl
void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  p *= 1.0 - 0.15 * uKick;                                  // kick punches in
  float r = length(p);
  float a = atan(p.y, p.x);
  float wob = spectrum(fract(a / TAU + 0.5)) * 0.08 * (0.5 + uMid);
  float v = sin((r + wob) * u_density - uTime * 1.5 - uBass * 2.0);
  float px = u_density / uResolution.y * 2.0;
  float ring = 1.0 - smoothstep(u_thickness, u_thickness + px, abs(v));
  vec3 col = mix(uBg, uFg, ring * 0.85);
  col = mix(col, uAccent, ring * (1.0 - smoothstep(0.0, 0.5, r)) * (0.3 + uEnergy));
  col += uAccent2 * exp(-r * 6.0) * uKick * 0.5;
  col += (hash21(gl_FragCoord.xy + fract(uTime) * 100.0) - 0.5) * 0.04;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
\`\`\`

## Example 2 — feedback smoke (params: speed, decay, swirl)
\`\`\`glsl
void main() {
  vec2 uv = vUv;
  vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
  float n = snoise(vec3(p * 2.5, uTime * u_speed));
  vec2 flow = vec2(cos(n * TAU), sin(n * TAU)) * (0.6 + uBass) * 0.002 * u_swirl;
  vec4 prev = texture2D(tPrev, uv - flow - vec2(0.0, 0.0015));
  vec3 hist = prev.a > 0.5 ? prev.rgb : uBg;
  hist = mix(uBg, hist, u_decay);                           // fade toward background
  float src = 1.0 - smoothstep(0.0, 0.12 + 0.1 * uKick, length(p - vec2(0.3 * uSway, -0.3)));
  vec3 ink = mix(uAccent, uAccent2, uHat);
  vec3 col = mix(hist, ink, src * (0.3 + 0.7 * uLevel));
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
\`\`\`
Return only the shader source for the fragment field: helper functions + main, nothing else.`;
