// macOS notifications via osascript. Texts travel as argv items of an AppleScript "on run argv" handler, never inside
// the script source and never through a shell, so quotes, backslashes and $(...) in task text stay plain text.
import { spawn } from 'node:child_process';

const SCRIPT = ['on run argv', 'display notification (item 2 of argv) with title (item 1 of argv)', 'end run'];

export function notifyArgs(title, body) {
  const args = [];
  for (const line of SCRIPT) args.push('-e', line);
  args.push('--', String(title), String(body));
  return args;
}

function defaultRun(cmd, args) {
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

// Shows a notification when cfg.notify is true on macOS. Never throws. `run` is injectable for tests.
export function notify(cfg, title, body, { run = defaultRun, platform = process.platform } = {}) {
  if (!cfg || cfg.notify !== true || platform !== 'darwin') return false;
  try {
    run('osascript', notifyArgs(title, body));
    return true;
  } catch {
    return false;
  }
}
