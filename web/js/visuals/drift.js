/*
 * Analog Brick — "Drift" visual mode.
 *
 * Silk threads on a slow current. A few thousand particles are advected through an
 * evolving, divergence-free (curl-noise) flow field and deposit thin anti-aliased
 * strokes into a persistent accumulation buffer, so long silky filaments form and
 * slowly dissolve.
 *
 * Rendering (WebGL1, GLSL ES 1.00):
 *   1. fade     the accumulation buffer is multiplied by exp(-dt/τ) with a blend-only pass
 *   2. deposit  each particle's last step is drawn as a butt-capped quad (soft profile
 *               across, exact partition along the path → speed-independent ink)
 *   3. glow     (balanced/high) 4×4 box downsample + separable blur at quarter res
 *   4. compose  ink background + soft tonemap of the threads + glow + vignette + dither
 *
 * Trail fade precision: the accumulation buffer is RGBA16F when the GPU can render to it
 * (all Macs running Safari 16+), so exponential decay reaches true black. Without it we
 * fall back to RGBA8 and fade in larger periodic steps followed by a 1/255 offset
 * subtract (reverse-subtract blend), which also reaches exact zero — no grey ghosting.
 *
 * The simulation is driven by differences in t (not dt) so a frozen stage renders a
 * still, and large steps (warp, freeze catch-up) are split into substeps whose deposits
 * are pre-weighted by their own decay, needing only one full-screen fade per frame.
 */
(function (global) {
  'use strict';

  var BV = global.BrickVisuals;
  if (!BV) return;

  // ─────────────────────────── tuning ───────────────────────────
  var TRAIL_TAU = 9.0;              // seconds for a deposit to fade to 1/e
  var PREWARM = 15;                 // seconds simulated on create (≈ 1.7 τ)
  var REF_AREA = 1440 * 900;        // css px² the base counts are tuned for
  var COUNTS = { saver: 1500, balanced: 3500, high: 6000 };
  var MAX_PARTICLES = 12000;        // ≤ 16383 so a Uint16 index buffer covers a whole draw
  var SPEED = 0.027;                // RMS particle speed, in screen heights per second
  var FIELD_RATE = 0.011;           // how fast the flow field evolves (noise z per second)
  var GRID_PER_H = 30;              // flow grid cells per screen height
  var MARGIN = 0.07;                // simulated margin outside the view (screen heights)
  var LDR_FADE_INTERVAL = 0.14;     // seconds between fades on the 8-bit fallback

  // Warm ink palette (display-space RGB). Ramp position 0 → 1.
  var RAMP = [
    [0.00, [1.00, 0.92, 0.80]],     // pale cream
    [0.24, [1.00, 0.88, 0.70]],     // cream
    [0.40, [0.99, 0.82, 0.58]],     // warm cream
    [0.58, [0.98, 0.66, 0.34]],     // amber
    [0.78, [0.93, 0.52, 0.52]],     // dusty rose
    [1.00, [0.70, 0.42, 0.62]]      // mauve (rare extreme)
  ];

  // Away from the light pools a share of the threads turn a quiet teal — like shot silk,
  // individual threads change colour rather than every thread blending to grey.
  var SHADOW = [0.27, 0.57, 0.67];

  function buildRampLut() {
    var lut = new Float32Array(256 * 3);
    for (var i = 0; i < 256; i++) {
      var t = i / 255, k = 0;
      while (k < RAMP.length - 2 && t > RAMP[k + 1][0]) k++;
      var a = RAMP[k], b = RAMP[k + 1];
      var f = (t - a[0]) / (b[0] - a[0]);
      f = f < 0 ? 0 : f > 1 ? 1 : f;
      f = f * f * (3 - 2 * f);
      for (var c = 0; c < 3; c++) lut[i * 3 + c] = a[1][c] + (b[1][c] - a[1][c]) * f;
    }
    return lut;
  }
  var RAMP_LUT = buildRampLut();

  // ─────────────────────────── shaders ───────────────────────────
  var THREAD_VS = [
    'attribute vec2 a_pos;',
    'attribute float a_side;',
    'attribute vec3 a_col;',
    'uniform vec2 u_res;',
    'varying float v_side;',
    'varying vec3 v_col;',
    'void main() {',
    '  v_side = a_side;',
    '  v_col = a_col;',
    '  gl_Position = vec4(a_pos / u_res * 2.0 - 1.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var THREAD_FS = [
    'precision mediump float;',
    'varying float v_side;',
    'varying vec3 v_col;',
    'uniform float u_scale;',
    'void main() {',
    '  float d = max(1.0 - v_side * v_side, 0.0);',
    '  gl_FragColor = vec4(v_col * (d * d * u_scale), 1.0);',
    '}'
  ].join('\n');

  var SOLID_FS = [
    'precision mediump float;',
    'uniform vec4 u_color;',
    'void main() { gl_FragColor = u_color; }'
  ].join('\n');

  function precisionHeader() {
    return '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n';
  }

  // 4×4 box downsample of the accumulation buffer (nearest taps on texel centres), soft-tonemapped.
  var DOWN_FS = [
    'uniform sampler2D u_src;',
    'uniform vec2 u_texel;',
    'uniform float u_gain;',
    'varying vec2 v_uv;',
    'void main() {',
    '  vec3 s = vec3(0.0);',
    '  for (int y = 0; y < 4; y++) {',
    '    for (int x = 0; x < 4; x++) {',
    '      s += texture2D(u_src, v_uv + (vec2(float(x), float(y)) - 1.5) * u_texel).rgb;',
    '    }',
    '  }',
    '  s *= u_gain / 16.0;',
    '  gl_FragColor = vec4(1.0 - exp(-s), 1.0);',
    '}'
  ].join('\n');

  // 9-tap gaussian using linear filtering (5 fetches).
  var BLUR_FS = [
    'uniform sampler2D u_src;',
    'uniform vec2 u_dir;',
    'varying vec2 v_uv;',
    'void main() {',
    '  vec3 s = texture2D(u_src, v_uv).rgb * 0.2270270270;',
    '  vec2 o1 = u_dir * 1.3846153846;',
    '  vec2 o2 = u_dir * 3.2307692308;',
    '  s += (texture2D(u_src, v_uv + o1).rgb + texture2D(u_src, v_uv - o1).rgb) * 0.3162162162;',
    '  s += (texture2D(u_src, v_uv + o2).rgb + texture2D(u_src, v_uv - o2).rgb) * 0.0702702703;',
    '  gl_FragColor = vec4(s, 1.0);',
    '}'
  ].join('\n');

  function composeFS(util) {
    return precisionHeader() + util.glsl.common + '\n' + [
      'uniform sampler2D u_acc;',
      'uniform sampler2D u_glow;',
      'uniform vec2 u_res;',
      'uniform float u_gain;',
      'uniform float u_glowAmt;',
      'uniform vec2 u_lamp;',
      'uniform vec3 u_bgDeep;',
      'uniform vec3 u_bgLift;',
      'uniform vec3 u_lampTint;',
      'varying vec2 v_uv;',
      'void main() {',
      '  float aspect = u_res.x / u_res.y;',
      '  vec2 p = (v_uv - 0.5) * vec2(aspect, 1.0);',
      '  // Deep ink with a faint, warm lamp-lit pool and a soft vignette.',
      '  float r = length(p - u_lamp);',
      '  float pool = exp(-r * r * 1.6);',
      '  vec3 bg = u_bgDeep + u_bgLift * pool;',
      '  vec3 acc = texture2D(u_acc, v_uv).rgb * u_gain;',
      '  // Soft tonemap: per-channel (dense passages bloom toward cream) blended with a',
      '  // hue-preserving luminance curve (keeps amber and rose saturated).',
      '  float L = dot(acc, vec3(0.3, 0.55, 0.15));',
      '  vec3 silkLum = acc * ((1.0 - exp(-L)) / max(L, 1e-4));',
      '  vec3 silk = mix(1.0 - exp(-acc), silkLum, 0.72);',
      '  vec3 glow = texture2D(u_glow, v_uv).rgb * u_glowAmt;',
      '  vec3 col = bg + silk * (1.0 - bg) + glow * u_lampTint;',
      '  float vig = 1.0 - 0.38 * smoothstep(0.35, 1.05, length(p * vec2(0.82, 1.0)));',
      '  col *= vig;',
      '  col = dither(col, gl_FragCoord.xy);',
      '  gl_FragColor = vec4(col, 1.0);',
      '}'
    ].join('\n');
  }

  // ─────────────────────────── mode ───────────────────────────
  BV.register({
    id: 'drift',
    name: 'Drift',
    tagline: 'Silk threads drifting on a slow current',
    order: 20,
    context: 'webgl',
    renderScale: { saver: 0.6, balanced: 0.8, high: 1.0 },
    musicReactive: false,

    create: function (env) {
      var gl = env.gl;
      var U = env.util;
      var GLU = U.gl;
      var seed = (env.seed | 0) || 1;
      var rand = U.mulberry32(seed * 2654435761 + 0x9e37);
      var noise = U.createNoise(seed * 7919 + 101);
      var options = env.options || {};

      // Per-seed flavour: every display shares the mood, not the exact composition.
      var flav = {
        lightPhase: rand() * Math.PI * 2,
        currentPhase: rand() * Math.PI * 2,
        paletteShift: (rand() - 0.5) * 0.08,
        colorPhase: rand() * 100,
        fieldOffX: rand() * 200, fieldOffY: rand() * 200
      };

      // ── GL resources ──
      var ext = {
        half: gl.getExtension('OES_texture_half_float'),
        halfCb: gl.getExtension('EXT_color_buffer_half_float'),
        halfLinear: gl.getExtension('OES_texture_half_float_linear')
      };

      var tri = GLU.fullscreenTriangle(gl);
      var threadProg = GLU.createProgram(gl, THREAD_VS, THREAD_FS, { a_side: 1, a_col: 2 });
      var solidProg = GLU.createProgram(gl, GLU.FULLSCREEN_VS, SOLID_FS);
      var downProg = GLU.createProgram(gl, GLU.FULLSCREEN_VS, precisionHeader() + DOWN_FS);
      var blurProg = GLU.createProgram(gl, GLU.FULLSCREEN_VS, 'precision mediump float;\n' + BLUR_FS);
      var composeProg = GLU.createProgram(gl, GLU.FULLSCREEN_VS, composeFS(U));

      var FLOATS_PER_VERT = 6;
      var vertData = new Float32Array(MAX_PARTICLES * 4 * FLOATS_PER_VERT);
      var vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, vertData.byteLength, gl.DYNAMIC_DRAW);
      var idx = new Uint16Array(MAX_PARTICLES * 6);
      for (var q = 0; q < MAX_PARTICLES; q++) {
        var b4 = q * 4, b6 = q * 6;
        idx[b6] = b4; idx[b6 + 1] = b4 + 1; idx[b6 + 2] = b4 + 2;
        idx[b6 + 3] = b4 + 1; idx[b6 + 4] = b4 + 3; idx[b6 + 5] = b4 + 2;
      }
      var ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      idx = null;

      var acc = null;           // { texture, framebuffer, width, height, hdr }
      var glowA = null, glowB = null;
      var blackTex = null;      // bound as glow when glow is off

      function makeTarget(w, h, wantHalf, linear) {
        var tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        var filt = linear ? gl.LINEAR : gl.NEAREST;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        var hdr = false;
        var fb = gl.createFramebuffer();
        if (wantHalf && ext.half) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, ext.half.HALF_FLOAT_OES, null);
          gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
          hdr = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
          if (!hdr) gl.bindTexture(gl.TEXTURE_2D, tex);
        }
        if (!hdr) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        }
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return { texture: tex, framebuffer: fb, width: w, height: h, hdr: hdr };
      }
      function freeTarget(t) {
        if (!t) return;
        gl.deleteFramebuffer(t.framebuffer);
        gl.deleteTexture(t.texture);
      }

      blackTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, blackTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

      // ── simulation state ──
      var W = 1, H = 1, aspect = 1, ratio = 1;
      var count = 0, quality = null;
      var px = new Float32Array(MAX_PARTICLES), py = new Float32Array(MAX_PARTICLES);
      var age = new Float32Array(MAX_PARTICLES), life = new Float32Array(MAX_PARTICLES);
      var depth = new Float32Array(MAX_PARTICLES), jitter = new Float32Array(MAX_PARTICLES);
      var coolRank = new Float32Array(MAX_PARTICLES);
      var spMul = new Float32Array(MAX_PARTICLES), hwPx = new Float32Array(MAX_PARTICLES);
      var inten = new Float32Array(MAX_PARTICLES);

      var gnx = 0, gny = 0, gx0 = 0, gy0 = 0, gh = 1 / GRID_PER_H, ginv = GRID_PER_H;
      var psi = null, gvx = null, gvy = null, gcol = null, glum = null;

      var simTime = 0;          // simulation clock (s)
      var fieldTime = -1e9;     // when the grid was last evaluated
      var lastT = null;         // last t passed to render()
      var ldrFadeAcc = 0;       // 8-bit path: time since the last fade step
      var depositScale = 1, composeGain = 1;
      var light = [1, 0];       // sheen direction
      var paletteCenter = 0.5;
      var current = [0, 0];
      var intensityBase = 1;

      // Trails scale with the screen, so ink coverage stays constant when the count
      // grows with the square root of the area rather than with the area itself.
      function areaFactor() {
        var area = Math.max(1, env.cssWidth * env.cssHeight) / REF_AREA;
        return Math.max(0.15, Math.min(2.2, Math.sqrt(area)));
      }
      function particleTarget() {
        var q = env.quality in COUNTS ? env.quality : 'balanced';
        return Math.max(150, Math.min(MAX_PARTICLES, Math.round(COUNTS[q] * areaFactor())));
      }

      function spawn(i, fresh) {
        px[i] = -MARGIN + rand() * (aspect + 2 * MARGIN);
        py[i] = -MARGIN + rand() * (1 + 2 * MARGIN);
        life[i] = 10 + rand() * 14;
        age[i] = fresh ? rand() * life[i] : 0;
        var z = Math.pow(rand(), 1.35);           // 0 = far, 1 = near; more far than near
        depth[i] = z;
        jitter[i] = (rand() - 0.5) * 0.1;
        coolRank[i] = rand();
        spMul[i] = 0.62 + 0.55 * z + (rand() - 0.5) * 0.12;
      }

      function setupParticles() {
        var n = particleTarget();
        for (var i = count; i < n; i++) spawn(i, true);
        count = n;
        quality = env.quality;
        updateParticleLooks();
      }

      // Width/intensity depend on canvas resolution and particle count; recompute on resize.
      function updateParticleLooks() {
        var pr = Math.max(0.5, env.pixelRatio || 1);
        // Threads stay hairline: ~1 device px, a little finer still in small previews.
        var minSide = Math.min(env.cssWidth, env.cssHeight);
        var fine = Math.max(0.72, Math.min(1, Math.sqrt(minSide / 700)));
        var widthScale = Math.max(0.9, Math.min(2.2, Math.sqrt(pr))) * fine;
        // Fewer particles (saver) → slightly stronger ink so coverage reads the same.
        var nominal = COUNTS.balanced * areaFactor();
        var comp = Math.pow(nominal / Math.max(1, count), 0.5);
        intensityBase = 0.36 * comp / Math.sqrt(fine);
        for (var i = 0; i < count; i++) {
          var z = depth[i];
          hwPx[i] = (0.95 + 0.75 * z) * widthScale;
          inten[i] = (0.32 + 0.68 * z * z) / (0.9 + 0.35 * z);
        }
      }

      function setupGrid() {
        gx0 = -MARGIN - 2 * gh;
        gy0 = -MARGIN - 2 * gh;
        gnx = Math.ceil((aspect + 2 * MARGIN + 4 * gh) * ginv) + 1;
        gny = Math.ceil((1 + 2 * MARGIN + 4 * gh) * ginv) + 1;
        var n = gnx * gny;
        psi = new Float32Array(n);
        gvx = new Float32Array(n);
        gvy = new Float32Array(n);
        gcol = new Float32Array(n);
        glum = new Float32Array(n);
        fieldTime = -1e9;
      }

      // Evaluate the stream function on the grid and take its curl → divergence-free velocity.
      function computeField(time) {
        fieldTime = time;
        var z = time * FIELD_RATE;
        var ox = flav.fieldOffX, oy = flav.fieldOffY;
        var i, j, k, X, Y;
        for (j = 0; j < gny; j++) {
          Y = gy0 + j * gh;
          for (i = 0; i < gnx; i++) {
            X = gx0 + i * gh;
            // Gentle domain warp for organic, non-grid-like eddies.
            var wx = noise.noise3D(X * 0.5 + ox, Y * 0.5 + oy, z * 0.7 + 7.1);
            var wy = noise.noise3D(X * 0.5 + ox + 31.7, Y * 0.5 + oy - 12.3, z * 0.7 + 3.9);
            var qx = X + wx * 0.15, qy = Y + wy * 0.15;
            k = j * gnx + i;
            psi[k] = noise.noise3D(qx * 0.7 + ox, qy * 0.7 + oy, z)
                   + 0.22 * noise.noise3D(qx * 1.9 + ox - 40.2, qy * 1.9 + oy + 17.9, z * 1.5 + 5.3);
            gcol[k] = noise.noise3D(X * 0.62 + flav.colorPhase, Y * 0.62 - flav.colorPhase, time * 0.004 + 11.0)
                    + 0.35 * noise.noise3D(X * 1.7 - flav.colorPhase, Y * 1.7, time * 0.007 + 23.0);
            // Slow pools of light falling across the silk: bright passages and quiet dark ones.
            var l = noise.noise3D(X * 0.9 - 17.0 + flav.colorPhase, Y * 0.9 + 9.0, time * 0.006 + 41.0);
            l = 0.5 + 0.5 * l;
            glum[k] = 0.3 + 1.45 * l * l * l;
          }
        }
        var sum = 0;
        for (j = 0; j < gny; j++) {
          var jm = j > 0 ? j - 1 : 0, jp = j < gny - 1 ? j + 1 : gny - 1;
          var sy = (jp - jm) * gh;
          for (i = 0; i < gnx; i++) {
            var im = i > 0 ? i - 1 : 0, ip = i < gnx - 1 ? i + 1 : gnx - 1;
            k = j * gnx + i;
            var vx = (psi[jp * gnx + i] - psi[jm * gnx + i]) / sy;
            var vy = -(psi[j * gnx + ip] - psi[j * gnx + im]) / ((ip - im) * gh);
            gvx[k] = vx; gvy[k] = vy;
            sum += vx * vx + vy * vy;
          }
        }
        // Normalise to the target RMS speed, then add a slow, wandering large-scale current.
        var rms = Math.sqrt(sum / (gnx * gny)) || 1;
        var s = SPEED / rms;
        var ang = flav.currentPhase + 0.9 * Math.sin(time / 173 + 1.3) + 0.45 * Math.sin(time / 61);
        var cur = SPEED * (0.8 + 0.12 * Math.sin(time / 97 + flav.currentPhase));
        current[0] = Math.cos(ang) * cur; current[1] = Math.sin(ang) * cur;
        for (k = 0; k < gvx.length; k++) {
          gvx[k] = gvx[k] * s + current[0];
          gvy[k] = gvy[k] * s + current[1];
        }
        // Slowly wandering "light" for the satin sheen, and a palette that drifts over minutes.
        var la = flav.lightPhase + time * 0.0042 + 0.5 * Math.sin(time / 83);
        light[0] = Math.cos(la); light[1] = Math.sin(la);
        paletteCenter = 0.5 + flav.paletteShift + 0.1 * Math.sin(time / 190 + flav.lightPhase) + 0.05 * Math.sin(time / 71 + 2.0);
      }

      // Bilinear sample of the velocity grid; result in sVX, sVY (and sC for the colour field).
      var sVX = 0, sVY = 0, sC = 0, sL = 1;
      function sample(x, y, withColor) {
        var fx = (x - gx0) * ginv, fy = (y - gy0) * ginv;
        if (fx < 0) fx = 0; else if (fx > gnx - 1.001) fx = gnx - 1.001;
        if (fy < 0) fy = 0; else if (fy > gny - 1.001) fy = gny - 1.001;
        var i = fx | 0, j = fy | 0;
        var tx = fx - i, ty = fy - j;
        var k = j * gnx + i, k2 = k + gnx;
        var w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
        sVX = gvx[k] * w00 + gvx[k + 1] * w10 + gvx[k2] * w01 + gvx[k2 + 1] * w11;
        sVY = gvy[k] * w00 + gvy[k + 1] * w10 + gvy[k2] * w01 + gvy[k2 + 1] * w11;
        if (withColor) {
          sC = gcol[k] * w00 + gcol[k + 1] * w10 + gcol[k2] * w01 + gcol[k2 + 1] * w11;
          sL = glum[k] * w00 + glum[k + 1] * w10 + glum[k2] * w01 + glum[k2 + 1] * w11;
        }
      }

      // ── GL passes ──
      function bindThreadAttribs() {
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        var stride = FLOATS_PER_VERT * 4;
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 8);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 12);
      }
      function unbindThreadAttribs() {
        gl.disableVertexAttribArray(1);
        gl.disableVertexAttribArray(2);
      }

      function flushQuads(nq) {
        if (nq <= 0) return;
        // Re-specify (orphan) the buffer rather than sub-updating storage the GPU may still be
        // reading — avoids a pipeline sync per batch during prewarm and catch-up.
        gl.bufferData(gl.ARRAY_BUFFER, vertData.subarray(0, nq * 4 * FLOATS_PER_VERT), gl.STREAM_DRAW);
        gl.drawElements(gl.TRIANGLES, nq * 6, gl.UNSIGNED_SHORT, 0);
      }

      // Multiply the accumulation buffer by k (and, on 8-bit, subtract `sub` afterwards).
      function fadeAcc(k, sub) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, acc.framebuffer);
        gl.viewport(0, 0, acc.width, acc.height);
        gl.enable(gl.BLEND);
        solidProg.use();
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ZERO, gl.SRC_COLOR);
        solidProg.set('u_color', [k, k, k, k]);
        tri.draw();
        if (sub > 0) {
          gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT);
          gl.blendFunc(gl.ONE, gl.ONE);
          solidProg.set('u_color', [sub, sub, sub, 0]);
          tri.draw();
          gl.blendEquation(gl.FUNC_ADD);
        }
      }

      function fadeFor(step) {
        if (acc.hdr) {
          fadeAcc(Math.exp(-step / TRAIL_TAU), 0);
          return;
        }
        // 8-bit: a tiny per-frame multiply would round back to the same value forever, so
        // fade in larger steps and finish with an exact one-step offset that reaches zero.
        ldrFadeAcc += step;
        if (ldrFadeAcc < LDR_FADE_INTERVAL) return;
        var steps = Math.min(8, Math.floor(ldrFadeAcc / LDR_FADE_INTERVAL));
        fadeAcc(Math.exp(-ldrFadeAcc / TRAIL_TAU), steps / 255);
        ldrFadeAcc = 0;
      }

      // Advance every particle by h seconds, writing quads; deposit weight w (pre-applied decay).
      function simulate(h, w) {
        var Hpx = H;
        var lx = light[0], ly = light[1];
        var pc = paletteCenter;
        var vmin2 = (SPEED * 0.1) * (SPEED * 0.1);
        var slowRef = 1 / (0.6 * SPEED * 0.6 * SPEED);
        var lo = -MARGIN - 0.02, hiX = aspect + MARGIN + 0.02, hiY = 1 + MARGIN + 0.02;
        var nq = 0, o = 0;
        var baseI = intensityBase * w * depositScale;
        for (var i = 0; i < count; i++) {
          var x = px[i], y = py[i];
          var sp = spMul[i];
          // Midpoint (RK2) integration.
          sample(x, y, false);
          var mx = x + sVX * sp * h * 0.5, my = y + sVY * sp * h * 0.5;
          sample(mx, my, true);
          var vx = sVX, vy = sVY;
          var v2 = vx * vx + vy * vy;
          var boost = Math.sqrt((v2 + vmin2) / (v2 + 1e-12));
          var nx = x + vx * boost * sp * h, ny = y + vy * boost * sp * h;
          var a = age[i] + h;
          if (a >= life[i] || nx < lo || nx > hiX || ny < lo || ny > hiY) {
            spawn(i, false);
            continue;
          }
          age[i] = a;
          px[i] = nx; py[i] = ny;

          var dx = nx - x, dy = ny - y;
          var len = Math.sqrt(dx * dx + dy * dy);
          if (len < 1e-9) continue;
          var ux = dx / len, uy = dy / len;

          // Tapered life envelope, satin sheen from the thread direction, and colour.
          var lt = a / life[i];
          var env1 = lt < 0.18 ? lt / 0.18 : lt > 0.7 ? (1 - lt) / 0.3 : 1;
          env1 = env1 * env1 * (3 - 2 * env1);
          var al = ux * lx + uy * ly;
          al *= al;
          var sheen = al * al * al;               // |cos|^6: a narrow satin highlight
          var z = depth[i];
          // Threads thin out where the flow stalls (saddles, vortex cores): those points wander
          // as the field evolves, and long trails there would cross into frizz.
          var flow = v2 * slowRef;
          flow = flow > 1 ? 1 : flow;
          var I = baseI * inten[i] * env1 * sL * flow * (0.62 + sheen * (0.75 + 0.5 * z));
          if (I < 1e-5) continue;

          var ct = pc + sC * 0.55 + jitter[i];
          ct = ct < 0 ? 0 : ct > 1 ? 1 : ct;
          var li = ((ct * 255) | 0) * 3;
          var cr = RAMP_LUT[li], cg = RAMP_LUT[li + 1], cb = RAMP_LUT[li + 2];
          // Warm where the light falls; in shadow, a growing share of threads turn teal.
          var dark = 1 - (sL - 0.3) * 2.0;
          dark = dark < 0 ? 0 : dark > 1 ? 1 : dark;
          var sh = (dark * 0.5 - coolRank[i]) * 8 + 0.5;
          if (sh > 0) {
            sh = sh > 1 ? 0.9 : sh * 0.9;
            cr += (SHADOW[0] - cr) * sh; cg += (SHADOW[1] - cg) * sh; cb += (SHADOW[2] - cb) * sh;
          }
          // Distant threads: a dustier, slightly cooler version of their own colour.
          var fz = (1 - z) * 0.22;
          var lum = (0.3 * cr + 0.6 * cg + 0.1 * cb) * fz;
          var r = (cr * (1 - fz) + lum * 0.92) * I;
          var g = (cg * (1 - fz) + lum * 0.96) * I;
          var b = (cb * (1 - fz) + lum * 1.08) * I;

          var hw = hwPx[i];
          var ox = -uy * hw, oy = ux * hw;
          var X0 = x * Hpx, Y0 = y * Hpx, X1 = nx * Hpx, Y1 = ny * Hpx;
          o = nq * 24;
          vertData[o] = X0 - ox; vertData[o + 1] = Y0 - oy; vertData[o + 2] = -1;
          vertData[o + 3] = r; vertData[o + 4] = g; vertData[o + 5] = b;
          vertData[o + 6] = X0 + ox; vertData[o + 7] = Y0 + oy; vertData[o + 8] = 1;
          vertData[o + 9] = r; vertData[o + 10] = g; vertData[o + 11] = b;
          vertData[o + 12] = X1 - ox; vertData[o + 13] = Y1 - oy; vertData[o + 14] = -1;
          vertData[o + 15] = r; vertData[o + 16] = g; vertData[o + 17] = b;
          vertData[o + 18] = X1 + ox; vertData[o + 19] = Y1 + oy; vertData[o + 20] = 1;
          vertData[o + 21] = r; vertData[o + 22] = g; vertData[o + 23] = b;
          nq++;
        }
        flushQuads(nq);
      }

      // Advance the simulation by `step` seconds of sim time and deposit the threads.
      function advance(step, opts) {
        if (!(step > 0)) return;
        var big = step > 1.0;
        var maxH = big ? 1 / 10 : 1 / 30;
        // The field changes on a ~minute scale; long catch-ups can refresh it less often.
        var refresh = big ? 0.4 : 0.12;
        var n = Math.max(1, Math.ceil(step / maxH));
        if (n > 720) n = 720;
        var h = step / n;
        if (!(opts && opts.noFade)) fadeFor(step);

        gl.bindFramebuffer(gl.FRAMEBUFFER, acc.framebuffer);
        gl.viewport(0, 0, acc.width, acc.height);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE);
        threadProg.use();
        threadProg.set('u_res', [W, H]);
        threadProg.set('u_scale', 1);
        bindThreadAttribs();
        for (var s = 0; s < n; s++) {
          if (simTime - fieldTime > refresh || simTime < fieldTime) computeField(simTime + h * 0.5);
          var w = Math.exp(-(step - (s + 1) * h) / TRAIL_TAU);
          simulate(h, w);
          simTime += h;
        }
        unbindThreadAttribs();
      }

      function clearAcc() {
        gl.bindFramebuffer(gl.FRAMEBUFFER, acc.framebuffer);
        gl.viewport(0, 0, acc.width, acc.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        ldrFadeAcc = 0;
      }

      function glowEnabled() { return env.quality !== 'saver' && glowA && glowB; }

      function renderGlow() {
        gl.disable(gl.BLEND);
        // downsample acc → glowA
        gl.bindFramebuffer(gl.FRAMEBUFFER, glowA.framebuffer);
        gl.viewport(0, 0, glowA.width, glowA.height);
        downProg.use();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, acc.texture);
        downProg.set('u_src', 0);
        downProg.set('u_texel', [1 / acc.width, 1 / acc.height]);
        downProg.set('u_gain', composeGain * 1.2);
        tri.draw();
        // blur H: glowA → glowB, blur V: glowB → glowA
        blurProg.use();
        blurProg.set('u_src', 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, glowB.framebuffer);
        gl.bindTexture(gl.TEXTURE_2D, glowA.texture);
        blurProg.set('u_dir', [1.6 / glowA.width, 0]);
        tri.draw();
        gl.bindFramebuffer(gl.FRAMEBUFFER, glowA.framebuffer);
        gl.bindTexture(gl.TEXTURE_2D, glowB.texture);
        blurProg.set('u_dir', [0, 1.6 / glowA.height]);
        tri.draw();
      }

      function compose() {
        var glow = glowEnabled();
        if (glow) renderGlow();
        gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, W, H);
        composeProg.use();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, acc.texture);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, glow ? glowA.texture : blackTex);
        gl.activeTexture(gl.TEXTURE0);
        composeProg.set('u_acc', 0);
        composeProg.set('u_glow', 1);
        composeProg.set('u_res', [W, H]);
        composeProg.set('u_gain', composeGain);
        composeProg.set('u_glowAmt', glow ? 0.34 : 0);
        composeProg.set('u_lamp', [-0.18 * aspect, 0.22]);
        composeProg.set('u_bgDeep', [0.017, 0.017, 0.024]);
        composeProg.set('u_bgLift', [0.030, 0.022, 0.018]);
        composeProg.set('u_lampTint', [1.0, 0.86, 0.70]);
        tri.draw();
      }

      function allocTargets() {
        freeTarget(acc); freeTarget(glowA); freeTarget(glowB);
        acc = makeTarget(W, H, !options.driftLowPrecision, false);
        // 8-bit storage clips at 1.0: store at reduced scale and compensate when composing.
        depositScale = acc.hdr ? 1 : 0.45;
        composeGain = acc.hdr ? 1 : 1 / 0.45;
        var gw = Math.max(1, Math.round(W / 4)), gh2 = Math.max(1, Math.round(H / 4));
        glowA = makeTarget(gw, gh2, false, true);
        glowB = makeTarget(gw, gh2, false, true);
      }

      function layout(prewarmSeconds) {
        W = Math.max(1, env.width | 0);
        H = Math.max(1, env.height | 0);
        aspect = W / H;
        ratio = env.pixelRatio || 1;
        allocTargets();
        setupGrid();
        // Respawn anything that no longer fits the new aspect.
        for (var i = 0; i < count; i++) {
          if (px[i] > aspect + MARGIN || px[i] < -MARGIN) spawn(i, true);
        }
        setupParticles();
        clearAcc();
        advance(prewarmSeconds, { noFade: true });
      }

      layout(PREWARM);

      var api = {
        resize: function () {
          layout(PREWARM * 0.75);
        },
        render: function (t) {
          if (gl.isContextLost()) return;
          if (env.quality !== quality) { setupParticles(); }
          if (lastT === null) lastT = t;
          var step = t - lastT;
          lastT = t;
          if (step > 0) {
            if (step > 60) step = 60;     // freeze/warp catch-up cap
            advance(step);
          }
          compose();
        },
        destroy: function () {
          freeTarget(acc); freeTarget(glowA); freeTarget(glowB);
          acc = glowA = glowB = null;
          if (blackTex) gl.deleteTexture(blackTex);
          blackTex = null;
          gl.deleteBuffer(vbo);
          gl.deleteBuffer(ibo);
          tri.destroy();
          threadProg.destroy(); solidProg.destroy(); downProg.destroy(); blurProg.destroy(); composeProg.destroy();
          psi = gvx = gvy = gcol = glum = null;
          vertData = null;
        }
      };
      return api;
    }
  });
})(window);
