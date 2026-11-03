/*
 * Analog Brick — setup window logic (setup.html).
 * Plain script. Talks to native only through window.Brick (see docs/BRIDGE.md):
 *   events in:  init, status, settings, stats, gallery, error
 *   commands:   settings.save, session.start, status.refresh, focus.openShortcuts, focus.test,
 *               spotify.requestPermission, spotify.launch, audio.requestPermission,
 *               loginItem.openSettings, gallery.choose, gallery.clear, openURL
 * The PIN is never stored, saved, or logged: it lives only in the two inputs and is sent once
 * with session.start, then cleared when the window hides.
 */
(function () {
  'use strict';

  var U = window.BrickUtil;
  var el = U.el;
  var BV = window.BrickVisuals || null;
  function $(id) { return document.getElementById(id); }

  // ───────────────────────────── constants ─────────────────────────────
  var PRESETS = [25, 45, 60, 90, 120];
  var DUR_MIN = 5, DUR_MAX = 480, DUR_STEP = 5;
  var PIN_MIN = 4, PIN_MAX = 8;
  var SAVE_DEBOUNCE_MS = 300;
  var MAX_PLAYLISTS = 12;

  var DEFAULTS = {
    durationMin: 50, mode: 'aurora', quality: 'balanced', intention: '',
    keepAwake: true, showTimerOnSecondary: true, resumeAfterRestart: true, focusEnabled: true,
    launchSpotify: true, autoplayUri: '', quickPlaylists: [], confirmDelaySec: 3, peekSeconds: 90,
    breathPattern: 'box'
  };

  // Used only if a mode file is missing its copy, or no mode registered at all.
  var KNOWN_MODES = [
    { id: 'aurora', name: 'Aurora', tagline: 'Northern lights over a quiet, starry lake' },
    { id: 'drift', name: 'Drift', tagline: 'Silk threads drifting on a slow current' },
    { id: 'breath', name: 'Breath', tagline: 'A glowing orb that breathes with you' },
    { id: 'horizon', name: 'Horizon', tagline: 'Mountains and a lake through a slow dusk' },
    { id: 'night', name: 'Night', tagline: 'A slowly turning sky, the odd shooting star' },
    { id: 'pulse', name: 'Pulse', tagline: 'Moves with your Spotify music' },
    { id: 'gallery', name: 'Gallery', tagline: 'Your own photos, drifting slowly' }
  ];

  // Placeholder art for mode tiles until the real still is rendered.
  var SWATCH = {
    aurora: 'radial-gradient(120% 90% at 50% 18%, #2c8a72 0%, #17394a 42%, #070b14 78%)',
    drift: 'radial-gradient(120% 100% at 30% 70%, #5a4128 0%, #241a14 45%, #0b0a0f 80%)',
    breath: 'radial-gradient(60% 60% at 50% 52%, #8cc2cf 0%, #2b4b66 38%, #0a0f1a 75%)',
    horizon: 'linear-gradient(180deg, #232846 0%, #8d5a5a 52%, #19151f 53%, #0c0b12 100%)',
    night: 'radial-gradient(120% 90% at 30% 15%, #1d2747 0%, #0a0d19 55%, #05060c 85%)',
    pulse: 'radial-gradient(70% 70% at 50% 62%, #a8517a 0%, #3a1f4a 42%, #0b0912 78%)',
    gallery: 'linear-gradient(140deg, #34322e 0%, #1c1b1d 60%, #121216 100%)'
  };
  var SWATCH_DEFAULT = 'linear-gradient(140deg, #1b1f2c, #0b0c12)';

  var ICON = {
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7"/></svg>',
    checkCircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.8 2.8L16.2 9.6"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.3v.2"/></svg>',
    todo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-dasharray="3 2.6"/><path d="M12 8v4.5l2.8 1.7"/></svg>',
    chevron: '<svg class="chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5l3-3 3 3"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="9.5" rx="2.2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>',
    display: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20h6M12 16.5V20"/></svg>'
  };
  function icon(name) {
    var t = document.createElement('span');
    t.innerHTML = ICON[name] || '';
    return t.firstChild;
  }

  // ───────────────────────────── state ─────────────────────────────
  var S = {
    settings: Object.assign({}, DEFAULTS),
    status: null,
    stats: null,
    gallery: { folder: null, count: 0, images: [] },
    version: '',
    inited: false,
    busy: false,
    startPending: false,
    startSent: false,
    pinTouched: false,
    confirmTouched: false,
    pinVisible: false,
    flash: null
  };

  var stage = null;
  var modes = [];
  var thumbs = {};

  // ───────────────────────────── saving ─────────────────────────────
  var pendingSave = {};
  var saveTimer = null;

  function queueSave(patch) {
    Object.assign(pendingSave, patch);
    Object.assign(S.settings, patch);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }
  function flushSave() {
    clearTimeout(saveTimer);
    var keys = Object.keys(pendingSave);
    if (!keys.length) return;
    var patch = pendingSave;
    pendingSave = {};
    Brick.send('settings.save', patch);
  }
  window.addEventListener('pagehide', flushSave);

  // ───────────────────────────── small helpers ─────────────────────────────
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  function folderName(path) {
    if (!path) return '';
    var parts = String(path).split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(path);
  }
  function isFocused(node) { return node && document.activeElement === node; }
  function within(container, node) { return !!(container && node && container.contains(node)); }
  function startOfDay(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function dayDiff(a, b) { return Math.round((startOfDay(b) - startOfDay(a)) / 86400000); }
  function restartAnim(node, cls) { node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls); }

  /** Spotify link or URI → canonical "spotify:<type>:<id>", or null. Mirrors BrickCore.SpotifyURI. */
  function normalizeSpotify(raw) {
    var TYPES = ['playlist', 'album', 'track', 'artist', 'show', 'episode'];
    function isID(x) { return /^[A-Za-z0-9]{1,64}$/.test(x); }
    var s = String(raw || '').trim();
    if (!s) return null;
    if (/^spotify:/i.test(s)) {
      var p = s.split(':');
      if (p.length === 3 && TYPES.indexOf(p[1]) >= 0 && isID(p[2])) return 'spotify:' + p[1] + ':' + p[2];
      if (p.length === 5 && p[1] === 'user' && p[3] === 'playlist' && isID(p[4])) return 'spotify:playlist:' + p[4];
      return null;
    }
    if (/^(open|play)\.spotify\.com\//i.test(s)) s = 'https://' + s;
    var url;
    try { url = new URL(s); } catch (e) { return null; }
    var host = url.hostname.toLowerCase();
    if (host !== 'open.spotify.com' && host !== 'play.spotify.com') return null;
    var comps = url.pathname.split('/').filter(Boolean);
    if (comps.length && comps[0].indexOf('intl-') === 0) comps.shift();
    if (comps.length >= 4 && comps[0] === 'user' && comps[2] === 'playlist') comps = comps.slice(2);
    if (comps.length >= 2 && TYPES.indexOf(comps[0]) >= 0 && isID(comps[1])) return 'spotify:' + comps[0] + ':' + comps[1];
    return null;
  }

  function copyText(text, btn) {
    function done(ok) {
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(function () { btn.textContent = old; }, 1400);
    }
    function legacy() {
      var ta = el('textarea', { style: { position: 'fixed', left: '-9999px', top: '0' } });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      done(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, legacy);
    } else {
      legacy();
    }
  }

  // ───────────────────────────── modes ─────────────────────────────
  function knownMode(id) {
    for (var i = 0; i < KNOWN_MODES.length; i++) if (KNOWN_MODES[i].id === id) return KNOWN_MODES[i];
    return null;
  }

  function loadModes() {
    var list = BV ? BV.list() : [];
    modes = list.map(function (m) {
      var k = knownMode(m.id);
      return {
        id: m.id,
        name: m.name || (k && k.name) || m.id,
        tagline: m.tagline || (k && k.tagline) || '',
        music: !!m.musicReactive || m.id === 'pulse',
        context: m.context
      };
    });
    if (!modes.length) {
      modes = KNOWN_MODES.map(function (k) { return { id: k.id, name: k.name, tagline: k.tagline, music: k.id === 'pulse', context: 'none' }; });
    }
  }

  function modeById(id) {
    for (var i = 0; i < modes.length; i++) if (modes[i].id === id) return modes[i];
    return null;
  }
  function currentMode() { return modeById(S.settings.mode) || modes[0] || null; }

  function buildModes() {
    var box = $('modes');
    box.textContent = '';
    box.style.setProperty('--n', String(modes.length));
    modes.forEach(function (m) {
      var thumb = el('span', { class: 'mode-thumb' });
      thumb.style.setProperty('--swatch', SWATCH[m.id] || SWATCH_DEFAULT);
      if (m.music) thumb.appendChild(el('span', { class: 'mode-badge', title: 'Moves with your music' }, icon('note')));
      var btn = el('button', {
        type: 'button', class: 'mode', role: 'radio', 'aria-checked': 'false', tabindex: '-1',
        title: m.tagline + (m.music ? ' (moves with your music)' : ''),
        'data-id': m.id
      }, thumb, el('span', { class: 'mode-name', text: m.name }));
      btn.addEventListener('click', function () { selectMode(m.id); });
      btn.addEventListener('mouseenter', function () { peekCaption(m); });
      btn.addEventListener('mouseleave', function () { peekCaption(null); });
      btn.addEventListener('keydown', onModeKey);
      box.appendChild(btn);
    });
    renderModeTiles();
    renderGalleryTile();
    Object.keys(thumbs).forEach(function (id) { setThumb(id, thumbs[id]); });
  }

  function renderModeTiles() {
    var cur = currentMode();
    Array.prototype.forEach.call(document.querySelectorAll('.mode'), function (b) {
      var on = !!cur && b.getAttribute('data-id') === cur.id;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
  }

  function onModeKey(e) {
    var keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    var cur = modes.indexOf(currentMode());
    var next = -1;
    if (keys[e.key]) next = (cur + keys[e.key] + modes.length) % modes.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = modes.length - 1;
    if (next < 0) return;
    e.preventDefault();
    selectMode(modes[next].id);
    var b = document.querySelector('.mode[data-id="' + modes[next].id + '"]');
    if (b) b.focus();
  }

  function selectMode(id, opts) {
    if (!modeById(id)) return;
    var changed = S.settings.mode !== id;
    S.settings.mode = id;
    renderModeTiles();
    swapCaption(modeById(id));
    renderSummary();
    if (stage && stage.mode !== id) {
      stage.setMode(id, { transition: 1000 });
    }
    if (stage) stage.setPlaying(id === 'pulse');
    if (changed && !(opts && opts.silent)) queueSave({ mode: id });
  }

  function setThumb(id, url) {
    thumbs[id] = url;
    var t = document.querySelector('.mode[data-id="' + id + '"] .mode-thumb');
    if (!t) return;
    var img = t.querySelector('img');
    if (!img) {
      img = el('img', { alt: '', draggable: 'false' });
      t.insertBefore(img, t.firstChild);
    }
    img.classList.remove('is-loaded');
    img.onload = function () { img.classList.add('is-loaded'); };
    img.src = url;
  }

  function renderGalleryTile() {
    var t = document.querySelector('.mode[data-id="gallery"] .mode-thumb');
    if (!t) return;
    var first = S.gallery && S.gallery.images && S.gallery.images[0];
    var glyph = t.querySelector('.glyph');
    if (first) {
      if (glyph) glyph.remove();
      if (thumbs.gallery !== first) setThumb('gallery', first);
    } else {
      delete thumbs.gallery;
      var img = t.querySelector('img');
      if (img) img.remove();
      if (!glyph) t.appendChild(el('span', { class: 'glyph' }, icon('folder')));
    }
  }

  /** Render a still of every mode once, one at a time, with a hidden frozen stage. */
  function makeThumbs() {
    if (!BV) return;
    var ids = modes.filter(function (m) {
      return m.id !== 'gallery' && BV.has(m.id) && m.context !== 'none';
    }).map(function (m) { return m.id; });
    if (!ids.length) return;
    var host = el('div', {
      'aria-hidden': 'true',
      style: { position: 'fixed', left: '-10000px', top: '0', width: '224px', height: '140px', pointerEvents: 'none', visibility: 'hidden' }
    });
    document.body.appendChild(host);
    var tstage;
    try {
      tstage = BV.mount(host, { quality: 'high', freeze: 42, seed: 1, displayIndex: 0, options: stageOptions() });
      tstage.pause();
    } catch (e) {
      host.remove();
      return;
    }
    var i = 0;
    function next() {
      if (i >= ids.length) { tstage.destroy(); host.remove(); return; }
      var id = ids[i++];
      try {
        if (id === 'pulse') primeAudio(tstage);
        tstage.setMode(id, { transition: 0 });
        var layer = host.querySelector('.bv-mode-' + id);
        var canvas = layer && layer.querySelector('canvas');
        if (canvas && canvas.width > 1) setThumb(id, captureThumb(canvas));
      } catch (err) {
        console.warn('[setup] could not render a still of "' + id + '"', err);
      }
      setTimeout(next, 140);
    }
    setTimeout(next, 1200);
  }

  /**
   * Copy a just-rendered canvas into a JPEG data URL. Very dark stills (fine threads, night skies)
   * vanish at tile size, so lift their exposure a little (a gain on linear-ish values, capped).
   * Must run in the same task as the render: WebGL buffers are not preserved.
   */
  function captureThumb(src) {
    var w = src.width, h = src.height;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d');
    g.drawImage(src, 0, 0);
    try {
      var img = g.getImageData(0, 0, w, h), d = img.data, sum = 0, n = 0;
      for (var i = 0; i < d.length; i += 16) { sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; n++; }
      var mean = sum / Math.max(1, n) / 255;
      var gain = Math.min(1.9, Math.max(1, 0.15 / Math.max(0.01, mean)));
      if (gain > 1.05) {
        for (var k = 0; k < d.length; k += 4) {
          d[k] = Math.min(255, d[k] * gain);
          d[k + 1] = Math.min(255, d[k + 1] * gain);
          d[k + 2] = Math.min(255, d[k + 2] * gain);
        }
        g.putImageData(img, 0, 0);
      }
    } catch (e) { /* tainted or unsupported: keep the plain copy */ }
    return c.toDataURL('image/jpeg', 0.88);
  }

  /** Give a frozen thumbnail stage a plausible moment of music (Pulse reads env.audio). */
  function primeAudio(st) {
    var a = st.audio;
    if (!a) return;
    a.playing = true; a.synthetic = true;
    a.level = 0.55; a.bass = 0.72; a.mid = 0.45; a.treble = 0.3; a.energy = 0.5; a.beat = 0.6;
    for (var i = 0; i < a.bands.length; i++) {
      a.bands[i] = Math.max(0, Math.min(1, 0.2 + 0.55 * Math.exp(-i / 9) + 0.12 * Math.sin(i * 0.9)));
    }
  }

  // ───────────────────────────── preview ─────────────────────────────
  function stageOptions() {
    return {
      breathPattern: S.settings.breathPattern || 'box',
      images: (S.gallery && S.gallery.images) ? S.gallery.images.slice() : []
    };
  }

  function mountStage() {
    if (stage || !BV) return;
    var cur = currentMode();
    try {
      stage = BV.mount($('previewStage'), {
        mode: cur ? cur.id : 'aurora', quality: 'saver', seed: 1, displayIndex: 0,
        options: stageOptions(), transition: 0
      });
      stage.setPlaying(!!cur && cur.id === 'pulse');
      window.__stage = stage;
    } catch (e) {
      console.error('[setup] preview failed', e);
      return;
    }
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { $('previewStage').classList.add('is-live'); });
    });
  }

  var captionTimer = null;
  var captionShown = null;
  function fillCaption(m, peek) {
    captionShown = m ? m.id + (peek ? ':peek' : '') : null;
    $('pcName').textContent = m ? m.name : '';
    $('pcTag').textContent = m ? m.tagline : '';
    var extra = $('pcExtra');
    extra.textContent = '';
    if (!m) return;
    if (m.music) extra.appendChild(el('span', { class: 'pill pill-lamp' }, icon('note'), 'Moves with your music'));
    if (m.id === 'gallery') {
      var g = S.gallery || {};
      if (g.folder) {
        extra.appendChild(el('span', { class: 'pill' }, icon('folder'), folderName(g.folder) + ' · ' + plural(g.count || 0, 'photo')));
      } else if (peek) {
        extra.appendChild(el('span', { class: 'pill' }, icon('folder'), 'No folder chosen yet'));
      } else {
        extra.appendChild(el('button', { type: 'button', class: 'pill pill-lamp', onclick: chooseGallery }, icon('folder'), 'Choose a photo folder…'));
      }
    }
  }
  function swapCaption(m, peek) {
    var key = m ? m.id + (peek ? ':peek' : '') : null;
    if (key === captionShown) return;
    var cap = $('previewCaption');
    clearTimeout(captionTimer);
    cap.classList.add('is-swapping');
    captionTimer = setTimeout(function () {
      fillCaption(m, peek);
      cap.classList.remove('is-swapping');
    }, 160);
  }
  function peekCaption(m) {
    var cur = currentMode();
    if (!m || (cur && m.id === cur.id)) swapCaption(cur, false);
    else swapCaption(m, true);
  }

  function intentionValue() { return $('intention').value.trim(); }

  function renderLockMock() {
    var ms = S.settings.durationMin * 60000;
    $('plTime').textContent = U.formatCountdown(ms);
    $('plIntent').textContent = intentionValue();
    $('plEnds').textContent = 'ends ' + U.formatClock(Date.now() + ms);
  }

  // ───────────────────────────── duration ─────────────────────────────
  function buildPresets() {
    var box = $('presets');
    box.textContent = '';
    PRESETS.forEach(function (min) {
      var b = el('button', {
        type: 'button', class: 'seg', 'aria-pressed': 'false', 'data-min': String(min),
        'aria-label': U.formatMinutesLong(min), text: String(min)
      });
      b.addEventListener('click', function () { setDuration(min); });
      box.appendChild(b);
    });
  }

  function setDuration(min, opts) {
    min = +min;
    if (!isFinite(min)) min = DEFAULTS.durationMin;
    min = Math.round(U.clamp(min, DUR_MIN, DUR_MAX));
    var changed = min !== S.settings.durationMin;
    S.settings.durationMin = min;
    renderDuration();
    if (changed && !(opts && opts.silent)) {
      queueSave({ durationMin: min });
      clearError();
    }
  }

  function sizeDurInput() {
    var input = $('durInput');
    input.style.width = (Math.max(2, input.value.length || 1) + 0.25) + 'ch';
  }

  function renderDuration() {
    var d = S.settings.durationMin;
    var input = $('durInput');
    if (!isFocused(input)) input.value = String(d);
    sizeDurInput();
    input.setAttribute('aria-valuenow', String(d));
    input.setAttribute('aria-valuetext', U.formatMinutesLong(d));
    $('durMinus').disabled = d <= DUR_MIN;
    $('durPlus').disabled = d >= DUR_MAX;
    Array.prototype.forEach.call(document.querySelectorAll('.seg'), function (b) {
      b.setAttribute('aria-pressed', +b.getAttribute('data-min') === d ? 'true' : 'false');
    });
    renderEnds();
    renderLockMock();
  }

  function stepDuration(dir) {
    var d = S.settings.durationMin;
    var base = dir > 0 ? Math.floor(d / DUR_STEP) * DUR_STEP : Math.ceil(d / DUR_STEP) * DUR_STEP;
    setDuration(base + dir * DUR_STEP);
  }

  function commitDurInput() {
    var input = $('durInput');
    var v = parseInt(input.value, 10);
    if (isNaN(v)) { input.value = String(S.settings.durationMin); sizeDurInput(); return; }
    setDuration(v);
    input.value = String(S.settings.durationMin);
    sizeDurInput();
  }

  function renderEnds() {
    var end = new Date(Date.now() + S.settings.durationMin * 60000);
    var days = dayDiff(new Date(), end);
    var t = U.formatClock(end);
    var txt;
    if (days <= 0) txt = 'Ends at ' + t;
    else if (days === 1) txt = 'Ends tomorrow at ' + t;
    else txt = 'Ends ' + end.toLocaleDateString(undefined, { weekday: 'long' }) + ' at ' + t;
    if (S.settings.durationMin >= 90) txt = U.formatMinutesLong(S.settings.durationMin) + ' · ' + txt;
    $('endsAt').textContent = txt;
    $('plEnds').textContent = 'ends ' + t;
  }

  // ───────────────────────────── PIN ─────────────────────────────
  function pinState() {
    var a = $('pin1').value, b = $('pin2').value;
    var tip = 'Tip: let someone else type it.';
    if (S.flash && Date.now() < S.flash.until) return { ok: false, kind: 'error', msg: S.flash.msg, field: S.flash.field, label: a.length >= PIN_MIN ? 'Confirm your PIN' : 'Set a PIN to begin' };
    if (!a && !b) return { ok: false, kind: 'tip', msg: tip, label: 'Set a PIN to begin' };
    if (a.length < PIN_MIN) {
      var showErr = (S.pinTouched && !isFocused($('pin1'))) || b.length > 0;
      return { ok: false, kind: showErr ? 'error' : 'tip', msg: showErr ? 'Use 4 to 8 digits.' : '4 to 8 digits. ' + tip, field: 1, label: 'Set a PIN to begin' };
    }
    if (!b) return { ok: false, kind: 'tip', msg: 'Now type it once more to confirm.', label: 'Confirm your PIN' };
    if (a === b) return { ok: true, kind: 'ok', msg: 'PINs match. Stopping early takes it three times.', label: 'Begin session' };
    var mismatch = b.length >= a.length || a.indexOf(b) !== 0 || (S.confirmTouched && !isFocused($('pin2')));
    if (mismatch) return { ok: false, kind: 'error', msg: 'The PINs don’t match.', field: 2, label: 'Confirm your PIN' };
    return { ok: false, kind: 'tip', msg: 'Now type it once more to confirm.', label: 'Confirm your PIN' };
  }

  function renderPin() {
    var st = pinState();
    var help = $('pinHelp');
    help.textContent = '';
    help.className = 'pin-help' + (st.kind === 'error' ? ' is-error' : st.kind === 'ok' ? ' is-ok' : '');
    if (st.kind === 'error') help.appendChild(icon('alert'));
    if (st.kind === 'ok') help.appendChild(icon('checkCircle'));
    help.appendChild(document.createTextNode(st.msg));

    var p1 = $('pin1'), p2 = $('pin2');
    var bad1 = st.kind === 'error' && st.field === 1, bad2 = st.kind === 'error' && st.field === 2;
    p1.classList.toggle('is-invalid', bad1);
    p2.classList.toggle('is-invalid', bad2);
    p1.classList.toggle('is-ok', st.ok);
    p2.classList.toggle('is-ok', st.ok);
    p1.setAttribute('aria-invalid', bad1 ? 'true' : 'false');
    p2.setAttribute('aria-invalid', bad2 ? 'true' : 'false');

    var btn = $('beginBtn');
    btn.disabled = !st.ok;
    btn.classList.toggle('is-busy', S.busy);
    btn.setAttribute('aria-busy', S.busy ? 'true' : 'false');
    $('beginLabel').textContent = S.busy ? 'Starting…' : st.label;
  }

  function onPinInput(e) {
    var input = e.target;
    var v = input.value;
    var clean = v.replace(/\D+/g, '').slice(0, PIN_MAX);
    if (clean !== v) {
      var pos = input.selectionStart;
      input.value = clean;
      try { input.setSelectionRange(Math.min(pos, clean.length), Math.min(pos, clean.length)); } catch (err) { /* type=password in some engines */ }
      if (/\D/.test(v)) {
        S.flash = { msg: 'Digits only.', field: input.id === 'pin1' ? 1 : 2, until: Date.now() + 1600 };
        setTimeout(renderPin, 1650);
      }
    }
    if (input.id === 'pin1') S.pinTouched = S.pinTouched || clean.length >= PIN_MIN;
    clearError();
    renderPin();
  }

  function setReveal(on) {
    S.pinVisible = !!on;
    var btn = $('pinReveal');
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('aria-label', on ? 'Hide PIN' : 'Show PIN');
    btn.querySelector('.reveal-text').textContent = on ? 'Hide' : 'Show';
    $('pin1').type = on ? 'text' : 'password';
    $('pin2').type = on ? 'text' : 'password';
  }

  function clearPins() {
    S.startSent = false;
    $('pin1').value = '';
    $('pin2').value = '';
    S.pinTouched = S.confirmTouched = false;
    S.flash = null;
    setReveal(false);
    renderPin();
  }

  // ───────────────────────────── begin ─────────────────────────────
  var busyTimer = null;

  function tryBegin() {
    if (S.busy) return;
    var st = pinState();
    if (!st.ok) {
      S.pinTouched = true;
      S.confirmTouched = !!$('pin2').value;
      renderPin();
      restartAnim($('pinHelp'), 'shake');
      var a = $('pin1').value;
      (a.length < PIN_MIN ? $('pin1') : $('pin2')).focus();
      return;
    }
    flushSave();
    clearError();
    S.busy = true;
    S.startPending = true;
    S.startSent = true;
    renderPin();
    Brick.send('session.start', {
      durationMin: S.settings.durationMin,
      pin: $('pin1').value,
      mode: (currentMode() || { id: S.settings.mode }).id,
      intention: intentionValue()
    });
    clearTimeout(busyTimer);
    busyTimer = setTimeout(function () { S.busy = false; renderPin(); }, 2500);
  }

  function showError(message) {
    var box = $('beginError');
    $('begin').classList.add('has-error');
    box.textContent = '';
    box.appendChild(icon('alert'));
    box.appendChild(document.createTextNode(String(message || 'Something went wrong. Please try again.')));
    restartAnim(box, 'shake');
  }
  function clearError() {
    $('beginError').textContent = '';
    $('begin').classList.remove('has-error');
  }

  function renderSummary() {
    var m = currentMode();
    var name = m ? m.name : 'The visual';
    var n = (S.status && S.status.displays) || 1;
    var where = n <= 1 ? 'your display' : n === 2 ? 'both displays' : 'all ' + n + ' displays';
    var box = $('summary');
    box.textContent = '';
    box.appendChild(el('b', { text: name }));
    box.appendChild(document.createTextNode(' on ' + (n <= 1 ? 'your display' : n + ' displays') + ' · only Spotify in reach'));

    var rules = $('rules');
    rules.textContent = '';
    rules.appendChild(el('li', null, icon('display'), el('span', null, el('b', { text: name }), ' fills ' + where)));
    rules.appendChild(el('li', null, icon('note'), el('span', { text: 'Only Spotify stays within reach' })));
    rules.appendChild(el('li', null, icon('lock'), el('span', { text: 'Stopping early takes your PIN, three times' })));
  }

  // ───────────────────────────── stats ─────────────────────────────
  function last7(recent) {
    var today = startOfDay(new Date());
    var days = [];
    for (var i = 6; i >= 0; i--) {
      var d = new Date(today);
      d.setDate(d.getDate() - i);
      var e = new Date(d);
      e.setDate(e.getDate() + 1);
      days.push({ start: d.getTime(), end: e.getTime(), ms: 0, date: d, today: i === 0 });
    }
    (recent || []).forEach(function (r) {
      var t = +r.startedAt;
      for (var k = 0; k < days.length; k++) {
        if (t >= days[k].start && t < days[k].end) { days[k].ms += Math.max(0, +r.focusedMs || 0); break; }
      }
    });
    return days;
  }

  function renderStats() {
    var box = $('stats');
    box.textContent = '';
    var st = S.stats;
    var empty = !st || !((st.totalSessions || 0) > 0 || (st.weekMs || 0) > 0 || (st.todayMs || 0) > 0);
    if (empty) {
      box.appendChild(el('span', { class: 'stats-empty', text: 'Your first session starts here.' }));
      return;
    }
    box.appendChild(el('span', { class: 'stat' }, 'Today ', el('b', { text: U.formatDuration(st.todayMs || 0) })));
    box.appendChild(el('span', { class: 'stat-sep', 'aria-hidden': 'true' }));
    box.appendChild(el('span', { class: 'stat' }, 'This week ', el('b', { text: U.formatDuration(st.weekMs || 0) })));
    if ((st.streakDays || 0) >= 2) {
      box.appendChild(el('span', { class: 'stat-sep', 'aria-hidden': 'true' }));
      box.appendChild(el('span', { class: 'stat' }, el('b', { text: st.streakDays + '-day' }), ' streak'));
    }
    var days = last7(st.recent);
    var max = Math.max(45 * 60000, Math.max.apply(null, days.map(function (d) { return d.ms; })));
    var labels = [];
    var spark = el('span', { class: 'spark', role: 'img' });
    days.forEach(function (d) {
      var name = d.today ? 'Today' : d.date.toLocaleDateString(undefined, { weekday: 'short' });
      labels.push(name + ' ' + U.formatDuration(d.ms));
      var h = d.ms > 0 ? Math.max(3, Math.round(18 * d.ms / max)) : 2;
      spark.appendChild(el('i', {
        class: (d.ms > 0 ? '' : 'is-zero') + (d.today ? ' is-today' : ''),
        style: { height: h + 'px' },
        title: name + ' · ' + U.formatDuration(d.ms)
      }));
    });
    spark.setAttribute('aria-label', 'Last 7 days: ' + labels.join(', '));
    box.appendChild(spark);
  }

  // ───────────────────────────── readiness ─────────────────────────────
  function readinessItems() {
    var st = S.status;
    var set = S.settings;
    var f = (st && st.focus) || {}, sp = (st && st.spotify) || {}, au = (st && st.audio) || {}, li = (st && st.loginItem) || {};
    var checking = !st;

    var focus = { id: 'focus', label: 'Do Not Disturb' };
    if (checking) { focus.state = 'off'; focus.value = 'Checking…'; }
    else if (!set.focusEnabled) { focus.state = 'off'; focus.value = 'Off'; }
    else if (f.shortcutsAvailable === false) { focus.state = 'off'; focus.value = 'Unavailable'; }
    else if (f.hasOn && f.hasOff) { focus.state = 'ok'; focus.value = 'Ready'; }
    else { focus.state = 'warn'; focus.value = 'Set up'; focus.todo = true; }

    var spot = { id: 'spotify', label: 'Spotify' };
    if (checking) { spot.state = 'off'; spot.value = 'Checking…'; }
    else if (sp.installed === false) { spot.state = 'off'; spot.value = 'Not installed'; }
    else if (sp.permission === 'granted') { spot.state = 'ok'; spot.value = 'Allowed'; }
    else if (sp.permission === 'denied') { spot.state = 'bad'; spot.value = 'Blocked'; spot.todo = true; }
    else { spot.state = 'warn'; spot.value = 'Allow'; spot.todo = true; }

    var audio = { id: 'audio', label: 'Music-reactive' };
    if (checking) { audio.state = 'off'; audio.value = 'Checking…'; }
    else if (au.supported === false) { audio.state = 'off'; audio.value = 'Unsupported'; }
    else if (au.permission === 'granted') { audio.state = 'ok'; audio.value = 'On'; }
    else { audio.state = 'warn'; audio.value = 'Allow'; }

    var resume = { id: 'resume', label: 'Resume after restart' };
    if (checking) { resume.state = 'off'; resume.value = 'Checking…'; }
    else if (!set.resumeAfterRestart) { resume.state = 'off'; resume.value = 'Off'; }
    else if (li.status === 'enabled') { resume.state = 'ok'; resume.value = 'On'; }
    else if (li.status === 'requiresApproval') { resume.state = 'warn'; resume.value = 'Approve'; resume.todo = true; }
    else if (li.status === 'notRegistered') { resume.state = 'warn'; resume.value = 'Not active'; resume.todo = true; }
    else if (li.status === 'notFound') { resume.state = 'bad'; resume.value = 'Unavailable'; resume.todo = true; }
    else { resume.state = 'off'; resume.value = 'Unavailable'; }

    return [focus, spot, audio, resume];
  }

  var openReady = null;     // id of the open checklist item
  var recheckBusy = false;

  function renderReady() {
    var items = readinessItems();
    var box = $('readyItems');
    var focusedId = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-ready');
    box.textContent = '';
    items.forEach(function (it) {
      var b = el('button', {
        type: 'button', class: 'ready-item is-' + it.state, 'data-ready': it.id,
        'aria-expanded': openReady === it.id ? 'true' : 'false', 'aria-controls': 'readyPop',
        'aria-label': it.label + ': ' + it.value
      },
      el('span', { class: 'dot ' + it.state, 'aria-hidden': 'true' }),
      el('span', { class: 'ri-label', text: it.label }),
      el('span', { class: 'ri-val', text: it.value }),
      icon('chevron'));
      b.addEventListener('click', function (e) { toggleReady(it.id, e.detail === 0); });
      box.appendChild(b);
      if (focusedId === it.id) b.focus();
    });

    var todo = items.filter(function (i) { return i.todo; }).length;
    var sum = $('readySummary');
    sum.textContent = '';
    sum.classList.toggle('is-todo', todo > 0);
    if (!S.status) {
      sum.appendChild(icon('todo'));
      sum.appendChild(document.createTextNode('Checking'));
    } else if (todo) {
      sum.appendChild(icon('todo'));
      sum.appendChild(document.createTextNode(todo === 1 ? '1 thing to set up' : todo + ' things to set up'));
    } else {
      sum.appendChild(icon('checkCircle'));
      sum.appendChild(document.createTextNode('Ready'));
    }
    if (openReady) renderReadyPop();
  }

  function actionBtn(label, onClick, opts) {
    opts = opts || {};
    var b = el('button', { type: 'button', class: 'btn btn-sm' + (opts.primary ? ' btn-lamp' : '') + (opts.ghost ? ' btn-ghost' : ''), text: label });
    b.addEventListener('click', function () { onClick(b); });
    if (opts.disabled) b.disabled = true;
    return b;
  }
  function recheckBtn() {
    var b = actionBtn(recheckBusy ? 'Checking…' : 'Re-check', function (btn) {
      recheckBusy = true;
      btn.textContent = 'Checking…';
      btn.classList.add('is-busy');
      Brick.send('status.refresh', {});
      setTimeout(function () { if (recheckBusy) { recheckBusy = false; if (openReady) renderReadyPop(); } }, 2500);
    }, { ghost: false });
    if (recheckBusy) b.classList.add('is-busy');
    return b;
  }
  function sendBtn(label, type, opts) {
    return actionBtn(label, function (btn) {
      Brick.send(type, {});
      btn.classList.add('is-busy');
      setTimeout(function () { btn.classList.remove('is-busy'); }, 1800);
    }, opts);
  }
  function para(cls) {
    var p = el('p', { class: cls || 'pop-text' });
    for (var i = 1; i < arguments.length; i++) {
      var c = arguments[i];
      p.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return p;
  }
  function b(text) { return el('b', { text: text }); }
  function shortcutChip(name, found) {
    var copy = el('button', { type: 'button', class: 'copy-btn', text: 'Copy', 'aria-label': 'Copy the name ' + name });
    copy.addEventListener('click', function () { copyText(name, copy); });
    return el('span', { class: 'shortcut-name' },
      el('span', { text: name }),
      el('span', { class: 'sn-state ' + (found ? 'ok' : 'missing'), text: found ? 'Found' : 'Missing' }),
      copy);
  }

  function readyPopContent(it) {
    var st = S.status || {};
    var f = st.focus || {}, sp = st.spotify || {}, au = st.audio || {}, li = st.loginItem || {};
    var nodes = [];
    var actions = el('div', { class: 'pop-actions' });

    if (it.id === 'focus') {
      if (!S.settings.focusEnabled) {
        nodes.push(para('pop-text', 'You’ve switched this off in Preferences, so Analog Brick won’t touch Focus. Turn on Do Not Disturb yourself if you like.'));
        actions.appendChild(actionBtn('Open Preferences', function () { closeReady(); openPrefs(); }));
      } else if (f.shortcutsAvailable === false) {
        nodes.push(para('pop-text', 'Focus can’t be automated on this Mac, because the Shortcuts app isn’t available. Sessions still work: turn on ', b('Do Not Disturb'), ' from Control Center before you begin.'));
        actions.appendChild(recheckBtn());
      } else if (f.hasOn && f.hasOff) {
        nodes.push(para('pop-text', 'Do Not Disturb turns on when a session starts and off when it ends, using your shortcuts ', b('“' + (f.onName || 'Focus On') + '”'), ' and ', b('“' + (f.offName || 'Focus Off') + '”'), '.'));
        actions.appendChild(sendBtn('Test', 'focus.test'));
        actions.appendChild(recheckBtn());
        nodes.push(actions);
        nodes.push(para('pop-note', 'Test turns Do Not Disturb on for three seconds, then off again.'));
        return nodes;
      } else {
        nodes.push(para('pop-text', 'Analog Brick switches Do Not Disturb with two shortcuts you make once in the Shortcuts app.'));
        var steps = el('ol', { class: 'steps' });
        steps.appendChild(el('li', null, 'In Shortcuts, make a new shortcut named exactly', el('br'), shortcutChip(f.onName || 'Analog Brick Focus On', !!f.hasOn)));
        steps.appendChild(el('li', null, 'Add the ', b('Set Focus'), ' action: ', b('Do Not Disturb'), ' → ', b('Turn On'), ' → ', b('Until Turned Off'), '.'));
        steps.appendChild(el('li', null, 'Make a second shortcut named exactly', el('br'), shortcutChip(f.offName || 'Analog Brick Focus Off', !!f.hasOff), el('br'), 'with ', b('Set Focus'), ' → ', b('Do Not Disturb'), ' → ', b('Turn Off'), '.'));
        steps.appendChild(el('li', null, 'Come back here and press ', b('Re-check'), '.'));
        nodes.push(steps);
        actions.appendChild(sendBtn('Open Shortcuts', 'focus.openShortcuts', { primary: true }));
        actions.appendChild(recheckBtn());
        actions.appendChild(sendBtn('Test', 'focus.test', { disabled: !(f.hasOn || f.hasOff) }));
      }
    } else if (it.id === 'spotify') {
      if (sp.installed === false) {
        nodes.push(para('pop-text', 'Spotify isn’t installed. Everything else works; you just won’t have music controls during a session.'));
        actions.appendChild(actionBtn('Get Spotify', function () { Brick.send('openURL', { url: 'https://www.spotify.com/download/mac/' }); }));
        actions.appendChild(recheckBtn());
      } else if (sp.permission === 'granted') {
        nodes.push(para('pop-text', 'During a session Spotify is the one thing you can reach: play, pause, skip and pick a playlist from the lock screen.'));
        actions.appendChild(recheckBtn());
      } else if (sp.permission === 'denied') {
        nodes.push(para('pop-text', 'macOS is blocking Analog Brick from controlling Spotify. To fix it:'));
        var s2 = el('ol', { class: 'steps' });
        s2.appendChild(el('li', null, 'Open ', b('System Settings'), ' › ', b('Privacy & Security'), ' › ', b('Automation'), '.'));
        s2.appendChild(el('li', null, 'Find ', b('Analog Brick'), ' and switch on ', b('Spotify'), '.'));
        s2.appendChild(el('li', null, 'Come back here and press ', b('Re-check'), '.'));
        nodes.push(s2);
        actions.appendChild(recheckBtn());
      } else {
        nodes.push(para('pop-text', 'During a session the only thing you can control is Spotify. macOS asks once whether Analog Brick may do that, and it’s better to answer now than mid-session.'));
        actions.appendChild(sendBtn('Allow…', 'spotify.requestPermission', { primary: true }));
        actions.appendChild(recheckBtn());
        nodes.push(actions);
        nodes.push(para('pop-note', sp.running ? 'Spotify is open, so the prompt appears right away.' : 'Spotify needs to be open for the prompt. Analog Brick opens it quietly in the background.'));
        return nodes;
      }
    } else if (it.id === 'audio') {
      if (au.supported === false) {
        nodes.push(para('pop-text', 'Listening to Spotify needs macOS 13 or later. Pulse still moves, to a gentle built-in rhythm.'));
        actions.appendChild(recheckBtn());
      } else if (au.permission === 'granted') {
        nodes.push(para('pop-text', 'Pulse listens to Spotify’s audio so it can move with your music. Nothing is recorded, saved or sent anywhere.'));
        actions.appendChild(recheckBtn());
      } else {
        nodes.push(para('pop-text', 'Optional. To let Pulse move with your music, macOS asks for ', b('Screen Recording'), ' permission. Analog Brick uses it only to hear Spotify during a session. Nothing is recorded, saved or sent anywhere.'));
        actions.appendChild(sendBtn('Allow…', 'audio.requestPermission', { primary: true }));
        actions.appendChild(recheckBtn());
        nodes.push(actions);
        nodes.push(para('pop-note', 'If you said no before, this opens System Settings › Privacy & Security › Screen Recording instead.'));
        return nodes;
      }
    } else if (it.id === 'resume') {
      if (!S.settings.resumeAfterRestart) {
        nodes.push(para('pop-text', 'Switched off in Preferences. If the Mac restarts, the session ends early.'));
        actions.appendChild(actionBtn('Open Preferences', function () { closeReady(); openPrefs(); }));
      } else if (li.status === 'enabled') {
        nodes.push(para('pop-text', 'If your Mac restarts during a session, Analog Brick opens again and the lock picks up where it left off.'));
        actions.appendChild(recheckBtn());
      } else if (li.status === 'requiresApproval') {
        nodes.push(para('pop-text', 'macOS needs your OK before Analog Brick can reopen after a restart. In ', b('Login Items'), ', switch on Analog Brick under ', b('Allow in the Background'), '.'));
        actions.appendChild(sendBtn('Open Login Items', 'loginItem.openSettings', { primary: true }));
        actions.appendChild(recheckBtn());
      } else if (li.status === 'notRegistered') {
        nodes.push(para('pop-text', 'Not active yet. Analog Brick registers itself while this setting is on; give it a moment, then re-check.'));
        actions.appendChild(recheckBtn());
      } else if (li.status === 'notFound') {
        nodes.push(para('pop-text', 'macOS couldn’t find the helper that reopens Analog Brick. Move the app to your ', b('Applications'), ' folder and open it again.'));
        actions.appendChild(recheckBtn());
      } else {
        nodes.push(para('pop-text', 'Reopening after a restart isn’t available on this Mac.'));
        actions.appendChild(recheckBtn());
      }
    }
    nodes.push(actions);
    return nodes;
  }

  function renderReadyPop() {
    var it = null;
    readinessItems().forEach(function (x) { if (x.id === openReady) it = x; });
    var pop = $('readyPop');
    if (!it) { closeReady(); return; }
    var hadFocus = within(pop, document.activeElement);
    pop.textContent = '';
    pop.appendChild(el('div', { class: 'pop-head' },
      el('span', { class: 'dot ' + it.state, 'aria-hidden': 'true' }),
      el('h3', { class: 'pop-title', id: 'readyPopTitle', text: it.label }),
      el('span', { class: 'pop-state ' + it.state, text: it.value })));
    readyPopContent(it).forEach(function (n) { pop.appendChild(n); });
    if (hadFocus) { var f = pop.querySelector('button:not([disabled])'); if (f) f.focus(); else pop.focus(); }
    positionReadyPop();
  }

  function positionReadyPop() {
    if (!openReady) return;
    var pop = $('readyPop');
    var btn = document.querySelector('.ready-item[data-ready="' + openReady + '"]');
    var bar = document.querySelector('.ready-bar');
    if (!btn || !bar) return;
    var r = btn.getBoundingClientRect(), br = bar.getBoundingClientRect();
    var w = pop.offsetWidth || 380;
    var left = U.clamp(r.left - 6, 16, window.innerWidth - w - 16);
    pop.style.left = Math.round(left) + 'px';
    pop.style.bottom = Math.round(window.innerHeight - br.top + 10) + 'px';
    pop.style.transformOrigin = Math.round(r.left + r.width / 2 - left) + 'px 100%';
  }

  function toggleReady(id, viaKeyboard) {
    if (openReady === id) closeReady(true);
    else openReadyPop(id, viaKeyboard);
  }
  function openReadyPop(id, focusInside) {
    openReady = id;
    renderReady();
    var pop = $('readyPop');
    pop.classList.add('is-open');
    positionReadyPop();
    if (focusInside) {
      var f = pop.querySelector('button:not([disabled])');
      (f || pop).focus();
    }
  }
  function closeReady(returnFocus) {
    if (!openReady) return;
    var id = openReady;
    openReady = null;
    $('readyPop').classList.remove('is-open');
    Array.prototype.forEach.call(document.querySelectorAll('.ready-item'), function (b) { b.setAttribute('aria-expanded', 'false'); });
    if (returnFocus) {
      var b = document.querySelector('.ready-item[data-ready="' + id + '"]');
      if (b) b.focus();
    }
  }

  document.addEventListener('mousedown', function (e) {
    if (!openReady) return;
    if (within($('readyPop'), e.target) || (e.target.closest && e.target.closest('.ready-item'))) return;
    closeReady(false);
  });
  $('readyPop').addEventListener('focusout', function (e) {
    var to = e.relatedTarget;
    if (!to || within($('readyPop'), to) || (to.closest && to.closest('.ready-item'))) return;
    closeReady(false);
  });
  window.addEventListener('resize', positionReadyPop);

  // ───────────────────────────── preferences ─────────────────────────────
  var prefsOpen = false;
  var prefsReturnFocus = null;

  function openPrefs() {
    if (prefsOpen) return;
    closeReady(false);
    prefsOpen = true;
    prefsReturnFocus = document.activeElement;
    renderPrefs(true);
    var p = $('prefs');
    p.classList.add('is-open');
    p.setAttribute('aria-hidden', 'false');
    $('scrim').classList.add('is-open');
    $('app').setAttribute('aria-hidden', 'true');
    $('app').inert = true;
    $('openPrefs').setAttribute('aria-expanded', 'true');
    setTimeout(function () { p.focus(); }, 60);
  }
  function closePrefs() {
    if (!prefsOpen) return;
    prefsOpen = false;
    flushSave();
    var p = $('prefs');
    p.classList.remove('is-open');
    p.setAttribute('aria-hidden', 'true');
    $('scrim').classList.remove('is-open');
    $('app').removeAttribute('aria-hidden');
    $('app').inert = false;
    $('openPrefs').setAttribute('aria-expanded', 'false');
    var back = prefsReturnFocus && document.contains(prefsReturnFocus) ? prefsReturnFocus : $('openPrefs');
    setTimeout(function () { try { back.focus(); } catch (e) { /* ignore */ } }, 0);
  }

  function setSliderFill(input) {
    var min = +input.min, max = +input.max, v = +input.value;
    input.style.setProperty('--fill', ((v - min) / (max - min) * 100).toFixed(1) + '%');
  }
  function formatPeek(sec) {
    sec = Math.round(sec);
    var m = Math.floor(sec / 60), s = sec % 60;
    if (m === 0) return s + ' s';
    return s === 0 ? m + ' min' : m + ':' + (s < 10 ? '0' : '') + s;
  }

  function renderPrefs(force) {
    var s = S.settings;
    var body = $('prefsBody');
    Array.prototype.forEach.call(body.querySelectorAll('input[type="radio"]'), function (r) {
      r.checked = s[r.name] === r.value;
    });
    Array.prototype.forEach.call(body.querySelectorAll('input[type="checkbox"][data-key]'), function (c) {
      c.checked = !!s[c.getAttribute('data-key')];
    });
    var cd = $('confirmDelay');
    if (!isFocused(cd)) cd.value = String(s.confirmDelaySec);
    setSliderFill(cd);
    $('confirmDelayVal').textContent = (+cd.value === 0 ? 'None' : cd.value + ' s');
    var pk = $('peekSec');
    if (!isFocused(pk)) pk.value = String(s.peekSeconds);
    setSliderFill(pk);
    $('peekSecVal').textContent = formatPeek(+pk.value);

    renderAutoplay();
    renderPlaylists(!!force);
    renderGalleryPrefs();

    var n = (S.status && S.status.displays) || 0;
    $('displaysDesc').textContent = n > 1
      ? 'Show a quiet countdown on your other ' + (n === 2 ? 'display' : (n - 1) + ' displays') + ' too.'
      : 'Show a quiet countdown on other displays too. One is connected now.';
    $('prefsFoot').textContent = 'Analog Brick' + (S.version ? ' v' + S.version : '');
  }

  function renderAutoplay() {
    var sel = $('autoplay');
    if (isFocused(sel)) return;
    var s = S.settings;
    sel.textContent = '';
    sel.appendChild(el('option', { value: '', text: 'Nothing' }));
    var found = false;
    (s.quickPlaylists || []).forEach(function (p) {
      if (!p || !p.uri) return;
      if (p.uri === s.autoplayUri) found = true;
      sel.appendChild(el('option', { value: p.uri, text: p.name || p.uri }));
    });
    if (s.autoplayUri && !found) sel.appendChild(el('option', { value: s.autoplayUri, text: 'Other: ' + s.autoplayUri }));
    sel.value = s.autoplayUri || '';
  }

  // Quick playlists editor. plDraft holds rows as typed (including half-typed, invalid ones);
  // only valid rows are saved.
  var plDraft = null;

  function validPlaylists(rows) {
    var out = [];
    (rows || []).forEach(function (r) {
      var uri = normalizeSpotify(r.uri);
      if (uri) out.push({ name: (r.name || '').trim().slice(0, 60) || 'Playlist', uri: uri });
    });
    return out.slice(0, MAX_PLAYLISTS);
  }

  function renderPlaylists(force) {
    var box = $('playlists');
    if (!force && within(box, document.activeElement)) return;
    var saved = S.settings.quickPlaylists || [];
    if (!force && plDraft && JSON.stringify(validPlaylists(plDraft)) === JSON.stringify(saved)) return;
    if (force && plDraft && JSON.stringify(validPlaylists(plDraft)) === JSON.stringify(saved)) {
      // keep the draft (it may contain rows being edited)
    } else {
      plDraft = saved.map(function (p) { return { name: p.name, uri: p.uri }; });
    }
    buildPlaylistRows();
  }

  function buildPlaylistRows(focusIndex) {
    var box = $('playlists');
    box.textContent = '';
    if (!plDraft.length) {
      box.appendChild(el('p', { class: 'pl-empty', text: 'No quick playlists yet.' }));
    }
    plDraft.forEach(function (row, idx) {
      var name = el('input', { class: 'field pl-name', type: 'text', placeholder: 'Name', maxlength: '60', 'aria-label': 'Playlist ' + (idx + 1) + ' name', spellcheck: 'false' });
      name.value = row.name || '';
      var uri = el('input', { class: 'field pl-uri', type: 'text', placeholder: 'https://open.spotify.com/playlist/…', 'aria-label': 'Playlist ' + (idx + 1) + ' Spotify link or URI', spellcheck: 'false', autocomplete: 'off' });
      uri.value = row.uri || '';
      var msg = el('p', { class: 'pl-msg', 'aria-live': 'polite', id: 'plmsg' + idx });
      uri.setAttribute('aria-describedby', msg.id);
      var del = el('button', { type: 'button', class: 'icon-btn pl-del', 'aria-label': 'Remove playlist ' + (idx + 1) }, icon('x'));

      function validate(showConverted) {
        var v = uri.value.trim();
        var norm = normalizeSpotify(v);
        msg.className = 'pl-msg';
        msg.textContent = '';
        uri.classList.remove('is-invalid');
        uri.removeAttribute('aria-invalid');
        if (!v) return null;
        if (!norm) {
          uri.classList.add('is-invalid');
          uri.setAttribute('aria-invalid', 'true');
          msg.className = 'pl-msg is-error';
          msg.textContent = 'Paste a Spotify playlist, album or track link.';
        } else if (showConverted && norm !== v) {
          msg.className = 'pl-msg is-ok';
          msg.textContent = 'Link converted to ' + norm;
        }
        return norm;
      }

      name.addEventListener('input', function () { row.name = name.value; commitPlaylists(); });
      uri.addEventListener('input', function () { row.uri = uri.value; validate(false); commitPlaylists(); });
      uri.addEventListener('blur', function () {
        var v = uri.value.trim();
        var norm = normalizeSpotify(v);
        if (norm && norm !== v) {
          uri.value = norm;
          row.uri = norm;
          validate(false);
          msg.className = 'pl-msg is-ok';
          msg.textContent = 'Link converted to ' + norm;
          setTimeout(function () { if (msg.className === 'pl-msg is-ok') { msg.textContent = ''; } }, 2600);
        } else {
          validate(false);
        }
      });
      del.addEventListener('click', function () {
        plDraft.splice(idx, 1);
        buildPlaylistRows(Math.min(idx, plDraft.length - 1));
        commitPlaylists();
        if (!plDraft.length) $('plAdd').focus();
      });
      if (row.uri) validate(false);
      box.appendChild(el('div', { class: 'pl-row', role: 'listitem' }, name, uri, del, msg));
    });
    $('plAdd').disabled = plDraft.length >= MAX_PLAYLISTS;
    if (focusIndex != null && focusIndex >= 0) {
      var rows = box.querySelectorAll('.pl-row');
      var r = rows[focusIndex];
      if (r) r.querySelector('.pl-name').focus();
    }
  }

  function commitPlaylists() {
    var list = validPlaylists(plDraft);
    if (JSON.stringify(list) === JSON.stringify(S.settings.quickPlaylists || [])) return;
    var patch = { quickPlaylists: list };
    if (S.settings.autoplayUri && !list.some(function (p) { return p.uri === S.settings.autoplayUri; })) {
      var wasQuick = (S.settings.quickPlaylists || []).some(function (p) { return p.uri === S.settings.autoplayUri; });
      if (wasQuick) patch.autoplayUri = '';
    }
    queueSave(patch);
    renderAutoplay();
  }

  function renderGalleryPrefs() {
    var g = S.gallery || {};
    var has = !!g.folder;
    $('galleryDesc').textContent = has
      ? folderName(g.folder) + ' · ' + plural(g.count || 0, 'photo')
      : 'Choose a folder of photos for the Gallery visual.';
    $('galleryChoose').textContent = has ? 'Change…' : 'Choose…';
    $('galleryClear').hidden = !has;
    var box = $('galleryThumbs');
    box.textContent = '';
    (g.images || []).slice(0, 6).forEach(function (src) {
      box.appendChild(el('span', null, el('img', { src: src, alt: '', loading: 'lazy', draggable: 'false' })));
    });
  }

  function chooseGallery() { Brick.send('gallery.choose', {}); }

  function bindPrefs() {
    var body = $('prefsBody');
    Array.prototype.forEach.call(body.querySelectorAll('input[type="radio"]'), function (r) {
      r.addEventListener('change', function () {
        if (!r.checked) return;
        var patch = {};
        patch[r.name] = r.value;
        queueSave(patch);
        if (r.name === 'breathPattern' && stage) stage.setOptions({ breathPattern: r.value });
      });
    });
    Array.prototype.forEach.call(body.querySelectorAll('input[type="checkbox"][data-key]'), function (c) {
      c.addEventListener('change', function () {
        var patch = {};
        patch[c.getAttribute('data-key')] = c.checked;
        queueSave(patch);
        renderReady();
      });
    });
    [['confirmDelay', 'confirmDelaySec'], ['peekSec', 'peekSeconds']].forEach(function (pair) {
      var input = $(pair[0]);
      input.addEventListener('input', function () {
        var patch = {};
        patch[pair[1]] = +input.value;
        queueSave(patch);
        renderPrefs(false);
      });
    });
    $('autoplay').addEventListener('change', function () { queueSave({ autoplayUri: $('autoplay').value }); });
    $('plAdd').addEventListener('click', function () {
      if (!plDraft) plDraft = [];
      if (plDraft.length >= MAX_PLAYLISTS) return;
      plDraft.push({ name: '', uri: '' });
      buildPlaylistRows(plDraft.length - 1);
    });
    $('galleryChoose').addEventListener('click', chooseGallery);
    $('galleryClear').addEventListener('click', function () { Brick.send('gallery.clear', {}); });
    $('openPrefs').addEventListener('click', openPrefs);
    $('closePrefs').addEventListener('click', closePrefs);
    $('scrim').addEventListener('click', closePrefs);
  }

  // ───────────────────────────── gallery ─────────────────────────────
  function applyGallery(g) {
    S.gallery = {
      folder: g && g.folder ? g.folder : null,
      count: (g && g.count) || 0,
      images: (g && Array.isArray(g.images)) ? g.images.slice(0, 12) : []
    };
    if (stage) stage.setOptions({ images: S.gallery.images.slice() });
    renderGalleryTile();
    var cur = currentMode();
    if (cur && cur.id === 'gallery') fillCaption(cur, false);
    renderGalleryPrefs();
  }

  // ───────────────────────────── settings from native ─────────────────────────────
  function applySettings(s, isInit) {
    var merged = Object.assign({}, DEFAULTS, s || {}, pendingSave);
    var prevMode = S.settings.mode;
    var prevBreath = S.settings.breathPattern;
    S.settings = merged;
    if (!modeById(S.settings.mode)) S.settings.mode = (modes[0] && modes[0].id) || 'aurora';

    if (isInit || !isFocused($('intention'))) {
      if (isInit || $('intention').value !== S.settings.intention) $('intention').value = S.settings.intention || '';
    }
    renderDuration();
    renderModeTiles();
    if (isInit || prevMode !== S.settings.mode) {
      fillCaption(currentMode(), false);
      if (stage && stage.mode !== S.settings.mode) stage.setMode(S.settings.mode, { transition: 1000 });
      if (stage) stage.setPlaying(S.settings.mode === 'pulse');
    }
    if (stage && prevBreath !== S.settings.breathPattern) stage.setOptions({ breathPattern: S.settings.breathPattern });
    renderSummary();
    renderReady();
    renderPrefs(false);
  }

  // ───────────────────────────── wiring ─────────────────────────────
  function bindSession() {
    $('durMinus').addEventListener('click', function () { stepDuration(-1); });
    $('durPlus').addEventListener('click', function () { stepDuration(1); });
    var dur = $('durInput');
    dur.addEventListener('input', function () {
      var clean = dur.value.replace(/\D+/g, '').slice(0, 3);
      if (clean !== dur.value) dur.value = clean;
      sizeDurInput();
    });
    dur.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowUp') { e.preventDefault(); commitDurInput(); stepDuration(1); dur.value = String(S.settings.durationMin); sizeDurInput(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); commitDurInput(); stepDuration(-1); dur.value = String(S.settings.durationMin); sizeDurInput(); }
      else if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) { e.preventDefault(); commitDurInput(); }
    });
    dur.addEventListener('blur', commitDurInput);
    // Select the number on focus so typing replaces it; keep that selection through the click's mouseup.
    var durJustFocused = false;
    dur.addEventListener('focus', function () {
      try { dur.select(); } catch (e) { /* ignore */ }
      durJustFocused = true;
      setTimeout(function () { durJustFocused = false; }, 250);
    });
    dur.addEventListener('mouseup', function (e) { if (durJustFocused) e.preventDefault(); });

    var intention = $('intention');
    intention.addEventListener('input', function () {
      renderLockMock();
      queueSave({ intention: intention.value.slice(0, 140) });
    });
    intention.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) { e.preventDefault(); $('pin1').focus(); }
    });

    var p1 = $('pin1'), p2 = $('pin2');
    [p1, p2].forEach(function (p) {
      p.addEventListener('input', onPinInput);
      p.addEventListener('blur', function () {
        if (p === p1 && p1.value) S.pinTouched = true;
        if (p === p2 && p2.value) S.confirmTouched = true;
        renderPin();
      });
      p.addEventListener('focus', renderPin);
    });
    p1.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        S.pinTouched = true;
        if (p1.value.length >= PIN_MIN) p2.focus(); else { renderPin(); restartAnim($('pinHelp'), 'shake'); }
      }
    });
    p2.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) { e.preventDefault(); S.confirmTouched = true; tryBegin(); }
    });
    $('pinReveal').addEventListener('click', function () { setReveal(!S.pinVisible); });

    $('sessionForm').addEventListener('submit', function (e) { e.preventDefault(); tryBegin(); });
  }

  document.addEventListener('keydown', function (e) {
    var mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      if (!prefsOpen) tryBegin();
      return;
    }
    if (mod && (e.key === ',' || e.code === 'Comma')) {
      e.preventDefault();
      if (prefsOpen) closePrefs(); else openPrefs();
      return;
    }
    if (e.key === 'Escape') {
      if (prefsOpen) { e.preventDefault(); closePrefs(); }
      else if (openReady) { e.preventDefault(); closeReady(true); }
      return;
    }
    if (e.key === 'Tab' && prefsOpen) {
      var f = Array.prototype.filter.call($('prefs').querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])'), function (n) {
        return !n.disabled && !n.hidden && n.offsetParent !== null;
      });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      var active = document.activeElement;
      if (active === $('prefs') || !within($('prefs'), active)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // The window hides when a session starts: forget the PIN.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && S.startPending) {
      S.startPending = false;
      S.busy = false;
      clearPins();
    }
  });

  setInterval(renderEnds, 30000);

  // ───────────────────────────── bridge ─────────────────────────────
  Brick.on('init', function (p) {
    p = p || {};
    S.version = p.version || '';
    $('version').textContent = S.version ? 'v' + S.version : '';
    S.status = p.status || null;
    S.stats = p.stats || null;
    applyGallery(p.gallery);
    applySettings(p.settings, true);
    renderStats();
    if (!S.inited) {
      S.inited = true;
      mountStage();
      makeThumbs();
    }
  });
  Brick.on('settings', function (s) { applySettings(s, false); });
  Brick.on('status', function (st) {
    S.status = st || null;
    recheckBusy = false;
    renderReady();
    renderSummary();
    if (prefsOpen) renderPrefs(false);
  });
  Brick.on('stats', function (st) {
    S.stats = st || null;
    renderStats();
    // Stats arrive when a session ends and the window comes back: never keep that session's PIN around.
    // (They also arrive when the window is merely re-presented; a PIN being typed then is left alone.)
    if (S.startSent) {
      S.startSent = false;
      S.startPending = false;
      S.busy = false;
      clearPins();
    }
  });
  Brick.on('gallery', applyGallery);
  Brick.on('error', function (p) {
    clearTimeout(busyTimer);
    S.busy = false;
    S.startPending = false;
    S.startSent = false;
    showError(p && p.message);
    renderPin();
  });

  // ───────────────────────────── boot ─────────────────────────────
  loadModes();
  buildModes();
  buildPresets();
  bindSession();
  bindPrefs();
  fillCaption(currentMode(), false);
  renderDuration();
  renderPin();
  renderStats();
  renderReady();
  renderSummary();

  // WebKit on macOS only Tabs between text fields unless the user has turned on system-wide keyboard
  // navigation; controls with an explicit tabindex are always included. Keep every control reachable.
  function ensureTabbable() {
    Array.prototype.forEach.call(document.querySelectorAll('button, select, input[type="checkbox"], input[type="radio"], input[type="range"]'), function (n) {
      if (!n.hasAttribute('tabindex')) n.setAttribute('tabindex', '0');
    });
  }
  ensureTabbable();
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(ensureTabbable).observe(document.body, { childList: true, subtree: true });
  }

  // Small dev surface (used by the browser mock to open panels for screenshots).
  window.BrickSetup = {
    openPrefs: openPrefs,
    closePrefs: closePrefs,
    openReady: function (id) { openReadyPop(id, false); },
    selectMode: function (id) { selectMode(id); }
  };

  Brick.ready();
})();
