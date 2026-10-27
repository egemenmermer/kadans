import AppKit

/// Menu bar item + popover.
/// k19: pushed, not just polled. A change notice (hook event, usage sample, session file; see ChangeWatcher) refreshes
/// the panel within ~0.5 s while the popover is open, and the menu bar's working count (`agents --brief --json`) while it
/// is closed. Fallback polls: panel every 2 s while open; brief every 10 s and `status --json` every 30 s while closed.
/// Never two CLI runs of the same kind at once (Gate), and the closed-popover runs keep to a CPU budget.
/// Reads fresh usage (`kadans usage fetch`) every 120 s and on popover open when the last reading is over 60 s old.
/// k25: the spare-quota check (AutoGas: `gas tick --json` every 5 min and 1 min after each reset) runs on its own timers,
/// popover open or closed, screen locked or not.
final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private let panel = PanelController()
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

    // k19: push refresh and fallback polls
    static let openPoll: TimeInterval = 2
    static let openMinGap: TimeInterval = 1
    static let briefPoll: TimeInterval = 10
    static let statusPoll: TimeInterval = 30
    /// Share of one CPU core the closed-popover brief may use on average (status adds ~0.3 % at one run per 30 s).
    static let briefCpuShare = 0.005
    static let briefMinGap: TimeInterval = 3
    static let briefMaxGap: TimeInterval = 120

    private var watcher: ChangeWatcher?
    private var pollTimer: Timer?
    private var statusTimer: Timer?
    private lazy var panelGate = Gate(minGap: Self.openMinGap) { [weak self] done in
        guard let self else { return done() }
        self.panel.refresh(completion: done)
    }
    private lazy var briefGate = Gate(minGap: Self.briefPoll) { [weak self] done in self?.runBrief(done) ?? done() }
    private lazy var statusGate = Gate(minGap: Self.statusPoll) { [weak self] done in self?.runStatus(done) ?? done() }
    private let liveQueue = DispatchQueue(label: "dev.kadans.live", qos: .utility)
    /// Seconds one brief run takes (moving average); sets the closed-popover brief gap.
    private var briefCost: TimeInterval = 0.2
    private var briefFailLogged = false
    private var lastBrief: Brief?
    /// k25: the spare-quota check (`gas tick --json`) every 5 min and after each window reset, popover open or closed.
    private let autoGas = AutoGas()
    /// k28: the `kadans serve` child while config `phone` is true, pairing and the device list.
    private let phone = Phone()
    private var termSource: DispatchSourceSignal?

    /// Dev and measuring only: KADANS_NO_USAGE_FETCH=1 never runs `usage fetch`; KADANS_FAKE_WORKING=<n> stands in for the
    /// brief's working count (until `agents --brief --json` exists).
    private let env = ProcessInfo.processInfo.environment
    private var noUsageFetch: Bool { env["KADANS_NO_USAGE_FETCH"] == "1" }
    private var fakeWorking: Int? { env["KADANS_FAKE_WORKING"].flatMap { Int($0) } }

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
        blinker.start()

        popover.behavior = .transient
        popover.animates = true
        popover.contentViewController = panel
        popover.contentSize = NSSize(width: PanelController.width, height: 420)
        popover.delegate = self
        panel.softenFirstFrame()

        panel.onSize = { [weak self] h in self?.resizePopover(to: h) }
        panel.onClose = { [weak self] in self?.popover.performClose(nil) }
        panel.onStatus = { [weak self] status in self?.updateItem(status) }
        panel.onAgents = { [weak self] agents in
            guard let self, self.popover.isShown else { return }
            self.blinker.setWorking(self.fakeWorking ?? Brief.working(inAgents: agents))
        }
        panel.onConfig = { [weak self] cfg in
            self?.autoGas.noteConfig(cfg)
            self?.phone.noteConfig(cfg) // the launch refresh's config starts serve when phone is true
        }
        panel.phone = phone
        panel.computers = Computers() // k41: Settings › Computers
        panel.updater = AppUpdater.make() // k44: premium build with SUFeedURL + SUPublicEDKey only; nil otherwise
        // A plain SIGTERM would skip applicationWillTerminate and leave the serve child running: quit properly instead.
        signal(SIGTERM, SIG_IGN)
        let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        term.setEventHandler { NSApp.terminate(nil) }
        term.resume()
        termSource = term
        panel.onLoaded = { [weak self] in self?.panel.refresh(full: true) }
        panel.load()
        // k42: the popover's height cap follows the status item's screen (resolution, Dock, display changes).
        panel.fit(screen: statusItem.button?.window?.screen ?? NSScreen.main)
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.panel.fit(screen: self.statusItem.button?.window?.screen ?? NSScreen.main)
        }

        let w = ChangeWatcher { [weak self] kinds in self?.changed(kinds) }
        w.start()
        watcher = w
        startClosedPolls()
        briefGate.request()
        if noUsageFetch { log("usage fetch off (KADANS_NO_USAGE_FETCH=1)") } else { startUsagePolling() }
        autoGas.onStarted = { [weak self] _ in
            guard let self else { return }
            if self.popover.isShown { self.panelGate.request() } else { self.briefGate.request(); self.statusGate.request() }
        }
        autoGas.start()
    }

    func applicationWillTerminate(_ note: Notification) {
        phone.serve.shutdown()
    }

    // MARK: push refresh (k19)

    private func changed(_ kinds: Set<ChangeWatcher.Kind>) {
        if popover.isShown {
            panelGate.request()
        } else {
            if kinds.contains(.agents) { briefGate.request() }
            if kinds.contains(.usage) { statusGate.request() }
        }
    }

    private func startOpenPoll() {
        stopPolls()
        let t = Timer(timeInterval: Self.openPoll, repeats: true) { [weak self] _ in
            guard let self else { return }
            // A fallback only: skip it when a change notice refreshed the panel moments ago.
            if Date().timeIntervalSince(self.panel.lastRefresh) >= Self.openPoll - 0.25 { self.panelGate.request() }
        }
        t.tolerance = 0.2
        RunLoop.main.add(t, forMode: .common)
        pollTimer = t
    }

    private func startClosedPolls() {
        stopPolls()
        let b = Timer(timeInterval: Self.briefPoll, repeats: true) { [weak self] _ in self?.briefGate.request() }
        b.tolerance = 1
        RunLoop.main.add(b, forMode: .common)
        pollTimer = b
        let s = Timer(timeInterval: Self.statusPoll, repeats: true) { [weak self] _ in self?.statusGate.request() }
        s.tolerance = 3
        RunLoop.main.add(s, forMode: .common)
        statusTimer = s
    }

    private func stopPolls() {
        pollTimer?.invalidate()
        pollTimer = nil
        statusTimer?.invalidate()
        statusTimer = nil
        briefGate.cancelPending()
        statusGate.cancelPending()
        panelGate.cancelPending()
    }

    /// `agents --brief --json` off the main thread. Its run time sets the gap to the next one, so the brief stays within
    /// `briefCpuShare` of a core however slow the CLI is (a node start is ~0.05-0.1 s of CPU).
    private func runBrief(_ done: @escaping () -> Void) {
        liveQueue.async { [weak self] in
            let started = Date()
            let r = CLI.run(["agents", "--brief", "--json"], timeout: 10)
            let took = Date().timeIntervalSince(started)
            let brief = Brief(json: r.json)
            DispatchQueue.main.async {
                guard let self else { return done() }
                self.briefCost = self.briefCost * 0.7 + took * 0.3
                self.briefGate.minGap = min(Self.briefMaxGap, max(Self.briefMinGap, self.briefCost / Self.briefCpuShare))
                if brief == nil && !self.briefFailLogged {
                    self.briefFailLogged = true
                    log("agents --brief --json: no brief yet (code \(r.code)); working motion stays off until it answers")
                }
                if brief != self.lastBrief, let b = brief { log("brief: working \(b.working), needs you \(b.needsYou)") }
                self.lastBrief = brief
                if !self.popover.isShown { self.blinker.setWorking(self.fakeWorking ?? brief?.working) }
                done()
            }
        }
    }

    /// `status --json` alone (the menu bar title) while the popover is closed; the panel's full refresh does it when open.
    private func runStatus(_ done: @escaping () -> Void) {
        liveQueue.async { [weak self] in
            let r = CLI.run(["status", "--json"])
            let status = r.json as? [String: Any]
            DispatchQueue.main.async {
                guard let self else { return done() }
                if !r.ok { log("status --json failed (code \(r.code), timeout \(r.timedOut)): \(r.err)") }
                if !self.popover.isShown { self.updateItem(status) }
                done()
            }
        }
    }

    // MARK: popover size (k19): animated in step with the page's slide, never snapped

    static let resizeDuration: TimeInterval = 0.24
    private var resizeTimer: Timer?
    private var resizeTarget: CGFloat = 0

    /// The page reports a taller height when a slide starts (grows with the slide) and a shorter one only after its slide
    /// ended. Both are animated here frame by frame, from the size on screen now (a new report mid-way turns from where it
    /// is), with the page's own ease-out curve. NSPopover's own contentSize animation is off while this runs.
    private func resizePopover(to h: CGFloat) {
        let w = PanelController.width
        guard popover.isShown, !BlobBlinker.reduceMotion else {
            finishResize()
            popover.contentSize = NSSize(width: w, height: h)
            return
        }
        let from = popover.contentSize.height
        guard abs(from - h) >= 1 else { return }
        resizeTimer?.invalidate()
        resizeTarget = h
        popover.animates = false
        let start = CACurrentMediaTime()
        let t = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            let p = min(1, (CACurrentMediaTime() - start) / Self.resizeDuration)
            let e = Ease.panelOut(p)
            self.popover.contentSize = NSSize(width: w, height: (from + (h - from) * CGFloat(e)).rounded())
            if p >= 1 { self.finishResize() }
        }
        RunLoop.main.add(t, forMode: .common)
        resizeTimer = t
    }

    private func finishResize() {
        resizeTimer?.invalidate()
        resizeTimer = nil
        popover.animates = true
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
        guard !usageBusy, !noUsageFetch else { return }
        usageBusy = true
        usageQueue.async { [weak self] in
            let r = CLI.run(["usage", "fetch", "--json"], timeout: 90)
            let obj = r.json as? [String: Any]
            DispatchQueue.main.async {
                guard let self else { return }
                self.usageBusy = false
                if (obj?["ok"] as? Bool) == true {
                    if self.popover.isShown { self.panelGate.request() } else { self.statusGate.request() }
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
        panel.fit(screen: button.window?.screen ?? NSScreen.main) // k42: before the popover sizes itself
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        panel.fadeIn()
        blinker.blink(force: true)
        popover.contentViewController?.view.window?.makeKey()
        panel.refresh(full: true)
        startOpenPoll()
        let newest = ownLastSample.map { Date(timeIntervalSince1970: $0 / 1000) } ?? .distantPast
        if Date().timeIntervalSince(newest) > Self.usageStaleOnOpen { fetchUsage() }
    }

    func popoverDidClose(_ notification: Notification) {
        finishResize()
        if resizeTarget > 0 { popover.contentSize = NSSize(width: PanelController.width, height: resizeTarget) }
        panel.resetFade()
        startClosedPolls()
    }

    // MARK: menu bar item (the menu bar item)


    private func updateItem(_ status: [String: Any]?) {
        guard let button = statusItem.button else { return }
        let item = MenuBarItem(status: status)
        let accounts = status?["accounts"] as? [[String: Any]] ?? []
        ownLastSample = (accounts.first { ($0["own"] as? Bool) == true }?["lastSample"] as? NSNumber)?.doubleValue
        autoGas.noteStatus(status)
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
        // The own account, else the first one Kadans acts on (Codex is shown only, never the menu-bar default).
        let acct = accounts.first { ($0["own"] as? Bool) == true } ?? accounts.first { ($0["acts"] as? Bool) != false } ?? accounts.first
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

