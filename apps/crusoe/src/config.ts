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

/**
 * Which proxy file to read. `proxy-live.txt` is written by `bun run proxy-check`
 * and holds only proxies that actually answered from somebody else's IP, so it
 * is preferred when present; the raw harvest is the fallback so a first run
 * before any check still works.
 */
export function resolveProxySeed(cwd: string, explicit?: string): string {
  if (explicit) return resolve(explicit);
  const live = path.join(cwd, "proxy-live.txt");
  return fs.existsSync(live) ? live : path.join(cwd, "proxy.txt");
}

export interface AppConfig {
  workers: number;
  headless: boolean;
  /**
   * UI cadence. "fast" keeps human-shaped typing and clicking but stops
   * waiting for things that already happened; "careful" slows everything for
   * a hostile risk engine. It does NOT change inter-account spacing — that is
   * `interAccountDelaySec`, and it is the setting risk control actually sees.
   */
  pace: PaceName;
  /** reprocess accounts listed in akun-failed.txt on re-run */
  retryFailed: boolean;
  /** min seconds between accounts per worker (risk-control spacing, 0 = off) */
  interAccountDelaySec: number;
  /**
   * Read proxies from the seed file at all. Off means every account runs from
   * this machine's IP on purpose, which is the right choice while the proxy
   * pool is empty or suspect, and the wrong one for a long batch.
   */
  useProxy: boolean;
  /**
   * Let Google's sign-in reach us directly even when the run is proxied.
   * Google serves an image captcha to shared datacenter addresses; the site
   * being automated still sees the proxy. Off means everything goes through
   * the proxy, captcha included.
   */
  googleDirect: boolean;
  /** hosts sent direct; empty falls back to the library's Google auth list */
  googleDirectHosts: string[];
  /** seconds to wait for the complete-signup form after OAuth */
  signupFormTimeoutSec: number;
  /** seconds to wait for the API-key create form / onboarding */
  apiKeyTimeoutSec: number;
  /** seconds to wait for the $5 bonus credit banner */
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
    googleDirect: parseBool(env.GOOGLE_DIRECT, true),
    googleDirectHosts: (env.GOOGLE_DIRECT_HOSTS || "")
      .split(/[;,\s]+/)
      .map((h) => h.trim())
      .filter(Boolean),
    signupFormTimeoutSec: int(env.SIGNUP_FORM_TIMEOUT_SEC, 45),
    apiKeyTimeoutSec: int(env.API_KEY_TIMEOUT_SEC, 180),
    creditsTimeoutSec: int(env.CREDITS_TIMEOUT_SEC, 30),
    seedGsuite: resolve(env.SEED_GSUITE || path.join(cwd, "gsuite.txt")),
    seedProxy: resolveProxySeed(cwd, env.SEED_PROXY),
    stateFile: resolve(env.CRUSOE_STATE_FILE || path.join(cwd, "state-crusoe.jsonl")),
    resultSuccessFile: resolve(env.CRUSOE_RESULT_SUCCESS_FILE || path.join(cwd, "akun-result-crusoe.txt")),
    resultFailedFile: resolve(env.CRUSOE_RESULT_FAILED_FILE || path.join(cwd, "akun-failed-crusoe.txt")),
    apiKeyFile: resolve(env.CRUSOE_APIKEY_FILE || path.join(cwd, "apikey.txt")),
    screenshotDir: resolve(env.CRUSOE_SCREENSHOT_DIR || path.join(cwd, "screenshots-crusoe")),
  };
}

export function ensureDirs(cfg: AppConfig): void {
  fs.mkdirSync(path.dirname(cfg.resultSuccessFile), { recursive: true });
  fs.mkdirSync(path.dirname(cfg.resultFailedFile), { recursive: true });
  fs.mkdirSync(path.dirname(cfg.apiKeyFile), { recursive: true });
  fs.mkdirSync(cfg.screenshotDir, { recursive: true });
}