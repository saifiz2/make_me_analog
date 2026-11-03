import Foundation

/// One analysis frame sent to the web visuals (bridge event `audio`).
public struct AudioFrame: Equatable, Sendable {
    public var bands: [Float]
    public var level: Float
    public var bass: Float
    public var mid: Float
    public var treble: Float
    public var beat: Bool

    public static let silent = AudioFrame(bands: Array(repeating: 0, count: AudioAnalyzer.bandCount), level: 0, bass: 0, mid: 0, treble: 0, beat: false)

    public func payload() -> [String: Any] {
        func r(_ v: Float) -> Double { (Double(v) * 1000).rounded() / 1000 }
        return [
            "bands": bands.map(r),
            "level": r(level),
            "bass": r(bass),
            "mid": r(mid),
            "treble": r(treble),
            "beat": beat,
        ]
    }
}

/// Turns a stream of mono PCM samples into 32 log-spaced, auto-gained bands plus beat detection.
///
/// Not thread-safe: call `append` and `analyze` from the same serial queue.
public final class AudioAnalyzer {
    public static let bandCount = 32
    public static let minFrequency: Double = 30
    public static let maxFrequency: Double = 16_000

    public let sampleRate: Double
    public let fftSize: Int

    private var ring: [Float]
    private var writeIndex = 0
    private var filled = 0
    private let window: [Float]
    private let fft: FFT
    private let bandBins: [(lo: Int, hi: Int)]

    // Automatic gain: a slowly decaying ceiling in dB.
    private var ceilingDb: Float = -30
    private let dynamicRangeDb: Float = 48
    private var lastAnalyze: Double?

    // Beat detection on low-frequency spectral flux.
    private var previousLow = [Float](repeating: 0, count: 10)
    private var fluxHistory: [Float] = []
    private let fluxHistoryLength = 45
    private var lastBeatTime: Double = -10
    public var minBeatInterval: Double = 0.28

    public init(sampleRate: Double, fftSize: Int = 2048) {
        precondition(fftSize >= 64 && (fftSize & (fftSize - 1)) == 0, "fftSize must be a power of two")
        self.sampleRate = sampleRate
        self.fftSize = fftSize
        self.ring = [Float](repeating: 0, count: fftSize)
        self.window = (0..<fftSize).map { i in Float(0.5 - 0.5 * cos(2 * Double.pi * Double(i) / Double(fftSize - 1))) }
        self.fft = FFT(size: fftSize)
        self.bandBins = AudioAnalyzer.makeBands(sampleRate: sampleRate, fftSize: fftSize)
    }

    /// Lower edge (Hz) of band `i`; band `bandCount` gives the top edge.
    public static func bandEdge(_ i: Int) -> Double {
        minFrequency * pow(maxFrequency / minFrequency, Double(i) / Double(bandCount))
    }

    static func makeBands(sampleRate: Double, fftSize: Int) -> [(lo: Int, hi: Int)] {
        let binHz = sampleRate / Double(fftSize)
        let maxBin = fftSize / 2 - 1
        var out: [(Int, Int)] = []
        for i in 0..<bandCount {
            var lo = Int((bandEdge(i) / binHz).rounded(.down))
            var hi = Int((bandEdge(i + 1) / binHz).rounded(.up))
            lo = min(max(1, lo), maxBin)
            hi = min(max(lo + 1, hi), maxBin + 1)
            out.append((lo, hi))
        }
        return out
    }

    /// Append mono samples (−1…1).
    public func append(_ samples: UnsafeBufferPointer<Float>) {
        for s in samples {
            ring[writeIndex] = s.isFinite ? s : 0
            writeIndex = (writeIndex + 1) & (fftSize - 1)
        }
        filled = min(fftSize, filled + samples.count)
    }

    public func append(_ samples: [Float]) {
        samples.withUnsafeBufferPointer { append($0) }
    }

    /// Analyse the most recent `fftSize` samples. `time` is a monotonically increasing clock in seconds.
    public func analyze(time: Double) -> AudioFrame {
        let dt = Float(min(0.5, max(0.001, time - (lastAnalyze ?? (time - 1.0 / 30)))))
        lastAnalyze = time
        guard filled > 0 else { return .silent }

        // Window the ring buffer, oldest sample first.
        var re = [Float](repeating: 0, count: fftSize)
        var im = [Float](repeating: 0, count: fftSize)
        var sumSquares: Float = 0
        for i in 0..<fftSize {
            let s = ring[(writeIndex + i) & (fftSize - 1)]
            sumSquares += s * s
            re[i] = s * window[i]
        }
        fft.forward(&re, &im)

        // Magnitudes normalised so a full-scale sine is ~0 dB.
        let norm = 4 / Float(fftSize)
        var bandDb = [Float](repeating: -120, count: AudioAnalyzer.bandCount)
        for (b, range) in bandBins.enumerated() {
            var power: Float = 0
            for k in range.lo..<range.hi { power += (re[k] * re[k] + im[k] * im[k]) }
            power /= Float(range.hi - range.lo)
            let mag = sqrt(power) * norm
            bandDb[b] = 20 * log10(max(mag, 1e-7))
        }

        let rms = sqrt(sumSquares / Float(fftSize))
        let levelDb = 20 * log10(max(rms, 1e-7))

        // Auto gain: ceiling rises instantly, falls 2 dB/s, never below −60 dB.
        let loudest = max(bandDb.max() ?? -120, levelDb)
        if loudest > ceilingDb { ceilingDb = loudest } else { ceilingDb = max(-60, ceilingDb - 2 * dt) }
        let floorDb = ceilingDb - dynamicRangeDb

        var bands = [Float](repeating: 0, count: AudioAnalyzer.bandCount)
        for b in 0..<AudioAnalyzer.bandCount {
            let v = (bandDb[b] - floorDb) / dynamicRangeDb
            bands[b] = min(1, max(0, v))
        }
        let level = min(1, max(0, (levelDb - floorDb) / dynamicRangeDb))
        func avg(_ r: Range<Int>) -> Float { r.reduce(0) { $0 + bands[$1] } / Float(r.count) }
        let bass = avg(0..<9), mid = avg(9..<21), treble = avg(21..<32)

        // Spectral flux over the low bands.
        var flux: Float = 0
        for i in 0..<previousLow.count {
            let d = bands[i] - previousLow[i]
            if d > 0 { flux += d }
            previousLow[i] = bands[i]
        }
        var beat = false
        if fluxHistory.count >= 8 {
            let mean = fluxHistory.reduce(0, +) / Float(fluxHistory.count)
            let variance = fluxHistory.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Float(fluxHistory.count)
            let threshold = mean + 1.5 * sqrt(variance)
            if flux > threshold && flux > 0.35 && bass > 0.2 && time - lastBeatTime >= minBeatInterval {
                beat = true
                lastBeatTime = time
            }
        }
        fluxHistory.append(flux)
        if fluxHistory.count > fluxHistoryLength { fluxHistory.removeFirst(fluxHistory.count - fluxHistoryLength) }

        let silent = rms < 1e-5
        if silent {
            return AudioFrame(bands: Array(repeating: 0, count: AudioAnalyzer.bandCount), level: 0, bass: 0, mid: 0, treble: 0, beat: false)
        }
        return AudioFrame(bands: bands, level: level, bass: bass, mid: mid, treble: treble, beat: beat)
    }

    public func reset() {
        for i in 0..<ring.count { ring[i] = 0 }
        writeIndex = 0
        filled = 0
        fluxHistory.removeAll()
        for i in 0..<previousLow.count { previousLow[i] = 0 }
        ceilingDb = -30
        lastAnalyze = nil
    }
}

/// Iterative radix-2 complex FFT with precomputed twiddles.
public final class FFT {
    public let size: Int
    private let cosTable: [Float]
    private let sinTable: [Float]
    private let reversed: [Int]

    public init(size: Int) {
        precondition(size >= 2 && (size & (size - 1)) == 0)
        self.size = size
        var c = [Float](), s = [Float]()
        for i in 0..<(size / 2) {
            let a = -2 * Double.pi * Double(i) / Double(size)
            c.append(Float(cos(a)))
            s.append(Float(sin(a)))
        }
        cosTable = c
        sinTable = s
        let bits = Int(log2(Double(size)))
        reversed = (0..<size).map { i in
            var x = i, r = 0
            for _ in 0..<bits { r = (r << 1) | (x & 1); x >>= 1 }
            return r
        }
    }

    public func forward(_ re: inout [Float], _ im: inout [Float]) {
        let n = size
        for i in 0..<n {
            let j = reversed[i]
            if j > i { re.swapAt(i, j); im.swapAt(i, j) }
        }
        var len = 2
        while len <= n {
            let half = len / 2
            let step = n / len
            var start = 0
            while start < n {
                var k = 0
                for j in start..<(start + half) {
                    let wr = cosTable[k], wi = sinTable[k]
                    let xr = re[j + half], xi = im[j + half]
                    let tr = xr * wr - xi * wi
                    let ti = xr * wi + xi * wr
                    re[j + half] = re[j] - tr
                    im[j + half] = im[j] - ti
                    re[j] += tr
                    im[j] += ti
                    k += step
                }
                start += len
            }
            len <<= 1
        }
    }
}
