import Foundation
import CoreGraphics
import IOKit.ps

/// perf-1: when the closed popover's tick and the usage reader run. Pure (no clocks or system reads inside), so the whole
/// schedule reads in one place. Change notices (ChangeWatcher) wake the tick; these numbers bound how often.
enum Schedule {
    /// The closed fallback poll: covers the time rules only (working -> idle after 2 min, old reading dimmed after 10 min).
    static let closedFallback: TimeInterval = 60
    /// On battery, or when nobody touched the Mac for `idleAfter`, the fallback runs half as often.
    static let closedFallbackSlow: TimeInterval = 120
    static let idleAfter: TimeInterval = 300
    /// Closed ticks (one node start: the menu bar title, and the working count when a count is due) at most this often:
    /// the old `status --json` floor, so the menu bar percentage is as fresh as before.
    static let closedMinGap: TimeInterval = 30
    /// Share of one CPU core counting the agents (Orca, ps) may use on average while the popover is closed, as the old
    /// brief: the count gap passed to `live --count-gap`, from the run time of the ticks that counted.
    static let countCpuShare = 0.005
    static let countMinGap: TimeInterval = 3
    static let countMaxGap: TimeInterval = 120

    static func fallback(onBattery: Bool, userIdle: TimeInterval) -> TimeInterval {
        onBattery || userIdle >= idleAfter ? closedFallbackSlow : closedFallback
    }

    /// Least time between two agent counts that take `cost` seconds each: within countCpuShare, clamped.
    static func countGap(cost: TimeInterval) -> TimeInterval {
        min(countMaxGap, max(countMinGap, cost / countCpuShare))
    }

    /// Whether the 120 s usage timer spawns `usage fetch`: not while the reader is off or backing off (the CLI would only
    /// answer "off" / "backoff"). nil = not known yet: run (the CLI decides).
    static func fetchUsage(now: Date, apiOn: Bool?, nextAt: Date?) -> Bool {
        if apiOn == false { return false }
        if let nextAt, nextAt > now { return false }
        return true
    }
}

/// The two system readings Schedule.fallback takes (cheap: no process, no file).
enum Power {
    static var onBattery: Bool {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let type = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() else { return false }
        return (type as String) == "Battery Power" // kIOPMBatteryPowerKey
    }

    /// Seconds since the last keyboard, mouse or trackpad input in this login session.
    static var userIdle: TimeInterval {
        guard let any = CGEventType(rawValue: UInt32.max) else { return 0 }
        return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: any)
    }
}
