import AppKit
import ImageIO
import UniformTypeIdentifiers
import BrickCore

/// Talks to the Spotify desktop app through its AppleScript dictionary.
///
/// Rules that keep a locked screen from ever hanging:
///  • never script Spotify unless it is already running (`tell application` would launch it)
///  • never script it unless Automation permission is already granted (a consent prompt would
///    appear underneath the lock and block the main thread)
final class SpotifyController {
    static let bundleID = "com.spotify.client"

    enum Permission: String { case granted, denied, undetermined, unknown }

    /// Full player state for the bridge `spotify` event.
    var onState: (([String: Any]) -> Void)?
    /// Album art + palette for the bridge `artwork` event.
    var onArtwork: (([String: Any]) -> Void)?
    /// Spotify launched or quit.
    var onRunningChanged: ((Bool) -> Void)?

    private(set) var lastState: [String: Any] = [:]
    private(set) var lastArtwork: [String: Any]?
    private var monitoring = false
    private var pollTimer: Timer?
    private var observers: [NSObjectProtocol] = []
    private var artworkTrackID: String?
    private var permissionCache: (Permission, Date)?
    private var lastSentSignature = ""
    private let scriptQueue = DispatchQueue(label: "analogbrick.spotify", qos: .userInitiated)
    private var readInFlight = false
    private var refreshAgain = false
    private var volumeInFlight = false
    private var pendingVolume: Int?
    private var useInProcessScripts = false

    // MARK: status

    var isInstalled: Bool { appURL != nil }
    var appURL: URL? { NSWorkspace.shared.urlForApplication(withBundleIdentifier: Self.bundleID) }
    var runningApp: NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: Self.bundleID).first { !$0.isTerminated }
    }
    var isRunning: Bool { runningApp != nil }

    /// Automation permission for Spotify, without prompting. Cached for a few seconds.
    /// Strict: this gates every script, so it never returns a remembered answer.
    func permission() -> Permission {
        if let cached = permissionCache, Date().timeIntervalSince(cached.1) < 5 { return cached.0 }
        let p = Self.determinePermission(ask: false)
        if p != .unknown {
            permissionCache = (p, Date())
            remember(p)
        }
        return p
    }

    private static let permissionKey = "spotifyAutomationPermission"

    private func remember(_ p: Permission) {
        guard p != .unknown else { return }
        UserDefaults.standard.set(p.rawValue, forKey: Self.permissionKey)
    }

    /// The last definite answer macOS gave (it can only answer while Spotify is running). Display only.
    private var lastKnownPermission: Permission? {
        UserDefaults.standard.string(forKey: Self.permissionKey).flatMap(Permission.init(rawValue:))
    }

    /// Ask for Automation permission (shows the system prompt). Spotify must be running.
    /// Blocks while the prompt is up, so this runs off the main thread.
    func requestPermission(completion: @escaping (Permission) -> Void) {
        let ask = {
            DispatchQueue.global(qos: .userInitiated).async {
                let p = Self.determinePermission(ask: true)
                DispatchQueue.main.async {
                    self.permissionCache = (p, Date())
                    self.remember(p)
                    completion(p)
                }
            }
        }
        if isRunning { ask(); return }
        launch(hidden: true) { ok in
            guard ok else { return completion(.unknown) }
            after(1.5) { ask() }
        }
    }

    private static func determinePermission(ask: Bool) -> Permission {
        let target = NSAppleEventDescriptor(bundleIdentifier: bundleID)
        guard let desc = target.aeDesc else { return .unknown }
        let status = AEDeterminePermissionToAutomateTarget(desc, AEEventClass(typeWildCard), AEEventID(typeWildCard), ask)
        switch status {
        case 0: return .granted
        case -1743: return .denied          // errAEEventNotPermitted
        case -1744: return .undetermined    // errAEEventWouldRequireUserConsent
        default: return .unknown            // e.g. -600 procNotFound when Spotify isn't running
        }
    }

    /// For the setup checklist: while Spotify is closed macOS can't say, so show the last known answer.
    func statusPayload() -> [String: Any] {
        let running = isRunning
        var p = permission()
        var lastKnown = false
        if p == .unknown, !running, let saved = lastKnownPermission {
            p = saved
            lastKnown = true
        }
        return ["installed": isInstalled, "running": running, "permission": p.rawValue, "permissionLastKnown": lastKnown]
    }

    // MARK: launching

    /// Start Spotify without bringing it to the front.
    func launch(hidden: Bool, completion: ((Bool) -> Void)? = nil) {
        guard let url = appURL else { completion?(false); return }
        if isRunning { completion?(true); return }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = !hidden
        config.hides = hidden
        config.addsToRecentItems = false
        NSWorkspace.shared.openApplication(at: url, configuration: config) { app, error in
            DispatchQueue.main.async {
                if let error { Log.spotify.error("Launch failed: \(error.localizedDescription, privacy: .public)") }
                completion?(app != nil && error == nil)
            }
        }
    }

    /// Bring Spotify's window to the front (used by "peek").
    func showWindow(completion: ((Bool) -> Void)? = nil) {
        guard let url = appURL else { completion?(false); return }
        runningApp?.unhide()
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        config.addsToRecentItems = false
        // Re-opening a running app sends it a reopen event, which shows its main window.
        NSWorkspace.shared.openApplication(at: url, configuration: config) { app, error in
            DispatchQueue.main.async { completion?(app != nil && error == nil) }
        }
    }

    func hide() { runningApp?.hide() }

    // MARK: monitoring

    func startMonitoring() {
        guard !monitoring else { return }
        monitoring = true
        let dnc = DistributedNotificationCenter.default()
        observers.append(dnc.addObserver(forName: NSNotification.Name("com.spotify.client.PlaybackStateChanged"), object: nil, queue: .main) { [weak self] _ in
            self?.refresh()
        })
        let wnc = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification] {
            observers.append(wnc.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                      app.bundleIdentifier == Self.bundleID else { return }
                let running = name == NSWorkspace.didLaunchApplicationNotification
                self?.onRunningChanged?(running)
                after(running ? 1.5 : 0.1) { self?.refresh() }
            })
        }
        let timer = Timer(timeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
        refresh(force: true)
    }

    func stopMonitoring() {
        monitoring = false
        pollTimer?.invalidate()
        pollTimer = nil
        let dnc = DistributedNotificationCenter.default()
        let wnc = NSWorkspace.shared.notificationCenter
        for o in observers { dnc.removeObserver(o); wnc.removeObserver(o) }
        observers.removeAll()
    }

    /// Read the player state (off the main thread) and publish it — only when something changed,
    /// or on every poll while playing (so the progress bar stays honest).
    func refresh(force: Bool = false) {
        var state: [String: Any] = [
            "installed": isInstalled,
            "running": isRunning,
            "permission": Permission.unknown.rawValue,
            "state": "stopped",
            "track": NSNull(),
            "positionMs": 0,
            "positionAt": Date().epochMillis,
            "volume": 0,
            "shuffling": false,
            "repeating": false,
        ]
        guard isRunning else { return publish(state, force: force) }
        let p = permission()
        state["permission"] = p.rawValue
        guard p == .granted else { return publish(state, force: force) }
        if readInFlight {
            refreshAgain = refreshAgain || force
            return
        }
        readInFlight = true
        runScript(Self.readSource) { [weak self] output, _ in
            guard let self else { return }
            self.readInFlight = false
            if let output, let info = Self.parsePlayer(output) {
                state.merge(info) { _, new in new }
                self.publish(state, force: force)
            } else if force {
                self.publish(state, force: true)
            }
            if self.refreshAgain {
                self.refreshAgain = false
                self.refresh(force: true)
            }
        }
    }

    private func publish(_ state: [String: Any], force: Bool) {
        let playing = (state["state"] as? String) == "playing"
        let signature = signatureOf(state)
        lastState = state
        if force || playing || signature != lastSentSignature {
            lastSentSignature = signature
            onState?(state)
        }
        if let track = state["track"] as? [String: Any], let id = track["id"] as? String, id != artworkTrackID {
            artworkTrackID = id
            loadArtwork(trackID: id, urlString: track["artworkUrl"] as? String)
        }
    }

    private func signatureOf(_ s: [String: Any]) -> String {
        let track = (s["track"] as? [String: Any])?["id"] as? String ?? "-"
        return [s["running"], s["permission"], s["state"], s["volume"], s["shuffling"], s["repeating"], track]
            .map { "\($0 ?? "")" }.joined(separator: "|")
    }

    // MARK: commands

    /// Execute a `spotify.command` from the lock page.
    func perform(action: String, value: Any?) {
        guard isRunning, permission() == .granted else { return }
        let command: String
        switch action {
        case "playpause": command = "playpause"
        case "play": command = "play"
        case "pause": command = "pause"
        case "next": command = "next track"
        case "previous": command = "previous track"
        case "volume":
            guard let v = Self.number(value), v.isFinite else { return }
            setVolume(Int(min(100, max(0, v.rounded()))))
            return
        case "shuffle":
            guard let b = value as? Bool else { return }
            command = "set shuffling to \(b ? "true" : "false")"
        case "repeat":
            guard let b = value as? Bool else { return }
            command = "set repeating to \(b ? "true" : "false")"
        case "seek":
            guard let ms = Self.number(value), ms.isFinite, ms >= 0 else { return }
            command = String(format: "set player position to %.2f", locale: Locale(identifier: "en_US_POSIX"), ms / 1000)
        case "playUri":
            // Only canonical spotify:<type>:<alnum id> URIs reach AppleScript, so nothing can be injected.
            guard let raw = value as? String, let uri = SpotifyURI.normalize(raw) else { return }
            command = "play track \"\(uri)\""
        default:
            return
        }
        runScript(Self.wrap(command)) { [weak self] _, _ in self?.refresh(force: true) }
    }

    /// Volume sliders fire many events; send at most one at a time, always the latest value.
    private func setVolume(_ volume: Int) {
        pendingVolume = volume
        guard !volumeInFlight else { return }
        volumeInFlight = true
        let v = volume
        pendingVolume = nil
        runScript(Self.wrap("set sound volume to \(v)")) { [weak self] _, _ in
            guard let self else { return }
            self.volumeInFlight = false
            if let next = self.pendingVolume, next != v { self.setVolume(next) } else { self.refresh(force: true) }
        }
    }

    /// Start a playlist if nothing is playing (session auto-play).
    func autoplay(uri: String) {
        guard let normalized = SpotifyURI.normalize(uri) else { return }
        var attempts = 0
        func attempt() {
            attempts += 1
            guard attempts <= 12 else { return }
            guard isRunning, permission() == .granted else { after(1.5, attempt); return }
            runScript(Self.readSource) { [weak self] output, _ in
                guard let self else { return }
                let info = output.flatMap(Self.parsePlayer)
                if info == nil { after(1.5, attempt); return }
                if (info?["state"] as? String) == "playing" { return }
                self.perform(action: "playUri", value: normalized)
            }
        }
        attempt()
    }

    private static func number(_ v: Any?) -> Double? {
        if let d = v as? Double { return d }
        if let n = v as? NSNumber { return n.doubleValue }
        if let s = v as? String { return Double(s) }
        return nil
    }

    // MARK: AppleScript

    private static let sep = "\u{1E}"

    /// Every script checks `running` first (which never launches the app) and bounds each Apple Event.
    private static func wrap(_ command: String) -> String {
        """
        if application id "\(bundleID)" is running then
            tell application id "\(bundleID)"
                with timeout of 2 seconds
                    \(command)
                end timeout
            end tell
        end if
        """
    }

    private static let readSource = """
    if application id "com.spotify.client" is running then
        tell application id "com.spotify.client"
            with timeout of 2 seconds
                set sep to character id 30
                set out to (player state as string)
                set tid to ""
                set tname to ""
                set tartist to ""
                set talbum to ""
                set tdur to 0
                set tart to ""
                try
                    set t to current track
                    set tid to (id of t) as string
                    set tname to (name of t) as string
                    set tartist to (artist of t) as string
                    set talbum to (album of t) as string
                    set tdur to (duration of t)
                    set tart to (artwork url of t) as string
                end try
                set pos to 0
                try
                    set pos to player position
                end try
                set out to out & sep & tid & sep & tname & sep & tartist & sep & talbum & sep & (tdur as string) & sep & tart
                set out to out & sep & (pos as string) & sep & ((sound volume) as string) & sep & ((shuffling) as string) & sep & ((repeating) as string)
                return out
            end timeout
        end tell
    end if
    return ""
    """

    static func parsePlayer(_ text: String) -> [String: Any]? {
        let f = text.components(separatedBy: sep)
        guard f.count >= 11 else { return nil }
        func num(_ s: String) -> Double { Double(s.replacingOccurrences(of: ",", with: ".").trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0 }
        let stateWord = f[0].lowercased()
        let state = stateWord.contains("play") ? "playing" : (stateWord.contains("pause") ? "paused" : "stopped")
        var info: [String: Any] = [
            "state": state,
            "positionMs": Int64(num(f[7]) * 1000),
            "positionAt": Date().epochMillis,
            "volume": Int(num(f[8])),
            "shuffling": f[9].trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "true",
            "repeating": f[10].trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "true",
        ]
        if !f[1].isEmpty {
            info["track"] = [
                "id": f[1],
                "name": f[2],
                "artist": f[3],
                "album": f[4],
                "durationMs": Int64(num(f[5])),
                "artworkUrl": f[6],
            ] as [String: Any]
        } else {
            info["track"] = NSNull()
        }
        return info
    }

    /// Run AppleScript without ever blocking the main thread: `osascript` on a serial queue, killed after 3 s.
    /// Completion runs on main with (output, errorNumber).
    ///
    /// If macOS turns out not to attribute osascript's Apple Events to Analog Brick (error -1743 although our own
    /// Automation permission is granted), fall back to in-process NSAppleScript; every event is still bounded
    /// by `with timeout of 2 seconds`.
    private func runScript(_ source: String, completion: ((String?, Int?) -> Void)? = nil) {
        if useInProcessScripts {
            let r = runInProcess(source)
            completion?(r.0, r.1)
            return
        }
        scriptQueue.async { [weak self] in
            let r = Self.osascript(source, timeout: 3)
            DispatchQueue.main.async {
                guard let self else { return }
                if r.1 == -1743 {
                    if Self.determinePermission(ask: false) == .granted {
                        Log.spotify.info("osascript events not attributed to the app; using in-process AppleScript")
                        self.useInProcessScripts = true
                        let again = self.runInProcess(source)
                        completion?(again.0, again.1)
                        return
                    }
                    self.permissionCache = (.denied, Date())
                    self.remember(.denied)
                }
                completion?(r.0, r.1)
            }
        }
    }

    private static func osascript(_ source: String, timeout: TimeInterval) -> (String?, Int?) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-"]
        let input = Pipe(), output = Pipe(), errors = Pipe()
        p.standardInput = input
        p.standardOutput = output
        p.standardError = errors
        do { try p.run() } catch { return (nil, -1) }
        input.fileHandleForWriting.write(Data(source.utf8))
        try? input.fileHandleForWriting.close()
        let killer = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: killer)
        let out = output.fileHandleForReading.readDataToEndOfFile()
        let err = errors.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        killer.cancel()
        if p.terminationReason == .exit && p.terminationStatus == 0 {
            var text = String(data: out, encoding: .utf8) ?? ""
            if text.hasSuffix("\n") { text.removeLast() }
            return (text, nil)
        }
        // osascript reports e.g. "…: execution error: Not authorized to send Apple events to Spotify. (-1743)"
        let message = String(data: err, encoding: .utf8) ?? ""
        var code = -1
        if let open = message.lastIndex(of: "("), let close = message.lastIndex(of: ")"), open < close,
           let n = Int(message[message.index(after: open)..<close]) {
            code = n
        }
        return (nil, code)
    }

    private func runInProcess(_ source: String) -> (String?, Int?) {
        guard let script = NSAppleScript(source: source) else { return (nil, -1) }
        var error: NSDictionary?
        let result = script.executeAndReturnError(&error)
        if let error {
            let code = error[NSAppleScript.errorNumber] as? Int ?? -1
            if code == -1743 { permissionCache = (.denied, Date()); remember(.denied) }
            return (nil, code)
        }
        return (result.stringValue ?? "", nil)
    }

    // MARK: artwork

    private func loadArtwork(trackID: String, urlString: String?) {
        guard let urlString, let url = URL(string: urlString), url.scheme == "https" else {
            publishArtwork(["trackId": trackID, "dataUrl": NSNull(), "palette": []])
            return
        }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            var payload: [String: Any] = ["trackId": trackID, "dataUrl": NSNull(), "palette": []]
            if let data, let (jpeg, palette) = Self.process(artwork: data) {
                payload["dataUrl"] = "data:image/jpeg;base64," + jpeg.base64EncodedString()
                payload["palette"] = palette
            }
            DispatchQueue.main.async {
                guard let self, self.artworkTrackID == trackID else { return }
                self.publishArtwork(payload)
            }
        }.resume()
    }

    private func publishArtwork(_ payload: [String: Any]) {
        lastArtwork = payload
        onArtwork?(payload)
    }

    /// 320 px JPEG for display + dominant colours.
    static func process(artwork data: Data) -> (Data, [String])? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 320,
        ]
        guard let thumb = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, thumb, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }

        let side = 48
        var pixels = [UInt8](repeating: 0, count: side * side * 4)
        let palette: [String] = pixels.withUnsafeMutableBytes { buf -> [String] in
            guard let ctx = CGContext(data: buf.baseAddress, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
                                      space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return [] }
            ctx.interpolationQuality = .medium
            ctx.draw(thumb, in: CGRect(x: 0, y: 0, width: side, height: side))
            return PaletteExtractor.extract(rgba: Array(buf.bindMemory(to: UInt8.self)), width: side, height: side, count: 4)
        }
        return (out as Data, palette)
    }
}
