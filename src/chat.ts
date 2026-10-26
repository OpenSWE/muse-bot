// Chat helpers shared by `send`, and the interactive chat (`muse-bot chat`, or bare
// `muse-bot`). Plain line-by-line text so it reads well with a screen reader.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { borrowLogin, configDir, connect, deviceId } from "./auth.ts";
import { AuthError, type Gateway } from "./gateway.ts";

// biome-ignore lint/suspicious/noExplicitAny: chat events are untyped server JSON.
export type ChatEvent = Record<string, any>;

const payloadOf = (e: ChatEvent): ChatEvent =>
  e.payload && typeof e.payload === "object" ? e.payload : {};

export function fmtEvent(e: ChatEvent) {
  const p = payloadOf(e);
  return {
    seq: e.seq,
    role: p.role ?? e.event_name,
    message_id: p.message_id ?? e.message_id,
    text: p.display_text || p.content || "",
  };
}

// A genuine assistant reply: history marks proactive pushes (Telegram drafts, background
// task updates) with a reply_to_message_id, and a reply still being written has no status.
export function isReply(e: ChatEvent, after: number): boolean {
  const p = payloadOf(e);
  return (
    e.event_name === "message.assistant" &&
    (e.seq ?? 0) > after &&
    !(e.reply_to_message_id || p.reply_to_message_id) &&
    Boolean(p.display_text || p.content) &&
    Boolean(p.status)
  );
}

export async function history(
  gw: Gateway,
  limit: number,
  sessionId?: string | null,
): Promise<ChatEvent[]> {
  const d = (await gw.callJson("chat.history", {
    body: { limit, ...(sessionId ? { session_id: sessionId } : {}) },
  })) as { chat_events?: ChatEvent[] };
  return (d.chat_events ?? []).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

export async function lastSeq(gw: Gateway, sessionId?: string | null): Promise<number> {
  try {
    return (await history(gw, 1, sessionId)).at(-1)?.seq ?? 0;
  } catch {
    return 0;
  }
}

// Fires chat.stream and returns its stream id. Replies are read by polling history:
// threaded replies never arrive as live events (docs/PROTOCOL.md in the reference).
export function sendMessage(gw: Gateway, text: string, sessionId?: string | null): number {
  return gw.open("chat.stream", {
    body: {
      items: [{ type: "text", text }],
      node_id: deviceId(),
      capabilities: {},
      ...(sessionId ? { session_id: sessionId } : {}),
    },
  });
}

// --- interactive chat ----------------------------------------------------------------

const WAIT = 300; // seconds to wait for the first reply
const QUIET = 10; // seconds of silence after a reply before taking the next message
const POLL = 1; // seconds between history reads while waiting
const STATE = () => join(configDir(), "chat.json");

const HELP = `Commands:
  /chats          list your conversations
  /open N         switch to conversation number N from /chats
  /main           switch to your main chat
  /new [title]    start a new conversation
  /history [N]    read the last N messages here (default 10)
  /login          save your muse.ai login from the browser again (same as \`muse-bot auth export\`)
  /exit           quit (Ctrl+C works too)`;

interface State {
  session_id: string | null;
  title: string;
}

function loadState(): State {
  try {
    if (existsSync(STATE())) return JSON.parse(readFileSync(STATE(), "utf8"));
  } catch {}
  return { session_id: null, title: "main chat" };
}

export const formatTime = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

class Chat {
  gw: Gateway;
  st = loadState();
  listing: ChatEvent[] = [];
  autoLogin: boolean;

  constructor(gw: Gateway, autoLogin: boolean) {
    this.gw = gw;
    this.autoLogin = autoLogin;
  }

  async showHistory(n = 10) {
    const msgs = (await history(this.gw, n * 3, this.st.session_id))
      .filter(
        (e) => ["message.user", "message.assistant"].includes(e.event_name) && fmtEvent(e).text,
      )
      .slice(-n);
    if (!msgs.length) console.log("No messages here yet.");
    for (const e of msgs) {
      console.log(`\n${e.event_name === "message.user" ? "You" : "Muse"}: ${fmtEvent(e).text}`);
    }
  }

  async send(text: string) {
    let seen = await lastSeq(this.gw, this.st.session_id);
    sendMessage(this.gw, text, this.st.session_id);
    console.log("Muse is thinking...");
    let deadline = Date.now() + WAIT * 1000;
    let gotAny = false;
    while (Date.now() < deadline) {
      await sleep(POLL * 1000);
      let replies: ChatEvent[];
      try {
        replies = (await history(this.gw, 15, this.st.session_id)).filter((e) => isReply(e, seen));
      } catch (e) {
        if (e instanceof AuthError) throw e;
        continue;
      }
      for (const e of replies) {
        console.log(`\nMuse: ${fmtEvent(e).text}`);
        seen = e.seq;
      }
      if (replies.length) {
        gotAny = true;
        // Keep listening briefly: the agent often sends follow-ups.
        deadline = Date.now() + QUIET * 1000;
      }
    }
    if (!gotAny) console.log(`(No reply within ${WAIT} seconds. Type /history later to check.)`);
  }

  async listChats() {
    const d = (await this.gw.callJson("sessions.list")) as { sessions?: ChatEvent[] };
    this.listing = (d.sessions ?? []).filter((s) => !s.archived);
    this.listing.forEach((s, i) => {
      const main = s.is_thread ? "" : " (main chat)";
      console.log(
        `${i + 1}. ${s.title || "untitled"}${main}, updated ${formatTime(s.updated_at_ms ?? 0)}`,
      );
    });
    console.log("Type /open and a number to switch.");
  }

  async switchTo(sessionId: string | null, title: string) {
    this.st = { session_id: sessionId, title };
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(STATE(), JSON.stringify(this.st, null, 2));
    console.log(`Now in: ${title}`);
    await this.showHistory(3);
  }

  async openChat(arg: string) {
    if (!this.listing.length) return this.listChats();
    const n = Number.parseInt(arg, 10);
    if (Number.isNaN(n)) return console.log("Type /open and a number from /chats.");
    const s = this.listing[n - 1];
    if (!s) return console.log("No conversation with that number. Type /chats to see them.");
    await this.switchTo(s.session_id, s.title || "untitled");
  }

  async newChat(title: string) {
    const d = (await this.gw.callJson("session.start", {
      body: {
        method: "/api/session/start",
        params: { origin: "fresh", lifecycle: "persistent", ...(title ? { title } : {}) },
      },
    })) as ChatEvent;
    await this.switchTo(d.session_id ?? d.id, title || "new conversation");
  }

  async reconnect() {
    this.gw.close();
    this.gw = await connect(this.autoLogin);
  }

  async handle(line: string) {
    const [cmd, ...rest] = line.split(" ");
    const arg = rest.join(" ").trim();
    if (cmd === "/help" || cmd === "/?") console.log(HELP);
    else if (cmd === "/chats") await this.listChats();
    else if (cmd === "/open") await this.openChat(arg);
    else if (cmd === "/main") await this.switchTo(null, "main chat");
    else if (cmd === "/new") await this.newChat(arg);
    else if (cmd === "/history") await this.showHistory(/^\d+$/.test(arg) ? Number(arg) : 10);
    else if (cmd === "/login") {
      try {
        await borrowLogin();
        await this.reconnect();
        console.log("Signed in.");
      } catch (e) {
        console.log((e as Error).message);
      }
    } else console.log("Unknown command. Type /help.");
  }
}

export async function runChat(autoLogin: boolean): Promise<void> {
  const chat = new Chat(await connect(autoLogin), autoLogin);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "\nYou: " });
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  rl.on("SIGINT", () => rl.close());
  // The iterator queues lines that arrive while a reply is pending (piped input).
  const lines = rl[Symbol.asyncIterator]();
  console.log(`Muse chat, in: ${chat.st.title}. Type /help for commands, /exit to quit.`);
  try {
    await chat.showHistory(3);
    for (;;) {
      if (!closed) rl.prompt(); // piped stdin can hit EOF while lines are still queued
      const next = await lines.next();
      if (next.done) break; // EOF or Ctrl+C
      const line = next.value.trim();
      if (!line) continue;
      if (["/exit", "/quit", "exit", "quit"].includes(line.toLowerCase())) break;
      try {
        await (line.startsWith("/") ? chat.handle(line) : chat.send(line));
      } catch (e) {
        if (e instanceof AuthError) {
          console.log("Your login expired. Type /login to sign in again.");
          continue;
        }
        // A dropped connection: reconnect so the next try works.
        console.log(
          `Connection problem (${(e as Error).message}). Reconnecting; please try again.`,
        );
        await chat.reconnect().catch((e2) => console.log(`Still can't connect: ${e2.message}`));
      }
    }
  } finally {
    rl.close();
    chat.gw.close();
  }
  console.log("\nBye.");
}
