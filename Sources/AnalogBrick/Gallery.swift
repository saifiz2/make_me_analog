import AppKit
import ImageIO
import UniformTypeIdentifiers

/// The user's photo folder for the Gallery mode. Images are served to the web views as
/// brick://gallery/<index>[?size=<px>] — decoded with ImageIO (HEIC, orientation) and re-encoded as JPEG.
final class Gallery {
    static let extensions: Set<String> = ["jpg", "jpeg", "png", "heic", "heif", "webp", "tif", "tiff", "gif", "bmp"]
    static let maxImages = 300

    private(set) var folder: URL?
    private(set) var images: [URL] = []
    private let cache = NSCache<NSString, NSData>()
    private let lock = NSLock()

    init() {
        cache.totalCostLimit = 200 * 1024 * 1024
    }

    func scan(path: String?) {
        guard let path, !path.isEmpty else {
            set(folder: nil, images: [])
            return
        }
        let url = URL(fileURLWithPath: path, isDirectory: true)
        var found: [URL] = []
        let keys: [URLResourceKey] = [.isRegularFileKey, .isHiddenKey]
        if let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: keys,
                                                  options: [.skipsHiddenFiles, .skipsPackageDescendants]) {
            for case let file as URL in e {
                if e.level > 3 { e.skipDescendants(); continue }
                guard Gallery.extensions.contains(file.pathExtension.lowercased()) else { continue }
                found.append(file)
                if found.count >= Gallery.maxImages { break }
            }
        }
        found.sort { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
        set(folder: url, images: found)
    }

    private func set(folder: URL?, images: [URL]) {
        lock.lock()
        self.folder = folder
        self.images = images
        lock.unlock()
        cache.removeAllObjects()
    }

    func urls(limit: Int? = nil) -> [String] {
        lock.lock()
        let count = images.count
        lock.unlock()
        let n = limit.map { min($0, count) } ?? count
        return (0..<n).map { "brick://gallery/\($0)" }
    }

    func payload() -> [String: Any] {
        lock.lock()
        let folderPath = folder?.path
        let count = images.count
        lock.unlock()
        return [
            "folder": folderPath.map { $0 as Any } ?? NSNull(),
            "count": count,
            "images": urls(limit: 12).map { $0 + "?size=480" },
        ]
    }

    /// JPEG data for image `index`, longest side ≤ `maxPixel`. Call off the main thread.
    func jpeg(index: Int, maxPixel: Int) -> Data? {
        lock.lock()
        let file = images.indices.contains(index) ? images[index] : nil
        lock.unlock()
        guard let file else { return nil }
        let key = "\(index)@\(maxPixel)" as NSString
        if let hit = cache.object(forKey: key) { return hit as Data }

        guard let src = CGImageSourceCreateWithURL(file as CFURL, nil) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.86] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        cache.setObject(out, forKey: key, cost: out.length)
        return out as Data
    }
}
