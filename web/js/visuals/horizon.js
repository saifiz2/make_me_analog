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
  var RIDGE_ROWS = 8;        // rows in the ridge texture (5 used)
  // Horizontal drift of each ridge in screen heights per second (far → near: parallax).
  var DRIFT = [0.00010, 0.00019, 0.00032, 0.00050, 0.00075];
  var CLOUD_DRIFT = 0.0021;  // screen heights per second
  var MIST_DRIFT = 0.0045;

  // Sun and moon paths: ellipses in screen uv (x across, y up), keyed to the day phase.
  var SUN = { noon: 0.0, cx: 0.56, rx: 0.30, cy: 0.205, ry: 0.475, r: 0.030 };
  var MOON = { noon: 0.58, cx: 0.48, rx: 0.32, cy: 0.48, ry: 0.34, r: 0.021 };

  // Per-quality budgets.
  var Q = {
    saver:    { oct: 3, hz: 12 },
    balanced: { oct: 4, hz: 24 },
    high:     { oct: 5, hz: 30 }
  };

  // ───────────────────────────── palettes ─────────────────────────────
  // p: day phase 0…1. Colours are display sRGB. Scalars: glowAmt (sun glow strength),
  // stars, moon, mist, light (two-tone ridge lighting), cloud (cloud cover bias).
  var KEYS = [
    { p: 0.00, name: 'golden',
      zen: '#5a7fae', mid: '#d9b99a', hor: '#f7d29a', sun: '#fff4d6', glow: '#ffc985',
      far: '#b89fae', near: '#1f2b3b', haze: '#f3d5b8', cLit: '#fff0d6', cDark: '#a99aae', water: '#2b3d55',
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
      far: '#7c5a7c', near: '#17172b', haze: '#c98d97', cLit: '#f79a86', cDark: '#4d3c5f', water: '#1d1d38',
      glowAmt: 0.55, stars: 0, moon: 0.1, mist: 0.55, light: 0.15, cloud: 0.06 },
    { p: 0.29, name: 'blue hour',
      zen: '#1c2753', mid: '#3f5088', hor: '#9387b0', sun: '#ffcf8c', glow: '#c48aa0',
      far: '#4f5a8a', near: '#10142b', haze: '#7a82ae', cLit: '#9a92bb', cDark: '#2e3359', water: '#141a38',
      glowAmt: 0.18, stars: 0.15, moon: 0.45, mist: 0.65, light: 0.0, cloud: 0.04 },
    { p: 0.38, name: 'nightfall',
      zen: '#0c1431', mid: '#192951', hor: '#33497a', sun: '#ffcf8c', glow: '#8090c0',
      far: '#2b3a66', near: '#080c1c', haze: '#40527f', cLit: '#48577f', cDark: '#141c39', water: '#0b1228',
      glowAmt: 0.0, stars: 0.85, moon: 0.85, mist: 0.6, light: 0.15, cloud: 0.0 },
    { p: 0.55, name: 'night',
      zen: '#080e26', mid: '#14224a', hor: '#2c4170', sun: '#ffcf8c', glow: '#8090c0',
      far: '#2e3f6c', near: '#070b19', haze: '#465c8a', cLit: '#7383ab', cDark: '#18213f', water: '#0a1129',
      glowAmt: 0.0, stars: 1.0, moon: 1.0, mist: 0.55, light: 0.25, cloud: -0.02 },
    { p: 0.70, name: 'late night',
      zen: '#0a1029', mid: '#17244b', hor: '#30426f', sun: '#ffcf8c', glow: '#8090c0',
      far: '#2d3c68', near: '#080c1b', haze: '#44567f', cLit: '#5f6e98', cDark: '#161e3b', water: '#0b1229',
      glowAmt: 0.0, stars: 0.95, moon: 0.9, mist: 0.65, light: 0.2, cloud: 0.02 },
    { p: 0.78, name: 'pre-dawn',
      zen: '#1a2652', mid: '#3c4d85', hor: '#9a8db0', sun: '#ffd8a8', glow: '#e2a0a6',
      far: '#4c5a8b', near: '#0f142e', haze: '#8890b8', cLit: '#a69dc2', cDark: '#2f365e', water: '#161f43',
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

  // Pass 1: ridge heights. Row r holds ridge r (0 = farthest). Heights are screen-uv y.
  // RG = packed height, B = fine slope (±8), A = coarse slope (±2), slopes in dy/dX where
  // X is measured in screen heights.
  var RIDGE_FS = [
    'varying vec2 v_uv;',
    'uniform float uAspect;',
    'uniform float uTexW;',
    'uniform float uPx;        // screen heights per canvas pixel',
    'uniform vec4 uDriftA;     // ridges 0..3 horizontal offsets (screen heights)',
    'uniform float uDriftB;    // ridge 4',
    'uniform vec4 uSalt;',
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
    '    float hh = hgt * (0.5 + 0.5 * r2);',
    '    float w = 0.40 + 0.22 * r1;',
    '    float q = clamp(1.0 - abs(f - cx) / w, 0.0, 1.0);',
    '    best = max(best, hh * pow(q, 1.2));',
    '  }',
    '  float m = smoothstep(-0.55, 0.05, snoise(vec2(x * 0.75, salt * 0.37)));',
    '  float lod = smoothstep(2.0, 4.5, cell / uPx);',
    '  return m * mix(hgt * 0.35, best, lod);',
    '}',
    '',
    '// Each returns the full height; c receives the coarse (big-shape) height.',
    'float ridge0(float x, out float c) {',
    '  float b = snoise(vec2(x * 0.42, 1.7 + uSalt.x));',
    '  float r1 = 1.0 - abs(snoise(vec2(x * 1.05, 4.1 + uSalt.x)));',
    '  c = 0.535 + 0.045 * b + 0.07 * r1 * r1;',
    '  float r2 = 1.0 - abs(snoise(vec2(x * 2.7, 7.3 + uSalt.x)));',
    '  return c + 0.02 * r2 * r2 - 0.008 + 0.004 * snoise(vec2(x * 7.0, 9.9 + uSalt.x));',
    '}',
    'float ridge1(float x, out float c) {',
    '  float b = snoise(vec2(x * 0.6, 2.3 + uSalt.y));',
    '  float r1 = 1.0 - abs(snoise(vec2(x * 1.5, 5.2 + uSalt.y)));',
    '  c = 0.462 + 0.03 * b + 0.04 * r1 * r1;',
    '  return c + 0.008 * snoise(vec2(x * 4.0, 8.1 + uSalt.y)) + 0.002 * snoise(vec2(x * 11.0, 3.3 + uSalt.y));',
    '}',
    'float ridge2(float x, out float c) {',
    '  c = 0.412 + 0.024 * snoise(vec2(x * 0.9, 6.6 + uSalt.z)) + 0.012 * snoise(vec2(x * 2.2, 1.1 + uSalt.z));',
    '  return c + 0.004 * snoise(vec2(x * 6.0, 2.9 + uSalt.z));',
    '}',
    'float ridge3(float x, out float c) {',
    '  c = 0.370 + 0.018 * snoise(vec2(x * 1.2, 3.8 + uSalt.w)) + 0.008 * snoise(vec2(x * 3.0, 9.4 + uSalt.w));',
    '  return c + trees(x, 0.0062, 0.011, uSalt.w + 21.0);',
    '}',
    'float ridge4(float x, out float c) {',
    '  c = 0.322 + 0.008 * snoise(vec2(x * 1.4, 7.7 + uSalt.x * 0.5))',
    '      + 0.045 * smoothstep(0.35, 1.0, snoise(vec2(x * 0.28, 3.3 + uSalt.y * 0.5)));',
    '  return c + trees(x, 0.0090, 0.018, uSalt.z + 47.0);',
    '}',
    'float ridgeAt(float row, float x, out float c) {',
    '  if (row < 0.5) return ridge0(x + uDriftA.x, c);',
    '  if (row < 1.5) return ridge1(x + uDriftA.y, c);',
    '  if (row < 2.5) return ridge2(x + uDriftA.z, c);',
    '  if (row < 3.5) return ridge3(x + uDriftA.w, c);',
    '  return ridge4(x + uDriftB, c);',
    '}',
    '',
    'void main() {',
    '  float row = floor(v_uv.y * ' + RIDGE_ROWS.toFixed(1) + ');',
    '  if (row > 4.5) { gl_FragColor = vec4(0.0); return; }',
    '  float X = (v_uv.x - 0.5) * uAspect;',
    '  float e = 0.5 * uAspect / uTexW;',
    '  float c, cl, cr;',
    '  float h = ridgeAt(row, X, c);',
    '  float hl = ridgeAt(row, X - e, cl);',
    '  float hr = ridgeAt(row, X + e, cr);',
    '  float sf = (hr - hl) / (2.0 * e);',
    '  float sc = (cr - cl) / (2.0 * e);',
    '  gl_FragColor = vec4(pack16(h), clamp(0.5 + sf / 16.0, 0.0, 1.0), clamp(0.5 + sc / 4.0, 0.0, 1.0));',
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
    'uniform vec4 uAmt;        // stars, mist, ridge light, cloud cover bias',
    'uniform vec2 uLight;      // light source position (X, y)',
    'uniform vec4 uCloudOff;',
    'uniform vec4 uMistOff;',
    'uniform float uOct;',
    'uniform float uSalt;',
    GLSL_PACK,
    '',
    'vec3 mixL(vec3 a, vec3 b, float t) { return sqrt(mix(a * a, b * b, t)); }   // mix in ~linear light',
    'vec3 screen(vec3 a, vec3 b) { return 1.0 - (1.0 - a) * (1.0 - clamp(b, 0.0, 1.0)); }',
    '',
    'float fbmq(vec2 p) {',
    '  float s = 0.0, a = 0.5;',
    '  for (int i = 0; i < 6; i++) {',
    '    if (float(i) >= uOct) break;',
    '    s += a * snoise(p);',
    '    p = p * 2.07 + vec2(13.1, 7.7);',
    '    a *= 0.5;',
    '  }',
    '  return s;',
    '}',
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
    'float cloudField(vec2 P) {',
    '  vec2 q = vec2(P.x * 0.9 + uCloudOff.x, P.y * 5.0 + uCloudOff.y);',
    '  q.x += 0.6 * snoise(q * vec2(0.35, 0.6) + uCloudOff.zw);',
    '  float env = smoothstep(0.60, 0.74, P.y) * smoothstep(1.04, 0.86, P.y);',
    '  return fbmq(q) * 0.9 + (env - 1.0) * 0.8 + uAmt.w;',
    '}',
    '',
    'void main() {',
    '  float y = mix(uWater, 1.0, v_uv.y);',
    '  float X = (v_uv.x - 0.5) * uAspect;',
    '  vec2 P = vec2(X, y);',
    '',
    '  // sky',
    '  vec3 lo = mixL(uHor, uMid, smoothstep(0.46, 0.78, y));',
    '  vec3 col = mixL(lo, uZen, smoothstep(0.64, 1.05, y));',
    '',
    '  // sun glow (screen-blended: soft, never clips)',
    '  vec2 S = uSun.xy;',
    '  float ds = length(P - S);',
    '  float glow = uSun.w * (0.50 * exp(-ds * 16.0) + 0.32 * exp(-ds * 4.5)',
    '             + 0.22 * exp(-length((P - S) * vec2(0.35, 2.2)) * 3.0));',
    '  col = screen(col, uGlowCol * glow);',
    '',
    '  // stars',
    '  if (uAmt.x > 0.001) {',
    '    float vs = max(1.0, 700.0 / uCss.y);',
    '    vec2 spx = vec2(v_uv.x, y) * uCss * vs;',
    '    float fl = 0.35 / (vs * vs);',
    '    vec3 st = starLayer(spx, uPr / vs, fl, 9.0, 0.22, 0.45, 0.10, uSalt)',
    '            + starLayer(spx, uPr / vs, fl, 34.0, 0.30, 0.65, 0.55, uSalt + 17.0);',
    '    col += st * uAmt.x * smoothstep(0.5, 0.75, y);',
    '  }',
    '',
    '  // moon',
    '  vec2 M = uMoon.xy;',
    '  float dm = length(P - M);',
    '  if (uMoon.w > 0.001) {',
    '    float mg = uMoon.w * (0.20 * exp(-dm * 26.0) + 0.12 * exp(-dm * 6.0));',
    '    col = screen(col, vec3(0.62, 0.70, 0.88) * mg);',
    '    float md = smoothstep(uMoon.z + uPx, uMoon.z - uPx, dm);',
    '    if (md > 0.0) {',
    '      vec2 mq = (P - M) / uMoon.z;',
    '      float mare = snoise(mq * 1.4 + 7.0) * 0.6 + snoise(mq * 3.3 + 2.0) * 0.3;',
    '      vec3 mc = vec3(0.97, 0.96, 0.91) * (0.95 - 0.09 * smoothstep(-0.1, 0.6, mare));',
    '      col = mix(col, mc, md * uMoon.w);',
    '    }',
    '  }',
    '',
    '  // sun disc',
    '  float sd = smoothstep(uSun.z + 1.2 * uPx, uSun.z - 1.2 * uPx, ds);',
    '  col = mix(col, uSunCol, sd);',
    '',
    '  // clouds',
    '  if (y > 0.58) {',
    '    float d = cloudField(P);',
    '    float a = smoothstep(0.0, 0.2, d);',
    '    if (a > 0.0) {',
    '      vec2 toL = normalize(uLight - P + vec2(0.0001, 0.0));',
    '      float dl = cloudField(P + toL * 0.03);',
    '      float lit = clamp(0.5 + (d - dl) * 3.0, 0.0, 1.0);',
    '      vec3 cc = mixL(uCloudDark, uCloudLit, lit);',
    '      cc = screen(cc, uGlowCol * uSun.w * 0.55 * exp(-ds * 5.0));',
    '      col = mix(col, cc, a * 0.92);',
    '    }',
    '  }',
    '',
    '  // ridges, far → near, with mist drifting in each valley',
    '  for (int i = 0; i < 5; i++) {',
    '    float fi = float(i);',
    '    float k = fi / 4.0;',
    '    vec4 r = texture2D(uRidge, vec2(v_uv.x, (fi + 0.5) / ' + RIDGE_ROWS.toFixed(1) + '));',
    '    float h = unpack16(r.rg);',
    '    float sf = (r.b - 0.5) * 16.0;',
    '    float sc = (r.a - 0.5) * 4.0;',
    '    float dd = h - y;',
    '    float cov = clamp(dd / (uPx * sqrt(1.0 + sf * sf)) + 0.5, 0.0, 1.0);',
    '    float c = 0.455 - 0.045 * fi;   // valley floor in front of this ridge',
    '    if (cov > 0.0) {',
    '      vec3 rc = mixL(uFar, uNear, pow(k, 0.8));',
    '      float fog = smoothstep(c + 0.08, c - 0.01, y) * uAmt.y * mix(0.7, 0.35, k);',
    '      rc = mixL(rc, uHaze, fog);',
    '      float side = sign(uLight.x - X);',
    '      float sl = mix(clamp(sf, -2.0, 2.0), sc, smoothstep(0.0, 0.02, dd));',
    '      float lit = smoothstep(-0.25, 0.25, -sl * side) * exp(-dd * 9.0);',
    '      rc = mixL(rc, rc * 1.22 + uGlowCol * 0.12, lit * uAmt.z * (1.0 - 0.75 * k));',
    '      float rim = exp(-dd / 0.0035) * exp(-ds * 4.0) * uSun.w * (1.0 - 0.8 * k);',
    '      rc = screen(rc, uGlowCol * rim * 0.5);',
    '      col = mix(col, rc, cov);',
    '    }',
    '    if (i < 4) {',
    '      float band = smoothstep(c + 0.06, c, y) * smoothstep(c - 0.05, c - 0.01, y);',
    '      if (band > 0.001) {',
    '        vec2 mq = vec2(X * 1.3 + uMistOff.x * (1.0 + fi * 0.35) + fi * 17.0, y * 22.0 + fi * 5.1 + uMistOff.y);',
    '        float n = snoise(mq) * 0.6 + snoise(mq * vec2(2.3, 1.7) + vec2(uMistOff.z, 0.0)) * 0.3;',
    '        float a = band * smoothstep(-0.25, 0.55, n + (band - 0.5) * 0.6) * uAmt.y * 0.55;',
    '        vec3 mc = screen(uHaze, uGlowCol * exp(-ds * 3.0) * uSun.w * 0.4);',
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
    'uniform vec2 uRes;',
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
    '// how much of a light at (X, y) is visible over the ridges',
    'float overRidges(vec2 L, float r) {',
    '  float u = L.x / uAspect + 0.5;',
    '  float top = 0.0;',
    '  for (int i = 0; i < 5; i++) top = max(top, unpack16(texture2D(uRidge, vec2(u, (float(i) + 0.5) / 8.0)).rg));',
    '  return smoothstep(-r, r, L.y - top) * step(0.0, u) * step(u, 1.0);',
    '}',
    '',
    'float glitter(float xl, float zl, float dep, float X, float cx, float lodf) {',
    '  float w = 0.012 + dep * 0.22;',
    '  float col = exp(-(X - cx) * (X - cx) / (w * w));',
    '  if (col < 0.002) return 0.0;',
    '  float s = snoise(vec2(xl * 1.3, zl * 7.0 + uT * 0.22));',
    '  float s2 = snoise(vec2(xl * 3.1 + 4.0, zl * 15.0 - uT * 0.17));',
    '  float dash = smoothstep(0.25, 0.8, s * 0.7 + s2 * 0.4);',
    '  return col * mix(0.22, dash, lodf);',
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
    '    float amp = dep * (0.7 + 0.6 * wind);',
    '    vec2 off = vec2((0.010 * n1 + 0.004 * n2) * amp, (0.035 * n1 + 0.016 * n2) * amp);',
    '    float above = max(dep + off.y, 0.0);',
    '    vec2 ruv = vec2(uv.x + off.x / uAspect, 0.0);',
    '    float b = (0.0015 + dep * 0.02);',
    '    vec3 refl = scene(ruv, above) * 0.4 + scene(ruv, above + b) * 0.3 + scene(ruv, max(above - b, 0.0)) * 0.3;',
    '    float fres = mix(0.9, 0.6, smoothstep(0.0, 0.3, dep));',
    '    col = mix(uWaterCol, refl * vec3(0.9, 0.93, 0.97), fres);',
    '    col = mix(col, col * 1.06 + uHaze * 0.04, wind * 0.6);',
    '',
    '    // glitter paths under the sun and the moon',
    '    float lodG = clamp(1.6 - dz * 12.0, 0.0, 1.0);',
    '    float fall = exp(-dep * 5.0);',
    '    if (uSun.w > 0.01) {',
    '      float g = glitter(xl, zl, dep, X, uSun.x, lodG);',
    '      if (g > 0.0) col += uSunCol * g * fall * uSun.w * 0.55 * overRidges(uSun.xy, uSun.z);',
    '    }',
    '    if (uMoon.w > 0.01) {',
    '      float g = glitter(xl, zl, dep, X, uMoon.x, lodG);',
    '      if (g > 0.0) col += vec3(0.75, 0.8, 0.9) * g * fall * uMoon.w * 0.3 * overRidges(uMoon.xy, uMoon.z);',
    '    }',
    '',
    '    // mist lying on the water along the far shore',
    '    float mn = snoise(vec2(X * 1.1 + uT * 0.004, 0.5)) * 0.5 + 0.5;',
    '    col = mix(col, uHaze, exp(-dep / 0.018) * uMist * 0.28 * (0.5 + 0.5 * mn));',
    '    // a faint bright line where the water meets the shore',
    '    col = mix(col, uHaze, 0.18 * (1.0 - smoothstep(0.0, 2.5 * uPx, dep)));',
    '  }',
    '',
    '  // vignette, paper grain, dither',
    '  vec2 vq = (uv - 0.5) * vec2(uAspect / 1.6, 1.0);',
    '  col *= mix(1.0, 0.82, smoothstep(0.35, 0.95, length(vq)));',
    '  float g = hash12(floor(gl_FragCoord.xy * 0.5) + 41.0) - 0.5;',
    '  col *= 1.0 + g * 0.035;',
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
              .set('uSalt', salt);
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
              .set('uAmt', [pal.stars, pal.mist, light, pal.cloud + 0.05 * Math.sin(T * 0.0021 + cloudSeed[3])])
              .set('uLight', [lightX, lightY])
              .set('uCloudOff', [cloudSeed[0] + T * CLOUD_DRIFT * 0.9, cloudSeed[1] + T * 0.00035, cloudSeed[2] + T * 0.0016, T * 0.0011])
              .set('uMistOff', [mistSeed + T * MIST_DRIFT, T * 0.0009, T * 0.006, 0])
              .set('uOct', q.oct)
              .set('uSalt', starSalt);
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
            .set('uRes', [w, h])
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
