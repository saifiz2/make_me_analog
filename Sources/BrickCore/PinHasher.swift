import Foundation

/// Rules for a session PIN.
public enum PinPolicy {
    public static let minLength = 4
    public static let maxLength = 8

    /// 4–8 ASCII digits.
    public static func isValid(_ pin: String) -> Bool {
        guard (minLength...maxLength).contains(pin.count) else { return false }
        return pin.unicodeScalars.allSatisfy { $0.value >= 48 && $0.value <= 57 }
    }
}

/// A salted, iterated SHA-256 of a PIN. Stored with the active session so the lock can be
/// resumed after a restart without keeping the PIN itself on disk.
///
/// A 4–8 digit PIN can never be strongly protected against someone with the file; the goal is
/// only that the PIN is not sitting there in plain sight. Analog Brick is a commitment device.
public struct PinHash: Codable, Equatable, Sendable {
    public var salt: String        // hex
    public var iterations: Int
    public var digest: String      // hex

    public static let defaultIterations = 20_000

    public static func make(pin: String, iterations: Int = defaultIterations, salt: [UInt8]? = nil) -> PinHash {
        let saltBytes = salt ?? PinHash.randomSalt()
        let digest = PinHash.derive(pin: pin, salt: saltBytes, iterations: iterations)
        return PinHash(salt: SHA256.hex(saltBytes), iterations: iterations, digest: SHA256.hex(digest))
    }

    public func verify(_ pin: String) -> Bool {
        guard let saltBytes = PinHash.bytes(fromHex: salt) else { return false }
        let candidate = SHA256.hex(PinHash.derive(pin: pin, salt: saltBytes, iterations: iterations))
        return PinHash.constantTimeEquals(candidate, digest)
    }

    static func derive(pin: String, salt: [UInt8], iterations: Int) -> [UInt8] {
        var block = SHA256.hash(salt + Array(pin.utf8))
        let n = max(1, iterations)
        if n > 1 {
            for _ in 1..<n { block = SHA256.hash(block + salt) }
        }
        return block
    }

    static func randomSalt() -> [UInt8] {
        var g = SystemRandomNumberGenerator()
        return (0..<16).map { _ in UInt8.random(in: 0...255, using: &g) }
    }

    static func bytes(fromHex hex: String) -> [UInt8]? {
        let chars = Array(hex.utf8)
        guard chars.count % 2 == 0 else { return nil }
        var out = [UInt8]()
        out.reserveCapacity(chars.count / 2)
        var i = 0
        while i < chars.count {
            guard let hi = nibble(chars[i]), let lo = nibble(chars[i + 1]) else { return nil }
            out.append(hi << 4 | lo)
            i += 2
        }
        return out
    }

    private static func nibble(_ c: UInt8) -> UInt8? {
        switch c {
        case 48...57: return c - 48
        case 97...102: return c - 87
        case 65...70: return c - 55
        default: return nil
        }
    }

    static func constantTimeEquals(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        guard x.count == y.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<x.count { diff |= x[i] ^ y[i] }
        return diff == 0
    }
}
