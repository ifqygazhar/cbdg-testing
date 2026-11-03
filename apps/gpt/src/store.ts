import fs from "node:fs";
import path from "node:path";

export enum FlowState {
  PENDING = "PENDING",
  SIGNUP_SUBMITTED = "SIGNUP_SUBMITTED",
  PASSWORD_SET = "PASSWORD_SET",
  OTP_SUBMITTED = "OTP_SUBMITTED",
  ABOUT_YOU_SUBMITTED = "ABOUT_YOU_SUBMITTED",
  ONBOARDING_CONTINUED = "ONBOARDING_CONTINUED",
  PROMPT_SENT = "PROMPT_SENT",
  DONE = "DONE",
  FAILED = "FAILED",
}

export interface AccountRecord {
  email: string;
  password?: string;
  status: FlowState;
  proxy?: string;
  fingerprint?: string;
  error?: string;
  updatedAt: number;
}

export class JsonlStore {
  private records = new Map<string, AccountRecord>();
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    const content = fs.readFileSync(this.filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as AccountRecord;
        if (rec.email) {
          this.records.set(rec.email.toLowerCase(), rec);
        }
      } catch {}
    }
  }

  public get(email: string): AccountRecord | undefined {
    return this.records.get(email.toLowerCase());
  }

  public getAll(): AccountRecord[] {
    return Array.from(this.records.values());
  }

  public upsert(record: AccountRecord): void {
    const key = record.email.toLowerCase();
    this.records.set(key, record);
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.filePath, JSON.stringify(record) + "\n", "utf-8");
    } catch (e) {
      console.error(`[JsonlStore] failed to write state: ${(e as Error).message}`);
    }
  }
}

export class ResultWriter {
  private successFile: string;
  private failedFile: string;
  private successfulEmails = new Set<string>();

  constructor(successFile: string, failedFile: string) {
    this.successFile = path.resolve(successFile);
    this.failedFile = path.resolve(failedFile);
    this.loadExistingSuccess();
  }

  private loadExistingSuccess(): void {
    if (!fs.existsSync(this.successFile)) return;
    const content = fs.readFileSync(this.successFile, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const parts = trimmed.split(":");
      if (parts[0]) {
        this.successfulEmails.add(parts[0].trim().toLowerCase());
      }
    }
  }

  public getSuccessfulEmails(): Set<string> {
    return this.successfulEmails;
  }

  public recordSuccess(email: string, password?: string): void {
    const norm = email.trim().toLowerCase();
    this.successfulEmails.add(norm);
    const line = password ? `${email.trim()}:${password.trim()}\n` : `${email.trim()}\n`;
    try {
      const dir = path.dirname(this.successFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.successFile, line, "utf-8");
    } catch (e) {
      console.error(`[ResultWriter] failed to record success: ${(e as Error).message}`);
    }
  }

  public recordFailed(email: string, reason?: string, password?: string): void {
    const entry = password
      ? `${email.trim()}:${password.trim()} | ${reason || "unknown"}\n`
      : `${email.trim()} | ${reason || "unknown"}\n`;
    try {
      const dir = path.dirname(this.failedFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.failedFile, entry, "utf-8");
    } catch (e) {
      console.error(`[ResultWriter] failed to record failed: ${(e as Error).message}`);
    }
  }
}
