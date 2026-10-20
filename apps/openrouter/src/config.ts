import fs from "node:fs";
import path from "node:path";
import { resolvePace, type Pace, type PaceName } from "@ifqy/google-oauth";

export interface OpenRouterConfig {
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
  limit: number;
  authMethod: "google" | "tempmail";
  seedProxy: string;
  seedAccounts?: string;
  stateFile: string;
  resultSuccessFile: string;
  resultFailedFile: string;
  apiKeyFile: string;
  screenshotDir: string;
}

export function parseBool(val: string | undefined, defaultVal: boolean): boolean {
  if (val === undefined) return defaultVal;
  const s = val.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OpenRouterConfig {
  const workers = Math.max(1, parseInt(env.WORKERS || "1", 10) || 1);
  const headless = parseBool(env.HEADLESS, true);
  const pace = resolvePace(env.PACE as PaceName);
  const retryFailed = parseBool(env.RETRY_FAILED, false);
  const interAccountDelaySec = Math.max(0, parseInt(env.INTER_ACCOUNT_DELAY_SEC || "2", 10) || 0);

  const defaultPassword = env.OPENROUTER_PASSWORD || "torabikA1#";
  const tempMailApiKey = env.TEMPMAIL_API_KEY || "anjingmemekkontol";
  const tempMailBaseUrl = env.TEMPMAIL_BASE_URL || "https://temp-postservice.verifwebsitepro.workers.dev";
  let tempMailDomain = env.TEMPMAIL_DOMAIN || "ifqy.net";
  if (tempMailDomain.startsWith("temp.")) {
    tempMailDomain = tempMailDomain.slice(5);
  }

  const useProxy = parseBool(env.USE_PROXY, true);
  const proxyReuse = parseBool(env.PROXY_REUSE, false);
  const limit = Math.max(0, parseInt(env.LIMIT || "0", 10) || 0);
  const authMethod: "google" | "tempmail" = env.OPENROUTER_AUTH === "google" ? "google" : "tempmail";

  // Auto-resolve proxy seed
  let seedProxy = env.SEED_PROXY || "proxy-live.txt";
  if (!fs.existsSync(seedProxy) && fs.existsSync("proxy.txt")) {
    seedProxy = "proxy.txt";
  }

  // Auto-resolve optional accounts file ONLY for Google OAuth
  let seedAccounts = env.SEED_ACCOUNTS;
  if (!seedAccounts && authMethod === "google") {
    if (fs.existsSync("openrouter-dataset/gsuite.txt")) {
      seedAccounts = "openrouter-dataset/gsuite.txt";
    } else if (fs.existsSync("gsuite.txt")) {
      seedAccounts = "gsuite.txt";
    }
  }

  const stateFile = env.OPENROUTER_STATE_FILE || env.STATE_FILE || "state-openrouter.jsonl";
  const resultSuccessFile = env.OPENROUTER_RESULT_SUCCESS_FILE || "akun-result-openrouter.txt";
  const resultFailedFile = env.OPENROUTER_RESULT_FAILED_FILE || "akun-failed-openrouter.txt";
  const apiKeyFile = env.OPENROUTER_API_KEY_FILE || env.API_KEY_FILE || "apikey-openrouter.txt";
  const screenshotDir = env.OPENROUTER_SCREENSHOT_DIR || env.SCREENSHOT_DIR || "screenshots-openrouter";

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
    limit,
    authMethod,
    seedProxy,
    seedAccounts,
    stateFile,
    resultSuccessFile,
    resultFailedFile,
    apiKeyFile,
    screenshotDir,
  };
}

export function ensureDirs(cfg: OpenRouterConfig): void {
  const dirs = [cfg.screenshotDir, path.dirname(cfg.stateFile), path.dirname(cfg.resultSuccessFile)];
  for (const d of dirs) {
    if (d && d !== "." && !fs.existsSync(d)) {
      try {
        fs.mkdirSync(d, { recursive: true });
      } catch {
        /* best effort */
      }
    }
  }
}
