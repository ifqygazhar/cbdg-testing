// ── App config (Bun-native — reads .env automatically) ─────────────
import fs from "node:fs";
import path from "node:path";
import { isPaceName, type PaceName } from "@ifqy/google-oauth";

export function parseBool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "y", "on"].includes(String(v).toLowerCase());
}
function int(v: string | undefined, def: number): number {
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}
function resolve(p: string): string {
  return path.resolve(process.cwd(), p);
}

export function resolveProxySeed(cwd: string, explicit?: string): string {
  if (explicit) return resolve(explicit);
  const live = path.join(cwd, "proxy-live.txt");
  return fs.existsSync(live) ? live : path.join(cwd, "proxy.txt");
}

export interface AppConfig {
  workers: number;
  headless: boolean;
  pace: PaceName;
  retryFailed: boolean;
  interAccountDelaySec: number;
  useProxy: boolean;
  reuseProxy: boolean;
  googleDirect: boolean;
  googleDirectHosts: string[];
  signupFormTimeoutSec: number;
  welcomeTimeoutSec: number;
  apiKeyTimeoutSec: number;
  creditsTimeoutSec: number;
  seedGsuite: string;
  seedProxy: string;
  stateFile: string;
  resultSuccessFile: string;
  resultFailedFile: string;
  apiKeyFile: string;
  screenshotDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const cwd = process.cwd();
  return {
    workers: int(env.WORKERS, 1),
    headless: parseBool(env.HEADLESS, false),
    pace: isPaceName(env.PACE) ? env.PACE : "human",
    retryFailed: parseBool(env.RETRY_FAILED, false),
    interAccountDelaySec: int(env.INTER_ACCOUNT_DELAY_SEC, 0),
    useProxy: parseBool(env.USE_PROXY, true),
    reuseProxy: parseBool(env.PROXY_REUSE, false),
    googleDirect: parseBool(env.GOOGLE_DIRECT, true),
    googleDirectHosts: (env.GOOGLE_DIRECT_HOSTS || "")
      .split(/[;,\s]+/)
      .map((h) => h.trim())
      .filter(Boolean),
    signupFormTimeoutSec: int(env.FASTROUTER_SIGNUP_TIMEOUT_SEC, 45),
    welcomeTimeoutSec: int(env.FASTROUTER_WELCOME_TIMEOUT_SEC, 60),
    apiKeyTimeoutSec: int(env.FASTROUTER_API_KEY_TIMEOUT_SEC, 180),
    creditsTimeoutSec: int(env.FASTROUTER_CREDITS_TIMEOUT_SEC, 30),
    seedGsuite: resolve(env.SEED_GSUITE || path.join(cwd, "gsuite.txt")),
    seedProxy: resolveProxySeed(cwd, env.SEED_PROXY),
    stateFile: resolve(env.FASTROUTER_STATE_FILE || path.join(cwd, "state-fastrouter.jsonl")),
    resultSuccessFile: resolve(env.FASTROUTER_RESULT_SUCCESS_FILE || path.join(cwd, "akun-result-fastrouter.txt")),
    resultFailedFile: resolve(env.FASTROUTER_RESULT_FAILED_FILE || path.join(cwd, "akun-failed-fastrouter.txt")),
    apiKeyFile: resolve(env.FASTROUTER_APIKEY_FILE || path.join(cwd, "apikey-fastrouter.txt")),
    screenshotDir: resolve(env.FASTROUTER_SCREENSHOT_DIR || path.join(cwd, "screenshots-fastrouter")),
  };
}

export function ensureDirs(cfg: AppConfig): void {
  fs.mkdirSync(path.dirname(cfg.resultSuccessFile), { recursive: true });
  fs.mkdirSync(path.dirname(cfg.resultFailedFile), { recursive: true });
  fs.mkdirSync(path.dirname(cfg.apiKeyFile), { recursive: true });
  fs.mkdirSync(cfg.screenshotDir, { recursive: true });
}
