// ── Proxy liveness checking (pure parts) ───────────────────────────

import { SocksClient } from "socks";
import tls from "node:tls";
import net from "node:net";

export interface ProxyEntry {
  /** the line exactly as it appeared in the input file */
  raw: string;
  /** a URL fetch() or client can use, credentials included */
  url: string;
  /** host:port, for display and de-duplication */
  hostPort: string;
  /** protocol, e.g. "http:", "https:", "socks5:", "socks4:" */
  protocol: string;
  /** hostname */
  hostname: string;
  /** port */
  port: string;
  /** username for authentication */
  username?: string;
  /** password for authentication */
  password?: string;
}

export interface CheckResult {
  entry: ProxyEntry;
  alive: boolean;
  ms: number;
  /** the IP the target saw, when we got that far */
  exitIp?: string;
  reason?: string;
}

/** Hide the password so a pasted log does not leak the pool. */
export function mask(line: string): string {
  // 1. host:port:user:pass -> host:port:user:***
  if (/^[^:\s]+:\d+:[^:@\s]+:.+$/.test(line)) {
    return line.replace(/^([^:\s]+:\d+:[^:@\s]+:).+$/, "$1***");
  }
  // 2. scheme://user:pass@host:port or user:pass@host:port
  return line.replace(/((?:\/\/|^)[^:/@]+:)[^@/]+@/, "$1***@");
}

/**
 * Supports standard HTTP/HTTPS, SOCKS4, SOCKS5, and bare host:port lines,
 * both with and without credentials (e.g. https://37.203.35.19:443 or socks5://1.2.3.4:1080).
 * Blanks and `#` comments return null.
 */
export function parseProxyLine(line: string): ProxyEntry | null {
  const raw = line.trim();
  if (!raw || raw.startsWith("#")) return null;

  let norm = raw;
  // Handle host:port:user:pass format if no scheme is present
  if (!norm.includes("://")) {
    const parts = norm.split(":");
    if (parts.length === 4) {
      const [h, p, u, pwd] = parts;
      norm = `http://${encodeURIComponent(u)}:${encodeURIComponent(pwd)}@${h}:${p}`;
    } else {
      norm = `http://${norm}`;
    }
  }

  try {
    const u = new URL(norm);
    if (!u.hostname) return null;

    // Determine the port (WHATWG URL strips default 80 for http and 443 for https)
    let port = u.port;
    if (!port) {
      const authority = norm.split("://")[1]?.split("/")[0] || "";
      const hostPart = authority.includes("@") ? authority.split("@")[1] : authority;
      const m = hostPart.match(/:(\d+)$/);
      if (m) {
        port = m[1];
      }
    }

    // Require an explicit port to avoid dialling invalid hosts (e.g. "http://host-tanpa-port")
    if (!port) return null;

    const protocol = u.protocol.toLowerCase();
    const allowed = [
      "http:",
      "https:",
      "socks:",
      "socks4:",
      "socks4a:",
      "socks5:",
      "socks5h:",
    ];
    if (!allowed.includes(protocol)) return null;

    let normProtocol = protocol;
    if (normProtocol === "socks5h:" || normProtocol === "socks5:") {
      normProtocol = "socks5:";
    } else if (normProtocol === "socks4a:" || normProtocol === "socks4:" || normProtocol === "socks:") {
      normProtocol = "socks4:";
    }

    const username = u.username ? decodeURIComponent(u.username) : undefined;
    const password = u.password ? decodeURIComponent(u.password) : undefined;

    const authPart = username
      ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ""}@`
      : "";
    const url = `${normProtocol}//${authPart}${u.hostname}:${port}`;

    return {
      raw,
      url,
      hostPort: `${u.hostname}:${port}`,
      protocol: normProtocol,
      hostname: u.hostname,
      port,
      username,
      password,
    };
  } catch {
    return null;
  }
}

export function parseProxyFile(text: string): { entries: ProxyEntry[]; skipped: string[] } {
  const entries: ProxyEntry[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const entry = parseProxyLine(t);
    if (!entry) {
      skipped.push(t);
      continue;
    }
    if (seen.has(entry.hostPort)) continue; // same endpoint twice is one proxy
    seen.add(entry.hostPort);
    entries.push(entry);
  }
  return { entries, skipped };
}

const IP_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/** The check endpoint answers with the caller's IP and nothing else. */
export function readExitIp(body: string): string | null {
  const t = body.trim();
  if (IP_RE.test(t)) return t;
  for (const line of t.split(/\r?\n/)) {
    const lt = line.trim();
    if (IP_RE.test(lt)) return lt;
  }
  return null;
}

/** Decode HTTP chunked transfer encoding body */
export function decodeChunked(rawBody: string): string {
  let result = "";
  let remaining = rawBody;
  while (remaining.length > 0) {
    const idx = remaining.indexOf("\r\n");
    if (idx === -1) break;
    const chunkSizeHex = remaining.slice(0, idx).trim();
    const chunkSize = parseInt(chunkSizeHex, 16);
    if (isNaN(chunkSize) || chunkSize === 0) break;
    const dataStart = idx + 2;
    result += remaining.slice(dataStart, dataStart + chunkSize);
    remaining = remaining.slice(dataStart + chunkSize + 2);
  }
  return result || rawBody;
}

/**
 * A proxy counts as alive only when the target saw an address that is NOT
 * ours. A transparent or broken proxy that quietly falls back to a direct
 * connection would otherwise pass, and then every "proxied" account would run
 * from this machine's IP without anyone noticing.
 */
export function judge(exitIp: string | null, directIp: string | null): { alive: boolean; reason?: string } {
  if (!exitIp) return { alive: false, reason: "jawaban bukan alamat IP" };
  if (directIp && exitIp === directIp) return { alive: false, reason: "IP keluar sama dengan IP kita" };
  return { alive: true };
}

/** Fastest first: the queue hands out proxies in file order. */
export function sortByLatency(results: CheckResult[]): CheckResult[] {
  return [...results].sort((a, b) => a.ms - b.ms);
}

export function summarise(results: CheckResult[]): { alive: number; dead: number; medianMs: number } {
  const alive = results.filter((r) => r.alive);
  const times = alive.map((r) => r.ms).sort((a, b) => a - b);
  const medianMs = times.length ? times[Math.floor(times.length / 2)] : 0;
  return { alive: alive.length, dead: results.length - alive.length, medianMs };
}

/** Check SOCKS proxy liveness (SOCKS4 / SOCKS5 with optional auth) */
export async function checkSocks(
  entry: ProxyEntry,
  opts: { url: string; timeoutMs: number },
  ourIp: string | null,
): Promise<CheckResult> {
  const started = Date.now();
  let rawSocket: net.Socket | null = null;
  let activeSocket: net.Socket | tls.TLSSocket | null = null;

  try {
    const destUrl = new URL(opts.url);
    const isHttps = destUrl.protocol === "https:";
    const destPort = destUrl.port ? Number(destUrl.port) : (isHttps ? 443 : 80);
    const destHost = destUrl.hostname;
    const destPath = (destUrl.pathname || "/") + destUrl.search;
    const socksType = entry.protocol.startsWith("socks4") ? 4 : 5;

    const connInfo = await SocksClient.createConnection({
      proxy: {
        host: entry.hostname,
        port: Number(entry.port),
        type: socksType,
        userId: entry.username || undefined,
        password: entry.password || undefined,
      },
      command: "connect",
      destination: {
        host: destHost,
        port: destPort,
      },
      timeout: opts.timeoutMs,
    });

    rawSocket = connInfo.socket;

    if (isHttps) {
      const tlsSocket = tls.connect({
        socket: rawSocket,
        servername: destHost,
        rejectUnauthorized: false,
      });

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          tlsSocket.destroy();
          reject(new Error("TLS handshake timeout"));
        }, opts.timeoutMs);
        tlsSocket.once("secureConnect", () => {
          clearTimeout(timer);
          resolve();
        });
        tlsSocket.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      activeSocket = tlsSocket;
    } else {
      activeSocket = rawSocket;
    }

    const responseText = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => {
        activeSocket?.destroy();
        reject(new Error("Response timeout"));
      }, opts.timeoutMs);

      activeSocket!.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (buffer.includes("\r\n\r\n")) {
          const [headers, ...rest] = buffer.split("\r\n\r\n");
          const cl = headers.match(/content-length:\s*(\d+)/i);
          if (cl) {
            const expected = Number(cl[1]);
            const bodySoFar = rest.join("\r\n\r\n");
            if (Buffer.byteLength(bodySoFar) >= expected) {
              clearTimeout(timer);
              resolve(buffer);
              return;
            }
          }
          if (/transfer-encoding:\s*chunked/i.test(headers) && /0\r\n\r\n$/i.test(buffer.trim())) {
            clearTimeout(timer);
            resolve(buffer);
            return;
          }
        }
      });

      activeSocket!.once("end", () => {
        clearTimeout(timer);
        resolve(buffer);
      });

      activeSocket!.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      activeSocket!.write(
        `GET ${destPath} HTTP/1.1\r\nHost: ${destHost}\r\nUser-Agent: curl/8.5.0\r\nConnection: close\r\nAccept: */*\r\n\r\n`,
      );
    });

    const ms = Date.now() - started;
    const [headers, ...rest] = responseText.split("\r\n\r\n");
    const rawBody = rest.join("\r\n\r\n");
    const body = /transfer-encoding:\s*chunked/i.test(headers) ? decodeChunked(rawBody) : rawBody;

    const statusMatch = headers.match(/^HTTP\/[0-9.]+\s+(\d+)/i);
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    if (status < 200 || status >= 400) {
      return { entry, alive: false, ms, reason: status ? `HTTP ${status}` : "jawaban tidak valid" };
    }

    const exitIp = readExitIp(body);
    const verdict = judge(exitIp, ourIp);
    return { entry, alive: verdict.alive, ms, exitIp: exitIp ?? undefined, reason: verdict.reason };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const reason = /timeout|timed out|aborted/i.test(msg) ? "timeout" : msg.slice(0, 60);
    return { entry, alive: false, ms: Date.now() - started, reason };
  } finally {
    try {
      activeSocket?.destroy();
    } catch {}
    try {
      rawSocket?.destroy();
    } catch {}
  }
}

/** Run `task` over `items` with at most `limit` in flight. Order is preserved. */
export async function pool<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await task(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
