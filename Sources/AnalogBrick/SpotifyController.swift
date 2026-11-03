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
    private var scripts: [String: NSAppleScript] = [:]
    private var lastSentSignature = ""

    // MARK: status

    var isInstalled: Bool { appURL != nil }
    var appURL: URL? { NSWorkspace.shared.urlForApplication(withBundleIdentifier: Self.bundleID) }
    var runningApp: NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: Self.bundleID).first { !$0.isTerminated }
    }
    var isRunning: Bool { runningApp != nil }

    /// Automation permission for Spotify, without prompting. Cached for a few seconds.
    func permission() -> Permission {
        if let cached = permissionCache, Date().timeIntervalSince(cached.1) < 5 { return cached.0 }
        let p = Self.determinePermission(ask: false)
        if p != .unknown { permissionCache = (p, Date()) }
        return p
    }

    /// Ask for Automation permission (shows the system prompt). Spotify must be running.
    /// Blocks while the prompt is up, so this runs off the main thread.
    func requestPermission(completion: @escaping (Permission) -> Void) {
        let ask = {
            DispatchQueue.global(qos: .userInitiated).async {
                let p = Self.determinePermission(ask: true)
                DispatchQueue.main.async {
                    self.permissionCache = (p, Date())
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

    func statusPayload() -> [String: Any] {
        ["installed": isInstalled, "running": isRunning, "permission": permission().rawValue]
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

    /// Read the player state and publish it (only when something changed, or every poll while playing).
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
        if isRunning {
            let p = permission()
            state["permission"] = p.rawValue
            if p == .granted, let info = readPlayer() {
                state.merge(info) { _, new in new }
            }
        }
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
        let source: String
        switch action {
        case "playpause": source = "playpause"
        case "play": source = "play"
        case "pause": source = "pause"
        case "next": source = "next track"
        case "previous": source = "previous track"
        case "volume":
            guard let v = Self.number(value) else { return }
            source = "set sound volume to \(Int(min(100, max(0, v.rounded()))))"
        case "shuffle":
            guard let b = value as? Bool else { return }
            source = "set shuffling to \(b ? "true" : "false")"
        case "repeat":
            guard let b = value as? Bool else { return }
            source = "set repeating to \(b ? "true" : "false")"
        case "seek":
            guard let ms = Self.number(value), ms.isFinite, ms >= 0 else { return }
            source = String(format: "set player position to %.2f", locale: Locale(identifier: "en_US_POSIX"), ms / 1000)
        case "playUri":
            // Only canonical spotify:<type>:<alnum id> URIs reach AppleScript, so nothing can be injected.
            guard let raw = value as? String, let uri = SpotifyURI.normalize(raw) else { return }
            source = "play track \"\(uri)\""
        default:
            return
        }
        run("tell application id \"\(Self.bundleID)\" to \(source)")
        after(0.25) { [weak self] in self?.refresh(force: true) }
    }

    /// Start a playlist if nothing is playing (session auto-play).
    func autoplay(uri: String) {
        guard let normalized = SpotifyURI.normalize(uri) else { return }
        var attempts = 0
        func attempt() {
            attempts += 1
            guard attempts <= 12 else { return }
            guard isRunning, permission() == .granted else { after(1.5, attempt); return }
            if let info = readPlayer(), (info["state"] as? String) == "playing" { return }
            perform(action: "playUri", value: normalized)
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

    private static let readSource = """
    tell application id "com.spotify.client"
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
    end tell
    """

    private func readPlayer() -> [String: Any]? {
        guard let text = run(Self.readSource, cacheKey: "read") else { return nil }
        let f = text.components(separatedBy: Self.sep)
        guard f.count >= 11 else { return nil }
        func num(_ s: String) -> Double { Double(s.replacingOccurrences(of: ",", with: ".").trimmingCharacters(in: .whitespaces)) ?? 0 }
        let stateWord = f[0].lowercased()
        let state = stateWord.contains("play") ? "playing" : (stateWord.contains("pause") ? "paused" : "stopped")
        var info: [String: Any] = [
            "state": state,
            "positionMs": Int64(num(f[7]) * 1000),
            "positionAt": Date().epochMillis,
            "volume": Int(num(f[8])),
            "shuffling": f[9].lowercased() == "true",
            "repeating": f[10].lowercased() == "true",
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

    @discardableResult
    private func run(_ source: String, cacheKey: String? = nil) -> String? {
        let script: NSAppleScript
        if let key = cacheKey, let cached = scripts[key] {
            script = cached
        } else {
            guard let s = NSAppleScript(source: source) else { return nil }
            var compileError: NSDictionary?
            if !s.compileAndReturnError(&compileError) {
                Log.spotify.error("AppleScript compile failed: \(String(describing: compileError), privacy: .public)")
                return nil
            }
            if let key = cacheKey { scripts[key] = s }
            script = s
        }
        var error: NSDictionary?
        let result = script.executeAndReturnError(&error)
        if let error {
            let code = error[NSAppleScript.errorNumber] as? Int ?? 0
            if code == -1743 { permissionCache = (.denied, Date()) }
            Log.spotify.debug("AppleScript error \(code): \(String(describing: error[NSAppleScript.errorMessage]), privacy: .public)")
            return nil
        }
        return result.stringValue
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
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
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
