// ── Account store (JSONL crash-safe) + result writer ───────────────
import fs from "node:fs";
import path from "node:path";

export enum FlowState {
  PENDING = "PENDING",
  SIGNUP = "SIGNUP",
  VERIFY_OTP = "VERIFY_OTP",
  COMPLETE_SIGNUP = "COMPLETE_SIGNUP",
  WELCOME = "WELCOME",
  API_KEY = "API_KEY",
  DONE = "DONE",
  FAILED = "FAILED",
}

export interface AccountRecord {
  email: string;
  password: string;
  status: FlowState;
  fingerprint?: string;
  proxy?: string;
  apiKey?: string;
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
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
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

// ── Result writer: akun-result-fastrouter.txt / akun-failed-fastrouter.txt / apikey-fastrouter.txt ──
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
    private apiKeyFile: string,
  ) {
    fs.mkdirSync(path.dirname(successFile), { recursive: true });
    fs.mkdirSync(path.dirname(failedFile), { recursive: true });
    fs.mkdirSync(path.dirname(apiKeyFile), { recursive: true });
  }
  private append(file: string, line: string): void {
    fs.appendFileSync(file, line + "\n", "utf8");
  }
  /** success = API key obtained; appends the key (1 key/line) */
  markSuccess(email: string, apiKey: string): void {
    const ts = new Date().toISOString();
    this.append(this.successFile, `${email}|${ts}|${apiKey}`);
    this.append(this.apiKeyFile, apiKey);

    // Also support exact "apikey-fastrouter" if apiKeyFile is apikey-fastrouter.txt (or vice versa)
    const baseDir = path.dirname(this.apiKeyFile);
    const baseName = path.basename(this.apiKeyFile);
    if (baseName === "apikey-fastrouter.txt") {
      const altFile = path.join(baseDir, "apikey-fastrouter");
      this.append(altFile, apiKey);
    } else if (baseName === "apikey-fastrouter") {
      const altFile = path.join(baseDir, "apikey-fastrouter.txt");
      this.append(altFile, apiKey);
    }
  }
  markFailed(email: string, reason: string): void {
    const ts = new Date().toISOString();
    this.append(this.failedFile, `${email}|${ts}|${reason.replace(/\|/g, "/")}`);
  }
  /** emails already recorded as successful (always skipped on re-run) */
  getSuccessfulEmails(): Set<string> {
    return readEmails(this.successFile);
  }
  /** emails already recorded as failed (skipped unless --retry-failed) */
  getFailedEmails(): Set<string> {
    return readEmails(this.failedFile);
  }
  /**
   * Emails recorded as failed with a PERMANENT reason (e.g. ACCOUNT_RESTRICTED).
   * Skipped even under --retry-failed.
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
