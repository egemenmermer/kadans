# Contributing

Thanks for looking. Kadans is small and meant to stay calm: few features, each easy to explain and to undo.

- Open an issue before a large change, so we can agree on the shape first.
- Needs Node.js 22 or newer. There are no npm dependencies. The macOS app needs the Swift toolchain.
- Run the tests with `node --test`. They use temporary folders and never touch your `~/.claude` or `~/.kadans`, and they
  never start a real Claude Code session. Please keep it that way.
- The panel (`app/web`) is plain HTML, CSS and JavaScript with no build step and no network access. Every colour,
  radius and shadow lives in the theme block at the top of `app/web/panel.css`. To preview it in a browser, open
  `app/web/dev.html` from a local web server.
- Hooks must fail open and stay fast. A hook that errors or hangs slows down Claude Code, so keep the fast path short.
- Anything that changes what is read or written must also change [SECURITY.md](SECURITY.md).
- Writing: plain, calm English. No hype.
