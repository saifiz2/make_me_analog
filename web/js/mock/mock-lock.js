/*
 * Analog Brick — browser mock of the native side for lock.html.
 * Plain script. Does nothing inside the app (Brick.isNative). Emulates docs/BRIDGE.md faithfully so the
 * lock screen is fully usable and screenshot-testable in a normal browser.
 *
 * Query params (all optional):
 *   role=primary|secondary   display=N   displayCount=N
 *   minutes=50               session length (fractions allowed, e.g. 0.2 to test the natural end)
 *   elapsed=7                minutes already elapsed
 *   mode=aurora              initial visual mode
 *   intention=Chapter…       session intention ("" for none; default is a sample)
 *   quality=balanced         saver | balanced | high
 *   spotify=playing          playing | paused | off | notinstalled | denied | undetermined | empty
 *   pin=1234                 the session PIN
 *   peekSeconds=90           confirmDelay=3 (seconds)   unlockTimeout=60 (seconds)   cooldown=60 (seconds)
 *   audio=1                  emit synthetic 'audio' frames ~30 Hz while playing
 *   stage=pin|confirm|cooldown|unlocked   jump into that unlock stage (with &step=N, &error=1, &wrong=N)
 *   ending=completed|unlocked             send 'ending' after 1 s
 *   peek=1                   start in a Spotify peek
 *   showTimer=0              hide the timer on secondary displays
 *   images=N                 feed the Gallery mode N generated sample images
 *   breath=box|coherent|relax
 *
 * window.__mockLog records every command the page sent ({t, type, payload, note}).
 * window.BrickMock exposes the mock state for tests.
 */
(function (global) {
  'use strict';

  var Brick = global.Brick;
  if (!Brick || Brick.isNative) return;

  var P = Brick.params;
  function num(name, def) {
    var v = P.get(name);
    if (v == null || v === '') return def;
    var n = Number(v);
    return isFinite(n) ? n : def;
  }
  function str(name, def) { var v = P.get(name); return v == null ? def : v; }
  function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
  function emit(type, payload, delay) { Brick.mock.emit(type, payload, delay || 0); }

  var log = [];
  global.__mockLog = log;
  function note(type, payload, msg) {
    log.push({ t: Date.now(), type: type, payload: payload, note: msg || '' });
    if (msg) console.info('[mock] ' + type + ': ' + msg);
  }

  // ───────────────────────────── session & settings ─────────────────────────────
  var role = str('role', 'primary') === 'secondary' ? 'secondary' : 'primary';
  var displayIndex = Math.max(0, Math.floor(num('display', role === 'primary' ? 0 : 1)));
  var displayCount = Math.max(displayIndex + 1, Math.floor(num('displayCount', role === 'secondary' ? 2 : 1)));
  var minutes = Math.max(0.05, num('minutes', 50));
  var elapsed = clamp(num('elapsed', 7), 0, minutes);
  var PIN = String(str('pin', '1234')).replace(/\D/g, '').slice(0, 8);
  if (PIN.length < 4) PIN = '1234';
  var peekSeconds = Math.max(1, num('peekSeconds', 90));
  var confirmDelaySec = Math.max(0, num('confirmDelay', 3));
  var unlockTimeoutMs = Math.max(1, num('unlockTimeout', 60)) * 1000;
  var audioOn = P.get('audio') === '1';

  var t0 = Date.now();
  var startedAt = t0 - Math.round(elapsed * 60000);
  var durationMs = Math.round(minutes * 60000);
  var session = {
    id: 'MOCK-' + t0.toString(16).toUpperCase(),
    startedAt: startedAt,
    endsAt: startedAt + durationMs,
    durationMs: durationMs,
    intention: str('intention', 'Chapter 3 outline'),
    mode: str('mode', 'aurora')
  };

  var quickPlaylists = [
    { name: 'Deep Focus', uri: 'spotify:playlist:37i9dQZF1DWZeKCadgRdKQ' },
    { name: 'Peaceful Piano', uri: 'spotify:playlist:37i9dQZF1DX4sWSpwq3LiO' },
    { name: 'Rain on the Window', uri: 'spotify:playlist:mock-rain-window' },
    { name: 'Lo-fi for Notebooks', uri: 'spotify:playlist:mock-lofi-notebooks' }
  ];

  var settings = {
    quality: str('quality', 'balanced'),
    showTimerOnSecondary: P.get('showTimer') !== '0',
    confirmDelaySec: confirmDelaySec,
    peekSeconds: peekSeconds,
    quickPlaylists: quickPlaylists,
    breathPattern: str('breath', 'box')
  };

  function sampleImages(n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var c = document.createElement('canvas'); c.width = 1600; c.height = 1000;
      var g = c.getContext('2d');
      var hue = (i * 53 + 200) % 360;
      var grad = g.createLinearGradient(0, 0, 0, c.height);
      grad.addColorStop(0, 'hsl(' + hue + ',38%,64%)');
      grad.addColorStop(0.55, 'hsl(' + ((hue + 28) % 360) + ',42%,40%)');
      grad.addColorStop(1, 'hsl(' + ((hue + 56) % 360) + ',32%,15%)');
      g.fillStyle = grad; g.fillRect(0, 0, c.width, c.height);
      for (var k = 0; k < 4; k++) {
        g.fillStyle = 'hsla(' + ((hue + 200) % 360) + ',22%,' + (12 + k * 6) + '%,0.9)';
        g.beginPath(); g.moveTo(0, c.height);
        for (var x = 0; x <= c.width; x += 40) g.lineTo(x, c.height * (0.55 + k * 0.1) - 110 * Math.sin(x * 0.004 + i + k * 1.7) - 50 * Math.sin(x * 0.011 + k));
        g.lineTo(c.width, c.height); g.fill();
      }
      out.push(c.toDataURL('image/jpeg', 0.85));
    }
    return out;
  }

  // ───────────────────────────── Spotify ─────────────────────────────
  var TRACKS = [
    { id: 'spotify:track:mock-weightless', name: 'Weightless', artist: 'Marconi Union', album: 'Weightless', durationMs: 480000 },
    { id: 'spotify:track:mock-low-tide', name: 'Low Tide Letters', artist: 'Harbour Lights', album: 'Salt & Paper', durationMs: 214000 },
    { id: 'spotify:track:mock-lanterns', name: 'Paper Lanterns', artist: 'Juniper Fields', album: 'Evening Hours', durationMs: 263000 },
    { id: 'spotify:track:mock-orbit', name: 'Slow Orbit', artist: 'Northwind Ensemble', album: 'Night Study', durationMs: 307000 },
    { id: 'spotify:track:mock-quiet-room', name: 'A Quiet Room, Raining Softly Against the Glass', artist: 'The Elsewhere String Quartet', album: 'Interiors', durationMs: 356000 }
  ];

  // Same hash/hue as BrickUtil.placeholderArt, so the palette matches the generated art.
  function seedHue(seed) {
    var h = 0;
    for (var i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return h % 360;
  }
  function hslHex(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360; s /= 100; l /= 100;
    function f(n) {
      var k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
      var v = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
      var x = Math.round(v * 255).toString(16);
      return x.length === 1 ? '0' + x : x;
    }
    return '#' + f(0) + f(8) + f(4);
  }
  function paletteFor(track) {
    var hue = seedHue(track.id);
    return [hslHex(hue, 45, 30), hslHex(hue + 70, 55, 14), hslHex(hue + 30, 70, 62), hslHex(hue + 15, 35, 46)];
  }
  var artCache = {};
  function artFor(track) {
    if (!artCache[track.id]) artCache[track.id] = global.BrickUtil ? global.BrickUtil.placeholderArt(track.id, 300) : null;
    return artCache[track.id];
  }

  var sp = {
    installed: true, running: true, permission: 'granted', state: 'playing', track: null,
    positionMs: 0, positionAt: t0, volume: 64, shuffling: false, repeating: false
  };
  var trackIndex = 0;

  function loadTrack(i) {
    trackIndex = ((i % TRACKS.length) + TRACKS.length) % TRACKS.length;
    var t = TRACKS[trackIndex];
    sp.track = { id: t.id, name: t.name, artist: t.artist, album: t.album, durationMs: t.durationMs, artworkUrl: 'https://i.scdn.co/image/' + t.id.split(':').pop() };
    sp.positionMs = 0;
    sp.positionAt = Date.now();
  }

  switch (str('spotify', 'playing')) {
    case 'paused': loadTrack(0); sp.state = 'paused'; sp.positionMs = 61000; break;
    case 'off': sp.running = false; sp.state = 'stopped'; break;
    case 'notinstalled': sp.installed = false; sp.running = false; sp.state = 'stopped'; sp.permission = 'unknown'; break;
    case 'denied': sp.permission = 'denied'; sp.state = 'stopped'; break;
    case 'undetermined': sp.permission = 'undetermined'; sp.state = 'stopped'; break;
    case 'empty': sp.state = 'stopped'; break;
    default: loadTrack(0); sp.state = 'playing'; sp.positionMs = 61000; sp.positionAt = t0; break;
  }

  function controllable() { return sp.installed && sp.running && sp.permission === 'granted'; }
  function position() {
    if (!sp.track) return 0;
    var p = sp.positionMs + (sp.state === 'playing' ? Date.now() - sp.positionAt : 0);
    return clamp(p, 0, sp.track.durationMs);
  }
  function snapshot() {
    sp.positionMs = Math.round(position());
    sp.positionAt = Date.now();
    var s = JSON.parse(JSON.stringify(sp));
    if (!sp.installed || !sp.running || sp.permission !== 'granted') {
      // Native can't read player state without a running Spotify + Automation permission.
      s.state = 'stopped'; s.track = null; s.positionMs = 0;
    }
    return s;
  }
  function sendSpotify(delay) { emit('spotify', snapshot(), delay); }
  function sendArtwork(delay) {
    if (!sp.track || !controllable()) return;
    var t = sp.track;
    emit('artwork', { trackId: t.id, dataUrl: artFor(t), palette: paletteFor(t) }, delay);
  }
  function sendAudioStatus(delay) {
    var reason = !sp.running ? 'spotify-not-running' : audioOn ? 'ok' : 'permission';
    emit('audioStatus', { available: audioOn && sp.running, reason: reason }, delay);
  }

  function setPlaying(on) {
    if (!sp.track) { if (!on) return; loadTrack(0); }
    sp.positionMs = position();
    sp.positionAt = Date.now();
    sp.state = on ? 'playing' : 'paused';
  }

  // Heartbeat: re-send while playing (~2 s), advance at the end of a track.
  setInterval(function () {
    if (!controllable() || !sp.track || sp.state !== 'playing') return;
    if (position() >= sp.track.durationMs - 50) {
      loadTrack(sp.repeating ? trackIndex : trackIndex + 1);
      sendSpotify(); sendArtwork(80);
    } else {
      sendSpotify();
    }
  }, 2000);

  // Synthetic analysis frames (~30 Hz) while playing.
  var lastBeat = -1;
  function audioFrame(t) {
    var bpm = 92, ph = t / (60 / bpm), bi = Math.floor(ph), bp = ph - bi;
    var kick = Math.exp(-bp * 6.5);
    var snare = (bi % 2 === 1) ? Math.exp(-bp * 8) : 0;
    var hat = Math.exp(-(((ph + 0.5) % 1)) * 16);
    var bands = [];
    for (var i = 0; i < 32; i++) {
      var f = i / 31;
      var v = 0.3 + 0.16 * Math.sin(t * 0.7 + i * 0.45) * Math.sin(t * 0.23 + i * 0.11) + 0.08 * Math.sin(t * 2.1 + i);
      if (f < 0.2) v += kick * (1 - f * 4) * 0.7;
      if (f > 0.3 && f < 0.6) v += snare * 0.35;
      if (f > 0.7) v += hat * 0.35 * (f - 0.6);
      bands.push(clamp(v * (1 - f * 0.45), 0, 1));
    }
    var bass = clamp(0.25 + kick * 0.65, 0, 1), mid = clamp(0.3 + snare * 0.4, 0, 1), treble = clamp(0.15 + hat * 0.5, 0, 1);
    var beat = bi !== lastBeat; lastBeat = bi;
    return { bands: bands, level: clamp((bass + mid + treble) / 3 + 0.08, 0, 1), bass: bass, mid: mid, treble: treble, beat: beat };
  }
  if (audioOn) {
    setInterval(function () {
      if (!controllable() || sp.state !== 'playing') return;
      Brick._receive({ type: 'audio', payload: audioFrame((Date.now() - t0) / 1000) });
    }, 33);
  }

  Brick.mock.handle('spotify.command', function (p) {
    p = p || {};
    if (!controllable()) { note('spotify.command', p, 'ignored: Spotify not controllable'); return; }
    note('spotify.command', p);
    var before = sp.track && sp.track.id;
    switch (p.action) {
      case 'playpause': setPlaying(sp.state !== 'playing'); break;
      case 'play': setPlaying(true); break;
      case 'pause': setPlaying(false); break;
      case 'next':
        if (sp.track) { loadTrack(trackIndex + 1); sp.state = 'playing'; }
        break;
      case 'previous':
        if (!sp.track) break;
        if (position() > 3000) { sp.positionMs = 0; sp.positionAt = Date.now(); }
        else { loadTrack(trackIndex - 1); }
        sp.state = 'playing';
        break;
      case 'volume': sp.volume = clamp(Math.round(+p.value || 0), 0, 100); break;
      case 'shuffle': sp.shuffling = !!p.value; break;
      case 'repeat': sp.repeating = !!p.value; break;
      case 'seek':
        if (sp.track) { sp.positionMs = clamp(+p.value || 0, 0, sp.track.durationMs); sp.positionAt = Date.now(); }
        break;
      case 'playUri':
        var u = String(p.value || '');
        var idx = u ? seedHue(u) % TRACKS.length : 0;
        loadTrack(idx); sp.state = 'playing';
        break;
      default: note('spotify.command', p, 'unknown action'); return;
    }
    sendSpotify(70);
    if ((sp.track && sp.track.id) !== before) sendArtwork(160);
  });

  Brick.mock.handle('spotify.launch', function (p) {
    note('spotify.launch', p);
    if (!sp.installed || sp.running) { sendSpotify(); return; }
    setTimeout(function () {
      sp.running = true;
      if (sp.permission === 'granted') { loadTrack(0); sp.state = 'paused'; }
      sendSpotify(); sendArtwork(120); sendAudioStatus(150);
    }, 1100);
  });

  // ───────────────────────────── peek ─────────────────────────────
  var peekTimer = null;
  function startPeek() {
    clearTimeout(peekTimer);
    var endsAt = Date.now() + peekSeconds * 1000;
    emit('peek', { active: true, endsAt: endsAt });
    peekTimer = setTimeout(endPeek, peekSeconds * 1000);
  }
  function endPeek() {
    clearTimeout(peekTimer); peekTimer = null;
    emit('peek', { active: false, endsAt: null });
  }
  Brick.mock.handle('spotify.peek', function (p) {
    if (!sp.installed) { note('spotify.peek', p, 'ignored: not installed'); return; }
    note('spotify.peek', p);
    if (!sp.running) { sp.running = true; sendSpotify(300); }
    startPeek();
  });
  Brick.mock.handle('peek.end', function (p) { note('peek.end', p); endPeek(); });

  // ───────────────────────────── mode ─────────────────────────────
  Brick.mock.handle('mode.set', function (p) {
    note('mode.set', p);
    if (p && p.mode) { session.mode = p.mode; emit('mode', { mode: p.mode }); }
  });

  // ───────────────────────────── unlock state machine ─────────────────────────────
  var TOTAL = 3, MAX_WRONG = 5, COOLDOWN_BASE = num('cooldown', 60) * 1000, COOLDOWN_MAX = 15 * 60000;
  var U = {
    stage: 'idle', step: 1, totalSteps: TOTAL, error: null, wrongAttempts: 0,
    cooldownUntil: null, confirmDelayMs: Math.round(confirmDelaySec * 1000), pinLength: PIN.length
  };
  var confirmEnteredAt = 0, cooldowns = 0, idleTimer = null, cooldownTimer = null, ended = false;

  function sendUnlock(delay) { emit('unlock', JSON.parse(JSON.stringify(U)), delay); }
  function armInactivity() {
    clearTimeout(idleTimer);
    if (U.stage === 'pin' || U.stage === 'confirm') {
      idleTimer = setTimeout(function () {
        note('unlock', null, '60 s without interaction → idle');
        toIdle(); sendUnlock();
      }, unlockTimeoutMs);
    }
  }
  function toIdle() { U.stage = 'idle'; U.step = 1; U.error = null; U.cooldownUntil = null; armInactivity(); }
  function toCooldown(ms) {
    U.stage = 'cooldown'; U.step = 1; U.error = null;
    U.cooldownUntil = Date.now() + ms;
    clearTimeout(cooldownTimer);
    cooldownTimer = setTimeout(function () { U.wrongAttempts = 0; toIdle(); sendUnlock(); }, ms);
    armInactivity();
  }

  Brick.mock.handle('unlock.begin', function (p) {
    note('unlock.begin', p);
    if (ended) return;
    if (U.stage === 'idle') { U.stage = 'pin'; U.step = 1; U.error = null; }
    armInactivity();
    sendUnlock(40);
  });

  Brick.mock.handle('unlock.submit', function (p) {
    var pin = String((p && p.pin) || '');
    if (U.stage !== 'pin') { note('unlock.submit', { pin: '•'.repeat(pin.length) }, 'ignored: stage is ' + U.stage); return; }
    if (pin === PIN) {
      note('unlock.submit', { pin: '•'.repeat(pin.length) }, 'correct PIN (step ' + U.step + ')');
      U.stage = 'confirm'; U.error = null; U.wrongAttempts = 0;
      confirmEnteredAt = Date.now();
    } else {
      U.wrongAttempts++;
      note('unlock.submit', { pin: '•'.repeat(pin.length) }, 'wrong PIN (' + U.wrongAttempts + ' in a row)');
      if (U.wrongAttempts >= MAX_WRONG) {
        var ms = Math.min(COOLDOWN_MAX, COOLDOWN_BASE * Math.pow(2, cooldowns));
        cooldowns++;
        toCooldown(ms);
      } else {
        U.error = 'wrong-pin';
      }
    }
    armInactivity();
    sendUnlock(220); // a beat of latency, like hashing on the native side
  });

  Brick.mock.handle('unlock.confirm', function (p) {
    if (U.stage !== 'confirm') { note('unlock.confirm', p, 'ignored: stage is ' + U.stage); return; }
    var waited = Date.now() - confirmEnteredAt;
    if (waited < U.confirmDelayMs) {
      note('unlock.confirm', p, 'REFUSED: only ' + waited + ' ms of ' + U.confirmDelayMs + ' ms elapsed');
      return;
    }
    note('unlock.confirm', p, 'accepted (step ' + U.step + ')');
    if (U.step < U.totalSteps) {
      U.step++; U.stage = 'pin'; U.error = null;
      armInactivity();
      sendUnlock(40);
    } else {
      U.stage = 'unlocked'; U.error = null;
      clearTimeout(idleTimer);
      sendUnlock(40);
      finish('unlocked', 1100);
    }
  });

  Brick.mock.handle('unlock.cancel', function (p) {
    note('unlock.cancel', p);
    if (U.stage === 'pin' || U.stage === 'confirm') { toIdle(); sendUnlock(30); }
  });

  Brick.mock.handle('unlock.activity', function (p) {
    log.push({ t: Date.now(), type: 'unlock.activity', payload: p, note: '' });
    armInactivity();
  });

  Brick.mock.handle('log', function (p) {
    p = p || {};
    (console[p.level] || console.log)('[native log]', p.message);
  });

  // ───────────────────────────── ending ─────────────────────────────
  var endTimer = null;
  function finish(reason, delay) {
    if (ended) return;
    ended = true;
    clearTimeout(endTimer); clearTimeout(idleTimer); clearTimeout(cooldownTimer);
    endPeekSilently();
    var focused = Math.min(durationMs, Math.max(0, Date.now() - startedAt));
    var payload = { reason: reason, focusedMs: reason === 'completed' ? durationMs : focused, durationMs: durationMs };
    note('ending', payload, 'session ' + reason);
    emit('ending', payload, delay || 0);
  }
  function endPeekSilently() { if (peekTimer) endPeek(); }

  // ───────────────────────────── ready → init ─────────────────────────────
  Brick.mock.handle('ready', function () {
    note('ready', null, 'page ready → init');
    var now = Date.now();
    emit('init', {
      page: 'lock',
      role: role,
      displayIndex: displayIndex,
      displayCount: displayCount,
      session: JSON.parse(JSON.stringify(session)),
      settings: JSON.parse(JSON.stringify(settings)),
      gallery: { images: P.get('images') ? sampleImages(Math.max(1, num('images', 4))) : [] }
    });
    sendSpotify(10);
    sendArtwork(20);
    sendAudioStatus(25);

    var jump = P.get('stage');
    if (jump === 'pin' || jump === 'confirm') {
      U.stage = jump;
      U.step = clamp(Math.floor(num('step', 1)), 1, TOTAL);
      if (jump === 'pin' && P.get('error') === '1') {
        U.error = 'wrong-pin';
        U.wrongAttempts = clamp(Math.floor(num('wrong', 2)), 1, MAX_WRONG - 1);
      }
      if (jump === 'confirm') confirmEnteredAt = now;
      armInactivity();
    } else if (jump === 'cooldown') {
      U.wrongAttempts = MAX_WRONG; cooldowns = 1;
      toCooldown(COOLDOWN_BASE);
    } else if (jump === 'unlocked') {
      U.stage = 'unlocked'; U.step = TOTAL;
    }
    sendUnlock(30);

    if (P.get('peek') === '1') setTimeout(startPeek, 40);

    var endParam = P.get('ending');
    if (endParam === 'completed' || endParam === 'unlocked') {
      setTimeout(function () { finish(endParam, 0); }, 1000);
    } else {
      clearTimeout(endTimer);
      endTimer = setTimeout(function () { finish('completed', 0); }, Math.max(0, session.endsAt - Date.now()));
    }
  });

  global.BrickMock = {
    get unlock() { return JSON.parse(JSON.stringify(U)); },
    get spotify() { return snapshot(); },
    session: session,
    settings: settings,
    pin: PIN,
    log: log,
    finish: finish
  };
})(window);
