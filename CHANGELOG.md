# Changelog

## 0.1.0

First public version.

- Usage gauge for the 5-hour and 7-day windows, with pace, projection at the reset and a status line.
- Menu bar app for macOS (Swift, AppKit and WebKit, no third-party packages) with a panel in light and dark.
- Agent list with plain titles, from `/rename`, Claude Code's own title or a cleaned-up first prompt.
- Stop, Replace, and Slow or Pause per agent, with a confirmation before Stop.
- Brake: holds new sub-agents and workflows while your pace would run you out before the reset.
- Throttle: off by default, per account and per session; feeds only tasks you approved.
- Auto-pace: optional nudge, then a gentle slowdown if the brake holds.
- Task queue with projects, urgency and approval (`kadans task ...`).
- `kadans install` and `uninstall` preview first, change nothing without `--apply`, and back up your settings.
- English everywhere; the status line and command aliases also speak Turkish.
- Everything stays on your Mac. No network calls.
