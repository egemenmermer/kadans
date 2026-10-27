import AppKit
import WebKit

/// Breaks the WKUserContentController -> handler retain cycle.
final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}

// BridgeResult begin (pure: no AppKit or WebKit, so it can be compiled and checked on its own)
/// What the page hears after a bridge action: `window.kadans.result({action, id, ok, why})`.
enum BridgeResult {
    static let maxWhy = 200

    /// The first non-empty line of the CLI's stderr (stdout when stderr is empty), without the "kadans: " prefix, at most
    /// `maxWhy` characters. Empty when the command succeeded.
    static func why(code: Int32, out: String, err: String, timedOut: Bool) -> String {
        if code == 0 && !timedOut { return "" }
        if timedOut { return "It took too long and was given up" }
        for text in [err, out] {
            for line in text.split(whereSeparator: \.isNewline) {
                var l = line.trimmingCharacters(in: .whitespaces)
                if l.hasPrefix("kadans: ") { l = String(l.dropFirst(8)) }
                if !l.isEmpty { return String(l.prefix(maxWhy)) }
            }
        }
        return "It failed (code \(code))"
    }

    static func payload(action: String, id: String, code: Int32, out: String, err: String, timedOut: Bool) -> [String: Any] {
        let ok = code == 0 && !timedOut
        return ["action": action, "id": id, "ok": ok, "why": why(code: code, out: out, err: err, timedOut: timedOut)]
    }

    /// A JSON value as a JavaScript literal. JSON is a subset of JavaScript once U+2028 / U+2029 are escaped, and
    /// JSONSerialization escapes quotes, backslashes and control characters, so no text ever reaches the page as source.
    static func literal(_ object: Any) -> String? {
        guard JSONSerialization.isValidJSONObject(object), let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        return String(decoding: data, as: UTF8.self)
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }

    static func script(_ payload: [String: Any]) -> String? {
        guard let json = literal(payload) else { return nil }
        return "window.kadans && window.kadans.result && window.kadans.result(\(json)); true;"
    }
}
// BridgeResult end

/// Hosts app/web/panel.html and is the only bridge between the page and the CLI.
final class PanelController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {
    static let width: CGFloat = 320
    /// The sane cap (k42): never taller than this, whatever the screen.
    static let maxHeight: CGFloat = 560
    /// k42: room kept free between the popover and the screen's visible bottom (arrow, gap under the menu bar, air).
    static let screenMargin: CGFloat = 44
    /// k42: the popover's height cap on the status item's screen: min(maxHeight, visible height under the menu bar - margin).
    private(set) var cap: CGFloat = PanelController.maxHeight

    private(set) var webView: WKWebView!
    private let theme: String?
    private var loaded = false
    private var refreshing = false
    /// A full refresh was asked for while another refresh ran; it runs right after.
    private var wantFull = false
    /// k19: a plain refresh was asked for while another ran (a change notice mid-refresh); it runs right after.
    private var wantAgain = false
    /// k19: when the last refresh finished (the host skips a fallback poll right after one).
    private(set) var lastRefresh: Date = .distantPast
    /// The latest `install --json` said settings.json needs changes; install-apply is refused otherwise.
    private var installChanged = false
    /// Snapshot of a fixture: the page may not reach the CLI at all (no refresh, no actions).
    var fixtureOnly = false
    /// Ids from the latest `agents --json`; a stop or compact request must name one of these.
    private var agentIds = Set<String>()
    /// k14: the page's size reports are coalesced (one popover resize per burst) and repeats dropped.
    private var pendingHeight: CGFloat?
    private var lastHeight: CGFloat = 0

    var onLoaded: (() -> Void)?
    var onSize: ((CGFloat) -> Void)?
    var onClose: (() -> Void)?
    var onStatus: (([String: Any]?) -> Void)?
    /// k19: the agent list of every refresh (the menu bar's working count while the popover is open).
    var onAgents: ((Any) -> Void)?
    /// k25: the config of every full refresh (`config get --json`), so the spare-quota check follows a Settings flip at once.
    var onConfig: ((Any) -> Void)?
    /// k28: phone control (serve, pairing, devices). nil in snapshot mode: the phone actions are then ignored.
    var phone: Phone? {
        didSet { phone?.onChange = { [weak self] in self?.phoneChanged() } }
    }
    /// k41: the owner's other computers (Settings › Computers). nil in snapshot mode: the computers actions are ignored.
    var computers: Computers?
    /// k28: the page sent "settings" and the popover has not closed since. The page sends no "back" notice, so this
    /// stays true until the popover closes. While true, every refresh carries {phone} (and `devices --json` while on).
    private(set) var settingsOpen = false

    init(theme: String? = nil) {
        self.theme = (theme == "light" || theme == "dark") ? theme : nil
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let ucc = WKUserContentController()
        ucc.add(WeakHandler(self), name: "kadans")
        // The popover already rounds its corners, so drop the page's own radius.
        var boot = "document.documentElement.dataset.chrome = 'none';"
        if let theme { boot += "document.documentElement.dataset.theme = '\(theme)';" }
        ucc.addUserScript(WKUserScript(source: boot, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let cfg = WKWebViewConfiguration()
        cfg.userContentController = ucc
        let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: Self.width, height: 420), configuration: cfg)
        wv.navigationDelegate = self
        webView = wv
        view = wv
    }

    // MARK: popover shown / closed

    /// The page cannot rely on `document.hidden` for a closed NSPopover, so it is told: closed, the blob blink timer
    /// stops and nothing animates. (The popover calls these on show and close; the snapshot window never does, and the
    /// page starts out visible.)
    override func viewDidAppear() {
        super.viewDidAppear()
        if let screen = view.window?.screen { fit(screen: screen) } // the popover's own screen, in case it moved
        if loaded { evaluate("window.kadans && window.kadans.visible && window.kadans.visible(true); true;") }
    }

    override func viewDidDisappear() {
        super.viewDidDisappear()
        settingsOpen = false
        if loaded { evaluate("window.kadans && window.kadans.visible && window.kadans.visible(false); true;") }
    }

    /// One resize per burst of size reports (the page already waits for its own animations before it shrinks).
    /// k42: the cap for a screen: what is visible under the menu bar (and above the Dock) minus a margin, at most
    /// maxHeight, never below 240. No screen known: maxHeight.
    static func cap(for screen: NSScreen?) -> CGFloat {
        guard let vf = screen?.visibleFrame, vf.height > 0 else { return maxHeight }
        return min(maxHeight, max(240, floor(vf.height - screenMargin)))
    }

    /// k42: fit the panel to the status item's screen (before the popover shows, on display changes). The page gets the
    /// cap as its max height, so the gauge and the bottom bar stay on screen and only the agents area scrolls.
    func fit(screen: NSScreen?) {
        let c = Self.cap(for: screen)
        guard c != cap else { return }
        cap = c
        if lastHeight > c { sizeFromPage(c) }
        pushCap()
    }

    private func pushCap() {
        guard loaded else { return }
        evaluate("window.kadans && window.kadans.cap && window.kadans.cap(\(Int(cap))); true;")
    }

    private func sizeFromPage(_ h: CGFloat) {
        let first = pendingHeight == nil
        pendingHeight = h
        guard first else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) {
            guard let h = self.pendingHeight else { return }
            self.pendingHeight = nil
            guard h != self.lastHeight else { return }
            self.lastHeight = h
            self.onSize?(h)
        }
    }

    // MARK: first frame and fade

    /// Paint the page's own panel colour before (and under) the page, so a dark-mode popover never flashes white.
    /// The colours are the `panel` token of docs/design/SPEC.md.
    func softenFirstFrame() {
        _ = view
        webView.underPageBackgroundColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(srgbRed: 0x1f / 255, green: 0x1f / 255, blue: 0x22 / 255, alpha: 1)
                : NSColor.white
        }
    }

    /// Fade in on show (opacity 0 -> 1, 160 ms ease-out). Reduce motion: no fade at all.
    func prepareFade() {
        _ = view
        webView.alphaValue = BlobBlinker.reduceMotion ? 1 : 0
    }

    func fadeIn() {
        guard !BlobBlinker.reduceMotion else { webView.alphaValue = 1; return }
        // One turn of the run loop later, so the popover window has its first frame and the fade starts from the real one.
        DispatchQueue.main.async {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.16
                ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                self.webView.animator().alphaValue = 1
            }
        }
    }

    /// The panel must never stay invisible: back to full opacity whenever the popover is gone.
    func resetFade() {
        webView.layer?.removeAllAnimations()
        webView.alphaValue = 1
    }

    func load() {
        _ = view
        guard let dir = Config.webDir else {
            log("web dir not found (bundle Resources/web, KADANS_WEB or <repo>/app/web)")
            webView.loadHTMLString("<p style='font:13px -apple-system;padding:16px'>Kadans: panel files not found.</p>", baseURL: nil)
            return
        }
        webView.loadFileURL(dir.appendingPathComponent("panel.html"), allowingReadAccessTo: dir)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !loaded else { return }
        loaded = true
        if cap != Self.maxHeight { pushCap() }
        onLoaded?()
    }

    // Keep the panel on its own files: anything else (links) is refused.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        decisionHandler(url?.isFileURL == true || url?.scheme == "about" ? .allow : .cancel)
    }

    // MARK: data

    /// Runs `status --json` and `agents --json` off the main thread and renders the result. Never overlaps itself.
    /// full: also `config get --json` (Settings) and `install --json` (hook card); on open, Settings and after actions,
    /// not on the 5 s tick. All four are read-only and take no page data.
    func refresh(full: Bool = false, completion: (() -> Void)? = nil) {
        guard loaded, !fixtureOnly else { completion?(); return }
        guard !refreshing else {
            if full { wantFull = true } else { wantAgain = true }
            completion?()
            return
        }
        refreshing = true
        // k28: the device list while Settings is open: on every refresh while phone is on, else on full ones only.
        let wantDevices = phone != nil && settingsOpen && (full || phone?.on == true)
        let withPhone = phone != nil && (settingsOpen || full)
        // k41: the computers list on full refreshes while Settings is open (its own queue: the status refresh never waits on it)
        if full && settingsOpen { computers?.reload { [weak self] in self?.pushComputers() } }
        DispatchQueue.global(qos: .utility).async {
            let devices = wantDevices ? Phone.fetchDevices() : nil
            let s = CLI.run(["status", "--json"])
            let a = CLI.run(["agents", "--json"])
            if !s.ok { log("status --json failed (code \(s.code), timeout \(s.timedOut)): \(s.err)") }
            if !a.ok { log("agents --json failed (code \(a.code), timeout \(a.timedOut)): \(a.err)") }
            let status = s.json as? [String: Any]
            if s.ok && status == nil { log("status --json: output is not a JSON object") }
            let agents: Any = a.json ?? []
            var extra: [String: Any] = [:]
            if full {
                let c = CLI.run(["config", "get", "--json"])
                if let cfg = c.json as? [String: Any] { extra["config"] = cfg } else { log("config get --json failed: \(c.err)") }
                extra["install"] = Self.installPreview() ?? NSNull()
            }
            DispatchQueue.main.async {
                self.refreshing = false
                self.lastRefresh = Date()
                self.agentIds = Self.ids(in: agents)
                self.onAgents?(agents)
                if full { self.installChanged = ((extra["install"] as? [String: Any])?["changed"] as? Bool) == true }
                if let cfg = extra["config"] { self.onConfig?(cfg) }
                self.onStatus?(status)
                var payload: [String: Any] = ["status": status ?? NSNull(), "agents": agents]
                payload.merge(extra) { _, new in new }
                if wantDevices { self.phone?.noteDevices(devices) }
                if withPhone, let ph = self.phone { payload.merge(ph.payload()) { _, new in new } }
                self.push(payload)
                completion?()
                if self.wantFull {
                    self.wantFull = false
                    self.wantAgain = false
                    self.refresh(full: true)
                } else if self.wantAgain {
                    self.wantAgain = false
                    self.refresh()
                }
            }
        }
    }

    /// `kadans install --json` (preview only, never writes). nil when it fails (for example a broken settings.json).
    private static func installPreview() -> [String: Any]? {
        let r = CLI.run(["install", "--json"])
        guard r.ok, let j = r.json as? [String: Any] else { log("install --json failed (code \(r.code)): \(r.err)"); return nil }
        return j
    }

    private static func ids(in agents: Any) -> Set<String> {
        let list = (agents as? [[String: Any]]) ?? ((agents as? [String: Any])?["agents"] as? [[String: Any]]) ?? []
        return Set(list.compactMap { $0["id"] as? String })
    }

    /// `window.kadans.render({status, agents})`; a nil status shows the page's "Can't read usage data" card.
    func render(status: [String: Any]?, agents: Any) {
        push(["status": status ?? NSNull(), "agents": agents])
    }

    /// `window.kadans.render(payload)`. The page keeps the keys a payload leaves out (status, agents, config, install).
    func push(_ payload: [String: Any]) {
        guard let json = BridgeResult.literal(payload) else { log("render: payload not serialisable"); return }
        evaluate("window.kadans && window.kadans.render(\(json)); true;")
    }

    /// Snapshot mode: evaluates the fixture files from the web dir, then renders KADANS_FIXTURES[name].
    func renderFixture(_ name: String, completion: @escaping (Bool) -> Void) {
        guard name.range(of: "^[a-z_]+$", options: .regularExpression) != nil, let dir = Config.webDir else {
            completion(false); return
        }
        let fdir = dir.appendingPathComponent("fixtures", isDirectory: true)
        let files = ((try? FileManager.default.contentsOfDirectory(atPath: fdir.path)) ?? [])
            .filter { $0.hasSuffix(".js") }
            .sorted { ($0 == "_base.js" ? 0 : 1, $0) < ($1 == "_base.js" ? 0 : 1, $1) }
        var source = ""
        for f in files {
            guard let text = try? String(contentsOf: fdir.appendingPathComponent(f), encoding: .utf8) else { continue }
            source += text + "\n;\n"
        }
        source += "(function(){ const f = window.KADANS_FIXTURES && window.KADANS_FIXTURES['\(name)'];" +
            " if (!f) return false; window.kadans.render(f);" +
            " if (typeof f.after === 'function') f.after(document); return true; })();"
        webView.evaluateJavaScript(source) { result, error in
            if let error { log("fixture eval failed: \(error.localizedDescription)") }
            completion((result as? Bool) == true)
        }
    }

    func evaluate(_ js: String, completion: ((Any?) -> Void)? = nil) {
        webView.evaluateJavaScript(js) { result, error in
            if let error { log("js error: \(error.localizedDescription)") }
            completion?(result)
        }
    }

    // MARK: phone (k28)

    func pushPhone() {
        guard let phone, loaded, !fixtureOnly else { return }
        push(phone.payload())
    }

    /// The serve child started or died: the page hears it only while Settings is open (the next refresh carries it anyway).
    private func phoneChanged() {
        if settingsOpen { pushPhone() }
    }

    // MARK: computers (k41)

    func pushComputers() {
        guard loaded, !fixtureOnly, let p = computers?.payload() else { return }
        push(p)
    }

    /// The list first, then how the action ended (the page reads the error code from the list payload).
    private func computersDone(_ action: String, id: String, ok: Bool) {
        pushComputers()
        let r: [String: Any] = ["action": action, "id": id, "ok": ok, "why": ""]
        if let js = BridgeResult.script(r) { evaluate(js) }
    }

    // MARK: messages from the page

    /// A string id from the latest `agents --json` list that cannot be read as a flag.
    private func agentId(_ v: Any?) -> String? {
        guard let id = v as? String, !id.isEmpty, !id.hasPrefix("-"), agentIds.contains(id) else { return nil }
        return id
    }

    /// A positive integer task id. JSON true/false also bridge to NSNumber, so booleans and fractions are refused.
    static func taskId(_ v: Any?) -> Int? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        guard d.isFinite, d >= 1, d <= 1_000_000_000, d.rounded() == d else { return nil }
        return Int(d)
    }

    /// k31: a rename title, as lib/serve.mjs titleArg: control and invisible characters (Cc, Cf; newline and tab kept)
    /// stripped, trimmed, at most 80 characters (unicode scalars, like JS code points); "" clears. A "--" start is refused
    /// (the CLI would read it as a flag).
    static func titleArg(_ v: Any?) -> String? {
        guard let raw = v as? String, raw.unicodeScalars.count <= 320 else { return nil }
        var kept = String.UnicodeScalarView()
        for u in raw.unicodeScalars {
            let cat = u.properties.generalCategory
            if (cat == .control || cat == .format) && u != "\n" && u != "\t" { continue }
            kept.append(u)
        }
        let t = String(kept).trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.unicodeScalars.count <= 80, !t.hasPrefix("--") else { return nil }
        return t
    }

    /// Opening a session can wait on Orca (up to 30 s), hence the longer timeout for start and replace.
    /// result: { action, id } names the page's row or setting; when given, the page hears how it ended
    /// (`window.kadans.result`, JSON-encoded) before the refresh.
    private func runThenRefresh(_ args: [String], timeout: TimeInterval = 10, result: (action: String, id: String)? = nil) {
        log(args.joined(separator: " "))
        DispatchQueue.global(qos: .userInitiated).async {
            let r = CLI.run(args, timeout: timeout)
            let out = String(decoding: r.out, as: UTF8.self)
            log("\(args.prefix(2).joined(separator: " ")): code \(r.code)\(r.timedOut ? " (timed out)" : "") \(out) \(r.err)")
            DispatchQueue.main.async {
                if let result {
                    let p = BridgeResult.payload(action: result.action, id: result.id, code: r.code, out: out, err: r.err, timedOut: r.timedOut)
                    if let js = BridgeResult.script(p) { self.evaluate(js) }
                }
                self.refresh(full: true)
            }
        }
    }

    /// A config-set argument: a short string that cannot be read as a flag. The CLI does the real validation.
    static func configArg(_ v: Any?, pattern: String) -> String? {
        guard let s = v as? String, !s.isEmpty, s.count <= 64, !s.hasPrefix("-"),
              s.range(of: pattern, options: .regularExpression) != nil else { return nil }
        return s
    }

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.isFileURL == true,
              let body = message.body as? [String: Any], let action = body["action"] as? String else {
            log("ignored a message that is not {action: …} from the panel page")
            return
        }
        if fixtureOnly && action != "size" {
            log("snapshot: ignored action \"\(action)\" (fixture mode never runs the CLI)")
            return
        }
        switch action {
        case "size":
            // UI only: fit the popover to the page.
            guard let h = (body["height"] as? NSNumber)?.doubleValue, h.isFinite, h > 0 else { return }
            sizeFromPage(min(cap, max(60, ceil(CGFloat(h)))))
        case "close":
            onClose?()
        case "settings":
            settingsOpen = true
            refresh(full: true)
        case "settings-closed":
            // The page left Settings: stop the per-refresh `devices --json` run until it opens again.
            settingsOpen = false
        case "retry", "check-again":
            // Re-runs the read-only commands (plus config get and install --json); no page data reaches the CLI.
            refresh(full: true)
        case "install-preview":
            // Read-only: `install --json`, handed to the page as {install}.
            DispatchQueue.global(qos: .userInitiated).async {
                let j = Self.installPreview()
                DispatchQueue.main.async {
                    self.installChanged = (j?["changed"] as? Bool) == true
                    self.push(["install": j ?? NSNull()])
                }
            }
        case "install-apply":
            // Only after a preview that said something changes; the page has already asked once more (inline confirm).
            guard installChanged else { log("ignored install-apply: the latest install --json said nothing changes"); return }
            installChanged = false
            runThenRefresh(["install", "--apply"], timeout: 20)
        case "config-set":
            // Key and value pass through as argv; `kadans config set` holds the allow-list and validates both.
            // Keys may be camelCase (compact.soonPct); the CLI allow-list still decides.
            guard let key = Self.configArg(body["key"], pattern: "^[A-Za-z0-9_.]+$"),
                  let value = Self.configArg(body["value"], pattern: "^[a-z0-9_,:]+$") else {
                log("ignored config-set: key or value is not a short plain string")
                return
            }
            runThenRefresh(["config", "set", key, value], result: ("config-set", key))
        // The only actions that run a CLI command with page data. Agent ids must be in the latest agents list and
        // task ids must be positive integers (JSON booleans rejected); argv only, never a shell; refresh afterwards.
        case "stop":
            guard let id = agentId(body["id"]) else { log("ignored stop: id is not in the current agents list"); return }
            runThenRefresh(["agent", "stop", id], result: ("stop", id))
        case "compact":
            // Types /compact into that chat's Orca terminal; the CLI refuses anything but an idle chat in a known terminal.
            guard let id = agentId(body["id"]) else { log("ignored compact: id is not in the current agents list"); return }
            runThenRefresh(["agent", "compact", id], result: ("compact", id))
        case "approve":
            guard let task = Self.taskId(body["id"]) else { log("ignored approve: id is not a task number"); return }
            runThenRefresh(["approve", String(task)])
        case "start":
            guard let task = Self.taskId(body["id"]) else { log("ignored start: id is not a task number"); return }
            runThenRefresh(["task", "start", String(task)], timeout: 45, result: ("start", String(task)))
        case "replace":
            guard let id = agentId(body["id"]), let task = Self.taskId(body["task"]) else {
                log("ignored replace: agent id not in the current list or task is not a number")
                return
            }
            runThenRefresh(["agent", "replace", id, String(task)], timeout: 45, result: ("replace", id))
        case "pace":
            // mode slow|pause|none; optional until reset|30m (the two pause items in the menu). Nothing else passes.
            guard let id = agentId(body["id"]), let mode = body["mode"] as? String, ["slow", "pause", "none"].contains(mode) else {
                log("ignored pace: agent id not in the current list or mode is not slow, pause or none")
                return
            }
            var args = ["agent", "pace", id, mode]
            if let until = body["until"] {
                guard mode == "pause", let u = until as? String, ["reset", "30m"].contains(u) else {
                    log("ignored pace: until must be reset or 30m, with pause only")
                    return
                }
                args += ["--until", u]
            }
            runThenRefresh(args)
        case "rename":
            // k31: the owner's title for a row ("" clears it); `kadans agent title` stores it.
            guard let id = agentId(body["id"]), let title = Self.titleArg(body["title"]) else {
                log("ignored rename: agent id not in the current list or title is not text of at most 80 characters")
                return
            }
            runThenRefresh(["agent", "title", id, title], result: ("rename", id))
        case "reorder":
            // k31: the new row order after a drag: 1 to 50 different ids, all in the latest agents list.
            guard let list = body["ids"] as? [Any], (1...50).contains(list.count) else {
                log("ignored reorder: ids is not a list of 1 to 50 agent ids")
                return
            }
            let ids = list.compactMap { agentId($0) }
            guard ids.count == list.count, Set(ids).count == ids.count else {
                log("ignored reorder: ids must be different agent ids from the current list")
                return
            }
            runThenRefresh(["agent", "order"] + ids, result: ("reorder", ""))
        case "autopace":
            // A real JSON boolean only (NSNumber 0/1 would also bridge to Bool).
            guard let n = body["on"] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else {
                log("ignored autopace: on is not a boolean")
                return
            }
            runThenRefresh(["autopace", n.boolValue ? "on" : "off"])
        // k28: phone control. Nothing from the page reaches the CLI except a device id from the latest list.
        case "phone-on", "phone-off":
            guard let phone else { return }
            settingsOpen = true
            phone.turn(on: action == "phone-on") { [weak self] in
                self?.pushPhone()
                self?.refresh(full: true)
            }
        case "phone-pair":
            guard let phone else { return }
            settingsOpen = true
            phone.makePair { [weak self] in self?.pushPhone() }
        case "phone-revoke":
            guard let phone else { return }
            settingsOpen = true
            guard let id = phone.knownDevice(body["id"]) else { log("ignored phone-revoke: id is not in the current devices list"); return }
            phone.revoke(id) { [weak self] in self?.pushPhone() }
        // k41: computers. The page's name and code are checked again here; the code goes to the CLI's stdin only and is
        // never logged (this case logs nothing from the body). Remove takes only an id from the latest list.
        case "computers-add":
            guard let computers else { return }
            settingsOpen = true
            computers.add(name: body["name"], code: body["code"]) { [weak self] ok in
                self?.computersDone("computers-add", id: "", ok: ok)
                if ok { self?.refresh() } // the new computer's agents (the list itself came with the add)
            }
        case "computers-remove":
            guard let computers else { return }
            settingsOpen = true
            guard let id = computers.known(body["id"]) else {
                log("ignored computers-remove: id is not in the current computers list")
                computersDone("computers-remove", id: "", ok: false)
                return
            }
            computers.remove(id) { [weak self] ok in
                self?.computersDone("computers-remove", id: id, ok: ok)
                if ok { self?.refresh() }
            }
        default:
            log("ignored action \"\(action)\" (not on the allow-list)")
        }
    }
}
