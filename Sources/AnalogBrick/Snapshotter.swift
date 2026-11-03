import AppKit
import WebKit
import BrickCore

/// `AnalogBrick --snapshot <target> <out.png> [WxH]` renders a page offscreen in the real WebKit and
/// writes a PNG, then exits. `target` is a visual mode id (rendered via preview.html), or `lock` / `setup`
/// (rendered with fake bridge data). Used by CI to check the bundle on actual macOS.
final class Snapshotter: NSObject, WebHostDelegate {
    private let target: String
    private let output: String
    private let size: NSSize
    private let schemeHandler: BrickSchemeHandler
    private var window: NSWindow?
    private var host: WebHost?
    private var done = false

    init(target: String, output: String, size: NSSize, schemeHandler: BrickSchemeHandler) {
        self.target = target
        self.output = output
        self.size = size
        self.schemeHandler = schemeHandler
    }

    func run() {
        let rect = NSRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
        window.backgroundColor = .black
        window.isReleasedWhenClosed = false

        let page: String
        var query: [URLQueryItem] = []
        switch target {
        case "lock":
            page = "lock"
            query = [URLQueryItem(name: "role", value: "primary"), URLQueryItem(name: "display", value: "0")]
        case "setup":
            page = "setup"
        default:
            page = "preview"
            query = [URLQueryItem(name: "mode", value: target), URLQueryItem(name: "quality", value: "balanced")]
        }
        let host = WebHost(page: page, query: query, frame: rect, schemeHandler: schemeHandler)
        host.delegate = self
        window.contentView = host.webView
        window.setFrameOrigin(NSPoint(x: 0, y: 0))
        window.orderFrontRegardless()
        self.window = window
        self.host = host

        // preview.html has no bridge, so it never sends `ready`; show it after it has had time to load.
        after(1.0) { host.webView.alphaValue = 1 }
        after(6.0) { [weak self] in self?.capture() }
        after(20.0) { [weak self] in
            guard let self, !self.done else { return }
            Log.app.error("Snapshot timed out")
            exit(3)
        }
    }

    private func capture() {
        guard let host, !done else { return }
        host.webView.alphaValue = 1
        host.webView.takeSnapshot(with: WKSnapshotConfiguration()) { [weak self] image, error in
            guard let self else { return }
            self.done = true
            guard let image, let tiff = image.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else {
                Log.app.error("Snapshot failed: \(error?.localizedDescription ?? "no image", privacy: .public)")
                exit(4)
            }
            do {
                let url = URL(fileURLWithPath: self.output)
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try png.write(to: url)
                print("wrote \(self.output)")
                exit(0)
            } catch {
                print("could not write \(self.output): \(error)")
                exit(5)
            }
        }
    }

    func webHost(_ host: WebHost, didReceive type: String, payload: [String: Any]) {
        guard type == "ready" else { return }
        let now = Date()
        if host.page == "lock" {
            host.send("init", [
                "page": "lock", "role": "primary", "displayIndex": 0, "displayCount": 1,
                "session": [
                    "id": "snapshot", "startedAt": now.addingTimeInterval(-600).epochMillis,
                    "endsAt": now.addingTimeInterval(2400).epochMillis, "durationMs": 3_000_000,
                    "intention": "Chapter 3 outline", "mode": "aurora",
                ] as [String: Any],
                "settings": Settings().payload(),
                "gallery": ["images": [String]()],
            ] as [String: Any])
            host.send("spotify", [
                "installed": true, "running": true, "permission": "granted", "state": "playing",
                "track": ["id": "spotify:track:snapshot", "name": "Weightless", "artist": "Marconi Union",
                          "album": "Weightless", "durationMs": 480_000, "artworkUrl": ""] as [String: Any],
                "positionMs": 61_000, "positionAt": now.epochMillis, "volume": 60, "shuffling": false, "repeating": false,
            ] as [String: Any])
            host.send("unlock", UnlockFlow(pinLength: 4, verify: { _ in false }).payload())
        } else if host.page == "setup" {
            host.send("init", [
                "page": "setup", "version": AppInfo.version,
                "settings": Settings().payload(),
                "status": [
                    "focus": ["shortcutsAvailable": true, "onName": FocusManager.onName, "offName": FocusManager.offName, "hasOn": true, "hasOff": true],
                    "spotify": ["installed": true, "running": true, "permission": "granted"],
                    "audio": ["supported": true, "permission": "granted"],
                    "loginItem": ["status": "enabled"],
                    "displays": 1,
                ] as [String: Any],
                "stats": StatsCalculator.summarize([], now: now).payload(),
                "gallery": ["folder": NSNull(), "count": 0, "images": [String]()],
            ] as [String: Any])
        }
    }
}
