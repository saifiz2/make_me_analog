import AppKit
import BrickCore

protocol SetupWindowDelegate: AnyObject {
    func setupWantsToStart(_ request: SessionRequest)
}

/// The normal app window where a session is configured (web/setup.html).
final class SetupWindowController: NSWindowController, NSWindowDelegate, WebHostDelegate {
    weak var startDelegate: SetupWindowDelegate?

    private let host: WebHost
    private let store: Store
    private let gallery: Gallery
    private let spotify: SpotifyController
    private let focus: FocusManager

    init(store: Store, gallery: Gallery, spotify: SpotifyController, focus: FocusManager, schemeHandler: BrickSchemeHandler) {
        self.store = store
        self.gallery = gallery
        self.spotify = spotify
        self.focus = focus

        let rect = NSRect(x: 0, y: 0, width: 1040, height: 720)
        let window = NSWindow(contentRect: rect,
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.title = "Analog Brick"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 900, height: 640)
        window.backgroundColor = NSColor(srgbRed: 5 / 255, green: 6 / 255, blue: 10 / 255, alpha: 1)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.appearance = NSAppearance(named: .darkAqua)

        let container = NSView(frame: rect)
        host = WebHost(page: "setup", frame: container.bounds, schemeHandler: schemeHandler)
        host.webView.autoresizingMask = [.width, .height]
        container.addSubview(host.webView)
        let drag = DragStripView(frame: NSRect(x: 0, y: rect.height - 30, width: rect.width, height: 30))
        drag.autoresizingMask = [.width, .minYMargin]
        container.addSubview(drag)
        window.contentView = container

        super.init(window: window)
        window.delegate = self
        host.delegate = self
        window.setFrameAutosaveName("AnalogBrickSetup")
        if !window.setFrameUsingName("AnalogBrickSetup") { window.center() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func present() {
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        window?.makeFirstResponder(host.webView)
        refreshStatus()
        host.send("stats", store.stats().payload())
    }

    func showError(_ message: String) {
        host.send("error", ["message": message])
    }

    // MARK: status

    private func statusPayload() -> [String: Any] {
        [
            "focus": focus.statusPayload(),
            "spotify": spotify.statusPayload(),
            "audio": ["supported": true, "permission": AudioCapture.hasPermission ? "granted" : "denied"],
            "loginItem": ["status": LoginItem.status()],
            "displays": NSScreen.screens.count,
        ]
    }

    /// Send what we know now, then again once the (async) Shortcuts check completes.
    func refreshStatus() {
        host.send("status", statusPayload())
        focus.refresh { [weak self] in
            guard let self else { return }
            self.host.send("status", self.statusPayload())
        }
    }

    // MARK: WebHostDelegate

    func webHost(_ host: WebHost, didReceive type: String, payload: [String: Any]) {
        switch type {
        case "ready":
            host.send("init", [
                "page": "setup",
                "version": AppInfo.version,
                "settings": store.settings.payload(),
                "status": statusPayload(),
                "stats": store.stats().payload(),
                "gallery": gallery.payload(),
            ] as [String: Any])
            refreshStatus()
            if store.settings.resumeAfterRestart && LoginItem.status() == "notRegistered" {
                LoginItem.setEnabled(true)
                after(0.5) { [weak self] in self?.refreshStatus() }
            }

        case "settings.save":
            let before = store.settings
            store.replaceSettings(before.applying(payload))
            host.send("settings", store.settings.payload())
            if before.resumeAfterRestart != store.settings.resumeAfterRestart {
                LoginItem.setEnabled(store.settings.resumeAfterRestart)
                after(0.5) { [weak self] in self?.refreshStatus() }
            }

        case "session.start":
            switch SessionRequest.parse(payload) {
            case .success(let request): startDelegate?.setupWantsToStart(request)
            case .failure(let error): showError(error.description)
            }

        case "status.refresh":
            refreshStatus()

        case "focus.openShortcuts":
            focus.openShortcutsApp()
        case "focus.test":
            focus.turnOn { [weak self] _ in
                after(3) {
                    self?.focus.turnOff { _ in self?.refreshStatus() }
                }
            }

        case "spotify.requestPermission":
            spotify.requestPermission { [weak self] _ in
                self?.refreshStatus()
                NSApp.activate(ignoringOtherApps: true)
                self?.window?.makeKeyAndOrderFront(nil)
            }
        case "spotify.launch":
            spotify.launch(hidden: true) { [weak self] _ in after(1) { self?.refreshStatus() } }

        case "audio.requestPermission":
            if !AudioCapture.requestPermission() {
                // After the first prompt macOS only offers System Settings.
                AudioCapture.openPrivacySettings()
            }
            after(1) { [weak self] in self?.refreshStatus() }

        case "loginItem.openSettings":
            LoginItem.openSettings()

        case "gallery.choose":
            chooseGalleryFolder()
        case "gallery.clear":
            store.update { $0.galleryFolder = nil }
            gallery.scan(path: nil)
            host.send("gallery", gallery.payload())

        case "openURL":
            if let s = payload.string("url"), let url = URL(string: s), ["https", "http"].contains(url.scheme ?? "") {
                NSWorkspace.shared.open(url)
            }

        case "app.quit":
            NSApp.terminate(nil)

        default:
            break
        }
    }

    private func chooseGalleryFolder() {
        guard let window else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Use Folder"
        panel.message = "Choose a folder of photos for the Gallery visual."
        if let current = store.settings.galleryFolder { panel.directoryURL = URL(fileURLWithPath: current) }
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .OK, let url = panel.url else { return }
            self.store.update { $0.galleryFolder = url.path }
            DispatchQueue.global(qos: .userInitiated).async {
                self.gallery.scan(path: url.path)
                DispatchQueue.main.async { self.host.send("gallery", self.gallery.payload()) }
            }
        }
    }

    // MARK: NSWindowDelegate

    func windowWillClose(_ notification: Notification) {
        // Closing the setup window quits the app (nothing runs in the background between sessions).
        after(0.1) { NSApp.terminate(nil) }
    }
}
