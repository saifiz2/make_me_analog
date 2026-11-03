import AppKit
import BrickCore

struct LaunchOptions {
    /// Started by the login agent: re-lock if a session is still running, otherwise quit silently.
    var resumeOnly = false
    /// `--snapshot <page|mode> <out.png> [WxH]`: render a page offscreen and exit (CI self-test).
    var snapshotTarget: String?
    var snapshotOut: String?
    var snapshotSize = NSSize(width: 1440, height: 900)

    init(arguments: [String]) {
        var i = 1
        while i < arguments.count {
            switch arguments[i] {
            case "--resume-only":
                resumeOnly = true
            case "--snapshot":
                if i + 2 < arguments.count {
                    snapshotTarget = arguments[i + 1]
                    snapshotOut = arguments[i + 2]
                    i += 2
                    if i + 1 < arguments.count, arguments[i + 1].contains("x") {
                        let parts = arguments[i + 1].split(separator: "x").compactMap { Double($0) }
                        if parts.count == 2 { snapshotSize = NSSize(width: parts[0], height: parts[1]); i += 1 }
                    }
                }
            default:
                break
            }
            i += 1
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, SetupWindowDelegate {
    let options: LaunchOptions
    let store = Store()
    let gallery = Gallery()
    let spotify = SpotifyController()
    let focus = FocusManager()
    private(set) lazy var schemeHandler = BrickSchemeHandler(webRoot: AppInfo.webRoot, gallery: gallery)

    private var setup: SetupWindowController?
    private var lock: LockController?
    private var snapshotter: Snapshotter?

    init(options: LaunchOptions) {
        self.options = options
        super.init()
    }

    // MARK: NSApplicationDelegate

    func applicationDidFinishLaunching(_ notification: Notification) {
        Log.app.info("Analog Brick \(AppInfo.version, privacy: .public) launched; web root \(AppInfo.webRoot.path, privacy: .public)")

        if let target = options.snapshotTarget, let out = options.snapshotOut {
            let s = Snapshotter(target: target, output: out, size: options.snapshotSize, schemeHandler: schemeHandler)
            snapshotter = s
            s.run()
            return
        }

        // One instance only (the login agent and a manual launch could otherwise race).
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: AppInfo.bundleID)
            .filter { $0.processIdentifier != getpid() && !$0.isTerminated }
        if let other = others.first {
            if !options.resumeOnly { _ = other.activate(options: []) }
            NSApp.terminate(nil)
            return
        }

        NSApp.mainMenu = MainMenu.standard()
        gallery.scan(path: store.settings.galleryFolder)

        if let record = store.loadSession() {
            if record.isActive(at: Date()) {
                startLock(record, resumed: true)
                return
            }
            // The session ran out while the Mac was off or the app wasn't running: it counts.
            store.appendHistory(SessionLogEntry(startedAt: record.startedAt,
                                                plannedMs: Int64(record.duration * 1000),
                                                focusedMs: Int64(record.duration * 1000),
                                                completed: true))
            store.saveSession(nil)
        }

        if options.resumeOnly {
            NSApp.terminate(nil)
            return
        }
        showSetup()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        lock == nil ? .terminateNow : .terminateCancel
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if lock == nil { showSetup() }
        return false
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    // MARK: sessions

    private func showSetup() {
        if setup == nil {
            let s = SetupWindowController(store: store, gallery: gallery, spotify: spotify, focus: focus, schemeHandler: schemeHandler)
            s.startDelegate = self
            setup = s
        }
        setup?.present()
    }

    func setupWantsToStart(_ request: SessionRequest) {
        guard lock == nil else { return }
        let now = Date()
        let record = SessionRecord(startedAt: now,
                                   endsAt: now.addingTimeInterval(TimeInterval(request.durationMin) * 60),
                                   intention: request.intention,
                                   mode: request.mode,
                                   pin: PinHash.make(pin: request.pin),
                                   pinLength: request.pin.count)
        store.update {
            $0.durationMin = request.durationMin
            $0.mode = request.mode
            $0.intention = request.intention
        }
        store.saveSession(record)
        setup?.window?.orderOut(nil)
        startLock(record, resumed: false)
    }

    private func startLock(_ record: SessionRecord, resumed: Bool) {
        let controller = LockController(session: record, store: store, gallery: gallery, spotify: spotify,
                                        focus: focus, schemeHandler: schemeHandler, resumed: resumed)
        controller.onFinish = { [weak self] _ in self?.lockDidFinish() }
        lock = controller
        NSApp.mainMenu = MainMenu.locked()
        controller.start()
    }

    private func lockDidFinish() {
        lock = nil
        NSApp.mainMenu = MainMenu.standard()
        showSetup()
    }
}

/// Menus. While locked, the menu bar is hidden and the menu is stripped so no key equivalent does anything.
enum MainMenu {
    static func standard() -> NSMenu {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let app = NSMenu(title: "Analog Brick")
        app.addItem(withTitle: "About Analog Brick", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Analog Brick", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit Analog Brick", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = app
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let windowItem = NSMenuItem()
        let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        window.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = window
        main.addItem(windowItem)
        NSApp.windowsMenu = window

        return main
    }

    static func locked() -> NSMenu {
        let main = NSMenu()
        let appItem = NSMenuItem()
        appItem.submenu = NSMenu(title: "Analog Brick")
        main.addItem(appItem)
        return main
    }
}
