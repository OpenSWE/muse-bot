// Gateway client: HTTPS auth chain, then a Noise-encrypted WebSocket carrying protobuf
// envelopes to the user's personal VM. Ported from nikships/muse-cli gateway.py;
// see its docs/PROTOCOL.md for the protocol and server quirks.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type WebSocket from "ws";
import { handshake, type Session } from "./noise.ts";
import { decodeFrame, encodeRequest, type Frame } from "./proto.ts";
import { museFetch, openSocket } from "./transport.ts";

const GATEWAY_HOST = "hatch.metaaivm.com";
const SERVICE_IDS: Record<string, number> = { daemon: 0, sentinel: 1, vault: 2, authd: 3 };

export interface Route {
  method: string;
  http: string;
  path: string;
  service?: string;
}
export const ROUTES: Map<string, Route> = new Map(
  (JSON.parse(readFileSync(new URL("./data/routes.json", import.meta.url), "utf8")) as Route[]).map(
    (r) => [r.method, r],
  ),
);

// Cookies missing, expired or logged out. The CLI maps this to its auth exit code.
export class AuthError extends Error {}

export class GatewayError extends Error {
  status: number;
  payload: string;
  constructor(status: number, payload: string) {
    super(`gateway status=${status} payload=${payload}`);
    this.status = status;
    this.payload = payload;
  }
}

class Timeout extends Error {}

function parseJson(text: string, what: string): Record<string, unknown> {
  try {
    return JSON.parse(text);
  } catch {
    throw new AuthError(`${what} returned non-JSON (${JSON.stringify(text.slice(0, 80))})`);
  }
}

export async function fetchSessionInfo(cookies: string): Promise<{ vm_id: string }> {
  const r = await museFetch("GET", "/api/session", cookies);
  if (r.status !== 200)
    throw new AuthError(`api/session -> ${r.status} (cookies expired? re-export)`);
  const info = parseJson(r.text, "api/session");
  // While the VM restarts: {"status":"unavailable","vm_resolution_issue":{"kind":"retryable"}}.
  if (typeof info.vm_id !== "string") {
    throw new GatewayError(
      -1,
      `VM unavailable (${r.text.slice(0, 200)}); retry shortly or \`MUSE_VM_ID=<id> muse-bot wake\``,
    );
  }
  return info as { vm_id: string };
}

export async function fetchAccessToken(cookies: string): Promise<string> {
  const r = await museFetch("POST", "/api/auth/check", cookies);
  if (r.status !== 200) {
    throw new AuthError(
      `auth/check -> ${r.status} ${r.text.slice(0, 120)} (cookies expired? re-export)`,
    );
  }
  return parseJson(r.text, "auth/check").access_token as string;
}

export async function fetchHatchToken(
  cookies: string,
  accessToken: string,
  vmId: string,
): Promise<string> {
  const r = await museFetch("POST", "/api/hatch/token", cookies, {
    accessToken,
    body: { vmAddress: `wss://${vmId}.metaaivm.com/`, vmName: vmId },
  });
  if (r.status !== 200) throw new AuthError(`hatch/token -> ${r.status} ${r.text.slice(0, 160)}`);
  return parseJson(r.text, "hatch/token").token as string;
}

export interface CallOptions {
  pathParams?: Record<string, string | number>;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  timeout?: number;
}

export interface SubscribeOptions extends CallOptions {
  maxRecords?: number;
  idleTimeout?: number;
  overallTimeout?: number;
  onRecord?: (line: string) => void;
}

// One authenticated connection. Frames are consumed by one caller at a time: commands
// make sequential calls, so a frame for another stream is a stale one and is dropped.
export class Gateway {
  vmId: string;
  private ws: WebSocket;
  private session!: Session;
  private inbox: Uint8Array[] = [];
  private wake: (() => void) | undefined;
  private closed: Error | undefined;
  private stream = 1;

  private constructor(ws: WebSocket, vmId: string) {
    this.ws = ws;
    this.vmId = vmId;
    ws.on("message", (data: Buffer) => {
      this.inbox.push(new Uint8Array(data));
      this.wake?.();
    });
    ws.on("close", (code, reason) => {
      this.closed = new GatewayError(-1, `websocket closed ${code} ${reason.toString()}`);
      this.wake?.();
    });
    ws.on("error", (err) => {
      this.closed = err;
      this.wake?.();
    });
  }

  static async connect(cookies: string, vmId?: string): Promise<Gateway> {
    const vm = vmId ?? (await fetchSessionInfo(cookies)).vm_id;
    const access = await fetchAccessToken(cookies);
    const hatch = await fetchHatchToken(cookies, access, vm);
    const url = `wss://${GATEWAY_HOST}/v1/noise?vm_id=${vm}&auth_token=${encodeURIComponent(hatch)}`;
    const gw = new Gateway(await openSocket(url), vm);
    const deadline = Date.now() + 20_000;
    gw.session = await handshake(
      (msg) => gw.ws.send(msg),
      () => gw.nextRaw(deadline),
    );
    return gw;
  }

  private async nextRaw(deadline: number): Promise<Uint8Array> {
    while (this.inbox.length === 0) {
      if (this.closed) throw this.closed;
      const left = deadline - Date.now();
      if (left <= 0) throw new Timeout("gateway read timed out");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
    return this.inbox.shift() as Uint8Array;
  }

  private async nextFrame(deadline: number): Promise<Frame> {
    return decodeFrame(this.session.decrypt(await this.nextRaw(deadline)));
  }

  // Sends a request and returns its stream id without waiting (fire-and-forget calls).
  open(method: string, opts: CallOptions): number {
    const route = ROUTES.get(method);
    if (!route) throw new GatewayError(-1, `unknown gateway method ${method}`);
    let path = route.path;
    for (const [k, v] of Object.entries(opts.pathParams ?? {})) {
      path = path.replace(`{${k}}`, encodeURIComponent(String(v)));
    }
    let { body, query } = opts;
    if (route.http === "GET" && body !== undefined && query === undefined) {
      query = body as CallOptions["query"];
      body = undefined;
    }
    const qs = new URLSearchParams(
      Object.entries(query ?? {})
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    if (qs) path += (path.includes("?") ? "&" : "?") + qs;
    const raw =
      body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
    const headers: { key: string; value: string }[] = [
      { key: "x-request-id", value: randomUUID() },
    ];
    if (raw.length) headers.push({ key: "content-type", value: "application/json" });
    const sid = this.stream++;
    const plaintext = encodeRequest(SERVICE_IDS[route.service ?? "daemon"] ?? 0, sid, {
      verb: route.http,
      path,
      headers,
      body: raw,
      endBody: true,
    });
    this.ws.send(this.session.encrypt(plaintext));
    return sid;
  }

  async request(method: string, opts: CallOptions = {}): Promise<Uint8Array> {
    const sid = this.open(method, opts);
    const deadline = Date.now() + (opts.timeout ?? 30) * 1000;
    const chunks: Uint8Array[] = [];
    let status: number | undefined;
    try {
      for (;;) {
        const f = await this.nextFrame(deadline);
        if (Number(f.streamId) !== sid) continue;
        const k = f.kind;
        if (k.case === "response") {
          const v = k.value as { status: number; body: Uint8Array; endBody: boolean };
          status = v.status;
          if (v.body.length) chunks.push(v.body);
          if (v.endBody) break;
        } else if (k.case === "bodyChunk") {
          const v = k.value as { data: Uint8Array; endBody: boolean };
          chunks.push(v.data);
          if (v.endBody) break;
        } else if (k.case === "reset") {
          const v = k.value as { code: number; reason: string };
          throw new GatewayError(-1, `stream reset ${v.code}: ${v.reason}`);
        }
      }
    } catch (e) {
      if (!(e instanceof Timeout)) throw e;
    }
    if (status === undefined) throw new GatewayError(-1, `no response for ${method}`);
    const payload = Buffer.concat(chunks);
    if (status < 200 || status >= 300) {
      throw new GatewayError(status, payload.subarray(0, 500).toString("utf8"));
    }
    return payload;
  }

  async callJson(method: string, opts: CallOptions = {}): Promise<unknown> {
    const raw = Buffer.from(await this.request(method, opts)).toString("utf8");
    let d: unknown;
    try {
      d = raw ? JSON.parse(raw) : {};
    } catch {
      throw new GatewayError(-1, `non-JSON response: ${raw.slice(0, 200)}`);
    }
    if (d && typeof d === "object" && !Array.isArray(d)) {
      const o = d as Record<string, unknown>;
      if (o.ok === false) throw new GatewayError(-1, `api error: ${JSON.stringify(o.error)}`);
      return "result" in o ? o.result : o;
    }
    return d;
  }

  // Reads an ndjson subscription until it ends, goes idle, or hits a limit.
  async subscribe(method: string, opts: SubscribeOptions = {}): Promise<string[]> {
    const { maxRecords = 100, idleTimeout = 10, overallTimeout = 120, onRecord } = opts;
    const sid = this.open(method, opts);
    const end = Date.now() + overallTimeout * 1000;
    const records: string[] = [];
    let buf = "";
    const take = (line: string) => {
      records.push(line);
      onRecord?.(line);
    };
    try {
      outer: while (records.length < maxRecords) {
        const f = await this.nextFrame(Math.min(end, Date.now() + idleTimeout * 1000));
        if (Number(f.streamId) !== sid) continue;
        const k = f.kind;
        let done = false;
        if (k.case === "response") {
          const v = k.value as { body: Uint8Array; endBody: boolean };
          buf += Buffer.from(v.body).toString("utf8");
          done = v.endBody && !buf;
        } else if (k.case === "bodyChunk") {
          const v = k.value as { data: Uint8Array; endBody: boolean };
          buf += Buffer.from(v.data).toString("utf8");
          done = v.endBody;
        } else if (k.case === "reset") {
          break;
        }
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) take(line);
          if (records.length >= maxRecords) break outer;
          nl = buf.indexOf("\n");
        }
        if (done) break;
      }
    } catch (e) {
      if (!(e instanceof Timeout)) throw e;
    }
    if (buf.trim()) take(buf);
    return records;
  }

  close(): void {
    this.ws.close();
  }
}
