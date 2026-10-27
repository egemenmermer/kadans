import Foundation

/// Where things live: web dir, repo (for bin/kadans.mjs) and node.
enum Config {
    static let env = ProcessInfo.processInfo.environment

    static func expand(_ p: String) -> String { (p as NSString).expandingTildeInPath }

    private static func hasPanel(_ dir: URL) -> Bool {
        FileManager.default.fileExists(atPath: dir.appendingPathComponent("panel.html").path)
    }

    /// The app bundle's Resources/web, else KADANS_WEB, else <repo>/app/web.
    static var webDir: URL? {
        if let res = Bundle.main.resourceURL?.appendingPathComponent("web", isDirectory: true), hasPanel(res) { return res }
        if let w = env["KADANS_WEB"], !w.isEmpty {
            let u = URL(fileURLWithPath: expand(w), isDirectory: true)
            if hasPanel(u) { return u }
        }
        if let r = repoDir {
            let u = r.appendingPathComponent("app/web", isDirectory: true)
            if hasPanel(u) { return u }
        }
        return nil
    }

    /// KADANS_REPO, else the path baked into Info.plist (KadansRepo) by scripts/build-app.sh.
    static var repoDir: URL? {
        if let r = env["KADANS_REPO"], !r.isEmpty { return URL(fileURLWithPath: expand(r), isDirectory: true) }
        if let r = Bundle.main.object(forInfoDictionaryKey: "KadansRepo") as? String, !r.isEmpty {
            return URL(fileURLWithPath: r, isDirectory: true)
        }
        return nil
    }

    /// KADANS_NODE, else Homebrew's node, else /usr/local/bin/node.
    static var nodePath: String? {
        var candidates: [String] = []
        if let n = env["KADANS_NODE"], !n.isEmpty { candidates.append(expand(n)) }
        candidates += ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }
}

struct CLIResult {
    let code: Int32
    let out: Data
    let err: String
    let timedOut: Bool

    var ok: Bool { code == 0 && !timedOut }

    /// Parsed stdout, only when the command succeeded and printed valid JSON.
    var json: Any? {
        guard ok else { return nil }
        return try? JSONSerialization.jsonObject(with: out)
    }
}

/// Runs `node <repo>/bin/kadans.mjs <args>` as an argv array (never a shell string). Blocking: call it off the main thread.
enum CLI {
    /// A `node <repo>/bin/kadans.mjs <args>` process, set up but not started (argv only, never a shell), or why not.
    /// k28: also used for the long-lived `kadans serve` child (Phone.swift).
    static func process(_ args: [String]) -> (Process?, String) {
        guard let node = Config.nodePath else { return (nil, "node not found (set KADANS_NODE)") }
        guard let repo = Config.repoDir else { return (nil, "repo path unknown (set KADANS_REPO or rebuild with scripts/build-app.sh)") }
        let script = repo.appendingPathComponent("bin/kadans.mjs").path
        guard FileManager.default.fileExists(atPath: script) else { return (nil, "not found: \(script)") }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [script] + args
        p.currentDirectoryURL = repo
        // An app started by launchd has a bare PATH: add node's dir, Homebrew, ~/.local/bin (claude) and Orca's bin dir.
        var env = ProcessInfo.processInfo.environment
        let home = NSHomeDirectory()
        let extra = [(node as NSString).deletingLastPathComponent, "/opt/homebrew/bin", "/usr/local/bin",
                     "\(home)/.local/bin", "/Applications/Orca.app/Contents/Resources/bin"]
        env["PATH"] = (extra + [env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"]).joined(separator: ":")
        p.environment = env
        p.standardInput = FileHandle.nullDevice
        return (p, "")
    }

    static func run(_ args: [String], timeout: TimeInterval = 10) -> CLIResult {
        func fail(_ why: String) -> CLIResult { CLIResult(code: -1, out: Data(), err: why, timedOut: false) }
        let (made, why) = process(args)
        guard let p = made else { return fail(why) }

        let outPipe = Pipe(), errPipe = Pipe()
        p.standardOutput = outPipe
        p.standardError = errPipe
        do { try p.run() } catch { return fail("launch failed: \(error.localizedDescription)") }

        // Drain stderr alongside stdout so neither pipe can fill up and stall the child.
        var errData = Data()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            errData = errPipe.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        let killer = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: killer)
        let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        killer.cancel()
        group.wait()

        let timedOut = p.terminationReason == .uncaughtSignal
        return CLIResult(code: p.terminationStatus, out: outData,
                         err: String(decoding: errData.prefix(2000), as: UTF8.self), timedOut: timedOut)
    }
}

func log(_ s: String) { NSLog("Kadans: %@", s) }
