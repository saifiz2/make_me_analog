/*
 * Analog Brick — native bridge.
 * Plain script (no modules). Defines window.Brick. See docs/BRIDGE.md.
 *
 * Inside the app, messages go to WKScriptMessageHandler "brick".
 * In a normal browser, Brick.send() is routed to mock handlers registered with
 * Brick.mock.handle(type, fn) (see js/mock/*.js), so every page can be developed
 * and screenshot-tested without the native shell.
 */
(function (global) {
  'use strict';

  var listeners = new Map();
  var hasNative = !!(global.webkit && global.webkit.messageHandlers && global.webkit.messageHandlers.brick);

  function emit(type, payload) {
    var set = listeners.get(type);
    if (set) {
      Array.from(set).forEach(function (fn) {
        try { fn(payload, type); } catch (err) { console.error('[brick] handler for "' + type + '" failed', err); }
      });
    }
    var any = listeners.get('*');
    if (any) {
      Array.from(any).forEach(function (fn) {
        try { fn(payload, type); } catch (err) { console.error('[brick] wildcard handler failed', err); }
      });
    }
  }

  var mockHandlers = new Map();

  var Brick = {
    isNative: hasNative,
    page: (document.documentElement && document.documentElement.dataset.page) || 'unknown',
    params: new URLSearchParams(global.location ? global.location.search : ''),
    debug: false,

    /** JS → native. */
    send: function (type, payload) {
      var msg = { type: type, payload: payload || {} };
      if (Brick.debug) console.log('[brick →]', type, msg.payload);
      if (hasNative) {
        try { global.webkit.messageHandlers.brick.postMessage(msg); }
        catch (err) { console.error('[brick] postMessage failed', err); }
      } else {
        Brick.mock._dispatch(msg);
      }
    },

    /** Subscribe to native → JS events. Use '*' for all. Returns an unsubscribe function. */
    on: function (type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return function off() { var s = listeners.get(type); if (s) s.delete(fn); };
    },

    once: function (type, fn) {
      var off = Brick.on(type, function (payload, t) { off(); fn(payload, t); });
      return off;
    },

    /** Tell native the page is ready to receive events. Register handlers first. */
    ready: function () {
      Brick.send('ready', { page: Brick.page });
    },

    /** Called by native (evaluateJavaScript) and by the mock. Accepts an object or JSON string. */
    _receive: function (msg) {
      if (typeof msg === 'string') {
        try { msg = JSON.parse(msg); } catch (err) { console.error('[brick] bad message', msg); return; }
      }
      if (!msg || typeof msg.type !== 'string') return;
      if (Brick.debug) console.log('[brick ←]', msg.type, msg.payload);
      emit(msg.type, msg.payload);
    },

    /** Forward a log line to native (no-op in browsers). */
    log: function (level, message) {
      if (hasNative) Brick.send('log', { level: level, message: String(message) });
      else (console[level] || console.log)('[brick]', message);
    },

    mock: {
      /** Register a fake native command handler (browser only). fn(payload, type). '*' catches all. */
      handle: function (type, fn) { mockHandlers.set(type, fn); },
      /** Fake a native → JS event (browser only). */
      emit: function (type, payload, delayMs) {
        setTimeout(function () { Brick._receive({ type: type, payload: payload }); }, delayMs || 0);
      },
      _dispatch: function (msg) {
        var fn = mockHandlers.get(msg.type) || mockHandlers.get('*');
        if (fn) setTimeout(function () { fn(msg.payload, msg.type); }, 0);
      }
    }
  };

  if (hasNative) {
    // Surface uncaught errors in the native log; invaluable when debugging inside WKWebView.
    global.addEventListener('error', function (e) {
      Brick.log('error', (e.message || 'error') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0));
    });
    global.addEventListener('unhandledrejection', function (e) {
      Brick.log('error', 'unhandled rejection: ' + (e.reason && e.reason.message ? e.reason.message : e.reason));
    });
  }

  global.Brick = Brick;
})(window);
