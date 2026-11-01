import fs from "node:fs";
import path from "node:path";
import { resolvePace, type Pace, type PaceName } from "@ifqy/google-oauth";

export const DEFAULT_SIGNUP_URL = "https://zro.moonmath.ai/sign-up";
export const VERIFY_EMAIL_URL = "https://zro.moonmath.ai/sign-up/create/verify-email-address";
export const LEGAL_CONSENT_URL = "https://zro.moonmath.ai/sign-up/create/continue";
export const DASHBOARD_URL = "https://zro.moonmath.ai/overview";
export const API_KEYS_URL = "https://zro.moonmath.ai/api-keys";

export interface ZroMoonmathConfig {
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ZroMoonmathConfig {
  const workers = Math.max(1, parseInt(env.WORKERS || "1", 10) || 1);
  const headless = parseBool(env.HEADLESS, true);
  const pace = resolvePace(env.PACE as PaceName);
  const retryFailed = parseBool(env.RETRY_FAILED, false);
  const interAccountDelaySec = Math.max(0, parseInt(env.INTER_ACCOUNT_DELAY_SEC || "2", 10) || 0);

  const defaultPassword = env.ZRO_PASSWORD || env.DEFAULT_PASSWORD || "torabikA1###########";
  const tempMailApiKey = env.TEMPMAIL_API_KEY || "anjingmemekkontol";
  const tempMailBaseUrl = env.TEMPMAIL_BASE_URL || "https://temp-postservice.verifwebsitepro.workers.dev";
  let tempMailDomain = env.TEMPMAIL_DOMAIN || "ifqy.net";
  if (tempMailDomain.startsWith("temp.")) {
    tempMailDomain = tempMailDomain.slice(5);
  }

  const useProxy = parseBool(env.USE_PROXY, true);
  const proxyReuse = parseBool(env.PROXY_REUSE, false);
  const limit = Math.max(0, parseInt(env.LIMIT || "0", 10) || 0);
  const authMethod: "google" | "tempmail" = env.ZRO_AUTH === "google" || env.AUTH_METHOD === "google" ? "google" : "tempmail";

  // Auto-resolve proxy seed
  let seedProxy = env.SEED_PROXY || "proxy-live.txt";
  if (!fs.existsSync(seedProxy) && fs.existsSync("proxy.txt")) {
    seedProxy = "proxy.txt";
  }

  // Auto-resolve optional accounts file ONLY for Google OAuth
  let seedAccounts = env.SEED_ACCOUNTS;
  if (!seedAccounts && authMethod === "google") {
    if (fs.existsSync("zromoonshotai-dataset/gsuite.txt")) {
      seedAccounts = "zromoonshotai-dataset/gsuite.txt";
    } else if (fs.existsSync("gsuite.txt")) {
      seedAccounts = "gsuite.txt";
    }
  }

  const stateFile = env.ZRO_STATE_FILE || env.STATE_FILE || "state-zro.jsonl";
  const resultSuccessFile = env.ZRO_RESULT_SUCCESS_FILE || "akun-result-zro.txt";
  const resultFailedFile = env.ZRO_RESULT_FAILED_FILE || "akun-failed-zro.txt";
  const apiKeyFile = env.ZRO_API_KEY_FILE || env.API_KEY_FILE || "apikey-zro.txt";
  const screenshotDir = env.ZRO_SCREENSHOT_DIR || env.SCREENSHOT_DIR || "screenshots-zromoonmath";

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

export function ensureDirs(cfg: ZroMoonmathConfig): void {
  const dirs = [cfg.screenshotDir, path.dirname(cfg.stateFile), path.dirname(cfg.resultSuccessFile), path.dirname(cfg.apiKeyFile)];
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
