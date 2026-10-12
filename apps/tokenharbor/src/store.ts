// ── Account store (JSONL crash-safe) + result writer ───────────────
import fs from "node:fs";
import path from "node:path";

export enum FlowState {
  PENDING = "PENDING",
  SIGNUP = "SIGNUP",
  DASHBOARD = "DASHBOARD",
  FREE_MODELS = "FREE_MODELS",
  TRIGGER_VERIFY = "TRIGGER_VERIFY",
  EMAIL_VERIFIED = "EMAIL_VERIFIED",
  API_KEY = "API_KEY",
  DONE = "DONE",
  FAILED = "FAILED",
}

export interface AccountRecord {
  email: string;
  password?: string;
  status: FlowState;
  fingerprint?: string;
  proxy?: string;
  apiKey?: string;
  verificationLink?: string;
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

// ── Result writer: akun-result-tokenharbor.txt / apikey-tokenharbor.txt ──
function readEmails(fileOrFiles: string | string[]): Set<string> {
  const out = new Set<string>();
  const files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
  const emailRegex = /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/;
  for (const file of files) {
    if (!file || !fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const clean = t.includes(" #") ? t.split(" #")[0].trim() : t;
      const email = clean.split(/[:|]/)[0].trim().toLowerCase();
      if (email && email.includes("@")) {
        out.add(email);
      } else {
        const m = t.match(emailRegex);
        if (m) out.add(m[0].toLowerCase());
      }
    }
  }
  return out;
}

export class ResultWriter {
  private keyFiles: string[] = [];

  constructor(
    private successFile: string,
    private failedFile: string,
    apiKeyFile: string,
  ) {
    fs.mkdirSync(path.dirname(successFile), { recursive: true });
    fs.mkdirSync(path.dirname(failedFile), { recursive: true });
    fs.mkdirSync(path.dirname(apiKeyFile), { recursive: true });

    this.keyFiles.push(apiKeyFile);
    if (fs.existsSync("tokenharbor-dataset")) {
      this.keyFiles.push("tokenharbor-dataset/apikey-tokenharbor.txt");
    }
  }

  private append(file: string, line: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line + "\n", "utf8");
  }

  /** success = API key obtained; appends key to apikey files and account details */
  markSuccess(email: string, password: string, apiKey: string): void {
    const ts = new Date().toISOString();
    this.append(this.successFile, `${email}:${password}:${apiKey}|${ts}`);

    for (const kf of this.keyFiles) {
      this.append(kf, apiKey);
    }
  }

  markFailed(email: string, reason: string): void {
    const ts = new Date().toISOString();
    this.append(this.failedFile, `${email}|${ts}|${reason.replace(/\|/g, "/")}`);
  }

  getSuccessfulEmails(): Set<string> {
    const candidateFiles = [
      this.successFile,
      "akun-result-tokenharbor.txt",
      "vps/akun-result-tokenharbor.txt",
      "akun-good-tokenharbor.txt",
      "vps/akun-good-tokenharbor.txt",
      "gsuite-api-key.txt",
      "tokenharbor-dataset/akun-result-tokenharbor.txt",
    ];
    return readEmails(candidateFiles);
  }

  getFailedEmails(): Set<string> {
    const candidateFiles = [
      this.failedFile,
      "akun-failed-tokenharbor.txt",
      "vps/akun-failed-tokenharbor.txt",
    ];
    return readEmails(candidateFiles);
  }
}
