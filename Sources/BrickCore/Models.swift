import Foundation

public struct QuickPlaylist: Codable, Equatable, Sendable {
    public var name: String
    public var uri: String

    public init(name: String, uri: String) {
        self.name = name
        self.uri = uri
    }
}

public enum VisualMode {
    public static let all = ["aurora", "drift", "breath", "horizon", "night", "pulse", "gallery"]
    public static let fallback = "aurora"
}

/// User preferences, persisted as JSON. Every field has a default so older files keep decoding.
public struct Settings: Codable, Equatable, Sendable {
    public var durationMin: Int = 50
    public var mode: String = "aurora"
    public var quality: String = "balanced"
    public var intention: String = ""
    public var keepAwake: Bool = true
    public var showTimerOnSecondary: Bool = true
    public var resumeAfterRestart: Bool = true
    public var focusEnabled: Bool = true
    public var launchSpotify: Bool = true
    public var autoplayUri: String = ""
    public var quickPlaylists: [QuickPlaylist] = Settings.defaultPlaylists
    public var confirmDelaySec: Int = 3
    public var peekSeconds: Int = 90
    public var breathPattern: String = "box"
    public var galleryFolder: String? = nil

    public static let qualities = ["saver", "balanced", "high"]
    public static let breathPatterns = ["box", "coherent", "relax"]
    public static let durationRange = 1...480
    public static let confirmDelayRange = 0...10
    public static let peekRange = 30...300

    public static let defaultPlaylists: [QuickPlaylist] = [
        QuickPlaylist(name: "Deep Focus", uri: "spotify:playlist:37i9dQZF1DWZeKCadgRdKQ"),
        QuickPlaylist(name: "Peaceful Piano", uri: "spotify:playlist:37i9dQZF1DX4sWSpwq3LiO"),
        QuickPlaylist(name: "lofi beats", uri: "spotify:playlist:37i9dQZF1DWWQRwui0ExPn"),
    ]

    public init() {}

    private enum CodingKeys: String, CodingKey {
        case durationMin, mode, quality, intention, keepAwake, showTimerOnSecondary, resumeAfterRestart,
             focusEnabled, launchSpotify, autoplayUri, quickPlaylists, confirmDelaySec, peekSeconds,
             breathPattern, galleryFolder
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var s = Settings()
        s.durationMin = (try? c.decodeIfPresent(Int.self, forKey: .durationMin)) ?? s.durationMin
        s.mode = (try? c.decodeIfPresent(String.self, forKey: .mode)) ?? s.mode
        s.quality = (try? c.decodeIfPresent(String.self, forKey: .quality)) ?? s.quality
        s.intention = (try? c.decodeIfPresent(String.self, forKey: .intention)) ?? s.intention
        s.keepAwake = (try? c.decodeIfPresent(Bool.self, forKey: .keepAwake)) ?? s.keepAwake
        s.showTimerOnSecondary = (try? c.decodeIfPresent(Bool.self, forKey: .showTimerOnSecondary)) ?? s.showTimerOnSecondary
        s.resumeAfterRestart = (try? c.decodeIfPresent(Bool.self, forKey: .resumeAfterRestart)) ?? s.resumeAfterRestart
        s.focusEnabled = (try? c.decodeIfPresent(Bool.self, forKey: .focusEnabled)) ?? s.focusEnabled
        s.launchSpotify = (try? c.decodeIfPresent(Bool.self, forKey: .launchSpotify)) ?? s.launchSpotify
        s.autoplayUri = (try? c.decodeIfPresent(String.self, forKey: .autoplayUri)) ?? s.autoplayUri
        s.quickPlaylists = (try? c.decodeIfPresent([QuickPlaylist].self, forKey: .quickPlaylists)) ?? s.quickPlaylists
        s.confirmDelaySec = (try? c.decodeIfPresent(Int.self, forKey: .confirmDelaySec)) ?? s.confirmDelaySec
        s.peekSeconds = (try? c.decodeIfPresent(Int.self, forKey: .peekSeconds)) ?? s.peekSeconds
        s.breathPattern = (try? c.decodeIfPresent(String.self, forKey: .breathPattern)) ?? s.breathPattern
        s.galleryFolder = (try? c.decodeIfPresent(String.self, forKey: .galleryFolder)) ?? nil
        self = s.normalized()
    }

    /// Clamp and sanitise every field.
    public func normalized() -> Settings {
        var s = self
        s.durationMin = s.durationMin.clamped(to: Settings.durationRange)
        if !VisualMode.all.contains(s.mode) { s.mode = VisualMode.fallback }
        if !Settings.qualities.contains(s.quality) { s.quality = "balanced" }
        s.intention = String(s.intention.trimmingCharacters(in: .whitespacesAndNewlines).prefix(140))
        s.confirmDelaySec = s.confirmDelaySec.clamped(to: Settings.confirmDelayRange)
        s.peekSeconds = s.peekSeconds.clamped(to: Settings.peekRange)
        if !Settings.breathPatterns.contains(s.breathPattern) { s.breathPattern = "box" }
        s.quickPlaylists = s.quickPlaylists.compactMap { p in
            guard let uri = SpotifyURI.normalize(p.uri) else { return nil }
            let name = p.name.trimmingCharacters(in: .whitespacesAndNewlines)
            return QuickPlaylist(name: name.isEmpty ? "Playlist" : String(name.prefix(60)), uri: uri)
        }
        if s.quickPlaylists.count > 12 { s.quickPlaylists = Array(s.quickPlaylists.prefix(12)) }
        if s.autoplayUri.isEmpty {
            s.autoplayUri = ""
        } else {
            s.autoplayUri = SpotifyURI.normalize(s.autoplayUri) ?? ""
        }
        if let folder = s.galleryFolder, folder.isEmpty { s.galleryFolder = nil }
        return s
    }

    /// Apply a partial update coming from the setup page (`settings.save`). Unknown keys and
    /// wrongly-typed values are ignored. Returns the normalised result.
    public func applying(_ patch: [String: Any]) -> Settings {
        var s = self
        func int(_ key: String) -> Int? {
            if let v = patch[key] as? Int { return v }
            if let v = patch[key] as? Double, v.isFinite { return Int(v.rounded()) }
            if let v = patch[key] as? NSNumber { return v.intValue }
            if let v = patch[key] as? String { return Int(v) }
            return nil
        }
        func bool(_ key: String) -> Bool? {
            if let v = patch[key] as? Bool { return v }
            if let v = patch[key] as? NSNumber { return v.boolValue }
            return nil
        }
        func str(_ key: String) -> String? { patch[key] as? String }

        if let v = int("durationMin") { s.durationMin = v }
        if let v = str("mode") { s.mode = v }
        if let v = str("quality") { s.quality = v }
        if let v = str("intention") { s.intention = v }
        if let v = bool("keepAwake") { s.keepAwake = v }
        if let v = bool("showTimerOnSecondary") { s.showTimerOnSecondary = v }
        if let v = bool("resumeAfterRestart") { s.resumeAfterRestart = v }
        if let v = bool("focusEnabled") { s.focusEnabled = v }
        if let v = bool("launchSpotify") { s.launchSpotify = v }
        if let v = str("autoplayUri") { s.autoplayUri = v }
        if let v = int("confirmDelaySec") { s.confirmDelaySec = v }
        if let v = int("peekSeconds") { s.peekSeconds = v }
        if let v = str("breathPattern") { s.breathPattern = v }
        if let list = patch["quickPlaylists"] as? [[String: Any]] {
            s.quickPlaylists = list.compactMap { item in
                guard let uri = item["uri"] as? String else { return nil }
                return QuickPlaylist(name: (item["name"] as? String) ?? "", uri: uri)
            }
        }
        return s.normalized()
    }

    /// JSON-ready dictionary for the bridge (`init.settings` / `settings`).
    public func payload() -> [String: Any] {
        [
            "durationMin": durationMin,
            "mode": mode,
            "quality": quality,
            "intention": intention,
            "keepAwake": keepAwake,
            "showTimerOnSecondary": showTimerOnSecondary,
            "resumeAfterRestart": resumeAfterRestart,
            "focusEnabled": focusEnabled,
            "launchSpotify": launchSpotify,
            "autoplayUri": autoplayUri,
            "quickPlaylists": quickPlaylists.map { ["name": $0.name, "uri": $0.uri] },
            "confirmDelaySec": confirmDelaySec,
            "peekSeconds": peekSeconds,
            "breathPattern": breathPattern,
        ]
    }
}

/// An active (or interrupted) focus session, persisted so the lock survives a restart.
public struct SessionRecord: Codable, Equatable, Sendable {
    public var id: String
    public var startedAt: Date
    public var endsAt: Date
    public var intention: String
    public var mode: String
    public var pin: PinHash
    public var pinLength: Int

    public init(id: String = UUID().uuidString, startedAt: Date, endsAt: Date, intention: String, mode: String, pin: PinHash, pinLength: Int) {
        self.id = id
        self.startedAt = startedAt
        self.endsAt = endsAt
        self.intention = intention
        self.mode = mode
        self.pin = pin
        self.pinLength = pinLength
    }

    public var duration: TimeInterval { endsAt.timeIntervalSince(startedAt) }
    public func isActive(at now: Date) -> Bool { now < endsAt }
    public func remaining(at now: Date) -> TimeInterval { max(0, endsAt.timeIntervalSince(now)) }
}

/// Validated request to start a session (from `session.start`).
public struct SessionRequest: Equatable, Sendable {
    public var durationMin: Int
    public var pin: String
    public var mode: String
    public var intention: String

    public enum ValidationError: Error, Equatable, CustomStringConvertible {
        case invalidPin, invalidDuration

        public var description: String {
            switch self {
            case .invalidPin: return "Your PIN must be 4–8 digits."
            case .invalidDuration: return "Choose a session between 1 minute and 8 hours."
            }
        }
    }

    /// Parse and validate the bridge payload.
    public static func parse(_ payload: [String: Any]) -> Result<SessionRequest, ValidationError> {
        let pin = (payload["pin"] as? String) ?? ""
        guard PinPolicy.isValid(pin) else { return .failure(.invalidPin) }
        var minutes: Int?
        if let v = payload["durationMin"] as? Int { minutes = v }
        else if let v = payload["durationMin"] as? Double, v.isFinite { minutes = Int(v.rounded()) }
        else if let v = payload["durationMin"] as? NSNumber { minutes = v.intValue }
        else if let v = payload["durationMin"] as? String { minutes = Int(v) }
        guard let m = minutes, Settings.durationRange.contains(m) else { return .failure(.invalidDuration) }
        var mode = (payload["mode"] as? String) ?? VisualMode.fallback
        if !VisualMode.all.contains(mode) { mode = VisualMode.fallback }
        let intention = String(((payload["intention"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(140))
        return .success(SessionRequest(durationMin: m, pin: pin, mode: mode, intention: intention))
    }
}

/// Spotify URIs and open.spotify.com links → canonical `spotify:<type>:<id>`.
public enum SpotifyURI {
    static let types: Set<String> = ["playlist", "album", "track", "artist", "show", "episode"]

    public static func normalize(_ raw: String) -> String? {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if s.hasPrefix("spotify:") {
            let parts = s.split(separator: ":").map(String.init)
            // spotify:playlist:ID  or legacy spotify:user:NAME:playlist:ID
            if parts.count == 3, types.contains(parts[1]), isID(parts[2]) { return "spotify:\(parts[1]):\(parts[2])" }
            if parts.count == 5, parts[1] == "user", parts[3] == "playlist", isID(parts[4]) { return "spotify:playlist:\(parts[4])" }
            return nil
        }
        guard let url = URL(string: s), let host = url.host?.lowercased(),
              host == "open.spotify.com" || host == "play.spotify.com" else { return nil }
        var comps = url.path.split(separator: "/").map(String.init)
        if let first = comps.first, first.hasPrefix("intl-") { comps.removeFirst() }
        if comps.count >= 4, comps[0] == "user", comps[2] == "playlist" { comps = Array(comps[2...]) }
        guard comps.count >= 2, types.contains(comps[0]), isID(comps[1]) else { return nil }
        return "spotify:\(comps[0]):\(comps[1])"
    }

    static func isID(_ s: String) -> Bool {
        !s.isEmpty && s.count <= 64 && s.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) }
    }
}

extension Comparable {
    func clamped(to r: ClosedRange<Self>) -> Self { min(max(self, r.lowerBound), r.upperBound) }
}
