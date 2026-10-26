import AppKit

// Kadans menu bar app. `Kadans --snapshot <out.png> [--fixture <name>] [--theme light|dark]` renders the panel to a PNG and quits.
// `Kadans --menubar-frames <dir>` writes the menu bar blob frames (every face, eyes open and closed) as PNGs and quits.

let args = CommandLine.arguments
func value(after flag: String) -> String? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
    return args[i + 1]
}

let app = NSApplication.shared

if let dir = value(after: "--menubar-frames") {
    app.setActivationPolicy(.prohibited)
    exit(MenuBarFrames.write(to: URL(fileURLWithPath: Config.expand(dir))))
} else if args.contains("--snapshot") {
    guard let path = value(after: "--snapshot") else {
        SnapshotRunner.finish(2, "usage: Kadans --snapshot <out.png> [--fixture <name>] [--theme light|dark]")
        exit(2)
    }
    app.setActivationPolicy(.prohibited)
    let runner = SnapshotRunner(out: URL(fileURLWithPath: Config.expand(path)), fixture: value(after: "--fixture"),
                                theme: value(after: "--theme"))
    DispatchQueue.main.async { runner.start() }
    app.run()
} else {
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}
