import AppKit

/// A borderless window that covers one display above everything ordinary (menu bar, Dock,
/// notifications, other apps' windows) for the length of a session.
final class OverlayWindow: NSWindow {
    static let lockLevel = NSWindow.Level.screenSaver
    static let peekLevel = NSWindow.Level.normal

    let displayID: CGDirectDisplayID

    init(screen: NSScreen) {
        displayID = screen.displayID
        super.init(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        setFrame(screen.frame, display: false)
        isReleasedWhenClosed = false
        backgroundColor = .black
        isOpaque = true
        hasShadow = false
        level = OverlayWindow.lockLevel
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        isMovable = false
        acceptsMouseMovedEvents = true
        animationBehavior = .none
        hidesOnDeactivate = false
        canHide = false
        isExcludedFromWindowsMenu = true
        tabbingMode = .disallowed
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    // Nothing may close, minimise or move these windows while a session runs.
    override func performClose(_ sender: Any?) {}
    override func performMiniaturize(_ sender: Any?) {}
    override func miniaturize(_ sender: Any?) {}
    override func performZoom(_ sender: Any?) {}
    override func toggleFullScreen(_ sender: Any?) {}
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }

    /// Unhandled keys would otherwise beep.
    override func noResponder(for eventSelector: Selector) {}

    /// Called when the session really ends.
    func dismiss() {
        orderOut(nil)
        close()
    }
}

/// Invisible strip across the top of the setup window so the (transparent) title bar area stays draggable
/// even though a web view sits underneath it.
final class DragStripView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
            if action == "Minimize" { window?.performMiniaturize(nil) } else if action != "None" { window?.performZoom(nil) }
            return
        }
        window?.performDrag(with: event)
    }
}
