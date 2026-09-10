// ── Account store (JSONL crash-safe) + result writer ───────────────
import fs from "node:fs";
import path from "node:path";

export enum FlowState {
  PENDING = "PENDING",
  SIGNUP = "SIGNUP",
  PROXY_LIST = "PROXY_LIST",
  DONE = "DONE",
  FAILED = "FAILED",
}

export interface AccountRecord {
  email: string;
  password: string;
  status: FlowState;
  fingerprint?: string;
  proxy?: string;
  proxyCount?: number;
  notes?: string;
  updatedAt: number;
}

export class JsonlStore {
  private records = new Map<string, AccountRecord>();
  constructor(private file: string) {
    this.replay();
  }
  private replay(): void {
    this.records.clear();
    if (!fs.existsSync(this.file)) return;
    for (const line of fs.readFileSync(this.file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as AccountRecord;
        this.records.set(r.email, r);
      } catch {
        /* ignore corrupt line */
      }
    }
  }
  all(): AccountRecord[] {
    return [...this.records.values()];
  }
  get(email: string): AccountRecord | undefined {
    return this.records.get(email);
  }
  upsert(r: AccountRecord): void {
    this.records.set(r.email, r);
    fs.appendFileSync(this.file, JSON.stringify(r) + "\n", "utf8");
  }
  setStatus(email: string, s: FlowState, notes?: string): void {
    const cur = this.records.get(email);
    if (!cur) return;
    this.upsert({ ...cur, status: s, notes: notes ?? cur.notes, updatedAt: Date.now() });
  }
  isTerminal(email: string): boolean {
    const r = this.records.get(email);
    return r?.status === FlowState.DONE || r?.status === FlowState.FAILED;
  }
}

// ── One free proxy as webshare hands it to us ──────────────────────

export interface ProxyRecord {
  address: string;
  port: number;
  username: string;
  password: string;
}

export type ProxyFormat = "url" | "webshare";

/**
 * `url` → `http://user:pass@host:port`, which `loadProxies` in the other apps
 * parses directly, so proxy.txt doubles as their seed file.
 * `webshare` → `host:port:user:pass`, webshare's own download format.
 */
export function formatProxy(p: ProxyRecord, format: ProxyFormat = "url"): string {
  if (format === "webshare") return `${p.address}:${p.port}:${p.username}:${p.password}`;
  const cred = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@` : "";
  return `http://${cred}${p.address}:${p.port}`;
}

// ── Result writer: akun-result-webshare / akun-failed-webshare / proxy.txt ──
// Line format: `email|isoTimestamp|note` — email always first so a re-run can
// parse the file back into a skip-set.

function readEmails(file: string): Set<string> {
  const out = new Set<string>();
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    out.add(t.split("|")[0].trim());
  }
  return out;
}

export class ResultWriter {
  constructor(
    private successFile: string,
    private failedFile: string,
    private proxyFile: string,
    private format: ProxyFormat = "url",
  ) {
    fs.mkdirSync(path.dirname(successFile), { recursive: true });
    fs.mkdirSync(path.dirname(failedFile), { recursive: true });
    fs.mkdirSync(path.dirname(proxyFile), { recursive: true });
  }
  private append(file: string, line: string): void {
    fs.appendFileSync(file, line + "\n", "utf8");
  }

  /** Proxies already in proxy.txt, so a re-run never duplicates a line. */
  existingProxyLines(): Set<string> {
    const out = new Set<string>();
    if (!fs.existsSync(this.proxyFile)) return out;
    for (const line of fs.readFileSync(this.proxyFile, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith("#")) out.add(t);
    }
    return out;
  }

  /** success = proxies harvested; appends them to proxy.txt (1 per line). */
  markSuccess(email: string, proxies: ProxyRecord[]): number {
    const ts = new Date().toISOString();
    const seen = this.existingProxyLines();
    let written = 0;
    for (const p of proxies) {
      const line = formatProxy(p, this.format);
      if (seen.has(line)) continue;
      seen.add(line);
      this.append(this.proxyFile, line);
      written++;
    }
    this.append(this.successFile, `${email}|${ts}|${proxies.length} proxies (${written} new)`);
    return written;
  }
  markFailed(email: string, reason: string): void {
    const ts = new Date().toISOString();
    this.append(this.failedFile, `${email}|${ts}|${reason.replace(/\|/g, "/")}`);
  }
  getSuccessfulEmails(): Set<string> {
    return readEmails(this.successFile);
  }
  getFailedEmails(): Set<string> {
    return readEmails(this.failedFile);
  }
  /**
   * Failed for a PERMANENT reason (needle in the reason field). Skipped even
   * under --retry-failed: a risk-control ban does not clear, so retrying only
   * burns time and re-flags the device/IP.
   */
  getPermanentlyFailedEmails(reasonNeedle: string): Set<string> {
    const out = new Set<string>();
    if (!fs.existsSync(this.failedFile)) return out;
    for (const line of fs.readFileSync(this.failedFile, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const parts = t.split("|");
      const email = parts[0]?.trim();
      const reason = parts.slice(2).join("|");
      if (email && reason.includes(reasonNeedle)) out.add(email);
    }
    return out;
  }
}
