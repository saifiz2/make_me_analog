# Analog Brick: plan and architecture

## What it is

A macOS app that turns the laptop into a "brick" for a fixed stretch of time so you can work in a paper notebook.

1. **Before a session** you set a duration, a PIN, a visual and (optionally) what you'll work on.
2. **During the session** every display shows a calm full-screen visual. The only thing you can control is
   Spotify: play/pause, skip, volume, shuffle, your quick playlists, and a timed "peek" at the real Spotify window.
   Notifications are silenced via Focus / Do Not Disturb. Every other app is hidden and kept out of reach.
3. **Unlocking early** means typing the PIN three times, with an "are you sure?" after each one. The "I'm sure"
   button stays disabled for a few seconds each time. Five wrong PINs in a row trigger a cooldown.
4. **When the timer ends** the visuals fade out, a short "session complete" message appears, and the desktop
   comes back exactly as it was: Dock, menu bar, hidden apps, Focus off.

## Architecture

```
┌──────────────────────────── Analog Brick.app ────────────────────────────┐
│ Native shell (Swift, AppKit)                     Web UI (WKWebView)      │
│                                                                          │
│ AppDelegate ── SetupWindowController ──────────▶ setup.html              │
│     │                                              duration · PIN · mode │
│     └── LockController (one per session)           checklist · prefs     │
│           ├─ OverlayWindow × N displays ───────▶ lock.html × N           │
│           │    (.screenSaver level, all Spaces)    visual · timer ·      │
│           ├─ kiosk presentation options            Spotify · unlock      │
│           ├─ watchdog (hide other apps,                                  │
│           │   re-take focus, screen changes)     js/visuals/core.js      │
│           ├─ UnlockFlow (BrickCore) ◀── PIN ──     + 7 modes (WebGL /    │
│           ├─ SpotifyController (AppleScript)        Canvas / DOM)        │
│           ├─ AudioCapture (ScreenCaptureKit) ─ FFT ─▶ Pulse mode          │
│           ├─ FocusManager (Shortcuts CLI)                                │
│           └─ PowerAssertion (displays stay on)                           │
│                                                                          │
│ BrickCore (pure Swift, unit-tested on macOS + Linux):                    │
│   UnlockFlow · PinHash/SHA-256 · Settings · SessionRecord · Stats ·      │
│   AudioAnalyzer (FFT, 32 bands, beat) · PaletteExtractor (album art)     │
└──────────────────────────────────────────────────────────────────────────┘
```

The two halves talk over a small message bridge, specified in [`BRIDGE.md`](BRIDGE.md).

### Why a native shell with a web UI

- **Native** is the only way to get the parts that matter for a lock: kiosk presentation options, windows above
  everything on every display, hiding other apps, AppleScript to Spotify, ScreenCaptureKit audio, power
  assertions, a login agent.
- **Web (WebGL in WKWebView)** is the most productive way to make beautiful, GPU-cheap generative visuals and a
  polished UI. It can also be developed and screenshot-tested in a normal browser. Every page ships with a mock of
  the native side (`web/js/mock/`).
- No third-party dependencies: no npm packages at runtime, no Swift packages, no CDNs. The app works offline.

### How the lock holds

| Escape route | What stops it |
|---|---|
| ⌘⇥ app switcher, Mission Control, Exposé, ⌘H | `NSApplication.PresentationOptions`: `.disableProcessSwitching`, `.disableHideApplication`, `.hideDock`, `.hideMenuBar` |
| ⌥⌘⎋ Force Quit, power-key Restart/Shut Down panel, Apple menu | `.disableForceQuit`, `.disableSessionTermination`, `.disableAppleMenu` |
| ⌘Q, ⌘W, ⌘M | Quit is refused while locked; the locked menu has no items; overlay windows ignore close/minimise |
| Dock clicks, Spotlight launches, login items, notification clicks | Watchdog: any other app that activates or launches is hidden right away and focus returns to the lock |
| Plugging or unplugging displays | Overlays are rebuilt for the new display set |
| Lid close / sleep | The timer runs on wall-clock time; on wake the lock re-asserts itself |
| Hard reboot (hold power) | The session is saved to disk. A login agent relaunches the lock at login until the time is up |
| Killing the process (e.g. from a launcher hotkey) | When a session starts, the login agent is kick-started as a watchdog that waits on the app's instance lock. If the app dies mid-session, the watchdog takes the lock and re-locks within a second. launchd restarts the watchdog itself if it is killed |
| Force Quit from the Dock during a Spotify peek | During a peek, Analog Brick becomes an accessory app: no Dock icon, and it isn't listed in the Force Quit window. Do Not Disturb is re-applied when the peek ends |
| A Spotify hang | All AppleScript runs off the main thread via `osascript`, killed after 3 s, with each event bounded to 2 s |
| The lock page failing to load | Retried. If the primary display's page never becomes ready, the session ends (fail open) rather than leave a black screen with no way to unlock |
| Notifications | Focus mode via the user's two Shortcuts; the overlay also sits above banners |

Analog Brick is a commitment device, not DRM. Holding the power button, or holding ⇧ at login (which skips
login items), always works. That's on purpose.

### Spotify, and only Spotify

- Playback control uses Spotify's AppleScript dictionary: state, track, artwork, position, volume, shuffle and
  repeat, plus `play track "spotify:playlist:…"` for quick playlists.
- The app never sends AppleScript unless Spotify is already running *and* Automation permission is already
  granted. Otherwise the macOS consent prompt could open underneath the lock and freeze it. Permission is
  requested from the setup screen instead.
- "Open Spotify" peeks: the overlays drop to normal window level and Spotify's window comes forward for
  `peekSeconds` (default 90). Any other app that activates during a peek ends it immediately. So does clicking the
  lock or the timer running out.
- The **Pulse** mode hears Spotify's audio only, via a ScreenCaptureKit app-filtered audio stream. The audio is
  FFT'd into 32 log bands with auto-gain and beat detection, then sent at 30 Hz. Nothing is recorded. This needs
  the Screen Recording permission. Without it, Pulse falls back to a synthetic rhythm while Spotify plays.

### Visual modes

| Mode | Idea |
|---|---|
| Aurora | Northern-lights curtains over a starry sky |
| Drift | Thousands of silk threads following a slow flow field |
| Breath | A glowing orb that paces box / coherent / 4-7-8 breathing, in sync across displays |
| Horizon | A painterly mountain-and-lake landscape through a slow 30-minute day cycle |
| Night | A slowly turning star field, Milky Way, the odd shooting star |
| Pulse | Moves with your music, tinted by the album art |
| Gallery | Your own photo folder with slow Ken Burns drift |

All modes share `web/js/visuals/core.js`: a registry, crossfades, quality tiers (fps and render scale), audio
smoothing and synthesis, GLSL noise, GL helpers, and a 2D fallback if WebGL is unavailable.

## Build phases

1. **Contracts first.** Write the bridge spec, the visuals engine and its mode API, the design tokens, the bridge
   and mocks, and the screenshot tooling.
2. **In parallel:**
   - the seven visual modes, the lock screen and the setup screen, each built and iterated against
     headless-Chromium screenshots;
   - BrickCore, test-first (SHA-256 vectors, the unlock ritual, cooldowns, settings, stats, FFT band placement,
     beat detection, palette);
   - the AppKit shell.
3. **Integration.** Packaging (`scripts/build_app.sh`, icon, Info.plist, login agent), CI (Linux core tests, web
   smoke tests, a macOS build plus in-WebKit snapshots), then an adversarial review of escape holes and contract
   mismatches.

## Known limitations

- macOS has no public API to toggle Focus. You make two Shortcuts once (the setup screen walks you through it).
- Ad-hoc signed builds lose their Automation and Screen Recording permissions whenever the binary changes (each
  rebuild). Re-grant them from the setup screen.
- On macOS 15+, apps that use ScreenCaptureKit may get a monthly "continue to allow?" system prompt.
- Spotlight (⌘Space) can still open its panel. Anything launched from it is hidden at once.
