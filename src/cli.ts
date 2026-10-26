#!/usr/bin/env node
// muse-bot: JSON on stdout, diagnostics on stderr (DECISIONS.md Q3).
import { readFileSync } from "node:fs";
import { Command, CommanderError } from "commander";
import {
  autoLoginAllowed,
  type Browser,
  borrowLogin,
  cookiesPath,
  importCookies,
  loadCookies,
} from "./auth.ts";
import { AuthError, Gateway, GatewayError, ROUTES } from "./gateway.ts";

const EXIT = { error: 1, usage: 2, auth: 3 } as const;

const program = new Command("muse-bot")
  .description("CLI for your personal muse.ai agent")
  .version(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version)
  .option("--no-auto-login", "never read a browser login or install agent-browser")
  .exitOverride();

const out = (obj: unknown): void => {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
};

// Connects with the saved cookies. On expired auth, borrows a fresh browser login once
// and retries (DECISIONS.md Q17).
async function withGateway<T>(fn: (gw: Gateway) => Promise<T>): Promise<T> {
  const auto = autoLoginAllowed(program.opts().autoLogin);
  let retried = false;
  for (;;) {
    const cookies = await loadCookies(auto);
    let gw: Gateway;
    try {
      gw = await Gateway.connect(cookies, process.env.MUSE_VM_ID);
    } catch (e) {
      if (e instanceof AuthError && auto && !retried) {
        retried = true;
        process.stderr.write(`${e.message}\nre-reading the browser login…\n`);
        await borrowLogin();
        continue;
      }
      throw e;
    }
    try {
      return await fn(gw);
    } finally {
      gw.close();
    }
  }
}

const json = (value: string) => {
  try {
    return JSON.parse(value);
  } catch {
    throw new CommanderError(EXIT.usage, "muse-bot.badJson", `not valid JSON: ${value}`);
  }
};

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
  .command("raw <method>")
  .description(`call any gateway method (escape hatch; ${ROUTES.size} methods)`)
  .option("--body <json>", "JSON body (query params for GET)", json)
  .option("--path-params <json>", "JSON object of {placeholders} in the route path", json)
  .option("--query <json>", "JSON object of query params", json)
  .option("--list", "print the route table instead of calling")
  .action(
    (
      method: string,
      opts: {
        body?: unknown;
        pathParams?: Record<string, string>;
        query?: Record<string, string>;
        list?: boolean;
      },
    ) => {
      if (opts.list) return out([...ROUTES.values()].filter((r) => r.method.includes(method)));
      return withGateway(async (gw) =>
        out(
          await gw.callJson(method, {
            body: opts.body,
            pathParams: opts.pathParams,
            query: opts.query,
          }),
        ),
      );
    },
  );

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
