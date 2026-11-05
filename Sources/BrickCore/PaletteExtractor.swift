import Foundation

/// Dominant colours of an image (album art) via a small deterministic k-means.
public enum PaletteExtractor {
    /// - Parameters:
    ///   - rgba: tightly packed RGBA8 pixels (premultiplied or not; alpha < 128 is skipped)
    ///   - count: colours to return (sorted by dominance), near-duplicates merged
    public static func extract(rgba: [UInt8], width: Int, height: Int, count: Int = 4) -> [String] {
        guard width > 0, height > 0, rgba.count >= width * height * 4 else { return [] }
        var pts: [(Float, Float, Float)] = []
        pts.reserveCapacity(width * height)
        let stride = max(1, (width * height) / 4096)
        var i = 0
        while i < width * height {
            let o = i * 4
            if rgba[o + 3] >= 128 {
                pts.append((Float(rgba[o]), Float(rgba[o + 1]), Float(rgba[o + 2])))
            }
            i += stride
        }
        guard !pts.isEmpty else { return [] }

        let k = min(max(count + 2, 3), 8, pts.count)
        // Deterministic maximin initialisation.
        var centers: [(Float, Float, Float)] = [mean(pts)]
        while centers.count < k {
            var best = pts[0], bestD: Float = -1
            for p in pts {
                let d = centers.map { dist2(p, $0) }.min() ?? 0
                if d > bestD { bestD = d; best = p }
            }
            centers.append(best)
        }

        var assignment = [Int](repeating: 0, count: pts.count)
        for _ in 0..<10 {
            var sums = [(Float, Float, Float)](repeating: (0, 0, 0), count: k)
            var counts = [Int](repeating: 0, count: k)
            for (pi, p) in pts.enumerated() {
                var bi = 0, bd = Float.greatestFiniteMagnitude
                for (ci, c) in centers.enumerated() {
                    let d = dist2(p, c)
                    if d < bd { bd = d; bi = ci }
                }
                assignment[pi] = bi
                sums[bi].0 += p.0; sums[bi].1 += p.1; sums[bi].2 += p.2
                counts[bi] += 1
            }
            for ci in 0..<k where counts[ci] > 0 {
                let n = Float(counts[ci])
                centers[ci] = (sums[ci].0 / n, sums[ci].1 / n, sums[ci].2 / n)
            }
        }

        var counts = [Int](repeating: 0, count: k)
        for a in assignment { counts[a] += 1 }
        let ordered = (0..<k).filter { counts[$0] > 0 }.sorted { counts[$0] > counts[$1] }.map { centers[$0] }

        // Merge near-duplicates (distance < 28 in RGB space).
        var result: [(Float, Float, Float)] = []
        for c in ordered where !result.contains(where: { dist2($0, c) < 28 * 28 }) {
            result.append(c)
            if result.count == count { break }
        }
        return result.map(hex)
    }

    static func mean(_ pts: [(Float, Float, Float)]) -> (Float, Float, Float) {
        var s: (Float, Float, Float) = (0, 0, 0)
        for p in pts { s.0 += p.0; s.1 += p.1; s.2 += p.2 }
        let n = Float(pts.count)
        return (s.0 / n, s.1 / n, s.2 / n)
    }

    static func dist2(_ a: (Float, Float, Float), _ b: (Float, Float, Float)) -> Float {
        let dr = a.0 - b.0, dg = a.1 - b.1, db = a.2 - b.2
        return dr * dr + dg * dg + db * db
    }

    static func hex(_ c: (Float, Float, Float)) -> String {
        func h(_ v: Float) -> String {
            let n = Int(min(255, max(0, v.rounded())))
            let digits = Array("0123456789abcdef")
            return String([digits[n >> 4], digits[n & 15]])
        }
        return "#" + h(c.0) + h(c.1) + h(c.2)
    }
}
