/*
 * Analog Brick — "Breath" visual mode (id "breath").
 *
 * A soft, luminous orb that paces your breathing. It grows on the inhale, rests on the
 * hold and shrinks on the exhale; a faint guide ring marks the full-inhale size and a
 * quiet word below it ("breathe in", "hold", "breathe out") names the current phase.
 *
 *   • pattern     env.options.breathPattern, read every frame (the setup screen changes it
 *                 live): 'box' 4·4·4·4 (default), 'coherent' 5.5·5.5, 'relax' 4·7·8.
 *   • clock       the breathing phase comes from the WALL CLOCK (Date.now()), so every
 *                 display — each running its own stage — breathes in step. A pattern
 *                 change blends over ~2 s instead of jumping.
 *   • orb         a pearl-like sphere of light: luminous body, warm inner glow, gentle
 *                 limb brightening, and slow 3D noise "shimmer" mapped onto the sphere
 *                 (a little livelier during holds). Size eases (easeInOutSine) between
 *                 22 % and 38 % of min(viewport) in diameter.
 *   • halo        three-term falloff from the orb's edge, scattered through a faint,
 *                 slowly drifting mist that also textures the background.
 *   • background  deep gradient pooled around the orb; its hue drifts over minutes,
 *                 dusk blue ↔ plum ↔ dusk blue ↔ deep teal (also wall-clock driven).
 *   • overlay     DOM: the phase word (serif italic, lowercase, letter-spaced, low contrast,
 *                 crossfaded) and a tiny timeline of the cycle whose current segment fills.
 *                 Hidden below ~400 css px wide (thumbnails).
 *
 * Seed (per display) changes the shimmer and mist patterns only; timing and colour stay
 * shared so side-by-side displays read as one scene.
 *
 * Frozen stages (setup thumbnails) render a fixed, representative moment: most of the way
 * through an inhale, in dusk blue.
 *
 * Single WebGL1 pass (GLSL ES 1.00), linear light → tonemap → sRGB → triangular dither.
 */
(function (global) {
  'use strict';

  var BV = global.BrickVisuals;
  if (!BV) return;

  // ───────────────────────── breathing ─────────────────────────
  // kind: 'in' | 'top' (hold after inhale) | 'out' | 'bottom' (hold after exhale)
  var PATTERNS = {
    box:      [{ kind: 'in', dur: 4 }, { kind: 'top', dur: 4 }, { kind: 'out', dur: 4 }, { kind: 'bottom', dur: 4 }],
    coherent: [{ kind: 'in', dur: 5.5 }, { kind: 'out', dur: 5.5 }],
    relax:    [{ kind: 'in', dur: 4 }, { kind: 'top', dur: 7 }, { kind: 'out', dur: 8 }]
  };
  Object.keys(PATTERNS).forEach(function (k) {
    var total = 0;
    PATTERNS[k].forEach(function (ph) { total += ph.dur; });
    PATTERNS[k].total = total;
  });
  var WORDS = { 'in': 'breathe in', top: 'hold', out: 'breathe out', bottom: 'hold' };

  var CENTER_Y = 0.47;          // orb centre, fraction of the height from the top
  var R_MIN = 0.11;             // radius as a fraction of min(viewport): 22 % diameter
  var R_MAX = 0.19;             //                                          38 % diameter
  var PATTERN_BLEND = 2.2;      // seconds to blend when the pattern changes
  var WORD_LEAD = 0.35;         // seconds: the word starts crossfading slightly early
  var HOLD_RAMP = 0.9;          // seconds: hold shimmer eases in/out over this
  var MIST_DIV = 4;             // mist pass resolution divisor

  function patternFor(key) { return PATTERNS[key] ? key : 'box'; }

  /** Phase at wall-clock seconds `sec`: { index, kind, dur, elapsed, p }. */
  function phaseAt(key, sec) {
    var pat = PATTERNS[key];
    var x = sec % pat.total;
    if (x < 0) x += pat.total;
    for (var i = 0; i < pat.length; i++) {
      if (x < pat[i].dur || i === pat.length - 1) {
        var e = Math.min(x, pat[i].dur);
        return { index: i, kind: pat[i].kind, dur: pat[i].dur, elapsed: e, p: e / pat[i].dur };
      }
      x -= pat[i].dur;
    }
    return null;
  }

  function easeInOutSine(t) { return -(Math.cos(Math.PI * t) - 1) / 2; }

  /** 0 = fully exhaled, 1 = fully inhaled. */
  function fullness(ph) {
    switch (ph.kind) {
      case 'in': return easeInOutSine(ph.p);
      case 'top': return 1;
      case 'out': return 1 - easeInOutSine(ph.p);
      default: return 0;
    }
  }

  /** 0…1, eased in and out at the ends of a hold. */
  function holdAmount(ph) {
    if (ph.kind !== 'top' && ph.kind !== 'bottom') return 0;
    var r = Math.min(HOLD_RAMP, ph.dur / 2);
    var a = Math.min(1, ph.elapsed / r), b = Math.min(1, (ph.dur - ph.elapsed) / r);
    return easeInOutSine(Math.min(a, b));
  }

  // ───────────────────────── colour ─────────────────────────
  // sRGB hex; converted to linear light once.
  var THEMES = {
    blue: { deep: '#03050b', mid: '#0a1227', haze: '#26396b', orb: '#adc4ee', halo: '#5b80c9', core: '#fff4e8' },
    plum: { deep: '#060409', mid: '#170c1e', haze: '#4f2d57', orb: '#dfbddb', halo: '#a46b97', core: '#fff2ea' },
    teal: { deep: '#02080a', mid: '#071b1e', haze: '#1d5150', orb: '#abdfd6', halo: '#4c9e93', core: '#f7fbef' }
  };
  var ROLES = ['deep', 'mid', 'haze', 'orb', 'halo', 'core'];
  var THEME_ORDER = ['blue', 'plum', 'blue', 'teal'];   // ping-pong through dusk blue: never plum↔teal directly
  var THEME_LEG = 210;                                  // seconds per leg → a 14-minute cycle

  function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }

  // ───────────────────────── shader ─────────────────────────
  var HEADER = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    ''
  ].join('\n');

  // Pass 1 — mist, at quarter resolution (it is very low-frequency).
  // R: mist density 0…1, G: slow secondary tint 0…1.
  var MIST_FS = [
    'varying vec2 v_uv;',
    'uniform vec2 uRes;        // canvas size (px)',
    'uniform vec2 uC;          // orb centre (canvas px)',
    'uniform float uM;         // min(canvas w, h)',
    'uniform float uT;',
    'uniform vec4 uSeed;',
    '',
    'float mist(vec2 p) {',
    '  float s = 0.0, a = 0.5;',
    '  for (int i = 0; i < MIST_OCT; i++) {',
    '    s += a * snoise(p);',
    '    p = rot2(0.6) * p * 2.07 + vec2(11.7, 5.3);',
    '    a *= 0.5;',
    '  }',
    '  return s;',
    '}',
    '',
    'void main() {',
    '  vec2 pn = (v_uv * uRes - uC) / uM;',
    '  vec2 mp = pn * 1.1 + uSeed.xy;',
    '  vec2 w = vec2(snoise(mp * 0.5 + vec2(uT * 0.009, 3.1)), snoise(mp * 0.5 + vec2(7.7, -uT * 0.007)));',
    '  float f = mist(mp + w * 0.65 + vec2(uT * 0.004, -uT * 0.0027));',
    '  float mv = smoothstep(-0.65, 0.75, f);',
    '  float tint = 0.5 + 0.5 * snoise(pn * 0.6 + uSeed.yx + vec2(-uT * 0.0021, uT * 0.0017));',
    '  gl_FragColor = vec4(mv, tint, 0.0, 1.0);',
    '}'
  ].join('\n');

  // Pass 2 — composite at canvas resolution.
  var FS = [
    'varying vec2 v_uv;',
    'uniform sampler2D uMist;',
    'uniform vec2 uRes;        // canvas size (px)',
    'uniform vec2 uC;          // orb centre (px, GL origin bottom-left)',
    'uniform vec3 uR;          // orb radius now, guide-ring radius, min(res)   (px)',
    'uniform float uPr;        // canvas px per css px',
    'uniform float uT;         // shimmer clock (s)',
    'uniform vec4 uSeed;',
    'uniform vec4 uB;          // fullness 0…1, hold shimmer 0…1, brightness, unused',
    'uniform vec3 uDeep;',
    'uniform vec3 uMid;',
    'uniform vec3 uHaze;',
    'uniform vec3 uOrb;',
    'uniform vec3 uHalo;',
    'uniform vec3 uCore;',
    '',
    '// light from the orb as a function of distance from its edge, in orb radii',
    'float haloAt(float o) {',
    '  return 0.26 * exp(-o * 5.0) + 0.12 * exp(-o * 1.7) + 0.045 * exp(-o * 0.55);',
    '}',
    '',
    'void main() {',
    '  vec2 fc = gl_FragCoord.xy;',
    '  vec2 d = fc - uC;',
    '  float dist = length(d);',
    '  float R = uR.x;',
    '  vec2 pn = d / uR.z;                    // orb-centred, short side = 1',
    '  vec4 ms = texture2D(uMist, fc / uRes);',
    '  float mv = ms.r;',
    '',
    '  // ── background: a deep pool of colour around the orb, faint mist ──',
    '  float rn = length(pn * vec2(0.8, 1.0));',
    '  vec3 mid = mix(uMid, mix(uMid, uHaze, 0.22), smoothstep(0.35, 0.85, ms.g));',
    '  vec3 col = mix(mid, uDeep, smoothstep(0.02, 0.95, rn));',
    '  col *= 0.86 + 0.28 * mv;',
    '',
    '  // ── halo, scattered through the mist ──',
    '  float o = max(dist - R, 0.0) / R;',
    '  float halo = haloAt(o) * uB.z;',
    '  float scatter = mix(1.0, 0.6 + 0.8 * mv, smoothstep(0.1, 1.5, o));',
    '  col += uHalo * halo * scatter;',
    '',
    '  // ── guide ring at the full-inhale radius, lit by the halo ──',
    '  float sig = max(0.5 * uPr, 0.7);',
    '  float rr = dist - uR.y;',
    '  float ring = exp(-0.5 * rr * rr / (sig * sig)) * min(1.0, 0.7 * uPr / sig);',
    '  float ringLit = 0.06 + 0.8 * haloAt(max(uR.y - R, 0.0) / R) * uB.z;',
    '  col += mix(uHalo, vec3(1.0, 0.96, 0.9), 0.5) * ring * ringLit * (0.55 + 0.6 * mv) * 0.5;',
    '',
    '  // ── the orb ──',
    '  float aa = max(1.6 * uPr, R * 0.012) / R;',
    '  float r = dist / R;',
    '  if (r < 1.0 + 2.0 * aa) {',
    '    vec2 q = d / R;',
    '    float z = sqrt(max(1.0 - r * r, 0.0));',
    '    vec3 n = vec3(q, z);',
    '    n.xz = rot2(uT * 0.019 + uSeed.z) * n.xz;',
    '    n.yz = rot2(0.4) * n.yz;',
    '    float sn = snoise(n * 1.6 + vec3(uSeed.w, 0.0, uT * 0.035));',
    '#if SURF_OCT > 1',
    '    sn = sn * 0.7 + 0.3 * snoise(n * 3.9 + vec3(0.0, uT * 0.05, uSeed.w));',
    '#endif',
    '    // holds: a finer, slightly livelier shimmer fades in',
    '    float hs = uB.y > 0.001 ? snoise(n * 6.5 + vec3(uT * 0.21, -uT * 0.17, uSeed.w)) : 0.0;',
    '    float shimmer = 1.0 + 0.07 * sn + 0.045 * uB.y * hs;',
    '    float body = pow(z, 0.75);',
    '    float core = exp(-r * r * 2.2);',
    '    float rim = pow(1.0 - z, 2.5);',
    '    vec3 c = uOrb * (0.10 + 0.42 * body) + uCore * core * 0.42 + uHalo * rim * 0.42;',
    '    // a soft sheen toward the upper left so it reads as round',
    '    vec2 sq = q - vec2(-0.30, 0.34);',
    '    c += uCore * 0.07 * exp(-dot(sq, sq) * 2.6);',
    '    c *= shimmer * uB.z;',
    '    float cov = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);',
    '    col = mix(col, c + uHalo * haloAt(0.0) * uB.z * 0.5, cov);',
    '  }',
    '',
    '  // ── gentle vignette ──',
    '  vec2 uv = fc / uRes - 0.5;',
    '  col *= 1.0 - 0.3 * smoothstep(0.45, 1.2, length(uv * vec2(1.0, 0.85)) * 1.4);',
    '',
    '  col = tonemap(col);',
    '  col = pow(col, vec3(1.0 / 2.2));',
    '  col += (hash12(fc) + hash12(fc + 71.3) - 1.0) / 255.0;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var Q = {
    saver:    { mist: 2, surf: 1 },
    balanced: { mist: 3, surf: 2 },
    high:     { mist: 4, surf: 2 }
  };

  // ───────────────────────── overlay (DOM) ─────────────────────────
  var EASE = 'cubic-bezier(0.45, 0, 0.55, 1)';
  var TEXT_RGB = '246, 242, 234';

  function div(css) { var e = document.createElement('div'); if (css) e.style.cssText = css; return e; }

  BV.register({
    id: 'breath',
    name: 'Breath',
    tagline: 'A glowing orb that paces your breath',
    order: 30,
    context: 'webgl',
    renderScale: { saver: 0.5, balanced: 0.7, high: 1.0 },
    musicReactive: false,

    create: function (env) {
      var gl = env.gl;
      var U = env.util, G = U.gl;
      var lib = U.glsl.common + '\n' + U.glsl.noise + '\n';

      var rand = U.mulberry32(((env.seed | 0) + 1) * 48271 + 11);
      var seed = [rand() * 100 - 50, rand() * 100 - 50, rand() * Math.PI * 2, rand() * 100];
      var timeOff = rand() * 400;

      var linThemes = {};
      Object.keys(THEMES).forEach(function (name) {
        var th = {};
        ROLES.forEach(function (role) { th[role] = U.hexToRgb(THEMES[name][role]).map(srgbToLinear); });
        linThemes[name] = th;
      });

      // ── GL ──
      var tri = G.fullscreenTriangle(gl);
      var programs = {};
      function programsFor() {
        var q = Q[env.quality] ? env.quality : 'balanced';
        if (!programs[q]) {
          var defs = '#define MIST_OCT ' + Q[q].mist + '\n#define SURF_OCT ' + Q[q].surf + '\n';
          programs[q] = {
            mist: G.createProgram(gl, G.FULLSCREEN_VS, HEADER + defs + lib + MIST_FS),
            comp: G.createProgram(gl, G.FULLSCREEN_VS, HEADER + defs + lib + FS)
          };
        }
        return programs[q];
      }
      programsFor();

      var mistRT = null;
      function ensureTargets() {
        var mw = Math.max(8, Math.round(env.width / MIST_DIV)), mh = Math.max(8, Math.round(env.height / MIST_DIV));
        if (mistRT && mistRT.width === mw && mistRT.height === mh) return;
        if (mistRT) mistRT.destroy();
        mistRT = G.createRenderTarget(gl, mw, mh);
      }
      ensureTargets();

      // ── overlay ──
      var ui = div('position:absolute;left:0;right:0;top:0;display:flex;flex-direction:column;align-items:center;' +
        'pointer-events:none;opacity:0;transition:opacity 1.6s ' + EASE + ';');
      var wordBox = div('position:relative;width:100%;height:1.5em;');
      function makeWord() {
        var w = div('position:absolute;left:0;right:0;top:0;text-align:center;white-space:nowrap;' +
          'font-family:ui-serif,"New York","Iowan Old Style",Georgia,serif;font-style:italic;font-weight:400;' +
          'letter-spacing:0.16em;padding-left:0.16em;line-height:1.5em;color:rgba(' + TEXT_RGB + ',0.5);' +
          'text-shadow:0 1px 14px rgba(0,0,0,0.35);opacity:0;filter:blur(3px);-webkit-filter:blur(3px);' +
          'transform:translateY(3px);will-change:opacity;' +
          'transition:opacity 1.1s ' + EASE + ',filter 1.1s ' + EASE + ',-webkit-filter 1.1s ' + EASE + ',transform 1.4s ' + EASE + ';');
        wordBox.appendChild(w);
        return w;
      }
      var words = [makeWord(), makeWord()];
      var activeWord = -1, shownText = null;
      var track = div('display:flex;align-items:center;justify-content:center;gap:5px;margin-top:0.7em;');
      var segs = [], segKey = null;
      ui.appendChild(wordBox);
      ui.appendChild(track);
      env.overlay.appendChild(ui);

      function setWordVisible(w, on) {
        w.style.opacity = on ? '1' : '0';
        w.style.filter = on ? 'blur(0px)' : 'blur(3px)';
        w.style.webkitFilter = w.style.filter;
        w.style.transform = on ? 'translateY(0)' : 'translateY(-3px)';
      }

      function showWord(text, instant) {
        if (text === shownText) return;
        shownText = text;
        var next = activeWord === 0 ? 1 : 0;
        var inc = words[next], out = words[activeWord] || null;
        // incoming word starts slightly below and blurred, settles in place
        inc.style.transition = 'none';
        inc.style.transform = 'translateY(3px)';
        inc.textContent = text;
        void inc.offsetWidth;
        inc.style.transition = instant ? 'none' :
          'opacity 1.1s ' + EASE + ',filter 1.1s ' + EASE + ',-webkit-filter 1.1s ' + EASE + ',transform 1.4s ' + EASE;
        setWordVisible(inc, true);
        if (out) {
          if (instant) out.style.transition = 'none';
          setWordVisible(out, false);
        }
        activeWord = next;
      }

      function buildSegments(key) {
        segKey = key;
        track.textContent = '';
        segs = [];
        var pat = PATTERNS[key];
        var total = pat.total;
        for (var i = 0; i < pat.length; i++) {
          var s = div('position:relative;height:2px;border-radius:1px;overflow:hidden;background:rgba(' + TEXT_RGB + ',0.11);');
          s.style.width = (pat[i].dur / total * 100).toFixed(2) + '%';
          var fill = div('position:absolute;inset:0;border-radius:1px;background:rgba(' + TEXT_RGB + ',0.46);' +
            'transform-origin:0 50%;transform:scaleX(0);opacity:0;');
          s.appendChild(fill);
          track.appendChild(s);
          segs.push({ el: s, fill: fill, current: false, lastScale: -1 });
        }
      }

      function updateSegments(ph) {
        for (var i = 0; i < segs.length; i++) {
          var s = segs[i];
          if (i === ph.index) {
            if (!s.current) {
              s.current = true;
              s.fill.style.transition = 'none';
              s.fill.style.opacity = '1';
            }
            var sc = Math.round(ph.p * 400) / 400;
            if (sc !== s.lastScale) { s.fill.style.transform = 'scaleX(' + sc + ')'; s.lastScale = sc; }
          } else if (s.current) {
            s.current = false;
            s.fill.style.transition = 'opacity 1.4s ' + EASE;
            s.fill.style.opacity = '0';
          }
        }
      }

      var uiHidden = null;
      function layoutOverlay() {
        var cw = env.cssWidth, ch = env.cssHeight, m = Math.min(cw, ch);
        var hide = cw < 400 || ch < 240;
        if (hide !== uiHidden) { ui.style.display = hide ? 'none' : 'flex'; uiHidden = hide; }
        if (hide) return;
        var fs = Math.max(15, Math.min(22, m * 0.02));
        var gap = Math.max(22, Math.min(80, m * 0.07));
        ui.style.fontSize = fs.toFixed(1) + 'px';
        ui.style.top = Math.round(ch * CENTER_Y + m * R_MAX + gap) + 'px';
        track.style.width = Math.round(fs * 5.2) + 'px';
      }
      layoutOverlay();

      // ── time ──
      var lastT = null, perfLast = null, warpExtra = 0;
      var curKey = null, prevKey = null, blendStart = 0;
      var started = false;

      function clockMs(t, dt, frozen) {
        var pnow = (global.performance && performance.now) ? performance.now() : Date.now();
        // Previews may run the stage faster than real time (timeScale): follow that, so a
        // warped preview shows the long-term evolution. At timeScale 1 this stays 0.
        if (!frozen && perfLast !== null) {
          var real = (pnow - perfLast) / 1000;
          if (real > 0 && real < 0.25 && dt > real * 1.5) warpExtra += (dt - real) * 1000;
        }
        perfLast = pnow;
        return Date.now() + warpExtra;
      }

      function themeAt(sec, frozen) {
        var out = {};
        if (frozen) {
          ROLES.forEach(function (r) { out[r] = U.mixRgb(linThemes.blue[r], linThemes.teal[r], 0.22); });
          return out;
        }
        var x = sec / THEME_LEG;
        var i = Math.floor(x), f = x - i;
        var n = THEME_ORDER.length;
        var a = linThemes[THEME_ORDER[((i % n) + n) % n]], b = linThemes[THEME_ORDER[(((i + 1) % n) + n) % n]];
        var e = easeInOutSine(U.clamp((f - 0.15) / 0.7, 0, 1));
        ROLES.forEach(function (r) { out[r] = U.mixRgb(a[r], b[r], e); });
        return out;
      }

      return {
        resize: function () { ensureTargets(); layoutOverlay(); },

        render: function (t, dt) {
          var frozen = dt === 0 || (lastT !== null && t === lastT);
          lastT = t;
          if (!started) { started = true; ui.style.opacity = '1'; }

          var key = patternFor(env.options && env.options.breathPattern);
          var ms = clockMs(t, dt, frozen);
          var sec = ms / 1000;
          var localSec = t;
          if (key !== curKey) {
            if (curKey !== null && !frozen) { prevKey = curKey; blendStart = localSec; }
            curKey = key;
            buildSegments(key);
          }

          var ph, full, hold;
          if (frozen) {
            // a representative still: most of the way through an inhale
            ph = { index: 0, kind: 'in', dur: PATTERNS[key][0].dur, elapsed: 0, p: 0.78 };
            ph.elapsed = ph.p * ph.dur;
            full = easeInOutSine(ph.p);
            hold = 0;
          } else {
            ph = phaseAt(key, sec);
            full = fullness(ph);
            hold = holdAmount(ph);
            if (prevKey) {
              var k = (localSec - blendStart) / PATTERN_BLEND;
              if (k >= 1 || k < 0) prevKey = null;
              else {
                var pp = phaseAt(prevKey, sec), e = easeInOutSine(k);
                full = U.lerp(fullness(pp), full, e);
                hold = U.lerp(holdAmount(pp), hold, e);
              }
            }
          }

          // ── draw ──
          var w = env.width, h = env.height;
          var m = Math.min(w, h);
          var R = m * U.lerp(R_MIN, R_MAX, full);
          var th = themeAt(sec, frozen);
          var bright = 0.84 + 0.16 * full;

          var P = programsFor();
          ensureTargets();
          var cx = w * 0.5, cy = h * (1 - CENTER_Y);
          gl.disable(gl.BLEND);
          gl.disable(gl.DEPTH_TEST);

          mistRT.bind();
          P.mist.use()
            .set('uRes', [w, h])
            .set('uC', [cx, cy])
            .set('uM', m)
            .set('uT', t + timeOff)
            .set('uSeed', seed);
          tri.draw();

          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, w, h);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, mistRT.texture);
          P.comp.use()
            .set('uMist', 0)
            .set('uRes', [w, h])
            .set('uC', [cx, cy])
            .set('uR', [R, m * R_MAX, m])
            .set('uPr', env.pixelRatio)
            .set('uT', t + timeOff)
            .set('uSeed', seed)
            .set('uB', [full, hold, bright, 0])
            .set('uDeep', th.deep)
            .set('uMid', th.mid)
            .set('uHaze', th.haze)
            .set('uOrb', th.orb)
            .set('uHalo', th.halo)
            .set('uCore', th.core);
          tri.draw();

          // ── overlay ──
          if (!uiHidden) {
            var lead = frozen ? ph : phaseAt(key, sec + WORD_LEAD);
            showWord(WORDS[lead.kind], frozen);
            updateSegments(ph);
          }
        },

        destroy: function () {
          Object.keys(programs).forEach(function (q) { programs[q].mist.destroy(); programs[q].comp.destroy(); });
          programs = {};
          if (mistRT) { mistRT.destroy(); mistRT = null; }
          tri.destroy();
          if (ui.parentNode) ui.parentNode.removeChild(ui);
        }
      };
    }
  });
})(window);
