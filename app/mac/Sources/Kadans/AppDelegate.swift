import AppKit

/// Menu bar item + popover. Refreshes every 5 s while the popover is open, 30 s otherwise.
final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private let panel = PanelController()
    private var timer: Timer?
    private var lastTitle = ""

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.accessory)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = MenuBarBlob.image(face: .work)
            button.imagePosition = .imageLeading
            button.title = "–"
            button.setAccessibilityLabel("Kadans")
            button.target = self
            button.action = #selector(togglePopover(_:))
        }

        popover.behavior = .transient
        popover.animates = true
        popover.contentViewController = panel
        popover.contentSize = NSSize(width: PanelController.width, height: 420)
        popover.delegate = self

        panel.onSize = { [weak self] h in self?.popover.contentSize = NSSize(width: PanelController.width, height: h) }
        panel.onClose = { [weak self] in self?.popover.performClose(nil) }
        panel.onStatus = { [weak self] status in self?.updateItem(status) }
        panel.onLoaded = { [weak self] in self?.panel.refresh(full: true) }
        panel.load()
        schedule(every: 30)
    }

    @objc private func togglePopover(_ sender: Any?) {
        if popover.isShown {
            popover.performClose(sender)
            return
        }
        guard let button = statusItem.button else { return }
        // An accessory app must be active, or Escape and focus never reach the web view.
        NSApp.activate(ignoringOtherApps: true)
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
        panel.refresh(full: true)
        schedule(every: 5)
    }

    func popoverDidClose(_ notification: Notification) { schedule(every: 30) }

    private func schedule(every seconds: TimeInterval) {
        timer?.invalidate()
        let t = Timer(timeInterval: seconds, repeats: true) { [weak self] _ in self?.panel.refresh() }
        t.tolerance = seconds / 10
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    // MARK: menu bar item (the menu bar item)

    private func updateItem(_ status: [String: Any]?) {
        guard let button = statusItem.button else { return }
        let item = MenuBarItem(status: status)
        button.image = MenuBarBlob.image(face: item.face)
        button.attributedTitle = item.title
        button.setAccessibilityLabel(item.accessibilityLabel)
        if item.plainTitle != lastTitle {
            lastTitle = item.plainTitle
            log("menu bar: \"\(item.plainTitle)\" (\(item.accessibilityLabel))")
        }
    }
}

/// What the status item shows, derived from `kadans status --json`.
struct MenuBarItem {
    let face: MenuBarBlob.Face
    let title: NSAttributedString
    let plainTitle: String
    let accessibilityLabel: String

    init(status: [String: Any]?) {
        let accounts = status?["accounts"] as? [[String: Any]] ?? []
        let acct = accounts.first { ($0["own"] as? Bool) == true } ?? accounts.first
        let limits = acct?["limits"] as? [[String: Any]] ?? []
        let named = acct?["limit"] as? String
        func pct(_ l: [String: Any]) -> Double { (l["pct"] as? NSNumber)?.doubleValue ?? -1 }
        // The tightest applicable limit: the one the account state names, else the highest percentage.
        let lim = limits.first { ($0["name"] as? String) == named && named != nil } ?? limits.max { pct($0) < pct($1) }
        let state = acct?["state"] as? String ?? "nodata"

        guard let lim, pct(lim) >= 0 else {
            face = .work
            plainTitle = "–"
            title = NSAttributedString(string: "–", attributes: [.font: Self.font, .foregroundColor: NSColor.labelColor])
            accessibilityLabel = status == nil ? "Kadans, can't read usage data" : "Kadans, no usage data yet"
            return
        }
        let p = Int(pct(lim).rounded())
        let text = NSMutableAttributedString()
        var dot: NSColor?
        switch state {
        case "brake": dot = .systemOrange
        case "gas": dot = .systemGreen
        default: dot = nil
        }
        if let dot {
            text.append(NSAttributedString(string: "● ", attributes: [.font: NSFont.systemFont(ofSize: 7), .foregroundColor: dot,
                                                                      .baselineOffset: 2]))
        }
        text.append(NSAttributedString(string: "\(p)%", attributes: [.font: Self.font, .foregroundColor: NSColor.labelColor]))
        face = state == "brake" ? .slow : .work
        title = text
        plainTitle = (dot != nil ? "● " : "") + "\(p)%"

        let name: String
        switch lim["name"] as? String {
        case "five_hour": name = "5-hour limit"
        case "seven_day": name = "7-day limit"
        case let other?: name = other.replacingOccurrences(of: "_", with: " ") + " limit"
        case nil: name = "limit"
        }
        let words = ["brake": "braking", "cruise": "on pace", "gas": "spare quota", "early": "early in the window",
                     "unknown": "too little data yet"][state] ?? state
        accessibilityLabel = "Kadans, \(name) \(p) percent, \(words)"
    }

    static let font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize(for: .small) + 1, weight: .medium)
}

/// The 16 px blob as a template image (adapts to light/dark menu bars). Eyes are cut out.
enum MenuBarBlob {
    enum Face { case work, slow }

    static func image(face: Face) -> NSImage {
        let img = NSImage(size: NSSize(width: 16, height: 16), flipped: true) { _ in
            // Same shape as the panel's "square" blob (viewBox 32), scaled by 0.5.
            let path = NSBezierPath(roundedRect: NSRect(x: 2.25, y: 2.5, width: 11.5, height: 11), xRadius: 3.75, yRadius: 3.75)
            switch face {
            case .work:
                path.append(NSBezierPath(roundedRect: NSRect(x: 5.9, y: 5.6, width: 1.5, height: 3.4), xRadius: 0.75, yRadius: 0.75))
                path.append(NSBezierPath(roundedRect: NSRect(x: 8.6, y: 5.6, width: 1.5, height: 3.4), xRadius: 0.75, yRadius: 0.75))
            case .slow:
                path.append(NSBezierPath(roundedRect: NSRect(x: 5.4, y: 7.0, width: 2.2, height: 1.3), xRadius: 0.65, yRadius: 0.65))
                path.append(NSBezierPath(roundedRect: NSRect(x: 8.4, y: 7.0, width: 2.2, height: 1.3), xRadius: 0.65, yRadius: 0.65))
            }
            path.windingRule = .evenOdd
            NSColor.black.setFill()
            path.fill()
            return true
        }
        img.isTemplate = true
        return img
    }
}
