import AppKit

/// Menu bar item + popover. Refreshes every 5 s while the popover is open, 30 s otherwise.
/// Reads fresh usage (`kadans usage fetch`) every 120 s and on popover open when the last reading is over 60 s old.
final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private let panel = PanelController()
    private var timer: Timer?
    private var lastTitle = ""
    private let blinker = BlobBlinker()
    private var usageTimer: Timer?
    /// Main thread only: true while a `usage fetch` runs, so two never run at once.
    private var usageBusy = false
    private let usageQueue = DispatchQueue(label: "dev.kadans.usage", qos: .utility)
    /// Newest own-account sample time (epoch ms) from the last status read.
    private var ownLastSample: Double?

    static let usageEvery: TimeInterval = 120
    static let usageStaleOnOpen: TimeInterval = 60

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.accessory)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = MenuBarBlob.image(face: .work)
            blinker.button = button
            blinker.isPopoverShown = { [weak self] in self?.popover.isShown ?? false }
            button.addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                                  owner: blinker, userInfo: nil))
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
        panel.softenFirstFrame()

        panel.onSize = { [weak self] h in self?.popover.contentSize = NSSize(width: PanelController.width, height: h) }
        panel.onClose = { [weak self] in self?.popover.performClose(nil) }
        panel.onStatus = { [weak self] status in self?.updateItem(status) }
        panel.onLoaded = { [weak self] in self?.panel.refresh(full: true) }
        panel.load()
        schedule(every: 30)
        startUsagePolling()
    }

    // MARK: fresh usage (lib/usage-api.mjs; the CLI checks config usageApi, back-off and the 60 s minimum itself)

    private func startUsagePolling() {
        let t = Timer(timeInterval: Self.usageEvery, repeats: true) { [weak self] _ in self?.fetchUsage() }
        t.tolerance = 10
        RunLoop.main.add(t, forMode: .common)
        usageTimer = t
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.fetchUsage() }
    }

    /// Runs `kadans usage fetch --json` off the main thread. The first run may wait on a macOS Keychain dialog,
    /// hence the long timeout. Logs only the result code (the CLI never prints a token).
    private func fetchUsage() {
        guard !usageBusy else { return }
        usageBusy = true
        usageQueue.async { [weak self] in
            let r = CLI.run(["usage", "fetch", "--json"], timeout: 90)
            let obj = r.json as? [String: Any]
            DispatchQueue.main.async {
                guard let self else { return }
                self.usageBusy = false
                if (obj?["ok"] as? Bool) == true {
                    self.panel.refresh()
                } else {
                    let code = obj?["code"] as? String ?? (r.timedOut ? "timeout" : "exit \(r.code)")
                    if !["off", "too_soon", "backoff"].contains(code) { log("usage fetch: \(code)") }
                }
            }
        }
    }

    @objc private func togglePopover(_ sender: Any?) {
        if popover.isShown {
            popover.performClose(sender)
            return
        }
        guard let button = statusItem.button else { return }
        // An accessory app must be active, or Escape and focus never reach the web view.
        NSApp.activate(ignoringOtherApps: true)
        panel.prepareFade()
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        panel.fadeIn()
        blinker.blink(force: true)
        popover.contentViewController?.view.window?.makeKey()
        panel.refresh(full: true)
        schedule(every: 5)
        let newest = ownLastSample.map { Date(timeIntervalSince1970: $0 / 1000) } ?? .distantPast
        if Date().timeIntervalSince(newest) > Self.usageStaleOnOpen { fetchUsage() }
    }

    func popoverDidClose(_ notification: Notification) {
        panel.resetFade()
        schedule(every: 30)
    }

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
        let accounts = status?["accounts"] as? [[String: Any]] ?? []
        ownLastSample = (accounts.first { ($0["own"] as? Bool) == true }?["lastSample"] as? NSNumber)?.doubleValue
        blinker.setFace(item.face)  // a state change wins over a blink in progress
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
        // An old reading (no sample for 10+ minutes) is shown dimmed.
        let fresh = acct?["fresh"] as? Bool ?? true

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
        text.append(NSAttributedString(string: "\(p)%", attributes: [.font: Self.font,
                                                                    .foregroundColor: fresh ? NSColor.labelColor : NSColor.secondaryLabelColor]))
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
        accessibilityLabel = "Kadans, \(name) \(p) percent, \(words)" + (fresh ? "" : ", last reading is over 10 minutes old")
    }

    static let font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize(for: .small) + 1, weight: .medium)
}

/// The 16 px blob as a template image (adapts to light/dark menu bars). Eyes are cut out.
/// The closed-eyes frame keeps the body path untouched, so nothing around the eyes moves when it blinks.
enum MenuBarBlob {
    enum Face: CaseIterable {
        case work, slow
        var name: String { self == .work ? "work" : "slow" }
    }

    static let size = NSSize(width: 16, height: 16)

    /// Draws the blob into the current context, 16 x 16 points, top-left origin (flipped).
    static func draw(face: Face, eyesClosed: Bool = false) {
        // Same shape as the panel's "square" blob (viewBox 32), scaled by 0.5.
        let path = NSBezierPath(roundedRect: NSRect(x: 2.25, y: 2.5, width: 11.5, height: 11), xRadius: 3.75, yRadius: 3.75)
        func eye(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) {
            path.append(NSBezierPath(roundedRect: NSRect(x: x, y: y, width: w, height: h), xRadius: min(w, h) / 2, yRadius: min(w, h) / 2))
        }
        switch (face, eyesClosed) {
        case (.work, false):
            eye(5.9, 5.6, 1.5, 3.4)
            eye(8.6, 5.6, 1.5, 3.4)
        case (.work, true):
            // Eyes shut: two thin lines at the height the open eyes were centred on.
            eye(5.5, 6.8, 2.1, 1.0)
            eye(8.4, 6.8, 2.1, 1.0)
        case (.slow, false):
            eye(5.4, 7.0, 2.2, 1.3)
            eye(8.4, 7.0, 2.2, 1.3)
        case (.slow, true):
            // The half-shut bars thin out and sink a little: lids all the way down.
            eye(5.4, 7.7, 2.2, 0.7)
            eye(8.4, 7.7, 2.2, 0.7)
        }
        path.windingRule = .evenOdd
        NSColor.black.setFill()
        path.fill()
    }

    static func image(face: Face, eyesClosed: Bool = false) -> NSImage {
        let img = NSImage(size: size, flipped: true) { _ in
            draw(face: face, eyesClosed: eyesClosed)
            return true
        }
        img.isTemplate = true
        return img
    }
}

/// Blinks the menu bar blob when the pointer enters it, and once when the popover opens.
/// No timers run while idle: a blink is a few one-shot work items that end by themselves. Reduce motion turns it off.
final class BlobBlinker: NSObject {
    weak var button: NSStatusBarButton?
    var isPopoverShown: () -> Bool = { false }

    static let closedFor: TimeInterval = 0.11
    static let secondBlinkGap: TimeInterval = 0.12
    static let secondBlinkChance = 0.2
    static let minGap: TimeInterval = 1.5

    private var face: MenuBarBlob.Face = .work
    private var lastBlink: Date = .distantPast
    /// Bumped by every blink start and every face change; a pending step from an older blink does nothing.
    private var generation = 0

    static var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    /// The menu bar state changed: show the new face, open-eyed, and drop whatever blink was running.
    func setFace(_ f: MenuBarBlob.Face) {
        face = f
        generation += 1
        button?.image = MenuBarBlob.image(face: f)
    }

    @objc func mouseEntered(with event: NSEvent) {
        guard !isPopoverShown() else { return }
        blink(force: false)
    }

    /// force: the popover-open blink, which skips the popover and rate checks (never reduce motion).
    func blink(force: Bool, doubleBlink: Bool? = nil) {
        guard !Self.reduceMotion, let button else { return }
        let now = Date()
        if !force && now.timeIntervalSince(lastBlink) < Self.minGap { return }
        lastBlink = now
        generation += 1
        let gen = generation
        let again = doubleBlink ?? (Double.random(in: 0..<1) < Self.secondBlinkChance)
        step(gen, closed: true, remainingBlinks: again ? 2 : 1, button)
    }

    private func step(_ gen: Int, closed: Bool, remainingBlinks: Int, _ button: NSStatusBarButton) {
        guard gen == generation else { return }
        button.image = MenuBarBlob.image(face: face, eyesClosed: closed)
        let delay = closed ? Self.closedFor : Self.secondBlinkGap
        let nextClosed = !closed
        let left = closed ? remainingBlinks - 1 : remainingBlinks
        if !closed && left == 0 { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self, weak button] in
            guard let self, let button else { return }
            self.step(gen, closed: nextClosed, remainingBlinks: left, button)
        }
    }
}
