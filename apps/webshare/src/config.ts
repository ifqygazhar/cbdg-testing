// ── App config (Bun-native — reads .env automatically) ─────────────
import fs from "node:fs";
import path from "node:path";
import { isPaceName, type PaceName } from "@ifqy/google-oauth";
import type { ProxyFormat } from "./store.js";

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

export interface AppConfig {
  workers: number;
  headless: boolean;
  /** reprocess accounts listed in akun-failed-webshare.txt on re-run */
  retryFailed: boolean;
  /** min seconds between accounts per worker (risk-control spacing, 0 = off) */
  interAccountDelaySec: number;
  /** UI cadence: fast | human | careful */
  pace: PaceName;
  /** seconds to wait for the dashboard to appear after OAuth */
  dashboardTimeoutSec: number;
  /** seconds to wait for the proxy list API response */
  proxyListTimeoutSec: number;
  /** how proxy.txt lines are written */
  proxyFormat: ProxyFormat;
  seedGsuite: string;
  /**
   * Optional proxies to run the SIGNUPS through. Deliberately a different file
   * from `proxyFile`: reusing freshly harvested webshare proxies to create the
   * next webshare account links the accounts together for their risk engine.
   */
  seedProxyForSignup: string;
  stateFile: string;
  resultSuccessFile: string;
  resultFailedFile: string;
  proxyFile: string;
  screenshotDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const cwd = process.cwd();
  return {
    workers: int(env.WORKERS, 1),
    headless: parseBool(env.HEADLESS, false),
    retryFailed: parseBool(env.RETRY_FAILED, false),
    interAccountDelaySec: int(env.INTER_ACCOUNT_DELAY_SEC, 0),
    pace: isPaceName(env.PACE) ? env.PACE : "human",
    dashboardTimeoutSec: int(env.DASHBOARD_TIMEOUT_SEC, 90),
    proxyListTimeoutSec: int(env.PROXY_LIST_TIMEOUT_SEC, 60),
    proxyFormat: env.WEBSHARE_PROXY_FORMAT === "webshare" ? "webshare" : "url",
    seedGsuite: resolve(env.SEED_GSUITE || path.join(cwd, "gsuite.txt")),
    seedProxyForSignup: resolve(env.WEBSHARE_SEED_PROXY || path.join(cwd, "signup-proxy.txt")),
    stateFile: resolve(env.WEBSHARE_STATE_FILE || path.join(cwd, "state-webshare.jsonl")),
    resultSuccessFile: resolve(env.WEBSHARE_RESULT_SUCCESS_FILE || path.join(cwd, "akun-result-webshare.txt")),
    resultFailedFile: resolve(env.WEBSHARE_RESULT_FAILED_FILE || path.join(cwd, "akun-failed-webshare.txt")),
    proxyFile: resolve(env.WEBSHARE_PROXY_FILE || path.join(cwd, "proxy.txt")),
    screenshotDir: resolve(env.WEBSHARE_SCREENSHOT_DIR || path.join(cwd, "screenshots-webshare")),
  };
}

export function ensureDirs(cfg: AppConfig): void {
  fs.mkdirSync(path.dirname(cfg.resultSuccessFile), { recursive: true });
  fs.mkdirSync(path.dirname(cfg.resultFailedFile), { recursive: true });
  fs.mkdirSync(path.dirname(cfg.proxyFile), { recursive: true });
  fs.mkdirSync(cfg.screenshotDir, { recursive: true });
}
