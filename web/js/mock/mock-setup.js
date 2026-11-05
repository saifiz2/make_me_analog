/*
 * Analog Brick — browser mock of the native side of setup.html (docs/BRIDGE.md, "Setup page").
 * Does nothing inside the app (Brick.isNative). Lets the setup page be developed and
 * screenshot-tested in a normal browser.
 *
 * Query params:
 *   focus=ok|missing|unavailable            Do Not Disturb shortcuts (default ok)
 *   spotify=granted|undetermined|denied|notinstalled   (default granted)
 *   audio=granted|denied                    Screen Recording permission (default granted)
 *   login=enabled|requiresApproval|notRegistered       (default enabled)
 *   stats=empty|some                        (default some)
 *   gallery=1                               start with a photo folder chosen
 *   displays=N                              connected displays (default 2)
 *   mode=<id>  duration=<min>  intention=<text>   initial settings
 *   fail=1                                  session.start always answers with an error
 *   prefs=1                                 open Preferences after init
 *   ready=focus|spotify|audio|resume        open that checklist item after init
 *
 * The mock never logs or keeps the PIN it receives.
 */
(function () {
  'use strict';

  var Brick = window.Brick;
  if (!Brick || Brick.isNative) return;

  var P = Brick.params;
  function param(name, fallback) { var v = P.get(name); return v == null || v === '' ? fallback : v; }

  var FOCUS_ON = 'Analog Brick Focus On';
  var FOCUS_OFF = 'Analog Brick Focus Off';

  // ───────────────────────── settings ─────────────────────────
  var settings = {
    durationMin: +param('duration', 50),
    mode: param('mode', 'aurora'),
    quality: 'balanced',
    intention: param('intention', 'Chapter 3 outline'),
    keepAwake: true,
    showTimerOnSecondary: true,
    resumeAfterRestart: true,
    focusEnabled: true,
    launchSpotify: true,
    autoplayUri: 'spotify:playlist:37i9dQZF1DWZeKCadgRdKQ',
    quickPlaylists: [
      { name: 'Deep Focus', uri: 'spotify:playlist:37i9dQZF1DWZeKCadgRdKQ' },
      { name: 'Peaceful Piano', uri: 'spotify:playlist:37i9dQZF1DX4sWSpwq3LiO' },
      { name: 'lofi beats', uri: 'spotify:playlist:37i9dQZF1DWWQRwui0ExPn' }
    ],
    confirmDelaySec: 3,
    peekSeconds: 90,
    breathPattern: 'box'
  };

  var MODES = ['aurora', 'drift', 'breath', 'horizon', 'night', 'pulse', 'gallery'];
  function clampInt(v, a, b, d) { v = Math.round(+v); if (!isFinite(v)) return d; return Math.min(b, Math.max(a, v)); }

  function normalizeUri(raw) {
    var TYPES = ['playlist', 'album', 'track', 'artist', 'show', 'episode'];
    var s = String(raw || '').trim();
    if (!s) return null;
    if (/^spotify:/.test(s)) {
      var p = s.split(':');
      if (p.length === 3 && TYPES.indexOf(p[1]) >= 0 && /^[A-Za-z0-9]{1,64}$/.test(p[2])) return s;
      return null;
    }
    try {
      var u = new URL(/^https?:/.test(s) ? s : 'https://' + s);
      if (!/^(open|play)\.spotify\.com$/.test(u.hostname)) return null;
      var c = u.pathname.split('/').filter(Boolean);
      if (c[0] && c[0].indexOf('intl-') === 0) c.shift();
      if (c.length >= 2 && TYPES.indexOf(c[0]) >= 0 && /^[A-Za-z0-9]{1,64}$/.test(c[1])) return 'spotify:' + c[0] + ':' + c[1];
    } catch (e) { /* fallthrough */ }
    return null;
  }

  /** Mirror Settings.applying(): ignore unknown keys and wrong types, clamp ranges, normalise URIs. */
  function applyPatch(patch) {
    var s = settings;
    Object.keys(patch || {}).forEach(function (k) {
      var v = patch[k];
      switch (k) {
        case 'durationMin': s.durationMin = clampInt(v, 1, 480, s.durationMin); break;
        case 'mode': if (MODES.indexOf(v) >= 0) s.mode = v; break;
        case 'quality': if (['saver', 'balanced', 'high'].indexOf(v) >= 0) s.quality = v; break;
        case 'intention': if (typeof v === 'string') s.intention = v.slice(0, 140); break;
        case 'breathPattern': if (['box', 'coherent', 'relax'].indexOf(v) >= 0) s.breathPattern = v; break;
        case 'confirmDelaySec': s.confirmDelaySec = clampInt(v, 0, 10, s.confirmDelaySec); break;
        case 'peekSeconds': s.peekSeconds = clampInt(v, 30, 300, s.peekSeconds); break;
        case 'autoplayUri': if (typeof v === 'string') s.autoplayUri = v ? (normalizeUri(v) || '') : ''; break;
        case 'quickPlaylists':
          if (Array.isArray(v)) {
            s.quickPlaylists = v.map(function (p) {
              var uri = p && normalizeUri(p.uri);
              if (!uri) return null;
              var name = String(p.name || '').trim();
              return { name: name ? name.slice(0, 60) : 'Playlist', uri: uri };
            }).filter(Boolean).slice(0, 12);
          }
          break;
        case 'keepAwake': case 'showTimerOnSecondary': case 'resumeAfterRestart': case 'focusEnabled': case 'launchSpotify':
          if (typeof v === 'boolean') s[k] = v;
          break;
        default: break;
      }
    });
  }

  // ───────────────────────── status ─────────────────────────
  var focusP = param('focus', 'ok');
  var spotifyP = param('spotify', 'granted');
  var audioP = param('audio', 'granted');
  var loginP = param('login', 'enabled');

  var status = {
    focus: {
      shortcutsAvailable: focusP !== 'unavailable',
      onName: FOCUS_ON,
      offName: FOCUS_OFF,
      hasOn: focusP === 'ok',
      hasOff: focusP === 'ok'
    },
    spotify: {
      installed: spotifyP !== 'notinstalled',
      running: spotifyP === 'granted',
      permission: spotifyP === 'notinstalled' ? 'unknown' : spotifyP
    },
    audio: { supported: true, permission: audioP === 'granted' ? 'granted' : 'denied' },
    loginItem: { status: loginP },
    displays: clampInt(param('displays', 2), 1, 8, 2)
  };
  function snapshot(o) { return JSON.parse(JSON.stringify(o)); }

  // ───────────────────────── stats ─────────────────────────
  function makeStats(empty) {
    if (empty) return { todayMs: 0, weekMs: 0, streakDays: 0, totalSessions: 0, recent: [] };
    var MIN = 60000;
    var now = new Date();
    function at(daysAgo, h, m) { var d = new Date(now); d.setDate(d.getDate() - daysAgo); d.setHours(h, m, 0, 0); return d.getTime(); }
    // [daysAgo, hour, minute, plannedMin, focusedMin, completed]
    var plan = [
      [0, 9, 10, 50, 50, true], [0, 11, 0, 45, 40, false],
      [1, 8, 40, 90, 90, true], [1, 14, 5, 25, 25, true],
      [2, 10, 0, 60, 60, true],
      [4, 9, 30, 120, 75, false], [4, 15, 0, 25, 25, true],
      [5, 13, 20, 45, 45, true],
      [6, 9, 0, 50, 50, true], [6, 16, 30, 30, 30, true],
      [9, 10, 0, 60, 60, true], [11, 9, 0, 45, 45, true]
    ];
    var recent = plan.map(function (p) {
      return { startedAt: at(p[0], p[1], p[2]), plannedMs: p[3] * MIN, focusedMs: p[4] * MIN, completed: p[5] };
    }).filter(function (r) { return r.startedAt <= Date.now(); })
      .sort(function (a, b) { return b.startedAt - a.startedAt; });
    var startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
    var startWeek = new Date(startToday); startWeek.setDate(startWeek.getDate() - 6);
    var todayMs = 0, weekMs = 0;
    recent.forEach(function (r) {
      if (r.startedAt >= startToday.getTime()) todayMs += r.focusedMs;
      if (r.startedAt >= startWeek.getTime()) weekMs += r.focusedMs;
    });
    return { todayMs: todayMs, weekMs: weekMs, streakDays: 3, totalSessions: 41, recent: recent };
  }

  // ───────────────────────── gallery ─────────────────────────
  var galleryCache = null;
  function sampleImages(n) {
    if (galleryCache) return galleryCache;
    var out = [];
    for (var i = 0; i < n; i++) {
      var c = document.createElement('canvas');
      c.width = 360; c.height = 240;
      var g = c.getContext('2d');
      var hue = (i * 41 + 195) % 360;
      var grad = g.createLinearGradient(0, 0, 0, c.height);
      grad.addColorStop(0, 'hsl(' + hue + ',38%,64%)');
      grad.addColorStop(0.55, 'hsl(' + ((hue + 28) % 360) + ',42%,42%)');
      grad.addColorStop(1, 'hsl(' + ((hue + 55) % 360) + ',32%,16%)');
      g.fillStyle = grad;
      g.fillRect(0, 0, c.width, c.height);
      var sun = g.createRadialGradient(c.width * (0.25 + (i % 3) * 0.25), c.height * 0.35, 0, c.width * 0.5, c.height * 0.35, c.width * 0.5);
      sun.addColorStop(0, 'hsla(' + ((hue + 40) % 360) + ',80%,85%,0.55)');
      sun.addColorStop(1, 'hsla(' + hue + ',80%,60%,0)');
      g.fillStyle = sun;
      g.fillRect(0, 0, c.width, c.height);
      for (var k = 0; k < 4; k++) {
        g.fillStyle = 'hsla(' + ((hue + 200) % 360) + ',22%,' + (10 + k * 6) + '%,0.92)';
        g.beginPath();
        g.moveTo(0, c.height);
        for (var x = 0; x <= c.width; x += 12) {
          g.lineTo(x, c.height * (0.55 + k * 0.1) - 30 * Math.sin(x * 0.016 + i + k * 1.7) - 13 * Math.sin(x * 0.047 + k));
        }
        g.lineTo(c.width, c.height);
        g.fill();
      }
      out.push(c.toDataURL('image/jpeg', 0.82));
    }
    galleryCache = out;
    return out;
  }
  var gallery = param('gallery', '') === '1'
    ? { folder: '/Users/maya/Pictures/Quiet places', count: 24, images: null }
    : { folder: null, count: 0, images: [] };
  function galleryPayload() {
    if (gallery.folder && !gallery.images) gallery.images = sampleImages(12);
    return { folder: gallery.folder, count: gallery.count, images: gallery.images || [] };
  }

  // ───────────────────────── toast ─────────────────────────
  var toastEl = null, toastTimer = null;
  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.setAttribute('role', 'status');
      toastEl.style.cssText = [
        'position:fixed', 'left:50%', 'bottom:76px', 'z-index:100', 'transform:translate(-50%, 8px)',
        'padding:10px 16px', 'border-radius:12px', 'font:500 13px var(--font-sans)', 'color:var(--text)',
        'background:rgba(24,26,36,0.94)', 'border:1px solid rgba(255,255,255,0.12)',
        'box-shadow:0 20px 60px rgba(0,0,0,0.55)', 'opacity:0', 'pointer-events:none',
        'transition:opacity 200ms ease, transform 260ms cubic-bezier(0.22,0.8,0.24,1)', 'white-space:nowrap'
      ].join(';');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    requestAnimationFrame(function () { toastEl.style.opacity = '1'; toastEl.style.transform = 'translate(-50%, 0)'; });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.opacity = '0'; toastEl.style.transform = 'translate(-50%, 8px)'; }, 2600);
  }

  // ───────────────────────── handlers ─────────────────────────
  var H = Brick.mock.handle;
  var emit = Brick.mock.emit;

  H('ready', function () {
    emit('init', {
      page: 'setup',
      version: '1.0.0',
      settings: snapshot(settings),
      status: snapshot(status),
      stats: makeStats(param('stats', 'some') === 'empty'),
      gallery: galleryPayload()
    });
    setTimeout(function () {
      if (!window.BrickSetup) return;
      if (param('prefs', '') === '1') window.BrickSetup.openPrefs();
      var r = param('ready', '');
      if (r) window.BrickSetup.openReady(r);
    }, 150);
  });

  H('settings.save', function (patch) {
    applyPatch(patch);
    emit('settings', snapshot(settings), 40);
  });

  H('session.start', function (p) {
    p = p || {};
    var pin = typeof p.pin === 'string' ? p.pin : '';
    var dur = Math.round(+p.durationMin);
    if (param('fail', '') === '1') { emit('error', { message: 'Couldn’t start the session: another lock is already running.' }, 250); return; }
    if (!/^[0-9]{4,8}$/.test(pin)) { emit('error', { message: 'Your PIN must be 4–8 digits.' }, 200); return; }
    if (!(dur >= 1 && dur <= 480)) { emit('error', { message: 'Choose a session between 1 minute and 8 hours.' }, 200); return; }
    if (MODES.indexOf(p.mode) >= 0) settings.mode = p.mode;
    settings.durationMin = dur;
    settings.intention = String(p.intention || '').trim().slice(0, 140);
    pin = null;
    setTimeout(function () { toast('Session would start now (mock) · ' + dur + ' min'); }, 250);
  });

  function fixEverything() {
    if (status.focus.shortcutsAvailable) { status.focus.hasOn = true; status.focus.hasOff = true; }
    status.spotify.installed = true;
    status.spotify.running = true;
    status.spotify.permission = 'granted';
    if (status.audio.supported) status.audio.permission = 'granted';
    if (status.loginItem.status !== 'unsupported') status.loginItem.status = 'enabled';
  }

  H('status.refresh', function () {
    emit('status', snapshot(status), 120);
    setTimeout(function () { fixEverything(); emit('status', snapshot(status)); }, 1100);
  });
  H('focus.openShortcuts', function () { toast('Would open the Shortcuts app (mock)'); });
  H('focus.test', function () {
    toast('Do Not Disturb on for 3 seconds… (mock)');
    setTimeout(function () { emit('status', snapshot(status)); }, 3200);
  });
  H('spotify.requestPermission', function () {
    toast('macOS would ask: “Analog Brick wants to control Spotify” (mock)');
    setTimeout(function () {
      status.spotify.installed = true;
      status.spotify.running = true;
      status.spotify.permission = 'granted';
      emit('status', snapshot(status));
    }, 1400);
  });
  H('spotify.launch', function () {
    setTimeout(function () { status.spotify.running = status.spotify.installed; emit('status', snapshot(status)); }, 800);
  });
  H('audio.requestPermission', function () {
    toast('macOS would ask for Screen Recording permission (mock)');
    setTimeout(function () { status.audio.permission = 'granted'; emit('status', snapshot(status)); }, 1200);
  });
  H('loginItem.openSettings', function () {
    toast('Would open System Settings › Login Items (mock)');
    setTimeout(function () { status.loginItem.status = 'enabled'; emit('status', snapshot(status)); }, 1600);
  });
  H('gallery.choose', function () {
    gallery = { folder: '/Users/maya/Pictures/Quiet places', count: 24, images: null };
    emit('gallery', galleryPayload(), 350);
  });
  H('gallery.clear', function () {
    gallery = { folder: null, count: 0, images: [] };
    emit('gallery', galleryPayload(), 60);
  });
  H('openURL', function (p) { toast('Would open ' + ((p && p.url) || 'a link') + ' (mock)'); });
  H('app.quit', function () { toast('Would quit (mock)'); });
  H('log', function (p) { if (p && p.message) console.log('[native log]', p.level || 'info', p.message); });
})();
