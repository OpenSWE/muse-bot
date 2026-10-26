// Cookie jar and browser login borrowing (DECISIONS.md Q12, Q17, Q18, Q21–Q24).
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { AuthError } from "./gateway.ts";

const run = promisify(execFile);

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  expires?: number;
}

export type Browser = "chrome" | "ego";

export const configDir = () =>
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "muse-bot");
export const cookiesPath = () => process.env.MUSE_COOKIES || join(configDir(), "cookies.txt");

const isMuse = (domain: string) => /(^|\.)muse\.ai$/.test(domain);
const log = (msg: string) => process.stderr.write(`${msg}\n`);

// Accepts a `a=b; c=d` header line, a Netscape jar, or JSON ({name: value} or {cookies: {...}}).
export function parseCookies(raw: string): [string, string][] {
  const text = raw.trim();
  if (text.startsWith("{")) {
    try {
      const d = JSON.parse(text);
      const obj = d && typeof d.cookies === "object" && !Array.isArray(d.cookies) ? d.cookies : d;
      return Object.entries(obj).map(([k, v]) => [k, String(v)]);
    } catch {}
  }
  const lines = text.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const jarRows = lines.map((l) => l.split("\t")).filter((cols) => cols.length >= 7);
  if (jarRows.length) return jarRows.map((cols) => [cols[5], cols[6].trim()]);
  return lines
    .join("; ")
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.includes("="))
    .map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    });
}

export const cookieHeader = (pairs: [string, string][]) =>
  pairs.map(([k, v]) => `${k}=${v}`).join("; ");

// Writes a Netscape jar (mode 600), keeping the previous one as .bak. Refuses a
// logged-out jar so a working login is never replaced by one without hatch_sess.
export function saveJar(cookies: Cookie[], path = cookiesPath()): void {
  if (!cookies.some((c) => c.name === "hatch_sess")) {
    throw new AuthError(
      `no hatch_sess cookie: log in at https://muse.ai/ first. Left ${path} unchanged.`,
    );
  }
  const rows = cookies.map((c) =>
    [
      c.domain,
      c.domain.startsWith(".") ? "TRUE" : "FALSE",
      c.path ?? "/",
      c.secure ? "TRUE" : "FALSE",
      String(Math.max(0, Math.trunc(c.expires ?? 0))),
      c.name,
      c.value,
    ].join("\t"),
  );
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) renameSync(path, `${path}.bak`);
  writeFileSync(path, `# Netscape HTTP Cookie File\n${rows.join("\n")}\n`, { mode: 0o600 });
}

export function importCookies(raw: string, path = cookiesPath()): number {
  const pairs = parseCookies(raw);
  saveJar(
    pairs.map(([name, value]) => ({ name, value, domain: ".muse.ai", secure: true })),
    path,
  );
  return pairs.length;
}

function appExists(name: string): boolean {
  return [join("/Applications", name), join(homedir(), "Applications", name)].some(existsSync);
}

async function onPath(cmd: string): Promise<boolean> {
  try {
    await run("/usr/bin/which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

// --- Google Chrome through agent-browser ---------------------------------------------

async function ensureAgentBrowser(): Promise<void> {
  if (await onPath("agent-browser")) return;
  log("installing agent-browser (one-time)…");
  try {
    await run("npm", ["i", "-g", "agent-browser"], { timeout: 300_000 });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new AuthError(
      `could not install agent-browser: ${(err.stderr || err.message).trim().slice(-400)}\n` +
        "Fix: set an npm prefix you own (https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally), " +
        "or run `npm i -g agent-browser` yourself, then retry.",
    );
  }
}

// agent-browser prints a JSON envelope, sometimes after a warning line; failures are
// {"success": false, "error": ...} with exit 0 or non-zero depending on the version.
async function agentBrowser(args: string[]): Promise<unknown> {
  let stdout = "";
  let stderr = "";
  let code = 0;
  try {
    ({ stdout, stderr } = await run("agent-browser", ["--session", "muse-bot", ...args, "--json"], {
      timeout: 60_000,
    }));
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number; message: string };
    ({ stdout = "", stderr = "" } = err);
    code = typeof err.code === "number" ? err.code : 1;
    if (!stdout && !stderr) stderr = err.message;
  }
  for (const text of [stdout, stderr]) {
    for (const line of [text.trim(), ...text.trim().split("\n").reverse()]) {
      if (!line.startsWith("{")) continue;
      try {
        const doc = JSON.parse(line);
        if (doc.success === false)
          throw new Error(String(doc.error ?? "unknown error").slice(0, 400));
        return doc.data ?? doc;
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
      }
    }
  }
  if (code !== 0) throw new Error((stderr || stdout).trim().slice(0, 400) || `exit ${code}`);
  return {};
}

const listOf = (d: unknown, key: string): Record<string, unknown>[] => {
  if (Array.isArray(d)) return d;
  const v = (d as Record<string, unknown> | undefined)?.[key];
  return Array.isArray(v) ? v : [];
};

async function chromeCookies(): Promise<Cookie[]> {
  await ensureAgentBrowser();
  try {
    return await readChromeCookies();
  } finally {
    // Stops this session's daemon and drops its CDP link; Chrome and its tabs stay open.
    await agentBrowser(["close"]).catch(() => {});
  }
}

async function readChromeCookies(): Promise<Cookie[]> {
  // Port 9222 is the Dock-launcher Chrome and never prompts; --auto-connect is the
  // chrome://inspect route, which asks for Allow.
  const errors: string[] = [];
  for (const connect of [
    ["--cdp", "9222"],
    ["--headed", "--auto-connect"],
  ]) {
    try {
      // Cookies follow the active tab, so focus a muse.ai tab first.
      const tabs = listOf(await agentBrowser([...connect, "tab", "list"]), "tabs");
      const tab = tabs.find((t) => String(t.url ?? "").includes("muse.ai"));
      const id = tab && (tab.id ?? tab.tabId ?? tab.targetId);
      if (!id) throw new Error("no muse.ai tab open in Chrome: open https://muse.ai/ and log in");
      await agentBrowser([...connect, "tab", String(id)]);
      const raw = listOf(await agentBrowser([...connect, "cookies", "get"]), "cookies");
      return raw
        .map((c) => ({
          name: String(c.name),
          value: String(c.value),
          domain: String(c.domain ?? ""),
          path: c.path as string | undefined,
          secure: Boolean(c.secure),
          expires: Number(c.expires ?? 0),
        }))
        .filter((c) => isMuse(c.domain));
    } catch (e) {
      errors.push(`${connect.join(" ")}: ${(e as Error).message}`);
    }
  }
  throw new Error(errors.join("; "));
}

// --- ego lite through its own CLI ----------------------------------------------------

// task.cdp() takes only Target./Browser. commands, so read through the space's blank
// page; Network.getCookies by URL returns httpOnly cookies such as hatch_sess.
const EGO_SCRIPT = `
const task = await taskSpace("muse-bot-cookies");
let out;
try {
  const r = await task.page("p1").cdp("Network.getCookies", { urls: ["https://muse.ai/"] });
  out = { cookies: r.cookies || [] };
} catch (e) {
  out = { error: String((e && e.message) || e).slice(0, 400) };
}
console.log("MUSE_BOT_COOKIES " + JSON.stringify(out));
await task.finish({ keep: [] }).catch(() => {});
`;

async function egoCookies(): Promise<Cookie[]> {
  const child = execFile("ego-browser", ["nodejs"], { timeout: 120_000 });
  child.stdin?.end(EGO_SCRIPT);
  let output = "";
  child.stdout?.on("data", (d) => (output += d));
  // ego prints console.log to stderr when stdout is not a terminal.
  child.stderr?.on("data", (d) => (output += d));
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", () => resolve());
  });
  const line = output.split("\n").find((l) => l.startsWith("MUSE_BOT_COOKIES "));
  if (!line) throw new Error(`ego-browser gave no answer: ${output.trim().slice(-300)}`);
  const doc = JSON.parse(line.slice("MUSE_BOT_COOKIES ".length));
  if (doc.error) throw new Error(doc.error);
  return (doc.cookies as Record<string, unknown>[])
    .map((c) => ({
      name: String(c.name),
      value: String(c.value),
      domain: String(c.domain),
      path: String(c.path ?? "/"),
      secure: Boolean(c.secure),
      expires: Number(c.expires ?? 0),
    }))
    .filter((c) => isMuse(c.domain));
}

// --- borrowing a login ---------------------------------------------------------------

async function available(browser: Browser): Promise<string | undefined> {
  if (browser === "chrome")
    return appExists("Google Chrome.app") ? undefined : "Google Chrome.app not found";
  if (!appExists("ego lite.app")) return "ego lite.app not found";
  return (await onPath("ego-browser")) ? undefined : "ego-browser CLI not on PATH";
}

// Tries Chrome, then ego lite (or just `only`); the first with hatch_sess wins and is saved.
export async function borrowLogin(only?: Browser): Promise<{ browser: Browser; count: number }> {
  const reasons: string[] = [];
  for (const browser of only ? [only] : (["chrome", "ego"] as Browser[])) {
    const missing = await available(browser);
    if (missing) {
      reasons.push(`${browser}: ${missing}`);
      continue;
    }
    log(`reading muse.ai cookies from ${browser === "chrome" ? "Google Chrome" : "ego lite"}…`);
    try {
      const cookies = await (browser === "chrome" ? chromeCookies() : egoCookies());
      if (!cookies.some((c) => c.name === "hatch_sess")) {
        reasons.push(`${browser}: not logged in to muse.ai (no hatch_sess)`);
        continue;
      }
      saveJar(cookies);
      log(`saved ${cookies.length} muse.ai cookies to ${cookiesPath()}`);
      return { browser, count: cookies.length };
    } catch (e) {
      reasons.push(`${browser}: ${(e as Error).message}`);
    }
  }
  throw new AuthError(
    `could not borrow a muse.ai login.\n  ${reasons.join("\n  ")}\n` +
      "Log in at https://muse.ai/ in Chrome or ego lite, or use `muse-bot auth import`.",
  );
}

export const autoLoginAllowed = (flag: boolean) => flag && !process.env.MUSE_NO_AUTO_LOGIN;

// The Cookie header for the gateway, borrowing a browser login when the jar is missing.
export async function loadCookies(autoLogin: boolean): Promise<string> {
  const path = cookiesPath();
  if (!existsSync(path)) {
    if (!autoLogin) throw new AuthError(`no cookies at ${path}; run \`muse-bot auth export\``);
    await borrowLogin();
  }
  const pairs = parseCookies(readFileSync(path, "utf8"));
  if (!pairs.length)
    throw new AuthError(`cookies file ${path} is empty; run \`muse-bot auth export\``);
  return cookieHeader(pairs);
}
