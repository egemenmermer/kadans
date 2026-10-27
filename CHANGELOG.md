# Changelog

## 1.0.0 (date: TODO)

First public release. Changes since 0.1.0:

- Private by default: `~/.kadans` is 0700 and every file in it 0600 (an older, wider folder is tightened once). The store
  lock carries an owner token, so a slow writer can no longer free the lock of the writer that took over. Titles and
  prompts lose control and invisible characters (escape sequences, bidi overrides) before they are stored or printed.
- Fresh usage: the app reads your own usage from Anthropic every 2 minutes, so usage from claude.ai, the desktop or phone
  app and other computers shows up too. It uses your own Claude Code sign-in from the Keychain, in memory only; it never
  stores or refreshes the token. Off with `kadans config set usageApi false`. When a reading is old, the gauge dims and the
  panel says how old it is.
- Compact: each row shows the chat's current context size. An idle chat that re-reads a big context every turn gets a
  "Compact?" hint. The Compact button types `/compact` into that chat's Orca terminal after you confirm, and refuses if
  you have unsent text there. New command `kadans agent compact <id>`, and a "Suggest compact" setting (can be turned off).
- Close idle chats from the panel, one at a time or all chats idle for 2 hours or more with Close all. Both ask first.
- The agent list follows Claude Code's own session registry, so a chat you close leaves the list at once.
- Orca terminals are linked to sessions by their pane, so one chat is one row.
- Every agent has a distinct blob, and blobs react when you point at a row. Working agents blink now and then.
- Smoother panel: the 5-second refresh no longer rebuilds rows, so hover and open menus stay put. The gauge, rows and
  Settings move calmly, and nothing animates with Reduce motion on or while the popover is closed.
- Menu bar: the face blinks when you point at it or open the panel, and the popover fades in.
- Kickoff (off by default): `kadans kickoff` starts the next 5-hour window with one small Haiku message on your own
  account. `kadans kickoff schedule` previews a launchd job; the app never writes it.
- Action errors show their reason on the row, for stop, compact and replace.
- Safer hooks: they give up quickly on a held lock, Stop refuses a process id that was reused, and `install` keeps every
  backup.
- Rows match Orca's own state, and the panel and menu bar update within a moment of a change.
- Working agents' blobs move calmly in the panel, and the menu bar face moves while an agent works.

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
