import Foundation

/// One finished session, appended to the history log.
public struct SessionLogEntry: Codable, Equatable, Sendable {
    public var startedAt: Date
    public var plannedMs: Int64
    public var focusedMs: Int64
    public var completed: Bool

    public init(startedAt: Date, plannedMs: Int64, focusedMs: Int64, completed: Bool) {
        self.startedAt = startedAt
        self.plannedMs = plannedMs
        self.focusedMs = focusedMs
        self.completed = completed
    }
}

public struct StatsSummary: Equatable, Sendable {
    public var todayMs: Int64
    public var weekMs: Int64
    public var streakDays: Int
    public var totalSessions: Int
    public var recent: [SessionLogEntry]

    public func payload() -> [String: Any] {
        [
            "todayMs": todayMs,
            "weekMs": weekMs,
            "streakDays": streakDays,
            "totalSessions": totalSessions,
            "recent": recent.map {
                [
                    "startedAt": $0.startedAt.epochMillis,
                    "plannedMs": $0.plannedMs,
                    "focusedMs": $0.focusedMs,
                    "completed": $0.completed,
                ] as [String: Any]
            },
        ]
    }
}

public enum StatsCalculator {
    /// - today: focused time in sessions started today (local calendar day)
    /// - week: focused time in the last 7 calendar days including today
    /// - streak: consecutive days, ending today (or yesterday if nothing yet today), with ≥ 1 completed session
    public static func summarize(_ log: [SessionLogEntry], now: Date, calendar: Calendar = .current, recentLimit: Int = 30) -> StatsSummary {
        let startOfToday = calendar.startOfDay(for: now)
        let weekStart = calendar.date(byAdding: .day, value: -6, to: startOfToday) ?? startOfToday

        var today: Int64 = 0, week: Int64 = 0
        var completedDays = Set<Date>()
        for e in log {
            let day = calendar.startOfDay(for: e.startedAt)
            if day == startOfToday { today += e.focusedMs }
            if day >= weekStart && e.startedAt <= now { week += e.focusedMs }
            if e.completed { completedDays.insert(day) }
        }

        var streak = 0
        var cursor = completedDays.contains(startOfToday) ? startOfToday : (calendar.date(byAdding: .day, value: -1, to: startOfToday) ?? startOfToday)
        while completedDays.contains(cursor) {
            streak += 1
            guard let prev = calendar.date(byAdding: .day, value: -1, to: cursor) else { break }
            cursor = prev
        }

        let recent = Array(log.sorted { $0.startedAt > $1.startedAt }.prefix(recentLimit))
        return StatsSummary(todayMs: today, weekMs: week, streakDays: streak, totalSessions: log.count, recent: recent)
    }
}
