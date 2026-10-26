# Security and privacy

Kadans runs on your Mac only. It has no server, makes no network calls of its own, and needs no account or API key.
To check: `grep -rnE "https?://|fetch\(|XMLHttpRequest" lib bin app/web` finds no request code. The one exception is
kickoff (below, off by default): it runs the `claude` command, which talks to Anthropic as usual.

## What it reads

- The status line payload that Claude Code passes on stdin: usage percentages and reset times, session id, working
  folder, model and transcript path.
- Hook payloads for the session events listed below (session id, working folder, event name, and the start of your
  prompt, cut to about 120 characters).
- Session transcripts under `~/.claude/projects/`, read-only, for token counts, the model, a session title and the
  start of the first prompt (to make a title). Nothing is sent anywhere.
- The process list (`ps`) to tell whether a session is still running.
- If Orca is installed: its `orca` command, to list agent terminals and their titles.
- If Orca is installed: `~/.claude/sessions/<pid>.json` and, for each running `claude` process, the `ORCA_PANE_KEY`
  and `ORCA_TERMINAL_HANDLE` values from its environment (via `ps`), to tell which terminal hosts which session. Only
  those two values are read; nothing else from the environment is kept or logged.
- `~/.claude/sessions/<pid>.json` (the folder in `CLAUDE_CONFIG_DIR`), also without Orca, to tell which sessions are still
  open: only `pid`, `sessionId`, `procStart` and `kind` are read; the `*.key` files next to them (peer tokens) are never opened.
- `~/.claude/settings.json` (or the folder in `CLAUDE_CONFIG_DIR`), when you run `install` or `uninstall`.

## What it writes

- `~/.kadans/` (or `KADANS_HOME`): usage samples (kept 8 days), the session event log (kept 2 days), a transcript scan
  cache, `config.json`, `pace.json`, `titles.json`, your projects and tasks, and a copy of your previous status line.
- `settings.json`, only with `install --apply` or `uninstall --apply`, and always after a copy to
  `settings.json.kadans-backup-<time>`. Entries from other tools are left alone.
- `build/` and `~/Applications/Kadans.app`, when you run `scripts/build-app.sh`.
- A one-shot script in `~/.kadans/run/`, only when you press Start or Replace for a task you approved. It opens a
  new Claude Code session in Terminal.app or an Orca worktree and deletes itself.
- macOS notifications through `osascript`, only if you set `"notify": true` in `config.json`.
- `~/.kadans/kickoff.json` (time and result of the last kickoff) and one `Kickoff` line in the event log per kickoff.
- `~/Library/LaunchAgents/dev.kadans.kickoff.plist`, only with `kadans kickoff schedule --apply` (removed by
  `kadans kickoff unschedule --apply`). The app never writes it.

## Kickoff (off by default)

`kadans kickoff` runs exactly `claude -p "Reply with the single word OK." --model haiku`, once, in a new empty temp folder
(deleted afterwards), with a 90-second timeout, with `CLAUDE_CONFIG_DIR` and `KADANS_THROTTLE` removed from its
environment: so always your own account (`~/.claude`), never another profile, and never fed a task. It runs only when
`kickoff.enabled` is true, the local time is between `kickoff.from` and `kickoff.to`, and your own 5-hour window has
ended (or no sample shows a live one). After a kickoff it waits 5 hours (1 hour after a failed one) before it would run
again. Each kickoff spends a tiny amount of your quota. The scheduled job (`kickoff schedule --apply`) runs
`kadans kickoff` every 15 minutes through launchd; on its own it changes nothing while kickoff is off.

## Hooks it installs

Run `kadans install` for the exact preview. In short: the status line, plus `Stop`, `PreToolUse` (two entries),
`PostToolUse`, and event logging on `SessionStart`, `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`,
`SessionEnd` and `Notification`. The README has a table with what each one does. All hooks fail open and exit quietly on
error.

The `PreToolUse` and `PostToolUse` pace hooks run on every tool call. They read two small files and return at once,
unless you slowed or paused that session or turned Auto-pace on.

## What the app can do

The menu bar app shows a web page in a locked-down view: it loads only local files and ignores navigation elsewhere.
The page can ask the app for a short list of actions (stop, compact, pace, Auto-pace, start, replace, approve, resize,
refresh). Each runs `kadans` with a fixed argument list, never through a shell, and only with ids from the current agent
list.

Compact: Kadans can type `/compact` (and Enter) into a chat's Orca terminal (`orca terminal send`), only when you click
it (or run `kadans agent compact <id>`), and only for an idle chat whose terminal it knows for sure; never on its own, and
never into any other app. Just before sending it reads that terminal's visible screen once (`orca terminal read --screen`,
read-only, used only to see whether the input line is empty, never stored or logged) and refuses if you have unsent text
there, a dialog is open, or the screen cannot be read.

## Uninstall

```sh
node bin/kadans.mjs uninstall --apply
node bin/kadans.mjs kickoff unschedule --apply   # only if you scheduled kickoff
rm -rf ~/Applications/Kadans.app ~/.kadans
```

`uninstall` removes only Kadans entries from `settings.json` and puts your previous status line back.

## Reporting a problem

Please open a private security advisory on the GitHub repository, or an issue if it is not sensitive. Do not include
real session titles or paths in a report.
