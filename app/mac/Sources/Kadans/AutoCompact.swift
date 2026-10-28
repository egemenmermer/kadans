import AppKit

/// `kadans compact tick --json` -> {"compacted": <agent id or null>, "why": "<code>"} (the contract with the CLI). Anything
/// else (an older CLI without `compact tick`, junk) is unknown: nil, logged once, never shown to the owner.
struct CompactTick: Equatable {
    let compacted: String?
    let why: String

    init?(json: Any?) {
        guard let o = json as? [String: Any], let why = o["why"] as? String,
              why.range(of: "^[a-z][a-z0-9_-]{0,39}$", options: .regularExpression) != nil else { return nil }
        if let v = o["compacted"], !(v is NSNull) {
            guard let id = v as? String, !id.isEmpty, id.count <= 200 else { return nil }
            compacted = id
        } else {
            compacted = nil
        }
        self.why = why
    }
}

/// What the auto-compact check needs from `kadans config get --json`: autoCompact on. `known` is false when the config has
/// no autoCompact at all (an older CLI): then nothing runs.
struct AutoCompactConfig: Equatable {
    let known: Bool
    let enabled: Bool

    init(json: Any?) {
        let c = json as? [String: Any] ?? [:]
        let v = c["autoCompact"]
        known = v != nil
        if let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() { enabled = n.boolValue } else { enabled = false }
    }
}

/// k55: opt-in auto-compact, the AutoGas wake pattern. Every 5 min, and 1 min after the Mac wakes: `config get --json`,
/// then `compact tick --json` only when autoCompact is on. The CLI decides everything (which chat, the cache and idle
/// rules, the hourly cap, the live screen check, the record, the notification); this side only asks. Off the main thread
/// on its own queue, never two at once (Gate). No LaunchAgent, no launchctl: it runs only while the app runs.
final class AutoCompact {
    static let every: TimeInterval = 300
    static let afterWake: TimeInterval = 60
    static let tickTimeout: TimeInterval = 60

    /// Dev and measuring only: KADANS_AUTOCOMPACT_DRY_RUN=1 adds --dry-run to every tick; KADANS_AUTOCOMPACT_EVERY=<s>
    /// (10 s or more) replaces the 5 min.
    private let dryRun: Bool
    private let interval: TimeInterval
    private let queue = DispatchQueue(label: "dev.kadans.compact", qos: .utility)
    private lazy var gate = Gate(minGap: 30) { [weak self] done in self?.run(done) ?? done() }
    private var timer: Timer?
    private var wakeObserver: NSObjectProtocol?
    private var activity: NSObjectProtocol?
    private var lastWhy: String?
    private var failLogged = false
    private(set) var config: AutoCompactConfig?

    /// A chat was compacted (agent id): the host refreshes what it shows.
    var onCompacted: ((String) -> Void)?

    init(env: [String: String] = ProcessInfo.processInfo.environment) {
        dryRun = env["KADANS_AUTOCOMPACT_DRY_RUN"] == "1"
        interval = env["KADANS_AUTOCOMPACT_EVERY"].flatMap { Double($0) }.map { max(10, $0) } ?? Self.every
    }

    func start() {
        let t = Timer(timeInterval: interval, repeats: true) { [weak self] _ in self?.gate.request() }
        t.tolerance = min(30, interval / 10)
        RunLoop.main.add(t, forMode: .common)
        timer = t
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil,
                                                                         queue: .main) { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.afterWake) { self?.gate.request() }
        }
        if dryRun { log("auto-compact: dry run (KADANS_AUTOCOMPACT_DRY_RUN=1)") }
        gate.request() // reads the config at launch; ticks only when it is on
    }

    /// The config from the panel's full refresh (`config get --json`), so a Settings flip is logged at once.
    func noteConfig(_ json: Any?) {
        guard let json else { return }
        apply(AutoCompactConfig(json: json))
    }

    private func apply(_ c: AutoCompactConfig) {
        if c != config {
            log("auto-compact: \(c.known ? (c.enabled ? "on" : "off") : "unknown (config has no autoCompact)")")
        }
        config = c
        // While on, keep App Nap from stretching the 5-min timer past a chat's warm cache (idle system sleep still allowed).
        if c.enabled, activity == nil {
            activity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep,
                                                             reason: "Kadans checks for idle chats to compact every 5 min")
        } else if !c.enabled, let a = activity {
            ProcessInfo.processInfo.endActivity(a)
            activity = nil
        }
    }

    /// One check: config, then the tick only when it is on. Main thread in and out; the CLI runs on `queue`.
    private func run(_ done: @escaping () -> Void) {
        let dry = dryRun
        queue.async { [weak self] in
            let c = AutoCompactConfig(json: CLI.run(["config", "get", "--json"]).json)
            var r: CLIResult?
            if c.enabled { r = CLI.run(["compact", "tick", "--json"] + (dry ? ["--dry-run"] : []), timeout: Self.tickTimeout) }
            DispatchQueue.main.async {
                guard let self else { return done() }
                self.apply(c)
                if let r { self.handle(r) }
                done()
            }
        }
    }

    private func handle(_ r: CLIResult) {
        guard let tick = CompactTick(json: r.json) else {
            if !failLogged {
                failLogged = true
                log("compact tick --json: no answer yet (code \(r.code), timeout \(r.timedOut)); auto-compact waits for it")
            }
            return
        }
        failLogged = false
        if tick.why != lastWhy {
            lastWhy = tick.why
            log("compact tick: \(tick.why)") // the code only, never chat text
        }
        guard let id = tick.compacted, !dryRun else { return }
        onCompacted?(id)
    }
}
