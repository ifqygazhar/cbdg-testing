// ── App config (Bun-native — reads .env automatically) ─────────────
import fs from "node:fs";
import path from "node:path";

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
  region: string;
  workers: number;
  headless: boolean;
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
    wait3dsTimeoutSec: int(env.WAIT_3DS_TIMEOUT_SEC, 180),
    linkCardTimeoutSec: int(env.LINK_CARD_TIMEOUT_SEC, 180),
    creditVerifyTimeoutSec: int(env.CREDIT_VERIFY_TIMEOUT_SEC, 60),
    openPaymentTimeoutSec: int(env.OPEN_PAYMENT_TIMEOUT_SEC, 120),
    maxRetry: int(env.MAX_RETRY_PER_ACCOUNT, 1),
    retryFailed: parseBool(env.RETRY_FAILED, false),
    interAccountDelaySec: int(env.INTER_ACCOUNT_DELAY_SEC, 0),
    seedGsuite: resolve(env.SEED_GSUITE || path.join(cwd, "gsuite.txt")),
    seedVcc: resolve(env.SEED_VCC || path.join(cwd, "vcc.txt")),
    seedProxy: resolve(env.SEED_PROXY || path.join(cwd, "proxy.txt")),
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