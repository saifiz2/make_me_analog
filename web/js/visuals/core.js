/*
 * Analog Brick — visuals core.
 * Plain script; defines window.BrickVisuals. Load this before any mode file.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WRITING A MODE
 * ─────────────────────────────────────────────────────────────────────────────
 *   BrickVisuals.register({
 *     id: 'aurora',                 // stable id, used in settings and the bridge
 *     name: 'Aurora',               // short display name
 *     tagline: 'Northern lights over a quiet sky',
 *     order: 10,                    // sort order in pickers
 *     context: 'webgl',             // 'webgl' (GLSL ES 1.00) | 'webgl2' (GLSL ES 3.00) | '2d' | 'none'
 *     renderScale: { saver: 0.4, balanced: 0.6, high: 0.85 },  // optional; fraction of device pixels
 *     musicReactive: false,         // true if the mode is driven by env.audio
 *     create: function (env) {
 *       // set up; return an instance
 *       return {
 *         resize: function (width, height, pixelRatio) {},  // canvas already resized by core
 *         render: function (t, dt) {},                     // t = seconds since this mode appeared
 *         destroy: function () {}                          // free GL objects, timers, DOM in env.overlay
 *       };
 *     }
 *   });
 *
 * env (passed to create; fields marked * are live and updated in place):
 *   canvas        HTMLCanvasElement, already sized (hidden when context === 'none')
 *   gl            WebGLRenderingContext / WebGL2RenderingContext, or null
 *   ctx           CanvasRenderingContext2D, or null
 *   overlay       HTMLElement stacked above the canvas for DOM content (pointer-events: none)
 *   width*, height*        canvas size in device pixels (after renderScale)
 *   cssWidth*, cssHeight*  size in CSS pixels
 *   pixelRatio*   device pixels per CSS pixel actually used (devicePixelRatio × renderScale)
 *   quality*      'saver' | 'balanced' | 'high'
 *   audio*        live audio state (see below)
 *   palette*      { colors: ['#rrggbb', …], rgb: [[r,g,b] 0…1, …], fromArtwork: bool, version: n }
 *   seed          integer seed (stable per display, so displays differ subtly)
 *   displayIndex  0 for the primary display
 *   options*      mode options from settings, e.g. { breathPattern: 'box', images: [...] }
 *   util          BrickVisuals.util (math, noise, GL helpers, GLSL chunks)
 *
 * env.audio (smoothed by core every frame; all values 0…1 unless noted):
 *   available  real audio frames are arriving from native
 *   synthetic  values are synthesised (Spotify playing but no audio capture)
 *   playing    Spotify reports it is playing
 *   level, bass, mid, treble, energy (slow average of level)
 *   beat       1 on a detected beat, decays to 0 over ~0.3 s
 *   beatCount  integer, increments on every beat
 *   bands      Float32Array(32) log-spaced, low → high
 *
 * Rules for modes:
 *   • Calm first: slow motion, no strobing, no hard flashes, low contrast edges.
 *   • No network, no external files. Everything procedural or from env.options.
 *   • Must run in Safari/WKWebView (macOS 13+) and Chromium. WebGL1 GLSL ES 1.00 is safest.
 *   • Respect env.quality (fewer octaves/particles in 'saver').
 *   • Must not throw on resize to tiny sizes (e.g. 200×120 thumbnails).
 *   • Clean up everything in destroy(); the core also loses the GL context afterwards.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOSTING A STAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *   var stage = BrickVisuals.mount(containerEl, {
 *     mode: 'aurora', quality: 'balanced', seed: 1, displayIndex: 0,
 *     options: { breathPattern: 'box' },
 *     freeze: null,      // number → render a still at that t (screenshots)
 *     timeScale: 1,      // >1 speeds time up (previews)
 *     fps: null          // override the fps cap
 *   });
 *   stage.setMode('night', { transition: 1600 });   // crossfade, ms
 *   stage.setQuality('saver');
 *   stage.setAudioFrame({ bands, level, bass, mid, treble, beat });  // from the bridge 'audio' event
 *   stage.setPlaying(true);                           // from the bridge 'spotify' event
 *   stage.setPalette(['#223344', …]);                 // from the bridge 'artwork' event ([] resets)
 *   stage.setOptions({ images: [...] });               // merged into env.options
 *   stage.pause(); stage.resume(); stage.destroy();
 *   stage.mode  → current mode id
 *   stage.fps   → measured frames per second
 */
(function (global) {
  'use strict';

  var registry = new Map();

  var QUALITY = {
    saver:    { fps: 30, scale: 0.5 },
    balanced: { fps: 60, scale: 0.75 },
    high:     { fps: 60, scale: 1.0 }
  };
  var MAX_CANVAS_DIM = 4096;
  var NUM_BANDS = 32;

  // ───────────────────────────── math ─────────────────────────────
  function clamp(x, a, b) { if (a === undefined) { a = 0; b = 1; } return x < a ? a : x > b ? b : x; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
  function fract(x) { return x - Math.floor(x); }
  /** Frame-rate independent exponential approach factor. */
  function damp(rate, dt) { return 1 - Math.exp(-rate * dt); }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hexToRgb(hex) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return [0, 0, 0];
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function rgbToHex(rgb) {
    return '#' + rgb.map(function (v) {
      var s = Math.round(clamp(v, 0, 1) * 255).toString(16);
      return s.length === 1 ? '0' + s : s;
    }).join('');
  }
  /** h in 0…1, s,l in 0…1 → [r,g,b] 0…1 */
  function hslToRgb(h, s, l) {
    h = fract(h);
    function f(n) {
      var k = (n + h * 12) % 12;
      var a = s * Math.min(l, 1 - l);
      return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    }
    return [f(0), f(8), f(4)];
  }
  function mixRgb(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  function luminance(rgb) { return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]; }

  var easing = {
    inOutSine: function (t) { return -(Math.cos(Math.PI * t) - 1) / 2; },
    inOutCubic: function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
    outCubic: function (t) { return 1 - Math.pow(1 - t, 3); },
    inOutQuad: function (t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  };

  // ───────────────────── simplex noise (JS, Gustavson) ─────────────────────
  var GRAD3 = [
    [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
    [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
    [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]
  ];
  var F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
  var F3 = 1 / 3, G3 = 1 / 6;

  /** Returns { noise2D(x,y), noise3D(x,y,z), fbm2D(x,y,octaves), fbm3D(x,y,z,octaves) } in about −1…1. */
  function createNoise(seed) {
    var rand = mulberry32(seed == null ? 1 : seed);
    var p = new Uint8Array(256);
    for (var i = 0; i < 256; i++) p[i] = i;
    for (i = 255; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var tmp = p[i]; p[i] = p[j]; p[j] = tmp;
    }
    var perm = new Uint8Array(512), permMod12 = new Uint8Array(512);
    for (i = 0; i < 512; i++) { perm[i] = p[i & 255]; permMod12[i] = perm[i] % 12; }

    function noise2D(xin, yin) {
      var n0 = 0, n1 = 0, n2 = 0;
      var s = (xin + yin) * F2;
      var i = Math.floor(xin + s), j = Math.floor(yin + s);
      var t = (i + j) * G2;
      var x0 = xin - (i - t), y0 = yin - (j - t);
      var i1, j1;
      if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
      var x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
      var x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
      var ii = i & 255, jj = j & 255;
      var t0 = 0.5 - x0 * x0 - y0 * y0;
      if (t0 >= 0) { var g0 = GRAD3[permMod12[ii + perm[jj]]]; t0 *= t0; n0 = t0 * t0 * (g0[0] * x0 + g0[1] * y0); }
      var t1 = 0.5 - x1 * x1 - y1 * y1;
      if (t1 >= 0) { var g1 = GRAD3[permMod12[ii + i1 + perm[jj + j1]]]; t1 *= t1; n1 = t1 * t1 * (g1[0] * x1 + g1[1] * y1); }
      var t2 = 0.5 - x2 * x2 - y2 * y2;
      if (t2 >= 0) { var g2 = GRAD3[permMod12[ii + 1 + perm[jj + 1]]]; t2 *= t2; n2 = t2 * t2 * (g2[0] * x2 + g2[1] * y2); }
      return 70 * (n0 + n1 + n2);
    }

    function noise3D(xin, yin, zin) {
      var n0, n1, n2, n3;
      var s = (xin + yin + zin) * F3;
      var i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
      var t = (i + j + k) * G3;
      var x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);
      var i1, j1, k1, i2, j2, k2;
      if (x0 >= y0) {
        if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
        else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
        else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
      } else {
        if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
        else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
        else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      }
      var x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
      var x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
      var x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
      var ii = i & 255, jj = j & 255, kk = k & 255;
      var t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
      if (t0 < 0) n0 = 0; else { var g0 = GRAD3[permMod12[ii + perm[jj + perm[kk]]]]; t0 *= t0; n0 = t0 * t0 * (g0[0] * x0 + g0[1] * y0 + g0[2] * z0); }
      var t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
      if (t1 < 0) n1 = 0; else { var g1 = GRAD3[permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]]]; t1 *= t1; n1 = t1 * t1 * (g1[0] * x1 + g1[1] * y1 + g1[2] * z1); }
      var t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
      if (t2 < 0) n2 = 0; else { var g2 = GRAD3[permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]]]; t2 *= t2; n2 = t2 * t2 * (g2[0] * x2 + g2[1] * y2 + g2[2] * z2); }
      var t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
      if (t3 < 0) n3 = 0; else { var g3 = GRAD3[permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]]]; t3 *= t3; n3 = t3 * t3 * (g3[0] * x3 + g3[1] * y3 + g3[2] * z3); }
      return 32 * (n0 + n1 + n2 + n3);
    }

    function fbm2D(x, y, octaves) {
      var sum = 0, amp = 0.5, freq = 1, norm = 0;
      octaves = octaves || 4;
      for (var o = 0; o < octaves; o++) { sum += amp * noise2D(x * freq, y * freq); norm += amp; amp *= 0.5; freq *= 2.03; }
      return sum / norm;
    }
    function fbm3D(x, y, z, octaves) {
      var sum = 0, amp = 0.5, freq = 1, norm = 0;
      octaves = octaves || 4;
      for (var o = 0; o < octaves; o++) { sum += amp * noise3D(x * freq, y * freq, z * freq); norm += amp; amp *= 0.5; freq *= 2.03; }
      return sum / norm;
    }

    return { noise2D: noise2D, noise3D: noise3D, fbm2D: fbm2D, fbm3D: fbm3D };
  }

  // ───────────────────────────── GLSL chunks ─────────────────────────────
  // Simplex noise: Ashima Arts / Stefan Gustavson, MIT License
  // (https://github.com/ashima/webgl-noise). Works in GLSL ES 1.00 and 3.00.
  var GLSL_NOISE = [
    'vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }',
    'vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }',
    'vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }',
    'vec3 permute(vec3 x) { return mod289(((x * 34.0) + 10.0) * x); }',
    'vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }',
    'vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }',
    '',
    '// 2D simplex noise, about -1..1',
    'float snoise(vec2 v) {',
    '  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);',
    '  vec2 i  = floor(v + dot(v, C.yy));',
    '  vec2 x0 = v - i + dot(i, C.xx);',
    '  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);',
    '  vec4 x12 = x0.xyxy + C.xxzz;',
    '  x12.xy -= i1;',
    '  i = mod289(i);',
    '  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));',
    '  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);',
    '  m = m * m; m = m * m;',
    '  vec3 x = 2.0 * fract(p * C.www) - 1.0;',
    '  vec3 h = abs(x) - 0.5;',
    '  vec3 ox = floor(x + 0.5);',
    '  vec3 a0 = x - ox;',
    '  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);',
    '  vec3 g;',
    '  g.x = a0.x * x0.x + h.x * x0.y;',
    '  g.yz = a0.yz * x12.xz + h.yz * x12.yw;',
    '  return 130.0 * dot(m, g);',
    '}',
    '',
    '// 3D simplex noise, about -1..1',
    'float snoise(vec3 v) {',
    '  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);',
    '  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);',
    '  vec3 i  = floor(v + dot(v, C.yyy));',
    '  vec3 x0 = v - i + dot(i, C.xxx);',
    '  vec3 g = step(x0.yzx, x0.xyz);',
    '  vec3 l = 1.0 - g;',
    '  vec3 i1 = min(g.xyz, l.zxy);',
    '  vec3 i2 = max(g.xyz, l.zxy);',
    '  vec3 x1 = x0 - i1 + C.xxx;',
    '  vec3 x2 = x0 - i2 + C.yyy;',
    '  vec3 x3 = x0 - D.yyy;',
    '  i = mod289(i);',
    '  vec4 p = permute(permute(permute(',
    '            i.z + vec4(0.0, i1.z, i2.z, 1.0))',
    '          + i.y + vec4(0.0, i1.y, i2.y, 1.0))',
    '          + i.x + vec4(0.0, i1.x, i2.x, 1.0));',
    '  float n_ = 0.142857142857;',
    '  vec3 ns = n_ * D.wyz - D.xzx;',
    '  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);',
    '  vec4 x_ = floor(j * ns.z);',
    '  vec4 y_ = floor(j - 7.0 * x_);',
    '  vec4 x = x_ * ns.x + ns.yyyy;',
    '  vec4 y = y_ * ns.x + ns.yyyy;',
    '  vec4 h = 1.0 - abs(x) - abs(y);',
    '  vec4 b0 = vec4(x.xy, y.xy);',
    '  vec4 b1 = vec4(x.zw, y.zw);',
    '  vec4 s0 = floor(b0) * 2.0 + 1.0;',
    '  vec4 s1 = floor(b1) * 2.0 + 1.0;',
    '  vec4 sh = -step(h, vec4(0.0));',
    '  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;',
    '  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;',
    '  vec3 p0 = vec3(a0.xy, h.x);',
    '  vec3 p1 = vec3(a0.zw, h.y);',
    '  vec3 p2 = vec3(a1.xy, h.z);',
    '  vec3 p3 = vec3(a1.zw, h.w);',
    '  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));',
    '  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;',
    '  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);',
    '  m = m * m;',
    '  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));',
    '}',
    '',
    '// Fractal sums. FBM_OCTAVES may be #defined before including this chunk (default 5).',
    '#ifndef FBM_OCTAVES',
    '#define FBM_OCTAVES 5',
    '#endif',
    'float fbm(vec2 p) {',
    '  float s = 0.0, a = 0.5;',
    '  for (int i = 0; i < FBM_OCTAVES; i++) { s += a * snoise(p); p = p * 2.03 + vec2(17.13, 3.71); a *= 0.5; }',
    '  return s;',
    '}',
    'float fbm(vec3 p) {',
    '  float s = 0.0, a = 0.5;',
    '  for (int i = 0; i < FBM_OCTAVES; i++) { s += a * snoise(p); p = p * 2.03 + vec3(17.13, 3.71, 9.27); a *= 0.5; }',
    '  return s;',
    '}'
  ].join('\n');

  var GLSL_COMMON = [
    '#define PI 3.14159265359',
    '#define TAU 6.28318530718',
    'float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }',
    'float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }',
    'vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }',
    'mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }',
    '// Inigo Quilez cosine palette',
    'vec3 iqPalette(float t, vec3 a, vec3 b, vec3 c, vec3 d) { return a + b * cos(TAU * (c * t + d)); }',
    '// Cheap filmic-ish tonemap that keeps darks deep',
    'vec3 tonemap(vec3 c) { c = max(c, 0.0); return c / (1.0 + c * 0.35); }',
    '// Ordered-ish dither to kill banding in dark gradients; pass gl_FragCoord.xy',
    'vec3 dither(vec3 c, vec2 fragCoord) { return c + (hash12(fragCoord) - 0.5) / 255.0; }'
  ].join('\n');

  // Full-screen triangle vertex shaders. Attribute a_pos is bound to location 0.
  // v_uv is 0…1 across the canvas (origin bottom-left).
  var FULLSCREEN_VS = [
    'attribute vec2 a_pos;',
    'varying vec2 v_uv;',
    'void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }'
  ].join('\n');
  var FULLSCREEN_VS_300 = [
    '#version 300 es',
    'in vec2 a_pos;',
    'out vec2 v_uv;',
    'void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }'
  ].join('\n');

  // ───────────────────────────── GL helpers ─────────────────────────────
  function numbered(src) {
    return src.split('\n').map(function (l, i) { return (i + 1 + '').padStart(4, ' ') + '  ' + l; }).join('\n');
  }

  function compileShader(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('Shader compile failed:\n' + log + '\n' + numbered(src));
    }
    return sh;
  }

  /**
   * Build a program. Returns {
   *   program, use(), set(name, ...values|array), loc(name), attrib(name), destroy()
   * }. set() infers the GL call from the uniform's declared type; unknown names are ignored
   * (so optimised-out uniforms never throw). Attribute "a_pos" is bound to location 0.
   */
  function createProgram(gl, vsSrc, fsSrc, attribs) {
    var vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
    var fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'a_pos');
    if (attribs) Object.keys(attribs).forEach(function (n) { gl.bindAttribLocation(prog, attribs[n], n); });
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
      var log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error('Program link failed: ' + log);
    }
    var uniforms = {};
    var count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) || 0;
    for (var i = 0; i < count; i++) {
      var info = gl.getActiveUniform(prog, i);
      if (!info) continue;
      var name = info.name.replace(/\[0\]$/, '');
      uniforms[name] = { loc: gl.getUniformLocation(prog, info.name), type: info.type, size: info.size };
    }
    var api = {
      program: prog,
      uniforms: uniforms,
      use: function () { gl.useProgram(prog); return api; },
      loc: function (n) { return uniforms[n] ? uniforms[n].loc : null; },
      attrib: function (n) { return gl.getAttribLocation(prog, n); },
      set: function (name) {
        var u = uniforms[name];
        if (!u) return api;
        var a = arguments, v = a.length === 2 ? a[1] : Array.prototype.slice.call(a, 1);
        var arr = (typeof v === 'number' || typeof v === 'boolean') ? null : v;
        switch (u.type) {
          case gl.FLOAT: if (u.size > 1 && arr) gl.uniform1fv(u.loc, arr); else gl.uniform1f(u.loc, +(arr ? arr[0] : v)); break;
          case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, arr); break;
          case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, arr); break;
          case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, arr); break;
          case gl.INT: case gl.BOOL: case gl.SAMPLER_2D: case gl.SAMPLER_CUBE:
            if (u.size > 1 && arr) gl.uniform1iv(u.loc, arr); else gl.uniform1i(u.loc, (arr ? arr[0] : v) | 0); break;
          case gl.INT_VEC2: gl.uniform2iv(u.loc, arr); break;
          case gl.INT_VEC3: gl.uniform3iv(u.loc, arr); break;
          case gl.INT_VEC4: gl.uniform4iv(u.loc, arr); break;
          case gl.FLOAT_MAT2: gl.uniformMatrix2fv(u.loc, false, arr); break;
          case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, arr); break;
          case gl.FLOAT_MAT4: gl.uniformMatrix4fv(u.loc, false, arr); break;
          default: break;
        }
        return api;
      },
      destroy: function () { gl.deleteProgram(prog); }
    };
    return api;
  }

  /** A single big triangle covering the viewport. Returns { draw(), destroy() }. Uses attribute location 0. */
  function fullscreenTriangle(gl) {
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    return {
      draw: function () {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
      destroy: function () { gl.deleteBuffer(buf); }
    };
  }

  /** Create an RGBA texture + framebuffer pair (for feedback / bloom passes). */
  function createRenderTarget(gl, w, h, opts) {
    opts = opts || {};
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    var filter = opts.nearest ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    var fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return {
      texture: tex, framebuffer: fb, width: w, height: h,
      bind: function () { gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(0, 0, w, h); },
      destroy: function () { gl.deleteFramebuffer(fb); gl.deleteTexture(tex); }
    };
  }

  // ───────────────────────────── audio ─────────────────────────────
  function createAudioState() {
    return {
      available: false, synthetic: false, playing: false,
      level: 0, bass: 0, mid: 0, treble: 0, energy: 0,
      beat: 0, beatCount: 0,
      bands: new Float32Array(NUM_BANDS)
    };
  }

  /** Plausible "music" when Spotify plays but we cannot hear it: ~104 BPM kick/snare/hat + drifting tones. */
  function createSynth(seed) {
    var noise = createNoise(seed + 99);
    var bpm = 104, lastBeatIndex = -1;
    return function synth(time, target) {
      var beatLen = 60 / bpm;
      var phase = time / beatLen;
      var beatIndex = Math.floor(phase);
      var bp = phase - beatIndex;              // 0…1 within the beat
      var isBeat = beatIndex !== lastBeatIndex;
      lastBeatIndex = beatIndex;
      var bar = beatIndex % 4;
      var kick = Math.exp(-bp * 7);
      var snare = (bar === 1 || bar === 3) ? Math.exp(-bp * 9) : 0;
      var hat = Math.exp(-fract(phase + 0.5) * 18) * 0.6;
      var swell = 0.5 + 0.5 * noise.noise2D(time * 0.05, 3.1);
      for (var i = 0; i < NUM_BANDS; i++) {
        var f = i / (NUM_BANDS - 1);
        var tone = 0.35 + 0.35 * noise.noise2D(i * 0.35, time * 0.4) + 0.2 * swell;
        var v = tone * (1 - f * 0.55);
        if (f < 0.2) v += kick * (1 - f * 4) * 0.9;
        if (f > 0.3 && f < 0.6) v += snare * 0.5;
        if (f > 0.7) v += hat * (f - 0.6);
        target.bands[i] = clamp(v * 0.8, 0, 1);
      }
      target.bass = clamp(0.25 + kick * 0.7 + swell * 0.1, 0, 1);
      target.mid = clamp(0.3 + snare * 0.45 + swell * 0.2, 0, 1);
      target.treble = clamp(0.15 + hat * 0.6, 0, 1);
      target.level = clamp((target.bass + target.mid + target.treble) / 3 + 0.1, 0, 1);
      return isBeat;
    };
  }

  // ───────────────────────────── fallback mode ─────────────────────────────
  // Used when a mode is missing, throws, or its GL context cannot be created.
  var FALLBACK = {
    id: '__fallback', name: 'Calm', tagline: '', order: 999, context: '2d',
    renderScale: { saver: 0.25, balanced: 0.3, high: 0.4 },
    create: function (env) {
      var ctx = env.ctx;
      return {
        resize: function () {},
        render: function (t) {
          if (!ctx) return;
          var w = env.width, h = env.height;
          ctx.fillStyle = '#05070c';
          ctx.fillRect(0, 0, w, h);
          var blobs = [[0.3, 0.4, 210], [0.7, 0.6, 260], [0.5, 0.3, 170]];
          for (var i = 0; i < blobs.length; i++) {
            var b = blobs[i];
            var x = (b[0] + 0.12 * Math.sin(t * 0.05 + i * 2)) * w;
            var y = (b[1] + 0.1 * Math.cos(t * 0.04 + i)) * h;
            var r = Math.max(w, h) * 0.5;
            var g = ctx.createRadialGradient(x, y, 0, x, y, r);
            g.addColorStop(0, 'hsla(' + b[2] + ',45%,35%,0.35)');
            g.addColorStop(1, 'hsla(' + b[2] + ',45%,20%,0)');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
          }
        },
        destroy: function () {}
      };
    }
  };

  // ───────────────────────────── stage ─────────────────────────────
  var stageCount = 0;

  function Stage(container, opts) {
    opts = opts || {};
    this.container = container;
    this.quality = QUALITY[opts.quality] ? opts.quality : 'balanced';
    this.seed = opts.seed != null ? opts.seed | 0 : 1;
    this.displayIndex = opts.displayIndex | 0;
    this.options = Object.assign({}, opts.options || {});
    this.freeze = (opts.freeze === 0 || opts.freeze) ? +opts.freeze : null;
    this.timeScale = opts.timeScale > 0 ? +opts.timeScale : 1;
    this.fpsOverride = opts.fps > 0 ? +opts.fps : null;
    this.onError = opts.onError || null;

    this.audio = createAudioState();
    this._audioTarget = createAudioState();
    this._lastAudioFrameAt = -1e9;
    this._synth = createSynth(this.seed);
    this.palette = { colors: [], rgb: [], fromArtwork: false, version: 0 };

    this.layers = [];
    this.mode = null;
    this.fps = 0;
    this._time = 0;
    this._fpsAcc = 0; this._fpsFrames = 0;
    this._lastNow = null; this._lastRender = 0;
    this._paused = false;
    this._destroyed = false;
    this._id = ++stageCount;

    var el = document.createElement('div');
    el.className = 'bv-stage';
    el.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#000;contain:strict;';
    container.appendChild(el);
    this.el = el;

    var self = this;
    this._loop = function (now) { self._frame(now); };
    this._onVisibility = function () {
      if (document.hidden) self._hiddenPause = true;
      else { self._hiddenPause = false; self._lastNow = null; }
    };
    document.addEventListener('visibilitychange', this._onVisibility);

    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(function () { self._resizeAll(); });
      this._ro.observe(el);
    } else {
      this._onWinResize = function () { self._resizeAll(); };
      global.addEventListener('resize', this._onWinResize);
    }

    if (opts.mode) this.setMode(opts.mode, { transition: opts.transition || 0 });
    this._raf = requestAnimationFrame(this._loop);
  }

  Stage.prototype._scaleFor = function (def) {
    var rs = def.renderScale && def.renderScale[this.quality];
    return rs > 0 ? rs : QUALITY[this.quality].scale;
  };

  Stage.prototype._measure = function (def) {
    var rect = this.el.getBoundingClientRect();
    var cssW = Math.max(1, Math.round(rect.width || this.container.clientWidth || 1));
    var cssH = Math.max(1, Math.round(rect.height || this.container.clientHeight || 1));
    var dpr = global.devicePixelRatio || 1;
    var ratio = dpr * this._scaleFor(def);
    var w = Math.max(1, Math.round(cssW * ratio));
    var h = Math.max(1, Math.round(cssH * ratio));
    var over = Math.max(w, h) / MAX_CANVAS_DIM;
    if (over > 1) { w = Math.max(1, Math.round(w / over)); h = Math.max(1, Math.round(h / over)); ratio /= over; }
    return { cssW: cssW, cssH: cssH, w: w, h: h, ratio: ratio };
  };

  Stage.prototype._makeLayer = function (def) {
    var layerEl = document.createElement('div');
    layerEl.className = 'bv-layer bv-mode-' + def.id;
    layerEl.style.cssText = 'position:absolute;inset:0;opacity:0;will-change:opacity;';
    var canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
    var overlay = document.createElement('div');
    overlay.className = 'bv-overlay';
    overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
    layerEl.appendChild(canvas);
    layerEl.appendChild(overlay);
    this.el.appendChild(layerEl);

    try {
      return this._initLayer(def, layerEl, canvas, overlay);
    } catch (err) {
      layerEl.remove();
      throw err;
    }
  };

  Stage.prototype._initLayer = function (def, layerEl, canvas, overlay) {
    var m = this._measure(def);
    canvas.width = m.w; canvas.height = m.h;

    var gl = null, ctx = null;
    var attrs = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'low-power' };
    if (def.context === 'webgl2') gl = canvas.getContext('webgl2', attrs);
    else if (def.context === 'webgl') gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
    else if (def.context === '2d') ctx = canvas.getContext('2d', { alpha: false });
    else if (def.context === 'none') canvas.style.display = 'none';

    if ((def.context === 'webgl' || def.context === 'webgl2') && !gl) {
      throw new Error('WebGL unavailable for mode "' + def.id + '"');
    }

    var env = {
      canvas: canvas, gl: gl, ctx: ctx, overlay: overlay,
      width: m.w, height: m.h, cssWidth: m.cssW, cssHeight: m.cssH, pixelRatio: m.ratio,
      quality: this.quality,
      audio: this.audio,
      palette: this.palette,
      seed: this.seed,
      displayIndex: this.displayIndex,
      options: this.options,
      util: BrickVisuals.util
    };
    var instance = def.create(env) || {};
    return { def: def, el: layerEl, canvas: canvas, overlay: overlay, env: env, instance: instance, gl: gl,
             born: this._time, fadeFrom: 0, fadeTo: 1, fadeStart: this._time, fadeDur: 0, dying: false, opacity: 0 };
  };

  Stage.prototype._buildLayer = function (def) {
    try {
      return this._makeLayer(def);
    } catch (err) {
      console.error('[visuals] mode "' + def.id + '" failed to start; using fallback.', err);
      if (this.onError) this.onError(err, def.id);
      return this._makeLayer(FALLBACK);
    }
  };

  /** Switch modes with a crossfade. */
  Stage.prototype.setMode = function (id, opts) {
    if (this._destroyed) return;
    var transition = opts && opts.transition != null ? opts.transition : 1600;
    var def = registry.get(id);
    if (!def) { console.warn('[visuals] unknown mode "' + id + '"; using fallback'); def = FALLBACK; }
    var live = this.layers.filter(function (l) { return !l.dying; });
    if (live.length && live[live.length - 1].def.id === def.id) return;
    this.mode = def.id;
    var layer = this._buildLayer(def);
    var dur = Math.max(0, transition) / 1000;
    layer.fadeStart = this._time; layer.fadeDur = dur; layer.fadeFrom = 0; layer.fadeTo = 1;
    if (dur === 0) { layer.opacity = 1; layer.el.style.opacity = '1'; }
    for (var i = 0; i < this.layers.length; i++) {
      var old = this.layers[i];
      if (old.dying) continue;
      old.dying = true;
      old.fadeFrom = old.opacity; old.fadeTo = 0; old.fadeStart = this._time; old.fadeDur = dur;
    }
    this.layers.push(layer);
    if (dur === 0) this._reap(true);
    if (this.freeze != null) this._renderAll(0);
  };

  Stage.prototype._destroyLayer = function (layer) {
    try { if (layer.instance.destroy) layer.instance.destroy(); } catch (e) { console.error(e); }
    if (layer.gl) {
      var ext = layer.gl.getExtension('WEBGL_lose_context');
      if (ext) { try { ext.loseContext(); } catch (e) { /* ignore */ } }
    }
    layer.el.remove();
  };

  Stage.prototype._reap = function (force) {
    var keep = [];
    for (var i = 0; i < this.layers.length; i++) {
      var l = this.layers[i];
      if (l.dying && (force || l.opacity <= 0.001)) this._destroyLayer(l);
      else keep.push(l);
    }
    this.layers = keep;
  };

  Stage.prototype._resizeAll = function () {
    for (var i = 0; i < this.layers.length; i++) {
      var l = this.layers[i];
      var m = this._measure(l.def);
      if (m.w === l.canvas.width && m.h === l.canvas.height && m.cssW === l.env.cssWidth && m.cssH === l.env.cssHeight) continue;
      l.canvas.width = m.w; l.canvas.height = m.h;
      l.env.width = m.w; l.env.height = m.h; l.env.cssWidth = m.cssW; l.env.cssHeight = m.cssH; l.env.pixelRatio = m.ratio;
      try { if (l.instance.resize) l.instance.resize(m.w, m.h, m.ratio); } catch (e) { console.error('[visuals] resize failed', e); }
    }
    if (this.freeze != null) this._renderAll(0);
  };

  Stage.prototype.setQuality = function (q) {
    if (!QUALITY[q] || q === this.quality) return;
    this.quality = q;
    for (var i = 0; i < this.layers.length; i++) this.layers[i].env.quality = q;
    this._resizeAll();
  };

  Stage.prototype.setOptions = function (opts) {
    Object.assign(this.options, opts || {});
  };

  /** Feed a native audio frame: { bands[32], level, bass, mid, treble, beat }. */
  Stage.prototype.setAudioFrame = function (f) {
    if (!f) return;
    var tgt = this._audioTarget;
    if (f.bands && f.bands.length) {
      var n = Math.min(NUM_BANDS, f.bands.length);
      for (var i = 0; i < n; i++) tgt.bands[i] = clamp(+f.bands[i] || 0, 0, 1);
    }
    tgt.level = clamp(+f.level || 0, 0, 1);
    tgt.bass = clamp(+f.bass || 0, 0, 1);
    tgt.mid = clamp(+f.mid || 0, 0, 1);
    tgt.treble = clamp(+f.treble || 0, 0, 1);
    this._lastAudioFrameAt = performance.now();
    if (f.beat) this._triggerBeat();
  };

  Stage.prototype.setPlaying = function (playing) { this.audio.playing = !!playing; };

  Stage.prototype.setPalette = function (colors) {
    var list = (colors || []).filter(function (c) { return /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(String(c)); })
      .map(function (c) { return c.charAt(0) === '#' ? c : '#' + c; });
    this.palette.colors = list;
    this.palette.rgb = list.map(hexToRgb);
    this.palette.fromArtwork = list.length > 0;
    this.palette.version++;
  };

  Stage.prototype._triggerBeat = function () {
    this.audio.beat = 1;
    this.audio.beatCount++;
  };

  Stage.prototype._updateAudio = function (dt) {
    var a = this.audio, tgt = this._audioTarget;
    var now = performance.now();
    a.available = now - this._lastAudioFrameAt < 1000;
    a.synthetic = !a.available && a.playing;
    if (a.synthetic) {
      if (this._synth(this._time, tgt)) this._triggerBeat();
    } else if (!a.available) {
      // Silence: let everything settle.
      for (var i = 0; i < NUM_BANDS; i++) tgt.bands[i] = 0;
      tgt.level = tgt.bass = tgt.mid = tgt.treble = 0;
    }
    var up = damp(28, dt), down = damp(7, dt);
    for (var b = 0; b < NUM_BANDS; b++) {
      var cur = a.bands[b], t = tgt.bands[b];
      a.bands[b] = cur + (t - cur) * (t > cur ? up : down);
    }
    a.level += (tgt.level - a.level) * (tgt.level > a.level ? up : down);
    a.bass += (tgt.bass - a.bass) * (tgt.bass > a.bass ? up : down);
    a.mid += (tgt.mid - a.mid) * (tgt.mid > a.mid ? up : down);
    a.treble += (tgt.treble - a.treble) * (tgt.treble > a.treble ? up : down);
    a.energy += (a.level - a.energy) * damp(0.25, dt);
    a.beat = Math.max(0, a.beat - dt * 3.3);
  };

  Stage.prototype._renderAll = function (dt) {
    for (var i = 0; i < this.layers.length; i++) {
      var l = this.layers[i];
      if (l.fadeDur > 0) {
        var k = clamp((this._time - l.fadeStart) / l.fadeDur, 0, 1);
        l.opacity = lerp(l.fadeFrom, l.fadeTo, easing.inOutSine(k));
      } else {
        l.opacity = l.fadeTo;
      }
      l.el.style.opacity = l.opacity.toFixed(3);
      if (l.opacity <= 0.001 && l.dying) continue;
      if (l.gl && l.gl.isContextLost()) continue;
      var localT = this.freeze != null ? this.freeze : this._time - l.born;
      try {
        if (l.instance.render) l.instance.render(localT, dt);
      } catch (err) {
        console.error('[visuals] render failed in "' + l.def.id + '"', err);
        if (this.onError) this.onError(err, l.def.id);
        if (l.def !== FALLBACK) {
          // Swap this layer for the fallback, in place.
          this._destroyLayer(l);
          var fb = this._makeLayer(FALLBACK);
          fb.opacity = l.opacity; fb.fadeTo = l.fadeTo; fb.dying = l.dying; fb.el.style.opacity = String(l.opacity);
          this.layers[i] = fb;
        }
      }
    }
  };

  Stage.prototype._frame = function (now) {
    if (this._destroyed) return;
    this._raf = requestAnimationFrame(this._loop);
    if (this._paused || this._hiddenPause) { this._lastNow = null; return; }
    var fps = this.fpsOverride || QUALITY[this.quality].fps;
    var minInterval = 1000 / fps - 2;
    if (this._lastNow != null && now - this._lastRender < minInterval) return;
    var dtMs = this._lastNow == null ? 1000 / fps : now - this._lastNow;
    this._lastNow = now;
    this._lastRender = now;
    var dt = Math.min(0.1, dtMs / 1000) * this.timeScale;
    if (this.freeze == null) this._time += dt;

    this._fpsAcc += dtMs; this._fpsFrames++;
    if (this._fpsAcc >= 1000) { this.fps = Math.round(this._fpsFrames * 1000 / this._fpsAcc); this._fpsAcc = 0; this._fpsFrames = 0; }

    this._updateAudio(dt);
    this._renderAll(dt);
    this._reap(false);
  };

  Stage.prototype.pause = function () { this._paused = true; };
  Stage.prototype.resume = function () { this._paused = false; this._lastNow = null; };

  Stage.prototype.destroy = function () {
    if (this._destroyed) return;
    this._destroyed = true;
    cancelAnimationFrame(this._raf);
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._ro) this._ro.disconnect();
    if (this._onWinResize) global.removeEventListener('resize', this._onWinResize);
    for (var i = 0; i < this.layers.length; i++) this._destroyLayer(this.layers[i]);
    this.layers = [];
    this.el.remove();
  };

  // ───────────────────────────── public API ─────────────────────────────
  var BrickVisuals = {
    QUALITY: QUALITY,
    NUM_BANDS: NUM_BANDS,

    register: function (def) {
      if (!def || !def.id || typeof def.create !== 'function') throw new Error('BrickVisuals.register: id and create() are required');
      if (!def.context) def.context = 'webgl';
      registry.set(def.id, def);
      return def;
    },

    /** Registered modes sorted by order (excludes the internal fallback). */
    list: function () {
      return Array.from(registry.values()).sort(function (a, b) { return (a.order || 50) - (b.order || 50); });
    },

    get: function (id) { return registry.get(id) || null; },

    has: function (id) { return registry.has(id); },

    mount: function (container, opts) { return new Stage(container, opts); },

    /** True if this browser can create a WebGL context. */
    webglSupported: function () {
      try {
        var c = document.createElement('canvas');
        var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        var ok = !!gl;
        if (gl) { var ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); }
        return ok;
      } catch (e) { return false; }
    },

    util: {
      clamp: clamp, lerp: lerp, smoothstep: smoothstep, fract: fract, damp: damp,
      mulberry32: mulberry32, createNoise: createNoise,
      hexToRgb: hexToRgb, rgbToHex: rgbToHex, hslToRgb: hslToRgb, mixRgb: mixRgb, luminance: luminance,
      easing: easing,
      glsl: { noise: GLSL_NOISE, common: GLSL_COMMON },
      gl: {
        FULLSCREEN_VS: FULLSCREEN_VS,
        FULLSCREEN_VS_300: FULLSCREEN_VS_300,
        createProgram: createProgram,
        fullscreenTriangle: fullscreenTriangle,
        createRenderTarget: createRenderTarget
      }
    }
  };

  global.BrickVisuals = BrickVisuals;
})(window);
