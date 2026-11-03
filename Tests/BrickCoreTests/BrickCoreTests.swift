import XCTest
@testable import BrickCore

final class SHA256Tests: XCTestCase {
    func testKnownVectors() {
        XCTAssertEqual(SHA256.hex(SHA256.hash(Array("".utf8))),
                       "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        XCTAssertEqual(SHA256.hex(SHA256.hash(Array("abc".utf8))),
                       "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        XCTAssertEqual(SHA256.hex(SHA256.hash(Array("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq".utf8))),
                       "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1")
        // Exercise the multi-block path (1,000 bytes).
        XCTAssertEqual(SHA256.hex(SHA256.hash([UInt8](repeating: 0x61, count: 1000))),
                       "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3")
    }
}

final class PinTests: XCTestCase {
    func testPolicy() {
        XCTAssertTrue(PinPolicy.isValid("1234"))
        XCTAssertTrue(PinPolicy.isValid("12345678"))
        XCTAssertFalse(PinPolicy.isValid("123"))
        XCTAssertFalse(PinPolicy.isValid("123456789"))
        XCTAssertFalse(PinPolicy.isValid("12a4"))
        XCTAssertFalse(PinPolicy.isValid("١٢٣٤"))  // non-ASCII digits
        XCTAssertFalse(PinPolicy.isValid(" 1234"))
    }

    func testHashVerify() {
        let h = PinHash.make(pin: "4821", iterations: 50)
        XCTAssertTrue(h.verify("4821"))
        XCTAssertFalse(h.verify("4822"))
        XCTAssertFalse(h.verify(""))
        XCTAssertEqual(h.salt.count, 32)
        XCTAssertEqual(h.digest.count, 64)
        XCTAssertFalse(h.digest.contains("4821"))
    }

    func testSaltMakesHashesDiffer() {
        let a = PinHash.make(pin: "1234", iterations: 10)
        let b = PinHash.make(pin: "1234", iterations: 10)
        XCTAssertNotEqual(a.digest, b.digest)
    }

    func testCodableRoundTrip() throws {
        let h = PinHash.make(pin: "9999", iterations: 10)
        let data = try JSONEncoder().encode(h)
        let back = try JSONDecoder().decode(PinHash.self, from: data)
        XCTAssertEqual(h, back)
        XCTAssertTrue(back.verify("9999"))
    }
}

final class UnlockFlowTests: XCTestCase {
    var now = Date(timeIntervalSince1970: 1_000_000)

    func makeFlow(delay: TimeInterval = 3) -> UnlockFlow {
        UnlockFlow(pinLength: 4, confirmDelay: delay, verify: { $0 == "1234" })
    }

    func advance(_ s: TimeInterval) { now = now.addingTimeInterval(s) }

    func testFullRitualNeedsThreePinsAndThreeConfirms() {
        let f = makeFlow()
        XCTAssertEqual(f.state.stage, .idle)
        f.begin(now: now)
        for step in 1...3 {
            XCTAssertEqual(f.state.stage, .pin)
            XCTAssertEqual(f.state.step, step)
            f.submit(pin: "1234", now: now)
            XCTAssertEqual(f.state.stage, .confirm)
            advance(3)
            f.confirm(now: now)
        }
        XCTAssertEqual(f.state.stage, .unlocked)
        XCTAssertTrue(f.isUnlocked)
    }

    func testConfirmTooEarlyIsIgnored() {
        let f = makeFlow(delay: 3)
        f.begin(now: now)
        f.submit(pin: "1234", now: now)
        advance(1)
        f.confirm(now: now)
        XCTAssertEqual(f.state.stage, .confirm)
        XCTAssertEqual(f.state.step, 1)
        advance(2)
        f.confirm(now: now)
        XCTAssertEqual(f.state.stage, .pin)
        XCTAssertEqual(f.state.step, 2)
    }

    func testWrongPinKeepsStepAndReportsError() {
        let f = makeFlow()
        f.begin(now: now)
        f.submit(pin: "1234", now: now); advance(3); f.confirm(now: now)
        XCTAssertEqual(f.state.step, 2)
        f.submit(pin: "0000", now: now)
        XCTAssertEqual(f.state.stage, .pin)
        XCTAssertEqual(f.state.step, 2)
        XCTAssertEqual(f.state.error, "wrong-pin")
        XCTAssertEqual(f.state.wrongAttempts, 1)
        f.submit(pin: "1234", now: now)
        XCTAssertEqual(f.state.stage, .confirm)
        XCTAssertNil(f.state.error)
        XCTAssertEqual(f.state.wrongAttempts, 0)
    }

    func testCancelReturnsToIdleAndRestartsAtStepOne() {
        let f = makeFlow()
        f.begin(now: now)
        f.submit(pin: "1234", now: now); advance(3); f.confirm(now: now)
        XCTAssertEqual(f.state.step, 2)
        f.cancel(now: now)
        XCTAssertEqual(f.state.stage, .idle)
        f.begin(now: now)
        XCTAssertEqual(f.state.step, 1)
    }

    func testCooldownAfterFiveWrongAndItDoubles() {
        let f = makeFlow()
        f.begin(now: now)
        for _ in 0..<5 { f.submit(pin: "0000", now: now) }
        XCTAssertEqual(f.state.stage, .cooldown)
        let firstUntil = f.state.cooldownUntil!
        XCTAssertEqual(firstUntil.timeIntervalSince(now), 60, accuracy: 0.001)

        // Cancel and begin can't dodge the cooldown.
        f.cancel(now: now); f.begin(now: now)
        XCTAssertEqual(f.state.stage, .cooldown)
        f.submit(pin: "1234", now: now)
        XCTAssertEqual(f.state.stage, .cooldown)

        advance(59)
        XCTAssertFalse(f.tick(now: now))
        advance(1)
        XCTAssertTrue(f.tick(now: now))
        XCTAssertEqual(f.state.stage, .idle)
        XCTAssertEqual(f.state.wrongAttempts, 0)

        f.begin(now: now)
        for _ in 0..<5 { f.submit(pin: "0000", now: now) }
        XCTAssertEqual(f.state.cooldownUntil!.timeIntervalSince(now), 120, accuracy: 0.001)
    }

    func testWrongAttemptsSurviveCancel() {
        let f = makeFlow()
        f.begin(now: now)
        for _ in 0..<4 { f.submit(pin: "0000", now: now) }
        f.cancel(now: now)
        f.begin(now: now)
        f.submit(pin: "0000", now: now)
        XCTAssertEqual(f.state.stage, .cooldown)
    }

    func testInactivityTimeout() {
        let f = makeFlow()
        f.begin(now: now)
        f.submit(pin: "1234", now: now)
        advance(30)
        f.activity(now: now)
        advance(59)
        XCTAssertFalse(f.tick(now: now))
        advance(1)
        XCTAssertTrue(f.tick(now: now))
        XCTAssertEqual(f.state.stage, .idle)
    }

    func testInvalidPinFormatCountsAsWrong() {
        let f = makeFlow()
        f.begin(now: now)
        f.submit(pin: "12", now: now)
        XCTAssertEqual(f.state.error, "wrong-pin")
        XCTAssertEqual(f.state.stage, .pin)
    }

    func testIgnoresOutOfOrderCommands() {
        let f = makeFlow()
        f.submit(pin: "1234", now: now)
        XCTAssertEqual(f.state.stage, .idle)
        f.confirm(now: now)
        XCTAssertEqual(f.state.stage, .idle)
        f.begin(now: now)
        f.confirm(now: now)
        XCTAssertEqual(f.state.stage, .pin)
    }

    func testPayloadShape() {
        let f = makeFlow(delay: 3)
        f.begin(now: now)
        let p = f.payload()
        XCTAssertEqual(p["stage"] as? String, "pin")
        XCTAssertEqual(p["step"] as? Int, 1)
        XCTAssertEqual(p["totalSteps"] as? Int, 3)
        XCTAssertEqual(p["confirmDelayMs"] as? Int, 3000)
        XCTAssertEqual(p["pinLength"] as? Int, 4)
        XCTAssertTrue(p["error"] is NSNull)
        XCTAssertTrue(p["cooldownUntil"] is NSNull)
        XCTAssertTrue(JSONSerialization.isValidJSONObject(p))
    }

    func testZeroDelayConfirmImmediately() {
        let f = makeFlow(delay: 0)
        f.begin(now: now)
        f.submit(pin: "1234", now: now)
        f.confirm(now: now)
        XCTAssertEqual(f.state.step, 2)
    }
}

final class SettingsTests: XCTestCase {
    func testDefaultsDecodeFromEmptyJSON() throws {
        let s = try JSONDecoder().decode(Settings.self, from: Data("{}".utf8))
        XCTAssertEqual(s, Settings())
        XCTAssertEqual(s.durationMin, 50)
        XCTAssertEqual(s.quickPlaylists.count, 3)
    }

    func testDecodeToleratesBadValues() throws {
        let json = #"{"durationMin": 9999, "mode": "lasers", "quality": 7, "peekSeconds": 1, "breathPattern": "fast"}"#
        let s = try JSONDecoder().decode(Settings.self, from: Data(json.utf8))
        XCTAssertEqual(s.durationMin, 480)
        XCTAssertEqual(s.mode, "aurora")
        XCTAssertEqual(s.quality, "balanced")
        XCTAssertEqual(s.peekSeconds, 30)
        XCTAssertEqual(s.breathPattern, "box")
    }

    func testApplyingPatch() {
        let s = Settings().applying([
            "durationMin": 25.0,
            "mode": "night",
            "keepAwake": false,
            "confirmDelaySec": 99,
            "quickPlaylists": [["name": " Rain ", "uri": "https://open.spotify.com/playlist/37i9dQZF1DXbcPC6Vvqudd?si=abc"],
                               ["name": "bad", "uri": "not a uri"]],
            "pin": "1234",          // unknown keys are ignored
        ])
        XCTAssertEqual(s.durationMin, 25)
        XCTAssertEqual(s.mode, "night")
        XCTAssertFalse(s.keepAwake)
        XCTAssertEqual(s.confirmDelaySec, 10)
        XCTAssertEqual(s.quickPlaylists, [QuickPlaylist(name: "Rain", uri: "spotify:playlist:37i9dQZF1DXbcPC6Vvqudd")])
    }

    func testPayloadIsJSONSerializable() {
        XCTAssertTrue(JSONSerialization.isValidJSONObject(Settings().payload()))
    }

    func testRoundTrip() throws {
        var s = Settings()
        s.galleryFolder = "/Users/me/Pictures"
        s.intention = "Essay"
        let back = try JSONDecoder().decode(Settings.self, from: JSONEncoder().encode(s))
        XCTAssertEqual(s, back)
    }
}

final class SpotifyURITests: XCTestCase {
    func testNormalize() {
        XCTAssertEqual(SpotifyURI.normalize("spotify:playlist:37i9dQZF1DWZeKCadgRdKQ"), "spotify:playlist:37i9dQZF1DWZeKCadgRdKQ")
        XCTAssertEqual(SpotifyURI.normalize(" https://open.spotify.com/playlist/37i9dQZF1DWZeKCadgRdKQ?si=x1y2 "), "spotify:playlist:37i9dQZF1DWZeKCadgRdKQ")
        XCTAssertEqual(SpotifyURI.normalize("https://open.spotify.com/intl-de/album/4aawyAB9vmqN3uQ7FjRGTy"), "spotify:album:4aawyAB9vmqN3uQ7FjRGTy")
        XCTAssertEqual(SpotifyURI.normalize("https://open.spotify.com/track/6rqhFgbbKwnb9MLmUQDhG6"), "spotify:track:6rqhFgbbKwnb9MLmUQDhG6")
        XCTAssertEqual(SpotifyURI.normalize("spotify:user:someone:playlist:abc123"), "spotify:playlist:abc123")
        XCTAssertNil(SpotifyURI.normalize("https://example.com/playlist/abc"))
        XCTAssertNil(SpotifyURI.normalize("spotify:playlist:"))
        XCTAssertNil(SpotifyURI.normalize("spotify:playlist:abc;rm -rf"))
        XCTAssertNil(SpotifyURI.normalize("spotify:playlist:abc\" & quit"))
        XCTAssertNil(SpotifyURI.normalize(""))
    }
}

final class SessionRequestTests: XCTestCase {
    func testValid() throws {
        let r = try SessionRequest.parse(["durationMin": 45, "pin": "2468", "mode": "breath", "intention": "  Thesis ch. 2  "]).get()
        XCTAssertEqual(r, SessionRequest(durationMin: 45, pin: "2468", mode: "breath", intention: "Thesis ch. 2"))
    }

    func testInvalid() {
        guard case .failure(.invalidPin) = SessionRequest.parse(["durationMin": 45, "pin": "12"]) else { return XCTFail() }
        guard case .failure(.invalidDuration) = SessionRequest.parse(["durationMin": 0, "pin": "1234"]) else { return XCTFail() }
        guard case .failure(.invalidDuration) = SessionRequest.parse(["durationMin": 481, "pin": "1234"]) else { return XCTFail() }
        guard case .success(let r) = SessionRequest.parse(["durationMin": "30", "pin": "1234", "mode": "nope"]) else { return XCTFail() }
        XCTAssertEqual(r.mode, "aurora")
    }

    func testSessionRecordTiming() throws {
        let start = Date(timeIntervalSince1970: 1000)
        let rec = SessionRecord(startedAt: start, endsAt: start.addingTimeInterval(600), intention: "", mode: "night",
                                pin: PinHash.make(pin: "1234", iterations: 5), pinLength: 4)
        XCTAssertTrue(rec.isActive(at: start.addingTimeInterval(599)))
        XCTAssertFalse(rec.isActive(at: start.addingTimeInterval(600)))
        XCTAssertEqual(rec.remaining(at: start.addingTimeInterval(100)), 500)
        let back = try JSONDecoder().decode(SessionRecord.self, from: JSONEncoder().encode(rec))
        XCTAssertEqual(back, rec)
    }
}

final class StatsTests: XCTestCase {
    func testSummary() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let now = Date(timeIntervalSince1970: 1_762_174_800) // 2025-11-03 13:00 UTC
        let day: TimeInterval = 86_400
        let log = [
            SessionLogEntry(startedAt: now.addingTimeInterval(-3600), plannedMs: 3_000_000, focusedMs: 3_000_000, completed: true),
            SessionLogEntry(startedAt: now.addingTimeInterval(-day), plannedMs: 1_500_000, focusedMs: 1_500_000, completed: true),
            SessionLogEntry(startedAt: now.addingTimeInterval(-2 * day), plannedMs: 3_000_000, focusedMs: 600_000, completed: false),
            SessionLogEntry(startedAt: now.addingTimeInterval(-3 * day), plannedMs: 3_000_000, focusedMs: 3_000_000, completed: true),
            SessionLogEntry(startedAt: now.addingTimeInterval(-10 * day), plannedMs: 3_000_000, focusedMs: 3_000_000, completed: true),
        ]
        let s = StatsCalculator.summarize(log, now: now, calendar: cal)
        XCTAssertEqual(s.todayMs, 3_000_000)
        XCTAssertEqual(s.weekMs, 3_000_000 + 1_500_000 + 600_000 + 3_000_000)
        XCTAssertEqual(s.streakDays, 2)   // the day-2 session was broken early
        XCTAssertEqual(s.totalSessions, 5)
        XCTAssertEqual(s.recent.first?.focusedMs, 3_000_000)
        XCTAssertTrue(JSONSerialization.isValidJSONObject(s.payload()))
    }

    func testStreakCountsFromYesterdayWhenNothingToday() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let now = Date(timeIntervalSince1970: 1_762_174_800)
        let day: TimeInterval = 86_400
        let log = [
            SessionLogEntry(startedAt: now.addingTimeInterval(-day), plannedMs: 1, focusedMs: 1, completed: true),
            SessionLogEntry(startedAt: now.addingTimeInterval(-2 * day), plannedMs: 1, focusedMs: 1, completed: true),
        ]
        XCTAssertEqual(StatsCalculator.summarize(log, now: now, calendar: cal).streakDays, 2)
        XCTAssertEqual(StatsCalculator.summarize([], now: now, calendar: cal).streakDays, 0)
    }
}

final class AudioAnalyzerTests: XCTestCase {
    func sine(_ hz: Double, seconds: Double, rate: Double = 48_000, amp: Float = 0.5) -> [Float] {
        (0..<Int(seconds * rate)).map { Float(sin(2 * Double.pi * hz * Double($0) / rate)) * amp }
    }

    func band(for hz: Double) -> Int {
        (0..<AudioAnalyzer.bandCount).first { AudioAnalyzer.bandEdge($0) <= hz && hz < AudioAnalyzer.bandEdge($0 + 1) }!
    }

    func testFFTFindsPureTone() {
        let fft = FFT(size: 1024)
        var re = (0..<1024).map { Float(sin(2 * Double.pi * 64 * Double($0) / 1024)) }
        var im = [Float](repeating: 0, count: 1024)
        fft.forward(&re, &im)
        let mags = (0..<512).map { sqrt(re[$0] * re[$0] + im[$0] * im[$0]) }
        XCTAssertEqual(mags.firstIndex(of: mags.max()!), 64)
    }

    func testToneLightsTheRightBand() {
        for hz in [80.0, 440, 1000, 5000] {
            let a = AudioAnalyzer(sampleRate: 48_000)
            a.append(sine(hz, seconds: 0.2))
            let f = a.analyze(time: 1)
            let peak = f.bands.firstIndex(of: f.bands.max()!)!
            XCTAssertLessThanOrEqual(abs(peak - band(for: hz)), 1, "tone \(hz) Hz peaked in band \(peak)")
            XCTAssertGreaterThan(f.level, 0.3)
        }
    }

    func testBassVersusTreble() {
        let low = AudioAnalyzer(sampleRate: 48_000)
        low.append(sine(60, seconds: 0.2))
        let lf = low.analyze(time: 1)
        XCTAssertGreaterThan(lf.bass, lf.treble)

        let high = AudioAnalyzer(sampleRate: 48_000)
        high.append(sine(8000, seconds: 0.2))
        let hf = high.analyze(time: 1)
        XCTAssertGreaterThan(hf.treble, hf.bass)
    }

    func testSilenceIsSilent() {
        let a = AudioAnalyzer(sampleRate: 48_000)
        a.append([Float](repeating: 0, count: 4096))
        let f = a.analyze(time: 1)
        XCTAssertEqual(f, AudioFrame.silent)
        XCTAssertEqual(AudioAnalyzer(sampleRate: 48_000).analyze(time: 0), AudioFrame.silent)
    }

    func testDetectsKickDrumBeats() {
        // 120 BPM kicks (decaying 55 Hz bursts) over a quiet pad, analysed at 30 Hz.
        let rate = 48_000.0
        let a = AudioAnalyzer(sampleRate: rate)
        let hop = Int(rate / 30)
        var beats: [Double] = []
        var n = 0
        for frame in 0..<(30 * 6) {
            var chunk = [Float](repeating: 0, count: hop)
            for i in 0..<hop {
                let t = Double(n) / rate
                let sinceKick = t.truncatingRemainder(dividingBy: 0.5)
                let kick = Float(sin(2 * Double.pi * 55 * sinceKick) * exp(-sinceKick * 18)) * 0.8
                let pad = Float(sin(2 * Double.pi * 660 * t)) * 0.03
                chunk[i] = kick + pad
                n += 1
            }
            a.append(chunk)
            let time = Double(frame + 1) / 30
            if a.analyze(time: time).beat { beats.append(time) }
        }
        // ~12 kicks in 6 s; allow a warm-up miss or two.
        XCTAssertGreaterThanOrEqual(beats.count, 8, "beats: \(beats)")
        XCTAssertLessThanOrEqual(beats.count, 13, "beats: \(beats)")
        for (x, y) in zip(beats, beats.dropFirst()) { XCTAssertGreaterThanOrEqual(y - x, 0.28) }
    }

    func testPayloadIsJSON() {
        XCTAssertTrue(JSONSerialization.isValidJSONObject(AudioFrame.silent.payload()))
    }
}

final class PaletteTests: XCTestCase {
    func testExtractsDominantColours() {
        let w = 40, h = 40
        var px = [UInt8]()
        for y in 0..<h {
            for _ in 0..<w {
                if y < 28 { px += [20, 40, 120, 255] }        // 70% navy
                else if y < 38 { px += [230, 180, 60, 255] }  // 25% amber
                else { px += [250, 250, 250, 255] }           // 5% white
            }
        }
        let p = PaletteExtractor.extract(rgba: px, width: w, height: h, count: 4)
        XCTAssertEqual(p.first, "#142878")
        XCTAssertEqual(p.count, 3)
        XCTAssertEqual(p[1], "#e6b43c")
        XCTAssertTrue(p.allSatisfy { $0.hasPrefix("#") && $0.count == 7 })
    }

    func testEmptyAndTransparent() {
        XCTAssertEqual(PaletteExtractor.extract(rgba: [], width: 0, height: 0), [])
        XCTAssertEqual(PaletteExtractor.extract(rgba: [UInt8](repeating: 0, count: 64), width: 4, height: 4), [])
    }
}
