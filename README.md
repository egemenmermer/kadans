# Kadans

A speedometer for your Claude Code usage limits, in the macOS menu bar.

Kadans shows how fast you are using your Claude limit, where you will land at the reset, and what each agent is doing.
One click to slow, pause, replace or stop an agent.

![The Kadans panel while the brake is on](docs/images/panel-brake.png)

Kadans is free and open source (MIT). It runs only on your Mac and makes no network calls.

## What it shows

- **Gauge.** Your 5-hour window, and the 7-day window if your plan has one, with your pace and the time you are
  projected to run out (or the share that would go unused).
- **Agents.** Every running Claude Code session and sub-agent with a plain title, project, model, tokens and time.
  Titles come from the session itself (a name you set with `/rename`, or Claude Code's own title), else a cleaned-up
  start of your first prompt. No model calls are made to write them.
- **Controls.** Slow, pause, replace and stop, one agent at a time. Stop asks once.
- **Queue.** Tasks you write down for later. Kadans only starts the ones you approved. Replace stops an agent and starts
  one of them.
- **Menu bar item.** A small face and the percentage of your tightest limit. It follows the system light and dark look.

![Pacing one agent](docs/images/panel-pace-menu.png)

![Replacing an agent with a queued task](docs/images/panel-replace.png)

## Requirements

- macOS 13 or newer.
- Node.js 22 or newer.
- Claude Code on a Pro or Max plan. Claude Code only shares usage data on those plans, and only after the first reply
  in a session, so the gauge starts empty.
- For the menu bar app: the Swift toolchain (Xcode or the Command Line Tools).

## Install

Kadans is built from source. There is no download and no binary in this repository.

```sh
git clone https://github.com/egemenmermer/kadans.git
cd kadans
node bin/kadans.mjs install            # preview only: changes nothing
node bin/kadans.mjs install --apply    # write the changes, after a backup
```

`install` first prints a preview. It changes nothing until you run it again with `--apply`. Before writing, it
copies your `settings.json` to `settings.json.kadans-backup-<time>` next to it.

### What `install --apply` adds to Claude Code's settings

It edits `~/.claude/settings.json` (or the folder in `CLAUDE_CONFIG_DIR`). Entries from other tools are left alone.

| Where | What it does |
|---|---|
| Status line | Replaces your status line command. It records usage samples and prints a one-line gauge. Your old command is saved, and restored on uninstall. |
| `Stop` hook | Throttle: can hand one task you approved to a session when part of your limit would go unused. Does nothing unless you opt in (see below). |
| `PreToolUse`, matcher `Agent\|Workflow` | Brake: holds new sub-agents and workflows while the brake is on. |
| `PreToolUse`, matcher `*` | Pace: waits 20 s before a tool call if you slowed that session, halts it if you paused it. Otherwise it reads two small files and returns. |
| `PostToolUse`, matcher `*` | Auto-pace: with Auto-pace on, adds a short "usage is running hot" note, at most every 10 minutes. |
| `SessionStart`, `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`, `SessionEnd` | Writes a small event log so the agent list knows what is running. |
| `Notification` (permission prompts and questions) | Same log: marks an agent as "needs you". |

Every hook fails open: if Kadans errors, Claude Code carries on as if it were not there.

If you already had a status line script, set `"chain"` in `~/.kadans/config.json` to its path. Kadans then runs it with
the same input, so tools that rely on it keep working. Its printed output is dropped. The preview tells you when your
current status line differs from the chained path.

### The menu bar app

```sh
scripts/build-app.sh
```

This builds `build/Kadans.app`, signs it ad hoc and copies it to `~/Applications/Kadans.app`. Nothing starts at login.
Use `--no-install` to build without copying.

- Because you built it yourself, macOS normally opens it without a warning. If it does warn (for example if you copied
  the app from another Mac), right-click the app, choose Open, then confirm. Or run
  `xattr -dr com.apple.quarantine ~/Applications/Kadans.app`.
- The app finds `bin/kadans.mjs` in the checkout you built it from. Keep the checkout where it is, or rebuild after
  moving it. `KADANS_REPO` overrides the path.

You can also use Kadans without the app: `node bin/kadans.mjs status` and `node bin/kadans.mjs agents` print the same data.

## Uninstall

```sh
node bin/kadans.mjs uninstall            # preview
node bin/kadans.mjs uninstall --apply    # remove the hooks, restore your old status line, back up first
node bin/kadans.mjs kickoff unschedule --apply   # only if you scheduled kickoff
rm -rf ~/Applications/Kadans.app ~/.kadans   # optional: the app and everything Kadans stored
```

## How the brake and throttle work

Kadans keeps a short history of your usage and draws a needle from the last 15 minutes. From that it projects where
each window will be at its reset.

1. **Gauge.** Reading only. This is all you need.
2. **Brake.** If your pace would use up a window before it resets, Kadans denies *new* sub-agents and workflows and
   tells Claude why. Work already running keeps going. A task you marked urgent is let through, and so is a session
   started with `KADANS_ALLOW=1`.
3. **Throttle.** If a good part of a window would go unused, Kadans can give a session the next task you approved, up to
   three per session per window, and never in the last 15 minutes. It is off by default. It needs both an account opt-in
   (`"accounts": { "<key>": { "gas": true } }` in `config.json`; `kadans status` shows the key) and
   `KADANS_THROTTLE=1` in that session. It only ever uses tasks you approved.
4. **Auto-pace.** An optional switch in the panel. When usage runs hot it adds a note asking the agent to read less and
   skip sub-agents. If the brake holds for 10 minutes it slows that session for 15 minutes at a time, and lifts the
   slowdown when the pace is fine again, when a new window starts, or when you switch Auto-pace off. Anything you
   slowed or paused yourself is never touched.

Slow, pause and Auto-pace work on sessions that have a Claude session id and run under the account where Kadans is
installed. Other accounts are shown but never paced or throttled.

## Start the next window for me (kickoff)

The 5-hour window starts with your first message after the last one ended. If you would rather have it start at a time
you choose, `kadans kickoff` sends Claude one tiny message (`claude -p "Reply with the single word OK." --model haiku`)
in an empty temp folder, on your own account only. It does nothing unless all of these hold: you turned it on
(`kadans config set kickoff.enabled true`, or the switch in Settings), it is between `kickoff.from` and `kickoff.to`
(default 07:00-23:00, local time), and your last window has ended. `kadans kickoff --dry-run` shows what it would do.

To have it checked every 15 minutes, add a macOS job once (the app never does this for you):

```sh
node bin/kadans.mjs kickoff schedule            # preview the job and the launchctl commands
node bin/kadans.mjs kickoff schedule --apply    # write ~/Library/LaunchAgents/dev.kadans.kickoff.plist and load it
node bin/kadans.mjs kickoff unschedule --apply  # remove it
```

Each kickoff spends a tiny amount of your quota (one short Haiku reply).

## Privacy

- No network calls of its own. Kadans has no server and sends nothing anywhere. The one exception is kickoff (off by
  default): it runs `claude`, which talks to Anthropic as it always does.
- Official data only: the usage numbers Claude Code already passes to its status line. No scraping, no extra API calls.
- No account, sign-in, API key or tracking.
- Everything it stores is in `~/.kadans`. Usage samples are kept 8 days and the event log 2 days.
- It also reads session transcripts under `~/.claude/projects` (read-only) for token counts, the model and titles.

The full list of what is read and written is in [SECURITY.md](SECURITY.md).

## FAQ

**Which plans does it work with?** Claude Pro and Max. Claude Code only shares usage data on those plans, and only
after the first reply in a session.

**Will it slow my agents on its own?** Only the brake does, and only for new sub-agents when you would run out early.
Slowing a session by Auto-pace is a switch you turn on. The throttle stays off until you enable it.

**Does it need my API key or login?** No. It reads what Claude Code already passes to the status line on your Mac.

**Can I undo the install?** Yes. `install` shows the changes first and keeps a backup, and `uninstall` removes them.

**Why does the app say it cannot read usage data?** Claude Code sends usage data after the first reply of a session.
Send one message, then press "Check again". If Kadans is not installed yet, the panel says so.

**What about Codex or an iPhone view?** Not now. The Mac menu bar comes first.

**Does it start tasks on its own?** Never without your approval. `Start` and `Replace` open a new Claude Code session in
Terminal.app (or in an Orca worktree if you use Orca), and only for a task you approved.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Changes are listed in
[CHANGELOG.md](CHANGELOG.md).

## Licence

MIT, see [LICENSE](LICENSE). BoardUI Pro components and assets are not part of this repository and are not covered by
this licence.

## Made with BoardUI

The panel's soft look follows BoardUI. The theme is plain CSS variables at the top of `app/web/panel.css`.
