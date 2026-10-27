import AppKit

/// The 16 px blob as a template image (adapts to light/dark menu bars). Eyes are cut out.
/// The closed-eyes and glance frames keep the body path untouched, so nothing around the eyes ever moves.
enum MenuBarBlob {
    enum Face: CaseIterable {
        case work, slow
        var name: String { self == .work ? "work" : "slow" }
    }

    static let size = NSSize(width: 16, height: 16)
    /// Where the eyes can look, in points: centre, half way and all the way (1 pt = 2 px on a Retina menu bar).
    static let looks: [CGFloat] = [0, -0.5, -1, 0.5, 1]

    /// Draws the blob into the current context, 16 x 16 points, top-left origin (flipped).
    /// look: the eyes' sideways shift in points (negative = left); only the open eyes move.
    static func draw(face: Face, eyesClosed: Bool = false, look: CGFloat = 0) {
        // Same shape as the panel's "square" blob (viewBox 32), scaled by 0.5.
        let path = NSBezierPath(roundedRect: NSRect(x: 2.25, y: 2.5, width: 11.5, height: 11), xRadius: 3.75, yRadius: 3.75)
        let dx = eyesClosed ? 0 : look
        func eye(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) {
            path.append(NSBezierPath(roundedRect: NSRect(x: x + dx, y: y, width: w, height: h), xRadius: min(w, h) / 2, yRadius: min(w, h) / 2))
        }
        switch (face, eyesClosed) {
        case (.work, false):
            eye(5.9, 5.6, 1.5, 3.4)
            eye(8.6, 5.6, 1.5, 3.4)
        case (.work, true):
            // Eyes shut: two thin lines at the height the open eyes were centred on.
            eye(5.5, 6.8, 2.1, 1.0)
            eye(8.4, 6.8, 2.1, 1.0)
        case (.slow, false):
            eye(5.4, 7.0, 2.2, 1.3)
            eye(8.4, 7.0, 2.2, 1.3)
        case (.slow, true):
            // The half-shut bars thin out and sink a little: lids all the way down.
            eye(5.4, 7.7, 2.2, 0.7)
            eye(8.4, 7.7, 2.2, 0.7)
        }
        path.windingRule = .evenOdd
        NSColor.black.setFill()
        path.fill()
    }

    /// Main thread only. Every frame is drawn once and kept (2 faces x (closed + 5 looks) = 12 small images at most).
    private static var cache: [String: NSImage] = [:]

    static func image(face: Face, eyesClosed: Bool = false, look: CGFloat = 0) -> NSImage {
        let key = "\(face.name)/\(eyesClosed)/\(eyesClosed ? 0 : look)"
        if let img = cache[key] { return img }
        let img = NSImage(size: size, flipped: true) { _ in
            draw(face: face, eyesClosed: eyesClosed, look: look)
            return true
        }
        img.isTemplate = true
        cache[key] = img
        return img
    }
}

/// Keeps the menu bar blob alive, and quiet:
/// - it blinks now and then (every 4-9 s, at random, so it never falls into step with anything else on the bar),
///   on hover, and once when the popover opens;
/// - while an agent works, some of those moments are a glance instead: the eyes look to one side, hold, and come back.
/// One one-shot timer (with tolerance) waits for the next moment; a moment is a few one-shot steps (<= 8 image swaps).
/// Nothing runs with Reduce motion, while the screen is locked, while the displays sleep or while the Mac sleeps.
final class BlobBlinker: NSObject {
    weak var button: NSStatusBarButton?
    var isPopoverShown: () -> Bool = { false }

    static let closedFor: TimeInterval = 0.11
    static let secondBlinkGap: TimeInterval = 0.12
    static let secondBlinkChance = 0.2
    static let minGap: TimeInterval = 1.5
    /// The wait between two idle moments.
    static let idleGap: ClosedRange<TimeInterval> = 4...9
    /// While an agent works, this share of the idle moments is a glance (the rest stay blinks).
    static let glanceChance = 0.6
    /// A glance: a short in-between frame (the eyes' quick move), then a calm hold on the side.
    static let saccade: TimeInterval = 0.06
    static let hold: ClosedRange<TimeInterval> = 0.7...1.1
    static let glanceBothSides = 0.65

    private var face: MenuBarBlob.Face = .work
    private var lastBlink: Date = .distantPast
    /// Bumped by every blink or glance start, every face change and every pause; a pending step from an older one does nothing.
    private var generation = 0
    private var idleTimer: Timer?
    /// Agents working right now; nil = unknown (no working motion).
    private(set) var working: Int?
    private var displaysAsleep = false
    private var screenLocked = false
    private var macAsleep = false
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []

    static var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    var canAnimate: Bool { button != nil && !Self.reduceMotion && !displaysAsleep && !screenLocked && !macAsleep }

    /// Starts the idle moments and listens for the things that pause them.
    func start() {
        let ws = NSWorkspace.shared.notificationCenter
        let dist = DistributedNotificationCenter.default()
        func on(_ c: NotificationCenter, _ name: Notification.Name, _ change: @escaping (BlobBlinker) -> Void) {
            let o = c.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                guard let self else { return }
                change(self)
                self.resume()
            }
            observers.append((c, o))
        }
        on(ws, NSWorkspace.screensDidSleepNotification) { $0.displaysAsleep = true }
        on(ws, NSWorkspace.screensDidWakeNotification) { $0.displaysAsleep = false }
        on(ws, NSWorkspace.willSleepNotification) { $0.macAsleep = true }
        on(ws, NSWorkspace.didWakeNotification) { $0.macAsleep = false }
        on(ws, NSWorkspace.accessibilityDisplayOptionsDidChangeNotification) { _ in }
        on(dist, Notification.Name("com.apple.screenIsLocked")) { $0.screenLocked = true }
        on(dist, Notification.Name("com.apple.screenIsUnlocked")) { $0.screenLocked = false }
        resume()
    }

    deinit {
        for (c, o) in observers { c.removeObserver(o) }
        idleTimer?.invalidate()
    }

    /// Re-checks the pause conditions: arms the next moment when motion is allowed, else stops and shows the plain face.
    private func resume() {
        if canAnimate {
            if idleTimer == nil { arm() }
        } else {
            idleTimer?.invalidate()
            idleTimer = nil
            generation += 1
            button?.image = MenuBarBlob.image(face: face)
        }
    }

    private func arm(after: TimeInterval? = nil) {
        idleTimer?.invalidate()
        idleTimer = nil
        guard canAnimate else { return }
        let t = Timer(timeInterval: after ?? .random(in: Self.idleGap), repeats: false) { [weak self] _ in self?.tick() }
        t.tolerance = 0.5
        RunLoop.main.add(t, forMode: .common)
        idleTimer = t
    }

    private func tick() {
        idleTimer = nil
        guard canAnimate else { return }
        if (working ?? 0) > 0 && Double.random(in: 0..<1) < Self.glanceChance {
            glance()
        } else {
            blink(force: false)
        }
        arm()
    }

    /// The working count from `agents --brief --json` (closed) or the panel's agent list (open); nil = unknown.
    /// When work starts, the next moment comes sooner (1-2 s) so the blob reacts.
    func setWorking(_ n: Int?) {
        let was = working ?? 0
        working = n
        if was == 0 && (n ?? 0) > 0 && canAnimate { arm(after: .random(in: 1...2)) }
    }

    /// The menu bar state changed: show the new face, open-eyed and centred, and drop whatever moment was running.
    func setFace(_ f: MenuBarBlob.Face) {
        guard f != face else { return }
        face = f
        generation += 1
        button?.image = MenuBarBlob.image(face: f)
    }

    @objc func mouseEntered(with event: NSEvent) {
        guard !isPopoverShown() else { return }
        blink(force: false)
    }

    /// force: the popover-open blink, which skips the rate check (never reduce motion).
    func blink(force: Bool, doubleBlink: Bool? = nil) {
        guard !Self.reduceMotion, let button else { return }
        let now = Date()
        if !force && now.timeIntervalSince(lastBlink) < Self.minGap { return }
        lastBlink = now
        generation += 1
        let again = doubleBlink ?? (Double.random(in: 0..<1) < Self.secondBlinkChance)
        var frames: [Frame] = [Frame(closed: true, look: 0, hold: Self.closedFor)]
        if again { frames += [Frame(closed: false, look: 0, hold: Self.secondBlinkGap), Frame(closed: true, look: 0, hold: Self.closedFor)] }
        frames.append(Frame(closed: false, look: 0, hold: 0))
        play(generation, frames[...], button)
    }

    /// Eyes to one side and back (4 swaps), or to one side, the other, and back (8 swaps).
    func glance(firstLeft: Bool? = nil, bothSides: Bool? = nil) {
        guard canAnimate, let button else { return }
        generation += 1
        let s: CGFloat = (firstLeft ?? .random()) ? -1 : 1
        let both = bothSides ?? (Double.random(in: 0..<1) < Self.glanceBothSides)
        var frames = [Frame(closed: false, look: s / 2, hold: Self.saccade), Frame(closed: false, look: s, hold: .random(in: Self.hold)),
                      Frame(closed: false, look: s / 2, hold: Self.saccade), Frame(closed: false, look: 0, hold: both ? 0.3 : 0)]
        if both {
            frames += [Frame(closed: false, look: -s / 2, hold: Self.saccade), Frame(closed: false, look: -s, hold: .random(in: Self.hold)),
                       Frame(closed: false, look: -s / 2, hold: Self.saccade), Frame(closed: false, look: 0, hold: 0)]
        }
        play(generation, frames[...], button)
    }

    private struct Frame {
        let closed: Bool
        let look: CGFloat
        let hold: TimeInterval
    }

    private func play(_ gen: Int, _ frames: ArraySlice<Frame>, _ button: NSStatusBarButton) {
        guard gen == generation, let f = frames.first else { return }
        button.image = MenuBarBlob.image(face: face, eyesClosed: f.closed, look: f.look)
        let rest = frames.dropFirst()
        guard !rest.isEmpty else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + f.hold) { [weak self, weak button] in
            guard let self, let button else { return }
            self.play(gen, rest, button)
        }
    }
}
