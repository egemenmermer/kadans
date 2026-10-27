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

/// `Kadans --menubar-frames <dir>`: writes every menu bar blob face, eyes open, closed and glancing, as a 2x PNG (32 x 32 px, black on
/// transparent, exactly what the template image is), plus a light and a dark contact sheet at 6x so the frames can be looked at.
/// Also checks that a blink or a glance changes nothing outside the eye area (same outline).
enum MenuBarFrames {
    static let scale = 2
    static let pixels = 16 * scale
    /// Eye area in 2x pixels (the union of every open, closed and glancing eye rect, with a pixel of margin).
    static let eyeBox = (x: 8, y: 11, w: 16, h: 9)

    /// Every frame the menu bar can show, per face: open, closed, and the four glance positions.
    struct Frame {
        let face: MenuBarBlob.Face
        let closed: Bool
        let look: CGFloat
        var name: String {
            if closed { return "closed" }
            if look == 0 { return "open" }
            return (look < 0 ? "left" : "right") + (abs(look) < 1 ? "-half" : "")
        }
    }

    static var frames: [Frame] {
        MenuBarBlob.Face.allCases.flatMap { face in
            [Frame(face: face, closed: false, look: 0), Frame(face: face, closed: true, look: 0)] +
                MenuBarBlob.looks.filter { $0 != 0 }.sorted().map { Frame(face: face, closed: false, look: $0) }
        }
    }

    static func rep(_ f: Frame) -> NSBitmapImageRep {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
                                   hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 32)!
        NSGraphicsContext.saveGraphicsState()
        let ctx = NSGraphicsContext(bitmapImageRep: rep)!
        NSGraphicsContext.current = ctx
        let t = NSAffineTransform()
        t.translateX(by: 0, yBy: CGFloat(pixels))
        t.scaleX(by: CGFloat(scale), yBy: -CGFloat(scale))
        t.concat()
        MenuBarBlob.draw(face: f.face, eyesClosed: f.closed, look: f.look)
        NSGraphicsContext.restoreGraphicsState()
        return rep
    }

    static func alpha(_ rep: NSBitmapImageRep, _ x: Int, _ y: Int) -> Int {
        Int(((rep.colorAt(x: x, y: y)?.alphaComponent ?? 0) * 255).rounded())
    }

    /// Writes k19-<face>-<frame>.png (2x, black on transparent) and two zoomed contact sheets (light and dark menu bar:
    /// rows = faces, columns = open, closed, left, left-half, right-half, right). Fails when a frame differs from its
    /// face's open frame outside the eye area, or not at all inside it.
    static func write(to dir: URL) -> Int32 {
        do { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) } catch {
            SnapshotRunner.finish(1, "cannot create \(dir.path): \(error.localizedDescription)"); return 1
        }
        let all = frames
        var reps: [NSBitmapImageRep] = []
        var failed = false
        var open: NSBitmapImageRep?
        for f in all {
            let r = rep(f)
            reps.append(r)
            let file = dir.appendingPathComponent("k19-\(f.face.name)-\(f.name).png")
            do { try r.representation(using: .png, properties: [:])!.write(to: file) } catch { failed = true; log("write failed: \(file.path)") }
            if !f.closed && f.look == 0 { open = r; continue }
            guard let open else { continue }
            var outside = 0, inside = 0
            for y in 0..<pixels {
                for x in 0..<pixels where alpha(open, x, y) != alpha(r, x, y) {
                    let inBox = x >= eyeBox.x && x < eyeBox.x + eyeBox.w && y >= eyeBox.y && y < eyeBox.y + eyeBox.h
                    if inBox { inside += 1 } else { outside += 1 }
                }
            }
            FileHandle.standardError.write(Data("kadans frames: \(f.face.name) \(f.name): \(inside) px differ in the eye area, \(outside) outside it\n".utf8))
            if outside != 0 || inside == 0 { failed = true }
        }
        let columns = all.count / MenuBarBlob.Face.allCases.count
        for (name, bg, ink) in [("light", (232, 232, 236), 20), ("dark", (46, 46, 52), 245)] {
            let big = sheet(reps, columns: columns, bg: bg, ink: ink)
            let file = dir.appendingPathComponent("k19-sheet-\(name).png")
            do { try big.representation(using: .png, properties: [:])!.write(to: file) } catch { failed = true }
        }
        SnapshotRunner.finish(failed ? 1 : 0, failed ? "frames: failed (see above)" : "wrote \(all.count) frames and 2 sheets to \(dir.path)")
        return failed ? 1 : 0
    }

    /// Faces in rows, frames in columns, every source pixel drawn as a block of `zoom` x `zoom`.
    static func sheet(_ reps: [NSBitmapImageRep], columns: Int, bg: (Int, Int, Int), ink: Int) -> NSBitmapImageRep {
        let zoom = 6, pad = 20, cell = pixels * zoom
        let rows = (reps.count + columns - 1) / columns
        let w = pad * (columns + 1) + cell * columns, h = pad * (rows + 1) + cell * rows
        let out = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4,
                                   hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 32)!
        let data = out.bitmapData!
        let row = out.bytesPerRow  // rows can be padded past w * 4
        for y in 0..<h {
            for x in 0..<w {
                let o = y * row + x * 4
                data[o] = UInt8(bg.0); data[o + 1] = UInt8(bg.1); data[o + 2] = UInt8(bg.2); data[o + 3] = 255
            }
        }
        for (i, r) in reps.enumerated() {
            let ox = pad + (i % columns) * (cell + pad), oy = pad + (i / columns) * (cell + pad)
            for y in 0..<pixels {
                for x in 0..<pixels {
                    let a = Double(alpha(r, x, y)) / 255
                    let c = [bg.0, bg.1, bg.2].map { UInt8(Double($0) * (1 - a) + Double(ink) * a) }
                    for dy in 0..<zoom {
                        for dx in 0..<zoom {
                            let o = (oy + y * zoom + dy) * row + (ox + x * zoom + dx) * 4
                            data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]
                        }
                    }
                }
            }
        }
        return out
    }
}
