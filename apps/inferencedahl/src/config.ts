import fs from "node:fs";
import path from "node:path";
import { resolvePace, type Pace, type PaceName } from "@ifqy/google-oauth";

export interface InferenceDahlConfig {
  workers: number;
  headless: boolean;
  pace: Pace;
  retryFailed: boolean;
  interAccountDelaySec: number;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): InferenceDahlConfig {
  const workers = Math.max(1, parseInt(env.WORKERS || "1", 10) || 1);
  const headless = parseBool(env.HEADLESS, true);
  const pace = resolvePace(env.PACE as PaceName);
  const retryFailed = parseBool(env.RETRY_FAILED, false);
  const interAccountDelaySec = Math.max(0, parseInt(env.INTER_ACCOUNT_DELAY_SEC || "2", 10) || 0);

  const useProxy = parseBool(env.USE_PROXY, true);
  const proxyReuse = parseBool(env.PROXY_REUSE, false);
  const limit = Math.max(0, parseInt(env.LIMIT || "0", 10) || 0);

  // Auto-resolve proxy seed
  let seedProxy = env.SEED_PROXY || "proxy-live.txt";
  if (!fs.existsSync(seedProxy) && fs.existsSync("proxy.txt")) {
    seedProxy = "proxy.txt";
  }

  const stateFile = env.INFERENCEDAhl_STATE_FILE || env.STATE_FILE || "state-inferencedahl.jsonl";
  const resultSuccessFile = env.INFERENCEDAHL_RESULT_SUCCESS_FILE || "akun-result-inferencedahl.txt";
  const resultFailedFile = env.INFERENCEDAHL_RESULT_FAILED_FILE || "akun-failed-inferencedahl.txt";
  const apiKeyFile = env.INFERENCEDAHL_API_KEY_FILE || env.API_KEY_FILE || "apikey-inferencedahl.txt";
  const screenshotDir = env.INFERENCEDAHL_SCREENSHOT_DIR || env.SCREENSHOT_DIR || "screenshots-inferencedahl";

  return {
    workers,
    headless,
    pace,
    retryFailed,
    interAccountDelaySec,
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

export function ensureDirs(cfg: InferenceDahlConfig): void {
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
