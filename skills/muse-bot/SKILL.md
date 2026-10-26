---
name: muse-bot
description: Drive a personal muse.ai agent (Meta's Muse) from the terminal with the `muse-bot` CLI. Use when asked to message, check or automate someone's Muse agent; to read or manage its chats, side chats, feed, goals, ideas or sessions; or when muse-bot needs installing or a login.
---

# muse-bot

`muse-bot` talks to the user's muse.ai personal agent directly: HTTPS login, then an encrypted
WebSocket to their VM. Every command prints JSON on stdout (`watch` prints one JSON object per
line); diagnostics go to stderr. `muse-bot <command> --help` is the authoritative flag list.

Work top to bottom; stop at the first step that fails and report its stderr.

## 1. Install

```bash
command -v muse-bot || npm i -g muse-bot   # needs Node.js 24+
muse-bot --version
```

## 2. Log in

muse-bot borrows the muse.ai login the user already has in a browser and saves the cookies to
`~/.config/muse-bot/cookies.txt` (mode 600). Any command does this on its own when the jar is
missing or expired; `muse-bot auth export` does it explicitly. It tries, in order:

1. **Google Chrome**, through agent-browser (installed with `npm i -g agent-browser` on first
   need). It connects on port 9222 first, then through `chrome://inspect/#remote-debugging`,
   where Chrome may show an Allow prompt the user must click. A muse.ai tab must be open.
2. **ego lite**, through the `ego-browser` CLI, when the app is installed.

`--browser chrome|ego` picks one. When every browser fails, the error names what each lacked:
ask the user to log in at https://muse.ai/ in that browser, then run `muse-bot auth export`
once. Without a browser, the user can paste cookies (a `hatch_sess=…; …` line, a Netscape jar or
JSON) into `muse-bot auth import` on stdin.

## 3. Verify

```bash
muse-bot status   # VM id, session count, unread, identity
```

## Use

Read freely: `threads`, `history`, `unread`, `feed`, `goals`, `ideas`, `watch`, `status`.

Writes act as the user inside their agent. Announce each one before running it and never loop
it: `send`, `seen`, `feed-react`, `idea-exec`, `session-start` and the other `session-*`
commands, `wake`. `idea-exec` makes the agent do real work.

`raw <method> --body '{…}' [--param k=v]` reaches any gateway method with no named command.

## Gotchas

- Exit codes: 0 ok, 1 error, 2 usage, 3 auth (re-run `muse-bot auth export`).
- In cron or other unattended runs, pass `--no-auto-login` (or set `MUSE_NO_AUTO_LOGIN=1`) so
  an expired login fails with exit 3 instead of touching a browser or installing anything.
- `send` waits up to `--wait` seconds (default 90) for the reply; a result without `reply` means
  the agent was slower, and the message still landed: check `history`. `--wait 0` returns at once.
- `history` and `send` without `--thread` use the main chat.
- `idea-exec --thread` is not honored by current servers: the idea runs in the main chat, and
  muse-bot prints a warning saying so.
- `threads` hides archived sessions; `threads --all` includes them.
