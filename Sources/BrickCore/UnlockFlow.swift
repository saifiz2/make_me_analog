import Foundation

/// The early-unlock ritual: enter the PIN, confirm "are you sure?", three times over.
///
/// The native side owns this state machine; the web UI only renders what it is told
/// (see docs/BRIDGE.md, event `unlock`). Every method takes `now` so it is fully testable.
public final class UnlockFlow {
    public enum Stage: String, Codable, Sendable {
        case idle, pin, confirm, cooldown, unlocked
    }

    public struct State: Equatable, Sendable {
        public var stage: Stage = .idle
        public var step: Int = 1
        public var error: String? = nil
        public var wrongAttempts: Int = 0
        public var cooldownUntil: Date? = nil
        public var confirmEnteredAt: Date? = nil
    }

    public let totalSteps: Int
    public let confirmDelay: TimeInterval
    public let maxWrongBeforeCooldown: Int
    public let baseCooldown: TimeInterval
    public let maxCooldown: TimeInterval
    public let inactivityTimeout: TimeInterval
    public let pinLength: Int

    public private(set) var state = State()
    private var cooldownCount = 0
    private var lastActivity: Date = .distantPast
    private let verify: (String) -> Bool

    public init(
        pinLength: Int,
        confirmDelay: TimeInterval = 3,
        totalSteps: Int = 3,
        maxWrongBeforeCooldown: Int = 5,
        baseCooldown: TimeInterval = 60,
        maxCooldown: TimeInterval = 15 * 60,
        inactivityTimeout: TimeInterval = 60,
        verify: @escaping (String) -> Bool
    ) {
        self.pinLength = pinLength
        self.confirmDelay = max(0, confirmDelay)
        self.totalSteps = max(1, totalSteps)
        self.maxWrongBeforeCooldown = max(1, maxWrongBeforeCooldown)
        self.baseCooldown = baseCooldown
        self.maxCooldown = maxCooldown
        self.inactivityTimeout = inactivityTimeout
        self.verify = verify
    }

    public var isUnlocked: Bool { state.stage == .unlocked }

    /// "Unlock early" pressed.
    public func begin(now: Date) {
        lastActivity = now
        guard state.stage == .idle else { return }
        state.stage = .pin
        state.step = 1
        state.error = nil
        state.confirmEnteredAt = nil
    }

    public func submit(pin: String, now: Date) {
        lastActivity = now
        guard state.stage == .pin else { return }
        if PinPolicy.isValid(pin) && verify(pin) {
            state.stage = .confirm
            state.error = nil
            state.wrongAttempts = 0
            state.confirmEnteredAt = now
            return
        }
        state.wrongAttempts += 1
        state.error = "wrong-pin"
        if state.wrongAttempts >= maxWrongBeforeCooldown {
            cooldownCount += 1
            let duration = min(maxCooldown, baseCooldown * pow(2, Double(cooldownCount - 1)))
            state.stage = .cooldown
            state.cooldownUntil = now.addingTimeInterval(duration)
            state.step = 1
            state.confirmEnteredAt = nil
        }
    }

    /// "Yes, I'm sure". Ignored until `confirmDelay` has passed since the confirm stage began.
    public func confirm(now: Date) {
        lastActivity = now
        guard state.stage == .confirm, let entered = state.confirmEnteredAt else { return }
        // Small tolerance so a UI timer that fires a hair early isn't rejected.
        guard now.timeIntervalSince(entered) >= confirmDelay - 0.15 else { return }
        state.confirmEnteredAt = nil
        state.error = nil
        if state.step < totalSteps {
            state.step += 1
            state.stage = .pin
        } else {
            state.stage = .unlocked
        }
    }

    /// "Keep focusing" / Escape. Consecutive wrong attempts are kept so cancel can't dodge the cooldown.
    public func cancel(now: Date) {
        lastActivity = now
        guard state.stage == .pin || state.stage == .confirm else { return }
        reset()
    }

    public func activity(now: Date) { lastActivity = now }

    /// Call about once a second. Returns true if the state changed.
    @discardableResult
    public func tick(now: Date) -> Bool {
        switch state.stage {
        case .cooldown:
            if let until = state.cooldownUntil, now >= until {
                reset()
                state.wrongAttempts = 0
                return true
            }
        case .pin, .confirm:
            if now.timeIntervalSince(lastActivity) >= inactivityTimeout {
                reset()
                return true
            }
        case .idle, .unlocked:
            break
        }
        return false
    }

    private func reset() {
        state.stage = .idle
        state.step = 1
        state.error = nil
        state.cooldownUntil = nil
        state.confirmEnteredAt = nil
    }

    /// Payload for the bridge `unlock` event.
    public func payload() -> [String: Any] {
        var p: [String: Any] = [
            "stage": state.stage.rawValue,
            "step": state.step,
            "totalSteps": totalSteps,
            "wrongAttempts": state.wrongAttempts,
            "confirmDelayMs": Int(confirmDelay * 1000),
            "pinLength": pinLength,
        ]
        p["error"] = state.error ?? NSNull()
        if let until = state.cooldownUntil {
            p["cooldownUntil"] = until.epochMillis
        } else {
            p["cooldownUntil"] = NSNull()
        }
        return p
    }
}

public extension Date {
    /// Milliseconds since 1970, the timestamp scale the web side uses.
    var epochMillis: Int64 { Int64((timeIntervalSince1970 * 1000).rounded()) }
    init(epochMillis: Int64) { self.init(timeIntervalSince1970: Double(epochMillis) / 1000) }
}
