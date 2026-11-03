/*
 * Analog Brick — "Aurora" visual mode (id "aurora").
 *
 * Northern-lights curtains over a still lake under a quiet, starry sky.
 *
 * The scene is a pinhole camera standing at the water's edge, looking north. Aurora
 * curtains are thin vertical sheets of light hanging above altitude ~1 (arbitrary
 * units; camera at 0). Their ground plan ("footprint") is a pair of folded, drifting
 * ribbons. Rendering is a handful of cheap WebGL1 passes per frame:
 *
 *   0. land       — (on resize only) the mountain ridges and the near shore, baked per
 *                   screen column into a 2-row texture (16-bit packed heights).
 *   1. footprint  — the ribbons' ground plan, cached in a small texture indexed by
 *                   (view angle u = x/z, distance z). A slow shared domain warp folds
 *                   the ribbons like silk; fine noise along each ribbon makes the rays.
 *                   R,G = front ribbon (intensity, ray height); B,A = back ribbon.
 *   2. march      — per pixel at reduced resolution, walk the view ray through the
 *                   curtain band: one texture fetch per step, an altitude profile and a
 *                   colour ramp (green-teal base → violet → magenta tips).
 *   3. glow       — downsample + separable blur of the aurora (sky halo, lighting).
 *   4. composite  — sky gradient, twinkling stars, aurora, glow, mountain ranges, lake
 *                   reflection with slow ripples, spruce silhouettes, tonemap, dither.
 *
 * Seed (per display) shifts curtain placement, timing and the landscape.
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

  var H_BASE_A = 1.0;     // front ribbon lower edge (altitude)
  var H_BASE_B = 1.08;    // back ribbon lower edge
  var Z_NEAR = 1.6, Z_FAR = 17.0;
  var HORIZON = 0.25;     // screen height (0 bottom … 1 top) of the lake's far shore
  var LAND_RANGE = 0.5;   // land heights are packed as 0…LAND_RANGE of screen height

  // Packing helpers shared by the land pass (encode) and the composite (decode).
  var GLSL_PACK = [
    'vec2 pack16(float v) { v = clamp(v / ' + LAND_RANGE.toFixed(2) + ', 0.0, 0.99998) * 255.0; float hi = floor(v); return vec2(hi / 255.0, v - hi); }',
    'float unpack16(vec2 e) { return (e.x * 255.0 + e.y) / 255.0 * ' + LAND_RANGE.toFixed(2) + '; }'
  ].join('\n');

  // ───────────────────────── pass 0: land (static) ─────────────────────────
  var LAND_FS = [
    'varying vec2 v_uv;',
    'uniform float uAspect;',
    'uniform vec4 uSeed;',
    GLSL_PACK,
    '',
    'float ridgeFar(float X) {',
    '  float big = smoothstep(-0.55, 0.9, snoise(vec2(X * 0.62 + uSeed.x, 1.7)));',
    '  float n = 0.02 + 0.06 * big * big;',
    '  n += 0.03 * (0.35 + big) * (1.0 - abs(snoise(vec2(X * 2.4 + uSeed.x, 4.2))));',
    '  n += 0.008 * (1.0 - abs(snoise(vec2(X * 7.0 + uSeed.x, 7.3))));',
    '  n += 0.0018 * snoise(vec2(X * 23.0, 2.1));',
    '  return max(n, 0.008);',
    '}',
    'float ridgeNear(float X) {',
    '  float n = 0.010 + 0.012 * snoise(vec2(X * 1.6 + uSeed.y, 3.3));',
    '  n += 0.003 * snoise(vec2(X * 9.0 + uSeed.y, 5.1));',
    '  // tiny far-shore spruce spikes',
    '  float cell = X * 160.0;',
    '  float id = floor(cell);',
    '  float f = fract(cell) - 0.5;',
    '  float hgt = hash11(id + uSeed.y * 13.0);',
    '  n += 0.0055 * hgt * hgt * max(0.0, 1.0 - abs(f) * 2.4);',
    '  return max(n, 0.004);',
    '}',
    'float shore(float X) {',
    '  float ux = X / uAspect + 0.5;',
    '  float edge = max(smoothstep(0.30, 0.0, ux), 0.8 * smoothstep(0.72, 1.0, ux));',
    '  return 0.035 + 0.012 * snoise(vec2(X * 1.8 + uSeed.y, 0.5)) + 0.05 * edge;',
    '}',
    'void main() {',
    '  float X = (v_uv.x - 0.5) * uAspect;',
    '  if (v_uv.y < 0.5) gl_FragColor = vec4(pack16(ridgeFar(X)), pack16(ridgeNear(X)));',
    '  else gl_FragColor = vec4(pack16(shore(X)), 0.0, 1.0);',
    '}'
  ].join('\n');

  // ───────────────────────── pass 1: footprint ─────────────────────────
  var FOOT_FS = [
    'varying vec2 v_uv;',
    'uniform float uT;',
    'uniform vec2 uU;          // u range covered by the texture',
    'uniform vec2 uZ;          // z range covered by the texture',
    'uniform vec4 uSeed;       // per-display offsets',
    'uniform float uDu;        // u per texel (for ray LOD)',
    '',
    '// One ribbon: returns (intensity, ray height 0..1).',
    'vec2 ribbon(vec2 q, float z, float zc, float amp, float k, float sx, float t) {',
    '  float c = snoise(vec2(q.x * 0.16 * k + sx, 1.3 + sx * 0.37 + t * 0.004))',
    '          + 0.35 * snoise(vec2(q.x * 0.37 * k - sx, 7.9 - t * 0.006));',
    '  float d = q.y - zc - c * amp;',
    '  float sig = 0.14 + 0.012 * z;',
    '  float I = exp(-d * d / (sig * sig));',
    '  // patchiness along the sheet: arcs brighten and fade along their length',
    '  float patch = 0.18 + 0.82 * smoothstep(-0.7, 0.5, snoise(vec2(q.x * 0.07 + sx * 1.7, 3.7 + t * 0.008)));',
    '  // rays: fine vertical striations drifting slowly along the sheet',
    '  float lod = clamp(1.6 - uDu * z * 30.0, 0.0, 1.0);',
    '  float r1 = snoise(vec2(q.x * 2.8 + sx, t * 0.03 + sx));',
    '  float r2 = snoise(vec2(q.x * 8.0 - sx, 5.0 + t * 0.045)) * lod;',
    '  float rays = 0.56 + 0.25 * r1 + 0.2 * r2;',
    '  float big = snoise(vec2(q.x * 0.45 + sx, 9.0 + t * 0.014));',
    '  float hgt = smoothstep(-0.6, 0.85, big * 0.55 + r1 * 0.3 + r2 * 0.25);',
    '  return vec2(I * patch * rays, hgt);',
    '}',
    '',
    'void main() {',
    '  float u = mix(uU.x, uU.y, v_uv.x);',
    '  float z = mix(uZ.x, uZ.y, v_uv.y);',
    '  vec2 p = vec2(u * z, z);',
    '  float t = uT;',
    '  // shared flow: sideways drift + slow domain warp (20–40 s) that folds the ribbons',
    '  vec2 q = p + vec2(uSeed.x + t * 0.03, 0.0);',
    '  vec2 wp = q * vec2(0.17, 0.26);',
    '  vec2 w = vec2(snoise(vec3(wp, t * 0.028 + uSeed.y)),',
    '                snoise(vec3(wp + vec2(5.2, 1.3), t * 0.024 + uSeed.y + 4.0)));',
    '  q += w * vec2(1.9, 0.7);',
    '  vec2 a = ribbon(q, z, 5.2 + uSeed.z, 2.3, 1.0, uSeed.w, t);',
    '  vec2 b = ribbon(q + vec2(31.0, 0.0), z, 10.5 - uSeed.z, 2.6, 0.75, uSeed.w + 11.0, t * 0.9);',
    '  // distance window: nothing overhead, fade into the haze far away',
    '  float win = smoothstep(uZ.x, uZ.x + 1.2, z) * smoothstep(uZ.y, uZ.y - 6.0, z);',
    '  gl_FragColor = vec4(a.x * win, a.y, b.x * win, b.y);',
    '}'
  ].join('\n');

  // Box filter along z, as wide as one march step: the jittered march over a box-filtered
  // footprint integrates the thin ribbons exactly, so no sparkle from undersampling.
  var ZBOX_FS = [
    'varying vec2 v_uv;',
    'uniform sampler2D uSrc;',
    'uniform float uW;         // box width in texture v units',
    'void main() {',
    '  vec4 c = texture2D(uSrc, v_uv + vec2(0.0, -0.375 * uW));',
    '  c += texture2D(uSrc, v_uv + vec2(0.0, -0.125 * uW));',
    '  c += texture2D(uSrc, v_uv + vec2(0.0, 0.125 * uW));',
    '  c += texture2D(uSrc, v_uv + vec2(0.0, 0.375 * uW));',
    '  gl_FragColor = c * 0.25;',
    '}'
  ].join('\n');

  // ───────────────────────── pass 2: march ─────────────────────────
  var MARCH_FS = [
    'varying vec2 v_uv;',
    'uniform sampler2D uFoot;',
    'uniform vec4 uCam;        // T*aspect, T, cos(pitch), sin(pitch)',
    'uniform vec2 uU;',
    'uniform vec2 uZ;',
    'uniform vec2 uSteps;      // (max steps, target step length in z)',
    'uniform vec4 uGain;       // front gain, back gain, global swell, unused',
    '',
    'const float BASE_A = ' + H_BASE_A.toFixed(3) + ';',
    'const float BASE_B = ' + H_BASE_B.toFixed(3) + ';',
    'const float H_TOP = 2.9;',
    'const vec3 TINT_B = vec3(0.85, 0.95, 1.12);   // the far ribbon leans a touch bluer',
    '',
    '// green-teal base → violet → magenta tips (piecewise, cheap)',
    'vec3 auroraCol(float dh) {',
    '  vec3 c = mix(vec3(0.10, 1.00, 0.50), vec3(0.03, 0.80, 0.68), clamp(dh * 2.6 - 0.1, 0.0, 1.0));',
    '  c = mix(c, vec3(0.28, 0.24, 0.95), clamp(dh * 1.8 - 0.65, 0.0, 1.0));',
    '  return mix(c, vec3(0.66, 0.22, 0.86), clamp(dh * 1.5 - 1.3, 0.0, 1.0));',
    '}',
    '',
    'float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }',
    '',
    'void main() {',
    '  vec2 sc = v_uv * 2.0 - 1.0;',
    '  float cy = sc.y * uCam.y;',
    '  float rdy = cy * uCam.z + uCam.w;',
    '  float rdz = uCam.z - cy * uCam.w;',
    '  float u = sc.x * uCam.x / rdz;',
    '  float s = rdy / rdz;',
    '  vec3 acc = vec3(0.0);',
    '  if (s > 0.004) {',
    '    float za = max(uZ.x, BASE_A * 0.97 / s);',
    '    float zb = min(uZ.y, H_TOP / s);',
    '    if (zb > za) {',
    '      float n = clamp(ceil((zb - za) / uSteps.y), 6.0, uSteps.x);',
    '      float dz = (zb - za) / n;',
    '      float j = hash(gl_FragCoord.xy);',
    '      float on = max(0.05, s * dz * 0.8);   // profile onset no sharper than one step',
    '      float onB = max(0.11, on);             // the far ribbon gets a softer lower edge',
    '      float tu = (u - uU.x) / (uU.y - uU.x);',
    '      float zs = 1.0 / (uZ.y - uZ.x);',
    '      for (int i = 0; i < 64; i++) {',
    '        if (float(i) >= n) break;',
    '        float z = za + (float(i) + j) * dz;',
    '        float h = s * z;',
    '        vec4 f = texture2D(uFoot, vec2(tu, (z - uZ.x) * zs));',
    '        float dA = h - BASE_A;',
    '        float pA = smoothstep(-on * 0.5, on, dA) * exp(-max(dA, 0.0) / mix(0.15, 0.85, f.g * f.g));',
    '        float dB = h - BASE_B;',
    '        float pB = smoothstep(-onB * 0.6, onB, dB) * exp(-max(dB, 0.0) / mix(0.2, 0.9, f.a * f.a));',
    '        acc += auroraCol(dA) * (f.r * pA * uGain.x + f.b * pB * uGain.y * TINT_B);',
    '      }',
    '      acc *= dz * uGain.z * smoothstep(0.004, 0.03, s);',
    '    }',
    '  }',
    '  // stored gamma-encoded (8-bit target): keeps the faint gradients free of banding',
    '  gl_FragColor = vec4(pow(acc, vec3(1.0 / 2.2)) + (hash(gl_FragCoord.xy + 17.0) - 0.5) / 255.0, 1.0);',
    '}'
  ].join('\n');

  // ───────────────────────── pass 3: glow ─────────────────────────
  var DOWN_FS = [
    'varying vec2 v_uv;',
    'uniform sampler2D uSrc;',
    'uniform vec2 uTexel;      // source texel size',
    'vec3 dec(vec3 c) { return pow(c, vec3(2.2)); }',
    'void main() {',
    '  vec3 c = dec(texture2D(uSrc, v_uv + uTexel * vec2(-1.0, -1.0)).rgb);',
    '  c += dec(texture2D(uSrc, v_uv + uTexel * vec2(1.0, -1.0)).rgb);',
    '  c += dec(texture2D(uSrc, v_uv + uTexel * vec2(-1.0, 1.0)).rgb);',
    '  c += dec(texture2D(uSrc, v_uv + uTexel * vec2(1.0, 1.0)).rgb);',
    '  gl_FragColor = vec4(pow(c * 0.25, vec3(1.0 / 2.2)), 1.0);',
    '}'
  ].join('\n');

  var BLUR_FS = [
    'varying vec2 v_uv;',
    'uniform sampler2D uSrc;',
    'uniform vec2 uDir;        // texel step in the blur direction',
    'vec3 dec(vec3 c) { return pow(c, vec3(2.2)); }',
    'void main() {',
    '  vec3 c = dec(texture2D(uSrc, v_uv).rgb) * 0.2270270;',
    '  c += dec(texture2D(uSrc, v_uv + uDir * 1.3846154).rgb) * 0.3162162;',
    '  c += dec(texture2D(uSrc, v_uv - uDir * 1.3846154).rgb) * 0.3162162;',
    '  c += dec(texture2D(uSrc, v_uv + uDir * 3.2307692).rgb) * 0.0702703;',
    '  c += dec(texture2D(uSrc, v_uv - uDir * 3.2307692).rgb) * 0.0702703;',
    '  gl_FragColor = vec4(pow(c, vec3(1.0 / 2.2)), 1.0);',
    '}'
  ].join('\n');

  // ───────────────────────── pass 4: composite ─────────────────────────
  var COMP_FS = [
    'varying vec2 v_uv;',
    'uniform sampler2D uAur;',
    'uniform sampler2D uGlow;',
    'uniform sampler2D uLand;',
    'uniform vec2 uRes;        // canvas size in px',
    'uniform vec2 uCss;        // css size',
    'uniform float uPr;        // canvas px per css px',
    'uniform float uAspect;',
    'uniform float uHz;        // horizon height (uv)',
    'uniform float uT;',
    'uniform vec4 uSeed;',
    GLSL_PACK,
    'vec3 dec(vec3 c) { return pow(c, vec3(2.2)); }',
    '',
    'vec3 starLayer(vec2 px, float cell, float density, float rCss, float bMax, float salt) {',
    '  vec2 id = floor(px / cell);',
    '  float h = hash12(id + salt);',
    '  if (h > density) return vec3(0.0);',
    '  vec2 f = px - id * cell;',
    '  vec2 pos = (0.2 + 0.6 * hash22(id + salt + 3.1)) * cell;',
    '  float h2 = hash12(id * 1.7 + salt + 9.2);',
    '  float b = bMax * (0.1 + 0.9 * pow(h2, 7.0));',
    '  float r0 = rCss * uPr;',
    '  float r = max(r0, 0.8);',
    '  b *= min(1.0, (r0 * r0) / (r * r) + 0.35);',
    '  float d = length(f - pos) * uPr;',
    '  float tw = 0.8 + 0.2 * sin(uT * (0.3 + 0.55 * h2) + h * 40.0);',
    '  vec3 tint = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.86, 0.70), hash12(id + salt + 5.5));',
    '  return tint * b * tw * exp(-d * d / (r * r));',
    '}',
    '',
    'vec3 sky(vec2 uv, float starAmt) {',
    '  float e = uv.y - uHz;',
    '  float k = clamp(e / (1.0 - uHz), 0.0, 1.0);',
    '  vec3 zen = vec3(0.0009, 0.0013, 0.0034);',
    '  vec3 hor = vec3(0.0034, 0.0058, 0.0125);',
    '  vec3 col = mix(hor, zen, sqrt(k));',
    '  vec3 aur = dec(texture2D(uAur, uv).rgb);',
    '  vec3 glow = dec(texture2D(uGlow, uv).rgb);',
    '  col += aur + glow * 0.28;',
    '  if (starAmt > 0.0) {',
    '    vec2 px = uv * uCss;',
    '    vec3 st = starLayer(px, 8.0, 0.24, 0.45, 0.08, uSeed.z)',
    '            + starLayer(px, 33.0, 0.32, 0.65, 0.45, uSeed.z + 17.0);',
    '    float alum = dot(aur + glow, vec3(0.25, 0.65, 0.10));',
    '    col += st * starAmt * smoothstep(0.0, 0.22, e) * (1.0 - 0.75 * smoothstep(0.0, 0.12, alum));',
    '  }',
    '  return col;',
    '}',
    '',
    '// Everything above the waterline: sky + mountain ranges.',
    'vec3 above(vec2 uv, float starAmt) {',
    '  vec3 col = sky(uv, starAmt);',
    '  float e = uv.y - uHz;',
    '  if (e < 0.14) {',
    '    vec4 land = texture2D(uLand, vec2(uv.x, 0.25));',
    '    float px = 1.0 / uRes.y;',
    '    vec3 lit = dec(texture2D(uGlow, vec2(uv.x, uHz + 0.10)).rgb);',
    '    float rf = unpack16(land.xy);',
    '    float cf = clamp((rf - e) / px + 0.5, 0.0, 1.0);',
    '    vec3 mf = vec3(0.0011, 0.0016, 0.0030) + lit * 0.04 * smoothstep(rf - 0.05, rf, e);',
    '    col = mix(col, mf, cf);',
    '    float rn = unpack16(land.zw);',
    '    float cn = clamp((rn - e) / px + 0.5, 0.0, 1.0);',
    '    col = mix(col, vec3(0.0005, 0.0007, 0.0011) + lit * 0.01, cn);',
    '  }',
    '  return col;',
    '}',
    '',
    'float spruce(vec2 p, float cx, float base, float th, float px, float r) {',
    '  float rel = (p.y - base) / th;',
    '  if (rel < 0.0 || rel > 1.0) return 0.0;',
    '  float tiers = rel * (8.0 + 5.0 * r) + r * 3.0;',
    '  float saw = fract(tiers);',
    '  float jag = 0.8 + 0.4 * hash11(floor(tiers) + r * 91.0);   // uneven branch lengths',
    '  float w = th * 0.17 * pow(1.0 - rel, 1.1) * (0.6 + 0.4 * (1.0 - saw)) * jag + th * 0.006;',
    '  return clamp((w - abs(p.x - cx)) / px + 0.5, 0.0, 1.0);',
    '}',
    '',
    'float foreground(vec2 uv) {',
    '  vec2 p = vec2((uv.x - 0.5) * uAspect, uv.y);',
    '  float px = 1.0 / uRes.y;',
    '  float base = unpack16(texture2D(uLand, vec2(uv.x, 0.75)).xy);',
    '  float cov = clamp((base - p.y) / px + 0.5, 0.0, 1.0);',
    '  if (p.y > 0.4 || cov >= 1.0 || (uv.x > 0.35 && uv.x < 0.67)) return cov;',
    '  float cw = 0.026;',
    '  float ci = floor(p.x / cw);',
    '  for (int k = -2; k <= 2; k++) {',
    '    float id = ci + float(k);',
    '    float cx = (id + 0.5 + (hash11(id * 2.11 + 4.0 + uSeed.y) - 0.5) * 0.7) * cw;',
    '    float ux = cx / uAspect + 0.5;',
    '    float ed = max(smoothstep(0.30, 0.02, ux), 0.85 * smoothstep(0.72, 0.98, ux));',
    '    if (hash11(id * 1.37 + uSeed.y) > 0.92 * ed) continue;',
    '    float hr = hash11(id * 3.7 + 1.0 + uSeed.y);',
    '    float th = (0.035 + 0.15 * hr * hr) * (0.45 + 1.0 * ed);',
    '    cov = max(cov, spruce(p, cx, base - 0.006, th, px, hash11(id * 5.3 + uSeed.y)));',
    '  }',
    '  return cov;',
    '}',
    '',
    'void main() {',
    '  vec2 uv = v_uv;',
    '  vec3 col;',
    '  if (uv.y >= uHz) {',
    '    col = above(uv, 1.0);',
    '  } else {',
    '    float dep = uHz - uv.y;',
    '    float zl = 0.05 / (dep + 0.003);',
    '    float xl = (uv.x - 0.5) * uAspect * zl;',
    '    float n1 = snoise(vec2(xl * 0.9, zl * 2.6 + uT * 0.05));',
    '    float n2 = sin(zl * 9.0 - uT * 0.35 + n1 * 2.0 + xl * 0.7);',
    '    vec2 m = vec2(uv.x + 0.004 * n1 * dep, uHz + dep + (0.010 * n1 + 0.003 * n2) * dep);',
    '    m.y = max(m.y, uHz + 0.0005);',
    '    vec3 r = above(m, 0.35);',
    '    float fres = mix(0.42, 0.78, smoothstep(0.22, 0.0, dep));',
    '    col = vec3(0.0006, 0.0009, 0.0016) + r * fres;',
    '  }',
    '  float fg = foreground(uv);',
    '  col = mix(col, vec3(0.0005, 0.0007, 0.0010), fg);',
    '  col = tonemap(col);',
    '  col = pow(col, vec3(1.0 / 2.2));',
    '  // triangular dither, ±1 LSB, kills banding in the dark gradients',
    '  col += (hash12(gl_FragCoord.xy) + hash12(gl_FragCoord.xy + 71.3) - 1.0) / 255.0;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  // Per-quality budgets (all relative to the mode canvas, which renderScale sizes).
  var Q = {
    saver:    { steps: 32, dz: 0.30, aur: 0.5, footRows: 192 },
    balanced: { steps: 48, dz: 0.22, aur: 0.6, footRows: 256 },
    high:     { steps: 64, dz: 0.16, aur: 0.7, footRows: 320 }
  };

  BV.register({
    id: 'aurora',
    name: 'Aurora',
    tagline: 'Northern lights over a quiet, starry lake',
    order: 10,
    context: 'webgl',
    renderScale: { saver: 0.4, balanced: 0.6, high: 0.8 },
    musicReactive: false,

    create: function (env) {
      var gl = env.gl;
      var U = env.util, G = U.gl;
      var lib = U.glsl.common + '\n' + U.glsl.noise + '\n';

      var rand = U.mulberry32(((env.seed | 0) + 1) * 7919 + 101);
      var seed = {
        drift: (rand() - 0.5) * 400,     // where along the sky the ribbons start
        warp: rand() * 50,               // flow-field phase
        zShift: (rand() - 0.5) * 0.9,    // nudge front/back ribbon distances
        ribbon: rand() * 100,            // ribbon shapes / rays
        timeOff: rand() * 600,           // so displays are not in lockstep
        land: [rand() * 100, rand() * 100, rand() * 100, rand() * 100]
      };

      var tri = G.fullscreenTriangle(gl);
      var pLand = G.createProgram(gl, G.FULLSCREEN_VS, HEADER + lib + LAND_FS);
      var pFoot = G.createProgram(gl, G.FULLSCREEN_VS, HEADER + lib + FOOT_FS);
      var pZbox = G.createProgram(gl, G.FULLSCREEN_VS, HEADER + ZBOX_FS);
      var pMarch = G.createProgram(gl, G.FULLSCREEN_VS, HEADER + MARCH_FS);
      var pDown = G.createProgram(gl, G.FULLSCREEN_VS, HEADER + DOWN_FS);
      var pBlur = G.createProgram(gl, G.FULLSCREEN_VS, HEADER + BLUR_FS);
      var pComp = G.createProgram(gl, G.FULLSCREEN_VS, HEADER + lib + COMP_FS);

      var rt = { land: null, foot: null, foot2: null, aur: null, g1: null, g2: null };
      var cam = null, builtFor = null, landDirty = true;

      function freeTargets() {
        for (var k in rt) { if (rt[k]) { rt[k].destroy(); rt[k] = null; } }
      }

      function computeCamera() {
        var aspect = env.cssWidth / Math.max(1, env.cssHeight);
        var T = 0.5 * Math.pow(Math.max(1, 1.25 / aspect), 0.6);   // tan(half vertical fov)
        var tanA = (1 - 2 * HORIZON) * T;                           // pitch puts the horizon at HORIZON
        var a = Math.atan(tanA), ca = Math.cos(a), sa = Math.sin(a);
        var uMax = T * aspect / (ca - T * sa) * 1.03 + 0.02;
        cam = { aspect: aspect, T: T, ca: ca, sa: sa, uMax: uMax };
      }

      function makeTargets() {
        freeTargets();
        computeCamera();
        var q = Q[env.quality] || Q.balanced;
        var w = Math.max(1, env.width), h = Math.max(1, env.height);
        var aw = Math.max(8, Math.round(w * q.aur)), ah = Math.max(8, Math.round(h * q.aur));
        var fw = Math.max(16, Math.min(1024, Math.round(aw * 1.2)));
        var fh = Math.max(16, Math.min(q.footRows, Math.round(ah * 0.8) + 32));
        var gw = Math.max(4, Math.round(aw / 4)), gh = Math.max(4, Math.round(ah / 4));
        rt.land = G.createRenderTarget(gl, w, 2, { nearest: true });
        rt.foot = G.createRenderTarget(gl, fw, fh);
        rt.foot2 = G.createRenderTarget(gl, fw, fh);
        rt.aur = G.createRenderTarget(gl, aw, ah);
        rt.g1 = G.createRenderTarget(gl, gw, gh);
        rt.g2 = G.createRenderTarget(gl, gw, gh);
        builtFor = env.quality;
        landDirty = true;
      }

      makeTargets();

      function bindTex(unit, target) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, target.texture);
      }

      // DEBUG-TEMP
      window.__auroraDbg = { rt: rt, gl: gl };

      return {
        resize: function () { makeTargets(); },

        render: function (t) {
          if (builtFor !== env.quality) makeTargets();
          var q = Q[env.quality] || Q.balanced;
          var T = t + seed.timeOff;
          // a very slow "activity" swell (≈ 2–6 min periods), never a flash
          var swell = 0.9 + 0.07 * Math.sin(T * 0.041 + 1.3) + 0.05 * Math.sin(T * 0.017 + 4.1);

          gl.disable(gl.BLEND);
          gl.disable(gl.DEPTH_TEST);

          // 0. land (static)
          if (landDirty) {
            rt.land.bind();
            pLand.use().set('uAspect', cam.aspect).set('uSeed', seed.land);
            tri.draw();
            landDirty = false;
          }

          // 1. footprint
          rt.foot.bind();
          pFoot.use()
            .set('uT', T)
            .set('uU', [-cam.uMax, cam.uMax])
            .set('uZ', [Z_NEAR, Z_FAR])
            .set('uSeed', [seed.drift, seed.warp, seed.zShift, seed.ribbon])
            .set('uDu', (2 * cam.uMax) / rt.foot.width);
          tri.draw();

          // 1b. box filter along z, one march step wide
          rt.foot2.bind();
          bindTex(0, rt.foot);
          pZbox.use().set('uSrc', 0).set('uW', q.dz / (Z_FAR - Z_NEAR));
          tri.draw();

          // 2. march
          rt.aur.bind();
          bindTex(0, rt.foot2);
          pMarch.use()
            .set('uFoot', 0)
            .set('uCam', [cam.T * cam.aspect, cam.T, cam.ca, cam.sa])
            .set('uU', [-cam.uMax, cam.uMax])
            .set('uZ', [Z_NEAR, Z_FAR])
            .set('uSteps', [q.steps, q.dz])
            .set('uGain', [0.58, 0.36, swell, 0]);
          tri.draw();

          // 3. glow
          rt.g1.bind();
          bindTex(0, rt.aur);
          pDown.use().set('uSrc', 0).set('uTexel', [1 / rt.aur.width, 1 / rt.aur.height]);
          tri.draw();
          rt.g2.bind();
          bindTex(0, rt.g1);
          pBlur.use().set('uSrc', 0).set('uDir', [1.6 / rt.g1.width, 0]);
          tri.draw();
          rt.g1.bind();
          bindTex(0, rt.g2);
          pBlur.set('uDir', [0, 1.6 / rt.g2.height]);
          tri.draw();

          // 4. composite
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, env.width, env.height);
          bindTex(0, rt.aur);
          bindTex(1, rt.g1);
          bindTex(2, rt.land);
          pComp.use()
            .set('uAur', 0)
            .set('uGlow', 1)
            .set('uLand', 2)
            .set('uRes', [env.width, env.height])
            .set('uCss', [env.cssWidth, env.cssHeight])
            .set('uPr', env.pixelRatio)
            .set('uAspect', cam.aspect)
            .set('uHz', HORIZON)
            .set('uT', T)
            .set('uSeed', seed.land);
          tri.draw();
          gl.activeTexture(gl.TEXTURE0);
        },

        destroy: function () {
          freeTargets();
          pLand.destroy(); pFoot.destroy(); pZbox.destroy(); pMarch.destroy(); pDown.destroy(); pBlur.destroy(); pComp.destroy();
          tri.destroy();
        }
      };
    }
  });
})();
