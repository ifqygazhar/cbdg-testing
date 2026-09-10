// ── Proxy liveness checking (pure parts) ───────────────────────────

export interface ProxyEntry {
  /** the line exactly as it appeared in the input file */
  raw: string;
  /** a URL fetch() can use, credentials included */
  url: string;
  /** host:port, for display and de-duplication */
  hostPort: string;
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
  return line.replace(/(\/\/[^:/@]+:)[^@/]+@/, "$1***@");
}

/**
 * Same rules as the apps' `loadProxies`: blanks and `#` comments out, a bare
 * `host:port` gets an http scheme. Returns null for a line we cannot use, so
 * the caller can report it instead of silently dropping it.
 */
export function parseProxyLine(line: string): ProxyEntry | null {
  const raw = line.trim();
  if (!raw || raw.startsWith("#")) return null;
  try {
    const u = new URL(raw.includes("://") ? raw : `http://${raw}`);
    if (!u.port && !u.username) return null;
    // `u.host` drops a default port (80/443), which would make 1.2.3.4:80 and
    // 1.2.3.4 look like different endpoints in one direction and identical in
    // the other. Spell the port out so the key is stable either way.
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return { raw, url: u.toString().replace(/\/$/, ""), hostPort: `${u.hostname}:${port}` };
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
  return IP_RE.test(t) ? t : null;
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
