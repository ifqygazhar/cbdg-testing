import fs from "node:fs";
import path from "node:path";
import { type Pace, type PaceName, resolvePace } from "@ifqy/google-oauth";

export interface InferbaseConfig {
  workers: number;
  headless: boolean;
  pace: Pace;
  retryFailed: boolean;
  interAccountDelaySec: number;
  defaultPassword: string;
  tempMailApiKey: string;
  tempMailBaseUrl: string;
  tempMailDomain: string;
  useProxy: boolean;
  proxyReuse: boolean;
  seedProxy: string;
  authMethod: "google" | "tempmail";
  seedAccounts?: string;
  stateFile: string;
  resultSuccessFile: string;
  resultFailedFile: string;
  apiKeyFile: string;
  screenshotDir: string;
  limit: number;
}

export function parseBool(val: string | undefined, def: boolean): boolean {
  if (val === undefined) return def;
  const s = val.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): InferbaseConfig {
  const workers = Math.max(1, parseInt(env.WORKERS || "1", 10) || 1);
  const headless = parseBool(env.HEADLESS, true);
  const pace = resolvePace(env.PACE as PaceName);
  const retryFailed = parseBool(env.RETRY_FAILED, false);
  const interAccountDelaySec = Math.max(0, parseInt(env.INTER_ACCOUNT_DELAY_SEC || "2", 10) || 0);

  const defaultPassword = env.INFERBASE_PASSWORD || "torabikA1#";
  const tempMailApiKey = env.TEMPMAIL_API_KEY || "anjingmemekkontol";
  const tempMailBaseUrl = env.TEMPMAIL_BASE_URL || "https://temp-postservice.verifwebsitepro.workers.dev";
  let tempMailDomain = env.TEMPMAIL_DOMAIN || "ifqy.net";
  if (tempMailDomain.startsWith("temp.")) {
    tempMailDomain = tempMailDomain.slice(5);
  }

  const useProxy = parseBool(env.USE_PROXY, true);
  const proxyReuse = parseBool(env.PROXY_REUSE, false);
  const limit = Math.max(0, parseInt(env.LIMIT || "0", 10) || 0);
  const authMethod: "google" | "tempmail" = env.INFERBASE_AUTH === "google" ? "google" : "tempmail";

  // Auto-resolve proxy seed
  let seedProxy = env.SEED_PROXY || "proxy-live.txt";
  if (!fs.existsSync(seedProxy) && fs.existsSync("proxy.txt")) {
    seedProxy = "proxy.txt";
  }

  // Auto-resolve optional accounts file ONLY for Google OAuth
  let seedAccounts = env.SEED_ACCOUNTS;
  if (authMethod === "google" && !seedAccounts) {
    if (fs.existsSync("inferbase-ai-dataset/gsuite.txt")) seedAccounts = "inferbase-ai-dataset/gsuite.txt";
    else if (fs.existsSync("gsuite.txt")) seedAccounts = "gsuite.txt";
    else if (fs.existsSync("accounts-inferbase.txt")) seedAccounts = "accounts-inferbase.txt";
  }

  const stateFile = env.INFERBASE_STATE_FILE || "state-inferbase.jsonl";
  const resultSuccessFile = env.INFERBASE_RESULT_SUCCESS_FILE || "akun-result-inferbase.txt";
  const resultFailedFile = env.INFERBASE_RESULT_FAILED_FILE || "akun-failed-inferbase.txt";
  const apiKeyFile = env.INFERBASE_API_KEY_FILE || env.API_KEY_FILE || "apikey-inferbase.txt";
  const screenshotDir = env.INFERBASE_SCREENSHOT_DIR || env.SCREENSHOT_DIR || "screenshots-inferbase";

  return {
    workers,
    headless,
    pace,
    retryFailed,
    interAccountDelaySec,
    defaultPassword,
    tempMailApiKey,
    tempMailBaseUrl,
    tempMailDomain,
    useProxy,
    proxyReuse,
    seedProxy,
    authMethod,
    seedAccounts,
    stateFile,
    resultSuccessFile,
    resultFailedFile,
    apiKeyFile,
    screenshotDir,
    limit,
  };
}

export function ensureDirs(cfg: InferbaseConfig): void {
  const dirs = [cfg.screenshotDir, path.dirname(cfg.stateFile), path.dirname(cfg.resultSuccessFile)];
  for (const d of dirs) {
    if (d && d !== "." && !fs.existsSync(d)) {
      try {
        fs.mkdirSync(d, { recursive: true });
      } catch {}
    }
  }
}

