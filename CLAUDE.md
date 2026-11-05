# Analog Brick — notes for Claude

A macOS 13+ "focus brick": during a timed session every display shows a calm full-screen visual, only Spotify is
controllable, Do Not Disturb is on (via two user-made Shortcuts), and unlocking early takes the session PIN three
times with an "are you sure?" after each. Read `docs/PLAN.md` (architecture, how the lock holds) and `docs/BRIDGE.md`
(the native ↔ web message contract) before changing behaviour.

## Layout
- `Sources/BrickCore/` — pure Swift logic (unlock ritual, PIN hash, settings, stats, FFT audio analysis, palette). Tested.
- `Sources/AnalogBrick/` — AppKit shell: overlay windows per display, kiosk presentation options, app watchdog,
  Spotify via `osascript`, ScreenCaptureKit audio, Focus via `shortcuts`, login-agent watchdog/resume, WKWebView host.
- `web/` — every screen and visual (plain HTML/CSS/JS + WebGL, no build step), served to WKWebView via `brick://app/…`.
  `web/js/mock/` fakes the native side so pages run in any browser.
- `resources/` — Info.plist, login-agent plist, entitlements, icon. `scripts/build_app.sh` assembles the .app.
- `tools/` — `serve.mjs` (static server), `snap.mjs` (screenshots), `check.mjs` (web smoke tests incl. the unlock ritual).

## Commands
- Tests: `swift test`
- Build the app: `scripts/build_app.sh` → `build/Analog Brick.app` (ad-hoc signed)
- Run against the working copy of web/: `ANALOG_BRICK_WEB_ROOT="$PWD/web" ANALOG_BRICK_DEBUG=1 "build/Analog Brick.app/Contents/MacOS/AnalogBrick"`
- Render a page in real WebKit: `"build/Analog Brick.app/Contents/MacOS/AnalogBrick" --snapshot aurora /tmp/aurora.png`
- Web smoke tests (needs Playwright): `node tools/check.mjs --out build/web-shots`
- Logs: `log stream --predicate 'subsystem == "com.analogbrick.AnalogBrick"'`

## Status (handoff from a cloud session, Nov 2026)
- BrickCore: 35 tests pass (on Linux). Web: all checks in `tools/check.mjs` pass in Chromium.
- **`Sources/AnalogBrick` has never been compiled** — it was written without a Mac and reviewed twice for compile
  errors. First job on a Mac: `scripts/build_app.sh`, fix whatever the compiler reports, keep fixes minimal.
- Branch `claude/analog-brick` was never pushed (the cloud session lacked GitHub access): `git push -u origin claude/analog-brick`.
- Then smoke-test the real app: the setup window, a 1–2 minute session, the 3× PIN unlock, Spotify controls and peek,
  multiple displays if available, and `--snapshot` for each mode (WebKit-specific rendering issues show up there).

## Rules worth keeping
- Never send AppleScript to Spotify unless it is already running AND Automation permission is already granted
  (`SpotifyController.permission()` is the strict gate; a consent prompt mid-session would sit under the lock).
- Keep the main thread free during a session: scripts, Shortcuts and process waits run off-main with timeouts.
- If the primary lock page can't load, the session fails open (`LockController.webHostDidFail`) — never leave a
  black screen with no way to unlock.
- Visuals must stay calm: slow motion, no strobing (Pulse caps beat brightness changes), dithered gradients.
