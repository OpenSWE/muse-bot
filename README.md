# muse-bot

A command-line client for your personal [muse.ai](https://muse.ai) agent. Muse ships only a
macOS app and a web app; muse-bot gives you a scriptable terminal instead. You can chat, read
and manage side chats, the feed, goals, ideas and sessions, and call any of the 258 gateway
methods.

- **JSON everywhere.** Every command prints JSON on stdout, so it pipes into `jq`, cron jobs
  and other agents. Diagnostics go to stderr.
- **No extra login.** It borrows the muse.ai login you already have in Google Chrome or
  ego lite.
- **Agent-ready.** `skills/muse-bot/SKILL.md` teaches coding agents to drive it.

muse-bot is a TypeScript port of [nikships/muse-cli](https://github.com/nikships/muse-cli)
(Python, MIT). That project reverse-engineered the protocol: see its
[docs/PROTOCOL.md](https://github.com/nikships/muse-cli/blob/main/docs/PROTOCOL.md).

## Install

```bash
npm i -g muse-bot     # Node.js 24 or newer
npx skills add OpenSWE/muse-bot    # optional: the agent skill, for coding agents
```

## Log in

Log in at https://muse.ai/ in Google Chrome or ego lite, then run any command. When
`~/.config/muse-bot/cookies.txt` is missing or expired, muse-bot copies the muse.ai cookies
out of the browser and saves them there (mode 600). To do it explicitly:

```bash
muse-bot auth export                  # Chrome first, then ego lite
muse-bot auth export --browser ego    # one browser only
```

- **Google Chrome** is read through [agent-browser](https://github.com/vercel-labs/agent-browser).
  muse-bot installs it with `npm i -g agent-browser` the first time it is needed. Keep a muse.ai
  tab open. muse-bot connects on port 9222 when Chrome runs with
  `--remote-debugging-port=9222`. Otherwise turn on remote debugging at
  `chrome://inspect/#remote-debugging` and click Allow when Chrome asks.
- **ego lite** is read through its `ego-browser` CLI, when the app is installed.

Without a browser, paste the cookies from DevTools (Application → Cookies → `https://muse.ai`).
`hatch_sess` is required:

```bash
printf '%s\n' 'hatch_sess=VALUE; other=VALUE' | muse-bot auth import
```

## Usage

```bash
muse-bot                                         # interactive chat (type /help inside)
muse-bot status                                  # VM, session count, unread, identity
muse-bot threads [--all]                         # main chat and side chats
muse-bot history --limit 5 [--thread <id>]       # recent messages
muse-bot send "summarize my unread" --wait 120   # send and wait for the reply
muse-bot watch --timeout 60                      # live events, one JSON object per line
muse-bot feed --limit 5
muse-bot goals
muse-bot ideas
muse-bot idea-exec <idea-id>                     # the agent acts on the idea
muse-bot session-start --title "trip planning"   # also session-rename, -pin, -unpin,
                                                 # -archive, -unarchive, -delete
muse-bot raw <method> --body '{}' --param k=v    # any gateway method
```

`muse-bot --help` lists every command, and `muse-bot <command> --help` lists its flags.

```bash
muse-bot send "what's on my calendar today?" | jq -r .reply.text
```

### Exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | error (gateway, network) |
| 2 | usage |
| 3 | auth: the login is missing or expired |

### Environment

| Variable | Effect |
|---|---|
| `MUSE_NO_AUTO_LOGIN=1` | never read a browser or install agent-browser (same as `--no-auto-login`); use it in cron |
| `MUSE_COOKIES` | cookie jar path (default `~/.config/muse-bot/cookies.txt`) |
| `MUSE_VM_ID` | skip VM discovery |
| `XDG_CONFIG_HOME` | moves the config folder |

## Known limits

- `idea-exec --thread` is ignored by the current server: the idea runs in the main chat, and
  muse-bot warns about it.
- muse.ai's gateway API is internal and unversioned. When whole groups of calls start failing,
  the protocol has drifted.
- Respect muse.ai's terms and rate limits. Write commands act as you inside your agent.

## Development

```bash
pnpm install
pnpm dev status          # run from source (Node 24 strips the types)
pnpm test                # offline tests
MUSE_LIVE=1 pnpm test    # also read-only checks against your account
pnpm typecheck && pnpm lint && pnpm build
```

Design decisions and their reasons are in [DECISIONS.md](DECISIONS.md).

## License

MIT.
