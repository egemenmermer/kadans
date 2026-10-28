# Security and privacy

Kadans runs on your Mac only. It needs no account or API key, and it runs no server unless you turn phone control on
(below, off by default). It makes one kind of network call of its own: the fresh usage reading below (one GET to `https://api.anthropic.com/api/oauth/usage`, on by default, off with
`kadans config set usageApi false`). To check: `grep -rnE "https?://|fetch\(|XMLHttpRequest" lib bin app/web` finds only
`lib/usage-api.mjs`, plus the two `http://` links `kadans serve` and `kadans pair` print for phone control (the phone
server itself only answers requests). The other exceptions are kickoff (below, off by default) and smart titles (below, on by default): they run the `claude`
command, which talks to Anthropic as usual.

## What it reads

- The status line payload that Claude Code passes on stdin: usage percentages and reset times, session id, working
  folder, model and transcript path.
- Hook payloads for the session events listed below (session id, working folder, event name, and the start of your
  prompt, cut to about 120 characters).
- Session transcripts under `~/.claude/projects/`, read-only, for token counts, the model, a session title and the
  start of the first prompt (to make a title). Nothing is sent anywhere. To avoid re-reading big transcripts, the
  transcript scan cache (`agents-cache.json`) keeps up to 2000 characters of each listed session's first prompt, on
  this Mac only, in a file only you can read (mode 0600), for as long as the session is listed.
- Sub-agent transcripts next to them (`<session>/subagents/agent-<id>.jsonl`, for sub-agents the hook log knows), read-only,
  for token counts only. Their cache entries hold numbers only (offset, size, time, tokens, context), no prompt or text.
- The process list (`ps`) to tell whether a session is still running.
- If Orca is installed: its `orca` command, read-only, to list its agents' states (`orca worktree ps`, once per refresh)
  and, only when a pane's terminal handle is not known yet, its terminals (`orca terminal list`, at most once a minute).
  Only the state, its start time, the pane and terminal ids and the worktree path are kept; the prompt, preview, last
  message and tool input that Orca also returns are not stored, logged or shown. The tab title is used in memory only,
  as a row's title when the row has no title of yours or from Claude Code (then `orca terminal list` may run once in that
  refresh); it is stripped of control characters and never written to disk or logged.
- If Orca is installed: `~/.claude/sessions/<pid>.json` and, for each running `claude` process, the `ORCA_PANE_KEY`
  and `ORCA_TERMINAL_HANDLE` values from its environment (via `ps`), to tell which terminal hosts which session. Only
  those two values are read; nothing else from the environment is kept or logged.
- `~/.claude/sessions/<pid>.json` (the folder in `CLAUDE_CONFIG_DIR`), also without Orca, to tell which sessions are still
  open: only `pid`, `sessionId`, `procStart` and `kind` are read; the `*.key` files next to them (peer tokens) are never opened.
- `~/.claude/settings.json` (or the folder in `CLAUDE_CONFIG_DIR`), when you run `install` or `uninstall`.
- If the Codex CLI is installed (`~/.codex/sessions` or `$CODEX_HOME/sessions` exists, and `codex` is not set to false):
  its session logs `sessions/YYYY/MM/DD/rollout-*.jsonl` of the last 8 days, read-only, to show Codex's limits next to
  Claude's (`kadans status`, `kadans codex sync`). Only regular files with that name are opened (symlinks are skipped);
  nothing else in the Codex folder is read (never `auth.json`) and nothing is written there. Only lines containing
  `"rate_limits"` are parsed; from them only the time, the usage percentages, window lengths, reset times and the plan
  word are kept. Prompts, replies and tool output are skipped unparsed and never stored or printed. Kadans shows the Codex
  account's pace but never acts on it (no brake, feed, slow, gas or kickoff). Off with `kadans config set codex false`.

- The macOS Keychain item `Claude Code-credentials` (your own `~/.claude` account; Claude Code keeps other config dirs
  under other items, which Kadans never reads), through `/usr/bin/security find-generic-password` with an argument list,
  for the fresh usage reading below. Only the access token and its expiry are used.

## What it writes

Private by default: `~/.kadans` is created readable by you only (mode 0700, and tightened once if an older copy was
wider) and every file Kadans writes in it is 0600, because the event log and caches hold the start of your prompts and
your working folders. Other accounts on the same Mac cannot read them. Files are written to a temp file and renamed, and
one lock (with an owner token, so a slow writer never frees another writer's lock) keeps two writers from overwriting
each other. Titles and prompts are stripped of control and invisible characters before they are stored or printed, so
a hostile title cannot send escape sequences to your terminal.

- `~/.kadans/` (or `KADANS_HOME`): usage samples (kept 8 days), the session event log (kept 2 days), a transcript scan
  cache, `orca-panes.json` (Orca pane key -> terminal handle, and per claude process its pane and terminal: ids only), `agents-brief.json` (the agent counts of the
  latest list for the menu bar), `config.json`, `pace.json`, `titles.json`, `order.json` (the agent ids you dragged into your own order; ended ones are dropped), your projects and tasks, and a copy of your previous status line.
- `settings.json`, only with `install --apply` or `uninstall --apply`, and always after a copy to
  `settings.json.kadans-backup-<time>`. Entries from other tools are left alone.
- `build/` and `~/Applications/Kadans.app`, when you run `scripts/build-app.sh`.
- A one-shot script in `~/.kadans/run/`, only when you press Start or Replace for a task you approved. It opens a
  new Claude Code session in Terminal.app or an Orca worktree and deletes itself.
- macOS notifications through `osascript`, only if you set `"notify": true` in `config.json`.
- `~/.kadans/codex-cache.json`: per Codex rollout file its path, size, change time and how far it was read (numbers
  only), so an unchanged log is never read again. Codex readings go to their own `accounts/<key>/samples.jsonl`.
- `~/.kadans/usage-api.json`: time of the last usage reading attempt and success, the failure count, the next allowed
  time and a short error code (such as `http_429`). Never a token.
- `~/.kadans/titles.json` `_smart`: per chat the smart title, the prompt count it was made from and the last try time,
  plus the times of the title calls of the last 5 hours. `~/.kadans/titles-trigger.stamp`: time of the last trigger.
- `~/.kadans/kickoff.json` (time and result of the last kickoff) and one `Kickoff` line in the event log per kickoff.
- `~/.kadans/lean.json` (lean mode): per session the files read (path, size, change time, whole or part, time read; never
  the contents) and two counters, at most 20 sessions of the last 24 hours and 100 files each.
- `~/.kadans/autogas.json` (time, window id, task id, session id and result of each spare-quota start, kept 2 days) and
  one `AutoGas` line in the event log per start.
- Phone control only (off by default): `~/.kadans/serve.json` (the running server's address, port and pid),
  `~/.kadans/phone.json` (paired devices: id, name, times and a sha256 of each device token; the pending pair code, also
  only as a sha256) and `~/.kadans/phone-log.jsonl` (one line per request: time, device id, route, status; no bodies,
  tokens or codes; moved to `phone-log.1.jsonl` past about 1 MB).
- `~/Library/LaunchAgents/dev.kadans.kickoff.plist`, only with `kadans kickoff schedule --apply` (removed by
  `kadans kickoff unschedule --apply`). The app never writes it.

## Fresh usage reading (on by default)

The status line only brings a usage sample when a Claude Code chat on this Mac makes a model call. Usage from claude.ai,
the desktop or phone app or another computer would go unseen, so the app runs `kadans usage fetch` every 2 minutes (and
when you open it and the last reading is over a minute old). It reads the same numbers Claude Code's `/usage` shows:

1. Reads the `Claude Code-credentials` Keychain item (your own account only). The first time, macOS may ask whether to
   allow it.
   Choose "Allow" if you want to be asked again, or "Always Allow" if you do not. "Always Allow" has a price: it adds
   `/usr/bin/security` (the tool Kadans calls) to that Keychain item's access list, so afterwards any program you run
   can read the token through `security` without a prompt. That is how the macOS Keychain works, not something Kadans
   adds; if you prefer the prompt, click "Allow", or turn the fresh reading off (`usageApi false`) and no Keychain
   access happens at all. No proxy is used unless you set one up yourself.
2. If the access token is missing or expires within a minute, it stops there: "login needs a Claude Code session". It
   never uses the refresh token, because refreshing rotates it and could log Claude Code out.
3. Otherwise it sends one `GET https://api.anthropic.com/api/oauth/usage` (redirects refused, 10 s timeout) and stores the
   5-hour and 7-day percentages and reset times as a normal sample marked `source: "api"`.

Token rules: the access token lives in memory for that one request. It is never written to disk, logged, printed, put
in an error message, passed on a command line or in an environment variable, or sent anywhere but api.anthropic.com.
A 401, 403, 429, 5xx or timeout stores no sample and backs off (2, 4, 8, 16, then 30 minutes, or longer if the server
says so); there is never more than one request a minute. Turn it off with `kadans config set usageApi false`.

## Kickoff (off by default)

`kadans kickoff` runs exactly `claude -p "Reply with the single word OK." --model haiku`, once, in a new empty temp folder
(deleted afterwards), with a 90-second timeout, with `CLAUDE_CONFIG_DIR` and `KADANS_THROTTLE` removed from its
environment: so always your own account (`~/.claude`), never another profile, and never fed a task. It runs only when
`kickoff.enabled` is true, the local time is between `kickoff.from` and `kickoff.to`, and your own 5-hour window has
ended (or no sample shows a live one). After a kickoff it waits 5 hours (1 hour after a failed one) before it would run
again. Each kickoff spends a tiny amount of your quota. The scheduled job (`kickoff schedule --apply`) runs
`kadans kickoff` every 15 minutes through launchd; on its own it changes nothing while kickoff is off.

## Smart titles (on by default)

`kadans titles refresh` names your own account's live chats (`~/.claude` only, never another profile) with a 3-6 word
title. It sends Haiku the chat's project name, Claude Code's own title and its last 3 prompts (each cut to 300
characters), on stdin, through `claude -p --model haiku --no-session-persistence --tools ""` (no tools, no saved
session) in `~/.kadans/titler`, with `CLAUDE_CONFIG_DIR` and `KADANS_THROTTLE` removed and `KADANS_INTERNAL=1` (Kadans'
hooks ignore that run). `kadans agents` starts it in the background at most once a minute. At most one call per run,
one a minute, 30 per 5 hours, a chat at most every 20 minutes and only after 2 new prompts; never while your account is
in brake. Each call spends a tiny amount of your quota. Off with `kadans config set smartTitles false`.

## Spare quota on its own (off by default)

`kadans gas tick` (the app runs it every 5 minutes while it is on) can open a new Claude Code session for your next
approved task when your own 5-hour window would end with quota unused. It is off unless both `accounts.<own key>.gas`
and `autoGas` are true (`kadans config set autoGas true`). What it can start: only a task you approved (`kadans approve
<id>`), only on your own account (`~/.claude`: it reads that account's usage whatever `CLAUDE_CONFIG_DIR` says, and the
session script unsets `CLAUDE_CONFIG_DIR`), never another account profile. It goes through the same path as pressing
Start (`kadans task start <id>`), at most one task per call, and only with at least 15 % projected unused and 45 minutes
left (or no 5-hour window running at all, as at night: then the start opens a new window), fewer than `autoGasMax`
(default 1, at most 3) auto-started tasks still running, no other auto start in the last 10 minutes, and at least
`autoGasMinRamGB` (default 2.5) of free memory (`vm_stat`, macOS only). A task that fails to start is not tried again
until the window resets. The session spends your quota like any session you start yourself. `kadans gas tick --dry-run` shows the answer and changes nothing.

## Hooks it installs

Run `kadans install` for the exact preview. In short: the status line, plus `Stop`, `PreToolUse` (three entries),
`PostToolUse` (two entries), lean mode on `SessionStart`, and event logging on `SessionStart`, `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`,
`SessionEnd` and `Notification`. The README has a table with what each one does. All hooks fail open and exit quietly on
error.

The `PreToolUse` and `PostToolUse` pace hooks run on every tool call. They read two small files and return at once,
unless you slowed or paused that session or turned Auto-pace on.

## What the app can do

The menu bar app shows a web page in a locked-down view: it loads only local files and ignores navigation elsewhere.
The page can ask the app for a short list of actions (stop, compact, pace, Auto-pace, start, replace, approve, rename,
reorder, resize, refresh). A rename title is stripped of control characters and limited to 80 characters. Each runs `kadans` with a fixed argument list, never through a shell, and only with ids from the current agent
list.

Compact: Kadans can type `/compact` (and Enter) into a chat's Orca terminal (`orca terminal send`), only when you click
it (or run `kadans agent compact <id>`), and only for an idle chat whose terminal it knows for sure; never on its own, and
never into any other app. Just before sending it reads that terminal's visible screen once (`orca terminal read --screen`,
read-only, used only to see whether the input line is empty, never stored or logged) and refuses if you have unsent text
there, a dialog is open, or the screen cannot be read.

## Phone control (off by default)

`kadans config set phone true` (or the switch in the app) lets a phone use the same panel. The app then keeps
`kadans serve` running: a small HTTP server (Node's built-in `http`, no dependencies) on one address of this Mac, port
7477. By default that is the Mac's Tailscale address (100.64.0.0/10) if it has one, else its LAN address; never every
interface (0.0.0.0). `kadans serve` refuses to start while `phone` is false.

Pairing: `kadans pair` (or "Pair a phone" in the app) makes a one-time code: 128 random bits, valid 10 minutes, one use, a
new code replaces an unused one, stored only as a sha256. The code travels in the link's `#pair=` part, which the browser
never sends in a request line. The phone trades it for a device token (256 random bits) once; Kadans keeps only the
token's sha256 and compares in constant time. At most 5 pair attempts per minute per address, 10 devices, 10 requests a
second per device.

What a paired phone can do: read what the panel shows (`status`, `agents` and `config get`, the same three reads as the
Mac panel), and press the panel's own buttons: stop, compact, approve, start, replace, slow/pause/resume, rename (a title of at most 80 characters, control characters
stripped) and reorder (agent ids from the current list only), and change a
setting through `kadans config set` (whose allow-list includes notifications, Auto-pace, kickoff, auto-start and the gas
switch of your own account). Each runs `kadans` with a fixed argument list, never a shell, with the same checks as the Mac
app: agent ids must be in the current list, task ids must be whole numbers. What it cannot do: anything else. No
terminal text or input, no shell, no files but the panel's own (an exact list: panel.html, panel.js, panel.css, the manifest and the icons; any other
path, in any letter case, is 404; no directory listing), slow clients are cut off (10 s for the headers, 30 s per request,
5 s idle keep-alive, at most 64 connections), no install or
uninstall, no pairing or unpairing, no CORS, and the pages may not be framed (`Content-Security-Policy: default-src
'self'` with inline styles allowed for the panel's gauges, never inline scripts; `X-Frame-Options: DENY`). A request
must name the server's own address (Host header), which also stops DNS rebinding pages. Once `phone` is false, every
API request gets 503 even if the server is still running. The paired device's token is the security boundary: the
`confirmed: true` flag on starting a task or a handoff is a safety step in the page, not a second check on the server, so
anything holding a paired token can start workers (revoke the device to stop it).

Use Tailscale. On Tailscale the traffic is end-to-end encrypted between your own devices. On a LAN address it is plain
HTTP: anyone on the same Wi-Fi (a cafe, an office, a shared flat) could read the token on the wire and then act as your
phone until you revoke it. Pair and use the LAN address only on a network you trust.

Revoking: `kadans devices` lists paired phones; `kadans devices revoke <id>` (or the app's list) unpairs one, and its
next request gets 401. `kadans config set phone false` stops the server (the app ends `kadans serve`). Deleting
`~/.kadans/phone.json` unpairs every device.

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
