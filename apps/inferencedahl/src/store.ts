// ── Account store (JSONL crash-safe) + result writer ───────────────
import fs from "node:fs";
import path from "node:path";

export enum FlowState {
  PENDING = "PENDING",
  SIGNUP = "SIGNUP",
  FINGERPRINT_SAVED = "FINGERPRINT_SAVED",
  DASHBOARD = "DASHBOARD",
  ALLOCATE = "ALLOCATE",
  DONE = "DONE",
  FAILED = "FAILED",
}

export interface AccountRecord {
  id: string;
  username?: string;
  fingerprint?: string;
  status: FlowState;
  proxy?: string;
  apiKey?: string;
  allocated?: boolean;
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
        const key = r.id || r.fingerprint || r.username;
        if (key) this.records.set(key, { ...r, id: key });
      } catch {
        /* ignore corrupt line */
      }
    }
  }

  all(): AccountRecord[] {
    return [...this.records.values()];
  }

  get(id: string): AccountRecord | undefined {
    return this.records.get(id);
  }

  upsert(r: AccountRecord): void {
    this.records.set(r.id, r);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(r) + "\n", "utf8");
  }

  setStatus(id: string, s: FlowState, notes?: string): void {
    const cur = this.records.get(id);
    if (!cur) return;
    this.upsert({ ...cur, status: s, notes: notes ?? cur.notes, updatedAt: Date.now() });
  }

  isTerminal(id: string): boolean {
    const r = this.records.get(id);
    return r?.status === FlowState.DONE || r?.status === FlowState.FAILED;
  }
}

// ── Result writer: akun-result-inferencedahl.txt / apikey-inferencedahl.txt ──
function readFingerprints(fileOrFiles: string | string[]): Set<string> {
  const out = new Set<string>();
  const files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
  for (const file of files) {
    if (!file || !fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const clean = t.includes(" #") ? t.split(" #")[0].trim() : t;
      const fp = clean.split(/[:|]/)[0]?.trim();
      if (fp) {
        out.add(fp);
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
    if (!apiKeyFile.includes("tmp") && !apiKeyFile.includes("-store-") && fs.existsSync("inference-dahl-global-dataset")) {
      this.keyFiles.push("inference-dahl-global-dataset/apikey-inferencedahl.txt");
    }
  }

  private append(file: string, line: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line + "\n", "utf8");
  }

  /**
   * Saves fingerprint:apikey to akun-result-inferencedahl.txt
   * and apikey to apikey-inferencedahl.txt
   */
  markSuccess(fingerprint: string, apiKey: string): void {
    this.append(this.successFile, `${fingerprint}:${apiKey}`);

    for (const kf of this.keyFiles) {
      this.append(kf, apiKey);
    }
  }

  markFailed(id: string, reason: string): void {
    const ts = new Date().toISOString();
    this.append(this.failedFile, `${id}|${ts}|${reason.replace(/\|/g, "/")}`);
  }

  getSuccessfulFingerprints(): Set<string> {
    const candidateFiles = [
      this.successFile,
      "akun-result-inferencedahl.txt",
      "vps/akun-result-inferencedahl.txt",
      "inference-dahl-global-dataset/akun-result-inferencedahl.txt",
    ];
    return readFingerprints(candidateFiles);
  }

  getFailedIds(): Set<string> {
    const candidateFiles = [
      this.failedFile,
      "akun-failed-inferencedahl.txt",
      "vps/akun-failed-inferencedahl.txt",
    ];
    return readFingerprints(candidateFiles);
  }
}
