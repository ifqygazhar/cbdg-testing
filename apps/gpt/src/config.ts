import fs from "node:fs";
import path from "node:path";
import { resolvePace, type Pace, type PaceName } from "@ifqy/google-oauth";

export const DEFAULT_SIGNUP_URL = "https://chatgpt.com/";
export const AUTH_OPENAI_URL = "https://auth.openai.com/";

export interface GptConfig {
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
  authMethod: "tempmail" | "google";
  seedProxy: string;
  seedAccounts?: string;
  stateFile: string;
  resultSuccessFile: string;
  resultFailedFile: string;
  screenshotDir: string;
}

export function parseBool(val: string | undefined, defaultVal: boolean): boolean {
  if (val === undefined) return defaultVal;
  const s = val.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GptConfig {
  const workers = Math.max(1, parseInt(env.WORKERS || "1", 10) || 1);
  const headless = parseBool(env.HEADLESS, true);
  const pace = resolvePace(env.PACE as PaceName);
  const retryFailed = parseBool(env.RETRY_FAILED, false);
  const interAccountDelaySec = Math.max(0, parseInt(env.INTER_ACCOUNT_DELAY_SEC || "2", 10) || 0);

  const defaultPassword = env.GPT_PASSWORD || env.DEFAULT_PASSWORD || "torabikA1###########";
  const tempMailApiKey = env.TEMPMAIL_API_KEY || "anjingmemekkontol";
  const tempMailBaseUrl = env.TEMPMAIL_BASE_URL || "https://temp-postservice.verifwebsitepro.workers.dev";
  let tempMailDomain = env.TEMPMAIL_DOMAIN || "ifqy.net";
  if (tempMailDomain.startsWith("temp.")) {
    tempMailDomain = tempMailDomain.slice(5);
  }

  const useProxy = parseBool(env.USE_PROXY, true);
  const proxyReuse = parseBool(env.PROXY_REUSE, false);
  const limit = Math.max(0, parseInt(env.LIMIT || "0", 10) || 0);
  const authMethod: "tempmail" | "google" = env.GPT_AUTH === "google" || env.AUTH_METHOD === "google" ? "google" : "tempmail";

  // Auto-resolve proxy seed
  let seedProxy = env.SEED_PROXY || "proxy-live.txt";
  if (!fs.existsSync(seedProxy) && fs.existsSync("proxy.txt")) {
    seedProxy = "proxy.txt";
  }

  // Auto-resolve optional accounts file (for Google OAuth fallback)
  let seedAccounts = env.SEED_ACCOUNTS;
  if (!seedAccounts && authMethod === "google") {
    if (fs.existsSync("gpt-dataset/gsuite.txt")) {
      seedAccounts = "gpt-dataset/gsuite.txt";
    } else if (fs.existsSync("gsuite.txt")) {
      seedAccounts = "gsuite.txt";
    }
  }

  const stateFile = env.GPT_STATE_FILE || env.STATE_FILE || "state-gpt.jsonl";
  const resultSuccessFile = env.GPT_RESULT_SUCCESS_FILE || "akun-gpt.txt";
  const resultFailedFile = env.GPT_RESULT_FAILED_FILE || "akun-gpt-failed.txt";
  const screenshotDir = env.GPT_SCREENSHOT_DIR || env.SCREENSHOT_DIR || "screenshots-gpt";

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
    screenshotDir,
  };
}

export function ensureDirs(cfg: GptConfig): void {
  const dirs = [
    path.dirname(path.resolve(cfg.stateFile)),
    path.dirname(path.resolve(cfg.resultSuccessFile)),
    path.dirname(path.resolve(cfg.resultFailedFile)),
    path.resolve(cfg.screenshotDir),
  ];
  for (const dir of dirs) {
    if (dir && !fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {}
    }
  }
}
