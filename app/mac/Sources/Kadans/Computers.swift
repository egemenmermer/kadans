import Foundation

// k41: Settings › Computers on the Mac side: the owner's other computers (paired Orca environments).
// - ComputersParse: what `kadans computers --json` prints, checked; the page gets {id, name, status, agents} only.
// - Computers: the bridge actions computers-add / computers-remove and the list, one CLI call at a time, off the main
//   thread. The pairing code goes to `kadans computers add` on STDIN (never argv, never logged) and is dropped after.
// The page never sees CLI text: errors are short codes the page maps to its own lines (panel.js COMP_ERR).

// ComputersParse begin (pure Foundation)
enum ComputersParse {
    static let statuses: Set<String> = ["online", "stale", "offline", "unknown"]

    /// An environment id the CLI may get back as argv: short, plain, never a flag.
    static func id(_ v: Any?) -> String? {
        guard let s = v as? String, s.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$", options: .regularExpression) != nil else { return nil }
        return s
    }
    /// The name the page typed: 1 to 32 letters, digits, spaces or dashes, starting with a letter or digit.
    static func name(_ v: Any?) -> String? {
        guard let raw = v as? String else { return nil }
        let s = raw.trimmingCharacters(in: .whitespaces)
        guard s.count <= 32, s.range(of: "^[\\p{L}\\p{N}][\\p{L}\\p{N} -]*$", options: .regularExpression) != nil else { return nil }
        return s
    }
    /// The pasted pairing code: orca://pair? and URL-safe characters only, at most 2048. Never logged.
    static func code(_ v: Any?) -> String? {
        guard let raw = v as? String else { return nil }
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard s.utf8.count <= 2048, s.range(of: "^orca://pair\\?[A-Za-z0-9_.~%=&+/:-]+$", options: .regularExpression) != nil else { return nil }
        return s
    }
    /// `kadans computers --json` -> [{id, name, status, agents}]; bad rows dropped; nil when it is not a list.
    static func list(_ json: Any?) -> [[String: Any]]? {
        guard let rows = json as? [Any] else { return nil }
        return rows.prefix(50).compactMap { row in
            guard let o = row as? [String: Any], let id = id(o["id"]), let st = o["status"] as? String, statuses.contains(st) else { return nil }
            let name = (o["name"] as? String).map { String($0.prefix(40)) } ?? ""
            var agents: Any = NSNull()
            if let n = o["agents"] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue >= 0, n.doubleValue <= 999,
               n.doubleValue == n.doubleValue.rounded() { agents = NSNumber(value: n.intValue) }
            return ["id": id, "name": name, "status": st, "agents": agents]
        }
    }
    /// A failed `computers add` / `remove` -> the page's error code, from the CLI's fixed error strings only.
    static func errorCode(_ err: String, remove: Bool) -> String {
        if err.contains("already paired") { return "taken" }
        if err.contains("orca not found") { return "noorca" }
        if !remove && err.contains("not a pairing code") { return "code" }
        if !remove && err.contains("the name takes") { return "name" }
        return remove ? "remove" : "add"
    }
}
// ComputersParse end

/// Computers for the panel. Main thread; the CLI runs on its own queue, one call at a time.
final class Computers {
    static let addTimeout: TimeInterval = 45 // the CLI waits up to 30 s for orca to pair
    private let queue = DispatchQueue(label: "dev.kadans.computers", qos: .userInitiated)
    private var busy = false
    /// nil until the first list (the page hides the section until then) or when it could not be read.
    private(set) var list: [[String: Any]]?
    private var loaded = false
    private var ids = Set<String>()
    private var error: String?

    func payload() -> [String: Any]? {
        guard loaded else { return nil }
        return ["computers": ["list": list ?? NSNull(), "error": error ?? NSNull()] as [String: Any]]
    }

    /// `kadans computers --json` (Settings opened, full refreshes). Skipped while an action runs (it reloads after).
    func reload(done: @escaping () -> Void) {
        guard !busy else { return done() }
        busy = true
        queue.async {
            let l = Self.fetch()
            DispatchQueue.main.async {
                self.busy = false
                self.note(l)
                done()
            }
        }
    }

    /// computers-add: the page's name and code, checked here too; the code goes on stdin. done(ok).
    func add(name rawName: Any?, code rawCode: Any?, done: @escaping (Bool) -> Void) {
        guard let name = ComputersParse.name(rawName) else { error = "name"; return done(false) }
        guard let code = ComputersParse.code(rawCode) else { error = "code"; return done(false) }
        guard !busy else { error = "busy"; return done(false) }
        busy = true
        log("computers: add \"\(name)\" (code on stdin)")
        queue.async {
            let r = CLI.run(["computers", "add", "--name", name], stdin: Data((code + "\n").utf8), timeout: Self.addTimeout)
            if !r.ok { log("computers: add failed (code \(r.code), timeout \(r.timedOut))") }
            let why = r.ok ? nil : ComputersParse.errorCode(r.err, remove: false)
            let l = Self.fetch()
            DispatchQueue.main.async {
                self.busy = false
                self.note(l)
                self.error = why
                done(r.ok)
            }
        }
    }

    /// An id from the latest list (the page cannot name anything else).
    func known(_ v: Any?) -> String? {
        guard let id = ComputersParse.id(v), ids.contains(id) else { return nil }
        return id
    }

    /// computers-remove: `kadans computers remove <id>`, then the list again. done(ok).
    func remove(_ id: String, done: @escaping (Bool) -> Void) {
        guard !busy else { error = "busy"; return done(false) }
        busy = true
        queue.async {
            let r = CLI.run(["computers", "remove", id], timeout: 20)
            if !r.ok { log("computers: remove failed (code \(r.code), timeout \(r.timedOut)): \(r.err.prefix(200))") }
            let why = r.ok ? nil : ComputersParse.errorCode(r.err, remove: true)
            let l = Self.fetch()
            DispatchQueue.main.async {
                self.busy = false
                self.note(l)
                self.error = why
                done(r.ok)
            }
        }
    }

    private static func fetch() -> [[String: Any]]? {
        let r = CLI.run(["computers", "--json"], timeout: 15)
        let l = ComputersParse.list(r.json)
        if l == nil { log("computers --json failed (code \(r.code), timeout \(r.timedOut)): \(r.err.prefix(200))") }
        return l
    }

    private func note(_ l: [[String: Any]]?) {
        loaded = true
        list = l
        error = l == nil ? "list" : nil
        ids = Set((l ?? []).compactMap { $0["id"] as? String })
    }
}
