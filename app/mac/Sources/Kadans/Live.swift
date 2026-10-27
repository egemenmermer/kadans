import Foundation
import CoreServices

/// Runs one job of a kind at a time. A request while it runs is remembered and runs once right after it; two starts are
/// at least `minGap` apart (a request inside the gap waits for its end). Main thread only.
final class Gate {
    var minGap: TimeInterval
    private let job: (@escaping () -> Void) -> Void
    private var running = false
    private var again = false
    private var pending: DispatchWorkItem?
    private(set) var lastStart: Date = .distantPast

    init(minGap: TimeInterval, job: @escaping (@escaping () -> Void) -> Void) {
        self.minGap = minGap
        self.job = job
    }

    var isRunning: Bool { running }

    func request() {
        if running { again = true; return }
        if pending != nil { return }
        let wait = lastStart.addingTimeInterval(minGap).timeIntervalSinceNow
        if wait > 0 {
            let w = DispatchWorkItem { [weak self] in
                self?.pending = nil
                self?.request()
            }
            pending = w
            DispatchQueue.main.asyncAfter(deadline: .now() + wait, execute: w)
            return
        }
        running = true
        lastStart = Date()
        job { [weak self] in
            guard let self else { return }
            self.running = false
            if self.again {
                self.again = false
                self.request()
            }
        }
    }

    /// Drops a waiting request (not the running job).
    func cancelPending() {
        pending?.cancel()
        pending = nil
        again = false
    }
}

/// Tells when Kadans' inputs change, without reading them: FSEvents over the Kadans home (hook events and usage samples)
/// and Claude Code's sessions folder. Only file paths are looked at, never contents. Events arrive coalesced by FSEvents'
/// latency (250 ms). The CLI's own writes (agents-cache.json, locks, config, titles) are filtered out by path, so a
/// refresh can never trigger the next one.
final class ChangeWatcher {
    enum Kind { case agents, usage }

    let home: String
    let sessions: String
    private let onChange: (Set<Kind>) -> Void
    private var stream: FSEventStreamRef?

    /// KADANS_HOME (else ~/.kadans) and CLAUDE_CONFIG_DIR/sessions (else ~/.claude/sessions), symlinks resolved, as
    /// FSEvents reports real paths.
    init(onChange: @escaping (Set<Kind>) -> Void) {
        let env = ProcessInfo.processInfo.environment
        func real(_ p: String) -> String { URL(fileURLWithPath: Config.expand(p)).resolvingSymlinksInPath().path }
        let home = env["KADANS_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? (NSHomeDirectory() + "/.kadans")
        let claude = env["CLAUDE_CONFIG_DIR"].flatMap { $0.isEmpty ? nil : $0 } ?? (NSHomeDirectory() + "/.claude")
        self.home = real(home)
        self.sessions = real(claude + "/sessions")
        self.onChange = onChange
    }

    /// Which kind of change a path is, or nil for paths Kadans does not care about (or writes itself).
    static func kind(of path: String, home: String, sessions: String) -> Kind? {
        if path == sessions || path.hasPrefix(sessions + "/") { return .agents }
        guard path.hasPrefix(home + "/") else { return nil }
        let rel = path.dropFirst(home.count + 1)
        if rel.hasPrefix("events/") { return .agents }
        if rel.hasPrefix("accounts/") && (rel as NSString).lastPathComponent.hasPrefix("samples") { return .usage }
        return nil
    }

    func start() {
        guard stream == nil else { return }
        let fm = FileManager.default
        let roots = [home, sessions].filter { fm.fileExists(atPath: $0) }
        guard !roots.isEmpty else { log("watch: nothing to watch yet (no Kadans home, no sessions folder)"); return }
        var ctx = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(), retain: nil, release: nil,
                                       copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, count, paths, _, _ in
            guard let info else { return }
            let me = Unmanaged<ChangeWatcher>.fromOpaque(info).takeUnretainedValue()
            let list = unsafeBitCast(paths, to: NSArray.self)
            var kinds = Set<ChangeWatcher.Kind>()
            for i in 0..<min(count, list.count) {
                if let p = list[i] as? String, let k = ChangeWatcher.kind(of: p, home: me.home, sessions: me.sessions) { kinds.insert(k) }
            }
            if !kinds.isEmpty { me.onChange(kinds) }
        }
        let flags = FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagUseCFTypes)
        guard let s = FSEventStreamCreate(nil, callback, &ctx, roots as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
                                          0.25, flags) else { log("watch: FSEventStreamCreate failed"); return }
        FSEventStreamSetDispatchQueue(s, .main)
        FSEventStreamStart(s)
        stream = s
    }

    func stop() {
        guard let s = stream else { return }
        FSEventStreamStop(s)
        FSEventStreamInvalidate(s)
        FSEventStreamRelease(s)
        stream = nil
    }

    deinit { stop() }
}

/// `kadans agents --brief --json` -> {"working": Int, "needsYou": Int, "t": epoch ms}. Anything else (an older CLI
/// without --brief prints a table) is unknown: nil, never an error for the owner.
struct Brief: Equatable {
    let working: Int
    let needsYou: Int

    init?(json: Any?) {
        guard let o = json as? [String: Any], let w = o["working"] as? NSNumber, CFGetTypeID(w) != CFBooleanGetTypeID() else { return nil }
        working = max(0, w.intValue)
        needsYou = max(0, (o["needsYou"] as? NSNumber)?.intValue ?? 0)
    }

    /// The panel's full agent list (open popover): rows whose status is "working".
    static func working(inAgents agents: Any) -> Int {
        let list = (agents as? [[String: Any]]) ?? ((agents as? [String: Any])?["agents"] as? [[String: Any]]) ?? []
        return list.filter { ($0["status"] as? String) == "working" }.count
    }
}

/// The panel's `--ease-out` curve, cubic-bezier(.2, .9, .25, 1), so the popover resize moves like the page's slide.
enum Ease {
    static func panelOut(_ t: Double) -> Double { bezier(t, 0.2, 0.9, 0.25, 1) }

    /// y for x = t on a CSS cubic-bezier(x1, y1, x2, y2): Newton steps on x(s), bisection as the fallback.
    static func bezier(_ t: Double, _ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) -> Double {
        if t <= 0 { return 0 }
        if t >= 1 { return 1 }
        func f(_ s: Double, _ a: Double, _ b: Double) -> Double { 3 * a * s * (1 - s) * (1 - s) + 3 * b * s * s * (1 - s) + s * s * s }
        func df(_ s: Double, _ a: Double, _ b: Double) -> Double { 3 * a * (1 - s) * (1 - s) + 6 * (b - a) * s * (1 - s) + 3 * (1 - b) * s * s }
        var s = t
        for _ in 0..<8 {
            let d = df(s, x1, x2)
            if abs(d) < 1e-6 { break }
            s -= (f(s, x1, x2) - t) / d
        }
        if s < 0 || s > 1 || abs(f(s, x1, x2) - t) > 1e-4 {
            var lo = 0.0, hi = 1.0
            s = t
            for _ in 0..<40 {
                if f(s, x1, x2) < t { lo = s } else { hi = s }
                s = (lo + hi) / 2
            }
        }
        return f(s, y1, y2)
    }
}
