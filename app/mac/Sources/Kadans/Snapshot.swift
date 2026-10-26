import AppKit
import WebKit

/// `Kadans --snapshot <out.png> [--fixture <name>] [--theme light|dark]`: renders the panel offscreen, writes a PNG, quits.
final class SnapshotRunner {
    private let out: URL
    private let fixture: String?
    private let panel: PanelController
    private var window: NSWindow!
    private var height: CGFloat = 0
    private var shot = false

    init(out: URL, fixture: String?, theme: String?) {
        self.out = out
        self.fixture = fixture
        self.panel = PanelController(theme: theme)
        self.panel.fixtureOnly = fixture != nil
    }

    func start() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { Self.finish(1, "timed out after 30 s") }
        window = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: PanelController.width, height: PanelController.maxHeight),
                          styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = panel.view
        window.orderFrontRegardless()
        window.setFrameOrigin(NSPoint(x: -4000, y: -4000))

        panel.onSize = { [weak self] h in
            guard let self else { return }
            self.height = h
            self.window.setContentSize(NSSize(width: PanelController.width, height: h))
        }
        panel.onLoaded = { [weak self] in self?.fill() }
        panel.load()
    }

    private func fill() {
        if let fixture {
            panel.renderFixture(fixture) { [weak self] ok in
                if !ok { Self.finish(1, "no fixture named \"\(fixture)\" in app/web/fixtures") }
                self?.shoot()
            }
        } else {
            panel.refresh { [weak self] in self?.shoot() }
        }
    }

    private func shoot() {
        guard !shot else { return }
        shot = true
        // Give the size message a moment, then measure. (requestAnimationFrame never fires in the offscreen window.)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            let measure = "Math.ceil((document.getElementById('kadans').firstElementChild || document.body).getBoundingClientRect().height)"
            log("snapshot: rendered, size message height \(self.height)")
            self.panel.webView.evaluateJavaScript(measure) { v, _ in
                log("snapshot: measured \(String(describing: v))")
                if self.height == 0, let h = (v as? NSNumber)?.doubleValue, h > 0 {
                    self.height = min(PanelController.maxHeight, CGFloat(h))
                    self.window.setContentSize(NSSize(width: PanelController.width, height: self.height))
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.capture() }
            }
        }
    }

    private func capture() {
        let cfg = WKSnapshotConfiguration()
        cfg.rect = NSRect(x: 0, y: 0, width: PanelController.width, height: height > 0 ? height : panel.webView.bounds.height)
        log("snapshot: capturing \(cfg.rect)")
        panel.webView.takeSnapshot(with: cfg) { image, error in
            guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else {
                Self.finish(1, "snapshot failed: \(error?.localizedDescription ?? "no image")")
                return
            }
            do {
                try png.write(to: self.out)
                Self.finish(0, "wrote \(self.out.path) (\(rep.pixelsWide)x\(rep.pixelsHigh))")
            } catch {
                Self.finish(1, "write failed: \(error.localizedDescription)")
            }
        }
    }

    static func finish(_ code: Int32, _ message: String) {
        FileHandle.standardError.write(Data("kadans snapshot: \(message)\n".utf8))
        exit(code)
    }
}
