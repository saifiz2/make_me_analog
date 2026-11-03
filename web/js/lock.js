/*
 * Analog Brick — lock screen controller (lock.html).
 * Plain script. One instance runs on every display during a session.
 *
 * Everything is driven by bridge events (docs/BRIDGE.md):
 *   init, spotify, artwork, audio, audioStatus, unlock, mode, peek, ending.
 * The unlock flow is owned by native: this page renders the 'unlock' state it is sent and never
 * advances it locally (the only local action is closing the cooldown card).
 */
(function (global) {
  'use strict';

  var Brick = global.Brick;
  var U = global.BrickUtil;
  var BV = global.BrickVisuals;
  var P = Brick.params;
  var doc = document;
  var body = doc.body;
  var root = doc.documentElement;

  function $(id) { return doc.getElementById(id); }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function fmtTime(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(s / 60);
    s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ───────────────────────────── icons ─────────────────────────────
  // Hand-drawn on a 24px grid; 1.6px round strokes. Paths with class "f" are also filled.
  var ICONS = {
    play: '<path class="f" d="M8.6 6.3v11.4c0 .64.7 1.03 1.24.69l9.1-5.7a.82.82 0 0 0 0-1.38l-9.1-5.7c-.54-.34-1.24.05-1.24.69z"/>',
    pause: '<rect class="f" x="7.2" y="5.8" width="2.9" height="12.4" rx="1"/><rect class="f" x="13.9" y="5.8" width="2.9" height="12.4" rx="1"/>',
    next: '<path class="f" d="M5.8 7.2v9.6c0 .6.66.96 1.16.64l7.3-4.8a.77.77 0 0 0 0-1.28l-7.3-4.8c-.5-.32-1.16.04-1.16.64z"/><path d="M18 6.6v10.8"/>',
    prev: '<path class="f" d="M18.2 7.2v9.6c0 .6-.66.96-1.16.64l-7.3-4.8a.77.77 0 0 1 0-1.28l7.3-4.8c.5-.32 1.16.04 1.16.64z"/><path d="M6 6.6v10.8"/>',
    shuffle: '<path d="M3.5 17h2.4c1.5 0 2.6-.7 3.4-1.9l4.6-6.9c.8-1.2 2-1.9 3.4-1.9h2.8"/><path d="M17.8 4l2.5 2.3-2.5 2.3"/><path d="M3.5 7h2.4c1.5 0 2.6.7 3.4 1.9l.6.9"/><path d="M13.8 14.3l.6.8c.8 1.2 2 1.9 3.4 1.9h2.5"/><path d="M17.8 14.7l2.5 2.3-2.5 2.3"/>',
    volume: '<path d="M4.5 10v4c0 .4.3.7.7.7h2.6l3.8 3.2c.4.4 1.1.1 1.1-.5V6.6c0-.6-.7-.9-1.1-.5L7.8 9.3H5.2c-.4 0-.7.3-.7.7z"/><path d="M15.6 9.4a3.7 3.7 0 0 1 0 5.2"/><path d="M18.2 6.8a7.4 7.4 0 0 1 0 10.4"/>',
    volumeLow: '<path d="M4.5 10v4c0 .4.3.7.7.7h2.6l3.8 3.2c.4.4 1.1.1 1.1-.5V6.6c0-.6-.7-.9-1.1-.5L7.8 9.3H5.2c-.4 0-.7.3-.7.7z"/><path d="M15.6 9.4a3.7 3.7 0 0 1 0 5.2"/>',
    volumeMute: '<path d="M4.5 10v4c0 .4.3.7.7.7h2.6l3.8 3.2c.4.4 1.1.1 1.1-.5V6.6c0-.6-.7-.9-1.1-.5L7.8 9.3H5.2c-.4 0-.7.3-.7.7z"/><path d="M15.8 10l4 4M19.8 10l-4 4"/>',
    list: '<path d="M4 6.5h11M4 11h11M4 15.5h6.5"/><path d="M18.6 17.2V8.6l2.4-.9"/><circle cx="16.5" cy="17.2" r="2.1"/>',
    external: '<path d="M13.5 4.8h5.7v5.7"/><path d="M19.2 4.8l-7.7 7.7"/><path d="M17.2 13.6v4.1a1.6 1.6 0 0 1-1.6 1.6H6.3a1.6 1.6 0 0 1-1.6-1.6V8.4a1.6 1.6 0 0 1 1.6-1.6h4.1"/>',
    lock: '<rect x="5.2" y="10.6" width="13.6" height="9.4" rx="2.2"/><path d="M8.3 10.6V8.1a3.7 3.7 0 0 1 7.4 0v2.5"/><path d="M12 14.4v1.8"/>',
    unlock: '<rect x="5.2" y="10.6" width="13.6" height="9.4" rx="2.2"/><path d="M8.3 10.6V8.1a3.7 3.7 0 0 1 7.1-1.5"/><path d="M12 14.4v1.8"/>',
    backspace: '<path d="M9.3 5.8h9.2a2 2 0 0 1 2 2v8.4a2 2 0 0 1-2 2H9.3a2 2 0 0 1-1.55-.74L3.8 12l3.95-5.46a2 2 0 0 1 1.55-.74z"/><path d="M12.3 9.6l4.8 4.8M17.1 9.6l-4.8 4.8"/>',
    note: '<path d="M9 17.4V7l10-2.3v10.2"/><circle cx="6.8" cy="17.4" r="2.2"/><circle cx="16.8" cy="14.9" r="2.2"/>',
    power: '<path d="M12 4.2v7.2"/><path d="M7.3 7.1a6.9 6.9 0 1 0 9.4 0"/>',
    shield: '<path d="M12 3.8l6.8 2.6v5.2c0 4.1-2.8 7.3-6.8 8.7-4-1.4-6.8-4.6-6.8-8.7V6.4z"/><path d="M12 8.6v3.8"/><path d="M12 15.4v.1"/>',
    playSmall: '<path class="f" d="M9 7.3v9.4c0 .55.6.88 1.06.59l7.4-4.7a.7.7 0 0 0 0-1.18l-7.4-4.7C9.6 6.42 9 6.75 9 7.3z"/>',
    check: '<path d="M5.5 12.5l4.2 4.2 8.8-9.2"/>',
    // visual modes
    aurora: '<path d="M3.5 19.5h17"/><path d="M5.2 16.2c1.6-5.4 4.6-9.3 10.3-11"/><path d="M9.3 16.2c1.2-3.9 3.5-6.8 8-8.2"/><path d="M13.4 16.2c.9-2.3 2.6-4 5.3-5"/>',
    drift: '<path d="M3.5 8.2c2.9-2.4 5.6 2.4 8.5 0s5.6-2.4 8.5 0"/><path d="M3.5 12.2c2.9-2.4 5.6 2.4 8.5 0s5.6-2.4 8.5 0"/><path d="M3.5 16.2c2.9-2.4 5.6 2.4 8.5 0s5.6-2.4 8.5 0"/>',
    breath: '<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="8" stroke-dasharray="0.01 3.14"/>',
    horizon: '<path d="M3.5 18.8h17"/><path d="M3.8 15.6l4.6-5.1 3.1 3.3 2.3-2.4 5.9 4.2"/><circle cx="16.3" cy="7" r="1.9"/>',
    night: '<path d="M18.8 14.6A7.2 7.2 0 0 1 9.4 5.2a7.2 7.2 0 1 0 9.4 9.4z"/><path d="M17.2 4.2v2.6M15.9 5.5h2.6"/>',
    pulse: '<path d="M3 12h3.3l2.1-4.6 3.3 10 3-7.6 1.8 2.2H21"/>',
    gallery: '<rect x="3.6" y="5.2" width="16.8" height="13.6" rx="2.2"/><path d="M3.8 16l4.4-4.2a1.4 1.4 0 0 1 1.95 0L15 16.6"/><path d="M13.2 14.8l1.9-1.8a1.4 1.4 0 0 1 1.95 0l3.2 3"/><circle cx="15.6" cy="9.6" r="1.4"/>',
    dot: '<circle cx="12" cy="12" r="5.5"/>'
  };
  function iconSvg(name) {
    return '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + (ICONS[name] || ICONS.dot) + '</svg>';
  }
  function setIcon(node, name) {
    if (!node || node.getAttribute('data-icon-set') === name) return;
    node.setAttribute('data-icon-set', name);
    node.innerHTML = iconSvg(name);
  }
  function hydrateIcons(scope) {
    var nodes = (scope || doc).querySelectorAll('[data-icon]');
    for (var i = 0; i < nodes.length; i++) setIcon(nodes[i], nodes[i].getAttribute('data-icon'));
  }

  // ───────────────────────────── state ─────────────────────────────
  var UNLOCK_DEFAULTS = {
    stage: 'idle', step: 1, totalSteps: 3, error: null, wrongAttempts: 0,
    cooldownUntil: null, confirmDelayMs: 3000, pinLength: 4
  };

  var S = {
    role: P.get('role') === 'secondary' ? 'secondary' : 'primary',
    displayIndex: Math.max(0, parseInt(P.get('display'), 10) || 0),
    ready: false,
    session: null,
    settings: {
      quality: P.get('quality') || 'balanced', showTimerOnSecondary: true, confirmDelaySec: 3,
      peekSeconds: 90, quickPlaylists: [], breathPattern: 'box'
    },
    images: [],
    mode: null,
    spotify: null,
    view: 'loading',
    art: { trackId: null, src: null },
    artPendingTimer: null,
    volumeHoldUntil: 0,
    lastVolume: 60,
    launching: false,
    unlock: Object.assign({}, UNLOCK_DEFAULTS),
    modalOpen: false,
    cooldownDismissed: null,
    unlockRequested: false,
    entry: '',
    pinPending: false,
    pinPendingTimer: null,
    confirmStartedAt: 0,
    confirmKey: '',
    confirmTimer: null,
    peek: { active: false, endsAt: null },
    ending: null,
    idle: false,
    timeUp: false
  };

  // ───────────────────────────── DOM ─────────────────────────────
  var $stage = $('stage'), $clock = $('clock'), $intention = $('intention');
  var $remainingLabel = $('remainingLabel'), $endsLabel = $('endsLabel'), $sessionFill = $('sessionFill');
  var $player = $('player'), $art = $('art'), $trackTitle = $('trackTitle'), $trackArtist = $('trackArtist');
  var $trackFill = $('trackFill'), $trackKnob = $('trackKnob'), $tPos = $('tPos'), $tDur = $('tDur'), $seekBar = $('seekBar');
  var $playBtn = $('playBtn'), $prevBtn = $('prevBtn'), $nextBtn = $('nextBtn'), $shuffleBtn = $('shuffleBtn');
  var $muteBtn = $('muteBtn'), $volume = $('volume');
  var $playlistsBtn = $('playlistsBtn'), $pop = $('playlistsPop'), $popList = $('popList'), $emptyList = $('emptyList');
  var $msgIcon = $('msgIcon'), $msgTitle = $('msgTitle'), $msgBody = $('msgBody'), $msgAction = $('msgAction');
  var $peekBtn = $('peekBtn'), $peekHint = $('peekHint');
  var $modes = $('modes'), $unlockBtn = $('unlockBtn'), $unlockLabel = $('unlockLabel');
  var $miniTimer = $('miniTimer'), $toast = $('toast');
  var $peek = $('peek'), $peekText = $('peekText'), $peekReturn = $('peekReturn');
  var $modal = $('modal'), $card = $('modalCard'), $steps = $('steps'), $stepsLabel = $('stepsLabel');
  var $slots = $('slots'), $pinErr = $('pinErr'), $pinHint = $('pinHint'), $keypad = $('keypad');
  var $confirmTitle = $('confirmTitle'), $confirmBody = $('confirmBody'), $keepBtn = $('keepBtn'), $sureBtn = $('sureBtn'), $sureFill = $('sureFill');
  var $cooldownLeft = $('cooldownLeft'), $backBtn = $('backBtn');
  var $ending = $('ending'), $endingTitle = $('endingTitle'), $endingSub = $('endingSub'), $fade = $('fadeBlack');

  hydrateIcons();

  function applyRole() {
    body.classList.toggle('role-primary', S.role === 'primary');
    body.classList.toggle('role-secondary', S.role === 'secondary');
    body.classList.toggle('show-mini', S.role === 'secondary' && S.settings.showTimerOnSecondary !== false);
  }
  applyRole();

  // ───────────────────────────── stage ─────────────────────────────
  var stage = null, stageSeed = null;

  function stageOptions() {
    return { breathPattern: S.settings.breathPattern || 'box', images: S.images || [] };
  }

  function mountStage(mode, transition) {
    if (!BV) return;
    var seed = S.displayIndex + 1;
    if (stage && stageSeed !== seed) { stage.destroy(); stage = null; }
    if (!stage) {
      stage = BV.mount($stage, {
        quality: S.settings.quality, seed: seed, displayIndex: S.displayIndex, options: stageOptions()
      });
      stageSeed = seed;
      global.__stage = stage;
      if (S.spotify) stage.setPlaying(S.spotify.state === 'playing');
    } else {
      stage.setQuality(S.settings.quality);
      stage.setOptions(stageOptions());
    }
    if (mode) stage.setMode(mode, { transition: transition });
  }

  // Until 'init' arrives the page is black; if it never does, fade in the core fallback visual.
  var preInitTimer = setTimeout(function () {
    if (S.ready) return;
    var m = P.get('mode');
    mountStage(m && BV && BV.has(m) ? m : '__fallback', 2400);
  }, 1500);

  // ───────────────────────────── countdown ─────────────────────────────
  var lastClock = '', lastSessionTf = '';
  function updateCountdown(now) {
    var s = S.session;
    if (!s) return;
    var remaining = Math.max(0, s.endsAt - now);
    var txt = U.formatCountdown(remaining);
    if (txt !== lastClock) {
      lastClock = txt;
      $clock.textContent = txt;
      $miniTimer.textContent = txt;
      $clock.classList.toggle('is-long', txt.length > 5);
    }
    var dur = s.durationMs || (s.endsAt - s.startedAt) || 1;
    var tf = 'scaleX(' + clamp((now - s.startedAt) / dur, 0, 1).toFixed(4) + ')';
    if (tf !== lastSessionTf) { lastSessionTf = tf; $sessionFill.style.transform = tf; }
    if (remaining <= 0 && !S.timeUp) {
      // Never end locally: show 00:00 and wait for native's 'ending'.
      S.timeUp = true;
      $remainingLabel.textContent = 'time’s up';
      body.classList.add('is-timeup');
    }
  }

  function renderSessionMeta() {
    var s = S.session;
    if (!s) return;
    var intent = (s.intention || '').trim();
    $intention.textContent = intent;
    $intention.hidden = !intent;
    $endsLabel.textContent = 'ends ' + U.formatClock(s.endsAt);
    if (!S.timeUp) $remainingLabel.textContent = 'remaining';
  }

  // ───────────────────────────── Spotify ─────────────────────────────
  function controllable(sp) {
    return !!(sp && sp.installed && sp.running && sp.permission !== 'denied' && sp.permission !== 'undetermined');
  }

  function spotifyView(sp) {
    if (!sp) return 'loading';
    if (!sp.installed) return 'notinstalled';
    if (!sp.running) return 'notrunning';
    if (sp.permission === 'denied' || sp.permission === 'undetermined') return 'noperm';
    if (!sp.track) return 'empty';
    return 'track';
  }

  function cmd(action, value) {
    var payload = { action: action };
    if (value !== undefined) payload.value = value;
    Brick.send('spotify.command', payload);
  }

  function trackPosition(now) {
    var sp = S.spotify;
    if (!sp || !sp.track) return 0;
    var pos = +sp.positionMs || 0;
    if (sp.state === 'playing' && sp.positionAt) pos += now - sp.positionAt;
    return clamp(pos, 0, sp.track.durationMs || 0);
  }

  var lastPosText = '', lastTrackTf = '';
  function updateTrackProgress(now) {
    var sp = S.spotify;
    if (!sp || !sp.track) return;
    var dur = sp.track.durationMs || 0;
    var pos = trackPosition(now);
    var f = dur > 0 ? pos / dur : 0;
    var tf = 'scaleX(' + f.toFixed(4) + ')';
    if (tf !== lastTrackTf) {
      lastTrackTf = tf;
      $trackFill.style.transform = tf;
      $trackKnob.style.left = (f * 100).toFixed(2) + '%';
    }
    var t = fmtTime(pos);
    if (t !== lastPosText) { lastPosText = t; $tPos.textContent = t; }
  }

  function setArt(src) {
    if ($art.getAttribute('src') === src) { $art.classList.add('is-loaded'); return; }
    $art.classList.remove('is-loaded');
    $art.onload = function () { $art.classList.add('is-loaded'); };
    $art.src = src;
  }

  function showArtFor(track) {
    clearTimeout(S.artPendingTimer);
    if (S.art.trackId === track.id) {
      setArt(S.art.src || U.placeholderArt(track.id || track.name || 'track', 240));
      return;
    }
    // Artwork usually follows the 'spotify' event within a moment; fall back to a placeholder.
    $art.classList.remove('is-loaded');
    S.artPendingTimer = setTimeout(function () {
      if (S.spotify && S.spotify.track && S.spotify.track.id === track.id && S.art.trackId !== track.id) {
        setArt(U.placeholderArt(track.id || track.name || 'track', 240));
      }
    }, 1200);
  }

  function volumeIcon(v) { return v <= 0 ? 'volumeMute' : v < 45 ? 'volumeLow' : 'volume'; }
  function paintVolume(v) {
    $volume.style.setProperty('--v', v + '%');
    setIcon($muteBtn.firstElementChild, volumeIcon(v));
    $muteBtn.setAttribute('aria-label', v <= 0 ? 'Unmute' : 'Mute');
  }

  function renderSpotify(prev) {
    var sp = S.spotify;
    var view = spotifyView(sp);
    S.view = view;
    $player.setAttribute('data-view', view);
    if (stage) stage.setPlaying(!!(sp && sp.state === 'playing' && controllable(sp)));

    var peekable = sp && sp.installed && (view === 'track' || view === 'empty' || (view === 'noperm' && sp.running));
    $player.classList.toggle('no-foot', !peekable);

    if (view === 'track') {
      var tr = sp.track;
      var changed = !prev || !prev.track || prev.track.id !== tr.id;
      $trackTitle.textContent = tr.name || 'Unknown track';
      $trackTitle.title = tr.name || '';
      $trackArtist.textContent = [tr.artist, tr.album].filter(Boolean)[0] || '';
      $trackArtist.title = [tr.artist, tr.album].filter(Boolean).join(' — ');
      $tDur.textContent = fmtTime(tr.durationMs || 0);
      if (changed) { showArtFor(tr); lastPosText = ''; }
      var playing = sp.state === 'playing';
      setIcon($playBtn.firstElementChild, playing ? 'pause' : 'play');
      $playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      $player.classList.toggle('is-playing', playing);
      $shuffleBtn.setAttribute('aria-pressed', sp.shuffling ? 'true' : 'false');
      if (Date.now() > S.volumeHoldUntil) {
        var v = clamp(Math.round(+sp.volume || 0), 0, 100);
        $volume.value = v;
        paintVolume(v);
      }
      updateTrackProgress(Date.now());
    } else if (view === 'empty') {
      renderPlaylistRows($emptyList, 4);
    } else if (view !== 'loading') {
      renderMessage(view, sp);
    }
    if (view !== 'track') closePopover();
    if (view === 'notrunning' && S.launching === false) $msgAction.disabled = false;
    if (sp && sp.running) S.launching = false;
  }

  function renderMessage(view, sp) {
    var icon = 'note', title = '', text = '', action = null;
    if (view === 'notinstalled') {
      icon = 'note'; title = 'Spotify isn’t installed';
      text = 'Music controls appear here when it is. Tonight it’s just you and the page.';
    } else if (view === 'notrunning') {
      icon = 'power'; title = 'Spotify isn’t running';
      text = 'Start it quietly in the background, then pick something to play.';
      action = S.launching ? 'Starting…' : 'Start Spotify';
    } else if (view === 'noperm') {
      icon = 'shield'; title = 'Spotify control is off';
      text = 'Allow Spotify control from the setup screen next time.' + (sp && sp.running ? ' You can still open the app below.' : '');
    }
    setIcon($msgIcon, icon);
    $msgTitle.textContent = title;
    $msgBody.textContent = text;
    $msgAction.hidden = !action;
    if (action) { $msgAction.textContent = action; $msgAction.disabled = !!S.launching; }
  }

  function renderPlaylistRows(list, max) {
    var items = (S.settings.quickPlaylists || []).filter(function (p) { return p && p.uri; });
    if (max) items = items.slice(0, max);
    list.textContent = '';
    if (!items.length) {
      list.appendChild(U.el('li', { class: 'pl-list-empty', text: 'No quick playlists yet. Add some in the setup screen, or open Spotify.' }));
      return;
    }
    items.forEach(function (p) {
      var btn = U.el('button', { class: 'pl-row', type: 'button', role: 'menuitem', title: p.name || p.uri });
      btn.innerHTML = '<span class="pl-row-icon">' + iconSvg('playSmall') + '</span>';
      btn.appendChild(U.el('span', { class: 'pl-row-name', text: p.name || p.uri }));
      btn.addEventListener('click', function () {
        cmd('playUri', p.uri);
        closePopover();
      });
      list.appendChild(U.el('li', null, btn));
    });
  }

  // Popover
  var popOpen = false;
  function openPopover() {
    if (popOpen) return;
    renderPlaylistRows($popList, 0);
    var r = $player.getBoundingClientRect();
    $pop.style.width = r.width + 'px';
    $pop.style.right = Math.round(global.innerWidth - r.right) + 'px';
    $pop.style.bottom = Math.round(global.innerHeight - r.top + 10) + 'px';
    $pop.classList.add('is-open');
    $playlistsBtn.setAttribute('aria-expanded', 'true');
    popOpen = true;
  }
  function closePopover() {
    if (!popOpen) return;
    $pop.classList.remove('is-open');
    $playlistsBtn.setAttribute('aria-expanded', 'false');
    popOpen = false;
  }

  // Controls
  $playBtn.addEventListener('click', function () { togglePlay(); });
  $prevBtn.addEventListener('click', function () { cmd('previous'); });
  $nextBtn.addEventListener('click', function () { cmd('next'); });
  $shuffleBtn.addEventListener('click', function () {
    var on = !(S.spotify && S.spotify.shuffling);
    if (S.spotify) S.spotify.shuffling = on;
    $shuffleBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    cmd('shuffle', on);
  });
  $playlistsBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (popOpen) closePopover(); else openPopover();
  });
  $peekBtn.addEventListener('click', function () { Brick.send('spotify.peek', {}); });
  $msgAction.addEventListener('click', function () {
    if (S.view === 'notrunning' && !S.launching) {
      S.launching = true;
      $msgAction.textContent = 'Starting…';
      $msgAction.disabled = true;
      Brick.send('spotify.launch', {});
      setTimeout(function () {
        if (S.launching) { S.launching = false; if (S.view === 'notrunning') renderMessage('notrunning', S.spotify); }
      }, 10000);
    }
  });

  function togglePlay() {
    var sp = S.spotify;
    if (!controllable(sp)) return;
    if (sp.track) {
      var now = Date.now();
      sp.positionMs = trackPosition(now);
      sp.positionAt = now;
      sp.state = sp.state === 'playing' ? 'paused' : 'playing';
      renderSpotify(sp);
    }
    cmd('playpause');
  }

  // Volume: throttle while dragging, hold off incoming updates for a moment.
  var volSendTimer = null, volLastSent = 0;
  function sendVolume(v, final) {
    var now = Date.now();
    clearTimeout(volSendTimer);
    if (final || now - volLastSent > 120) {
      volLastSent = now;
      cmd('volume', v);
    } else {
      volSendTimer = setTimeout(function () { volLastSent = Date.now(); cmd('volume', v); }, 120 - (now - volLastSent));
    }
  }
  $volume.addEventListener('input', function () {
    var v = +$volume.value;
    S.volumeHoldUntil = Date.now() + 1500;
    if (v > 0) S.lastVolume = v;
    paintVolume(v);
    sendVolume(v, false);
  });
  $volume.addEventListener('change', function () {
    S.volumeHoldUntil = Date.now() + 1500;
    sendVolume(+$volume.value, true);
    $volume.blur();
  });
  $muteBtn.addEventListener('click', function () {
    var v = +$volume.value;
    var next = v > 0 ? 0 : (S.lastVolume > 0 ? S.lastVolume : 50);
    if (v > 0) S.lastVolume = v;
    $volume.value = next;
    S.volumeHoldUntil = Date.now() + 1500;
    paintVolume(next);
    sendVolume(next, true);
  });

  // Seek by clicking/dragging the progress bar.
  var seeking = false;
  function seekFrac(e) {
    var r = $seekBar.getBoundingClientRect();
    return clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1);
  }
  function previewSeek(f) {
    lastTrackTf = '';
    $trackFill.style.transform = 'scaleX(' + f.toFixed(5) + ')';
    $trackKnob.style.left = (f * 100).toFixed(3) + '%';
    if (S.spotify && S.spotify.track) $tPos.textContent = fmtTime(f * S.spotify.track.durationMs);
  }
  $seekBar.addEventListener('pointerdown', function (e) {
    if (!S.spotify || !S.spotify.track) return;
    seeking = true;
    $player.classList.add('is-seeking');
    try { $seekBar.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    previewSeek(seekFrac(e));
  });
  $seekBar.addEventListener('pointermove', function (e) { if (seeking) previewSeek(seekFrac(e)); });
  function endSeek(e) {
    if (!seeking) return;
    seeking = false;
    $player.classList.remove('is-seeking');
    var sp = S.spotify;
    if (!sp || !sp.track) return;
    var ms = Math.round(seekFrac(e) * sp.track.durationMs);
    sp.positionMs = ms; sp.positionAt = Date.now();
    lastPosText = '';
    cmd('seek', ms);
  }
  $seekBar.addEventListener('pointerup', endSeek);
  $seekBar.addEventListener('pointercancel', function () { seeking = false; $player.classList.remove('is-seeking'); });

  // ───────────────────────────── modes ─────────────────────────────
  function buildModes() {
    $modes.textContent = '';
    var list = BV ? BV.list() : [];
    $modes.hidden = list.length < 2;
    list.forEach(function (def) {
      var btn = U.el('button', {
        class: 'mode-btn', type: 'button', 'data-mode': def.id, 'aria-label': def.name || def.id,
        'aria-pressed': 'false', 'data-tip': def.name || def.id
      });
      var ic = U.el('span', { class: 'mode-ico' });
      setIcon(ic, ICONS[def.id] ? def.id : 'dot');
      btn.appendChild(ic);
      btn.appendChild(U.el('span', { class: 'mode-label' }, U.el('span', { text: def.name || def.id })));
      btn.addEventListener('click', function () {
        if (S.mode === def.id) return;
        Brick.send('mode.set', { mode: def.id });
      });
      $modes.appendChild(btn);
    });
    markMode();
  }
  function markMode() {
    var btns = $modes.querySelectorAll('.mode-btn');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-mode') === S.mode;
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      btns[i].classList.toggle('is-active', on);
    }
  }

  var toastTimer = null;
  function showToast(mode) {
    var def = BV && BV.get(mode);
    $toast.textContent = '';
    var ic = U.el('span', { class: 'toast-ico' });
    setIcon(ic, ICONS[mode] ? mode : 'dot');
    $toast.appendChild(ic);
    $toast.appendChild(U.el('span', { class: 'toast-name', text: def ? def.name : mode }));
    if (def && def.tagline) $toast.appendChild(U.el('span', { class: 'toast-tag', text: def.tagline }));
    $toast.classList.remove('is-visible');
    void $toast.offsetWidth;
    $toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $toast.classList.remove('is-visible'); }, 2600);
  }

  // ───────────────────────────── unlock flow ─────────────────────────────
  var activityLast = 0;
  function unlockActivity() {
    var now = Date.now();
    if (now - activityLast < 1000) return;
    activityLast = now;
    Brick.send('unlock.activity', {});
  }

  function beginUnlock() {
    if (S.ending || S.role !== 'primary') return;
    closePopover();
    S.unlockRequested = true;
    var u = S.unlock;
    if (u.stage === 'cooldown' && u.cooldownUntil && u.cooldownUntil > Date.now()) {
      S.cooldownDismissed = null;
      openModal();
      renderUnlock(u, u);
    }
    Brick.send('unlock.begin', {});
  }

  function cancelUnlock() { Brick.send('unlock.cancel', {}); }

  function openModal() {
    if (S.modalOpen) return;
    S.modalOpen = true;
    $modal.classList.add('is-open');
    body.classList.add('has-modal');
    closePopover();
  }
  function closeModal() {
    if (!S.modalOpen) return;
    S.modalOpen = false;
    $modal.classList.remove('is-open');
    body.classList.remove('has-modal');
    clearTimeout(S.confirmTimer);
    clearTimeout(S.pinPendingTimer);
    S.pinPending = false;
    S.entry = '';
    if (doc.activeElement && $modal.contains(doc.activeElement)) doc.activeElement.blur();
  }

  function setStageView(stageName) {
    var prev = $modal.getAttribute('data-stage');
    if (prev === stageName) return;
    $modal.setAttribute('data-stage', stageName);
    var view = $modal.querySelector('.mv-' + stageName);
    if (view) {
      view.classList.remove('is-entering');
      void view.offsetWidth;
      view.classList.add('is-entering');
    }
  }

  function renderSteps(u) {
    var total = Math.max(1, u.totalSteps || 3);
    if ($steps.children.length !== total) {
      $steps.textContent = '';
      for (var i = 0; i < total; i++) $steps.appendChild(doc.createElement('i'));
    }
    for (var k = 0; k < total; k++) {
      var seg = $steps.children[k], n = k + 1;
      seg.className = n < u.step ? 'done' : n === u.step ? (u.stage === 'confirm' ? 'current half' : 'current') : '';
    }
    $stepsLabel.textContent = 'Step ' + Math.min(u.step, total) + ' of ' + total;
  }

  function renderSlots(errorFlash) {
    var n = Math.max(1, S.unlock.pinLength || 4);
    if ($slots.children.length !== n) {
      $slots.textContent = '';
      for (var i = 0; i < n; i++) $slots.appendChild(doc.createElement('i'));
    }
    for (var k = 0; k < n; k++) $slots.children[k].classList.toggle('on', k < S.entry.length || !!errorFlash);
  }

  function shakeSlots() {
    $slots.classList.remove('shake', 'is-error');
    void $slots.offsetWidth;
    $slots.classList.add('shake', 'is-error');
    renderSlots(true);
    setTimeout(function () {
      $slots.classList.remove('shake', 'is-error');
      renderSlots(false);
    }, 520);
  }

  function pinInput(d) {
    var u = S.unlock;
    if (u.stage !== 'pin' || S.pinPending) return;
    if (S.entry.length >= u.pinLength) return;
    if ($slots.classList.contains('is-error')) $slots.classList.remove('shake', 'is-error');
    S.entry += d;
    renderSlots(false);
    unlockActivity();
    if (S.entry.length >= u.pinLength) {
      S.pinPending = true;
      $modal.classList.add('is-checking');
      var pin = S.entry;
      setTimeout(function () {
        if (S.unlock.stage !== 'pin') return;
        Brick.send('unlock.submit', { pin: pin });
      }, 140);
      clearTimeout(S.pinPendingTimer);
      S.pinPendingTimer = setTimeout(function () {
        // Native always answers; this only unsticks the UI if a reply was lost.
        S.pinPending = false; S.entry = '';
        $modal.classList.remove('is-checking');
        renderSlots(false);
      }, 4000);
    }
  }

  function pinDelete() {
    if (S.unlock.stage !== 'pin' || S.pinPending || !S.entry) return;
    S.entry = S.entry.slice(0, -1);
    renderSlots(false);
    unlockActivity();
  }

  function flashKey(k) {
    var b = $keypad.querySelector('[data-key="' + k + '"]');
    if (!b) return;
    b.classList.add('is-pressed');
    setTimeout(function () { b.classList.remove('is-pressed'); }, 130);
  }

  function nudgeSlots() {
    $slots.classList.remove('nudge');
    void $slots.offsetWidth;
    $slots.classList.add('nudge');
  }

  var NBSP = '\u00a0';
  function mins(n) { return U.formatMinutesLong(n).replace(/ /g, NBSP); }

  function confirmCopy(step, u) {
    var now = Date.now(), s = S.session;
    var remainingMin = s ? Math.max(1, Math.ceil((s.endsAt - now) / 60000)) : 0;
    var durationMin = s ? Math.round((s.durationMs || (s.endsAt - s.startedAt)) / 60000) : 0;
    var focusedMin = s ? Math.max(0, Math.floor((now - s.startedAt) / 60000)) : 0;
    var last = step >= (u.totalSteps || 3);
    if (step <= 1 && !last) {
      return {
        title: 'Are you sure?',
        body: s ? mins(remainingMin) + ' of your ' + mins(durationMin) +
          ' session left. The notebook is right there.' : 'The notebook is right there.'
      };
    }
    if (!last) {
      return { title: 'Still sure?', body: 'Second ask. Nothing on this screen matters more than the page in front of you.' };
    }
    return {
      title: 'Last ask.\nEnd the session now?',
      body: 'Unlocking ends this session early.' + (focusedMin >= 1 ? ' The ' + mins(focusedMin) +
        ' you’ve already focused still count.' : '')
    };
  }

  function startConfirmWait(u) {
    var delay = Math.max(0, +u.confirmDelayMs || 0);
    S.confirmStartedAt = Date.now();
    clearTimeout(S.confirmTimer);
    $sureBtn.disabled = true;
    $sureBtn.classList.remove('is-ready');
    $sureFill.style.transition = 'none';
    $sureFill.style.webkitClipPath = $sureFill.style.clipPath = 'inset(0 100% 0 0 round 1rem)';
    void $sureFill.offsetWidth;
    if (delay > 0) {
      $sureFill.style.transition = '-webkit-clip-path ' + delay + 'ms linear, clip-path ' + delay + 'ms linear';
      $sureFill.style.webkitClipPath = $sureFill.style.clipPath = 'inset(0 0 0 0 round 1rem)';
    }
    S.confirmTimer = setTimeout(function () {
      if (S.unlock.stage !== 'confirm') return;
      $sureBtn.disabled = false;
      $sureBtn.classList.add('is-ready');
    }, delay + 30);
  }

  function renderUnlock(u, prev) {
    renderSteps(u);
    var st = u.stage;
    setStageView(st);
    $modal.classList.toggle('show-steps', st === 'pin' || st === 'confirm');

    if (st === 'pin') {
      var fresh = prev.stage !== 'pin' || prev.step !== u.step;
      var wrong = u.error === 'wrong-pin' && (S.pinPending || u.wrongAttempts !== prev.wrongAttempts);
      clearTimeout(S.pinPendingTimer);
      S.pinPending = false;
      $modal.classList.remove('is-checking');
      if (fresh || wrong) S.entry = '';
      if (wrong) shakeSlots(); else renderSlots(false);
      if (u.error === 'wrong-pin') {
        $pinErr.textContent = 'That’s not it.';
        var left = 5 - (u.wrongAttempts || 0);
        $pinHint.textContent = u.wrongAttempts >= 2 && left > 0
          ? left + (left === 1 ? ' try' : ' tries') + ' before a short cooldown' : '';
      } else {
        $pinErr.textContent = '';
        $pinHint.textContent = '';
      }
      if (doc.activeElement !== $card && !$modal.contains(doc.activeElement)) $card.focus({ preventScroll: true });
    } else if (st === 'confirm') {
      var key = 'confirm:' + u.step;
      var copy = confirmCopy(u.step, u);
      $confirmTitle.textContent = copy.title;
      $confirmBody.textContent = copy.body;
      if (prev.stage !== 'confirm' || prev.step !== u.step || S.confirmKey !== key) {
        S.confirmKey = key;
        S.entry = '';
        startConfirmWait(u);
        $keepBtn.focus({ preventScroll: true });
      }
    } else {
      S.confirmKey = '';
    }

    if (st === 'cooldown') {
      updateCooldown(Date.now());
      $backBtn.focus({ preventScroll: true });
    }
    if (st === 'unlocked') {
      $card.focus({ preventScroll: true });
    }
  }

  function onUnlock(payload) {
    if (S.role !== 'primary') return;
    var prev = S.unlock;
    var u = Object.assign({}, UNLOCK_DEFAULTS, payload || {});
    u.step = Math.max(1, u.step | 0);
    u.totalSteps = Math.max(1, u.totalSteps | 0);
    u.pinLength = Math.max(1, u.pinLength | 0);
    S.unlock = u;
    updateUnlockLink(Date.now());

    if (S.ending) return;
    if (u.stage === 'idle') {
      S.unlockRequested = false;
      closeModal();
      $modal.setAttribute('data-stage', 'idle');
      return;
    }
    if (u.stage === 'cooldown' && S.cooldownDismissed === u.cooldownUntil && !S.unlockRequested) {
      return; // the user closed this cooldown card; don't push it back at them
    }
    S.unlockRequested = false;
    if (u.stage === 'cooldown') S.cooldownDismissed = null;
    openModal();
    renderUnlock(u, prev);
  }

  function updateCooldown(now) {
    var u = S.unlock;
    if (u.stage !== 'cooldown') return;
    var left = (u.cooldownUntil || 0) - now;
    $cooldownLeft.textContent = fmtTime(Math.max(0, left) + 999);
  }

  var lastUnlockLabel = '';
  function updateUnlockLink(now) {
    var u = S.unlock, label = 'Unlock early';
    if (u.stage === 'cooldown' && u.cooldownUntil && u.cooldownUntil > now) {
      label = 'Unlock early · ' + fmtTime(u.cooldownUntil - now + 999);
    }
    if (label !== lastUnlockLabel) { lastUnlockLabel = label; $unlockLabel.textContent = label; }
  }

  // Keypad & buttons
  $keypad.addEventListener('click', function (e) {
    var b = e.target.closest('[data-key]');
    if (!b) return;
    var k = b.getAttribute('data-key');
    if (k === 'del') pinDelete(); else pinInput(k);
  });
  $modal.addEventListener('click', function (e) {
    var a = e.target.closest('[data-action]');
    if (a && a.getAttribute('data-action') === 'cancel') cancelUnlock();
  });
  $modal.addEventListener('pointermove', function () { if (S.unlock.stage === 'pin') unlockActivity(); });
  $sureBtn.addEventListener('click', function () {
    if ($sureBtn.disabled || S.unlock.stage !== 'confirm') return;
    if (Date.now() - S.confirmStartedAt < (S.unlock.confirmDelayMs || 0)) return;
    $sureBtn.disabled = true; // one press per ask; native answers with the next stage
    Brick.send('unlock.confirm', {});
  });
  $backBtn.addEventListener('click', function () {
    S.cooldownDismissed = S.unlock.cooldownUntil;
    closeModal();
  });

  function trapTab(e) {
    var f = Array.prototype.filter.call(
      $card.querySelectorAll('.mv-' + S.unlock.stage + ' button:not([disabled])'),
      function (b) { return b.offsetParent !== null; }
    );
    if (!f.length) { e.preventDefault(); return; }
    var i = f.indexOf(doc.activeElement);
    e.preventDefault();
    var next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i + 1) % f.length;
    f[next].focus();
  }

  function handleModalKey(e) {
    var st = S.unlock.stage;
    if (e.key === 'Tab') { trapTab(e); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (st === 'pin') {
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); flashKey(e.key); pinInput(e.key); }
      else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); flashKey('del'); pinDelete(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (!S.pinPending && S.entry.length < S.unlock.pinLength) nudgeSlots();
      }
      else if (e.key === 'Escape') { e.preventDefault(); cancelUnlock(); }
      else if (e.key === ' ') { e.preventDefault(); }
    } else if (st === 'confirm') {
      if (e.key === 'Escape') { e.preventDefault(); cancelUnlock(); }
      else if (e.key === 'Enter') {
        // Enter activates the focused button (Keep focusing by default); otherwise it means "keep focusing".
        var a = doc.activeElement;
        if (a && a.tagName === 'BUTTON' && $modal.contains(a) && !a.disabled) return;
        e.preventDefault(); cancelUnlock();
      }
    } else if (st === 'cooldown') {
      if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); $backBtn.click(); }
    } else {
      e.preventDefault();
    }
  }

  $unlockBtn.addEventListener('click', beginUnlock);

  // ───────────────────────────── peek ─────────────────────────────
  var lastPeekText = '';
  function updatePeek(now) {
    if (!S.peek.active) return;
    var left = (S.peek.endsAt || now) - now;
    var t = left > 500 ? 'back to focus in ' + fmtTime(left + 999) : 'back to focus now';
    if (t !== lastPeekText) { lastPeekText = t; $peekText.textContent = t; }
  }
  $peekReturn.addEventListener('click', function () { Brick.send('peek.end', {}); });

  // ───────────────────────────── ending ─────────────────────────────
  function onEnding(e) {
    if (S.ending) return;
    e = e || {};
    S.ending = e;
    closeModal();
    closePopover();
    S.peek = { active: false, endsAt: null };
    $peek.classList.remove('is-visible');
    $toast.classList.remove('is-visible');
    body.classList.add('is-ending');
    var focusedMin = Math.round((+e.focusedMs || 0) / 60000);
    var focused = focusedMin >= 1 ? U.formatMinutesLong(focusedMin) : null;
    if (e.reason === 'unlocked') {
      $endingTitle.textContent = 'Session ended early';
      $endingSub.textContent = focused ? focused + ' focused. That still counts.' : 'A few minutes of focus still count.';
      $ending.classList.add('is-early');
    } else {
      $endingTitle.textContent = 'Session complete';
      var dur = Math.round((+e.focusedMs || +e.durationMs || 0) / 60000);
      $endingSub.textContent = (dur >= 1 ? U.formatMinutesLong(dur) + ' of focus.' : 'Well focused.') + ' Welcome back.';
    }
    requestAnimationFrame(function () { $ending.classList.add('is-visible'); });
    setTimeout(function () { $fade.classList.add('is-on'); }, 250);
    setTimeout(function () { if (stage) stage.pause(); }, 3600);
  }

  // ───────────────────────────── idle ─────────────────────────────
  function setIdle(v) {
    S.idle = v;
    body.classList.toggle('is-idle', v);
    if (v) {
      closePopover();
      if (doc.activeElement && doc.activeElement !== body && !$modal.contains(doc.activeElement)) doc.activeElement.blur();
    }
  }
  // Like BrickUtil.idleWatcher, but ignores mousemoves that didn't move: WebKit can send synthetic
  // "fake" mousemoves (layout/scroll changes under a resting cursor), which would keep the HUD awake.
  (function watchIdle(ms) {
    var timer = null, lastX = null, lastY = null;
    function arm() { clearTimeout(timer); timer = setTimeout(function () { setIdle(true); }, ms); }
    function activity() { if (S.idle) setIdle(false); arm(); }
    global.addEventListener('mousemove', function (e) {
      if (e.screenX === lastX && e.screenY === lastY) return;
      var first = lastX === null;
      lastX = e.screenX; lastY = e.screenY;
      if (!first || !S.idle) activity();
    }, { passive: true, capture: true });
    ['mousedown', 'keydown', 'wheel', 'touchstart'].forEach(function (t) {
      global.addEventListener(t, activity, { passive: true, capture: true });
    });
    arm();
  })(6000);

  // Mouse clicks shouldn't leave buttons focused (Space is play/pause, not "press the last button").
  doc.addEventListener('pointerup', function (e) {
    var b = e.target.closest && e.target.closest('button');
    if (b && !$modal.contains(b)) setTimeout(function () { if (doc.activeElement === b) b.blur(); }, 0);
  });
  doc.addEventListener('click', function (e) {
    if (popOpen && !$pop.contains(e.target) && !$playlistsBtn.contains(e.target)) closePopover();
  });
  global.addEventListener('resize', closePopover);

  // ───────────────────────────── keyboard ─────────────────────────────
  doc.addEventListener('keydown', function (e) {
    if (S.ending) { e.preventDefault(); return; }
    if (S.modalOpen) { handleModalKey(e); return; }
    if (S.role !== 'primary' || !S.ready) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    var inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    if (e.key === 'Escape') { if (popOpen) { e.preventDefault(); closePopover(); } return; }
    if (e.key === ' ' || e.code === 'Space') {
      // A keyboard-focused button keeps its normal Space behaviour.
      if (t && t.tagName === 'BUTTON' && t.matches(':focus-visible')) return;
      e.preventDefault();
      if (!e.repeat) togglePlay();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !inField) {
      e.preventDefault();
      if (!e.repeat && controllable(S.spotify) && S.spotify.track) cmd(e.key === 'ArrowLeft' ? 'previous' : 'next');
    } else if ((e.key === 'u' || e.key === 'U') && !e.repeat) {
      e.preventDefault();
      beginUnlock();
    }
  });

  // ───────────────────────────── bridge ─────────────────────────────
  Brick.on('init', function (p) {
    p = p || {};
    clearTimeout(preInitTimer);
    var first = !S.ready;
    S.ready = true;
    if (p.role === 'primary' || p.role === 'secondary') S.role = p.role;
    if (p.displayIndex != null) S.displayIndex = Math.max(0, p.displayIndex | 0);
    S.settings = Object.assign({}, S.settings, p.settings || {});
    S.images = (p.gallery && p.gallery.images) || [];
    if (p.session) {
      S.session = Object.assign({}, p.session);
      if (!S.session.durationMs) S.session.durationMs = S.session.endsAt - S.session.startedAt;
    }
    applyRole();
    body.classList.add('is-ready');

    var mode = (p.session && p.session.mode) || S.mode;
    S.mode = mode;
    mountStage(mode, first ? 1800 : 1600);

    var peekSec = Math.round(+S.settings.peekSeconds || 90);
    $peekHint.textContent = 'Shows the Spotify app for ' + peekSec + ' s';
    $peekBtn.title = 'Shows the Spotify app for ' + peekSec + ' s, then returns here';

    renderSessionMeta();
    buildModes();
    S.timeUp = false;
    body.classList.remove('is-timeup');
    lastClock = '';
    updateCountdown(Date.now());
  });

  Brick.on('mode', function (p) {
    var mode = p && p.mode;
    if (!mode) return;
    var changed = mode !== S.mode;
    S.mode = mode;
    if (S.session) S.session.mode = mode;
    if (stage) stage.setMode(mode, { transition: 1600 }); else mountStage(mode, 1600);
    markMode();
    if (changed && !S.ending) showToast(mode);
  });

  Brick.on('spotify', function (p) {
    var prev = S.spotify;
    S.spotify = Object.assign({}, p || {});
    if (!S.spotify.positionAt) S.spotify.positionAt = Date.now();
    renderSpotify(prev);
  });

  Brick.on('artwork', function (p) {
    p = p || {};
    S.art = { trackId: p.trackId || null, src: p.dataUrl || null };
    if (stage) stage.setPalette(Array.isArray(p.palette) ? p.palette : []);
    var sp = S.spotify;
    if (sp && sp.track && (!p.trackId || p.trackId === sp.track.id)) {
      clearTimeout(S.artPendingTimer);
      setArt(p.dataUrl || U.placeholderArt(sp.track.id || sp.track.name || 'track', 240));
    }
  });

  Brick.on('audio', function (p) { if (stage && p) stage.setAudioFrame(p); });
  Brick.on('audioStatus', function (p) { S.audioStatus = p || null; });
  Brick.on('unlock', onUnlock);

  Brick.on('peek', function (p) {
    p = p || {};
    S.peek = { active: !!p.active, endsAt: p.endsAt || null };
    if (S.ending) return;
    lastPeekText = '';
    updatePeek(Date.now());
    $peek.classList.toggle('is-visible', S.peek.active);
    body.classList.toggle('is-peeking', S.peek.active);
  });

  Brick.on('ending', onEnding);

  // ───────────────────────────── tick ─────────────────────────────
  // 4 Hz is plenty: the countdown changes once a second and a 3px track bar moves < 2 px/s.
  // Driven by rAF so nothing runs while the page is hidden; DOM writes only happen when values change.
  var lastSlow = 0;
  function tick() {
    requestAnimationFrame(tick);
    var now = Date.now();
    if (now - lastSlow < 250) return;
    lastSlow = now;
    updateCountdown(now);
    updatePeek(now);
    updateCooldown(now);
    updateUnlockLink(now);
    if (!S.idle && !seeking && S.view === 'track' && S.role === 'primary' && !S.ending) updateTrackProgress(now);
  }
  requestAnimationFrame(tick);

  // Debug handle for tests.
  global.__lock = { state: S, get stage() { return stage; } };

  Brick.ready();
})(window);
