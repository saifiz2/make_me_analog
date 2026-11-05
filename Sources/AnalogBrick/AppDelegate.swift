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
    private var instanceLockFD: Int32 = -1
    private var watchTimer: Timer?

    private var instanceLockPath: String { store.directory.appendingPathComponent("instance.lock").path }

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

        // Started by the login agent (at login, or kick-started as a watchdog when a session begins).
        if options.resumeOnly {
            guard let record = activeSessionOrRecordExpired() else {
                NSApp.terminate(nil)        // nothing to do; exit 0 so launchd doesn't restart us
                return
            }
            if acquireInstanceLock() {
                becomeLock(resuming: record)
            } else {
                watchRunningInstance()      // another instance holds the lock; take over if it dies
            }
            return
        }

        // A normal launch. One instance only: an exclusive flock picks a deterministic winner.
        guard acquireInstanceLock() else {
            NSRunningApplication.runningApplications(withBundleIdentifier: AppInfo.bundleID)
                .first { $0.processIdentifier != getpid() && !$0.isTerminated }
                .map { _ = $0.activate(options: []) }
            NSApp.terminate(nil)
            return
        }

        NSApp.mainMenu = MainMenu.standard()
        if let record = activeSessionOrRecordExpired() {
            scanGallery { [weak self] in self?.startLock(record, resumed: true) }
            return
        }
        scanGallery(nil)
        showSetup()
    }

    /// The active session, if any. A session that ran out while the Mac was off counts as completed.
    private func activeSessionOrRecordExpired() -> SessionRecord? {
        guard let record = store.loadSession() else { return nil }
        if record.isActive(at: Date()) { return record }
        store.appendHistory(SessionLogEntry(startedAt: record.startedAt,
                                            plannedMs: Int64(record.duration * 1000),
                                            focusedMs: Int64(record.duration * 1000),
                                            completed: true))
        store.saveSession(nil)
        return nil
    }

    private func scanGallery(_ then: (() -> Void)?) {
        let path = store.settings.galleryFolder
        DispatchQueue.global(qos: .userInitiated).async { [gallery = self.gallery] in
            gallery.scan(path: path)
            DispatchQueue.main.async { then?() }
        }
    }

    /// Exclusive, non-blocking. The kernel releases it if this process exits or is killed.
    private func acquireInstanceLock() -> Bool {
        if instanceLockFD >= 0 { return true }
        let fd = open(instanceLockPath, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
        guard fd >= 0 else { return true }  // can't create the lock file: don't make the app unlaunchable
        if flock(fd, LOCK_EX | LOCK_NB) == 0 {
            instanceLockFD = fd
            return true
        }
        close(fd)
        return false
    }

    private func becomeLock(resuming record: SessionRecord) {
        watchTimer?.invalidate()
        watchTimer = nil
        NSApp.setActivationPolicy(.regular)
        NSApp.mainMenu = MainMenu.standard()
        scanGallery { [weak self] in self?.startLock(record, resumed: true) }
    }

    /// Watchdog mode: block on the instance lock in the background. If the running instance is killed
    /// mid-session the lock is released, we get it, and the session is locked again within moments.
    /// Exits (status 0, so launchd leaves it alone) as soon as no session is active.
    private func watchRunningInstance() {
        Log.app.info("Watching the running instance for the rest of the session")
        let path = instanceLockPath
        let thread = Thread { [weak self] in
            let fd = open(path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
            guard fd >= 0 else { DispatchQueue.main.async { exit(0) }; return }
            _ = flock(fd, LOCK_EX)
            DispatchQueue.main.async {
                guard let self else { exit(0) }
                self.instanceLockFD = fd
                guard let record = self.activeSessionOrRecordExpired() else { exit(0) }
                Log.app.info("The running instance went away mid-session; locking again")
                self.becomeLock(resuming: record)
            }
        }
        thread.name = "instance-lock-watch"
        thread.start()
        let timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
            guard let self, self.lock == nil else { return }
            if self.store.loadSession()?.isActive(at: Date()) != true { exit(0) }
        }
        RunLoop.main.add(timer, forMode: .common)
        watchTimer = timer
    }

    /// Start the login agent now so it can watch this process for the rest of the session.
    private func startWatchdog() {
        guard LoginItem.status() == "enabled" else { return }
        DispatchQueue.global(qos: .utility).async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            p.arguments = ["kickstart", "gui/\(getuid())/\(LoginItem.label)"]
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            try? p.run()
            p.waitUntilExit()
        }
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
        startWatchdog()
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
