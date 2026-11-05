/*
 * Analog Brick — small shared helpers for the setup and lock pages.
 * Plain script; defines window.BrickUtil.
 */
(function (global) {
  'use strict';

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  var BrickUtil = {
    clamp: function (x, a, b) { return Math.min(b, Math.max(a, x)); },

    /** 3_723_000 → "1:02:03"; 125_000 → "02:05". Never negative. Rounds up so 0:00 shows only at the end. */
    formatCountdown: function (ms) {
      var total = Math.max(0, Math.ceil(ms / 1000));
      var h = Math.floor(total / 3600);
      var m = Math.floor((total % 3600) / 60);
      var s = total % 60;
      return h > 0 ? h + ':' + pad2(m) + ':' + pad2(s) : pad2(m) + ':' + pad2(s);
    },

    /** 5_400_000 → "1h 30m"; 2_700_000 → "45m"; 40_000 → "40s"; 0 → "0m". */
    formatDuration: function (ms) {
      var totalMin = Math.floor(Math.max(0, ms) / 60000);
      if (totalMin === 0) {
        var s = Math.floor(Math.max(0, ms) / 1000);
        return s > 0 ? s + 's' : '0m';
      }
      var h = Math.floor(totalMin / 60);
      var m = totalMin % 60;
      if (h === 0) return m + 'm';
      return m === 0 ? h + 'h' : h + 'h ' + m + 'm';
    },

    /** Minutes → "50 min" / "1 hr 30 min" for prose. */
    formatMinutesLong: function (min) {
      min = Math.round(min);
      var h = Math.floor(min / 60), m = min % 60;
      if (h === 0) return m + ' min';
      return m === 0 ? (h === 1 ? '1 hr' : h + ' hr') : h + ' hr ' + m + ' min';
    },

    /** Date or epoch ms → local "3:45 PM" (or 24h, following the system locale). */
    formatClock: function (d) {
      var date = d instanceof Date ? d : new Date(d);
      try {
        return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      } catch (e) {
        return date.getHours() + ':' + pad2(date.getMinutes());
      }
    },

    /** Tiny DOM builder: el('div', {class: 'x', onclick: fn, text: 'hi'}, child, …). */
    el: function (tag, attrs) {
      var node = document.createElement(tag);
      if (attrs) {
        Object.keys(attrs).forEach(function (k) {
          var v = attrs[k];
          if (v == null || v === false) return;
          if (k === 'class') node.className = v;
          else if (k === 'text') node.textContent = v;
          else if (k === 'html') node.innerHTML = v;
          else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
          else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
          else if (k === 'dataset') Object.assign(node.dataset, v);
          else node.setAttribute(k, v === true ? '' : v);
        });
      }
      for (var i = 2; i < arguments.length; i++) {
        var c = arguments[i];
        if (c == null || c === false) continue;
        if (Array.isArray(c)) c.forEach(function (cc) { if (cc != null) node.appendChild(typeof cc === 'string' ? document.createTextNode(cc) : cc); });
        else node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
      return node;
    },

    debounce: function (fn, ms) {
      var t = null;
      return function () {
        var args = arguments, self = this;
        clearTimeout(t);
        t = setTimeout(function () { fn.apply(self, args); }, ms);
      };
    },

    /**
     * Track user activity (mouse, keys, wheel, touch). Calls onIdle() after `ms` of no
     * activity and onActive() on the first activity after idling. Returns {poke(), stop(), isIdle()}.
     */
    idleWatcher: function (ms, onIdle, onActive) {
      var idle = false, timer = null;
      function arm() {
        clearTimeout(timer);
        timer = setTimeout(function () { idle = true; onIdle && onIdle(); }, ms);
      }
      function activity() {
        if (idle) { idle = false; onActive && onActive(); }
        arm();
      }
      var events = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'];
      events.forEach(function (e) { global.addEventListener(e, activity, { passive: true, capture: true }); });
      arm();
      return {
        poke: activity,
        isIdle: function () { return idle; },
        stop: function () {
          clearTimeout(timer);
          events.forEach(function (e) { global.removeEventListener(e, activity, { capture: true }); });
        }
      };
    },

    /** Make a soft placeholder album-art data URL from a seed string (used by mocks and as a fallback). */
    placeholderArt: function (seed, size) {
      size = size || 300;
      var h = 0;
      for (var i = 0; i < (seed || '').length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
      var c = document.createElement('canvas');
      c.width = c.height = size;
      var g = c.getContext('2d');
      var hue = h % 360;
      var grad = g.createLinearGradient(0, 0, size, size);
      grad.addColorStop(0, 'hsl(' + hue + ',45%,32%)');
      grad.addColorStop(1, 'hsl(' + ((hue + 70) % 360) + ',55%,14%)');
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
      var r = g.createRadialGradient(size * 0.7, size * 0.3, 0, size * 0.7, size * 0.3, size * 0.6);
      r.addColorStop(0, 'hsla(' + ((hue + 30) % 360) + ',80%,70%,0.55)');
      r.addColorStop(1, 'hsla(' + hue + ',80%,50%,0)');
      g.fillStyle = r;
      g.fillRect(0, 0, size, size);
      return c.toDataURL('image/jpeg', 0.85);
    }
  };

  global.BrickUtil = BrickUtil;
})(window);
