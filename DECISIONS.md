<!-- AI-maintained, append-only -->

# Decisions

## Q1 — interactive/cli-design — tradeoff

**Question:** Port nikships/muse-cli to TypeScript, or re-derive the muse.ai gateway protocol from scratch?
**Options considered:** port (reuse its PROTOCOL.md, routes.json, protobuf descriptors; MIT, credited) / re-derive from the Muse.app or web bundle
**Chosen:** Port it.
**Decided-by:** human
**Justification:** The reference protocol work is already verified live; re-deriving costs days for the same result.
**Outcome:** applied
**Ref:** (pending)

## Q2 — interactive/cli-design — tradeoff

**Question:** Which JS runtime does the CLI target?
**Options considered:** Node 24 LTS (ESM, built with tsup) / Bun (native TS, single-binary compile) / Deno
**Chosen:** Node 24 LTS, ESM, built with tsup.
**Decided-by:** human
**Justification:** The Chrome TLS fingerprint the gateway needs comes from a native addon; those are best proven on Node and unreliable inside Bun compiled binaries.
**Outcome:** applied
**Ref:** (pending)

## Q3 — interactive/cli-design — gate-resolution

**Question:** What is the output contract for commands?
**Options considered:** JSON on stdout + diagnostics on stderr + exit codes / human-readable text
**Chosen:** One JSON document per command on stdout (NDJSON for `watch`), diagnostics on stderr; exit 0 ok, 1 error, 2 usage, plus a dedicated exit code for expired auth.
**Decided-by:** human
**Justification:** Matches the reference; the auth exit code lets cron jobs react to a rotated cookie.
**Outcome:** applied
**Ref:** (pending)

## Q4 — interactive/cli-design — gate-resolution

**Question:** What is the command and npm package name?
**Options considered:** `muse-bot` / `muse-cli` (collides with the Python tool) / `muse` (collides with Muse Code)
**Chosen:** `muse-bot`.
**Decided-by:** human
**Justification:** Matches the repo name and avoids both collisions.
**Outcome:** applied
**Ref:** (pending)

## Q5 — interactive/cli-design — tradeoff

**Question:** How is the CLI tested?
**Options considered:** offline vitest units + opt-in live smoke test / mocked HTTP+gateway server
**Chosen:** vitest offline tests for Noise (test vectors), protobuf framing round-trip and arg parsing; a live smoke test (`status`, `history --limit 1`) gated on `MUSE_LIVE=1`. No mocked server.
**Decided-by:** human
**Justification:** A mock only re-asserts our own assumptions; the protocol is unversioned, so only a live call proves it works.
**Outcome:** applied
**Ref:** (pending)

## Q6 — interactive/cli-design — gate-resolution

**Question:** How does the CLI get muse.ai credentials?
**Options considered:** `auth import` + built-in Chrome CDP export / import only / own OIDC login against auth.muse.ai / reuse Muse.app login
**Chosen:** `auth import` (cookie string, Netscape jar or JSON via stdin or path) and `auth export` (reads Chrome cookies over DevTools protocol with Node's built-in WebSocket, no agent-browser). Jar at `~/.config/muse-bot/cookies.txt`, mode 600; never replace a jar with one lacking `hatch_sess`.
**Decided-by:** human
**Justification:** Muse.app's login is not reusable: the app is a WKWebView wrapper with no on-disk cookie store, and its token sits in Meta's access-group keychain, unreadable by other processes. OIDC login would be a new reverse-engineering job.
**Outcome:** applied
**Ref:** (pending)

## Q7 — interactive/cli-design — gate-resolution

**Question:** What is the v1 command scope?
**Options considered:** core subset + `raw` / full parity with the reference's 27 subcommands + interactive `chat` / full parity including `update`
**Chosen:** Full parity with nikships/muse-cli (all subcommands plus the no-arg interactive `chat`), except `update` and its daily update notice.
**Decided-by:** human
**Justification:** Each command is one gateway route plus a param shape once the client exists; npm (`npm i -g muse-bot@latest`) replaces the self-upgrade.
**Outcome:** applied
**Ref:** (pending)

## Q8 — interactive/cli-design — gate-resolution

**Question:** Which protobuf library encodes the gateway envelopes?
**Options considered:** `@bufbuild/protobuf` v2 with the reference's descriptors / `protobufjs` / hand-written `.proto` + codegen
**Chosen:** `@bufbuild/protobuf` v2, building a registry at runtime from `desc0.bin`/`desc1.bin` copied verbatim from the reference.
**Decided-by:** human
**Justification:** The descriptors were extracted from the app; using them as-is avoids retyping and drift.
**Outcome:** applied
**Ref:** (pending)

## Q9 — interactive/cli-design — gate-resolution

**Question:** Which CLI framework parses commands?
**Options considered:** `commander` / `yargs` / `citty` / `node:util.parseArgs` with hand-written dispatch
**Chosen:** `commander`.
**Decided-by:** human
**Justification:** Avoids owning hand-written dispatch and help text for ~27 commands.
**Outcome:** applied
**Ref:** (pending)

## Q10 — interactive/cli-design — tradeoff

**Question:** Which commands may the automated live suite run?
**Options considered:** read-only commands only / all commands
**Chosen:** `MUSE_LIVE=1` runs read-only commands only (status, threads, history, unread, feed, goals, ideas, `raw` on a read method); write commands (send, seen, feed-react, idea-exec, session-*, wake) are verified by hand once before release.
**Decided-by:** human
**Justification:** Automated tests must never post to the user's agent or delete sessions.
**Outcome:** applied
**Ref:** (pending)

## Q11 — interactive/cli-design — gate-resolution

**Question:** How is the CLI distributed?
**Options considered:** public npm via tag-triggered GitHub Actions with trusted publishing, plus bundled agent skill / GitHub-only
**Chosen:** Publish `muse-bot` to public npm from GitHub Actions on tag (trusted publishing, no stored token); ship `skills/muse-bot/SKILL.md`.
**Decided-by:** human
**Justification:** npm name `muse-bot` was free on 2026-10-25; the skill serves agent-driven automation, a primary use.
**Outcome:** applied
**Ref:** (pending)

## Q12 — interactive/cli-design — deviation

**Question:** How does the CLI obtain cookies when no jar exists, and what reads Chrome's cookies?
**Options considered:** fall back to the Python tool's `~/.config/muse-cli` jar / auto-borrow the Chrome login into `~/.config/muse-bot/cookies.txt` / own CDP client without agent-browser
**Chosen:** When `~/.config/muse-bot/cookies.txt` is missing, borrow the existing Chrome login and save those cookies there; `auth export` reads Chrome's cookies through agent-browser, as the reference does. `auth import` stays as the manual path.
**Decided-by:** human
**Justification:** User direction in round 2; keeps the reference's proven export path and makes first run need no separate login step.
**Outcome:** applied
**Ref:** (pending)
**Supersedes:** Q6 — replaces the own-CDP-client export with agent-browser and adds the automatic export on a missing jar.

## Q13 — interactive/cli-design — gate-resolution

**Question:** What lints and formats the code?
**Options considered:** Biome + `tsc --noEmit` / ESLint + Prettier
**Chosen:** Biome (one `biome.json`) plus `tsc --noEmit` in CI.
**Decided-by:** human
**Justification:** One tool, one config.
**Outcome:** applied
**Ref:** (pending)

## Q14 — interactive/cli-design — tradeoff

**Question:** Does the HTTPS/WebSocket transport need a Chrome TLS fingerprint library?
**Options considered:** built-in `fetch` + `ws` first, `wreq-js` as fallback / `wreq-js` from day one
**Chosen:** Built-in `fetch` + `ws` behind one small transport module, always sending browser `Sec-Fetch-*`, `Origin`, `Referer` and `Accept: application/json`; first milestone is a live authenticated `status`; swap to `wreq-js` if that is reset or gets an unexplained 403.
**Decided-by:** human
**Justification:** Unauthenticated probes on 2026-10-25 got identical app responses from plain Node and from wreq-js; the authenticated path is still unverified.
**Outcome:** applied
**Ref:** (pending)

## Q15 — interactive/cli-design — tradeoff

**Question:** Which library implements Noise_XX_25519_AESGCM_SHA256?
**Options considered:** `@richardhopton/noise-c.wasm` / `@niomon/noise-js` / `@brashkie/signalis-noise` / `@lukeburns/clatterjs` / own implementation on node:crypto
**Chosen:** `@richardhopton/noise-c.wasm`, wrapped in a thin handshake/cipher-state adapter; `@niomon/noise-js` is the pure-TS fallback.
**Decided-by:** human
**Justification:** User asked to reuse an existing library; npm search on 2026-10-25 found noise-c.wasm the most-used package supporting this suite (~3.9k/month), backed by the reference C implementation. ChaChaPoly/BLAKE-only libraries were ruled out.
**Outcome:** applied
**Ref:** (pending)

## Q16 — interactive/cli-design — gate-resolution

**Question:** How does the CLI get agent-browser?
**Options considered:** regular npm dependency / user-installed global prerequisite
**Chosen:** `agent-browser` in `dependencies`, invoked from our own node_modules bin.
**Decided-by:** human
**Justification:** One `npm i -g muse-bot` installs everything, removing the reference's separate install step.
**Outcome:** applied
**Ref:** (pending)

## Q17 — interactive/cli-design — gate-resolution

**Question:** Does the CLI also re-borrow the Chrome login when cookies expire?
**Options considered:** re-export once and retry once / only when the jar is missing
**Chosen:** On an expired-auth response, re-export from Chrome once, save, retry the command once; on failure keep the old jar and exit with the auth exit code. `--no-auto-login` / `MUSE_NO_AUTO_LOGIN=1` disables it.
**Decided-by:** human
**Justification:** Cookie rotation is the common failure; cron jobs that must not touch the browser can opt out.
**Outcome:** applied
**Ref:** (pending)

## Q18 — interactive/cli-design — gate-resolution

**Question:** Where does the CLI keep state and which env vars does it read?
**Options considered:** XDG folder + env vars, no config file / config file
**Chosen:** `${XDG_CONFIG_HOME:-~/.config}/muse-bot/` holding `cookies.txt` and `device-id`; env vars `MUSE_VM_ID`, `MUSE_COOKIES`, `MUSE_NO_AUTO_LOGIN`; no config file.
**Decided-by:** human
**Justification:** `MUSE_VM_ID` keeps the reference's name; flags and env vars cover every setting.
**Outcome:** applied
**Ref:** (pending)

## Q19 — interactive/cli-design — gate-resolution

**Question:** What package manager and source layout does the repo use?
**Options considered:** pnpm + flat src/ mirroring the reference / npm / per-command files
**Chosen:** pnpm; `src/{cli,gateway,transport,auth,chat}.ts`, `src/data/{routes.json,desc0.bin,desc1.bin}`, tests in `test/`.
**Decided-by:** human
**Justification:** Mirrors the reference's file split so the port stays easy to diff against it.
**Outcome:** applied
**Ref:** (pending)

## Q20 — interactive/cli-design — gate-resolution

**Question:** Should `auth export` read the token of a logged-in Muse.app?
**Options considered:** read Muse.app's credential / stay on browser cookie export
**Chosen:** No Muse.app path; `auth export` stays on browser cookie export (Chrome via agent-browser), with ego lite added as a second browser.
**Decided-by:** human
**Justification:** Muse.app keeps its durable credential in the data-protection keychain under Meta's access group and persists no readable cookie (scan of 2026-10-25); any remaining route would need invasive methods.
**Outcome:** applied
**Ref:** (pending)

## Q21 — interactive/cli-design — gate-resolution

**Question:** How does `auth export` read cookies from ego lite?
**Options considered:** spawn `ego-browser nodejs` with a CDP `Storage.getCookies` script / attach agent-browser to an ego CDP port
**Chosen:** Spawn `ego-browser nodejs` with a script calling `task.cdp("Storage.getCookies")`, filtered to muse.ai, default profile, no `--ego-server-name`. Used only when `ego lite.app` exists and `ego-browser` is on PATH; never installed by muse-bot.
**Decided-by:** human
**Justification:** ego lite opens no CDP TCP port (checked 2026-10-25), so agent-browser cannot attach; its CLI is the supported CDP surface.
**Outcome:** applied
**Ref:** (pending)

## Q22 — interactive/cli-design — gate-resolution

**Question:** In what order are browsers tried for cookie export and auto-login?
**Options considered:** Chrome first, then ego lite / ego lite first, then Chrome
**Chosen:** Google Chrome first when `Google Chrome.app` exists, then ego lite when `ego lite.app` exists and `ego-browser` is on PATH; first browser yielding `hatch_sess` wins; a browser with no `hatch_sess` falls through; `--browser chrome|ego` forces one.
**Decided-by:** human
**Justification:** User direction in round 4, overriding the proposed ego-first order.
**Outcome:** applied
**Ref:** (pending)

## Q23 — interactive/cli-design — gate-resolution

**Question:** How does agent-browser connect to Chrome?
**Options considered:** `--cdp 9222` then `--auto-connect` / `--auto-connect` only (reference)
**Chosen:** Try `--cdp 9222` first, fall back to `--auto-connect`.
**Decided-by:** human
**Justification:** The user's Chrome runs from a Dock launcher with CDP on 9222 and connects without a prompt; `--auto-connect` prompts on every connection.
**Outcome:** applied
**Ref:** (pending)

## Q24 — interactive/cli-design — deviation

**Question:** How does muse-bot get agent-browser?
**Options considered:** regular npm dependency / auto-install with `npm i -g agent-browser` on first need
**Chosen:** Not a dependency. When the Chrome step finds no `agent-browser` on PATH, run `npm i -g agent-browser` without prompting (one stderr line), wait, then continue; on failure print npm's error and the fix and skip Chrome. Never installs under `--no-auto-login` / `MUSE_NO_AUTO_LOGIN=1`, nor for ego lite.
**Decided-by:** human
**Justification:** User direction; keeps the muse-bot install lean and installs only for users who need Chrome export.
**Outcome:** applied
**Ref:** (pending)
**Supersedes:** Q16 — agent-browser moves from a bundled dependency to an on-demand global install.

## Q25 — impl/noise — deviation

**Question:** Which noise-c.wasm package provides the Noise suite?
**Options considered:** `@richardhopton/noise-c.wasm` 0.5.0 / upstream `noise-c.wasm` 0.4.0 / `@niomon/noise-js`
**Chosen:** Upstream `noise-c.wasm` 0.4.0 (nazar-pc), loaded with `wasmBinary` from disk.
**Decided-by:** agent
**Justification:** A local handshake test on 2026-10-25 showed the richardhopton build is ESPHome's trimmed fork and rejects `Noise_XX_25519_AESGCM_SHA256` with NOISE_ERROR_UNKNOWN_NAME; the upstream build completes an XX handshake and AESGCM round-trip with it. Same C library and API, so the human's choice of noise-c stands.
**Outcome:** applied
**Ref:** (pending)
**Supersedes:** Q15 — the chosen package lacks the required cipher; swapped to its upstream.

## Q26 — impl/transport — gate-resolution

**Question:** Is a Chrome TLS fingerprint library needed for the authenticated path?
**Options considered:** keep built-in `fetch` + `ws` / switch the transport module to `wreq-js`
**Chosen:** Keep built-in `fetch` + `ws`; `wreq-js` is not added.
**Decided-by:** agent
**Justification:** On 2026-10-25 a live read-only `muse-bot status` with cookies borrowed from ego lite completed api/session, auth/check, hatch/token, the WebSocket upgrade to hatch.metaaivm.com, the Noise XX handshake and three gateway calls with plain Node 24 — the condition Q14 set for staying plain.
**Outcome:** applied
**Ref:** (pending)

## Q27 — impl/idea-exec — deviation

**Question:** How should `idea-exec --thread` behave, given the server runs ideas in the main chat?
**Options considered:** keep sending session_id and warn when ignored / drop `--thread` / keep the reference's silent behavior
**Chosen:** Send the body the web client builds (`{mode, session_id?}`, path params stripped) and print a stderr warning when the response has no `chat.session_id` matching `--thread`.
**Decided-by:** agent
**Justification:** On 2026-10-25 three live runs (reference body, client body, client body plus x-app-id/Accept-Language headers) all ran in the main chat; the response never carried the `chat` object the Muse.app 8.0 client reads for a thread run, so this VM's server ignores session_id. Keeping the flag stays correct once the server supports it; the warning stops it failing silently.
**Outcome:** applied
**Ref:** (pending)

## Q28 — impl/session-start — deviation

**Question:** How should `session-start --title` name the new side chat, given the server drops the title?
**Options considered:** keep the reference's `params.title` / start the chat, then call `session.rename` / drop `--title`
**Chosen:** Start the chat without a title, then call `session.rename {session_id, title}`; the output carries the title.
**Decided-by:** agent
**Justification:** On 2026-10-26 a chat started with the reference's `params.title` listed `title: null` in both the active and archived views, and gained its title only after `session.rename`. The Muse.app 8.0 client never calls `session.start`, so there is no client body to copy; `session.rename` is the call it uses to name side chats.
**Outcome:** applied
**Ref:** (pending)
