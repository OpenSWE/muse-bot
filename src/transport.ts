// The only module that touches the network. Swap point for wreq-js if muse.ai
// starts rejecting Node's TLS fingerprint (DECISIONS.md Q14).
import WebSocket from "ws";

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

// muse.ai returns 403 to POSTs without the browser Sec-Fetch-* headers.
function museHeaders(cookies: string, accessToken?: string): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": UA,
    Referer: "https://muse.ai/",
    Origin: "https://muse.ai",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    Accept: "application/json",
    "Content-Type": "application/json",
    Cookie: cookies,
  };
  if (accessToken) h.Authorization = `Bearer ${accessToken}`;
  return h;
}

export async function museFetch(
  method: "GET" | "POST",
  path: string,
  cookies: string,
  opts: { accessToken?: string; body?: unknown } = {},
): Promise<{ status: number; text: string }> {
  const r = await fetch(`https://muse.ai${path}`, {
    method,
    headers: museHeaders(cookies, opts.accessToken),
    body:
      method === "POST" ? (opts.body === undefined ? "" : JSON.stringify(opts.body)) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  return { status: r.status, text: await r.text() };
}

export function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { "User-Agent": UA, Origin: "https://muse.ai" },
      handshakeTimeout: 20_000,
    });
    ws.binaryType = "nodebuffer";
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) =>
      reject(new Error(`gateway websocket upgrade -> HTTP ${res.statusCode}`)),
    );
    ws.once("error", reject);
  });
}
