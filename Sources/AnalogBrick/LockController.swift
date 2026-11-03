import AppKit
import BrickCore

enum SessionEndReason: String {
    case completed, unlocked
}

/// Runs one focus session: covers every display, locks the system UI down, keeps every app except
/// Spotify out of reach, drives the unlock ritual, and puts everything back when the session ends.
final class LockController: NSObject, WebHostDelegate {
    private struct Display {
        let window: OverlayWindow
        let host: WebHost
        let index: Int
        let role: String
    }

    /// Kiosk mode. Only applies while Analog Brick is the active app — hence the watchdog below.
    static let kioskOptions: NSApplication.PresentationOptions = [
        .hideDock,
        .hideMenuBar,
        .disableAppleMenu,
        .disableProcessSwitching,      // ⌘⇥, and all of Mission Control / Exposé
        .disableForceQuit,             // ⌥⌘⎋
        .disableSessionTermination,    // power-key Restart/Shut Down/Log Out panel
        .disableHideApplication,       // ⌘H
    ]

    /// System agents that may legitimately come forward; never hide them (we still take focus back).
    static let exemptBundleIDs: Set<String> = [
        "com.apple.loginwindow", "com.apple.SecurityAgent", "com.apple.UserNotificationCenter",
        "com.apple.coreservices.uiagent", "com.apple.universalaccessAuthWarn",
        "com.apple.accessibility.universalAccessAuthWarn", "com.apple.ScreenSaver.Engine",
        "com.apple.dock", "com.apple.systemuiserver", "com.apple.controlcenter",
        "com.apple.notificationcenterui", "com.apple.WindowManager",
    ]

    var onFinish: ((SessionEndReason) -> Void)?

    private(set) var session: SessionRecord
    private let store: Store
    private let gallery: Gallery
    private let spotify: SpotifyController
    private let focus: FocusManager
    private let schemeHandler: BrickSchemeHandler
    private let resumed: Bool
    private let audio = AudioCapture()
    private let power = PowerAssertion()
    private let unlock: UnlockFlow

    private var displays: [Display] = []
    private var mode: String
    private var ticker: Timer?
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private var hiddenApps: [pid_t] = []
    private var previousFrontmost: NSRunningApplication?
    private var peekUntil: Date?
    private var ending = false
    private var tornDown = false
    private var endingPayload: [String: Any] = [:]
    private var audioStatus: [String: Any] = ["available": false, "reason": "permission"]
    private var autoplayed = false
    private var lastReassert = Date.distantPast

    private var settings: Settings { store.settings }

    init(session: SessionRecord, store: Store, gallery: Gallery, spotify: SpotifyController,
         focus: FocusManager, schemeHandler: BrickSchemeHandler, resumed: Bool) {
        self.session = session
        self.store = store
        self.gallery = gallery
        self.spotify = spotify
        self.focus = focus
        self.schemeHandler = schemeHandler
        self.resumed = resumed
        self.mode = VisualMode.all.contains(session.mode) ? session.mode : VisualMode.fallback
        let pinHash = session.pin
        self.unlock = UnlockFlow(pinLength: session.pinLength,
                                 confirmDelay: TimeInterval(store.settings.confirmDelaySec),
                                 verify: { pinHash.verify($0) })
        super.init()
    }

    // MARK: lifecycle

    func start() {
        Log.lock.info("Session \(self.session.id, privacy: .public) starting (resumed: \(self.resumed)), ends \(self.session.endsAt.description, privacy: .public)")
        if let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != getpid() {
            previousFrontmost = front
        }
        hideOtherApps()
        buildDisplays()
        NSApp.presentationOptions = Self.kioskOptions
        NSApp.activate(ignoringOtherApps: true)
        bringToFront()
        installObservers()

        let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(timer, forMode: .common)
        ticker = timer

        if settings.keepAwake { power.begin(reason: "Analog Brick focus session") }
        if settings.focusEnabled { focus.turnOn() }

        // Spotify
        spotify.onState = { [weak self] state in self?.broadcast("spotify", state) }
        spotify.onArtwork = { [weak self] art in self?.broadcast("artwork", art) }
        spotify.onRunningChanged = { [weak self] running in
            guard let self, !self.ending else { return }
            if running { self.spotifyDidLaunch() } else {
                self.audio.stop()
                self.setAudioStatus(false, "spotify-not-running")
                if self.peekUntil != nil { self.endPeek() }
            }
        }
        spotify.startMonitoring()
        if spotify.isRunning {
            if !resumed { startAutoplayIfNeeded() }
        } else if settings.launchSpotify && spotify.isInstalled {
            spotify.launch(hidden: true)
        }

        // Audio for the music-reactive mode
        audio.onFrame = { [weak self] frame in
            guard let self, self.mode == "pulse" else { return }
            self.broadcast("audio", frame.payload(), droppable: true)
        }
        audio.onStatus = { [weak self] available, reason in self?.setAudioStatus(available, reason) }
        if spotify.isRunning { audio.start() } else {
            setAudioStatus(false, AudioCapture.hasPermission ? "spotify-not-running" : "permission")
        }
    }

    private func finish(_ reason: SessionEndReason) {
        guard !ending else { return }
        ending = true
        let now = Date()
        let focused = min(session.duration, max(0, now.timeIntervalSince(session.startedAt)))
        Log.lock.info("Session ending: \(reason.rawValue, privacy: .public), focused \(Int(focused))s")
        store.appendHistory(SessionLogEntry(startedAt: session.startedAt,
                                            plannedMs: Int64(session.duration * 1000),
                                            focusedMs: Int64(focused * 1000),
                                            completed: reason == .completed))
        store.saveSession(nil)
        if peekUntil != nil {
            peekUntil = nil
            spotify.hide()
            broadcast("peek", ["active": false, "endsAt": NSNull()])
            reassert(force: true)
        }
        endingPayload = [
            "reason": reason.rawValue,
            "focusedMs": Int64(focused * 1000),
            "durationMs": Int64(session.duration * 1000),
        ]
        broadcast("ending", endingPayload)
        audio.stop()
        after(3.6) { [weak self] in self?.teardown(reason) }
    }

    private func teardown(_ reason: SessionEndReason) {
        guard !tornDown else { return }
        tornDown = true
        ticker?.invalidate()
        ticker = nil
        for (center, token) in observers { center.removeObserver(token) }
        observers.removeAll()

        spotify.stopMonitoring()
        spotify.onState = nil
        spotify.onArtwork = nil
        spotify.onRunningChanged = nil
        audio.stop()
        audio.onFrame = nil
        audio.onStatus = nil
        power.end()
        if settings.focusEnabled { focus.turnOff() }

        NSApp.presentationOptions = []
        for d in displays {
            d.host.teardown()
            d.window.dismiss()
        }
        displays.removeAll()
        restoreApps()
        Log.lock.info("Session torn down")
        onFinish?(reason)
    }

    // MARK: displays

    private func buildDisplays() {
        for (i, screen) in NSScreen.screens.enumerated() {
            let role = i == 0 ? "primary" : "secondary"
            let window = OverlayWindow(screen: screen)
            let size = screen.frame.size
            let container = NSView(frame: NSRect(origin: .zero, size: size))
            container.wantsLayer = true
            container.layer?.backgroundColor = NSColor.black.cgColor
            let host = WebHost(page: "lock",
                               query: [URLQueryItem(name: "role", value: role), URLQueryItem(name: "display", value: String(i))],
                               frame: container.bounds, schemeHandler: schemeHandler)
            host.delegate = self
            host.webView.autoresizingMask = [.width, .height]
            container.addSubview(host.webView)
            window.contentView = container
            displays.append(Display(window: window, host: host, index: i, role: role))
        }
    }

    private func teardownDisplays() {
        for d in displays {
            d.host.teardown()
            d.window.dismiss()
        }
        displays.removeAll()
    }

    private func screensChanged() {
        guard !tornDown else { return }
        let screens = NSScreen.screens
        if screens.map(\.displayID) == displays.map(\.window.displayID) {
            for (d, s) in zip(displays, screens) where d.window.frame != s.frame {
                d.window.setFrame(s.frame, display: true)
            }
        } else {
            Log.lock.info("Displays changed (\(screens.count) now); rebuilding overlays")
            teardownDisplays()
            buildDisplays()
        }
        reassert(force: true)
    }

    private func bringToFront() {
        guard !tornDown else { return }
        let level = peekUntil == nil ? OverlayWindow.lockLevel : OverlayWindow.peekLevel
        for d in displays.reversed() {
            if d.window.level != level { d.window.level = level }
            d.window.orderFrontRegardless()
        }
        if peekUntil == nil, let primary = displays.first {
            primary.window.makeKeyAndOrderFront(nil)
            if primary.window.firstResponder !== primary.host.webView {
                primary.window.makeFirstResponder(primary.host.webView)
            }
        }
    }

    /// Take focus back from whatever grabbed it.
    private func reassert(force: Bool = false) {
        guard !tornDown, peekUntil == nil else { return }
        let now = Date()
        if !force && now.timeIntervalSince(lastReassert) < 0.1 { return }
        lastReassert = now
        if NSApp.presentationOptions != Self.kioskOptions { NSApp.presentationOptions = Self.kioskOptions }
        if NSApp.isHidden { NSApp.unhide(nil) }
        NSApp.activate(ignoringOtherApps: true)
        bringToFront()
    }

    // MARK: the watchdog

    private func installObservers() {
        let ws = NSWorkspace.shared.notificationCenter
        let nc = NotificationCenter.default

        func on(_ center: NotificationCenter, _ name: Notification.Name, _ handler: @escaping (Notification) -> Void) {
            observers.append((center, center.addObserver(forName: name, object: nil, queue: .main, using: handler)))
        }

        on(ws, NSWorkspace.didActivateApplicationNotification) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.appActivated(app)
        }
        on(ws, NSWorkspace.didLaunchApplicationNotification) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            // Apps launched mid-session (login items, Spotlight, schedulers) get hidden as soon as they settle.
            after(0.4) { self?.hideIfForbidden(app) }
        }
        on(ws, NSWorkspace.didWakeNotification) { [weak self] _ in
            self?.tick()
            self?.reassert(force: true)
            if self?.spotify.isRunning == true { self?.audio.restart() }
        }
        on(ws, NSWorkspace.screensDidWakeNotification) { [weak self] _ in self?.reassert(force: true) }
        on(ws, NSWorkspace.activeSpaceDidChangeNotification) { [weak self] _ in self?.reassert(force: true) }

        on(nc, NSApplication.didResignActiveNotification) { [weak self] _ in
            guard let self, self.peekUntil == nil else { return }
            DispatchQueue.main.async { self.reassert(force: true) }
        }
        on(nc, NSApplication.didBecomeActiveNotification) { [weak self] _ in
            // Clicking back onto the lock while Spotify is peeking ends the peek.
            guard let self, self.peekUntil != nil else { return }
            self.endPeek()
        }
        on(nc, NSApplication.didHideNotification) { [weak self] _ in
            NSApp.unhide(nil)
            self?.reassert(force: true)
        }
        on(nc, NSApplication.didChangeScreenParametersNotification) { [weak self] _ in
            // Let the system finish reconfiguring before rebuilding.
            after(0.3) { self?.screensChanged() }
        }
    }

    private func appActivated(_ app: NSRunningApplication) {
        guard !tornDown, app.processIdentifier != getpid() else { return }
        if peekUntil != nil {
            if app.bundleIdentifier == SpotifyController.bundleID { return }
            endPeek()
        }
        hideIfForbidden(app)
        DispatchQueue.main.async { [weak self] in self?.reassert(force: true) }
    }

    private func hideIfForbidden(_ app: NSRunningApplication) {
        guard !tornDown, !app.isTerminated, app.processIdentifier != getpid() else { return }
        if let id = app.bundleIdentifier {
            if Self.exemptBundleIDs.contains(id) { return }
            if id == SpotifyController.bundleID && peekUntil != nil { return }
        }
        guard app.activationPolicy != .prohibited else { return }
        if !app.isHidden, app.hide(), !hiddenApps.contains(app.processIdentifier) {
            hiddenApps.append(app.processIdentifier)
        }
    }

    private func hideOtherApps() {
        let me = getpid()
        for app in NSWorkspace.shared.runningApplications
        where app.processIdentifier != me && app.activationPolicy == .regular && !app.isHidden && !app.isTerminated {
            if let id = app.bundleIdentifier, Self.exemptBundleIDs.contains(id) { continue }
            if app.hide() { hiddenApps.append(app.processIdentifier) }
        }
    }

    private func restoreApps() {
        for pid in hiddenApps {
            NSRunningApplication(processIdentifier: pid)?.unhide()
        }
        hiddenApps.removeAll()
    }

    /// The app that was in front when the session began (nil if it was Analog Brick itself).
    var appInFrontBeforeSession: NSRunningApplication? { previousFrontmost }

    private func tick() {
        guard !tornDown else { return }
        let now = Date()
        if !ending && now >= session.endsAt {
            finish(.completed)
            return
        }
        if ending { return }
        if unlock.tick(now: now) { broadcastUnlock() }
        if let until = peekUntil, now >= until { endPeek() }
        guard peekUntil == nil else { return }

        if let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != getpid() {
            appActivated(front)
        } else if !NSApp.isActive || !(NSApp.keyWindow is OverlayWindow) {
            reassert()
        }
        for d in displays where !d.window.isVisible || d.window.level != OverlayWindow.lockLevel {
            d.window.level = OverlayWindow.lockLevel
            d.window.orderFrontRegardless()
        }
    }

    // MARK: Spotify peek

    private func startPeek() {
        guard !ending, peekUntil == nil, spotify.isInstalled else { return }
        let until = Date() + TimeInterval(settings.peekSeconds)
        peekUntil = until
        Log.lock.info("Spotify peek for \(self.settings.peekSeconds)s")
        for d in displays { d.window.level = OverlayWindow.peekLevel }
        broadcast("peek", ["active": true, "endsAt": until.epochMillis])
        if spotify.isRunning {
            spotify.showWindow()
        } else {
            spotify.launch(hidden: false)
        }
    }

    private func endPeek() {
        guard peekUntil != nil else { return }
        peekUntil = nil
        spotify.hide()
        broadcast("peek", ["active": false, "endsAt": NSNull()])
        reassert(force: true)
    }

    private func spotifyDidLaunch() {
        after(2.0) { [weak self] in
            guard let self, !self.ending else { return }
            if self.peekUntil == nil { self.spotify.hide() }
            self.audio.restart()
            if !self.resumed { self.startAutoplayIfNeeded() }
        }
    }

    private func startAutoplayIfNeeded() {
        guard !autoplayed, !settings.autoplayUri.isEmpty else { return }
        autoplayed = true
        spotify.autoplay(uri: settings.autoplayUri)
    }

    private func setAudioStatus(_ available: Bool, _ reason: String) {
        audioStatus = ["available": available, "reason": reason]
        broadcast("audioStatus", audioStatus)
    }

    // MARK: bridge

    private func broadcast(_ type: String, _ payload: [String: Any], droppable: Bool = false) {
        for d in displays { d.host.send(type, payload, droppable: droppable) }
    }

    private func broadcastUnlock() { broadcast("unlock", unlock.payload()) }

    private func initPayload(index: Int, role: String) -> [String: Any] {
        let s = settings
        return [
            "page": "lock",
            "role": role,
            "displayIndex": index,
            "displayCount": displays.count,
            "session": [
                "id": session.id,
                "startedAt": session.startedAt.epochMillis,
                "endsAt": session.endsAt.epochMillis,
                "durationMs": Int64(session.duration * 1000),
                "intention": session.intention,
                "mode": mode,
            ] as [String: Any],
            "settings": [
                "quality": s.quality,
                "showTimerOnSecondary": s.showTimerOnSecondary,
                "confirmDelaySec": s.confirmDelaySec,
                "peekSeconds": s.peekSeconds,
                "quickPlaylists": s.quickPlaylists.map { ["name": $0.name, "uri": $0.uri] },
                "breathPattern": s.breathPattern,
            ] as [String: Any],
            "gallery": ["images": gallery.urls()],
        ]
    }

    func webHost(_ host: WebHost, didReceive type: String, payload: [String: Any]) {
        guard !tornDown else { return }
        let now = Date()
        switch type {
        case "ready":
            guard let d = displays.first(where: { $0.host === host }) else { return }
            host.send("init", initPayload(index: d.index, role: d.role))
            if !spotify.lastState.isEmpty { host.send("spotify", spotify.lastState) }
            if let art = spotify.lastArtwork { host.send("artwork", art) }
            host.send("audioStatus", audioStatus)
            host.send("unlock", unlock.payload())
            if let until = peekUntil { host.send("peek", ["active": true, "endsAt": until.epochMillis]) }
            if ending { host.send("ending", endingPayload) }
            if d.index == 0 { d.window.makeFirstResponder(host.webView) }

        case "spotify.command":
            spotify.perform(action: payload.string("action") ?? "", value: payload["value"])
        case "spotify.launch":
            if !spotify.isRunning { spotify.launch(hidden: true) }
        case "spotify.peek":
            startPeek()
        case "peek.end":
            endPeek()

        case "unlock.begin":
            guard !ending else { return }
            unlock.begin(now: now)
            broadcastUnlock()
        case "unlock.submit":
            guard !ending else { return }
            unlock.submit(pin: payload.string("pin") ?? "", now: now)
            broadcastUnlock()
        case "unlock.confirm":
            guard !ending else { return }
            unlock.confirm(now: now)
            broadcastUnlock()
            if unlock.isUnlocked { finish(.unlocked) }
        case "unlock.cancel":
            unlock.cancel(now: now)
            broadcastUnlock()
        case "unlock.activity":
            unlock.activity(now: now)

        case "mode.set":
            guard let m = payload.string("mode"), VisualMode.all.contains(m), m != mode else { return }
            mode = m
            session.mode = m
            store.saveSession(session)
            store.update { $0.mode = m }
            broadcast("mode", ["mode": m])
            if m == "pulse", spotify.isRunning, audioStatus["available"] as? Bool != true { audio.start() }

        default:
            break
        }
    }
}
