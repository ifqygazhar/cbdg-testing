import fs from "node:fs";
import path from "node:path";
import { resolvePace, type Pace, type PaceName } from "@ifqy/google-oauth";

export interface CompositeConfig {
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
  seedProxy: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CompositeConfig {
  const workers = Math.max(1, parseInt(env.WORKERS || "1", 10) || 1);
  const headless = parseBool(env.HEADLESS, true);
  const pace = resolvePace(env.PACE as PaceName);
  const retryFailed = parseBool(env.RETRY_FAILED, false);
  const interAccountDelaySec = Math.max(0, parseInt(env.INTER_ACCOUNT_DELAY_SEC || "2", 10) || 0);

  const defaultPassword = env.COMPOSITE_PASSWORD || "torabikA1###########";
  const tempMailApiKey = env.TEMPMAIL_API_KEY || "anjingmemekkontol";
  const tempMailBaseUrl = env.TEMPMAIL_BASE_URL || "https://temp-postservice.verifwebsitepro.workers.dev";
  let tempMailDomain = env.TEMPMAIL_DOMAIN || "ifqy.net";
  if (tempMailDomain.startsWith("temp.")) {
    tempMailDomain = tempMailDomain.slice(5);
  }

  const useProxy = parseBool(env.USE_PROXY, true);
  const proxyReuse = parseBool(env.PROXY_REUSE, false);
  const limit = Math.max(0, parseInt(env.LIMIT || "0", 10) || 0);

  // Auto-resolve proxy seed
  let seedProxy = env.SEED_PROXY || "proxy-live.txt";
  if (!fs.existsSync(seedProxy) && fs.existsSync("proxy.txt")) {
    seedProxy = "proxy.txt";
  }

  const stateFile = env.COMPOSITE_STATE_FILE || env.STATE_FILE || "state-composite.jsonl";
  const resultSuccessFile = env.COMPOSITE_RESULT_SUCCESS_FILE || "akun-result-composite.txt";
  const resultFailedFile = env.COMPOSITE_RESULT_FAILED_FILE || "akun-failed-composite.txt";
  const apiKeyFile = env.COMPOSITE_API_KEY_FILE || env.API_KEY_FILE || "apikey-composite.txt";
  const screenshotDir = env.COMPOSITE_SCREENSHOT_DIR || env.SCREENSHOT_DIR || "screenshots-composite";

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
    seedProxy,
    stateFile,
    resultSuccessFile,
    resultFailedFile,
    apiKeyFile,
    screenshotDir,
  };
}

export function ensureDirs(cfg: CompositeConfig): void {
  for (const f of [cfg.stateFile, cfg.resultSuccessFile, cfg.resultFailedFile, cfg.apiKeyFile]) {
    const dir = path.dirname(f);
    if (dir && dir !== "." && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  if (!fs.existsSync(cfg.screenshotDir)) {
    fs.mkdirSync(cfg.screenshotDir, { recursive: true });
  }
}
