import AppKit
import IOKit.pwr_mgt
import ServiceManagement

/// Turns a Focus mode (e.g. Do Not Disturb) on/off through two user-made Shortcuts.
/// macOS has no public API for Focus, but `shortcuts run` + the "Set Focus" action is reliable.
final class FocusManager {
    static let onName = "Analog Brick Focus On"
    static let offName = "Analog Brick Focus Off"
    private static let cli = "/usr/bin/shortcuts"

    private(set) var known: Set<String> = []
    private(set) var lastChecked: Date?

    var isAvailable: Bool { FileManager.default.isExecutableFile(atPath: Self.cli) }
    var hasOn: Bool { known.contains(Self.onName) }
    var hasOff: Bool { known.contains(Self.offName) }

    func statusPayload() -> [String: Any] {
        [
            "shortcutsAvailable": isAvailable,
            "onName": Self.onName,
            "offName": Self.offName,
            "hasOn": hasOn,
            "hasOff": hasOff,
        ]
    }

    /// Re-read the user's shortcut names (async; ~0.3 s).
    func refresh(completion: (() -> Void)? = nil) {
        guard isAvailable else { completion?(); return }
        Self.exec(["list"]) { [weak self] ok, output in
            if ok {
                self?.known = Set(output.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) })
                self?.lastChecked = Date()
            }
            completion?()
        }
    }

    func turnOn(completion: ((Bool) -> Void)? = nil) { run(Self.onName, completion: completion) }
    func turnOff(completion: ((Bool) -> Void)? = nil) { run(Self.offName, completion: completion) }

    func run(_ name: String, completion: ((Bool) -> Void)? = nil) {
        guard isAvailable else { completion?(false); return }
        Self.exec(["run", name]) { ok, _ in
            if !ok { Log.app.info("Shortcut \"\(name, privacy: .public)\" did not run (missing?)") }
            completion?(ok)
        }
    }

    func openShortcutsApp() {
        let ws = NSWorkspace.shared
        if let url = ws.urlForApplication(withBundleIdentifier: "com.apple.shortcuts") {
            ws.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
        }
    }

    /// Runs the CLI off the main thread; completion on main.
    private static func exec(_ args: [String], completion: @escaping (Bool, String) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: Self.cli)
            p.arguments = args
            let out = Pipe()
            p.standardOutput = out
            p.standardError = Pipe()
            var ok = false
            var text = ""
            do {
                try p.run()
                let data = out.fileHandleForReading.readDataToEndOfFile()
                p.waitUntilExit()
                ok = p.terminationStatus == 0
                text = String(data: data, encoding: .utf8) ?? ""
            } catch {
                ok = false
            }
            DispatchQueue.main.async { completion(ok, text) }
        }
    }
}

/// Keeps the displays from sleeping while a session runs (the visuals are the point).
final class PowerAssertion {
    private var id: IOPMAssertionID = 0
    private(set) var isActive = false

    func begin(reason: String) {
        guard !isActive else { return }
        let result = IOPMAssertionCreateWithName(
            kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn),
            reason as CFString,
            &id)
        isActive = result == kIOReturnSuccess
    }

    func end() {
        guard isActive else { return }
        IOPMAssertionRelease(id)
        isActive = false
    }

    deinit { end() }
}

/// A launch agent (Contents/Library/LaunchAgents) that starts the app with `--resume-only` at login,
/// so a session interrupted by a restart picks up where it left off. It exits at once if no session is active.
enum LoginItem {
    static let plistName = "com.analogbrick.AnalogBrick.resume.plist"

    static var service: SMAppService { SMAppService.agent(plistName: plistName) }

    static func status() -> String {
        switch service.status {
        case .enabled: return "enabled"
        case .requiresApproval: return "requiresApproval"
        case .notRegistered: return "notRegistered"
        case .notFound: return "notFound"
        @unknown default: return "unsupported"
        }
    }

    static func setEnabled(_ on: Bool) {
        let s = service
        do {
            if on {
                if s.status == .notRegistered || s.status == .notFound { try s.register() }
            } else if s.status == .enabled || s.status == .requiresApproval {
                try s.unregister()
            }
        } catch {
            Log.app.error("Login item \(on ? "register" : "unregister", privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    static func openSettings() { SMAppService.openSystemSettingsLoginItems() }
}
