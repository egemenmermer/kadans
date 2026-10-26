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

/// Hosts app/web/panel.html and is the only bridge between the page and the CLI.
final class PanelController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {
    static let width: CGFloat = 320
    static let maxHeight: CGFloat = 560

    private(set) var webView: WKWebView!
    private let theme: String?
    private var loaded = false
    private var refreshing = false
    /// A full refresh was asked for while another refresh ran; it runs right after.
    private var wantFull = false
    /// The latest `install --json` said settings.json needs changes; install-apply is refused otherwise.
    private var installChanged = false
    /// Snapshot of a fixture: the page may not reach the CLI at all (no refresh, no actions).
    var fixtureOnly = false
    /// Ids from the latest `agents --json`; a stop request must name one of these.
    private var agentIds = Set<String>()

    var onLoaded: (() -> Void)?
    var onSize: ((CGFloat) -> Void)?
    var onClose: (() -> Void)?
    var onStatus: (([String: Any]?) -> Void)?

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
            if full { wantFull = true }
            completion?()
            return
        }
        refreshing = true
        DispatchQueue.global(qos: .utility).async {
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
                self.agentIds = Self.ids(in: agents)
                if full { self.installChanged = ((extra["install"] as? [String: Any])?["changed"] as? Bool) == true }
                self.onStatus?(status)
                var payload: [String: Any] = ["status": status ?? NSNull(), "agents": agents]
                payload.merge(extra) { _, new in new }
                self.push(payload)
                completion?()
                if self.wantFull {
                    self.wantFull = false
                    self.refresh(full: true)
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
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { log("render: payload not serialisable"); return }
        let json = String(decoding: data, as: UTF8.self)
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
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

    /// Opening a session can wait on Orca (up to 30 s), hence the longer timeout for start and replace.
    private func runThenRefresh(_ args: [String], timeout: TimeInterval = 10) {
        log(args.joined(separator: " "))
        DispatchQueue.global(qos: .userInitiated).async {
            let r = CLI.run(args, timeout: timeout)
            log("\(args.prefix(2).joined(separator: " ")): code \(r.code)\(r.timedOut ? " (timed out)" : "") " +
                "\(String(decoding: r.out, as: UTF8.self)) \(r.err)")
            DispatchQueue.main.async { self.refresh(full: true) }
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
            onSize?(min(Self.maxHeight, max(60, ceil(CGFloat(h)))))
        case "close":
            onClose?()
        case "retry", "check-again", "settings":
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
            guard let key = Self.configArg(body["key"], pattern: "^[a-z0-9_.]+$"),
                  let value = Self.configArg(body["value"], pattern: "^[a-z0-9_,:]+$") else {
                log("ignored config-set: key or value is not a short plain string")
                return
            }
            runThenRefresh(["config", "set", key, value])
        // The only actions that run a CLI command with page data. Agent ids must be in the latest agents list and
        // task ids must be positive integers (JSON booleans rejected); argv only, never a shell; refresh afterwards.
        case "stop":
            guard let id = agentId(body["id"]) else { log("ignored stop: id is not in the current agents list"); return }
            runThenRefresh(["agent", "stop", id])
        case "approve":
            guard let task = Self.taskId(body["id"]) else { log("ignored approve: id is not a task number"); return }
            runThenRefresh(["approve", String(task)])
        case "start":
            guard let task = Self.taskId(body["id"]) else { log("ignored start: id is not a task number"); return }
            runThenRefresh(["task", "start", String(task)], timeout: 45)
        case "replace":
            guard let id = agentId(body["id"]), let task = Self.taskId(body["task"]) else {
                log("ignored replace: agent id not in the current list or task is not a number")
                return
            }
            runThenRefresh(["agent", "replace", id, String(task)], timeout: 45)
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
        case "autopace":
            // A real JSON boolean only (NSNumber 0/1 would also bridge to Bool).
            guard let n = body["on"] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else {
                log("ignored autopace: on is not a boolean")
                return
            }
            runThenRefresh(["autopace", n.boolValue ? "on" : "off"])
        default:
            log("ignored action \"\(action)\" (not on the allow-list)")
        }
    }
}
