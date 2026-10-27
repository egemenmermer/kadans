// swift-tools-version:5.9
// Kadans menu bar shell: hosts app/web/panel.html in a WKWebView and feeds it `kadans status --json` / `agents --json`.
// k44: KADANS_SPARKLE=1 (set by scripts/build-app.sh only when a Sparkle feed and public key are given, i.e. the signed
// premium build from scripts/release-app.sh) adds Sparkle 2 and compiles the updater in. Without it (the free build that
// `npx kadans setup` compiles) nothing is fetched and the binary has no Sparkle code at all.
import PackageDescription
import Foundation

let sparkle = ProcessInfo.processInfo.environment["KADANS_SPARKLE"] == "1"

let package = Package(
    name: "Kadans",
    platforms: [.macOS(.v13)],
    dependencies: sparkle
        ? [.package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.0")]
        : [],
    targets: [
        .executableTarget(
            name: "Kadans",
            dependencies: sparkle ? [.product(name: "Sparkle", package: "Sparkle")] : [],
            path: "Sources/Kadans",
            swiftSettings: sparkle ? [.define("KADANS_SPARKLE")] : []
        )
    ]
)
