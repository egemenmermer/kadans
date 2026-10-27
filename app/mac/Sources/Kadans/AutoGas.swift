import AppKit

/// `kadans gas tick --json` -> {"started": <task id or null>, "why": "<code>"} (the contract with the CLI). Anything else
/// (an older CLI without `gas tick`, junk) is unknown: nil, logged once, never shown to the owner.
struct GasTick: Equatable {
    let started: Int?
    let why: String

    init?(json: Any?) {
        guard let o = json as? [String: Any], let why = o["why"] as? String,
              why.range(of: "^[a-z][a-z0-9_-]{0,39}$", options: .regularExpression) != nil else { return nil }
        if let v = o["started"], !(v is NSNull) {
            guard let id = PanelController.taskId(v) else { return nil }
            started = id
        } else {
            started = nil
        }
        self.why = why
    }
}

/// What the spare-quota check needs from `kadans config get --json`: autoGas on AND the own account's gas on.
/// `known` is false when the config has no autoGas at all (an older CLI): then nothing runs.
struct AutoGasConfig: Equatable {
    let known: Bool
    let enabled: Bool
    let notify: Bool

    init(json: Any?) {
        let c = json as? [String: Any] ?? [:]
        func isTrue(_ v: Any?) -> Bool {
            guard let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return false }
            return n.boolValue
        }
        let own = c["own"] as? String
        let accounts = c["accounts"] as? [String: Any]
        let ownGas = own.map { isTrue((accounts?[$0] as? [String: Any])?["gas"]) } ?? false
        known = c["autoGas"] != nil
        enabled = known && isTrue(c["autoGas"]) && ownGas
        notify = isTrue(c["notify"])
    }
}

/// A task as the status queue shows it (`status --json` queue.next), for the notification text.
struct QueuedTask: Equatable {
    let text: String
    let project: String?
}

/// macOS notifications the way lib/notify.mjs sends them: osascript with an `on run argv` handler, so the texts travel as
/// argv items, never inside the script source and never through a shell.
enum Notifier {
    static func args(title: String, body: String) -> [String] {
        ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run",
         "--", title, body]
    }

    static func post(title: String, body: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = args(title: title, body: body)
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { log("notification failed: \(error.localizedDescription)") }
    }

    /// "Started “{task}” on spare quota" / "{project}". Texts are cut to a sane length; quotes in them stay plain text.
    static func started(id: Int, task: QueuedTask?) -> (title: String, body: String) {
        let name = task.map { String($0.text.prefix(80)) }.flatMap { $0.isEmpty ? nil : $0 }
        let title = name.map { "Started “\($0)” on spare quota" } ?? "Started task #\(id) on spare quota"
        let body = task?.project.flatMap { $0.isEmpty ? nil : String($0.prefix(60)) } ?? "Kadans"
        return (title, body)
    }
}

/// k25: the app runs Kadans' spare-quota check on its own, also at night with nobody at the Mac.
/// - Every 5 min, and 1 min after each window reset of the own account (from `status --json`), and 1 min after the Mac
///   wakes: `config get --json`, then `gas tick --json` only when autoGas and the own account's gas are on. The CLI
///   decides everything else (state, caps, RAM, the task); this side only asks.
/// - Off the main thread on its own queue (a start can wait on Orca for 30 s), never two at once (Gate).
/// - Not tied to the popover or the screen lock: its timers are never paused by stopPolls or the blob's lock / sleep
///   pause. While autoGas is on, an activity keeps App Nap from stretching the timers (idle system sleep is still
///   allowed: a sleeping Mac checks nothing).
final class AutoGas {
    static let every: TimeInterval = 300
    static let afterReset: TimeInterval = 60
    static let afterWake: TimeInterval = 60
    static let tickTimeout: TimeInterval = 60

    /// Dev and measuring only: KADANS_AUTOGAS_DRY_RUN=1 adds --dry-run to every tick; KADANS_AUTOGAS_EVERY=<s> (10 s or
    /// more) replaces the 5 min.
    private let dryRun: Bool
    private let interval: TimeInterval
    private let queue = DispatchQueue(label: "dev.kadans.gas", qos: .utility)
    private lazy var gate = Gate(minGap: 30) { [weak self] done in self?.run(done) ?? done() }
    private var timer: Timer?
    private var resetTimer: Timer?
    private var resetAt: Double?
    private var wakeObserver: NSObjectProtocol?
    private var activity: NSObjectProtocol?
    private var tasks: [Int: QueuedTask] = [:]
    private var lastWhy: String?
    private var failLogged = false
    private(set) var config: AutoGasConfig?

    /// A task was started (task id): the host refreshes what it shows.
    var onStarted: ((Int) -> Void)?

    init(env: [String: String] = ProcessInfo.processInfo.environment) {
        dryRun = env["KADANS_AUTOGAS_DRY_RUN"] == "1"
        interval = env["KADANS_AUTOGAS_EVERY"].flatMap { Double($0) }.map { max(10, $0) } ?? Self.every
    }

    func start() {
        let t = Timer(timeInterval: interval, repeats: true) { [weak self] _ in self?.gate.request() }
        t.tolerance = min(30, interval / 10)
        RunLoop.main.add(t, forMode: .common)
        timer = t
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil,
                                                                         queue: .main) { [weak self] _ in
            self?.later(Self.afterWake)
        }
        if dryRun { log("spare quota: dry run (KADANS_AUTOGAS_DRY_RUN=1)") }
        gate.request() // reads the config at launch; ticks only when it is on
    }

    /// The config from the panel's full refresh (`config get --json`), so a Settings flip takes effect at once.
    func noteConfig(_ json: Any?) {
        guard let json else { return }
        apply(AutoGasConfig(json: json))
    }

    /// Every status read (popover open or closed): queued task names for the notification, and the own account's next
    /// window reset, which schedules one check a minute after it.
    func noteStatus(_ status: [String: Any]?) {
        guard let status else { return }
        let next = (status["queue"] as? [String: Any])?["next"] as? [[String: Any]] ?? []
        for t in next {
            guard let id = PanelController.taskId(t["id"]), let text = t["text"] as? String else { continue }
            tasks[id] = QueuedTask(text: text, project: t["project"] as? String)
        }
        if tasks.count > 200 { tasks = tasks.filter { k, _ in next.contains { PanelController.taskId($0["id"]) == k } } }
        let accounts = status["accounts"] as? [[String: Any]] ?? []
        let own = accounts.first { ($0["own"] as? Bool) == true }
        let now = (status["now"] as? NSNumber)?.doubleValue ?? Date().timeIntervalSince1970 * 1000
        let resets = (own?["limits"] as? [[String: Any]] ?? []).compactMap { ($0["resetsAt"] as? NSNumber)?.doubleValue }.filter { $0 > now }
        scheduleReset(resets.min())
    }

    private func scheduleReset(_ at: Double?) {
        guard at != resetAt else { return }
        resetAt = at
        resetTimer?.invalidate()
        resetTimer = nil
        guard let at else { return }
        let fire = Date(timeIntervalSince1970: at / 1000 + Self.afterReset)
        let t = Timer(fire: fire, interval: 0, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.resetTimer = nil
            self.resetAt = nil
            self.gate.request()
        }
        t.tolerance = 5
        RunLoop.main.add(t, forMode: .common)
        resetTimer = t
    }

    private func later(_ s: TimeInterval) {
        DispatchQueue.main.asyncAfter(deadline: .now() + s) { [weak self] in self?.gate.request() }
    }

    private func apply(_ c: AutoGasConfig) {
        if c != config {
            log("spare quota on its own: \(c.known ? (c.enabled ? "on" : "off") : "unknown (config has no autoGas)")")
        }
        config = c
        if c.enabled, activity == nil {
            activity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep,
                                                             reason: "Kadans checks for spare quota every 5 min")
        } else if !c.enabled, let a = activity {
            ProcessInfo.processInfo.endActivity(a)
            activity = nil
        }
    }

    /// One check: config, then the tick only when it is on. Main thread in and out; the CLI runs on `queue`.
    private func run(_ done: @escaping () -> Void) {
        let dry = dryRun
        queue.async { [weak self] in
            let c = AutoGasConfig(json: CLI.run(["config", "get", "--json"]).json)
            var r: CLIResult?
            if c.enabled { r = CLI.run(["gas", "tick", "--json"] + (dry ? ["--dry-run"] : []), timeout: Self.tickTimeout) }
            DispatchQueue.main.async {
                guard let self else { return done() }
                self.apply(c)
                if let r { self.handle(r) }
                done()
            }
        }
    }

    private func handle(_ r: CLIResult) {
        guard let tick = GasTick(json: r.json) else {
            if !failLogged {
                failLogged = true
                log("gas tick --json: no answer yet (code \(r.code), timeout \(r.timedOut)); spare quota on its own waits for it")
            }
            return
        }
        failLogged = false
        if tick.why != lastWhy {
            lastWhy = tick.why
            log("gas tick: \(tick.why)\(tick.started.map { ", started task #\($0)" } ?? "")")
        }
        guard let id = tick.started, !dryRun else { return }
        if config?.notify == true {
            let n = Notifier.started(id: id, task: tasks[id])
            Notifier.post(title: n.title, body: n.body)
        }
        onStarted?(id)
    }
}
