// swift-tools-version:5.9
// Kadans menu bar shell: hosts app/web/panel.html in a WKWebView and feeds it `kadans status --json` / `agents --json`.
import PackageDescription

let package = Package(
    name: "Kadans",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "Kadans", path: "Sources/Kadans")
    ]
)
