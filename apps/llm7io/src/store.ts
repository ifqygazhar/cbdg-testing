// ── Persistence: ResultWriter and JsonlStore for LLM7.io ─────────
import fs from "node:fs";
import path from "node:path";

export enum FlowState {
  PENDING = "PENDING",
  SIGNUP = "SIGNUP",
  WAIT_OTP = "WAIT_OTP",
  DASHBOARD = "DASHBOARD",
  API_KEY = "API_KEY",
  DONE = "DONE",
  FAILED = "FAILED",
}

export interface AccountRecord {
  email: string;
  password?: string;
  authMethod?: string;
  status: FlowState | string;
  apiKey?: string;
  proxy?: string | null;
  error?: string;
  updatedAt?: number;
}

export class JsonlStore {
  private records = new Map<string, AccountRecord>();

  constructor(public readonly filepath: string) {
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filepath)) return;
    try {
      const content = fs.readFileSync(this.filepath, "utf8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed) as AccountRecord;
          if (rec.email) {
            this.records.set(rec.email.toLowerCase(), rec);
          }
        } catch {}
      }
    } catch {}
  }

  get(email: string): AccountRecord | undefined {
    return this.records.get(email.toLowerCase());
  }

  isDone(email: string): boolean {
    const rec = this.get(email);
    return rec !== undefined && rec.status === FlowState.DONE;
  }

  getAllDoneEmails(): Set<string> {
    const done = new Set<string>();
    for (const [email, rec] of this.records.entries()) {
      if (rec.status === FlowState.DONE) done.add(email);
    }
    return done;
  }

  getAllFailedEmails(): Set<string> {
    const failed = new Set<string>();
    for (const [email, rec] of this.records.entries()) {
      if (rec.status === FlowState.FAILED) failed.add(email);
    }
    return failed;
  }

  upsert(rec: AccountRecord): void {
    if (!rec.email) return;
    rec.updatedAt = Date.now();
    this.records.set(rec.email.toLowerCase(), rec);

    try {
      const dir = path.dirname(path.resolve(this.filepath));
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.filepath, JSON.stringify(rec) + "\n", "utf8");
    } catch {}
  }
}

export class ResultWriter {
  constructor(
    public readonly keyFiles: string[],
    public readonly accountResultFile: string,
    public readonly accountFailedFile: string,
  ) {}

  markSuccess(email: string, password = "", apiKey = "", extra = ""): void {
    // 1. Write raw API key to all target keyFiles (apikey-llm7io.txt)
    if (apiKey) {
      for (const kf of this.keyFiles) {
        if (!kf) continue;
        try {
          const dir = path.dirname(path.resolve(kf));
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.appendFileSync(kf, `${apiKey}\n`, "utf8");
        } catch {}
      }
    }

    // 2. Write credential to accountResultFile
    const line = password ? `${email}:${password}` : email;
    const parts = [line];
    if (apiKey) parts.push(apiKey);
    if (extra) parts.push(extra);

    try {
      const dir = path.dirname(path.resolve(this.accountResultFile));
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.accountResultFile, `${parts.join(":")}\n`, "utf8");
    } catch {}
  }

  markFailed(email: string, errorMsg = ""): void {
    try {
      const dir = path.dirname(path.resolve(this.accountFailedFile));
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.accountFailedFile, `${email} # ${errorMsg}\n`, "utf8");
    } catch {}
  }
}
