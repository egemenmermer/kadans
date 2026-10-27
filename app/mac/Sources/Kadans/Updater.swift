import AppKit
#if KADANS_SPARKLE
import Sparkle
#endif

// k44: self-update for the signed premium build (Sparkle 2). Compiled in only when Package.swift sees KADANS_SPARKLE=1
// (scripts/build-app.sh with a feed and a public key); the free build gets the stub below and never has an updater.
// Even when compiled in, the updater starts only when Info.plist has both SUFeedURL and SUPublicEDKey.
// The page hears `update: { auto, available, checking }` (available: the found version or null) and may send
// `update-auto` {on} and `update-install`.
// KADANS_UPDATE_CHECK_NOW=1 (testing only) runs one background check right after start and logs each step.

enum UpdateInfo {
    /// Both keys present and non-empty: the only case in which an updater may start.
    static func configured(_ info: [String: Any]?) -> Bool {
        guard let feed = info?["SUFeedURL"] as? String, let key = info?["SUPublicEDKey"] as? String else { return false }
        return !feed.trimmingCharacters(in: .whitespaces).isEmpty && !key.trimmingCharacters(in: .whitespaces).isEmpty
    }
}

#if KADANS_SPARKLE
final class AppUpdater: NSObject, SPUUpdaterDelegate {
    private var controller: SPUStandardUpdaterController!
    private var canCheck: NSKeyValueObservation?
    private(set) var available: String?
    private(set) var checking = false
    /// The page's payload changed (checking, found, auto flag).
    var onChange: (() -> Void)?

    /// nil when Info.plist lacks SUFeedURL or SUPublicEDKey, or Sparkle refuses to start.
    static func make() -> AppUpdater? {
        guard UpdateInfo.configured(Bundle.main.infoDictionary) else {
            log("updater: off (no SUFeedURL/SUPublicEDKey in Info.plist)")
            return nil
        }
        let u = AppUpdater()
        return u.start() ? u : nil
    }

    private func start() -> Bool {
        controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)
        do {
            try controller.updater.start()
        } catch {
            log("updater: did not start: \(error.localizedDescription)")
            return false
        }
        let u = controller.updater
        log("updater: started (auto checks \(u.automaticallyChecksForUpdates), auto install \(u.automaticallyDownloadsUpdates), feed \(u.feedURL?.absoluteString ?? "-"))")
        canCheck = u.observe(\.canCheckForUpdates, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.noteChecking() }
        }
        if ProcessInfo.processInfo.environment["KADANS_UPDATE_CHECK_NOW"] == "1" {
            log("updater: background check now (KADANS_UPDATE_CHECK_NOW=1)")
            u.checkForUpdatesInBackground()
        }
        return true
    }

    private func noteChecking() {
        let now = controller.updater.sessionInProgress
        guard now != checking else { return }
        checking = now
        onChange?()
    }

    var auto: Bool { controller.updater.automaticallyChecksForUpdates && controller.updater.automaticallyDownloadsUpdates }

    func payload() -> [String: Any] {
        ["update": ["auto": auto, "available": available ?? NSNull(), "checking": checking] as [String: Any]]
    }

    /// The page's Automatic switch: checks and silent installs together.
    func setAuto(_ on: Bool) {
        controller.updater.automaticallyChecksForUpdates = on
        controller.updater.automaticallyDownloadsUpdates = on
        log("updater: automatic \(on ? "on" : "off")")
        onChange?()
    }

    /// "Install <version>" in the page or "Check for Updates…": Sparkle's own window (a downloaded update offers
    /// install and relaunch there).
    func checkNow() {
        NSApp.activate(ignoringOtherApps: true)
        controller.checkForUpdates(nil)
    }

    // MARK: SPUUpdaterDelegate

    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        log("updater: found \(item.displayVersionString) (build \(item.versionString))")
        available = item.displayVersionString
        onChange?()
    }

    func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
        log("updater: no update")
        if available != nil { available = nil; onChange?() }
    }

    func updater(_ updater: SPUUpdater, didDownloadUpdate item: SUAppcastItem) {
        log("updater: downloaded \(item.displayVersionString)")
    }

    func updater(_ updater: SPUUpdater, failedToDownloadUpdate item: SUAppcastItem, error: Error) {
        log("updater: download failed: \(error.localizedDescription)")
    }

    func updater(_ updater: SPUUpdater, didExtractUpdate item: SUAppcastItem) {
        log("updater: extracted \(item.displayVersionString) (signature checked)")
    }

    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem,
                 immediateInstallationBlock immediateInstallHandler: @escaping () -> Void) -> Bool {
        log("updater: \(item.displayVersionString) installs on quit")
        return false // Sparkle's default: install when the app quits
    }

    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
        log("updater: installing \(item.displayVersionString)")
    }

    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        log("updater: aborted: \(error.localizedDescription)")
    }
}
#else
/// Free build: no Sparkle, never an updater.
final class AppUpdater {
    var onChange: (() -> Void)?
    static func make() -> AppUpdater? { nil }
    func payload() -> [String: Any] { [:] }
    func setAuto(_ on: Bool) {}
    func checkNow() {}
}
#endif
