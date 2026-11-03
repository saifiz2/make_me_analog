import Foundation
import BrickCore

/// Settings, the active session and session history, as JSON files in
/// ~/Library/Application Support/Analog Brick/.
final class Store {
    let directory: URL
    private(set) var settings: Settings

    private var settingsURL: URL { directory.appendingPathComponent("settings.json") }
    private var sessionURL: URL { directory.appendingPathComponent("session.json") }
    private var historyURL: URL { directory.appendingPathComponent("history.json") }

    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        e.dateEncodingStrategy = .millisecondsSince1970
        return e
    }()
    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .millisecondsSince1970
        return d
    }()

    init(directory: URL? = nil) {
        let base = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Analog Brick", isDirectory: true)
        self.directory = base
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        settings = Settings()
        if let data = try? Data(contentsOf: settingsURL), let s = try? decoder.decode(Settings.self, from: data) {
            settings = s
        }
    }

    // MARK: settings

    func update(_ change: (inout Settings) -> Void) {
        var s = settings
        change(&s)
        settings = s.normalized()
        write(settings, to: settingsURL)
    }

    func replaceSettings(_ s: Settings) {
        settings = s.normalized()
        write(settings, to: settingsURL)
    }

    // MARK: active session

    func loadSession() -> SessionRecord? {
        guard let data = try? Data(contentsOf: sessionURL) else { return nil }
        return try? decoder.decode(SessionRecord.self, from: data)
    }

    func saveSession(_ record: SessionRecord?) {
        guard let record else {
            try? FileManager.default.removeItem(at: sessionURL)
            return
        }
        write(record, to: sessionURL, permissions: 0o600)
    }

    // MARK: history

    func loadHistory() -> [SessionLogEntry] {
        guard let data = try? Data(contentsOf: historyURL) else { return [] }
        return (try? decoder.decode([SessionLogEntry].self, from: data)) ?? []
    }

    func appendHistory(_ entry: SessionLogEntry) {
        var log = loadHistory()
        log.append(entry)
        if log.count > 2000 { log.removeFirst(log.count - 2000) }
        write(log, to: historyURL)
    }

    func stats(now: Date = Date()) -> StatsSummary {
        StatsCalculator.summarize(loadHistory(), now: now)
    }

    // MARK: io

    private func write<T: Encodable>(_ value: T, to url: URL, permissions: Int? = nil) {
        do {
            let data = try encoder.encode(value)
            try data.write(to: url, options: .atomic)
            if let permissions {
                try? FileManager.default.setAttributes([.posixPermissions: permissions], ofItemAtPath: url.path)
            }
        } catch {
            Log.app.error("Failed to write \(url.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }
}
