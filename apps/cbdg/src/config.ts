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
 * How far to take an account.
 *
 * `signup` stops right after registration, so the account keeps its new-user
 * welcome credits and no card is ever submitted. Nothing downstream of
 * COMPLETE_REGISTER runs, and vcc.txt is not needed at all.
 *
 * `full` continues into payment profile, the card form, 3DS and the trial.
 */
export type RunMode = "signup" | "full";

export function isRunMode(v: unknown): v is RunMode {
  return v === "signup" || v === "full";
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
  region: string;
  workers: number;
  headless: boolean;
  /** how far to take each account: signup-only or the full card flow */
  mode: RunMode;
  /** UI cadence: fast | human | careful */
  pace: PaceName;
  /** seconds to hold for manual 3DS verification */
  wait3dsTimeoutSec: number;
  /** seconds to wait for the payment/Midas link-card page */
  linkCardTimeoutSec: number;
  /** seconds to wait for the credit banner */
  creditVerifyTimeoutSec: number;
  /** seconds to wait after the "payment profile" navigation for harvestsharp token */
  openPaymentTimeoutSec: number;
  maxRetry: number;
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
  /**
   * Let one proxy address serve several accounts. Off by default: one account
   * per address is the whole reason the pool exists, and quietly doubling up
   * links two accounts together for the platform's risk engine.
   */
  reuseProxy: boolean;
  googleDirect: boolean;
  /** hosts sent direct; empty falls back to the library's Google auth list */
  googleDirectHosts: string[];
  seedGsuite: string;
  seedVcc: string;
  seedProxy: string;
  stateFile: string;
  resultSuccessFile: string;
  resultFailedFile: string;
  screenshotDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const cwd = process.cwd();
  return {
    region: (env.REGION || "SG").toUpperCase(),
    workers: int(env.WORKERS, 1),
    headless: parseBool(env.HEADLESS, false),
    mode: isRunMode(env.MODE) ? env.MODE : "full",
    pace: isPaceName(env.PACE) ? env.PACE : "human",
    wait3dsTimeoutSec: int(env.WAIT_3DS_TIMEOUT_SEC, 180),
    linkCardTimeoutSec: int(env.LINK_CARD_TIMEOUT_SEC, 180),
    creditVerifyTimeoutSec: int(env.CREDIT_VERIFY_TIMEOUT_SEC, 60),
    openPaymentTimeoutSec: int(env.OPEN_PAYMENT_TIMEOUT_SEC, 120),
    maxRetry: int(env.MAX_RETRY_PER_ACCOUNT, 1),
    retryFailed: parseBool(env.RETRY_FAILED, false),
    interAccountDelaySec: int(env.INTER_ACCOUNT_DELAY_SEC, 0),
    useProxy: parseBool(env.USE_PROXY, true),
    reuseProxy: parseBool(env.PROXY_REUSE, false),
    googleDirect: parseBool(env.GOOGLE_DIRECT, true),
    googleDirectHosts: (env.GOOGLE_DIRECT_HOSTS || "")
      .split(/[;,\s]+/)
      .map((h) => h.trim())
      .filter(Boolean),
    seedGsuite: resolve(env.SEED_GSUITE || path.join(cwd, "gsuite.txt")),
    seedVcc: resolve(env.SEED_VCC || path.join(cwd, "vcc.txt")),
    seedProxy: resolveProxySeed(cwd, env.SEED_PROXY),
    stateFile: resolve(env.STATE_FILE || path.join(cwd, "state.jsonl")),
    resultSuccessFile: resolve(env.RESULT_SUCCESS_FILE || path.join(cwd, "akun-result.txt")),
    resultFailedFile: resolve(env.RESULT_FAILED_FILE || path.join(cwd, "akun-failed.txt")),
    screenshotDir: resolve(env.SCREENSHOT_DIR || path.join(cwd, "screenshots")),
  };
}

export function ensureDirs(cfg: AppConfig): void {
  fs.mkdirSync(path.dirname(cfg.resultSuccessFile), { recursive: true });
  fs.mkdirSync(path.dirname(cfg.resultFailedFile), { recursive: true });
  fs.mkdirSync(cfg.screenshotDir, { recursive: true });
}