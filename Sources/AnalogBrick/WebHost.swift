import AppKit
import WebKit
import UniformTypeIdentifiers

protocol WebHostDelegate: AnyObject {
    /// A JS → native message (see docs/BRIDGE.md). `ready` is delivered too, after the host flips to ready.
    /// On `ready` the delegate must send `init` plus the complete current state: nothing is buffered before it.
    func webHost(_ host: WebHost, didReceive type: String, payload: [String: Any])
    /// The page could not be loaded or never became ready (after retries).
    func webHostDidFail(_ host: WebHost, reason: String)
}

extension WebHostDelegate {
    func webHostDidFail(_ host: WebHost, reason: String) {}
}

/// One WKWebView running a page of web/, plus its half of the bridge.
final class WebHost: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let webView: BrickWebView
    let page: String
    weak var delegate: WebHostDelegate?

    private(set) var isReady = false
    private(set) var didFail = false
    private let url: URL
    private var attempts = 0
    private var generation = 0
    static let readyTimeout: TimeInterval = 20
    static let maxAttempts = 4

    init(page: String, query: [URLQueryItem] = [], frame: NSRect, schemeHandler: BrickSchemeHandler) {
        self.page = page
        var comps = URLComponents()
        comps.scheme = BrickSchemeHandler.scheme
        comps.host = "app"
        comps.path = "/\(page).html"
        if !query.isEmpty { comps.queryItems = query }
        url = comps.url ?? URL(string: "brick://app/\(page).html")!

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(schemeHandler, forURLScheme: BrickSchemeHandler.scheme)
        config.suppressesIncrementalRendering = false
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.isElementFullscreenEnabled = false
        config.websiteDataStore = .nonPersistent()

        webView = BrickWebView(frame: frame, configuration: config)
        super.init()

        config.userContentController.add(WeakScriptHandler(self), name: "brick")
        webView.navigationDelegate = self
        webView.allowsMagnification = false
        webView.allowsBackForwardNavigationGestures = false
        webView.underPageBackgroundColor = .black
        // Avoid a white flash before the page paints: stay transparent until the page says it's ready.
        if webView.responds(to: NSSelectorFromString("_setDrawsBackground:")) || webView.responds(to: NSSelectorFromString("setDrawsBackground:")) {
            webView.setValue(false, forKey: "drawsBackground")
        }
        webView.alphaValue = 0
        if #available(macOS 13.3, *) { webView.isInspectable = AppInfo.isDebug }
        startLoad()
    }

    /// Load (or reload) the page and give it `readyTimeout` to say `ready`.
    private func startLoad() {
        guard !didFail else { return }
        attempts += 1
        generation += 1
        let gen = generation
        isReady = false
        webView.load(URLRequest(url: url))
        after(Self.readyTimeout) { [weak self] in
            guard let self, self.generation == gen, !self.isReady else { return }
            self.retryOrFail("page did not become ready within \(Int(Self.readyTimeout)) s")
        }
    }

    private func retryOrFail(_ reason: String) {
        guard !didFail, delegate != nil else { return }
        if attempts < Self.maxAttempts {
            Log.web.error("[\(self.page, privacy: .public)] \(reason, privacy: .public); retrying")
            after(0.5) { [weak self] in self?.startLoad() }
        } else {
            didFail = true
            Log.web.error("[\(self.page, privacy: .public)] giving up: \(reason, privacy: .public)")
            delegate?.webHostDidFail(self, reason: reason)
        }
    }

    /// Send a native → JS event. Events sent before the page is ready are dropped: on `ready` the delegate
    /// sends `init` and the complete current state, so nothing stale is ever replayed.
    func send(_ type: String, _ payload: Any = [String: Any](), droppable: Bool = false) {
        guard isReady else { return }
        guard let json = JSON.string(["type": type, "payload": payload]) else {
            Log.web.error("Unserialisable payload for \(type, privacy: .public)")
            return
        }
        let js = "window.Brick && window.Brick._receive(\(json));"
        webView.evaluateJavaScript(js) { _, error in
            if let error, !droppable { Log.web.error("evaluateJavaScript(\(type, privacy: .public)) failed: \(error.localizedDescription, privacy: .public)") }
        }
    }

    func teardown() {
        delegate = nil
        isReady = false
        generation += 1
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "brick")
        webView.removeFromSuperview()
    }

    // MARK: WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.protocol == BrickSchemeHandler.scheme else { return }
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        let payload = body["payload"] as? [String: Any] ?? [:]

        switch type {
        case "ready":
            isReady = true
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.35
                webView.animator().alphaValue = 1
            }
            delegate?.webHost(self, didReceive: type, payload: payload)
        case "log":
            let level = payload.string("level") ?? "info"
            let text = payload.string("message") ?? ""
            if level == "error" { Log.web.error("[\(self.page, privacy: .public)] \(text, privacy: .public)") }
            else { Log.web.info("[\(self.page, privacy: .public)] \(text, privacy: .public)") }
        default:
            delegate?.webHost(self, didReceive: type, payload: payload)
        }
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let target = navigationAction.request.url else { return decisionHandler(.cancel) }
        if target.scheme == BrickSchemeHandler.scheme { return decisionHandler(.allow) }
        if target.scheme == "about" { return decisionHandler(.allow) }
        decisionHandler(.cancel)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // The web process crashed (or was killed for memory). Reload; the page will send `ready` again.
        isReady = false
        generation += 1
        retryOrFail("web content process terminated")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        navigationFailed(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        navigationFailed(error)
    }

    private func navigationFailed(_ error: Error) {
        let e = error as NSError
        // Cancelled loads (our own reloads) and "frame load interrupted" are not failures.
        if e.code == NSURLErrorCancelled || (e.domain == "WebKitErrorDomain" && e.code == 102) { return }
        guard !isReady else { return }
        generation += 1
        retryOrFail("navigation failed: \(e.localizedDescription)")
    }
}

/// WKUserContentController retains its handlers; this breaks the cycle.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}

final class BrickWebView: WKWebView {
    /// No "Reload" / "Inspect Element" context menu.
    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        if !AppInfo.isDebug { menu.removeAllItems() }
        super.willOpenMenu(menu, with: event)
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// Serves brick://app/<path> from the web root and brick://gallery/<n> from the photo folder.
final class BrickSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "brick"

    let webRoot: URL
    let gallery: Gallery
    private var stopped = Set<ObjectIdentifier>()
    private let io = DispatchQueue(label: "analogbrick.scheme", qos: .userInitiated, attributes: .concurrent)

    init(webRoot: URL, gallery: Gallery) {
        self.webRoot = webRoot.standardizedFileURL
        self.gallery = gallery
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            return fail(urlSchemeTask, code: NSURLErrorBadURL)
        }
        let id = ObjectIdentifier(urlSchemeTask)
        stopped.remove(id)

        switch url.host {
        case "app":
            let relative = url.path.removingPercentEncoding ?? url.path
            let file = webRoot.appendingPathComponent(relative).standardizedFileURL
            guard file.path.hasPrefix(webRoot.path + "/") else { return fail(urlSchemeTask, code: NSURLErrorNoPermissionsToReadFile) }
            io.async { [weak self] in
                let data = try? Data(contentsOf: file)
                DispatchQueue.main.async {
                    guard let self, !self.stopped.contains(id) else { return }
                    guard let data else { return self.fail(urlSchemeTask, code: NSURLErrorFileDoesNotExist) }
                    self.respond(urlSchemeTask, url: url, data: data, mime: BrickSchemeHandler.mime(for: file))
                }
            }
        case "gallery":
            let index = Int(url.lastPathComponent) ?? -1
            let size = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "size" })?.value.flatMap(Int.init) ?? 2560
            let maxPixel = min(max(size, 64), 4096)
            io.async { [weak self] in
                let data = self?.gallery.jpeg(index: index, maxPixel: maxPixel)
                DispatchQueue.main.async {
                    guard let self, !self.stopped.contains(id) else { return }
                    guard let data else { return self.fail(urlSchemeTask, code: NSURLErrorFileDoesNotExist) }
                    self.respond(urlSchemeTask, url: url, data: data, mime: "image/jpeg")
                }
            }
        default:
            fail(urlSchemeTask, code: NSURLErrorUnsupportedURL)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(urlSchemeTask))
    }

    private func respond(_ task: WKURLSchemeTask, url: URL, data: Data, mime: String) {
        let headers = [
            "Content-Type": mime,
            "Content-Length": String(data.count),
            "Cache-Control": "no-cache",
            "Access-Control-Allow-Origin": "*",
        ]
        let response: URLResponse = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)
            ?? URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: nil)
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
        stopped.remove(ObjectIdentifier(task))
    }

    private func fail(_ task: WKURLSchemeTask, code: Int) {
        task.didFailWithError(NSError(domain: NSURLErrorDomain, code: code))
        stopped.remove(ObjectIdentifier(task))
    }

    static func mime(for file: URL) -> String {
        switch file.pathExtension.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "woff2": return "font/woff2"
        default: return UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}
