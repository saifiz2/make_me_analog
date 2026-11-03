# Native ↔ Web bridge contract

The native shell (Swift/AppKit) hosts every screen in a `WKWebView`. All UI and
visuals live in `web/`. This file is the single source of truth for the
messages the two halves exchange. If you change a message, change it here first.

## Transport

| Direction | Mechanism |
|---|---|
| JS → native | `window.webkit.messageHandlers.brick.postMessage({type, payload})` |
| native → JS | `webView.evaluateJavaScript("Brick._receive(" + json + ")")` where `json = {"type": …, "payload": …}` |

`web/js/bridge.js` wraps this:

```js
Brick.isNative            // true inside the app, false in a normal browser
Brick.page                // <html data-page="lock|setup|preview">
Brick.params              // URLSearchParams of the page URL
Brick.send(type, payload) // JS → native (in a browser: routed to the mock)
Brick.on(type, fn)        // native → JS subscription; returns an unsubscribe fn
Brick.once(type, fn)
Brick.ready()             // send {type:'ready'}; native answers with 'init'
Brick.mock.handle(type, fn)        // browser only: fake a native command handler
Brick.mock.emit(type, payload, ms) // browser only: fake a native event
```

Native buffers events for a page until that page has sent `ready`.
Pages must register their `Brick.on(...)` handlers **before** calling `Brick.ready()`.

All timestamps are **milliseconds since the Unix epoch** (JS `Date.now()` scale).

---

## Lock page (`lock.html`)

One lock page runs on every display. Loaded as
`lock.html?role=primary|secondary&display=<index>`.
The **primary** display hosts the controls (Spotify, mode switcher, unlock).
Secondary displays show the visual and, if enabled, a quiet timer.

### Events (native → JS)

#### `init`
```jsonc
{
  "page": "lock",
  "role": "primary",            // or "secondary"
  "displayIndex": 0,
  "displayCount": 2,
  "session": {
    "id": "8F1C…",
    "startedAt": 1762170000000,
    "endsAt":    1762173000000,
    "durationMs": 3000000,
    "intention": "Chapter 3 outline",   // may be ""
    "mode": "aurora"
  },
  "settings": {
    "quality": "balanced",            // saver | balanced | high
    "showTimerOnSecondary": true,
    "confirmDelaySec": 3,             // "I'm sure" stays disabled this long
    "peekSeconds": 90,                // how long "Open Spotify" peeks last
    "quickPlaylists": [ { "name": "Deep Focus", "uri": "spotify:playlist:37i9dQZF1DWZeKCadgRdKQ" } ],
    "breathPattern": "box"            // box | coherent | relax (used by the Breath mode)
  },
  "gallery": { "images": ["brick://gallery/0", "brick://gallery/1"] }  // [] if no folder chosen
}
```

#### `spotify` — full player state; sent on every change and every ~2 s while playing
```jsonc
{
  "installed": true,
  "running": true,
  "permission": "granted",   // granted | denied | undetermined | unknown
  "state": "playing",        // playing | paused | stopped
  "track": {                 // null when nothing is loaded
    "id": "spotify:track:…",
    "name": "Weightless",
    "artist": "Marconi Union",
    "album": "Weightless",
    "durationMs": 480000,
    "artworkUrl": "https://i.scdn.co/image/…"
  },
  "positionMs": 61000,
  "positionAt": 1762170061000,  // when positionMs was sampled; interpolate while playing
  "volume": 64,                 // 0…100
  "shuffling": false,
  "repeating": false
}
```

#### `artwork` — album art for the current track (sent after `spotify` when the track changes)
```jsonc
{ "trackId": "spotify:track:…", "dataUrl": "data:image/jpeg;base64,…", "palette": ["#2b3a55", "#c9a46a", "#8aa1b1", "#1a1d26"] }
```
`dataUrl` may be `null`; `palette` may be `[]`. Palette is sorted by dominance.

#### `audio` — live analysis of Spotify's audio, ~30 Hz, only while capture works
```jsonc
{ "bands": [/* 32 numbers 0…1, log-spaced 30 Hz → 16 kHz */], "level": 0.42, "bass": 0.7, "mid": 0.35, "treble": 0.2, "beat": true }
```

#### `audioStatus`
```jsonc
{ "available": false, "reason": "permission" }  // ok | permission | spotify-not-running | unsupported | error
```

#### `unlock` — authoritative state of the 3× PIN + "are you sure?" flow (native owns it)
```jsonc
{
  "stage": "pin",          // idle | pin | confirm | cooldown | unlocked
  "step": 1,               // which round, 1…totalSteps
  "totalSteps": 3,
  "error": null,           // null | "wrong-pin"
  "wrongAttempts": 0,      // consecutive wrong PINs
  "cooldownUntil": null,   // epoch ms while stage === "cooldown"
  "confirmDelayMs": 3000,  // keep "I'm sure" disabled this long after entering "confirm"
  "pinLength": 4           // number of digits, so the UI can draw slots and auto-submit
}
```
Flow: `idle` →(`unlock.begin`)→ `pin`(step 1) →(correct PIN)→ `confirm`(step 1) →(`unlock.confirm`)→
`pin`(step 2) → `confirm`(step 2) → `pin`(step 3) → `confirm`(step 3) →(`unlock.confirm`)→ `unlocked`.
A wrong PIN keeps the current step and sets `error: "wrong-pin"`. 5 consecutive wrong PINs →
`cooldown` (60 s, doubling each time, max 15 min), then back to `idle`.
`unlock.cancel` from `pin`/`confirm` → `idle` (step resets to 1). 60 s without interaction → `idle`.
Native ignores `unlock.confirm` sent before `confirmDelayMs` has elapsed.

#### `mode` — the visual mode changed (broadcast to every display)
```jsonc
{ "mode": "pulse" }
```

#### `peek` — Spotify "peek" (real Spotify window shown above the lock for a short time)
```jsonc
{ "active": true, "endsAt": 1762170150000 }   // endsAt null when inactive
```

#### `ending` — session is over; play the outro. Native removes the windows ~3.5 s later.
```jsonc
{ "reason": "completed", "focusedMs": 3000000, "durationMs": 3000000 }   // reason: completed | unlocked
```

### Commands (JS → native)

| type | payload | notes |
|---|---|---|
| `ready` | `{page:"lock"}` | |
| `spotify.command` | `{action, value?}` | `action`: `playpause` `play` `pause` `next` `previous` `volume`(value 0…100) `shuffle`(value bool) `repeat`(value bool) `seek`(value positionMs) `playUri`(value `"spotify:…"`) |
| `spotify.launch` | `{}` | start Spotify in the background if it isn't running |
| `spotify.peek` | `{}` | show the real Spotify app for `peekSeconds` |
| `peek.end` | `{}` | return to the lock immediately |
| `unlock.begin` | `{}` | |
| `unlock.submit` | `{pin:"1234"}` | |
| `unlock.confirm` | `{}` | "Yes, I'm sure" |
| `unlock.cancel` | `{}` | "Keep focusing" / Esc |
| `unlock.activity` | `{}` | user is typing; resets the 60 s inactivity timeout |
| `mode.set` | `{mode:"night"}` | |
| `log` | `{level, message}` | forwarded to the native log |

---

## Setup page (`setup.html`)

The normal app window used to configure and start a session.

### Events (native → JS)

#### `init`
```jsonc
{
  "page": "setup",
  "version": "1.0.0",
  "settings": {
    "durationMin": 50,
    "mode": "aurora",
    "quality": "balanced",
    "intention": "",
    "keepAwake": true,
    "showTimerOnSecondary": true,
    "resumeAfterRestart": true,
    "focusEnabled": true,
    "launchSpotify": true,
    "autoplayUri": "",                 // "" = don't auto-play
    "quickPlaylists": [ { "name": "Deep Focus", "uri": "spotify:playlist:…" } ],
    "confirmDelaySec": 3,
    "peekSeconds": 90,
    "breathPattern": "box"
  },
  "status": {
    "focus":   { "shortcutsAvailable": true, "onName": "Analog Brick Focus On", "offName": "Analog Brick Focus Off", "hasOn": true, "hasOff": false },
    "spotify": { "installed": true, "running": false, "permission": "undetermined" },
    "audio":   { "supported": true, "permission": "denied" },          // permission: granted | denied | unknown
    "loginItem": { "status": "enabled" },                             // enabled | requiresApproval | notRegistered | notFound | unsupported
    "displays": 2
  },
  "stats": {
    "todayMs": 5400000, "weekMs": 22200000, "streakDays": 3, "totalSessions": 41,
    "recent": [ { "startedAt": 1762100000000, "plannedMs": 3000000, "focusedMs": 3000000, "completed": true } ]
  },
  "gallery": { "folder": "/Users/me/Pictures/Calm", "count": 24, "images": ["brick://gallery/0"] }  // folder null when unset; images = first ≤12
}
```

#### `status` — same shape as `init.status`, sent after `status.refresh` or a permission change
#### `settings` — same shape as `init.settings`, sent after native normalises a save
#### `stats` — same shape as `init.stats`, sent when a session ends
#### `gallery` — same shape as `init.gallery`
#### `error` — `{ "message": "PIN must be 4–8 digits." }` (e.g. `session.start` rejected)

### Commands (JS → native)

| type | payload | notes |
|---|---|---|
| `ready` | `{page:"setup"}` | |
| `settings.save` | partial settings object | persisted immediately; native replies with `settings` |
| `session.start` | `{durationMin, pin, mode, intention}` | PIN: 4–8 digits. Duration: 1–480 min. Other options come from saved settings. On success the setup window hides and the lock starts. |
| `status.refresh` | `{}` | re-check Focus shortcuts, Spotify, permissions |
| `focus.openShortcuts` | `{}` | open the Shortcuts app |
| `focus.test` | `{}` | run the On shortcut, wait 3 s, run Off |
| `spotify.requestPermission` | `{}` | trigger the macOS "control Spotify" consent prompt now (not mid-session) |
| `spotify.launch` | `{}` | |
| `audio.requestPermission` | `{}` | trigger the Screen Recording permission prompt (needed to hear Spotify's audio) |
| `loginItem.openSettings` | `{}` | open System Settings → Login Items |
| `gallery.choose` | `{}` | native folder picker → `gallery` event |
| `gallery.clear` | `{}` | |
| `openURL` | `{url}` | open in the default browser (help links) |
| `app.quit` | `{}` | |

---

## Visual modes

`web/js/visuals/core.js` defines `window.BrickVisuals`. Each mode is one file in
`web/js/visuals/` that calls `BrickVisuals.register({...})`. See the header of
`core.js` for the full mode API.

| id | name | idea |
|---|---|---|
| `aurora`  | Aurora   | Northern-lights curtains over a quiet starry sky |
| `drift`   | Drift    | Thousands of silk threads following a slow flow field |
| `breath`  | Breath   | A glowing orb that guides box / coherent breathing |
| `horizon` | Horizon  | A procedural mountain-and-lake landscape through a slow dusk |
| `night`   | Night    | A slowly turning star field, milky way, the odd shooting star |
| `pulse`   | Pulse    | Moves with your Spotify music (audio-reactive) |
| `gallery` | Gallery  | Your own photo folder with slow Ken Burns drift |
