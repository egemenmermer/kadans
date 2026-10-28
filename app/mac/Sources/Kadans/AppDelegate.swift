import AppKit

/// Menu bar item + popover.
/// k19: pushed, not just polled. A change notice (hook event, usage sample, session file; see ChangeWatcher) refreshes
/// the panel within ~0.5 s while the popover is open, and the menu bar's working count (`agents --brief --json`) while it
/// is closed. Fallback polls: panel every 2 s while open; the closed tick every 60 s (120 s on battery or after 5 min
/// without input, see Schedule). Never two CLI runs of the same kind at once (Gate), and the closed-popover runs keep to a
/// CPU budget. perf-1: one node start per tick, open (`live --json`: status + agents) or closed (`live --brief --json`:
/// status + brief, at most every 30 s; the agents are counted at most every count gap, the old brief budget).
/// Reads fresh usage (`kadans usage fetch`) every 120 s and on popover open when the last reading is over 60 s old (perf-1:
/// the timer skips it while the API reader is off or backing off).
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

    private var watcher: ChangeWatcher?
    private var pollTimer: Timer?
    private lazy var panelGate = Gate(minGap: Self.openMinGap) { [weak self] done in
        guard let self else { return done() }
        self.panel.refresh(completion: done)
    }
    /// perf-1: the closed popover's one tick (`live --brief --json`: the menu bar title and the working count).
    private lazy var tickGate = Gate(minGap: Schedule.closedMinGap) { [weak self] done in self?.runTick(done) ?? done() }
    private let liveQueue = DispatchQueue(label: "dev.kadans.live", qos: .utility)
    /// Seconds one closed tick that counted the agents takes (moving average); sets the count gap (Schedule.countGap).
    private var countCost: TimeInterval = 0.3
    /// An agents change came while the count gap held the count back: one more tick once the gap is over.
    private var countDue = false
    private var lastCount: Date = .distantPast
    private var countWake: DispatchWorkItem?
    private var briefFailLogged = false
    private var lastBrief: Brief?
    /// From the last status read: the usage API reader is on, and when it may try again (perf-1: no idle `usage fetch`).
    private var usageApiOn: Bool?
    private var usageNextAt: Double?
    /// k25: the spare-quota check (`gas tick --json`) every 5 min and after each window reset, popover open or closed.
    private let autoGas = AutoGas()
    private let autoCompact = AutoCompact() // k55: `compact tick` every 5 min while autoCompact is on
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
            self?.autoCompact.noteConfig(cfg)
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
        tickGate.request()
        // perf-1: back from sleep or a locked screen, the closed tick runs at once (the fallback may be minutes away).
        for name in [NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification, NSWorkspace.sessionDidBecomeActiveNotification] {
            NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                guard let self, !self.popover.isShown else { return }
                self.tickGate.request()
            }
        }
        if noUsageFetch { log("usage fetch off (KADANS_NO_USAGE_FETCH=1)") } else { startUsagePolling() }
        autoGas.onStarted = { [weak self] _ in
            guard let self else { return }
            if self.popover.isShown { self.panelGate.request() } else { self.tickGate.request() }
        }
        autoGas.start()
        autoCompact.onCompacted = { [weak self] _ in
            guard let self, self.popover.isShown else { return }
            self.panelGate.request()
        }
        autoCompact.start()
    }

    func applicationWillTerminate(_ note: Notification) {
        phone.serve.shutdown()
    }

    // MARK: push refresh (k19)

    private func changed(_ kinds: Set<ChangeWatcher.Kind>) {
        if popover.isShown {
            panelGate.request()
        } else {
            if kinds.contains(.agents) { countDue = true }
            tickGate.request()
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

    /// The closed fallback: a change notice wakes the tick; this only covers the time rules (working -> idle after 2 min,
    /// an old reading dimmed after 10 min, window resets). It runs the tick when the last one is older than the fallback.
    private func startClosedPolls() {
        stopPolls()
        let b = Timer(timeInterval: Schedule.closedFallback, repeats: true) { [weak self] _ in
            guard let self else { return }
            let gap = Schedule.fallback(onBattery: Power.onBattery, userIdle: Power.userIdle)
            if Date().timeIntervalSince(self.tickGate.lastStart) >= gap - 2 { self.tickGate.request() }
        }
        b.tolerance = 5
        RunLoop.main.add(b, forMode: .common)
        pollTimer = b
    }

    private func stopPolls() {
        pollTimer?.invalidate()
        pollTimer = nil
        tickGate.cancelPending()
        panelGate.cancelPending()
    }

    /// The closed tick off the main thread: `live --brief --json` = {status, brief, counted} in one node start (an older CLI
    /// without `live`: `agents --brief --json` and `status --json`). The run time of a tick that counted sets the count gap,
    /// so counting stays within Schedule.countCpuShare of a core however slow Orca is.
    private func runTick(_ done: @escaping () -> Void) {
        let gap = Schedule.countGap(cost: countCost)
        liveQueue.async { [weak self] in
            let started = Date()
            let r = CLI.run(["live", "--brief", "--json", "--count-gap", String(Int(gap.rounded()))], timeout: 15)
            var obj = r.json as? [String: Any]
            if obj == nil {
                let b = CLI.run(["agents", "--brief", "--json"], timeout: 10)
                let s = CLI.run(["status", "--json"])
                if !s.ok { log("status --json failed (code \(s.code), timeout \(s.timedOut)): \(s.err)") }
                obj = ["brief": b.json ?? NSNull(), "status": s.json ?? NSNull(), "counted": true]
            }
            let took = Date().timeIntervalSince(started)
            let brief = Brief(json: obj?["brief"])
            let status = obj?["status"] as? [String: Any]
            let counted = obj?["counted"] as? Bool ?? true
            DispatchQueue.main.async {
                guard let self else { return done() }
                if counted {
                    self.countCost = self.countCost * 0.7 + took * 0.3
                    self.lastCount = started
                    self.countDue = false
                    self.countWake?.cancel()
                    self.countWake = nil
                } else if self.countDue && self.countWake == nil && !self.popover.isShown {
                    let wait = max(1, self.lastCount.addingTimeInterval(Schedule.countGap(cost: self.countCost)).timeIntervalSinceNow + 1.5)
                    let w = DispatchWorkItem { [weak self] in
                        guard let self else { return }
                        self.countWake = nil
                        if !self.popover.isShown { self.tickGate.request() }
                    }
                    self.countWake = w
                    DispatchQueue.main.asyncAfter(deadline: .now() + wait, execute: w)
                }
                if brief == nil && !self.briefFailLogged {
                    self.briefFailLogged = true
                    log("live --brief --json: no brief yet (code \(r.code)); working motion stays off until it answers")
                }
                if brief != self.lastBrief, let b = brief { log("brief: working \(b.working), needs you \(b.needsYou)") }
                self.lastBrief = brief
                if !self.popover.isShown {
                    self.blinker.setWorking(self.fakeWorking ?? brief?.working)
                    self.updateItem(status)
                }
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
        let t = Timer(timeInterval: Self.usageEvery, repeats: true) { [weak self] _ in
            guard let self else { return }
            let next = self.usageNextAt.map { Date(timeIntervalSince1970: $0 / 1000) }
            if Schedule.fetchUsage(now: Date(), apiOn: self.usageApiOn, nextAt: next) { self.fetchUsage() }
        }
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
                    if self.popover.isShown { self.panelGate.request() } else { self.tickGate.request() }
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
        if let api = status?["usageApi"] as? [String: Any] {
            usageApiOn = api["enabled"] as? Bool
            usageNextAt = (api["nextAt"] as? NSNumber)?.doubleValue
        }
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

