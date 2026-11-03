import AppKit
import os

enum Log {
    static let subsystem = Bundle.main.bundleIdentifier ?? "com.analogbrick.AnalogBrick"
    static let app = Logger(subsystem: subsystem, category: "app")
    static let lock = Logger(subsystem: subsystem, category: "lock")
    static let spotify = Logger(subsystem: subsystem, category: "spotify")
    static let audio = Logger(subsystem: subsystem, category: "audio")
    static let web = Logger(subsystem: subsystem, category: "web")
}

enum AppInfo {
    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }
    static var bundleID: String { Bundle.main.bundleIdentifier ?? "com.analogbrick.AnalogBrick" }
    static var isDebug: Bool { ProcessInfo.processInfo.environment["ANALOG_BRICK_DEBUG"] != nil }

    /// Where the web UI lives: $ANALOG_BRICK_WEB_ROOT, the app bundle's Resources/web, or ./web next to a dev build.
    static let webRoot: URL = {
        let fm = FileManager.default
        if let env = ProcessInfo.processInfo.environment["ANALOG_BRICK_WEB_ROOT"], !env.isEmpty {
            return URL(fileURLWithPath: env, isDirectory: true).standardizedFileURL
        }
        if let res = Bundle.main.resourceURL?.appendingPathComponent("web", isDirectory: true),
           fm.fileExists(atPath: res.appendingPathComponent("lock.html").path) {
            return res.standardizedFileURL
        }
        // `swift run` from the repo: .build/<config>/AnalogBrick → walk up to find web/.
        var dir = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().deletingLastPathComponent()
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("web", isDirectory: true)
            if fm.fileExists(atPath: candidate.appendingPathComponent("lock.html").path) { return candidate.standardizedFileURL }
            dir.deleteLastPathComponent()
        }
        return URL(fileURLWithPath: fm.currentDirectoryPath).appendingPathComponent("web", isDirectory: true)
    }()
}

enum JSON {
    /// Serialise a bridge message as a JS expression-safe JSON string.
    static func string(_ object: Any) -> String? {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed]),
              var s = String(data: data, encoding: .utf8) else { return nil }
        // U+2028/2029 are legal in JSON but historically not in JS string literals.
        s = s.replacingOccurrences(of: "\u{2028}", with: "\\u2028").replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        return s
    }
}

extension NSScreen {
    var displayID: CGDirectDisplayID {
        (deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
    }
}

extension Dictionary where Key == String, Value == Any {
    func string(_ key: String) -> String? { self[key] as? String }
    func bool(_ key: String) -> Bool? {
        if let b = self[key] as? Bool { return b }
        if let n = self[key] as? NSNumber { return n.boolValue }
        return nil
    }
    func double(_ key: String) -> Double? {
        if let d = self[key] as? Double { return d }
        if let n = self[key] as? NSNumber { return n.doubleValue }
        if let s = self[key] as? String { return Double(s) }
        return nil
    }
}

/// Run a closure on the main queue after a delay.
func after(_ seconds: TimeInterval, _ work: @escaping () -> Void) {
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
}
