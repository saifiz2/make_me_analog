/*
 * Analog Brick — "Night" visual mode (id "night").
 *
 * A slowly turning night sky above a dark hillside.
 *
 * Geometry. The celestial pole sits just above the top edge of the screen. The sky is an
 * azimuthal-equidistant projection around that pole ("sky plane", in screen heights), so
 * the whole sky turns rigidly about the pole at OMEGA (2° per minute, counter-clockwise as
 * when facing north). The galactic plane is a great circle that passes a few degrees from
 * the pole: on screen it is a softly curved band that swings across the view like a slow
 * clock hand, its bright core rising over the treeline.
 *
 * Rendering (WebGL1, GLSL ES 1.00):
 *   0. bakes, on create/resize only:
 *      • Milky Way — glow, star clouds and dust lanes evaluated in galactic coordinates on
 *        the sphere (seamless 3D noise) into a sky-fixed square texture that covers every
 *        point that can ever be on screen. RGB = glow (gamma-encoded), A = dust transmission.
 *        Octaves finer than ~3 texels are faded out so the rotating texture never shimmers.
 *      • Foreground — far ridge, wooded hills and a lone tree, analytic coverage, stored as a
 *        premultiplied screen-fixed texture covering the bottom FG_FRAC of the canvas.
 *   1. one full-screen pass per frame: sky gradient + airglow (screen-fixed), the rotated
 *      Milky Way lookup, five star layers, the occasional meteor, foreground, tonemap,
 *      gamma, triangular dither.
 *
 * Stars. Each star is an analytic, smoothly windowed gaussian (σ ≥ 0.62 canvas px) placed
 * in jittered grid cells of the rotated sky plane, so every star moves rigidly and its pixel
 * footprint never sparkles. Five cell scales give a realistic magnitude distribution
 * (intensities drawn from a Pareto law, N(>I) ∝ I^-1.25: many faint, few bright). The two
 * faint layers evaluate the 2×2 nearest cells with full jitter (no visible lattice); the
 * sparse bright layers use a single cell with a margin that fits the star's halo. Faint
 * stars gather in the Milky Way and vanish into its dust lanes.
 *
 * Seed (per display) changes the star field, the band's angle, the hills and the meteor
 * schedule, so displays differ subtly while keeping the same mood.
 */
(function () {
  'use strict';

  var BV = window.BrickVisuals;
  if (!BV) return;

  var HEADER = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    ''
  ].join('\n');

  var OMEGA = (2 * Math.PI / 180) / 60;  // sky rotation: 2° per minute, in rad/s
  var SKY_K = 0.96;                      // radians of sky per screen height
  var POLE_UP = 0.055;                   // the pole sits this far (screen heights) above the top edge
  var FG_FRAC = 0.36;                    // the foreground texture covers the bottom 36% of the screen
  var SMALL_REF = 560;                   // css px; below this height the star field is miniaturised
  var PSF_CSS = 0.46;                    // natural star sigma, css px
  var SIG_MIN = 0.62;                    // minimum star sigma, canvas px (anti-sparkle)

  // Per-quality budgets for the Milky Way bake (texels per canvas px, max size).
  var Q = {
    saver:    { mwRes: 0.7, mwMax: 1536 },
    balanced: { mwRes: 0.9, mwMax: 2048 },
    high:     { mwRes: 1.0, mwMax: 2048 }
  };

  // Star layers: cell (star px), probability, intensity range, halo.
  //   faint layers (2×2): dust, faint.  single-cell layers: mid, bright, brilliant.
  var LAYERS = {
    dust:      { cell: 13,  prob: 0.85, iMin: 0.010, iMax: 0.05 },
    faint:     { cell: 21,  prob: 0.72, iMin: 0.035, iMax: 0.22 },
    mid:       { cell: 54,  prob: 0.62, iMin: 0.18,  iMax: 0.9 },
    bright:    { cell: 150, prob: 0.55, iMin: 0.7,   iMax: 2.4 },
    brilliant: { cell: 400, prob: 0.42, iMin: 2.0,   iMax: 4.5 }
  };
  function uMinOf(L) { return Math.pow(L.iMax / L.iMin, -1.25); }

  // ───────────────────────── bake: Milky Way ─────────────────────────
  var MW_FS = [
    'varying vec2 v_uv;',
    'uniform float uR;         // half-size of the baked square, screen heights',
    'uniform float uK;         // radians of sky per screen height',
    'uniform vec3 uNGP;        // north galactic pole (celestial frame, z = pole)',
    'uniform vec3 uGC;         // galactic centre direction',
    'uniform vec3 uE2;         // completes the galactic frame',
    'uniform float uRift;      // +1/-1: the side of the core the Great Rift runs to',
    'uniform vec3 uOff;        // noise offset (seed)',
    'uniform float uTexRad;    // radians per texel (octave LOD)',
    '',
    '// fbm on the sphere; octaves finer than ~3 texels fade out (no shimmer once rotated)',
    'float fbmL(vec3 p, float f) {',
    '  float s = 0.0, a = 0.5;',
    '  for (int i = 0; i < 6; i++) {',
    '    float lod = 1.0 - smoothstep(0.10, 0.26, f * uTexRad);',
    '    if (lod <= 0.0) break;',
    '    s += a * lod * snoise(p * f);',
    '    f *= 2.03; a *= 0.5;',
    '    p += vec3(17.13, 3.71, 9.27);',
    '  }',
    '  return s;',
    '}',
    'float ridgedL(vec3 p, float f) {',
    '  float s = 0.0, a = 0.5;',
    '  for (int i = 0; i < 4; i++) {',
    '    float lod = 1.0 - smoothstep(0.10, 0.26, f * uTexRad);',
    '    if (lod <= 0.0) break;',
    '    float n = 1.0 - abs(snoise(p * f));',
    '    s += a * lod * n * n;',
    '    f *= 2.1; a *= 0.55;',
    '    p += vec3(5.3, 11.7, 2.9);',
    '  }',
    '  return s;',
    '}',
    '',
    'void main() {',
    '  vec2 s = (v_uv * 2.0 - 1.0) * uR;',
    '  float r = length(s);',
    '  if (r > uR) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }',
    '  float rho = r * uK;',
    '  vec2 dir = s / max(r, 1e-6);',
    '  vec3 d = vec3(sin(rho) * dir, cos(rho));',
    '  float b = asin(clamp(dot(d, uNGP), -1.0, 1.0));',
    '  float l = atan(dot(d, uE2), dot(d, uGC));',
    '  if (abs(b) > 0.8) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }',
    '  vec3 p = d + uOff;',
    '',
    '  // the band meanders a little and breathes in width',
    '  float w1 = fbmL(p, 1.6);',
    '  float bw = b + 0.05 * w1;',
    '  float lr = l * uRift;                       // > 0 toward the rift / the pole',
    '  float cosl = cos(l);',
    '  float lonF = 0.42 + 0.58 * smoothstep(-0.6, 1.0, cosl);',
    '  float wid = 0.085 * (1.0 + 0.25 * fbmL(p + 4.0, 1.1));',
    '  float thin = exp(-bw * bw / (wid * wid));',
    '  float thick = exp(-bw * bw / (0.26 * 0.26));',
    '  float bulge = exp(-l * l / (0.30 * 0.30) - bw * bw / (0.15 * 0.15));',
    '',
    '  // star clouds',
    '  float cl = fbmL(p, 6.0);',
    '  float clouds = 0.40 + 0.95 * smoothstep(-0.35, 0.55, cl);',
    '  float grain = fbmL(p + 9.0, 26.0);',
    '  float I = (0.62 * thin * clouds * (0.85 + 0.3 * grain) + 0.20 * thick * (0.75 + 0.35 * cl)) * lonF;',
    '  I += 1.05 * bulge * (0.62 + 0.55 * smoothstep(-0.3, 0.6, cl)) * (0.9 + 0.2 * grain);',
    '',
    '  // dust: the Great Rift (from the core toward the pole), filaments, mottling',
    '  float riftB = 0.012 + 0.022 * snoise(p * 2.4 + 3.0);',
    '  float riftW = 0.020 + 0.012 * smoothstep(-0.2, 0.8, lr);',
    '  float rz = (bw - riftB) / riftW;',
    '  float rift = exp(-rz * rz);',
    '  rift *= smoothstep(-0.25, 0.10, lr) * (1.0 - smoothstep(1.2, 1.9, lr));',
    '  rift *= 0.45 + 0.75 * smoothstep(-0.4, 0.4, fbmL(p + 21.0, 3.2));',
    '  float fil = ridgedL(p + 13.0 + 0.4 * w1, 7.0);',
    '  fil = smoothstep(0.35, 0.75, fil) * exp(-bw * bw / (0.14 * 0.14));',
    '  float mott = smoothstep(0.0, 0.55, fbmL(p + 33.0, 11.0)) * thin;',
    '  float tau = 1.9 * rift + 1.1 * fil + 0.75 * mott;',
    '  float T = exp(-tau);',
    '',
    '  // colour: cool silver along the disc, warm ivory in the bulge, dust-reddened edges',
    '  vec3 cool = vec3(0.80, 0.86, 1.00);',
    '  vec3 warm = vec3(1.00, 0.84, 0.62);',
    '  float wk = clamp(bulge * 1.5 + 0.45 * (1.0 - T) + 0.15 * thick, 0.0, 1.0);',
    '  vec3 col = mix(cool, warm, wk);',
    '  vec3 mw = col * I * T * 0.040;',
    '  gl_FragColor = vec4(pow(mw, vec3(1.0 / 2.2)) + (hash12(gl_FragCoord.xy) - 0.5) / 255.0, T);',
    '}'
  ].join('\n');

  // ───────────────────────── bake: foreground ─────────────────────────
  var FG_FS = [
    'varying vec2 v_uv;',
    'uniform float uAspect;',
    'uniform float uFgH;       // fraction of the screen height this texture covers',
    'uniform float uPx;        // screen heights per canvas px',
    'uniform vec4 uSeed;',
    'uniform float uSide;      // +1: the lone tree stands right of centre, -1: left',
    '',
    'float farRidge(float x) {',
    '  float n = 0.078 + 0.030 * snoise(vec2(x * 0.75 + uSeed.x, 1.3));',
    '  n += 0.012 * snoise(vec2(x * 2.2 + uSeed.x, 4.1));',
    '  n += 0.0035 * snoise(vec2(x * 7.5 + uSeed.x, 7.7));',
    '  n += 0.0010 * snoise(vec2(x * 23.0 + uSeed.x, 2.2));',
    '  return n;',
    '}',
    'float sq(float x) { return x * x; }',
    'float hills(float x) {',
    '  float xc = uSide * 0.30 * uAspect;',
    '  float h = 0.026 + 0.006 * snoise(vec2(x * 1.7 + uSeed.y, 2.0));',
    '  h += 0.072 * exp(-sq((x - xc) / 0.30));',
    '  h += 0.062 * exp(-sq((x + xc * 1.3) / 0.40));',
    '  h += 0.0025 * snoise(vec2(x * 6.0 + uSeed.y, 5.0));',
    '  return h;',
    '}',
    '',
    'float conifer(vec2 p, float cx, float base, float th, float px, float r) {',
    '  float rel = (p.y - base) / th;',
    '  if (rel < 0.0 || rel > 1.0) return 0.0;',
    '  float tiers = rel * (7.0 + 5.0 * r) + r * 3.0;',
    '  float saw = fract(tiers);',
    '  float jag = 0.8 + 0.4 * hash11(floor(tiers) + r * 91.0);',
    '  float prof = 0.62 + 0.38 * (1.0 - saw) * smoothstep(0.0, 0.15, saw);',
    '  float w = th * (0.12 + 0.06 * r) * pow(1.0 - rel, 1.15) * prof * jag + th * 0.008;',
    '  return clamp((w - abs(p.x - cx)) / px + 0.5, 0.0, 1.0);',
    '}',
    '',
    'float trees(vec2 p, float px) {',
    '  float xc = uSide * 0.30 * uAspect;',
    '  float cw = 0.016;',
    '  float ci = floor(p.x / cw);',
    '  float cov = 0.0;',
    '  for (int k = -3; k <= 3; k++) {',
    '    float id = ci + float(k);',
    '    float cx = (id + 0.5 + (hash11(id * 2.11 + uSeed.z) - 0.5) * 0.8) * cw;',
    '    // forest on the far-side hill, sparse elsewhere, a clear crest around the lone tree',
    '    float forest = exp(-sq((cx + xc * 1.3) / 0.36));',
    '    float dens = 0.10 + 0.85 * forest;',
    '    dens *= 1.0 - exp(-sq((cx - xc) / 0.16));',
    '    if (hash11(id * 1.37 + uSeed.z) > dens) continue;',
    '    float hr = hash11(id * 3.7 + 1.0 + uSeed.z);',
    '    float th = (0.022 + 0.055 * pow(hr, 1.4)) * (0.55 + 0.6 * forest);',
    '    float base = hills(cx) - 0.004;',
    '    cov = max(cov, conifer(p, cx, base, th, px, hash11(id * 5.3 + uSeed.z)));',
    '  }',
    '  return cov;',
    '}',
    '',
    'float sdCapsule(vec2 p, vec2 a, vec2 b, float ra, float rb) {',
    '  vec2 pa = p - a, ba = b - a;',
    '  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);',
    '  return length(pa - ba * h) - mix(ra, rb, h);',
    '}',
    '',
    '// A lone broadleaf tree on the crest: trunk, a few limbs, a leafy crown of blobs.',
    'float loneTree(vec2 p, float px) {',
    '  float xc = uSide * 0.30 * uAspect + uSide * 0.02;',
    '  float g = hills(xc);',
    '  vec2 q = p - vec2(xc, g);',
    '  if (abs(q.x) > 0.12 || q.y < -0.01 || q.y > 0.16) return 0.0;',
    '  float d = sdCapsule(q, vec2(0.0, -0.01), vec2(0.003, 0.048), 0.0042, 0.0028);',
    '  d = min(d, sdCapsule(q, vec2(0.003, 0.040), vec2(-0.026, 0.074), 0.0022, 0.0012));',
    '  d = min(d, sdCapsule(q, vec2(0.003, 0.044), vec2(0.030, 0.080), 0.0020, 0.0011));',
    '  d = min(d, sdCapsule(q, vec2(0.002, 0.046), vec2(0.004, 0.094), 0.0018, 0.0010));',
    '  float c = 1e3;',
    '  for (int i = 0; i < 7; i++) {',
    '    float fi = float(i);',
    '    vec2 h = hash22(vec2(fi * 3.1 + uSeed.w, 7.7));',
    '    float a = (fi / 6.0 - 0.5) * 2.4 + (h.x - 0.5) * 0.3;',
    '    vec2 c0 = vec2(sin(a) * 0.050, 0.086 + cos(a) * 0.026 + (h.y - 0.5) * 0.012);',
    '    float r = 0.021 + 0.010 * h.y + 0.006 * (1.0 - abs(fi / 6.0 - 0.5) * 2.0);',
    '    c = min(c, length(q - c0) - r);',
    '  }',
    '  // leafy edge and a few small gaps where the sky shows through',
    '  float leaf = snoise(q * 140.0 + uSeed.w) * 0.5 + snoise(q * 300.0 - uSeed.w) * 0.25;',
    '  c += 0.0035 * leaf;',
    '  float gaps = snoise(q * 70.0 + 3.0 + uSeed.w);',
    '  c = max(c, -(0.006 - 0.010 * smoothstep(0.55, 0.85, gaps)));',
    '  d = min(d, c);',
    '  return clamp(0.5 - d / px, 0.0, 1.0);',
    '}',
    '',
    'void main() {',
    '  float x = (v_uv.x - 0.5) * uAspect;',
    '  float y = v_uv.y * uFgH;',
    '  float px = uPx;',
    '  float hf = farRidge(x);',
    '  float cf = clamp((hf - y) / px + 0.5, 0.0, 1.0);',
    '  float hn = hills(x);',
    '  float cn = clamp((hn - y) / px + 0.5, 0.0, 1.0);',
    '  if (cn < 1.0 && y < hn + 0.09) cn = max(cn, trees(vec2(x, y), px));',
    '  if (cn < 1.0) cn = max(cn, loneTree(vec2(x, y), px));',
    '  // the far ridge is lifted by haze toward its crest; the near land is nearly black',
    '  vec3 farCol = vec3(0.0021, 0.0026, 0.0040) * (0.70 + 0.45 * smoothstep(hf - 0.07, hf, y));',
    '  vec3 nearCol = vec3(0.00050, 0.00058, 0.00080);',
    '  vec3 pre = nearCol * cn + farCol * cf * (1.0 - cn);',
    '  float a = cn + cf * (1.0 - cn);',
    '  gl_FragColor = vec4(pow(pre, vec3(1.0 / 2.2)) + (hash12(gl_FragCoord.xy + 5.0) - 0.5) / 255.0, a);',
    '}'
  ].join('\n');

  // ───────────────────────── per frame: sky ─────────────────────────
  var MAIN_FS = [
    'varying vec2 v_uv;',
    'uniform sampler2D uMW;',
    'uniform sampler2D uFG;',
    'uniform float uAspect;',
    'uniform vec2 uPole;       // pole position, screen heights (x from centre, y from bottom)',
    'uniform vec2 uRot;        // cos, sin of the sky rotation angle',
    'uniform float uMWScale;   // 1 / (2 × baked half-size)',
    'uniform float uStarScale; // star px per screen height',
    'uniform float uStarPx;    // canvas px per star px',
    'uniform float uPsf;       // natural star sigma, canvas px',
    'uniform float uSigMin;    // minimum star sigma, canvas px',
    'uniform float uPeakFloor; // keeps undersized stars from vanishing on small canvases',
    'uniform float uFaintR2;   // early-out radius² for faint stars, canvas px²',
    'uniform vec4 uVis;        // layer visibility: dust, faint, mid, bright',
    'uniform vec2 uVis2;       // brilliant visibility, unused',
    'uniform vec3 uMargin;     // cell margins (fraction) for the mid, bright, brilliant layers',
    'uniform float uT;',
    'uniform float uFgH;',
    'uniform vec4 uMetA;       // meteor head (x, y), direction (x, y), screen heights',
    'uniform vec4 uMetB;       // meteor intensity, tail length, sigma (screen heights), unused',
    'uniform vec4 uSeed;       // star salt, airglow phase, glow x, unused',
    '',
    'float wnd(float d2, float r2) { float w = max(0.0, 1.0 - d2 / r2); return w * w; }',
    '',
    '// blue-white … white … yellow … orange, normalised to equal luminance',
    'vec3 tint(float h, float sat) {',
    '  vec3 c = mix(vec3(0.64, 0.76, 1.00), vec3(1.00, 0.96, 0.91), smoothstep(0.0, 0.30, h));',
    '  c = mix(c, vec3(1.00, 0.84, 0.62), smoothstep(0.62, 0.86, h));',
    '  c = mix(c, vec3(1.00, 0.66, 0.40), smoothstep(0.93, 1.0, h));',
    '  c /= dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '  return mix(vec3(1.0), c, sat);',
    '}',
    '',
    'float twinkle(float hA, float hB, float amp) {',
    '  return 1.0 + amp * (0.62 * sin(uT * (0.30 + 0.75 * hA) + 6.2831 * hB)',
    '                    + 0.38 * sin(uT * (0.85 + 0.6 * hB) + 6.2831 * hA));',
    '}',
    '',
    '// One star; dv = offset from its centre in canvas px; I = peak at the natural PSF.',
    'vec3 star(vec2 dv, float I, float hc, float tw) {',
    '  float sig0 = uPsf * (1.0 + 0.22 * log2(max(1.0, I * 2.5)));',
    '  float sig = max(sig0, uSigMin);',
    '  float pk = I * max(sig0 * sig0 / (sig * sig), uPeakFloor);',
    '  float d2 = dot(dv, dv);',
    '  float s2 = sig * sig;',
    '  float v = pk * exp(-0.5 * d2 / s2) * wnd(d2, 16.0 * s2);',
    '  if (I > 0.5) {',
    '    float sh = max(uPsf, 0.4) * 4.5 * (1.0 + 0.35 * log2(I + 1.0));',
    '    float h2 = sh * sh;',
    '    v += 0.028 * I * exp(-0.5 * d2 / h2) * wnd(d2, 9.0 * h2);',
    '  }',
    '  return tint(hc, clamp(0.25 + 0.45 * I, 0.0, 0.85)) * v * tw;',
    '}',
    '',
    '// Faint layers: the 2×2 nearest cells, star anywhere in its cell (no lattice).',
    'vec3 layer4(vec2 q, float cell, float prob, float iMin, float uMin, float salt, float twAmp) {',
    '  vec2 b = floor(q / cell - 0.5);',
    '  vec3 acc = vec3(0.0);',
    '  for (int j = 0; j < 2; j++) {',
    '    for (int i = 0; i < 2; i++) {',
    '      vec2 id = b + vec2(float(i), float(j));',
    '      float h = hash12(id + salt);',
    '      if (h < prob) {',
    '        vec2 dv = (q - (id + hash22(id + salt + 31.7)) * cell) * uStarPx;',
    '        if (dot(dv, dv) < uFaintR2) {',
    '          float hI = hash12(id + salt + 7.13);',
    '          float I = iMin * pow(mix(uMin, 1.0, hI), -0.8);',
    '          float hc = fract(h * 7.31 / prob);',
    '          acc += star(dv, I, hc, twinkle(hI, hc, twAmp));',
    '        }',
    '      }',
    '    }',
    '  }',
    '  return acc;',
    '}',
    '',
    '// Sparse layers: one cell, the star kept a margin away from the edges (fits its halo).',
    'vec3 layer1(vec2 q, float cell, float prob, float iMin, float uMin, float salt, float margin, float twAmp) {',
    '  vec2 g = q / cell;',
    '  vec2 id = floor(g);',
    '  float h = hash12(id + salt);',
    '  // constellations: bright stars clump a little',
    '  float pr = prob * (0.35 + 1.3 * smoothstep(-0.5, 0.7, snoise((id + 0.5) * cell * 0.0031 + salt)));',
    '  if (h >= pr) return vec3(0.0);',
    '  vec2 pos = margin + (1.0 - 2.0 * margin) * hash22(id + salt + 31.7);',
    '  vec2 dv = (g - id - pos) * cell * uStarPx;',
    '  float hI = hash12(id + salt + 7.13);',
    '  float I = iMin * pow(mix(uMin, 1.0, hI), -0.8);',
    '  float hc = hash12(id + salt + 3.37);',
    '  return star(dv, I, hc, twinkle(hI, hc, twAmp));',
    '}',
    '',
    LAYER_CALLS(),
    '',
    'vec3 meteor(vec2 P) {',
    '  vec2 d = P - uMetA.xy;',
    '  float along = -dot(d, uMetA.zw);              // distance behind the head',
    '  float L = uMetB.y;',
    '  if (along < -0.02 || along > L) return vec3(0.0);',
    '  float across = dot(d, vec2(-uMetA.w, uMetA.z));',
    '  float k = clamp(along / L, 0.0, 1.0);',
    '  float sg = uMetB.z * (1.0 + 0.9 * k);',
    '  float body = along >= 0.0 ? exp(-along / (L * 0.30)) * (1.0 - smoothstep(0.55, 1.0, k))',
    '                            : exp(-0.5 * along * along / (uMetB.z * uMetB.z));',
    '  float w = exp(-0.5 * across * across / (sg * sg)) * (uMetB.z / sg);',
    '  return vec3(0.84, 0.91, 1.0) * uMetB.x * body * w;',
    '}',
    '',
    'void main() {',
    '  vec2 P = vec2((v_uv.x - 0.5) * uAspect, v_uv.y);',
    '  vec4 fg = vec4(0.0);',
    '  if (v_uv.y < uFgH) fg = texture2D(uFG, vec2(v_uv.x, v_uv.y / uFgH));',
    '  vec3 col = vec3(0.0);',
    '  if (fg.a < 0.999) {',
    '    float y = P.y;',
    '    // sky: deep blue-black at the top, a little lighter and greener toward the horizon',
    '    float k = clamp((y - 0.06) / 0.94, 0.0, 1.0);',
    '    col = mix(vec3(0.0046, 0.0056, 0.0080), vec3(0.0011, 0.0014, 0.0030), pow(k, 0.5));',
    '    // airglow: a faint band above the hills, with slow travelling waves',
    '    float wave = 0.8 + 0.2 * snoise(vec2(P.x * 0.9 + uT * 0.0015 + uSeed.y, uT * 0.002));',
    '    col += vec3(0.0014, 0.0030, 0.0021) * exp(-max(y - 0.11, 0.0) / 0.10) * wave;',
    '    // warm haze hugging the horizon (stronger toward a distant town)',
    '    float tx = (P.x - uSeed.z) / 0.5;',
    '    float town = 0.6 + 0.6 * exp(-tx * tx);',
    '    col += vec3(0.0042, 0.0028, 0.0016) * exp(-max(y - 0.07, 0.0) / 0.045) * town;',
    '',
    '    // the turning sky',
    '    vec2 v = P - uPole;',
    '    vec2 s = vec2(uRot.x * v.x + uRot.y * v.y, -uRot.y * v.x + uRot.x * v.y);',
    '    vec4 mwT = texture2D(uMW, s * uMWScale + 0.5);',
    '    vec3 mw = pow(mwT.rgb, vec3(2.2));',
    '    float mwF = smoothstep(0.001, 0.028, dot(mw, vec3(0.3, 0.6, 0.1)));',
    '    float low = 1.0 - smoothstep(0.08, 0.42, y);',
    '    vec3 st = stars(s * uStarScale, mwF, mwT.a, 1.0 + 1.6 * low);',
    '    // atmospheric extinction and reddening toward the horizon',
    '    vec3 ext = mix(vec3(1.0), vec3(0.42, 0.34, 0.26), low * low);',
    '    col += (mw + st) * ext;',
    '    col += meteor(P);',
    '  }',
    '  col = col * (1.0 - fg.a) + pow(fg.rgb, vec3(2.2));',
    '  col = tonemap(col);',
    '  col = pow(col, vec3(1.0 / 2.2));',
    '  col += (hash12(gl_FragCoord.xy) + hash12(gl_FragCoord.xy + 71.3) - 1.0) / 255.0;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  function f(x) { var s = String(+x.toFixed(6)); return s.indexOf('.') < 0 && s.indexOf('e') < 0 ? s + '.0' : s; }

  // The stars() function, with each layer's constants baked in (and its grid rotated so
  // the lattices of different layers never line up).
  function LAYER_CALLS() {
    var D = LAYERS.dust, F = LAYERS.faint, M = LAYERS.mid, B = LAYERS.bright, X = LAYERS.brilliant;
    return [
      'vec3 stars(vec2 q, float mwF, float dustT, float twk) {',
      '  vec3 c = vec3(0.0);',
      '  if (uVis.x > 0.0) c += uVis.x * (0.04 + 2.6 * mwF) * dustT * layer4(q, ' + f(D.cell) + ', ' + f(D.prob) + ', ' + f(D.iMin) + ', ' + f(uMinOf(D)) + ', uSeed.x, 0.0);',
      '  vec2 q1 = mat2(0.8, 0.6, -0.6, 0.8) * q + vec2(71.3, 19.1);',
      '  if (uVis.y > 0.0) c += uVis.y * (0.6 + 0.9 * mwF) * mix(1.0, dustT, 0.75) * layer4(q1, ' + f(F.cell) + ', ' + f(F.prob) + ', ' + f(F.iMin) + ', ' + f(uMinOf(F)) + ', uSeed.x + 17.0, 0.05 * twk);',
      '  vec2 q2 = mat2(0.28, -0.96, 0.96, 0.28) * q + vec2(-13.7, 41.9);',
      '  if (uVis.z > 0.0) c += uVis.z * mix(1.0, dustT, 0.5) * layer1(q2, ' + f(M.cell) + ', ' + f(M.prob) + ', ' + f(M.iMin) + ', ' + f(uMinOf(M)) + ', uSeed.x + 29.0, uMargin.x, 0.07 * twk);',
      '  vec2 q3 = mat2(-0.6, 0.8, -0.8, -0.6) * q + vec2(311.0, -97.0);',
      '  if (uVis.w > 0.0) c += uVis.w * mix(1.0, dustT, 0.3) * layer1(q3, ' + f(B.cell) + ', ' + f(B.prob) + ', ' + f(B.iMin) + ', ' + f(uMinOf(B)) + ', uSeed.x + 43.0, uMargin.y, 0.08 * twk);',
      '  vec2 q4 = mat2(0.96, 0.28, -0.28, 0.96) * q + vec2(-517.0, 233.0);',
      '  if (uVis2.x > 0.0) c += uVis2.x * layer1(q4, ' + f(X.cell) + ', ' + f(X.prob) + ', ' + f(X.iMin) + ', ' + f(uMinOf(X)) + ', uSeed.x + 59.0, uMargin.z, 0.08 * twk);',
      '  return c;',
      '}'
    ].join('\n');
  }

  // ───────────────────────── small vector helpers ─────────────────────────
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { var l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

  BV.register({
    id: 'night',
    name: 'Night',
    tagline: 'A slowly turning sky, the odd shooting star',
    order: 50,
    context: 'webgl',
    renderScale: { saver: 0.5, balanced: 0.7, high: 0.9 },
    musicReactive: false,

    create: function (env) {
      var gl = env.gl;
      var U = env.util, G = U.gl;
      var lib = U.glsl.common + '\n' + U.glsl.noise + '\n';

      var rand = U.mulberry32(Math.imul((env.seed | 0) + 11, 0x9E3779B1) ^ 0x5bd1e995);
      var S = {
        salt: 10 + rand() * 300,
        theta0: (-33 + (rand() - 0.5) * 10) * Math.PI / 180,   // band starts down-left of the pole
        poleX: (rand() - 0.5) * 0.10,
        coreR: 0.84 + rand() * 0.05,                            // core distance from the pole (screen heights)
        nearPole: (6 + rand() * 5) * Math.PI / 180,              // galactic plane passes this close to the pole
        off: [rand() * 40, rand() * 40, rand() * 40],
        fg: [rand() * 100, rand() * 100, rand() * 100, rand() * 100],
        side: (env.seed | 0) % 2 === 0 ? -1 : 1,
        glowX: (rand() - 0.5) * 1.2,
        airPhase: rand() * 50,
        timeOff: rand() * 400,
        meteorSeed: (rand() * 4294967296) >>> 0
      };

      // Galactic frame in the celestial frame (z = pole; sky-plane x/y at rotation 0).
      // The core sits straight "below" the pole at rotation 0; theta0 swings it down-left.
      var rc = S.coreR * SKY_K;
      var gc = [0, -Math.sin(rc), Math.cos(rc)];
      var pn = [Math.sin(S.nearPole), 0, Math.cos(S.nearPole)];
      var ngp = norm(cross(gc, pn));
      var e2 = cross(ngp, gc);
      var riftSign = e2[2] >= 0 ? 1 : -1;

      // Meteor schedule: deterministic in t, one every 40–90 s.
      var mrand = U.mulberry32(S.meteorSeed);
      var meteors = [];
      var nextMeteor = 18 + mrand() * 30;
      function meteorAt(t) {
        while (nextMeteor < t + 2) {
          var left = mrand() < 0.5;
          var ang = (18 + mrand() * 38) * Math.PI / 180;
          var dx = Math.cos(ang) * (left ? -1 : 1), dy = -Math.sin(ang);
          meteors.push({
            start: nextMeteor,
            dur: 0.75 + mrand() * 0.45,
            x: (mrand() - 0.5) * 0.8,       // fraction of the width
            y: 0.52 + mrand() * 0.40,       // screen heights from the bottom
            dx: dx, dy: dy,
            travel: 0.12 + mrand() * 0.12,
            tail: 0.07 + mrand() * 0.06,
            peak: 0.20 + mrand() * 0.16
          });
          nextMeteor += 40 + mrand() * 50;
        }
        for (var i = meteors.length - 1; i >= 0; i--) {
          var m = meteors[i];
          if (t >= m.start && t < m.start + m.dur) return m;
          if (m.start + m.dur < t - 120) break;
        }
        return null;
      }

      var tri = G.fullscreenTriangle(gl);
      var pMW = G.createProgram(gl, G.FULLSCREEN_VS, HEADER + lib + MW_FS);
      var pFG = G.createProgram(gl, G.FULLSCREEN_VS, HEADER + lib + FG_FS);
      var pMain = G.createProgram(gl, G.FULLSCREEN_VS, HEADER + lib + MAIN_FS);

      var rtMW = null, rtFG = null, geo = null, builtKey = '';

      function freeTargets() {
        if (rtMW) { rtMW.destroy(); rtMW = null; }
        if (rtFG) { rtFG.destroy(); rtFG = null; }
      }

      function computeGeo() {
        var w = Math.max(1, env.width), h = Math.max(1, env.height);
        var cssH = Math.max(1, env.cssHeight);
        var aspect = Math.max(1, env.cssWidth) / cssH;
        var pole = [S.poleX, 1 + POLE_UP];
        var R = 0;
        [[-aspect / 2, 0], [aspect / 2, 0], [-aspect / 2, 1], [aspect / 2, 1]].forEach(function (c) {
          R = Math.max(R, Math.hypot(c[0] - pole[0], c[1] - pole[1]));
        });
        R += 0.02;
        var pr = h / cssH;                                   // canvas px per css px
        var vs = Math.max(1, Math.sqrt(SMALL_REF / cssH));    // miniaturise the field on small canvases
        var starPx = pr / vs;                                // canvas px per star px
        var psf = PSF_CSS * pr;
        var sigFaint = Math.max(psf * 1.25, SIG_MIN);
        var faintReach = 4 * sigFaint;
        function visFaint(L) { return U.smoothstep(2.0, 2.7, L.cell * starPx / faintReach); }
        function reachOf(L) {
          var I = L.iMax;
          var sig = Math.max(psf * (1 + 0.22 * Math.log2(Math.max(1, I * 2.5))), SIG_MIN);
          var sh = Math.max(psf, 0.4) * 4.5 * (1 + 0.35 * Math.log2(I + 1));
          return Math.max(4 * sig, 3 * sh) + 0.5;
        }
        function marginOf(L) { return reachOf(L) / (L.cell * starPx); }
        function visOne(m) { return 1 - U.smoothstep(0.30, 0.44, m); }
        var mM = marginOf(LAYERS.mid), mB = marginOf(LAYERS.bright), mX = marginOf(LAYERS.brilliant);
        geo = {
          w: w, h: h, aspect: aspect, pole: pole, R: R,
          starScale: cssH * vs, starPx: starPx, psf: psf,
          faintR2: faintReach * faintReach,
          peakFloor: 0.45,
          vis: [visFaint(LAYERS.dust), visFaint(LAYERS.faint), visOne(mM), visOne(mB)],
          vis2: [visOne(mX), 0],
          margin: [Math.min(mM, 0.44), Math.min(mB, 0.44), Math.min(mX, 0.44)],
          fgRows: Math.max(2, Math.ceil(h * FG_FRAC))
        };
      }

      function maxTex() {
        var mt = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048;
        var vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
        return Math.min(mt, vp ? Math.min(vp[0], vp[1]) : mt);
      }

      function build() {
        freeTargets();
        computeGeo();
        var q = Q[env.quality] || Q.balanced;
        var size = Math.round(2 * geo.R * geo.h * q.mwRes);
        size = Math.max(64, Math.min(size, q.mwMax, maxTex()));
        rtMW = G.createRenderTarget(gl, size, size);
        rtFG = G.createRenderTarget(gl, geo.w, geo.fgRows, { nearest: true });

        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);

        rtMW.bind();
        pMW.use()
          .set('uR', geo.R)
          .set('uK', SKY_K)
          .set('uNGP', ngp).set('uGC', gc).set('uE2', e2)
          .set('uRift', riftSign)
          .set('uOff', S.off)
          .set('uTexRad', 2 * geo.R * SKY_K / size);
        tri.draw();

        rtFG.bind();
        pFG.use()
          .set('uAspect', geo.aspect)
          .set('uFgH', geo.fgRows / geo.h)
          .set('uPx', 1 / geo.h)
          .set('uSeed', S.fg)
          .set('uSide', S.side);
        tri.draw();

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        builtKey = env.quality + ':' + env.width + 'x' + env.height + ':' + env.cssWidth + 'x' + env.cssHeight;
      }

      build();

      return {
        resize: function () { build(); },

        render: function (t) {
          var key = env.quality + ':' + env.width + 'x' + env.height + ':' + env.cssWidth + 'x' + env.cssHeight;
          if (key !== builtKey) build();

          var theta = S.theta0 + OMEGA * t;
          var met = [0, 0, 1, 0], metB = [0, 0.1, 0.001, 0];
          var m = meteorAt(t);
          if (m) {
            var p = (t - m.start) / m.dur;
            var env1 = U.smoothstep(0, 0.2, p) * (1 - U.smoothstep(0.45, 1, p));
            var dist = m.travel * p * (1.2 - 0.2 * p);
            met = [m.x * geo.aspect + m.dx * dist, m.y + m.dy * dist, m.dx, m.dy];
            metB = [m.peak * env1, m.tail * Math.min(1, 0.25 + p * 1.5), Math.max(0.68 / geo.h, 0.5 / env.cssHeight), 0];
          }

          gl.disable(gl.BLEND);
          gl.disable(gl.DEPTH_TEST);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, env.width, env.height);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, rtMW.texture);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, rtFG.texture);
          pMain.use()
            .set('uMW', 0)
            .set('uFG', 1)
            .set('uAspect', geo.aspect)
            .set('uPole', geo.pole)
            .set('uRot', [Math.cos(theta), Math.sin(theta)])
            .set('uMWScale', 1 / (2 * geo.R))
            .set('uStarScale', geo.starScale)
            .set('uStarPx', geo.starPx)
            .set('uPsf', geo.psf)
            .set('uSigMin', SIG_MIN)
            .set('uPeakFloor', geo.peakFloor)
            .set('uFaintR2', geo.faintR2)
            .set('uVis', geo.vis)
            .set('uVis2', geo.vis2)
            .set('uMargin', geo.margin)
            .set('uT', t + S.timeOff)
            .set('uFgH', geo.fgRows / geo.h)
            .set('uMetA', met)
            .set('uMetB', metB)
            .set('uSeed', [S.salt, S.airPhase, S.glowX, 0]);
          tri.draw();
          gl.activeTexture(gl.TEXTURE0);
        },

        destroy: function () {
          freeTargets();
          pMW.destroy(); pFG.destroy(); pMain.destroy();
          tri.destroy();
        }
      };
    }
  });
})();
