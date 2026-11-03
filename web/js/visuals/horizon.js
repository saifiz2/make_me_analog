/*
 * Analog Brick — "Horizon" visual mode (id "horizon").
 *
 * A quiet mountain lake through a slow day: golden hour → sunset → blue hour → night
 * (stars, moon) → dawn → golden hour again, one full cycle every 30 minutes.
 * Painterly and flat-layered in the spirit of a travel poster rather than photoreal:
 * five mountain ridges in atmospheric perspective, drifting mist in the valleys, a few
 * soft clouds, a low sun (or moon) and a calm lake mirroring it all.
 *
 * Rendering (WebGL1, GLSL ES 1.00), three cheap passes:
 *   1. ridges   — per screen column, the height of each of the five ridges plus a fine and
 *                 a coarse slope, baked into a W×8 texture (16-bit packed heights). Ridges
 *                 drift sideways with slow parallax, so this is re-baked with the scene.
 *   2. scene    — everything above the waterline: sky gradient, sun / moon and their glow,
 *                 stars, clouds, ridges (two-tone lit faces, rim light, valley haze) and
 *                 drifting mist bands, rendered into a texture exactly the size of the
 *                 visible sky+land. The scene moves very slowly, so it is refreshed at a
 *                 modest rate (12–30 Hz by quality) instead of every frame.
 *   3. compose  — copies the scene above the waterline; below it, mirrors the scene with
 *                 perspective ripples, a soft vertical blur, wind streaks, a glitter path
 *                 under the sun / moon and shore mist; vignette, paper grain, dither.
 *
 * Time of day is a ring of keyframed palettes interpolated in OKLab on the CPU and sent as
 * uniforms. The sun and moon follow fixed elliptical paths keyed to the same phase.
 * Seed (per display) changes the terrain, clouds and mist, and nudges time a few seconds.
 */
(function () {
  'use strict';

  var BV = window.BrickVisuals;
  if (!BV) return;

  // ───────────────────────────── tuning ─────────────────────────────
  var CYCLE = 1800;          // seconds for a full day cycle
  var WATER = 0.31;          // waterline, fraction of the screen height from the bottom
  var RIDGE_ROWS = 10;       // rows in the bake texture: 5 ridges, 3 cloud layers, 2 coarse ridges
  // Horizontal drift of each ridge in screen heights per second (far → near: parallax).
  var DRIFT = [0.00010, 0.00019, 0.00032, 0.00050, 0.00075];
  var CLOUD_DRIFT = 0.0021;  // screen heights per second
  var MIST_DRIFT = 0.0045;
  var CLOUD_Y = [0.705, 0.825, 0.935];   // base lines of the low, mid and high cloud layers

  // Sun and moon paths: ellipses in screen uv (x across, y up), keyed to the day phase.
  var SUN = { noon: 0.0, cx: 0.56, rx: 0.30, cy: 0.205, ry: 0.475, r: 0.030 };
  var MOON = { noon: 0.58, cx: 0.48, rx: 0.32, cy: 0.48, ry: 0.34, r: 0.021 };

  // Per-quality budgets.
  var Q = {
    saver:    { hz: 12 },
    balanced: { hz: 20 },
    high:     { hz: 30 }
  };

  // ───────────────────────────── palettes ─────────────────────────────
  // p: day phase 0…1. Colours are display sRGB. Scalars: glowAmt (sun glow strength),
  // stars, moon, mist, light (two-tone ridge lighting), cloud (cloud cover bias).
  var KEYS = [
    { p: 0.00, name: 'golden',
      zen: '#4f7db3', mid: '#e3b991', hor: '#f9cc8a', sun: '#fff6dc', glow: '#ffc277',
      far: '#a996b4', near: '#1b2838', haze: '#efcfb4', cLit: '#fff0d6', cDark: '#a99aae', water: '#2b3d55',
      glowAmt: 0.75, stars: 0, moon: 0, mist: 0.45, light: 0.6, cloud: 0.0 },
    { p: 0.07, name: 'late golden',
      zen: '#4d6c9e', mid: '#e3ad8b', hor: '#ffc583', sun: '#ffe7b0', glow: '#ffb26b',
      far: '#b98e9c', near: '#1e2536', haze: '#f2c3a0', cLit: '#ffd9b0', cDark: '#94809e', water: '#283551',
      glowAmt: 0.9, stars: 0, moon: 0, mist: 0.45, light: 0.7, cloud: 0.03 },
    { p: 0.14, name: 'sunset',
      zen: '#38457a', mid: '#d88a7a', hor: '#ffa860', sun: '#ffcf8c', glow: '#ff9450',
      far: '#a86c80', near: '#1c1a2d', haze: '#eea486', cLit: '#ffb08a', cDark: '#6e5274', water: '#251f3b',
      glowAmt: 1.0, stars: 0, moon: 0, mist: 0.5, light: 0.55, cloud: 0.06 },
    { p: 0.21, name: 'afterglow',
      zen: '#2a3668', mid: '#a8728f', hor: '#f0957a', sun: '#ffcf8c', glow: '#ff8466',
      far: '#7c5a7c', near: '#17172b', haze: '#c98d97', cLit: '#f79a86', cDark: '#6b5274', water: '#1d1d38',
      glowAmt: 0.55, stars: 0, moon: 0.1, mist: 0.55, light: 0.15, cloud: 0.06 },
    { p: 0.29, name: 'blue hour',
      zen: '#1c2753', mid: '#3f5088', hor: '#9387b0', sun: '#ffcf8c', glow: '#c48aa0',
      far: '#4f5a8a', near: '#10142b', haze: '#7a82ae', cLit: '#9a92bb', cDark: '#414a78', water: '#141a38',
      glowAmt: 0.18, stars: 0.15, moon: 0.45, mist: 0.65, light: 0.0, cloud: 0.04 },
    { p: 0.38, name: 'nightfall',
      zen: '#0c1431', mid: '#1a2a53', hor: '#374e80', sun: '#ffcf8c', glow: '#8090c0',
      far: '#25345e', near: '#080c1c', haze: '#40527f', cLit: '#4c5b84', cDark: '#1c2546', water: '#0b1228',
      glowAmt: 0.0, stars: 0.85, moon: 0.85, mist: 0.6, light: 0.15, cloud: 0.0 },
    { p: 0.55, name: 'night',
      zen: '#080e26', mid: '#15244d', hor: '#33497c', sun: '#ffcf8c', glow: '#8090c0',
      far: '#22315b', near: '#070b19', haze: '#465c8a', cLit: '#7383ab', cDark: '#18213f', water: '#0a1129',
      glowAmt: 0.0, stars: 1.0, moon: 1.0, mist: 0.55, light: 0.25, cloud: -0.02 },
    { p: 0.70, name: 'late night',
      zen: '#0a1029', mid: '#17264e', hor: '#34497b', sun: '#ffcf8c', glow: '#8090c0',
      far: '#23325b', near: '#080c1b', haze: '#44567f', cLit: '#5f6e98', cDark: '#161e3b', water: '#0b1229',
      glowAmt: 0.0, stars: 0.95, moon: 0.9, mist: 0.65, light: 0.2, cloud: 0.02 },
    { p: 0.78, name: 'pre-dawn',
      zen: '#1a2652', mid: '#3c4d85', hor: '#9a8db0', sun: '#ffd8a8', glow: '#e2a0a6',
      far: '#4c5a8b', near: '#0f142e', haze: '#8890b8', cLit: '#a69dc2', cDark: '#434b78', water: '#161f43',
      glowAmt: 0.2, stars: 0.35, moon: 0.5, mist: 0.8, light: 0.05, cloud: 0.04 },
    { p: 0.85, name: 'dawn',
      zen: '#3b5590', mid: '#c99bb6', hor: '#ffc0a3', sun: '#ffe2bc', glow: '#ffae90',
      far: '#a48db2', near: '#202949', haze: '#efc5c8', cLit: '#ffc7b6', cDark: '#8b80a9', water: '#2a3560',
      glowAmt: 0.55, stars: 0, moon: 0.1, mist: 0.85, light: 0.2, cloud: 0.05 },
    { p: 0.92, name: 'sunrise',
      zen: '#5279b0', mid: '#eec0a3', hor: '#ffd39c', sun: '#fff0c8', glow: '#ffbe82',
      far: '#b6a0b5', near: '#222d45', haze: '#f6d6bf', cLit: '#ffe0bd', cDark: '#a497b2', water: '#2d4262',
      glowAmt: 0.85, stars: 0, moon: 0, mist: 0.65, light: 0.55, cloud: 0.02 }
  ];
  var COLOR_FIELDS = ['zen', 'mid', 'hor', 'sun', 'glow', 'far', 'near', 'haze', 'cLit', 'cDark', 'water'];
  var SCALAR_FIELDS = ['glowAmt', 'stars', 'moon', 'mist', 'light', 'cloud'];

  // ── OKLab (palette interpolation keeps hue and lightness transitions clean) ──
  function s2l(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function l2s(c) { c = c < 0 ? 0 : c > 1 ? 1 : c; return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }
  function toOklab(rgb) {
    var r = s2l(rgb[0]), g = s2l(rgb[1]), b = s2l(rgb[2]);
    var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    var m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    var s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  }
  function fromOklab(c, out) {
    var l = c[0] + 0.3963377774 * c[1] + 0.2158037573 * c[2];
    var m = c[0] - 0.1055613458 * c[1] - 0.0638541728 * c[2];
    var s = c[0] - 0.0894841775 * c[1] - 1.2914855480 * c[2];
    l = l * l * l; m = m * m * m; s = s * s * s;
    out[0] = l2s(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
    out[1] = l2s(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
    out[2] = l2s(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
    return out;
  }

  var LAB_KEYS = KEYS.map(function (k) {
    var o = { p: k.p };
    COLOR_FIELDS.forEach(function (f) { o[f] = toOklab(BV.util.hexToRgb(k[f])); });
    SCALAR_FIELDS.forEach(function (f) { o[f] = k[f]; });
    return o;
  });

  function makePalette() {
    var o = {};
    COLOR_FIELDS.forEach(function (f) { o[f] = [0, 0, 0]; });
    SCALAR_FIELDS.forEach(function (f) { o[f] = 0; });
    return o;
  }

  var tmpLab = [0, 0, 0];
  /** Smooth (eased per segment) interpolation around the ring of keyframes. */
  function samplePalette(p, out) {
    var n = LAB_KEYS.length, i = n - 1;
    for (var k = 0; k < n; k++) if (LAB_KEYS[k].p <= p) i = k;
    var a = LAB_KEYS[i], b = LAB_KEYS[(i + 1) % n];
    var pa = a.p, pb = b.p <= pa ? b.p + 1 : b.p, pp = p < pa ? p + 1 : p;
    var t = (pp - pa) / (pb - pa);
    t = t * t * (3 - 2 * t);
    for (var c = 0; c < COLOR_FIELDS.length; c++) {
      var f = COLOR_FIELDS[c], A = a[f], B = b[f];
      tmpLab[0] = A[0] + (B[0] - A[0]) * t;
      tmpLab[1] = A[1] + (B[1] - A[1]) * t;
      tmpLab[2] = A[2] + (B[2] - A[2]) * t;
      fromOklab(tmpLab, out[f]);
    }
    for (var s = 0; s < SCALAR_FIELDS.length; s++) {
      var g = SCALAR_FIELDS[s];
      out[g] = a[g] + (b[g] - a[g]) * t;
    }
    return out;
  }

  function orbit(o, p) {
    var a = 2 * Math.PI * (p - o.noon);
    return [o.cx + o.rx * Math.sin(a), o.cy + o.ry * Math.cos(a)];
  }

  // ───────────────────────────── shaders ─────────────────────────────
  var HEADER = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    ''
  ].join('\n');

  var GLSL_PACK = [
    'vec2 pack16(float v) { v = clamp(v, 0.0, 0.99998) * 255.0; float hi = floor(v); return vec2(hi / 255.0, v - hi); }',
    'float unpack16(vec2 e) { return (e.x * 255.0 + e.y) / 255.0; }'
  ].join('\n');

  // Pass 1: per-column bake. Rows 0–4: ridge r (0 = farthest). RG = packed height (screen-uv
  // y), B = fine slope dy/dX (±8, X in screen heights), A = skew of the shading spines.
  // Rows 5–7: cloud layers (low, mid, high). RG = packed top edge, B = thickness (×0.08),
  // A = end fade (0 = clear sky).
  // Rows 8–9: coarse (big-shape) heights of ridges 0 and 1, used to shade their faces.
  var RIDGE_FS = [
    'varying vec2 v_uv;',
    'uniform float uAspect;',
    'uniform float uTexW;',
    'uniform float uPx;        // screen heights per canvas pixel',
    'uniform vec4 uDriftA;     // ridges 0..3 horizontal offsets (screen heights)',
    'uniform float uDriftB;    // ridge 4',
    'uniform vec4 uSalt;',
    'uniform vec4 uCloud;      // xyz: cloud layer offsets, w: slow morph',
    'uniform float uCover;     // cloud cover bias',
    GLSL_PACK,
    '',
    '// Conifer tips: one slim triangle per cell (jittered), patchy forest with clearings.',
    'float trees(float x, float cell, float hgt, float salt) {',
    '  float c = x / cell;',
    '  float id = floor(c);',
    '  float f = c - id;',
    '  float best = 0.0;',
    '  for (int k = -1; k <= 1; k++) {',
    '    float j = id + float(k);',
    '    float r1 = hash11(j * 0.6180339 + salt);',
    '    float r2 = hash11(j * 1.3247180 + salt + 0.37);',
    '    float cx = float(k) + 0.5 + (r1 - 0.5) * 0.7;',
    '    float hh = hgt * (0.45 + 0.55 * r2 * r2);',
    '    float w = 0.36 + 0.2 * r1;',
    '    float q = clamp(1.0 - abs(f - cx) / w, 0.0, 1.0);',
    '    best = max(best, hh * pow(q, 1.15));',
    '  }',
    '  float m = smoothstep(-0.6, 0.0, snoise(vec2(x * 0.75, salt * 0.37)));',
    '  float lod = smoothstep(2.0, 4.5, cell / uPx);',
    '  return m * mix(hgt * 0.3, best, lod);',
    '}',
    '',
    '// Each returns the height of a ridge at x (screen heights from the centre).',
    '// Ridged multifractal: sharp summits, detail concentrated near the crests.',
    '// c receives the big shapes only (no small crags).',
    'float ridged(float x, float f, float salt, out float c) {',
    '  float n1 = 1.0 - abs(snoise(vec2(x * f, salt)));',
    '  n1 *= n1;',
    '  float n2 = 1.0 - abs(snoise(vec2(x * f * 2.1, salt + 3.3)));',
    '  n2 = n2 * n2 * n1;',
    '  float n3 = 1.0 - abs(snoise(vec2(x * f * 4.6, salt + 6.1)));',
    '  n3 = n3 * n3 * n2;',
    '  c = 0.62 * n1 + 0.2 * n2;',
    '  return 0.62 * n1 + 0.27 * n2 + 0.11 * n3;',
    '}',
    'float ridge0(float x, out float c) {         // the high range',
    '  float big = snoise(vec2(x * 0.27, 1.7 + uSalt.x));',
    '  float amp = 0.17 + 0.06 * big;',
    '  float h = 0.488 + 0.03 * big + amp * ridged(x, 0.62, 4.1 + uSalt.x, c);',
    '  c = 0.488 + 0.03 * big + amp * c;',
    '  return h + 0.0015 * snoise(vec2(x * 23.0, 2.2 + uSalt.x));',
    '}',
    'float ridge1(float x, out float c) {         // nearer mountains, a little softer',
    '  float b = snoise(vec2(x * 0.45, 2.3 + uSalt.y));',
    '  float amp = 0.085 + 0.025 * b;',
    '  float h = 0.44 + 0.025 * b + amp * ridged(x, 1.05, 5.2 + uSalt.y, c);',
    '  c = 0.44 + 0.025 * b + amp * c;',
    '  return h + 0.002 * snoise(vec2(x * 13.0, 3.3 + uSalt.y));',
    '}',
    'float ridge2(float x) {         // rolling foothills',
    '  float h = 0.402 + 0.03 * snoise(vec2(x * 0.75, 6.6 + uSalt.z)) + 0.014 * snoise(vec2(x * 2.1, 1.1 + uSalt.z));',
    '  return h + 0.004 * snoise(vec2(x * 6.0, 2.9 + uSalt.z)) + trees(x, 0.0045, 0.006, uSalt.z + 5.0) * 0.6;',
    '}',
    'float ridge3(float x) {         // forested hills',
    '  float h = 0.364 + 0.024 * snoise(vec2(x * 1.0, 3.8 + uSalt.w)) + 0.01 * snoise(vec2(x * 2.9, 9.4 + uSalt.w));',
    '  return h + trees(x, 0.0062, 0.012, uSalt.w + 21.0);',
    '}',
    'float ridge4(float x) {         // the far shore of the lake, with the odd wooded headland',
    '  float head = smoothstep(-0.05, 1.05, snoise(vec2(x * 0.6, 3.3 + uSalt.y * 0.5)));',
    '  float h = 0.321 + 0.007 * snoise(vec2(x * 1.4, 7.7 + uSalt.x * 0.5)) + 0.05 * head * head;',
    '  h += 0.014 * head * snoise(vec2(x * 2.6, 5.5 + uSalt.w));   // headlands roll, never plateau',
    '  return h + trees(x, 0.0085, 0.017 + 0.008 * head, uSalt.z + 47.0);',
    '}',
    'float ridgeAt(float row, float x) {',
    '  float c;',
    '  if (row < 0.5) return ridge0(x + uDriftA.x, c);',
    '  if (row < 1.5) return ridge1(x + uDriftA.y, c);',
    '  if (row < 2.5) return ridge2(x + uDriftA.z);',
    '  if (row < 3.5) return ridge3(x + uDriftA.w);',
    '  return ridge4(x + uDriftB);',
    '}',
    '',
    '// Scalloped top: a union of jittered round puffs, one per cell of width w. 0…1.',
    'float puffs(float x, float w, float salt) {',
    '  float c = x / w;',
    '  float id = floor(c);',
    '  float best = 0.0;',
    '  for (int k = -1; k <= 1; k++) {',
    '    float j = id + float(k);',
    '    float cx = j + 0.5 + (hash11(j * 0.731 + salt) - 0.5) * 0.5;',
    '    float r = 0.5 + 0.5 * hash11(j * 1.913 + salt + 0.5);',
    '    float d = c - cx;',
    '    best = max(best, sqrt(max(r * r - d * d, 0.0)));',
    '  }',
    '  return best;',
    '}',
    '',
    '// A cloud layer is a row of illustrated clouds: flat bottoms, puffy (or, for cirrus,',
    '// smooth) tops, tapering ends. Returns (top, thickness, end fade).',
    'vec3 cloud(float x, float yc, float thick, float stretch, float puffW, float salt) {',
    '  float xs = x * stretch;',
    '  float m = uCloud.w;',
    '  float n = snoise(vec2(xs, salt + m)) * 0.62 + snoise(vec2(xs * 2.4 + 5.0, salt + 3.7 - m * 0.7)) * 0.38;',
    '  float thr = 0.12 - uCover;',
    '  float k = clamp((n - thr) / (0.62 - thr), 0.0, 1.0);',
    '  yc += 0.012 * snoise(vec2(x * 0.45, salt + 20.0));',
    '  if (k <= 0.0) return vec3(yc, 0.0, 0.0);',
    '  float th = thick * sqrt(k);',
    '  float bot = yc - th * (0.2 + 0.05 * snoise(vec2(x * 2.2, salt + 9.0)));',
    '  float swell = 0.65 + 0.35 * snoise(vec2(x * 3.2, salt + 4.4));   // puffs vary along the cloud',
    '  float top = puffW > 0.0 ? yc + th * (0.22 + 0.9 * swell * puffs(x, puffW, salt)) : yc + th * 0.55;',
    '  return vec3(top, top - bot, smoothstep(0.0, 0.3, k));',
    '}',
    '',
    'void main() {',
    '  float row = floor(v_uv.y * ' + RIDGE_ROWS.toFixed(1) + ');',
    '  float X = (v_uv.x - 0.5) * uAspect;',
    '  if (row > 7.5) {',
    '    float c;',
    '    if (row < 8.5) ridge0(X + uDriftA.x, c); else ridge1(X + uDriftA.y, c);',
    '    gl_FragColor = vec4(pack16(c), 0.0, 0.0);',
    '    return;',
    '  }',
    '  if (row > 4.5) {',
    '    vec3 c;',
    '    if (row < 5.5) c = cloud(X + uCloud.x, ' + CLOUD_Y[0].toFixed(3) + ', 0.05, 1.25, 0.04, uSalt.y + 3.0);',
    '    else if (row < 6.5) c = cloud(X + uCloud.y, ' + CLOUD_Y[1].toFixed(3) + ', 0.036, 1.4, 0.03, uSalt.z + 11.0);',
    '    else c = cloud(X + uCloud.z, ' + CLOUD_Y[2].toFixed(3) + ', 0.026, 1.5, 0.0, uSalt.w + 19.0);',
    '    gl_FragColor = vec4(pack16(c.x), clamp(c.y / 0.08, 0.0, 1.0), c.z);',
    '    return;',
    '  }',
    '  float e = 0.5 * uAspect / uTexW;',
    '  float h = ridgeAt(row, X);',
    '  float sf = (ridgeAt(row, X + e) - ridgeAt(row, X - e)) / (2.0 * e);',
    '  // skew of the shading spines below this column (moves with the ridge)',
    '  float sk = 0.55 + 0.45 * snoise(vec2((X + (row < 0.5 ? uDriftA.x : uDriftA.y)) * 0.7, 11.0 + row * 7.0));',
    '  gl_FragColor = vec4(pack16(h), clamp(0.5 + sf / 16.0, 0.0, 1.0), clamp(sk, 0.0, 1.0));',
    '}'
  ].join('\n');

  // Pass 2: everything above the waterline.
  var SCENE_FS = [
    'varying vec2 v_uv;',
    'uniform sampler2D uRidge;',
    'uniform vec2 uCss;        // css size of the whole canvas',
    'uniform float uPx;        // screen heights per canvas pixel',
    'uniform float uPr;        // canvas px per css px',
    'uniform float uAspect;',
    'uniform float uWater;',
    'uniform float uT;',
    'uniform vec3 uZen;',
    'uniform vec3 uMid;',
    'uniform vec3 uHor;',
    'uniform vec3 uSunCol;',
    'uniform vec3 uGlowCol;',
    'uniform vec4 uSun;        // X (screen heights from centre), y, radius, glow amount',
    'uniform vec4 uMoon;       // X, y, radius, amount',
    'uniform vec3 uFar;',
    'uniform vec3 uNear;',
    'uniform vec3 uHaze;',
    'uniform vec3 uCloudLit;',
    'uniform vec3 uCloudDark;',
    'uniform vec4 uAmt;        // stars, mist, ridge light, unused',
    'uniform vec2 uLight;      // light source position (X, y)',
    'uniform vec4 uMistOff;',
    'uniform float uSalt;',
    'uniform float uTexel;     // 1 / bake texture width',
    GLSL_PACK,
    '',
    'vec3 mixL(vec3 a, vec3 b, float t) { return sqrt(mix(a * a, b * b, t)); }   // mix in ~linear light',
    'vec3 screen(vec3 a, vec3 b) { return 1.0 - (1.0 - a) * (1.0 - clamp(b, 0.0, 1.0)); }',
    'float rowV(float r) { return (r + 0.5) / ' + RIDGE_ROWS.toFixed(1) + '; }',
    '',
    'vec3 starLayer(vec2 px, float pr, float fl, float cell, float density, float rCss, float bMax, float salt) {',
    '  vec2 id = floor(px / cell);',
    '  float h = hash12(id + salt);',
    '  if (h > density) return vec3(0.0);',
    '  vec2 f = px - id * cell;',
    '  vec2 pos = (0.2 + 0.6 * hash22(id + salt + 3.1)) * cell;',
    '  float h2 = hash12(id * 1.7 + salt + 9.2);',
    '  float b = bMax * (0.12 + 0.88 * pow(h2, 6.0));',
    '  float r0 = rCss * pr;',
    '  float r = max(r0, 0.8);',
    '  b *= min(1.0, (r0 * r0) / (r * r) + fl);',
    '  float d = length(f - pos) * pr;',
    '  float tw = 0.82 + 0.18 * sin(uT * (0.25 + 0.45 * h2) + h * 40.0);',
    '  vec3 tint = mix(vec3(0.75, 0.84, 1.0), vec3(1.0, 0.9, 0.76), hash12(id + salt + 5.5));',
    '  return tint * b * tw * exp(-d * d / (r * r));',
    '}',
    '',
    '// One baked cloud layer over col. yc: base line, alpha: layer opacity.',
    'vec3 cloudLayer(vec3 col, float row, float yc, float alpha, float sf, float y, float ds) {',
    '  float rv = rowV(row);',
    '  vec4 e = texture2D(uRidge, vec2(v_uv.x, rv));',
    '  if (e.a <= 0.0) return col;',
    '  float top = unpack16(e.rg);',
    '  float th = max(e.b * 0.08, 1e-4);',
    '  float bot = top - th;',
    '  float soft = max(1.2 * uPx, th * sf);',
    '  if (y < bot - soft || y > top + soft * 8.0) return col;',
    '  // feather perpendicular to the edge: widen by the local slope of the top',
    '  float tl = unpack16(texture2D(uRidge, vec2(v_uv.x - uTexel, rv)).rg);',
    '  float tr = unpack16(texture2D(uRidge, vec2(v_uv.x + uTexel, rv)).rg);',
    '  float sl = (tr - tl) / (2.0 * uTexel * uAspect);',
    '  float st = soft * sqrt(1.0 + min(sl * sl, 400.0));',
    '  float a = smoothstep(bot - soft * 0.5, bot + soft * 0.5, y) * smoothstep(top + st * 0.5, top - st * 0.5, y);',
    '  if (a <= 0.0) return col;',
    '  float v = clamp((y - bot) / th, 0.0, 1.0);',
    '  float under = smoothstep(0.02, -0.12, uLight.y - yc);   // light below the cloud: undersides glow',
    '  float lit = mix(smoothstep(0.15, 1.0, v), 1.0 - smoothstep(0.0, 0.75, v), under);',
    '  vec3 cc = mixL(uCloudDark, uCloudLit, lit);',
    '  cc = screen(cc, uGlowCol * uSun.w * 0.45 * exp(-ds * 4.5));',
    '  return mix(col, cc, a * alpha * e.a);',
    '}',
    '',
    'void main() {',
    '  float y = mix(uWater, 1.0, v_uv.y);',
    '  float X = (v_uv.x - 0.5) * uAspect;',
    '  vec2 P = vec2(X, y);',
    '  vec2 S = uSun.xy;',
    '  float ds = length(P - S);',
    '',
    '  // the farthest ridge that matters here: the nearest one fully covering the pixel',
    '  float start = -1.0;',
    '  for (int i = 0; i < 5; i++) {',
    '    float hh = unpack16(texture2D(uRidge, vec2(v_uv.x, rowV(float(i)))).rg);',
    '    if (hh - y > 6.0 * uPx) start = float(i);',
    '  }',
    '',
    '  vec3 col = vec3(0.0);',
    '  if (start < 0.0) {',
    '    // sky',
    '    vec3 lo = mixL(uHor, uMid, smoothstep(0.47, 0.80, y));',
    '    col = mixL(lo, uZen, smoothstep(0.66, 1.06, y));',
    '    // sun glow (screen-blended: soft, never clips)',
    '    float glow = uSun.w * (0.7 * exp(-ds * 26.0) + 0.32 * exp(-ds * 7.0) + 0.22 * exp(-ds * 2.6)',
    '               + 0.20 * exp(-length((P - S) * vec2(0.32, 2.4)) * 3.0));',
    '    col = screen(col, uGlowCol * glow);',
    '    // stars',
    '    if (uAmt.x > 0.001) {',
    '      float vs = max(1.0, 700.0 / uCss.y);',
    '      vec2 spx = vec2(v_uv.x, y) * uCss * vs;',
    '      float fl = 0.35 / (vs * vs);',
    '      vec3 st = starLayer(spx, uPr / vs, fl, 9.0, 0.24, 0.45, 0.15, uSalt)',
    '              + starLayer(spx, uPr / vs, fl, 30.0, 0.34, 0.65, 0.7, uSalt + 17.0);',
    '      col += st * uAmt.x * smoothstep(0.48, 0.72, y);',
    '    }',
    '    // moon',
    '    if (uMoon.w > 0.001) {',
    '      vec2 M = uMoon.xy;',
    '      float dm = length(P - M);',
    '      float mg = uMoon.w * (0.22 * exp(-dm * 26.0) + 0.12 * exp(-dm * 6.0));',
    '      col = screen(col, vec3(0.62, 0.70, 0.88) * mg);',
    '      float md = smoothstep(uMoon.z + uPx, uMoon.z - uPx, dm);',
    '      if (md > 0.0) {',
    '        vec2 mq = (P - M) / uMoon.z;',
    '        float mare = smoothstep(0.05, 0.55, snoise(mq * 0.8 + 7.0) * 0.75 + snoise(mq * 1.9 + 2.0) * 0.25);',
    '        vec3 mc = vec3(0.97, 0.96, 0.91) * (1.0 - 0.07 * mare - 0.06 * dot(mq, mq));',
    '        col = mix(col, mc, md * uMoon.w);',
    '      }',
    '    }',
    '    // sun disc, then a hot halo over it (so the disc stays the brightest thing)',
    '    col = mix(col, uSunCol, smoothstep(uSun.z + 1.2 * uPx, uSun.z - 1.2 * uPx, ds));',
    '    col = screen(col, mix(uSunCol, vec3(1.0), 0.5) * exp(-max(ds - uSun.z, 0.0) * 60.0) * 0.5 * smoothstep(0.0, 0.4, uSun.w));',
    '    // clouds, high → low',
    '    if (y > 0.6) {',
    '      col = cloudLayer(col, 7.0, ' + CLOUD_Y[2].toFixed(3) + ', 0.4, 0.7, y, ds);',
    '      col = cloudLayer(col, 6.0, ' + CLOUD_Y[1].toFixed(3) + ', 0.88, 0.07, y, ds);',
    '      col = cloudLayer(col, 5.0, ' + CLOUD_Y[0].toFixed(3) + ', 0.95, 0.06, y, ds);',
    '    }',
    '  }',
    '',
    '  // ridges, far → near, with mist drifting in each valley',
    '  float side = 0.0;',
    '  for (int i = 0; i < 5; i++) {',
    '    float fi = float(i);',
    '    if (fi < start) continue;',
    '    float k = fi / 4.0;',
    '    float rv = rowV(fi);',
    '    vec4 r = texture2D(uRidge, vec2(v_uv.x, rv));',
    '    float h = unpack16(r.rg);',
    '    float sf = (r.b - 0.5) * 16.0;',
    '    float dd = h - y;',
    '    float cov = clamp(dd / (uPx * sqrt(1.0 + sf * sf)) + 0.5, 0.0, 1.0);',
    '    float c = 0.49 - 0.05 * fi;     // valley floor in front of this ridge',
    '    if (cov > 0.0) {',
    '      vec3 rc = mix(uFar, uNear, pow(k, 0.9));',
    '      // two-tone faces: secant slope over a window that widens with depth below the crest,',
    '      // so the lit / shaded split runs down from each peak like a spine',
    '      float fogT = smoothstep(c + 0.04, c - 0.02, y);',
    '      if (i < 2) {',
    '        float dp = max(dd, 0.0);',
    '        float ux = v_uv.x + dp * r.a * 1.2 / uAspect;',
    '        float dl = 0.008 + dp * 0.3;',
    '        float du = dl / uAspect;',
    '        float cv = rowV(8.0 + fi);',
    '        float hl = unpack16(texture2D(uRidge, vec2(ux - du, cv)).rg);',
    '        float hr = unpack16(texture2D(uRidge, vec2(ux + du, cv)).rg);',
    '        float s = (hr - hl) / (2.0 * dl);',
    '        float sideL = clamp((uLight.x - X) * 2.5, -1.0, 1.0);',
    '        float lit = smoothstep(-0.08, 0.08, -s * sideL);',
    '        float la = uAmt.z * (1.0 - 0.45 * k) * abs(sideL) * exp(-dp * 7.0) * (1.0 - fogT);',
    '        vec3 litC = screen(rc * 1.06, uGlowCol * 0.16);',
    '        vec3 shC = rc * vec3(0.9, 0.92, 0.97);',
    '        rc = mix(rc, mix(shC, litC, lit), la);',
    '      }',
    '      // valley haze: each layer pales toward its foot',
    '      float fog = fogT * uAmt.y * mix(0.7, 0.35, k);',
    '      rc = mixL(rc, uHaze, fog);',
    '      // the crest catches the light near the sun',
    '      float rim = exp(-max(dd, 0.0) / 0.003) * exp(-ds * 4.0) * uSun.w * (1.0 - 0.8 * k);',
    '      rc = screen(rc, uGlowCol * rim * 0.55);',
    '      col = mix(col, rc, cov);',
    '    }',
    '    if (i < 4) {',
    '      float band = smoothstep(c + 0.045, c + 0.008, y) * smoothstep(c - 0.03, c - 0.002, y);',
    '      if (band > 0.001) {',
    '        vec2 mq = vec2(X * 1.25 + uMistOff.x * (1.0 + fi * 0.4) + fi * 17.0, y * 24.0 + fi * 5.1 + uMistOff.y);',
    '        float n = snoise(mq) * 0.62 + snoise(mq * vec2(2.4, 1.6) + vec2(uMistOff.z, 0.0)) * 0.3;',
    '        float a = band * smoothstep(0.05, 0.5, n + (band - 0.5) * 0.3) * uAmt.y * 0.8;',
    '        vec3 mc = screen(uHaze, uGlowCol * exp(-ds * 3.0) * uSun.w * 0.35);',
    '        col = mixL(col, mc, a);',
    '      }',
    '    }',
    '  }',
    '',
    '  col += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  // Pass 3: compose to the screen. Above the waterline: the scene. Below: its reflection.
  var COMP_FS = [
    'varying vec2 v_uv;',
    'uniform sampler2D uScene;',
    'uniform sampler2D uRidge;',
    'uniform float uPx;',
    'uniform float uAspect;',
    'uniform float uWater;',
    'uniform float uT;',
    'uniform vec3 uWaterCol;',
    'uniform vec3 uHaze;',
    'uniform vec3 uSunCol;',
    'uniform vec4 uSun;        // X, y, radius, glow amount',
    'uniform vec4 uMoon;       // X, y, radius, amount',
    'uniform float uMist;',
    GLSL_PACK,
    '',
    'vec3 scene(vec2 uv, float above) {',
    '  return texture2D(uScene, vec2(uv.x, clamp(above / (1.0 - uWater), 0.0, 1.0))).rgb;',
    '}',
    '',
    '// how much of a light at (X, y) shows over the ridges',
    'float overRidges(vec2 L, float r) {',
    '  float u = L.x / uAspect + 0.5;',
    '  float top = 0.0;',
    '  for (int i = 0; i < 5; i++) top = max(top, unpack16(texture2D(uRidge, vec2(u, (float(i) + 0.5) / ' + RIDGE_ROWS.toFixed(1) + ')).rg));',
    '  return smoothstep(-r, r, L.y - top) * step(0.0, u) * step(u, 1.0);',
    '}',
    '',
    'float glitter(float xl, float zl, float dep, float X, float cx, float lodf) {',
    '  float w = 0.012 + dep * 0.22;',
    '  float g = exp(-(X - cx) * (X - cx) / (w * w));',
    '  if (g < 0.002) return 0.0;',
    '  float s = snoise(vec2(xl * 1.3, zl * 7.0 + uT * 0.22));',
    '  float s2 = snoise(vec2(xl * 3.1 + 4.0, zl * 15.0 - uT * 0.17));',
    '  float dash = smoothstep(0.25, 0.8, s * 0.7 + s2 * 0.4);',
    '  return g * mix(0.22, dash, lodf);',
    '}',
    '',
    'void main() {',
    '  vec2 uv = v_uv;',
    '  float X = (uv.x - 0.5) * uAspect;',
    '  vec3 col;',
    '  if (uv.y >= uWater) {',
    '    col = scene(uv, uv.y - uWater);',
    '  } else {',
    '    float dep = uWater - uv.y;                 // depth below the waterline (screen heights)',
    '    float zl = 0.06 / (dep + 0.006);           // pseudo distance across the water',
    '    float xl = X * zl;',
    '    float dz = 0.06 * uPx / ((dep + 0.006) * (dep + 0.006));   // zl change per pixel',
    '    float lodR = clamp(1.6 - dz * 6.0, 0.0, 1.0);',
    '    float n1 = snoise(vec2(xl * 0.5, zl * 1.5 + uT * 0.045));',
    '    float n2 = snoise(vec2(xl * 1.6 - uT * 0.02, zl * 4.6 - uT * 0.11)) * lodR;',
    '    // broad wind streaks: patches of slightly rougher, lighter water',
    '    float wind = smoothstep(0.15, 0.75, snoise(vec2(xl * 0.07 + uT * 0.004, zl * 0.55 + 3.0)));',
    '    float amp = dep * (0.8 + 0.7 * wind);',
    '    vec2 off = vec2((0.010 * n1 + 0.004 * n2) * amp, (0.045 * n1 + 0.024 * n2) * amp);',
    '    float above = max(dep + off.y, 0.0);',
    '    vec2 ruv = vec2(uv.x + off.x / uAspect, 0.0);',
    '    float b = 0.001 + dep * 0.04;              // softer farther from the shore',
    '    vec3 refl = (scene(ruv, max(above - 1.5 * b, 0.0)) + scene(ruv, max(above - 0.5 * b, 0.0))',
    '              + scene(ruv, above + 0.5 * b) + scene(ruv, above + 1.5 * b)) * 0.25;',
    '    float fres = mix(0.9, 0.38, pow(smoothstep(0.0, 0.32, dep), 0.8));',
    '    col = mix(uWaterCol, refl * vec3(0.86, 0.9, 0.95), fres);',
    '    col *= mix(1.0, 0.82, smoothstep(0.1, 0.32, dep));     // near water: looking down into it',
    '    col = mix(col, col * 1.05 + uHaze * 0.035, wind * 0.6);',
    '',
    '    // glitter paths under the sun and the moon',
    '    float lodG = clamp(1.6 - dz * 12.0, 0.0, 1.0);',
    '    float fall = exp(-dep * 5.0);',
    '    if (uSun.w > 0.01) {',
    '      float g = glitter(xl, zl, dep, X, uSun.x, lodG);',
    '      if (g > 0.0) col += uSunCol * g * fall * uSun.w * 0.5 * overRidges(uSun.xy, uSun.z);',
    '    }',
    '    if (uMoon.w > 0.01) {',
    '      float g = glitter(xl, zl, dep, X, uMoon.x, lodG);',
    '      if (g > 0.0) col += vec3(0.75, 0.8, 0.9) * g * fall * uMoon.w * 0.3 * overRidges(uMoon.xy, uMoon.z);',
    '    }',
    '',
    '    // mist lying on the water along the far shore',
    '    float mn = snoise(vec2(X * 1.1 + uT * 0.004, 0.5)) * 0.5 + 0.5;',
    '    col = mix(col, uHaze, exp(-dep / 0.016) * uMist * 0.3 * (0.5 + 0.5 * mn));',
    '    // a faint bright line where the water meets the shore',
    '    col = mix(col, uHaze, 0.16 * (1.0 - smoothstep(0.0, 2.5 * uPx, dep)));',
    '  }',
    '',
    '  // gentle grade for a dim room: a soft shoulder on the brightest skies, a touch richer colour',
    '  float lum = dot(col, vec3(0.299, 0.587, 0.114));',
    '  col = mix(vec3(lum), col, 1.08) * (1.0 - 0.17 * smoothstep(0.3, 0.95, lum));',
    '',
    '  // vignette, paper grain, dither',
    '  vec2 vq = (uv - 0.5) * vec2(uAspect / 1.6, 1.0);',
    '  col *= mix(1.0, 0.84, smoothstep(0.35, 0.95, length(vq)));',
    '  col *= 1.0 + (hash12(gl_FragCoord.xy * 0.71 + 41.0) - 0.5) * 0.02;',
    '  col += (hash12(gl_FragCoord.xy) + hash12(gl_FragCoord.xy + 71.3) - 1.0) / 255.0;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  // ───────────────────────────── mode ─────────────────────────────
  BV.register({
    id: 'horizon',
    name: 'Horizon',
    tagline: 'A still mountain lake from golden hour to dawn',
    order: 40,
    context: 'webgl',
    renderScale: { saver: 0.5, balanced: 0.7, high: 0.9 },
    musicReactive: false,

    create: function (env) {
      var gl = env.gl;
      var U = env.util, G = U.gl;
      var lib = U.glsl.common + '\n' + U.glsl.noise + '\n';

      var rand = U.mulberry32(((env.seed | 0) + 3) * 9973 + 17);
      var salt = [rand() * 60, rand() * 60, rand() * 60, rand() * 60];
      var drift0 = DRIFT.map(function () { return (rand() - 0.5) * 80; });
      var cloudSeed = [rand() * 50, rand() * 20, rand() * 30, rand() * 30];
      var mistSeed = rand() * 40;
      var starSalt = Math.floor(rand() * 500);
      var timeOff = rand() * 8;                 // seconds; displays are not in lockstep

      var tri = G.fullscreenTriangle(gl);
      var pRidge = G.createProgram(gl, G.FULLSCREEN_VS, HEADER + lib + RIDGE_FS);
      var pScene = G.createProgram(gl, G.FULLSCREEN_VS, HEADER + lib + SCENE_FS);
      var pComp = G.createProgram(gl, G.FULLSCREEN_VS, HEADER + lib + COMP_FS);

      var rt = { ridge: null, scene: null };
      var water = WATER, builtFor = null, lastSceneT = null;
      var pal = makePalette();

      function freeTargets() {
        for (var k in rt) { if (rt[k]) { rt[k].destroy(); rt[k] = null; } }
      }

      function makeTargets() {
        freeTargets();
        var w = Math.max(2, env.width), h = Math.max(4, env.height);
        var waterPx = Math.max(1, Math.round(h * WATER));
        water = waterPx / h;
        rt.ridge = G.createRenderTarget(gl, w, RIDGE_ROWS, { nearest: true });
        rt.scene = G.createRenderTarget(gl, w, Math.max(1, h - waterPx));
        builtFor = env.quality;
        lastSceneT = null;
      }

      makeTargets();

      function bindTex(unit, target) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, target.texture);
      }

      return {
        resize: function () { makeTargets(); },

        render: function (t) {
          if (builtFor !== env.quality || !rt.scene) makeTargets();
          var q = Q[env.quality] || Q.balanced;
          var T = t + timeOff;
          var p = U.fract(T / CYCLE);
          samplePalette(p, pal);

          var aspect = env.cssWidth / Math.max(1, env.cssHeight);
          var w = Math.max(2, env.width), h = Math.max(4, env.height);
          var px = 1 / h;

          var sun = orbit(SUN, p), moon = orbit(MOON, p);
          var sunX = (sun[0] - 0.5) * aspect, moonX = (moon[0] - 0.5) * aspect;
          // light for clouds and ridge faces: the sun by day, the moon by night
          var night = U.smoothstep(0.22, 0.38, p) * (1 - U.smoothstep(0.80, 0.90, p));
          var lightX = U.lerp(sunX, moonX, night), lightY = U.lerp(sun[1], moon[1], night);
          var light = pal.light;
          var moonAmt = pal.moon * U.smoothstep(0.30, 0.45, moon[1]);

          gl.disable(gl.BLEND);
          gl.disable(gl.DEPTH_TEST);

          var needScene = lastSceneT === null || Math.abs(T - lastSceneT) >= 1 / q.hz || T < lastSceneT;
          if (needScene) {
            lastSceneT = T;
            // 1. ridges
            rt.ridge.bind();
            pRidge.use()
              .set('uAspect', aspect)
              .set('uTexW', rt.ridge.width)
              .set('uPx', px)
              .set('uDriftA', [drift0[0] + T * DRIFT[0], drift0[1] + T * DRIFT[1], drift0[2] + T * DRIFT[2], drift0[3] + T * DRIFT[3]])
              .set('uDriftB', drift0[4] + T * DRIFT[4])
              .set('uSalt', salt)
              .set('uCloud', [cloudSeed[0] + T * CLOUD_DRIFT, cloudSeed[1] + T * CLOUD_DRIFT * 0.78, cloudSeed[2] + T * CLOUD_DRIFT * 0.55, T * 0.0016])
              .set('uCover', pal.cloud + 0.06 * Math.sin(T * 0.0019 + cloudSeed[3]));
            tri.draw();

            // 2. scene above the waterline
            rt.scene.bind();
            bindTex(0, rt.ridge);
            pScene.use()
              .set('uRidge', 0)
              .set('uCss', [env.cssWidth, env.cssHeight])
              .set('uPx', px)
              .set('uPr', env.pixelRatio)
              .set('uAspect', aspect)
              .set('uWater', water)
              .set('uT', T)
              .set('uZen', pal.zen).set('uMid', pal.mid).set('uHor', pal.hor)
              .set('uSunCol', pal.sun).set('uGlowCol', pal.glow)
              .set('uSun', [sunX, sun[1], SUN.r, pal.glowAmt])
              .set('uMoon', [moonX, moon[1], MOON.r, moonAmt])
              .set('uFar', pal.far).set('uNear', pal.near).set('uHaze', pal.haze)
              .set('uCloudLit', pal.cLit).set('uCloudDark', pal.cDark)
              .set('uAmt', [pal.stars, pal.mist, light, 0])
              .set('uLight', [lightX, lightY])
              .set('uMistOff', [mistSeed + T * MIST_DRIFT, T * 0.0009, T * 0.006, 0])
              .set('uSalt', starSalt)
              .set('uTexel', 1 / rt.ridge.width);
            tri.draw();
          }

          // 3. compose
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, env.width, env.height);
          bindTex(0, rt.scene);
          bindTex(1, rt.ridge);
          pComp.use()
            .set('uScene', 0)
            .set('uRidge', 1)
            .set('uPx', px)
            .set('uAspect', aspect)
            .set('uWater', water)
            .set('uT', T)
            .set('uWaterCol', pal.water)
            .set('uHaze', pal.haze)
            .set('uSunCol', pal.sun)
            .set('uSun', [sunX, sun[1], SUN.r, pal.glowAmt])
            .set('uMoon', [moonX, moon[1], MOON.r, moonAmt])
            .set('uMist', pal.mist);
          tri.draw();
          gl.activeTexture(gl.TEXTURE0);
        },

        destroy: function () {
          freeTargets();
          pRidge.destroy(); pScene.destroy(); pComp.destroy();
          tri.destroy();
        }
      };
    }
  });
})();
