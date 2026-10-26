#!/usr/bin/env node
// muse-bot: JSON on stdout (NDJSON for `watch`), diagnostics on stderr (DECISIONS.md Q3).
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import pkg from "../package.json" with { type: "json" };
import {
  autoLoginAllowed,
  type Browser,
  borrowLogin,
  connect,
  cookiesPath,
  importCookies,
  loadCookies,
} from "./auth.ts";
import {
  type ChatEvent,
  fmtEvent,
  formatTime,
  history,
  isReply,
  lastSeq,
  runChat,
  sendMessage,
} from "./chat.ts";
import {
  AuthError,
  fetchAccessToken,
  fetchSessionInfo,
  type Gateway,
  GatewayError,
  ROUTES,
} from "./gateway.ts";
import { museFetch } from "./transport.ts";

const EXIT = { error: 1, usage: 2, auth: 3 } as const;

const program = new Command("muse-bot")
  .description("CLI for your personal muse.ai agent")
  .version(pkg.version)
  .option("--no-auto-login", "never read a browser login or install agent-browser")
  .exitOverride();

const out = (obj: unknown): void => {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
};

const autoLogin = () => autoLoginAllowed(program.opts().autoLogin);

async function withGateway<T>(fn: (gw: Gateway) => Promise<T>): Promise<T> {
  const gw = await connect(autoLogin());
  try {
    return await fn(gw);
  } finally {
    gw.close();
  }
}

// A command that prints one gateway call's JSON.
const call =
  (method: string, opts: (...args: string[]) => Parameters<Gateway["callJson"]>[1] = () => ({})) =>
  (...args: string[]) =>
    withGateway(async (gw) => out(await gw.callJson(method, opts(...args))));

const toInt = (v: string) => {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n) || n < 0) throw new InvalidArgumentError("expected a whole number");
  return n;
};

// --- auth ----------------------------------------------------------------------------

const auth = program.command("auth").description("auth helpers");

auth
  .command("export")
  .description("save the muse.ai login from Google Chrome or ego lite")
  .option("--browser <name>", "only this browser: chrome or ego")
  .action(async (opts: { browser?: string }) => {
    if (opts.browser && !["chrome", "ego"].includes(opts.browser)) {
      throw new CommanderError(
        EXIT.usage,
        "muse-bot.badBrowser",
        "--browser must be chrome or ego",
      );
    }
    out({ ...(await borrowLogin(opts.browser as Browser | undefined)), path: cookiesPath() });
  });

auth
  .command("import [file]")
  .description("save cookies from a file or stdin (header line, Netscape jar, or JSON)")
  .action((file?: string) => {
    const raw = readFileSync(file && file !== "-" ? file : 0, "utf8");
    out({ count: importCookies(raw), path: cookiesPath() });
  });

// --- chat ----------------------------------------------------------------------------

program
  .command("chat", { isDefault: true })
  .description("interactive chat (the default with no command)")
  .action(() => runChat(autoLogin()));

program
  .command("status")
  .description("VM, session count, unread, identity")
  .action(() =>
    withGateway(async (gw) => {
      const sessions = (await gw.callJson("sessions.list")) as { sessions?: unknown[] };
      out({
        vm_id: gw.vmId,
        sessions: sessions.sessions?.length ?? 0,
        unread: await gw.callJson("chat.unread_count"),
        identity: await gw.callJson("identity"),
      });
    }),
  );

program
  .command("threads")
  .description("list chats and side chats")
  .option("--all", "include archived")
  .action((opts: { all?: boolean }) =>
    withGateway(async (gw) => {
      const list = async (query?: Record<string, string | boolean>) =>
        ((await gw.callJson("sessions.list", { query })) as { sessions?: ChatEvent[] }).sessions ??
        [];
      // The default list leaves archived sessions out; the web client asks for them
      // with view=archived.
      const archived = opts.all
        ? await list({ include_peer_sidechats: true, view: "archived" })
        : [];
      const sessions = [...(await list()).filter((s) => !s.archived), ...archived];
      out(
        sessions
          .filter((s, i) => sessions.findIndex((t) => t.session_id === s.session_id) === i)
          .map((s) => ({
            session_id: s.session_id,
            title: s.title,
            thread: s.is_thread,
            pinned: s.pinned,
            archived: s.archived,
            updated: formatTime(s.updated_at_ms ?? 0),
          })),
      );
    }),
  );

program
  .command("history")
  .description("read chat messages")
  .option("--thread <id>", "a side chat's session id")
  .option("--limit <n>", "how many events", toInt, 10)
  .option("--raw", "print the raw history response")
  .action((opts: { thread?: string; limit: number; raw?: boolean }) =>
    withGateway(async (gw) => {
      if (opts.raw) {
        const body = { limit: opts.limit, ...(opts.thread ? { session_id: opts.thread } : {}) };
        return out(await gw.callJson("chat.history", { body }));
      }
      out((await history(gw, opts.limit, opts.thread)).map(fmtEvent).filter((m) => m.text));
    }),
  );

program
  .command("send <text>")
  .description("send the agent a message")
  .option("--thread <id>", "a side chat's session id")
  .option("--wait <seconds>", "seconds to wait for the reply (0 = don't)", toInt, 90)
  .action((text: string, opts: { thread?: string; wait: number }) =>
    withGateway(async (gw) => {
      const baseline = await lastSeq(gw, opts.thread);
      const stream = sendMessage(gw, text, opts.thread);
      if (!opts.wait) {
        return out({
          sent: true,
          stream,
          note: "fire-and-forget; check `muse-bot history` for the reply",
        });
      }
      const deadline = Date.now() + opts.wait * 1000;
      let reply: ReturnType<typeof fmtEvent> | undefined;
      while (!reply && Date.now() < deadline) {
        try {
          const ev = (await history(gw, 10, opts.thread)).find((e) => isReply(e, baseline));
          if (ev) reply = fmtEvent(ev);
        } catch (e) {
          if (!(e instanceof GatewayError)) throw e;
        }
        if (!reply) await sleep(1000);
      }
      out(
        reply
          ? { sent: true, stream, reply }
          : {
              sent: true,
              stream,
              note: `no assistant reply within ${opts.wait}s; check \`muse-bot history\``,
            },
      );
    }),
  );

program
  .command("watch")
  .description("tail live agent events (NDJSON)")
  .option("--timeout <seconds>", "stop after this long, or this long idle", toInt, 60)
  .option("--n <count>", "stop after this many events", toInt, 50)
  .option("--all", "include agent.status events")
  .option("--thread <id>", "a side chat's session id")
  .action((opts: { timeout: number; n: number; all?: boolean; thread?: string }) =>
    withGateway(async (gw) => {
      // Subscribe the way the web client does: capabilities as a list.
      const body = {
        capabilities: ["chat_cancel", "delta_stream"],
        ...(opts.thread ? { session_id: opts.thread } : {}),
      };
      await gw.subscribe("chat.subscribe", {
        body,
        maxRecords: opts.n,
        idleTimeout: opts.timeout,
        overallTimeout: opts.timeout,
        onRecord: (line) => {
          let ev: ChatEvent;
          try {
            ev = JSON.parse(line);
          } catch {
            return;
          }
          const event = ev.event ?? ev.type;
          if (event === "agent.status" && !opts.all) return;
          const p: ChatEvent = ev.payload && typeof ev.payload === "object" ? ev.payload : {};
          const row: ChatEvent = { event, seq: ev.seq };
          for (const k of ["display_text", "content", "text", "activity_text", "status"]) {
            if (p[k]) row[k] = String(p[k]).slice(0, 300);
          }
          process.stdout.write(`${JSON.stringify(row)}\n`);
        },
      });
    }),
  );

program.command("unread").description("unread counts").action(call("chat.unread_count"));

program
  .command("seen <thread>")
  .description("mark a thread seen")
  .action(call("chat.mark_seen", (thread) => ({ pathParams: { thread_id: thread } })));

// --- feed, goals, ideas --------------------------------------------------------------

program
  .command("feed")
  .description("list feed units")
  .option("--limit <n>", "how many units", toInt)
  .option("--raw", "print the raw feed response")
  .action((opts: { limit?: number; raw?: boolean }) =>
    withGateway(async (gw) => {
      const d = (await gw.callJson("feed.list", {
        query: opts.limit ? { limit: opts.limit } : undefined,
      })) as { days?: ChatEvent[] };
      if (opts.raw) return out(d);
      const rows = (d.days ?? []).flatMap((day) =>
        (day.editions ?? []).flatMap((ed: ChatEvent) =>
          (ed.units ?? []).map((u: ChatEvent) => ({
            id: u.unit_id,
            title: u.title,
            date: day.local_date,
            edition: ed.kind,
          })),
        ),
      );
      out(opts.limit ? rows.slice(0, opts.limit) : rows);
    }),
  );

program.command("feed-status").description("feed refresh status").action(call("feed.status"));

program
  .command("feed-react <unit> [reaction]")
  .description("react to a feed unit (default: love)")
  .action(
    call("feed.unit.reaction", (unit, reaction) => ({
      pathParams: { unit_id: unit },
      body: { reaction: reaction || "love" },
    })),
  );

program.command("feed-prompt").description("show feed prompt").action(call("feed.prompt.get"));

program
  .command("goals")
  .description("list goals")
  .action(() =>
    withGateway(async (gw) => {
      const d = (await gw.callJson("goals.list")) as { goals?: ChatEvent[] };
      out(
        (d.goals ?? []).map((g) => ({
          id: g.id ?? g.goal_id,
          title: g.title,
          status: g.status,
          subtitle: g.subtitle,
        })),
      );
    }),
  );

program
  .command("goal <id>")
  .description("show one goal")
  .action(call("goals.get", (id) => ({ pathParams: { id } })));

program
  .command("ideas")
  .description("list idea cards")
  .action(() =>
    withGateway(async (gw) => {
      const d = (await gw.callJson("api.idea-cards.list")) as { sections?: ChatEvent[] };
      out(
        (d.sections ?? []).flatMap((s) =>
          (s.cards ?? s.ideas ?? []).map((c: ChatEvent) => ({
            id: c.id ?? c.ideaCardId,
            title: c.title,
            section: s.title,
          })),
        ),
      );
    }),
  );

program
  .command("idea <id>")
  .description("show one idea")
  .action(call("api.idea-cards.detail", (id) => ({ pathParams: { ideaCardId: id } })));

program
  .command("idea-exec <id>")
  .description("execute an idea (agent acts on it)")
  .option("--thread <id>", "run it in this side chat, where the server supports it")
  .action((id: string, opts: { thread?: string }) =>
    withGateway(async (gw) => {
      // Body as the web client builds it: path params stripped, session_id optional.
      const r = (await gw.callJson("api.idea-cards.execute", {
        pathParams: { ideaCardId: id },
        body: { mode: "full", ...(opts.thread ? { session_id: opts.thread } : {}) },
      })) as { chat?: { session_id?: string } };
      // A server that honors session_id answers with the chat it used; one that does
      // not (seen 2026-10-25) omits `chat` and runs the idea in the main chat.
      if (opts.thread && r.chat?.session_id !== opts.thread) {
        process.stderr.write("warning: the server ran this idea in the main chat, not --thread\n");
      }
      out(r);
    }),
  );

// --- sessions ------------------------------------------------------------------------

program
  .command("session-start")
  .description("start a new side chat")
  .option("--title <title>", "its title")
  .action((opts: { title?: string }) =>
    withGateway(async (gw) => {
      const started = (await gw.callJson("session.start", {
        body: {
          method: "/api/session/start",
          params: { origin: "fresh", lifecycle: "persistent" },
        },
      })) as { session_id?: string };
      // session.start ignores a title, so name the chat the way the web client renames one.
      if (opts.title && started.session_id)
        await gw.callJson("session.rename", {
          body: { session_id: started.session_id, title: opts.title },
        });
      out(opts.title ? { ...started, title: opts.title } : started);
    }),
  );

program
  .command("session-rename <id> <title>")
  .description("rename a session")
  .action(call("session.rename", (id, title) => ({ body: { session_id: id, title } })));

for (const kind of ["pin", "unpin", "archive", "unarchive", "delete"]) {
  program
    .command(`session-${kind} <id>`)
    .description(`${kind} a session`)
    .action(
      call(`session.${kind}`, (id) => ({
        body: { method: `/api/session/${kind}`, session_id: id },
      })),
    );
}

// --- VM and escape hatch -------------------------------------------------------------

program
  .command("wake")
  .description("request a VM wake")
  .action(async () => {
    const cookies = await loadCookies(autoLogin());
    const accessToken = await fetchAccessToken(cookies);
    const vmId = process.env.MUSE_VM_ID || (await fetchSessionInfo(cookies)).vm_id;
    const r = await museFetch("POST", "/api/hatch/vm/wake", cookies, {
      accessToken,
      body: { vm_id: vmId, retry_count: 0 },
    });
    let body: unknown = r.text || null;
    try {
      body = r.text ? JSON.parse(r.text) : null;
    } catch {}
    out({ status: r.status, body });
  });

program
  .command("raw <method>")
  .description(
    `call any gateway method (escape hatch; ${ROUTES.size} methods in src/data/routes.json)`,
  )
  .option("--body <json>", "JSON body (query params for GET)")
  .option(
    "--param <k=v>",
    "path param (repeatable)",
    (kv: string, all: string[]) => [...all, kv],
    [],
  )
  .option("--timeout <seconds>", "response timeout", toInt, 30)
  .action((method: string, opts: { body?: string; param: string[]; timeout: number }) => {
    const usage = (msg: string) => new CommanderError(EXIT.usage, "muse-bot.raw", msg);
    if (!ROUTES.has(method))
      throw usage(`unknown method '${method}' (${ROUTES.size} known methods)`);
    let body: unknown;
    try {
      body = opts.body ? JSON.parse(opts.body) : undefined;
    } catch {
      throw usage(`invalid --body JSON: ${opts.body}`);
    }
    const pathParams: Record<string, string> = {};
    for (const kv of opts.param) {
      const i = kv.indexOf("=");
      if (i < 0) throw usage(`bad --param '${kv}': expected k=v`);
      pathParams[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return withGateway(async (gw) => {
      const data = Buffer.from(
        await gw.request(method, { body, pathParams, timeout: opts.timeout }),
      );
      try {
        out(data.length ? JSON.parse(data.toString("utf8")) : {});
      } catch {
        process.stdout.write(`${data.toString("utf8")}\n`);
      }
    });
  });

try {
  await program.parseAsync();
} catch (e) {
  if (e instanceof CommanderError) {
    if (e.exitCode !== 0 && !e.code.startsWith("commander."))
      process.stderr.write(`error: ${e.message}\n`);
    process.exitCode = e.exitCode === 0 ? 0 : EXIT.usage;
  } else if (e instanceof AuthError) {
    process.stderr.write(`auth: ${e.message}\n`);
    process.exitCode = EXIT.auth;
  } else {
    process.stderr.write(
      `${e instanceof GatewayError ? "gateway" : "error"}: ${(e as Error).message}\n`,
    );
    process.exitCode = EXIT.error;
  }
}
