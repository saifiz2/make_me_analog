/*
 * Analog Brick — "Gallery" visual mode.
 *
 * The user's own photos with a slow Ken Burns drift. Pure DOM (context 'none'): every photo is
 * an <img> (or a pre-scaled <canvas>) on its own compositor layer, moved with CSS transforms that
 * render(t) updates. The GPU only re-composites; nothing is re-painted per frame.
 *
 *   • env.options.images is a list of URLs (brick://gallery/N in the app, data: URLs in preview).
 *     It is re-checked every frame, so stage.setOptions({ images }) takes effect at once.
 *   • Each photo is shown ~24 s with a slow zoom (1.0 → ~1.12, sometimes reversed) and a pan
 *     toward a focal point (biased toward the most detailed / colourful part of the photo when
 *     its pixels are readable), then a 3 s crossfade into the next. The next photo is loaded,
 *     decoded and prepared ~24 s ahead; photos that fail to load are skipped.
 *   • Landscape-ish photos are cover-fitted. Photos whose shape is far from the screen's
 *     (portrait on a landscape display, squares, very wide panoramas) are shown whole, like a
 *     print, over a heavily blurred, darkened, enlarged copy of themselves.
 *   • Much larger than needed photos are downscaled once into a canvas (high-quality, by halving)
 *     so the compositor never minifies a 24 MP texture (shimmer, memory).
 *   • The blurred backdrop is built with drawImage only (downscale → cross blur → upscale), so it
 *     also works when the image is cross-origin and the canvas becomes tainted.
 *   • A static finish layer adds a soft vignette and a whisper of film grain (the grain doubles as
 *     a dither for dark gradients).
 *   • Displays start at different photos (offset by env.displayIndex) and change at different
 *     moments; env.seed varies the focal points and zoom directions.
 *   • Empty state: a slow warm gradient (a tiny canvas the compositor scales up) and one quiet line.
 */
(function (global) {
  'use strict';

  var BV = global.BrickVisuals;
  if (!BV) return;
  var U = BV.util;

  // ─────────────────────────── tuning ───────────────────────────
  var PERIOD = 24;                  // seconds between photo changes
  var XFADE = 3;                    // crossfade between photos, seconds
  var LIFE = PERIOD + XFADE;        // motion runs over the whole time a photo is visible
  var INTRO = 1.8;                  // first photo fades in from the dark base
  var MAX_PROGRESS = 1.2;           // if the next photo is late, keep drifting a little past the plan
  var ZOOM_MAX = [1.10, 1.14];      // per-photo maximum zoom range
  var ZOOM_IN_SHARE = 0.72;         // share of photos that zoom in (the rest zoom slowly out)
  var CONTAIN_ZOOM = 1.045;         // whole-photo ("print") mode breathes much less
  var COVER_RATIO = [0.7, 2.2];     // photo aspect / screen aspect inside this → cover-fit
  var PRINT_BOX = [0.86, 0.82];     // print mode: max share of screen width / height at zoom 1
  var MAX_TRAVEL = 0.26;
  var BLEED = 1;                    // css px a cover-fitted photo always extends past each screen edge            // max pan per photo, as a share of the screen's long side
  var PRESCALE_OVER = 1.4;          // pre-scale photos more than this much larger than needed
  var MAX_CANVAS = 6144;            // never allocate pre-scaled canvases larger than this
  var LOAD_TIMEOUT_MS = 20000;
  var PRELOAD_AFTER = 2;            // start preparing the next photo this long after a crossfade ends
  var ATTACH_LEAD = 1.2;            // attach the next photo (invisibly) this long before its crossfade
  var EMPTY_GRACE = 0.6;            // seconds without images before the empty state fades in
  var QUALITY_SCALE = { saver: 0.75, balanced: 1, high: 1 };   // photo backing resolution × dpr

  var INK = '#06070b';
  var SERIF = 'ui-serif, "New York", "Iowan Old Style", Charter, Georgia, serif';
  var EMPTY_TEXT = 'Choose a photo folder in setup to see your own pictures here.';
  var FAIL_TEXT = 'These photos couldn’t be opened. Choose another folder in setup.';

  // Empty-state dusk: night blue above, warm plum below, a desk-lamp amber pool, rose, teal, violet.
  var SKY = ['#0a0d1b', '#121327', '#1f1520'];
  var BLOBS = [
    { c: [255, 172, 96],  a: 0.30, r: 0.58, x: 0.24, y: 0.86, ax: 0.08, ay: 0.05, fx: 1 / 97,  fy: 1 / 131 },
    { c: [214, 104, 120], a: 0.20, r: 0.55, x: 0.78, y: 0.74, ax: 0.08, ay: 0.06, fx: 1 / 113, fy: 1 / 89 },
    { c: [64, 138, 160],  a: 0.17, r: 0.60, x: 0.84, y: 0.16, ax: 0.07, ay: 0.06, fx: 1 / 127, fy: 1 / 103 },
    { c: [112, 100, 206], a: 0.15, r: 0.55, x: 0.18, y: 0.14, ax: 0.07, ay: 0.06, fx: 1 / 89,  fy: 1 / 141 }
  ];

  var ICON_SVG =
    '<svg width="44" height="34" viewBox="0 0 44 34" fill="none" stroke="currentColor" stroke-width="1.2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="1.6" y="1.6" width="40.8" height="30.8" rx="3.2"/>' +
    '<circle cx="30.5" cy="10.5" r="3.1"/>' +
    '<path d="M5 28.5 15.4 17.6 23 24.6 28 20.2 39 28.5"/></svg>';

  // ─────────────────────────── helpers ───────────────────────────
  var clamp = U.clamp, lerp = U.lerp, ease = U.easing.inOutSine;

  function nowMs() { return (global.performance && performance.now) ? performance.now() : Date.now(); }

  function hashStr(h, s) {
    for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    return h;
  }
  function mixSeed(a, b) {
    var h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ ((b | 0) + 0x632be5ab), 0xc2b2ae35) >>> 0;
    return (h ^ (h >>> 15)) >>> 0;
  }
  /** Stable across displays: same list → same order (varies hour to hour, so sessions differ). */
  function hashList(list) {
    var h = 2166136261 >>> 0;
    h = hashStr(h, String(list.length));
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      h = hashStr(h, u.length + ':' + u.slice(0, 40) + u.slice(-40));
    }
    return mixSeed(h, Math.floor(Date.now() / 3600000));
  }
  function permutation(n, seed) {
    var p = [], r = U.mulberry32(seed);
    for (var i = 0; i < n; i++) p.push(i);
    for (i = n - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var t = p[i]; p[i] = p[j]; p[j] = t; }
    return p;
  }
  /** Where display k starts in an n-photo playlist: golden-ratio spread, distinct while k < n. */
  function displayOffset(k, n) {
    if (n <= 1) return 0;
    var used = [], o = 0;
    for (var j = 0; j <= k; j++) {
      o = Math.round(U.fract(j * 0.6180339887) * n) % n;
      if (j < n) { while (used.indexOf(o) >= 0) o = (o + 1) % n; }
      used.push(o);
    }
    return o;
  }
  function approach(cur, target, rate, dt) {
    var d = target - cur, step = rate * dt;
    return Math.abs(d) <= step ? target : cur + (d > 0 ? step : -step);
  }

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }
  function ctx2d(c, readback) {
    var g = null;
    try { g = c.getContext('2d', readback ? { willReadFrequently: true } : undefined); } catch (e) { g = null; }
    if (g) { g.imageSmoothingEnabled = true; try { g.imageSmoothingQuality = 'high'; } catch (e) { /* old engines */ } }
    return g;
  }
  function freeCanvas(c) { if (c && c.getContext) { c.width = 0; c.height = 0; } }

  /**
   * High-quality downscale of a region (sx, sy, sw, sh) of src to tw × th: halve with bilinear
   * filtering (an exact 2×2 box) until close, then one final filtered draw. drawImage only.
   */
  function downscale(src, sx, sy, sw, sh, tw, th) {
    tw = Math.max(1, Math.round(tw)); th = Math.max(1, Math.round(th));
    var cur = src, cx = sx, cy = sy, cw = sw, ch = sh, tmp = null;
    while (cw > tw * 2.2 && ch > th * 2.2) {
      var nw = Math.max(tw, Math.round(cw / 2)), nh = Math.max(th, Math.round(ch / 2));
      var c = makeCanvas(nw, nh), g = ctx2d(c);
      if (!g) { freeCanvas(c); break; }
      g.drawImage(cur, cx, cy, cw, ch, 0, 0, nw, nh);
      if (tmp) freeCanvas(tmp);
      tmp = c; cur = c; cx = 0; cy = 0; cw = nw; ch = nh;
    }
    var out = makeCanvas(tw, th), go = ctx2d(out);
    if (!go) { freeCanvas(out); if (tmp) freeCanvas(tmp); return null; }
    go.drawImage(cur, cx, cy, cw, ch, 0, 0, tw, th);
    if (tmp) freeCanvas(tmp);
    return out;
  }

  /** Cross-shaped running-average blur, drawImage only (works on tainted canvases). */
  function softBlur(c, passes) {
    var w = c.width, h = c.height, t = makeCanvas(w, h), gt = ctx2d(t), g = ctx2d(c);
    if (!gt || !g) { freeCanvas(t); return; }
    var offs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (var p = 0; p < passes; p++) {
      gt.globalAlpha = 1;
      gt.clearRect(0, 0, w, h);
      gt.drawImage(c, 0, 0);
      for (var i = 0; i < offs.length; i++) { gt.globalAlpha = 1 / (i + 2); gt.drawImage(c, offs[i][0], offs[i][1]); }
      g.globalAlpha = 1;
      g.clearRect(0, 0, w, h);
      g.drawImage(t, 0, 0);
    }
    freeCanvas(t);
  }
  function upscale(c, w, h) {
    var o = makeCanvas(w, h), g = ctx2d(o);
    if (!g) { freeCanvas(o); return c; }
    g.drawImage(c, 0, 0, c.width, c.height, 0, 0, o.width, o.height);
    freeCanvas(c);
    return o;
  }

  // Film grain tile (shared by every instance). Normal-blend neutral grey noise at a low alpha:
  // ±~3 levels of noise in the midtones, which also breaks up banding in dark gradients.
  var grainURL = null;
  function grainTile() {
    if (grainURL !== null) return grainURL;
    grainURL = '';
    try {
      var N = 160, c = makeCanvas(N, N), g = c.getContext('2d');
      var id = g.createImageData(N, N), d = id.data, r = U.mulberry32(91573);
      for (var i = 0; i < N * N; i++) {
        var v = Math.round((r() * 0.75 + r() * 0.25) * 255);
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
        d[i * 4 + 3] = 10;
      }
      g.putImageData(id, 0, 0);
      grainURL = c.toDataURL('image/png');
      freeCanvas(c);
    } catch (e) { grainURL = ''; }
    return grainURL;
  }

  /**
   * Rough "where is the subject" map on a tiny copy: local contrast + saturation.
   * Returns null when the pixels are not readable (cross-origin) — callers fall back to random.
   */
  function analyse(small) {
    try {
      var long = 24, a = small.width / small.height;
      var gw = Math.max(4, Math.round(a >= 1 ? long : long * a)), gh = Math.max(4, Math.round(a >= 1 ? long / a : long));
      var c = makeCanvas(gw, gh), g = ctx2d(c, true);
      if (!g) return null;
      g.drawImage(small, 0, 0, small.width, small.height, 0, 0, gw, gh);
      var d = g.getImageData(0, 0, gw, gh).data;
      freeCanvas(c);
      var n = gw * gh, lum = new Float32Array(n), sat = new Float32Array(n), score = new Float32Array(n);
      for (var i = 0; i < n; i++) {
        var R = d[i * 4] / 255, G = d[i * 4 + 1] / 255, B = d[i * 4 + 2] / 255;
        var mx = Math.max(R, G, B), mn = Math.min(R, G, B);
        lum[i] = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        sat[i] = mx > 0.02 ? (mx - mn) / mx : 0;
      }
      for (var y = 0; y < gh; y++) {
        for (var x = 0; x < gw; x++) {
          var k = y * gw + x, s = 0, m = 0;
          if (x > 0) { s += Math.abs(lum[k] - lum[k - 1]); m++; }
          if (x < gw - 1) { s += Math.abs(lum[k] - lum[k + 1]); m++; }
          if (y > 0) { s += Math.abs(lum[k] - lum[k - gw]); m++; }
          if (y < gh - 1) { s += Math.abs(lum[k] - lum[k + gw]); m++; }
          score[k] = (m ? s / m : 0) * 3 + sat[k] * 0.35 * Math.min(1, lum[k] * 4) + lum[k] * 0.1;
        }
      }
      // 3×3 smooth so single noisy pixels do not win.
      var sm = new Float32Array(n);
      for (y = 0; y < gh; y++) {
        for (x = 0; x < gw; x++) {
          var acc = 0, cnt = 0;
          for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
              var xx = x + dx, yy = y + dy;
              if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
              acc += score[yy * gw + xx]; cnt++;
            }
          }
          sm[y * gw + x] = acc / cnt;
        }
      }
      return { w: gw, h: gh, s: sm };
    } catch (e) {
      return null;   // SecurityError on a tainted canvas, or no 2D context
    }
  }

  /** Best of a few random candidates, scored by the interest map and a soft centre prior. */
  function pickFocal(map, rand) {
    var best = null, bestScore = -1;
    for (var i = 0; i < 9; i++) {
      var fx = lerp(0.22, 0.78, rand()), fy = lerp(0.24, 0.72, rand());
      var sc = 1;
      if (map) {
        var gx = clamp(Math.floor(fx * map.w), 0, map.w - 1), gy = clamp(Math.floor(fy * map.h), 0, map.h - 1);
        sc = map.s[gy * map.w + gx];
      }
      var dxc = fx - 0.5, dyc = fy - 0.47;
      sc = sc * Math.exp(-(dxc * dxc + dyc * dyc) * 3) * (0.8 + 0.4 * rand());
      if (sc > bestScore) { bestScore = sc; best = [fx, fy]; }
    }
    return best;
  }

  // ─────────────────────────── mode ───────────────────────────
  BV.register({
    id: 'gallery',
    name: 'Gallery',
    tagline: 'Your own photos, drifting slowly',
    order: 70,
    context: 'none',
    renderScale: { saver: 0.75, balanced: 1, high: 1 },
    musicReactive: false,

    create: function (env) {
      var dead = false;
      var seed = env.seed | 0;
      var displayIndex = Math.max(0, env.displayIndex | 0);
      var serial = 0;

      // ── DOM ──
      function div(cls, css) { var d = document.createElement('div'); d.className = cls; if (css) d.style.cssText = css; return d; }

      var root = div('gal-root', 'position:absolute;inset:0;overflow:hidden;background:' + INK + ';');
      root.setAttribute('aria-hidden', 'true');

      var empty = div('gal-empty', 'position:absolute;inset:0;opacity:0;visibility:hidden;will-change:opacity;');
      var emptyCanvas = makeCanvas(16, 10);
      emptyCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
      var emptyCtx = ctx2d(emptyCanvas);
      var msg = div('gal-msg', 'position:absolute;left:0;right:0;top:50%;display:flex;flex-direction:column;align-items:center;' +
        'text-align:center;padding:0 24px;color:rgba(246,242,234,0.56);-webkit-transform:translateY(-50%);transform:translateY(-50%);');
      var icon = div('gal-icon', 'color:rgba(246,242,234,0.4);line-height:0;');
      icon.innerHTML = ICON_SVG;
      var text = div('gal-text', 'font-family:' + SERIF + ';font-style:italic;font-weight:400;letter-spacing:0.01em;line-height:1.5;' +
        'max-width:36em;text-wrap:balance;');
      text.textContent = EMPTY_TEXT;
      msg.appendChild(icon);
      msg.appendChild(text);
      empty.appendChild(emptyCanvas);
      empty.appendChild(msg);

      var slidesEl = div('gal-slides', 'position:absolute;inset:0;overflow:hidden;');

      var finish = div('gal-finish', 'position:absolute;inset:0;pointer-events:none;');
      var VIGNETTE = 'radial-gradient(ellipse at 50% 46%, rgba(0,0,0,0.04) 0%, rgba(0,0,0,0.05) 38%, rgba(0,0,0,0.12) 54%, ' +
        'rgba(0,0,0,0.25) 68%, rgba(0,0,0,0.40) 82%, rgba(0,0,0,0.56) 100%)';
      var FLOOR = 'linear-gradient(to top, rgba(0,0,0,0.20) 0%, rgba(0,0,0,0.09) 14%, rgba(0,0,0,0) 30%)';
      var finishGrain = null;
      /** Vignette + floor shade always; grain only when the stage is big enough for 1 px grain to read as film. */
      function styleFinish() {
        var grain = W() >= 600 && H() >= 360 ? grainTile() : '';
        if (grain === finishGrain) return;
        finishGrain = grain;
        finish.style.backgroundImage = (grain ? 'url("' + grain + '"),' : '') + VIGNETTE + ',' + FLOOR;
        finish.style.backgroundSize = (grain ? '160px 160px,' : '') + '100% 100%,100% 100%';
        finish.style.backgroundRepeat = (grain ? 'repeat,' : '') + 'no-repeat,no-repeat';
      }
      styleFinish();

      root.appendChild(empty);
      root.appendChild(slidesEl);
      root.appendChild(finish);
      env.overlay.appendChild(root);

      // ── state ──
      var list = [], order = [], cursor = 0, bad = new Set();
      var lastRef = null, lastLen = -1;
      var current = null, next = null, outgoing = [];
      var forceNext = false, firstShown = false;
      var lastT = NaN, clock = 0;
      var emptyAmt = 0, emptyTarget = 0, slidesAmt = 1, noImagesSince = 0;
      var emptyShown = false, lastEmptyDraw = -1, lastEmptyT = NaN, lastMsgKey = '';

      function W() { return Math.max(1, env.cssWidth || 1); }
      function H() { return Math.max(1, env.cssHeight || 1); }
      function backingRatio() {
        return (global.devicePixelRatio || 1) * (QUALITY_SCALE[env.quality] || 1);
      }

      // ── playlist ──
      function goodCount() {
        var c = 0;
        for (var i = 0; i < list.length; i++) if (!bad.has(list[i])) c++;
        return c;
      }

      function setList(newList) {
        list = newList;
        var n = list.length;
        var keep = new Set();
        bad.forEach(function (u) { if (list.indexOf(u) >= 0) keep.add(u); });
        bad = keep;
        order = permutation(n, hashList(list));
        cursor = displayOffset(displayIndex, n);
        if (n === 0) noImagesSince = clock;
        if (current) {
          var idx = list.indexOf(current.url);
          if (idx < 0) forceNext = true;
          else cursor = (order.indexOf(idx) + 1) % n;
        }
        if (next && list.indexOf(next.url) < 0) { release(next); next = null; }
      }

      function checkOptions() {
        var imgs = env.options && env.options.images;
        if (!Array.isArray(imgs)) imgs = [];
        if (imgs === lastRef && imgs.length === lastLen) return;
        lastRef = imgs; lastLen = imgs.length;
        var clean = [];
        for (var i = 0; i < imgs.length; i++) if (typeof imgs[i] === 'string' && imgs[i].length) clean.push(imgs[i]);
        if (clean.length === list.length) {
          var same = true;
          for (i = 0; i < clean.length && same; i++) same = clean[i] === list[i];
          if (same) return;
        }
        setList(clean);
      }

      function loadNext() {
        var n = order.length;
        for (var tries = 0; tries < n; tries++) {
          var url = list[order[cursor % n]];
          cursor = (cursor + 1) % n;
          if (!bad.has(url)) return load(url);
        }
        return null;
      }

      // ── loading & preparation ──
      function load(url) {
        var s = { url: url, serial: ++serial, state: 'loading', started: nowMs(), img: new Image() };
        var img = s.img;
        img.decoding = 'async';
        img.onload = function () {
          if (dead || s.state !== 'loading') return;
          var done = function () { if (!dead && s.state === 'loading') prepare(s); };
          if (typeof img.decode === 'function') {
            img.decode().then(done, function () { if (img.naturalWidth > 0) done(); else fail(s); });
          } else done();
        };
        img.onerror = function () { if (!dead && s.state === 'loading') fail(s); };
        img.src = url;
        return s;
      }

      function fail(s) {
        s.state = 'failed';
        bad.add(s.url);
        release(s);
        if (next === s) next = null;
      }

      function release(s) {
        if (!s) return;
        if (s.state === 'loading') s.state = 'dropped';
        if (s.img) { s.img.onload = s.img.onerror = null; if (!s.el) { try { s.img.removeAttribute('src'); } catch (e) { /* ignore */ } } }
        if (s.el && s.el.parentNode) s.el.parentNode.removeChild(s.el);
        if (s.photo && s.photo !== s.img) freeCanvas(s.photo);
        freeCanvas(s.backdrop);
        freeCanvas(s.small);
        s.img = s.photo = s.backdrop = s.small = s.shadow = s.el = null;
      }

      function prepare(s) {
        var img = s.img;
        s.iw = img.naturalWidth; s.ih = img.naturalHeight;
        if (!(s.iw > 0 && s.ih > 0)) { fail(s); return; }
        try {
          var rand = U.mulberry32(mixSeed(seed * 7919 + 13, s.serial));
          var zmax = lerp(ZOOM_MAX[0], ZOOM_MAX[1], rand());
          s.m = {
            zoomIn: rand() < ZOOM_IN_SHARE,
            zmax: zmax,
            jx: (rand() - 0.5) * 0.4, jy: (rand() - 0.5) * 0.3,
            cdx: (rand() - 0.5) * 0.012, cdy: -0.004 - rand() * 0.006,      // print mode: tiny drift
            bz0: 1.14 + rand() * 0.04,                                          // backdrop zoom
            rand: rand
          };
          s.L = computeLayout(s);

          // Pre-scale photos that are much larger than they will ever be shown.
          var ratio = backingRatio();
          var tw = s.L.bw * ratio, th = s.L.bh * ratio;
          var photo = img;
          if (s.iw > tw * PRESCALE_OVER && s.ih > th * PRESCALE_OVER) {
            var k = Math.min(1, MAX_CANVAS / Math.max(tw, th));
            var c = downscale(img, 0, 0, s.iw, s.ih, tw * k, th * k);
            if (c) photo = c;
          }
          s.photo = photo;

          // A small copy for the blurred backdrop and the focal-point analysis.
          var srcW = photo === img ? s.iw : photo.width, srcH = photo === img ? s.ih : photo.height;
          var sk = Math.min(1, 256 / Math.max(srcW, srcH));
          s.small = downscale(photo, 0, 0, srcW, srcH, srcW * sk, srcH * sk);
          var map = s.small ? analyse(s.small) : null;
          s.m.focal = pickFocal(map, rand);
          s.L = computeLayout(s);
          buildDom(s);
          if (photo !== img) { img.onload = img.onerror = null; s.img = null; }
          s.state = 'ready';
        } catch (err) {
          console.error('[gallery] could not prepare photo', err);
          fail(s);
        }
      }

      // ── layout ──
      function computeLayout(s) {
        var w = W(), h = H(), m = s.m;
        var sa = w / h, ia = s.iw / s.ih, r = ia / sa;
        var L = { w: w, h: h, kind: (r >= COVER_RATIO[0] && r <= COVER_RATIO[1]) ? 'cover' : 'contain' };
        var k;
        if (L.kind === 'cover') {
          var wb = w + 2 * BLEED, hb = h + 2 * BLEED;      // overhang the edges so no sub-pixel sliver shows
          k = Math.max(wb / s.iw, hb / s.ih);
          L.cw = s.iw * k; L.ch = s.ih * k;
          L.zref = m.zmax * 1.03;
          var zf = m.zmax;                                    // the focal point is reached at the deep end
          var zo = m.zoomIn ? 1.0 : 1.015;                    // the wide end
          L.z0 = m.zoomIn ? zo : zf; L.z1 = m.zoomIn ? zf : zo;
          var f = m.focal || [0.5, 0.5];
          var sxf = Math.max(0, 0.5 - wb / (2 * L.cw * zf)), syf = Math.max(0, 0.5 - hb / (2 * L.ch * zf));
          var ufx = sxf > 1e-4 ? clamp((f[0] - 0.5) / sxf, -1, 1) : 0;
          var ufy = syf > 1e-4 ? clamp((f[1] - 0.5) / syf, -1, 1) : 0;
          var uox = clamp(-ufx * 0.35 + m.jx, -1, 1), uoy = clamp(-ufy * 0.35 + m.jy, -1, 1);
          // Keep the pan gentle: limit travel (measured at the deep end, where slack is largest).
          var maxT = MAX_TRAVEL * Math.max(w, h);
          var tx = Math.abs(ufx - uox) * sxf * L.cw * zf, ty = Math.abs(ufy - uoy) * syf * L.ch * zf;
          var tt = Math.sqrt(tx * tx + ty * ty);
          if (tt > maxT) { var q = maxT / tt; uox = ufx + (uox - ufx) * q; uoy = ufy + (uoy - ufy) * q; }
          L.u0x = m.zoomIn ? uox : ufx; L.u1x = m.zoomIn ? ufx : uox;
          L.u0y = m.zoomIn ? uoy : ufy; L.u1y = m.zoomIn ? ufy : uoy;
        } else {
          var bw = w * PRINT_BOX[0], bh = h * PRINT_BOX[1];
          if (sa < 1) { bw = w * 0.88; bh = h * 0.86; }
          k = Math.min(bw / s.iw, bh / s.ih);
          L.cw = s.iw * k; L.ch = s.ih * k;
          L.zref = CONTAIN_ZOOM * 1.01;
          L.z0 = m.zoomIn ? 1 : CONTAIN_ZOOM; L.z1 = m.zoomIn ? CONTAIN_ZOOM : 1;
          L.shadowK = clamp(Math.min(w, h) / 900, 0.2, 1.6);
        }
        L.bw = L.cw * L.zref; L.bh = L.ch * L.zref;
        return L;
      }

      var PHOTO_CSS = 'position:absolute;left:0;top:0;display:block;max-width:none;max-height:none;margin:0;border:0;padding:0;' +
        '-webkit-transform-origin:0 0;transform-origin:0 0;will-change:transform;-webkit-backface-visibility:hidden;backface-visibility:hidden;' +
        '-webkit-user-drag:none;user-select:none;';

      function buildDom(s) {
        var L = s.L;
        if (!s.el) s.el = div('gal-slide', 'position:absolute;inset:0;opacity:0;will-change:opacity;');
        var contain = L.kind === 'contain';
        if (contain) {
          if (!s.backdrop || Math.abs(s.backdropAspect - L.w / L.h) > 0.03) {
            if (s.backdrop) { if (s.backdrop.parentNode) s.backdrop.parentNode.removeChild(s.backdrop); freeCanvas(s.backdrop); }
            s.backdrop = makeBackdrop(s);
            if (s.backdrop) s.el.insertBefore(s.backdrop, s.el.firstChild);
          }
          if (s.backdrop) { s.backdrop.style.width = L.w + 'px'; s.backdrop.style.height = L.h + 'px'; }
          if (!s.shadow) {
            s.shadow = div('gal-shadow', PHOTO_CSS + 'background:#0b0c10;');
            s.el.appendChild(s.shadow);
          }
          var sk = L.shadowK;
          s.shadow.style.width = L.bw + 'px';
          s.shadow.style.height = L.bh + 'px';
          s.shadow.style.boxShadow = '0 ' + (26 * sk).toFixed(1) + 'px ' + (80 * sk).toFixed(1) + 'px rgba(0,0,0,0.55), ' +
            '0 ' + (6 * sk).toFixed(1) + 'px ' + (18 * sk).toFixed(1) + 'px rgba(0,0,0,0.32)';
        } else {
          if (s.backdrop) { if (s.backdrop.parentNode) s.backdrop.parentNode.removeChild(s.backdrop); freeCanvas(s.backdrop); s.backdrop = null; }
          if (s.shadow) { if (s.shadow.parentNode) s.shadow.parentNode.removeChild(s.shadow); s.shadow = null; }
        }
        var p = s.photo;
        if (p.parentNode !== s.el) { p.style.cssText = PHOTO_CSS; p.setAttribute('alt', ''); p.draggable = false; s.el.appendChild(p); }
        else s.el.appendChild(p);   // keep it on top
        p.style.width = L.bw + 'px';
        p.style.height = L.bh + 'px';
        s.lastTf = s.lastBf = '';
      }

      /** Heavily blurred, darkened, enlarged copy of the photo, at a tiny size the compositor scales up. */
      function makeBackdrop(s) {
        if (!s.small) return null;
        var w = W(), h = H(), sa = w / h;
        // The whole photo, stretched to the screen (after this much blur the distortion is invisible,
        // and the glow beside the print matches the print's own colours at each height).
        var sw = s.small.width, sh = s.small.height;
        var cw = sw / 1.08, ch = sh / 1.08, cx = (sw - cw) / 2, cy = (sh - ch) / 2;
        var long = 20, tw = sa >= 1 ? long : Math.max(2, Math.round(long * sa)), th = sa >= 1 ? Math.max(2, Math.round(long / sa)) : long;
        var c = downscale(s.small, cx, cy, cw, ch, tw, th);
        if (!c) return null;
        softBlur(c, 2);
        c = upscale(c, tw * 2, th * 2); softBlur(c, 2);
        c = upscale(c, tw * 4, th * 4); softBlur(c, 1);
        c = upscale(c, tw * 8, th * 8); softBlur(c, 1);
        var g = ctx2d(c);
        if (g) {
          g.globalAlpha = 1;
          try { g.globalCompositeOperation = 'saturation'; g.fillStyle = 'rgba(128,128,128,0.08)'; g.fillRect(0, 0, c.width, c.height); } catch (e) { /* ignore */ }
          g.globalCompositeOperation = 'source-over';
          g.fillStyle = 'rgba(6,7,11,0.47)';
          g.fillRect(0, 0, c.width, c.height);
        }
        c.className = 'gal-backdrop';
        c.style.cssText = 'position:absolute;left:0;top:0;display:block;-webkit-transform-origin:50% 50%;transform-origin:50% 50%;' +
          'will-change:transform;-webkit-backface-visibility:hidden;backface-visibility:hidden;';
        s.backdropAspect = sa;
        return c;
      }

      function relayout() {
        var all = outgoing.concat(current ? [current] : [], next && next.state === 'ready' ? [next] : []);
        for (var i = 0; i < all.length; i++) {
          var s = all[i];
          if (!s.photo) continue;
          s.L = computeLayout(s);
          buildDom(s);
        }
      }

      // ── per-frame placement ──
      function place(s, t) {
        var L = s.L, m = s.m;
        if (L.w !== W() || L.h !== H()) { s.L = L = computeLayout(s); buildDom(s); }
        var p = clamp((t - s.startT) / LIFE, 0, MAX_PROGRESS);
        var w = L.w, h = L.h, tf;
        if (L.kind === 'cover') {
          var z = clamp(L.z0 * Math.pow(L.z1 / L.z0, p), 1, L.zref);
          var dw = L.cw * z, dh = L.ch * z;
          var sx = Math.max(0, 0.5 - (w + 2 * BLEED) / (2 * dw)), sy = Math.max(0, 0.5 - (h + 2 * BLEED) / (2 * dh));
          var ux = clamp(lerp(L.u0x, L.u1x, p), -1, 1), uy = clamp(lerp(L.u0y, L.u1y, p), -1, 1);
          var cx = 0.5 + ux * sx, cy = 0.5 + uy * sy;
          var x = w / 2 - cx * dw, y = h / 2 - cy * dh;
          tf = 'translate3d(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px,0) scale(' + (z / L.zref).toFixed(5) + ')';
          if (tf !== s.lastTf) { s.photo.style.transform = tf; s.lastTf = tf; }
        } else {
          var zc = lerp(L.z0, L.z1, p);
          var cw = L.cw * zc, ch = L.ch * zc;
          var dx = lerp(-1, 1, p) * m.cdx * w, dy = lerp(-1, 1, p) * m.cdy * h;
          var px = (w - cw) / 2 + dx, py = (h - ch) / 2 + dy;
          tf = 'translate3d(' + px.toFixed(2) + 'px,' + py.toFixed(2) + 'px,0) scale(' + (zc / L.zref).toFixed(5) + ')';
          if (tf !== s.lastTf) { s.photo.style.transform = tf; if (s.shadow) s.shadow.style.transform = tf; s.lastTf = tf; }
          if (s.backdrop) {
            var bz = m.bz0 + 0.07 * p;
            var bf = 'translate3d(' + (-dx * 2.5).toFixed(2) + 'px,' + (-dy * 2.5).toFixed(2) + 'px,0) scale(' + bz.toFixed(5) + ')';
            if (bf !== s.lastBf) { s.backdrop.style.transform = bf; s.lastBf = bf; }
          }
        }
      }

      function setOpacity(el, v, key, holder) {
        var str = v >= 0.999 ? '1' : v.toFixed(3);
        if (holder[key] !== str) { el.style.opacity = str; holder[key] = str; }
      }

      function promote(s, t, frozen) {
        var first = !current;
        s.startT = t;
        if (first && !firstShown) s.startT = t - ((displayIndex * 9) % 18);   // displays change at different moments
        s.fadeStart = t;
        s.fadeDur = first ? INTRO : XFADE;
        if (frozen) s.fadeStart = t - s.fadeDur;                              // stills: show it at once
        if (!s.attached) { s.op = ''; slidesEl.appendChild(s.el); s.attached = true; }
        place(s, t);
        setOpacity(s.el, 0, 'op', s);
        if (current) outgoing.push(current);
        current = s;
        next = null;
        forceNext = false;
        firstShown = true;
      }

      // ── empty state ──
      var blobPhase = U.mulberry32(mixSeed(seed, 4242))() * 400;
      function sizeEmptyCanvas() {
        var w = W(), h = H(), long = 160;
        var cw = w >= h ? long : Math.max(4, Math.round(long * w / h));
        var ch = w >= h ? Math.max(4, Math.round(long * h / w)) : long;
        if (emptyCanvas.width !== cw || emptyCanvas.height !== ch) { emptyCanvas.width = cw; emptyCanvas.height = ch; lastEmptyDraw = -1; }
      }
      // Computed per pixel (float maths, plain rounding) rather than with canvas gradients: canvas
      // gradients are dithered per texel, and the compositor's ~9× upscale turns that into a grid.
      var emptyImg = null, skyRows = null;
      var SKY_RGB = SKY.map(U.hexToRgb);
      function drawEmpty(t) {
        if (!emptyCtx) return;
        var cw = emptyCanvas.width, ch = emptyCanvas.height, R = Math.max(cw, ch), x, y, i;
        if (!emptyImg || emptyImg.width !== cw || emptyImg.height !== ch) {
          emptyImg = emptyCtx.createImageData(cw, ch);
          skyRows = new Float32Array(ch * 3);
          for (y = 0; y < ch; y++) {
            var v = ch > 1 ? y / (ch - 1) : 0, a = v < 0.55 ? SKY_RGB[0] : SKY_RGB[1], b = v < 0.55 ? SKY_RGB[1] : SKY_RGB[2];
            var f = v < 0.55 ? v / 0.55 : (v - 0.55) / 0.45;
            f = f * f * (3 - 2 * f);
            for (i = 0; i < 3; i++) skyRows[y * 3 + i] = (a[i] + (b[i] - a[i]) * f) * 255;
          }
        }
        var tt = t + blobPhase, nb = BLOBS.length;
        var bx = new Float32Array(nb), by = new Float32Array(nb), bk = new Float32Array(nb);
        for (i = 0; i < nb; i++) {
          var bl = BLOBS[i];
          bx[i] = (bl.x + bl.ax * Math.sin(tt * bl.fx * Math.PI * 2 + i * 1.7)) * cw;
          by[i] = (bl.y + bl.ay * Math.cos(tt * bl.fy * Math.PI * 2 + i * 2.3)) * ch;
          var r = bl.r * R * (1 + 0.06 * Math.sin(tt * 0.013 + i));
          bk[i] = 1 / (r * r);
        }
        var d = emptyImg.data, o = 0;
        for (y = 0; y < ch; y++) {
          var sr = skyRows[y * 3], sg = skyRows[y * 3 + 1], sb = skyRows[y * 3 + 2], py = y + 0.5;
          for (x = 0; x < cw; x++) {
            var cr = sr, cg = sg, cb = sb, px = x + 0.5;
            for (i = 0; i < nb; i++) {
              var dx = px - bx[i], dy = py - by[i], u2 = (dx * dx + dy * dy) * bk[i];
              if (u2 < 1) {
                var w = (1 - u2) * (1 - u2) * BLOBS[i].a, c = BLOBS[i].c;
                cr += c[0] * w; cg += c[1] * w; cb += c[2] * w;
              }
            }
            d[o] = cr; d[o + 1] = cg; d[o + 2] = cb; d[o + 3] = 255;   // Uint8ClampedArray rounds and clamps
            o += 4;
          }
        }
        emptyCtx.putImageData(emptyImg, 0, 0);
      }
      function styleMessage() {
        var w = W(), h = H();
        var tiny = w < 520 || h < 280;
        var key = (tiny ? 't' : 'f') + (w < 140 || h < 90 ? 'x' : '') + Math.round(w / 40);
        if (key === lastMsgKey) return;
        lastMsgKey = key;
        text.style.display = tiny ? 'none' : '';
        icon.style.display = (w < 140 || h < 90) ? 'none' : '';
        var fs = clamp(w / 88, 14, 19);
        text.style.fontSize = fs.toFixed(1) + 'px';
        var svg = icon.firstChild;
        var iw = tiny ? clamp(w / 9, 22, 34) : clamp(w / 34, 36, 50);
        if (svg) { svg.setAttribute('width', iw.toFixed(1)); svg.setAttribute('height', (iw * 34 / 44).toFixed(1)); }
        icon.style.marginBottom = tiny ? '0' : (fs * 1.05).toFixed(1) + 'px';
      }

      sizeEmptyCanvas();
      styleMessage();
      checkOptions();
      if (list.length) next = loadNext();

      // ── frame ──
      return {
        resize: function () {
          styleFinish();
          sizeEmptyCanvas();
          styleMessage();
          relayout();
        },

        render: function (t, dt) {
          if (dead) return;
          dt = dt > 0 ? dt : 0;
          var frozen = t === lastT;
          lastT = t;
          clock += dt;

          checkOptions();
          var n = list.length, good = goodCount();
          var noImages = n === 0 || good === 0;

          // Loading / promotion.
          if (!noImages) {
            if (next && next.state === 'loading' && nowMs() - next.started > LOAD_TIMEOUT_MS) fail(next);
            // Prepare the next photo mid-way through the current one, never during a crossfade
            // (decoding / downscaling a big photo can cost a frame or two).
            if (!next && (!current || forceNext || t >= current.fadeStart + current.fadeDur + PRELOAD_AFTER)) next = loadNext();
            if (next && next.state === 'ready') {
              if (!current) promote(next, t, frozen);
              else if (forceNext || t >= current.startT + PERIOD) promote(next, t, false);
              else if (!next.attached && t >= current.startT + PERIOD - ATTACH_LEAD) {
                // Put it in the tree (invisibly) a moment early so its texture is uploaded before it shows.
                next.startT = current.startT + PERIOD;
                slidesEl.appendChild(next.el);
                next.attached = true;
                place(next, t);
                setOpacity(next.el, 0.002, 'op', next);
              }
            }
          }

          // Slides: fade the whole set out when the folder is cleared or nothing loads.
          var slidesTarget = noImages ? 0 : 1;
          if (!current && !outgoing.length) slidesAmt = 1;
          else slidesAmt = approach(slidesAmt, slidesTarget, 1 / 2.5, dt);
          if (slidesTarget === 0 && slidesAmt <= 0) {
            for (var o = 0; o < outgoing.length; o++) release(outgoing[o]);
            outgoing = [];
            if (current) { release(current); current = null; }
            slidesAmt = 1;
          }
          setOpacity(slidesEl, ease(slidesAmt), 'op', slidesEl);

          if (current) {
            var k = current.fadeDur > 0 ? clamp((t - current.fadeStart) / current.fadeDur, 0, 1) : 1;
            setOpacity(current.el, ease(k), 'op', current);
            place(current, t);
            if (k >= 1 && outgoing.length) {
              for (var j = 0; j < outgoing.length; j++) release(outgoing[j]);
              outgoing = [];
            }
            for (j = 0; j < outgoing.length; j++) place(outgoing[j], t);
            if (k >= 1 && slidesAmt >= 1) { emptyTarget = 0; emptyAmt = 0; }
          }

          // Empty state.
          if (noImages) {
            if (n > 0 || clock - noImagesSince >= EMPTY_GRACE) emptyTarget = 1;
            var wantText = n > 0 ? FAIL_TEXT : EMPTY_TEXT;
            if (text.textContent !== wantText) text.textContent = wantText;
          } else if (!current && emptyAmt > 0) {
            emptyTarget = 1;   // keep showing until the first photo has fully faded in over it
          }
          emptyAmt = approach(emptyAmt, emptyTarget, 1 / 1.8, dt);
          if (emptyAmt > 0) {
            if (!emptyShown) { empty.style.visibility = 'visible'; emptyShown = true; }
            setOpacity(empty, ease(emptyAmt), 'op', empty);
            var interval = env.quality === 'saver' ? 1 / 12 : 1 / 20;   // drifts far below a texel per redraw
            if (lastEmptyDraw < 0 || (t !== lastEmptyT && clock - lastEmptyDraw >= interval)) { drawEmpty(t); lastEmptyDraw = clock; lastEmptyT = t; }
          } else if (emptyShown) {
            empty.style.visibility = 'hidden';
            setOpacity(empty, 0, 'op', empty);
            emptyShown = false;
          }
        },

        destroy: function () {
          dead = true;
          release(next);
          release(current);
          for (var i = 0; i < outgoing.length; i++) release(outgoing[i]);
          next = current = null;
          outgoing = [];
          freeCanvas(emptyCanvas);
          emptyCtx = null;
          if (root.parentNode) root.parentNode.removeChild(root);
        }
      };
    }
  });
})(window);
