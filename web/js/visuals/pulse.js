/*
 * Analog Brick — "Pulse" visual mode (id "pulse").
 *
 * A luminous ring hanging in a slow nebula, crowned by 64 soft filaments of light that
 * move with the music — something between a solar eclipse corona and a dandelion.
 *
 *   • ring       a thin, warm ring of light around a dark disc; its radius breathes with
 *                the (smoothed) bass, and with a slow breath when nothing is playing.
 *   • filaments  the 32 spectrum bands, mirrored left/right → 64 tapered, glowing threads
 *                that curve gently upward like petals, each ending in a soft bead.
 *                A continuous corona (the same bands, linearly filtered) glows behind them.
 *   • ripples    faint rings released on beats (and once per breath when idle) that drift
 *                outward, fade, and gently refract the nebula as they pass.
 *   • nebula     domain-warped fbm gas in the palette's deep tones, rendered at reduced
 *                resolution; its brightness and flow follow the music's energy.
 *
 * Audio: env.audio (bands/bass/level/energy/beat/beatCount). The bands are smoothed again,
 * tilt-compensated and lightly self-normalised, then uploaded every frame as a 32×1
 * LUMINANCE texture. Colours come from env.palette (album art) and crossfade over ~2 s
 * when the track changes; the default is deep indigo, magenta and amber.
 *
 * Photosensitivity: beats only nudge the ring's glow (≤ ~12 %) and release dim ripples;
 * there is no full-screen flash and nothing strobes.
 *
 * State is integrated from differences in t (not dt), so a frozen stage renders a still.
 *
 * Passes (WebGL1, GLSL ES 1.00): 1. nebula → half-res RGBA8 (sqrt-encoded, dithered)
 *                                2. composite at canvas resolution.
 */
(function (global) {
  'use strict';

  var BV = global.BrickVisuals;
  if (!BV) return;

  var NUM_BANDS = 32;
  var MAX_RIPPLES = 8;            // shader slots: 2 idle (breath) + 6 beat ripples
  var RIPPLE_LIFE = 7.5;          // seconds
  var RIPPLE_GAP = 0.95;          // min seconds between beat ripples
  var BREATH_PERIOD = 11.0;       // idle breath, seconds (≈ 5.5 breaths/min)
  var PALETTE_FADE = 2.0;         // seconds

  var HEADER = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    ''
  ].join('\n');

  // ───────────────────────── pass 1: nebula ─────────────────────────
  var NEB_FS = [
    'varying vec2 v_uv;',
    'uniform vec2 uHalf;       // half extents in ring units (r = 1 at half the short side)',
    'uniform float uT;         // nebula time (flows faster with energy)',
    'uniform float uRot;',
    'uniform float uOct;       // detail octaves (2…5)',
    'uniform vec4 uSeed;',
    'uniform vec3 uNeb1;',
    'uniform vec3 uNeb2;',
    'uniform float uGain;',
    '',
    'float fbmW(vec3 p) {',
    '  float s = 0.0, a = 0.5;',
    '  for (int i = 0; i < 3; i++) { s += a * snoise(p); p = p * 2.02 + vec3(17.13, 3.71, 9.27); a *= 0.5; }',
    '  return s;',
    '}',
    'float fbmD(vec3 p) {',
    '  float s = 0.0, a = 0.5;',
    '  for (int i = 0; i < 5; i++) {',
    '    if (float(i) >= uOct) break;',
    '    s += a * snoise(p); p = p * 2.03 + vec3(5.71, 13.3, 2.19); a *= 0.5;',
    '  }',
    '  return s;',
    '}',
    '',
    'void main() {',
    '  vec2 p = (v_uv * 2.0 - 1.0) * uHalf;',
    '  float r = length(p);',
    '  p = rot2(uRot) * p;',
    '  vec2 q = p * 0.46 + uSeed.xy;',
    '  float tt = uT;',
    '  vec2 w = vec2(fbmW(vec3(q, tt * 0.040 + uSeed.z)),',
    '                fbmW(vec3(q + vec2(5.2, 1.3), tt * 0.036 + uSeed.z + 4.0)));',
    '  float n = fbmD(vec3(q * 1.2 + w * 1.15, tt * 0.030 + 9.0));',
    '  float h = snoise(vec3(q * 0.45 - w * 0.5 + 3.3, tt * 0.020 + 2.0));',
    '  float dens = 0.22 + 0.78 * smoothstep(-0.50, 0.70, n);',
    '  dens *= dens;',
    '  // faint brighter veils where the gas folds',
    '  float veil = smoothstep(0.15, 0.65, n) * smoothstep(-0.2, 0.6, w.x);',
    '  vec3 tint = mix(uNeb1, uNeb2, smoothstep(-0.45, 0.55, h));',
    '  vec3 col = tint * (dens + 0.45 * veil) * uGain;',
    '  col = sqrt(max(col, 0.0));',
    '  col += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  // ───────────────────────── pass 2: composite ─────────────────────────
  var COMP_FS = [
    'varying vec2 v_uv;',
    'uniform sampler2D uNeb;',
    'uniform sampler2D uBands;',
    'uniform vec2 uHalf;',
    'uniform float uPx;        // one canvas pixel in ring units',
    'uniform float uRot;',
    'uniform float uR;         // ring radius',
    'uniform vec4 uLen;        // filament min length, length range, filament gain, corona gain',
    'uniform vec4 uRing;       // ring gain, inner glow, nebula light, star gain',
    'uniform float uCurl;',
    'uniform float uOrder;     // 0: band 0 at the top; 1: band 0 at the bottom',
    'uniform vec4 uRip[' + MAX_RIPPLES + '];     // radius, amplitude, width, unused',
    'uniform vec3 uDeep;',
    'uniform vec3 uGlowA;',
    'uniform vec3 uGlowB;',
    'uniform vec3 uCore;',
    'uniform float uT;',
    'uniform float uStarRot;',
    'uniform vec4 uSeed;',
    '',
    'const float CW = PI / 32.0;   // angular width of one filament cell',
    '',
    'float bandAt(float cellPos) {',
    '  float u = cellPos / 32.0;',
    '  u = mix(u, 1.0 - u, uOrder);',
    '  return texture2D(uBands, vec2(u, 0.5)).r;',
    '}',
    '',
    'vec3 stars(vec2 p) {',
    '  vec2 q = rot2(uStarRot) * p * 22.0 + uSeed.zw;',
    '  vec2 id = floor(q);',
    '  float h = hash12(id);',
    '  if (h > 0.12) return vec3(0.0);',
    '  vec2 f = q - id - (0.2 + 0.6 * hash22(id + 7.7));',
    '  float b = hash12(id + 3.1);',
    '  float rad = max(0.03, uPx * 22.0 * 0.55);',
    '  float tw = 0.8 + 0.2 * sin(uT * (0.15 + 0.3 * b) + h * 60.0);',
    '  float k = exp(-dot(f, f) / (rad * rad)) * min(1.0, 0.0012 / (rad * rad));',
    '  return mix(vec3(0.70, 0.76, 1.0), vec3(1.0, 0.84, 0.68), b) * k * (0.04 + 0.30 * b * b * b) * tw;',
    '}',
    '',
    'void main() {',
    '  vec2 p = (v_uv * 2.0 - 1.0) * uHalf;',
    '  float r = length(p);',
    '  vec2 dir = p / max(r, 1e-4);',
    '',
    '  // ripples: faint light and a gentle radial refraction of the nebula',
    '  float rip = 0.0, disp = 0.0;',
    '  for (int i = 0; i < ' + MAX_RIPPLES + '; i++) {',
    '    vec4 R = uRip[i];',
    '    float x = (r - R.x) / R.z;',
    '    float g = exp(-x * x);',
    '    rip += R.y * g;',
    '    disp += R.y * x * g * R.z;',
    '  }',
    '  vec2 nuv = v_uv - dir * disp * 0.45 / uHalf;',
    '  vec3 neb = texture2D(uNeb, nuv).rgb;',
    '  neb *= neb;',
    '  float gas = dot(neb, vec3(0.30, 0.50, 0.20));',
    '',
    '  float th = atan(p.x, p.y) - uRot;',
    '  th = mod(th + PI, TAU) - PI;',
    '  float m = abs(th);',
    '  float dr = r - uR;',
    '',
    '  // filaments: curve gently upward (zero bend at the top and bottom keeps the mirror clean)',
    '  float bend = uCurl * max(dr, 0.0);',
    '  float m0 = m + bend * sin(m);',
    '  float jac = max(0.25, 1.0 + bend * cos(m));',
    '  float cell = m0 / CW;',
    '  float k = floor(cell);',
    '  float spacing = CW * max(r, uR) / uPx;          // px between neighbouring filaments',
    '  float lod = smoothstep(2.5, 7.0, spacing);',
    '  vec3 fil = vec3(0.0);',
    '  for (int j = -1; j <= 1; j++) {',
    '    float kk = k + float(j);',
    '    float kc = clamp(kk, 0.0, 31.0);',
    '    float v = bandAt(kc + 0.5);',
    '    float jit = 0.80 + 0.40 * hash11(kc * 7.13 + uSeed.x);',
    '    float L = (uLen.x + uLen.y * v) * jit;',
    '    float s = dr / L;',
    '    float sc = clamp(s, 0.0, 1.0);',
    '    float sway = 0.30 * sin(uT * (0.21 + 0.05 * hash11(kc + uSeed.y)) + kc * 2.4) * sc;',
    '    float d = (cell - kk - 0.5 - sway) * CW * r / jac;',
    '    float w = max(mix(0.0028 + 0.0024 * v, 0.0010, sqrt(sc)), uPx * 0.7);',
    '    float along = smoothstep(-0.02, 0.03, dr) * pow(1.0 - sc, 1.3);',
    '    float dd = d * d / (w * w);',
    '    float I = (exp(-dd) + 0.16 * exp(-dd * 0.08)) * along;',
    '    float tip = dr - L;',
    '    float bs = max(0.0055, uPx * 1.1);',
    '    float bead = exp(-(tip * tip + d * d) / (bs * bs));',
    '    float hue = hash11(kc * 3.71 + uSeed.x);',
    '    vec3 c = mix(uGlowA, uGlowB, clamp(smoothstep(0.0, 0.75, sc) + 0.22 * hue - 0.08, 0.0, 1.0));',
    '    fil += c * I * (0.25 + 0.95 * v) + mix(uGlowB, uCore, 0.35) * bead * (0.05 + 0.55 * v * v);',
    '  }',
    '',
    '  // corona: fibrous, continuous glow whose reach follows the spectrum',
    '  float E = bandAt(cell);',
    '  float reach = uLen.x + uLen.y * E;',
    '  float fib = 0.5 + 0.5 * snoise(vec2(m0 * 15.0 + uSeed.y, dr * 1.4 - uT * 0.02));',
    '  fib = 0.35 + 0.9 * fib * fib;',
    '  float cor = exp(-max(dr, 0.0) / (0.30 * reach + 0.02)) * smoothstep(-0.02, 0.004, dr) * fib;',
    '  vec3 corona = mix(uGlowA, uGlowB, smoothstep(0.0, 0.22, dr)) * cor;',
    '',
    '  // ring: thin bright core; long soft glow outside, short glow inside',
    '  float wr = max(0.0038, uPx * 0.9);',
    '  float ringCore = exp(-dr * dr / (wr * wr));',
    '  float outer = exp(-max(dr, 0.0) / 0.035) * 0.34 + exp(-max(dr, 0.0) / 0.15) * 0.09;',
    '  float inner = exp(min(dr, 0.0) / 0.010) * 0.43;',
    '  float glow = mix(inner, outer, smoothstep(-wr, wr, dr));',
    '  vec3 glowCol = mix(uGlowA, uGlowB, smoothstep(0.0, 0.18, dr) * 0.75);',
    '  vec3 ring = (uCore * ringCore * 1.25 + glowCol * glow) * (0.80 + 0.40 * E);',
    '',
    '  // background: deep base, nebula lit a little by the ring, a dark disc inside',
    '  float light = exp(-max(dr, 0.0) / 0.6);',
    '  vec3 bg = uDeep + neb * (1.0 + uRing.z * light) + stars(p) * uRing.w;',
    '  float inside = smoothstep(uR + 0.002, uR - 0.02, r);',
    '  bg *= 1.0 - 0.93 * inside;',
    '  bg += uGlowA * uRing.y * inside * exp(-(uR - r) / 0.045);',
    '',
    '  vec3 col = bg;',
    '  col += corona * uLen.w * (1.0 - inside);',
    '  col += fil * uLen.z * lod * (1.0 - inside);',
    '  col += ring * uRing.x;',
    '  // a ripple mostly shows as a wave of light passing through the gas',
    '  col += mix(uGlowA, uGlowB, 0.55) * rip * (0.03 + 2.4 * gas);',
    '',
    '  // vignette',
    '  col *= 1.0 - 0.5 * smoothstep(0.8, 2.1, r);',
    '  col = tonemap(col);',
    '  col = pow(col, vec3(1.0 / 2.2));',
    '  col += (hash12(gl_FragCoord.xy) + hash12(gl_FragCoord.xy + 71.3) - 1.0) / 255.0;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  // Per-quality budgets.
  var Q = {
    saver:    { neb: 0.40, oct: 3 },
    balanced: { neb: 0.50, oct: 4 },
    high:     { neb: 0.55, oct: 5 }
  };

  // ───────────────────────── palette ─────────────────────────
  function rgbToHsl(c) {
    var r = c[0], g = c[1], b = c[2];
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var l = (max + min) / 2, h = 0, s = 0, d = max - min;
    if (d > 1e-6) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }
  function hueDist(a, b) { var d = Math.abs(a - b) % 1; return Math.min(d, 1 - d); }
  function toLinear(c) { return [Math.pow(c[0], 2.2), Math.pow(c[1], 2.2), Math.pow(c[2], 2.2)]; }

  /** Display-space roles for the default (no artwork) look: deep indigo, magenta, amber. */
  var DEFAULT_ROLES = {
    deep:  [0.022, 0.016, 0.062],  // night indigo
    neb1:  [0.28, 0.20, 0.70],     // indigo
    neb2:  [0.66, 0.20, 0.56],     // magenta
    glowA: [1.00, 0.70, 0.40],     // amber (ring glow, filament roots)
    glowB: [0.96, 0.38, 0.62],     // rose-magenta (filament tips)
    core:  [1.00, 0.90, 0.78]      // warm white (ring core)
  };

  /** Derive the six colour roles from an album-art palette (sorted by dominance). */
  function deriveRoles(rgbList) {
    var U = BV.util;
    if (!rgbList || !rgbList.length) return DEFAULT_ROLES;
    var c = rgbList.map(function (rgb, i) {
      var hsl = rgbToHsl(rgb);
      var chroma = Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]);
      return { rgb: rgb, h: hsl[0], s: hsl[1], l: hsl[2], chroma: chroma, i: i };
    });
    var vivid = c.filter(function (x) { return x.chroma > 0.06; });
    if (!vivid.length) {
      // Monochrome artwork: silver light, a faint cool nebula.
      var g = c[0].l;
      return {
        deep: [0.020, 0.022, 0.030],
        neb1: [0.34, 0.36, 0.44], neb2: [0.44, 0.42, 0.46],
        glowA: [0.80, 0.80, 0.86], glowB: [0.95, 0.92, 0.86],
        core: [1.0, 0.97, 0.93 + 0.0 * g]
      };
    }
    function score(x) { return x.chroma * (1.15 - Math.abs(x.l - 0.58)) * (1 - 0.06 * x.i); }
    var A = vivid.slice().sort(function (a, b) { return score(b) - score(a); })[0];
    var B = null, best = -1;
    vivid.forEach(function (x) {
      if (x === A) return;
      var sc = hueDist(x.h, A.h) * 2 + x.chroma * 0.5;
      if (hueDist(x.h, A.h) > 0.05 && sc > best) { best = sc; B = x; }
    });
    var hA = A.h, sA = U.clamp(A.s, 0.45, 0.85);
    var hB = B ? B.h : hA + 0.07, sB = B ? U.clamp(B.s, 0.38, 0.85) : sA;
    // Nebula: the most dominant colourful tone, and a second one near it.
    var N1 = vivid.slice().sort(function (a, b) { return a.i - b.i; })[0];
    var N2 = null;
    vivid.forEach(function (x) { if (!N2 && x !== N1 && hueDist(x.h, N1.h) > 0.04) N2 = x; });
    var h1 = N1.h, s1 = U.clamp(N1.s, 0.30, 0.70);
    var h2 = N2 ? N2.h : h1 + 0.06, s2 = N2 ? U.clamp(N2.s, 0.28, 0.65) : s1;
    var glowA = U.hslToRgb(hA, sA, 0.64);
    return {
      deep: U.hslToRgb(h1, 0.55, 0.035),
      neb1: U.hslToRgb(h1, s1, 0.42),
      neb2: U.hslToRgb(h2, s2, 0.40),
      glowA: glowA,
      glowB: U.hslToRgb(hB, sB, 0.68),
      core: U.mixRgb(glowA, [1, 0.97, 0.92], 0.62)
    };
  }

  var ROLE_KEYS = ['deep', 'neb1', 'neb2', 'glowA', 'glowB', 'core'];
  function rolesToLinear(roles) {
    var out = {};
    ROLE_KEYS.forEach(function (k) { out[k] = toLinear(roles[k]); });
    return out;
  }

  BV.register({
    id: 'pulse',
    name: 'Pulse',
    tagline: 'A glowing bloom that breathes with your music',
    order: 60,
    context: 'webgl',
    renderScale: { saver: 0.45, balanced: 0.65, high: 0.85 },
    musicReactive: true,

    create: function (env) {
      var gl = env.gl;
      var U = env.util, G = U.gl;
      var lib = U.glsl.common + '\n' + U.glsl.noise + '\n';

      var rand = U.mulberry32(((env.seed | 0) + 1) * 2654435761 + 17);
      var flav = {
        rot: rand() * Math.PI * 2,
        neb: [(rand() - 0.5) * 60, (rand() - 0.5) * 60, rand() * 40, 0],
        stars: [rand() * 500, rand() * 500],
        breath: rand() * BREATH_PERIOD,
        timeOff: rand() * 200,
        idle: rand() * 100,
        fil: rand() * 100,
        fib: rand() * 100
      };
      var noise = U.createNoise(((env.seed | 0) * 31 + 7) >>> 0);

      var tri = G.fullscreenTriangle(gl);
      var pNeb = G.createProgram(gl, G.FULLSCREEN_VS, HEADER + lib + NEB_FS);
      var pComp = G.createProgram(gl, G.FULLSCREEN_VS, HEADER + lib + COMP_FS);

      // 32×1 band texture (LUMINANCE, UNSIGNED_BYTE), re-uploaded every frame.
      var bandBytes = new Uint8Array(NUM_BANDS);
      var bandTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, bandTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, NUM_BANDS, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, bandBytes);

      var nebRT = null, builtFor = null;
      function makeTargets() {
        if (nebRT) { nebRT.destroy(); nebRT = null; }
        var q = Q[env.quality] || Q.balanced;
        var w = Math.max(4, Math.round(env.width * q.neb)), h = Math.max(4, Math.round(env.height * q.neb));
        nebRT = G.createRenderTarget(gl, w, h);
        builtFor = env.quality;
      }
      makeTargets();

      // ── live state (integrated from t differences) ──
      var lastT = null;
      var act = 0;                     // 0 idle … 1 music
      var bassSm = 0, levelSm = 0, beatSm = 0, energySm = 0;
      var rot = 0, nebT = 0;
      var bands = new Float32Array(NUM_BANDS);     // displayed (0…1)
      var bandAvg = new Float32Array(NUM_BANDS);   // slow running average for self-normalising
      for (var i = 0; i < NUM_BANDS; i++) bandAvg[i] = 0.3;
      var ripples = [];                // { born, amp }
      var lastBeatCount = env.audio.beatCount, lastRippleAt = -1e9;
      var ripData = new Float32Array(MAX_RIPPLES * 4);

      // palette crossfade
      var palVersion = -1;
      var palFrom = null, palTo = null, palCur = rolesToLinear(DEFAULT_ROLES), palStart = 0;

      function updatePalette(t) {
        var pal = env.palette;
        if (pal.version !== palVersion) {
          var target = rolesToLinear(pal.fromArtwork ? deriveRoles(pal.rgb) : DEFAULT_ROLES);
          if (palVersion === -1) { palCur = target; palFrom = target; palTo = target; }
          else { palFrom = palCur; palTo = target; palStart = t; }
          palVersion = pal.version;
        }
        if (palFrom !== palTo) {
          var k = U.clamp((t - palStart) / PALETTE_FADE, 0, 1);
          var e = U.easing.inOutSine(k);
          var cur = {};
          ROLE_KEYS.forEach(function (key) { cur[key] = U.mixRgb(palFrom[key], palTo[key], e); });
          palCur = cur;
          if (k >= 1) { palFrom = palTo; palCur = palTo; }
        }
      }

      function idleBand(i, T) {
        var f = i / (NUM_BANDS - 1);
        var n = noise.noise2D(i * 0.23 + flav.idle, T * 0.045);
        var wave = Math.sin(T * (Math.PI * 2 / BREATH_PERIOD) - f * 2.4 + flav.breath);
        return U.clamp(0.20 + 0.12 * n + 0.07 * wave - 0.06 * f, 0, 1);
      }

      function step(t) {
        var a = env.audio;
        var first = lastT == null;
        var dt = first ? 0 : U.clamp(t - lastT, 0, 2.5);
        lastT = t;
        var T = t + flav.timeOff;

        var live = (a.available || a.synthetic || a.playing) ? 1 : 0;
        var target = live * U.smoothstep(0.02, 0.18, a.level);
        if (first) act = target;
        act += (target - act) * U.damp(0.7, dt);

        // smoothed scalars
        bassSm += (a.bass - bassSm) * U.damp(a.bass > bassSm ? 9 : 3.5, dt);
        levelSm += (a.level - levelSm) * U.damp(2.0, dt);
        energySm += (a.energy - energySm) * U.damp(1.0, dt);
        beatSm += (a.beat - beatSm) * U.damp(a.beat > beatSm ? 14 : 4, dt);

        // bands: extra smoothing, high-band tilt, gentle self-normalisation, blended with idle
        for (var i = 0; i < NUM_BANDS; i++) {
          var f = i / (NUM_BANDS - 1);
          var raw = a.bands[i] * (1 + 0.9 * f);
          bandAvg[i] += (raw - bandAvg[i]) * U.damp(0.25, dt);
          var norm = raw / Math.max(0.18, bandAvg[i] * 1.7);
          var v = U.clamp(0.78 * raw + 0.22 * norm, 0, 1);
          var tgt = U.lerp(idleBand(i, T), v, act);
          if (first) bands[i] = tgt;
          bands[i] += (tgt - bands[i]) * U.damp(tgt > bands[i] ? 11 : 3.2, dt);
          bandBytes[i] = Math.round(U.clamp(bands[i], 0, 1) * 255);
        }

        // motion: slow rotation, faster (still slow) with energy
        rot += dt * (0.010 + 0.040 * energySm * act);
        nebT += dt * (0.55 + 1.6 * energySm * act);

        // beat ripples
        if (a.beatCount !== lastBeatCount) {
          lastBeatCount = a.beatCount;
          if (act > 0.15 && t - lastRippleAt >= RIPPLE_GAP) {
            ripples.push({ born: t, amp: (0.55 + 0.45 * U.clamp(bassSm, 0, 1)) * act });
            lastRippleAt = t;
            if (ripples.length > MAX_RIPPLES - 2) ripples.shift();
          }
        }
        ripples = ripples.filter(function (r) { return t - r.born < RIPPLE_LIFE && t >= r.born; });
        return T;
      }

      function rippleSlot(idx, age, amp, R) {
        var x = U.clamp(age / RIPPLE_LIFE, 0, 1);
        var rad = R + 0.30 * age * (1 - 0.32 * x);
        var a = amp * (1 - x) * (1 - x) * U.smoothstep(0, 0.06, x);
        ripData[idx * 4] = rad;
        ripData[idx * 4 + 1] = a / (0.6 + rad);
        ripData[idx * 4 + 2] = 0.008 + 0.032 * x;
        ripData[idx * 4 + 3] = 0;
      }

      return {
        resize: function () { makeTargets(); },

        render: function (t) {
          if (builtFor !== env.quality || !nebRT) makeTargets();
          var q = Q[env.quality] || Q.balanced;
          var T = step(t);
          updatePalette(t);
          var P = palCur;

          var minDim = Math.max(1, Math.min(env.width, env.height));
          var half = [env.width / minDim, env.height / minDim];
          var px = 2 / minDim;

          // ring radius: slow breath when idle, smoothed bass when playing
          var bphase = (T + flav.breath) * (Math.PI * 2 / BREATH_PERIOD);
          var breath = Math.sin(bphase);
          var R0 = 0.30;
          var R = R0 * (1 + 0.035 * breath * (1 - 0.6 * act) + act * (0.02 + 0.11 * U.clamp(bassSm, 0, 1)));

          // ripples: two deterministic idle ones (released at each breath peak), then beat ones
          ripData.fill(0);
          for (var s = 0; s < MAX_RIPPLES; s++) ripData[s * 4 + 2] = 1;
          var since = ((bphase - Math.PI / 2) / (Math.PI * 2)) * BREATH_PERIOD;
          var age0 = ((since % BREATH_PERIOD) + BREATH_PERIOD) % BREATH_PERIOD;
          rippleSlot(0, age0, 0.45 * (1 - act), R0 * 1.035);
          rippleSlot(1, age0 + BREATH_PERIOD, 0.45 * (1 - act), R0 * 1.035);
          for (var k = 0; k < ripples.length && k < MAX_RIPPLES - 2; k++) {
            rippleSlot(2 + k, t - ripples[k].born, ripples[k].amp, R);
          }

          gl.disable(gl.BLEND);
          gl.disable(gl.DEPTH_TEST);

          // band texture
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, bandTex);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NUM_BANDS, 1, gl.LUMINANCE, gl.UNSIGNED_BYTE, bandBytes);

          // 1. nebula
          nebRT.bind();
          pNeb.use()
            .set('uHalf', half)
            .set('uT', nebT + flav.timeOff * 0.5)
            .set('uRot', rot * 0.35 + flav.rot)
            .set('uOct', q.oct)
            .set('uSeed', flav.neb)
            .set('uNeb1', P.neb1)
            .set('uNeb2', P.neb2)
            .set('uGain', 0.10 * (0.75 + 0.5 * energySm * act + 0.1 * (1 - act)));
          tri.draw();

          // 2. composite
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, env.width, env.height);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, nebRT.texture);
          pComp.use()
            .set('uNeb', 0)
            .set('uBands', 1)
            .set('uHalf', half)
            .set('uPx', px)
            .set('uRot', rot + flav.rot)
            .set('uR', R)
            .set('uLen', [0.035, 0.46, 0.55 * (0.85 + 0.25 * levelSm * act), 0.26])
            .set('uRing', [0.9 * (1 + 0.12 * beatSm * act), 0.05, 1.1, 1.0])
            .set('uCurl', 0.42)
            .set('uOrder', 1)
            .set('uRip', ripData)
            .set('uDeep', P.deep)
            .set('uGlowA', P.glowA)
            .set('uGlowB', P.glowB)
            .set('uCore', P.core)
            .set('uT', T)
            .set('uStarRot', rot * 0.35 + flav.rot)
            .set('uSeed', [flav.fil, flav.fib, flav.stars[0], flav.stars[1]]);
          tri.draw();
        },

        destroy: function () {
          if (nebRT) { nebRT.destroy(); nebRT = null; }
          gl.deleteTexture(bandTex);
          pNeb.destroy();
          pComp.destroy();
          tri.destroy();
        }
      };
    }
  });
})(window);
