import AppKit
import CoreImage

// Phone control on the Mac side.
// - PhoneQR: a pairing URL as a crisp QR PNG (CoreImage CIQRCodeGenerator, no smoothing).
// - PhoneParse / PhoneState: what the CLI prints, checked, and the {phone:{on,url,pair,devices,error}} the page hears.
// - PhoneServe: supervises the `kadans serve` child while config `phone` is true (restart with back-off, stop on quit).
// - Phone: the bridge actions phone-on / phone-off / phone-pair / phone-revoke and the device list.
// The page never sees CLI text: every failure becomes one of the fixed strings in PhoneState.Err.

// PhoneQR begin
enum PhoneQR {
    /// Light modules around the code (the QR spec asks for 4).
    static let quietModules = 4
    /// Pixels per module: 8 keeps a ~60 character URL near 330 px, sharp at 2x in a 160 pt box.
    static let defaultScale = 8

    /// PNG bytes for `text`: black modules on opaque white (the panel has a dark mode), a 4-module quiet zone, every
    /// module exactly `scale` pixels (nearest neighbour, never smoothed). nil when CoreImage cannot make the code.
    static func png(_ text: String, scale: Int = defaultScale) -> Data? {
        guard !text.isEmpty, scale >= 1, let f = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        f.setValue(Data(text.utf8), forKey: "inputMessage")
        f.setValue("M", forKey: "inputCorrectionLevel")
        guard let out = f.outputImage, !out.extent.isInfinite, !out.extent.isEmpty else { return nil }
        let ctx = CIContext(options: [.useSoftwareRenderer: true, .cacheIntermediates: false])
        guard let modules = ctx.createCGImage(out, from: out.extent) else { return nil }
        let w = (modules.width + 2 * quietModules) * scale
        let h = (modules.height + 2 * quietModules) * scale
        guard let bmp = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return nil }
        bmp.setFillColor(gray: 1, alpha: 1)
        bmp.fill(CGRect(x: 0, y: 0, width: w, height: h))
        bmp.interpolationQuality = .none
        bmp.setShouldAntialias(false)
        bmp.draw(modules, in: CGRect(x: quietModules * scale, y: quietModules * scale,
                                     width: modules.width * scale, height: modules.height * scale))
        guard let img = bmp.makeImage() else { return nil }
        return NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:])
    }

    static func dataURL(_ text: String) -> String? {
        png(text).map { "data:image/png;base64," + $0.base64EncodedString() }
    }

    /// Reads a QR PNG back (the `--qr` debug path checks the round trip).
    static func decode(_ png: Data) -> String? {
        guard let img = CIImage(data: png),
              let det = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])
        else { return nil }
        return det.features(in: img).compactMap { ($0 as? CIQRCodeFeature)?.messageString }.first
    }
}
// PhoneQR end

// PhoneParse begin (pure Foundation: compiled and checked on its own)
/// What the k26 CLI prints, checked before anything reaches the page. Anything else is nil (a failure).
enum PhoneParse {
    static func isNumber(_ v: Any?) -> Double? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        return d.isFinite ? d : nil
    }

    /// An http(s) URL of plain printable ASCII, at most 512 characters.
    static func url(_ v: Any?) -> String? {
        guard let s = v as? String, s.count <= 512, s.hasPrefix("http://") || s.hasPrefix("https://"),
              s.range(of: "^[\\x21-\\x7e]+$", options: .regularExpression) != nil, URL(string: s) != nil else { return nil }
        return s
    }

    /// `kadans serve` prints one JSON line {"url","host","port","pid"}: the url.
    static func serveURL(line: Data) -> String? {
        guard let o = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { return nil }
        return url(o["url"])
    }

    /// `kadans pair --json` -> {"url","expiresAt"}; the url must carry #pair=.
    static func pair(_ json: Any?) -> (url: String, expiresAt: Double)? {
        guard let o = json as? [String: Any], let u = url(o["url"]), u.contains("#pair="),
              let exp = isNumber(o["expiresAt"]), exp > 0 else { return nil }
        return (u, exp)
    }

    /// A device id the CLI may get back as argv: short, plain, never a flag.
    static func deviceId(_ v: Any?) -> String? {
        guard let s = v as? String, s.range(of: "^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$", options: .regularExpression) != nil
        else { return nil }
        return s
    }

    /// `kadans devices --json` -> [{"id","name","createdAt","lastSeenAt"}]; the page gets {id, name, lastSeenAt} only.
    /// Rows without a valid id are dropped; nil when the output is not a list.
    static func devices(_ json: Any?) -> [[String: Any]]? {
        guard let list = (json as? [Any]) ?? ((json as? [String: Any])?["devices"] as? [Any]) else { return nil }
        return list.prefix(50).compactMap { row in
            guard let o = row as? [String: Any], let id = deviceId(o["id"]) else { return nil }
            let name = (o["name"] as? String).map { String($0.prefix(40)) } ?? ""
            let seen: Any = isNumber(o["lastSeenAt"]).map { NSNumber(value: $0) } ?? NSNull()
            return ["id": id, "name": name, "lastSeenAt": seen]
        }
    }

    /// Config `phone` as a real JSON boolean (anything else is off).
    static func phoneOn(config: Any?) -> Bool {
        guard let n = (config as? [String: Any])?["phone"] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return false }
        return n.boolValue
    }
}

/// The page's `phone` key. Fixed error strings only.
struct PhoneState {
    enum Err {
        static let serve = "The phone server stopped. Kadans is trying again."
        static let config = "Couldn't change the phone setting."
        static let pair = "Couldn't make a pairing code. Try again in a moment."
        static let notOn = "Turn on phone control first."
        static let devices = "Couldn't read the paired phones."
        static let revoke = "Couldn't remove that phone."
        static let busy = "Still working on the last request."
    }

    var on = false
    var url: String?
    var pair: (url: String, qr: String, expiresAt: Double)?
    var devices: [[String: Any]] = []
    var error: String?

    /// {phone:{on, url, pair, devices, error}}; a pair past its expiresAt (epoch ms) is left out.
    func payload(nowMs: Double) -> [String: Any] {
        var p: Any = NSNull()
        if let pair, pair.expiresAt > nowMs {
            p = ["url": pair.url, "qr": pair.qr, "expiresAt": NSNumber(value: pair.expiresAt)] as [String: Any]
        }
        return ["phone": ["on": on, "url": url ?? NSNull(), "pair": p, "devices": devices, "error": error ?? NSNull()] as [String: Any]]
    }
}
// PhoneParse end

/// Keeps one `kadans serve` child running while wanted. Main thread only.
/// - The child's first stdout line gives the URL; stdout and stderr are drained for its whole life.
/// - It died while wanted: restart after 2 s, 4 s, 8 s ... up to 5 min; a child that stayed up 60 s resets the back-off.
/// - stop() and the app's quit send SIGTERM (quit waits up to 1.5 s, then SIGKILL).
final class PhoneServe {
    static let backoffStart: TimeInterval = 2
    static let backoffMax: TimeInterval = 300
    static let stableAfter: TimeInterval = 60

    private(set) var wanted = false
    private(set) var url: String?
    /// The last child died or could not start (cleared when a URL arrives or on stop).
    private(set) var failed = false
    private var child: Process?
    private var startedAt = Date.distantPast
    private var backoff = backoffStart
    private var restart: DispatchWorkItem?
    var onChange: (() -> Void)?

    func setWanted(_ on: Bool) {
        if on {
            guard !wanted else { return }
            wanted = true
            backoff = Self.backoffStart
            launch()
        } else {
            stop()
        }
    }

    func stop() {
        let was = wanted || child != nil
        wanted = false
        restart?.cancel()
        restart = nil
        url = nil
        failed = false
        if let c = child {
            child = nil
            if c.isRunning { c.terminate() }
            log("phone: serve stopped (pid \(c.processIdentifier))")
        }
        if was { onChange?() }
    }

    /// At quit: SIGTERM, a short wait, then SIGKILL, so no serve outlives the app.
    func shutdown() {
        wanted = false
        restart?.cancel()
        restart = nil
        guard let c = child else { return }
        child = nil
        guard c.isRunning else { return }
        c.terminate()
        let deadline = Date().addingTimeInterval(1.5)
        while c.isRunning && Date() < deadline { usleep(20_000) }
        if c.isRunning { kill(c.processIdentifier, SIGKILL) }
        log("phone: serve stopped at quit")
    }

    private func launch() {
        guard wanted, child == nil else { return }
        let (made, why) = CLI.process(["serve"])
        guard let p = made else {
            log("phone: serve not started: \(why)")
            died()
            return
        }
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        var buf = Data()
        var gotLine = false
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil; return }
            guard !gotLine else { return } // keep draining
            buf.append(d)
            guard let nl = buf.firstIndex(of: 10) ?? (buf.count > 8192 ? buf.endIndex : nil) else { return }
            gotLine = true
            let u = PhoneParse.serveURL(line: buf.subdata(in: buf.startIndex..<nl))
            buf = Data()
            DispatchQueue.main.async { self?.started(p, url: u) }
        }
        var errLogged = false
        err.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil; return }
            if !errLogged {
                errLogged = true
                log("phone: serve says: \(String(decoding: d.prefix(200), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))")
            }
        }
        p.terminationHandler = { [weak self] p in
            DispatchQueue.main.async { self?.exited(p) }
        }
        do {
            try p.run()
        } catch {
            out.fileHandleForReading.readabilityHandler = nil
            err.fileHandleForReading.readabilityHandler = nil
            log("phone: serve launch failed: \(error.localizedDescription)")
            died()
            return
        }
        child = p
        startedAt = Date()
        log("phone: serve started (pid \(p.processIdentifier))")
    }

    private func started(_ p: Process, url u: String?) {
        guard child === p else { return }
        if let u {
            url = u
            failed = false
            log("phone: serving at \(u)")
        } else {
            log("phone: serve's first line had no URL")
        }
        onChange?()
    }

    private func exited(_ p: Process) {
        guard child === p else { return } // stopped on purpose (or an older child)
        child = nil
        url = nil
        log("phone: serve exited (code \(p.terminationStatus))")
        if Date().timeIntervalSince(startedAt) >= Self.stableAfter { backoff = Self.backoffStart }
        died()
    }

    private func died() {
        guard wanted else { return }
        failed = true
        onChange?()
        let w = DispatchWorkItem { [weak self] in
            self?.restart = nil
            self?.launch()
        }
        restart = w
        DispatchQueue.main.asyncAfter(deadline: .now() + backoff, execute: w)
        backoff = min(Self.backoffMax, backoff * 2)
    }
}

/// Phone control for the panel: serve supervision, pairing, the device list. Main thread, CLI runs on its own queue.
final class Phone {
    let serve = PhoneServe()
    private let queue = DispatchQueue(label: "dev.kadans.phone", qos: .userInitiated)
    private var busy = false
    private var pair: (url: String, qr: String, expiresAt: Double)?
    private(set) var devices: [[String: Any]] = []
    private var deviceIds = Set<String>()
    private var actionError: String?
    private var devicesError: String?
    /// The page flipped phone on/off moments ago: an older `config get` still in flight must not undo it.
    private var lastSet = Date.distantPast

    /// Something the page should hear changed (serve URL arrived or the child died).
    var onChange: (() -> Void)? {
        didSet { serve.onChange = { [weak self] in self?.onChange?() } }
    }

    var on: Bool { serve.wanted }

    var state: PhoneState {
        var s = PhoneState()
        s.on = serve.wanted
        s.url = serve.url
        s.pair = serve.wanted ? pair : nil
        s.devices = devices
        s.error = actionError ?? (serve.failed ? PhoneState.Err.serve : nil) ?? (serve.wanted ? devicesError : nil)
        return s
    }

    func payload() -> [String: Any] { state.payload(nowMs: Date().timeIntervalSince1970 * 1000) }

    /// Every `config get --json` (the launch refresh included): serve runs while `phone` is true.
    func noteConfig(_ json: Any?) {
        guard Date().timeIntervalSince(lastSet) > 5 else { return }
        let want = PhoneParse.phoneOn(config: json)
        if want != serve.wanted { log("phone: config says \(want ? "on" : "off")") }
        if !want { pair = nil }
        serve.setWanted(want)
    }

    /// phone-on / phone-off: `config set phone true|false`, then start or stop serve. Off stops serve even when the
    /// config write fails; on starts it only when the write worked (else the next config read would stop it again).
    func turn(on: Bool, done: @escaping () -> Void) {
        guard begin() else { return done() }
        lastSet = Date()
        if !on {
            serve.setWanted(false)
            pair = nil
        }
        queue.async {
            let r = CLI.run(["config", "set", "phone", on ? "true" : "false"])
            if !r.ok { log("phone: config set phone failed (code \(r.code)): \(r.err.prefix(200))") }
            DispatchQueue.main.async {
                self.busy = false
                self.lastSet = Date()
                self.actionError = r.ok ? nil : PhoneState.Err.config
                if on && r.ok { self.serve.setWanted(true) }
                done()
            }
        }
    }

    /// phone-pair: `kadans pair --json` -> QR PNG for the URL.
    func makePair(done: @escaping () -> Void) {
        guard serve.wanted else { actionError = PhoneState.Err.notOn; return done() }
        guard begin() else { return done() }
        queue.async {
            let r = CLI.run(["pair", "--json"])
            let p = PhoneParse.pair(r.json)
            let qr = p.flatMap { PhoneQR.dataURL($0.url) }
            if p == nil { log("phone: pair failed (code \(r.code)): \(r.err.prefix(200))") }
            DispatchQueue.main.async {
                self.busy = false
                if let p, let qr {
                    self.pair = (p.url, qr, p.expiresAt)
                    self.actionError = nil
                } else {
                    self.actionError = PhoneState.Err.pair
                }
                done()
            }
        }
    }

    /// An id from the latest device list (the page cannot name anything else).
    func knownDevice(_ v: Any?) -> String? {
        guard let id = PhoneParse.deviceId(v), deviceIds.contains(id) else { return nil }
        return id
    }

    /// phone-revoke: `kadans devices revoke <id>`, then the list again.
    func revoke(_ id: String, done: @escaping () -> Void) {
        guard begin() else { return done() }
        queue.async {
            let r = CLI.run(["devices", "revoke", id])
            if !r.ok { log("phone: devices revoke failed (code \(r.code)): \(r.err.prefix(200))") }
            let list = Self.fetchDevices()
            DispatchQueue.main.async {
                self.busy = false
                self.actionError = r.ok ? nil : PhoneState.Err.revoke
                self.noteDevices(list)
                done()
            }
        }
    }

    /// `kadans devices --json`, blocking (the panel's refresh calls it off the main thread). nil on failure.
    static func fetchDevices() -> [[String: Any]]? {
        let r = CLI.run(["devices", "--json"])
        return PhoneParse.devices(r.json)
    }

    /// A fresh list: a new device means the pairing code was used, so the QR goes away.
    func noteDevices(_ list: [[String: Any]]?) {
        guard let list else { devicesError = PhoneState.Err.devices; return }
        devicesError = nil
        let ids = Set(list.compactMap { $0["id"] as? String })
        if devicesSeen && pair != nil && !ids.subtracting(deviceIds).isEmpty { pair = nil }
        devicesSeen = true
        devices = list
        deviceIds = ids
    }
    private var devicesSeen = false

    private func begin() -> Bool {
        guard !busy else { actionError = PhoneState.Err.busy; return false }
        busy = true
        return true
    }
}
