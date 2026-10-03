import fs from "node:fs";
import path from "node:path";
import { type Pace, type PaceName, resolvePace } from "@ifqy/google-oauth";

export interface TokenHarborConfig {
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TokenHarborConfig {
  const workers = Math.max(1, parseInt(env.WORKERS || "1", 10) || 1);
  const headless = parseBool(env.HEADLESS, true);
  const pace = resolvePace(env.PACE as PaceName);
  const retryFailed = parseBool(env.RETRY_FAILED, false);
  const interAccountDelaySec = Math.max(0, parseInt(env.INTER_ACCOUNT_DELAY_SEC || "2", 10) || 0);

  const defaultPassword = env.TOKENHARBOR_PASSWORD || "torabikA1###########";
  const tempMailApiKey = env.TEMPMAIL_API_KEY || "anjingmemekkontol";
  const tempMailBaseUrl = env.TEMPMAIL_BASE_URL || "https://temp-postservice.verifwebsitepro.workers.dev";
  const tempMailDomain = env.TEMPMAIL_DOMAIN || "ifqy.net";

  const useProxy = parseBool(env.USE_PROXY, true);
  const proxyReuse = parseBool(env.PROXY_REUSE, false);
  const limit = Math.max(0, parseInt(env.LIMIT || "0", 10) || 0);

  // Auto-resolve proxy seed
  let seedProxy = env.SEED_PROXY || "proxy-live.txt";
  if (!fs.existsSync(seedProxy) && fs.existsSync("proxy.txt")) {
    seedProxy = "proxy.txt";
  }

  // Auto-resolve optional accounts file
  let seedAccounts = env.SEED_ACCOUNTS;
  if (!seedAccounts) {
    if (fs.existsSync("tokenharbor-dataset/gsuite.txt")) seedAccounts = "tokenharbor-dataset/gsuite.txt";
    else if (fs.existsSync("accounts-tokenharbor.txt")) seedAccounts = "accounts-tokenharbor.txt";
  }

  const stateFile = env.STATE_FILE || "state-tokenharbor.jsonl";
  const resultSuccessFile = env.RESULT_SUCCESS_FILE || "akun-result-tokenharbor.txt";
  const resultFailedFile = env.RESULT_FAILED_FILE || "akun-failed-tokenharbor.txt";
  const apiKeyFile = env.API_KEY_FILE || "apikey-tokenharbor.txt";
  const screenshotDir = env.SCREENSHOT_DIR || "screenshots-tokenharbor";

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
    seedAccounts,
    stateFile,
    resultSuccessFile,
    resultFailedFile,
    apiKeyFile,
    screenshotDir,
    limit,
  };
}

export function ensureDirs(cfg: TokenHarborConfig): void {
  const dirs = [cfg.screenshotDir, path.dirname(cfg.stateFile), path.dirname(cfg.resultSuccessFile)];
  for (const d of dirs) {
    if (d && d !== "." && !fs.existsSync(d)) {
      try {
        fs.mkdirSync(d, { recursive: true });
      } catch {}
    }
  }
}
