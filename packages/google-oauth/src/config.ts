// ── Library config ─────────────────────────────────────────────────
// Reusable: callers override what they need; defaults mirror the
// battle-tested cline-regist settings. Bun loads .env automatically.

import process from "node:process";
import path from "node:path";
import { resolvePace, isPaceName, type Pace, type PaceName } from "./pace.js";

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "y", "on"].includes(String(v).toLowerCase());
}
function int(v: string | undefined, def: number): number {
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export interface GoogleOAuthOptions {
  headless?: boolean;
  /**
   * How fast to drive the UI. "fast" keeps human-shaped typing and clicking
   * but stops waiting for things that already happened; "careful" slows
   * everything down for hostile risk engines. Default "human".
   */
  pace?: PaceName | Pace;
  /** max time to leave the Google domain after password (consent screens) */
  consentTimeoutMs?: number;
  /** max time looking for the password field */
  passwordTimeoutMs?: number;
  /** max time waiting for the google sign-in popup/page */
  signinTimeoutMs?: number;
  /** max time to solve a captcha manually in headed mode */
  captchaTimeoutMs?: number;
  /** if true, throw when a captcha appears (avoids hanging) */
  failOnCaptcha?: boolean;
  /**
   * When the Google provider button is not found yet, click generic
   * "login / sign in / sign up" text as a fallback (needed on sites where
   * the provider buttons live behind a login route). Set false for sites
   * that render the Google button on the landing page itself — there the
   * fallback only wanders the SPA (e.g. crusoe's "Already have an account?
   * Login" link) and destroys the page we were waiting on.
   */
  genericAuthTextClick?: boolean;
  /** human-typing delay bounds */
  typeDelayMin?: number;
  typeDelayMax?: number;
  screenShotDir?: string;
  log?: (level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) => void;
}

export function resolveGoogleOAuthOptions(overrides: GoogleOAuthOptions = {}): GoogleOAuthOptions {
  const env = process.env;
  const pace = resolvePace(
    overrides.pace ?? (isPaceName(env.GOOGLE_OAUTH_PACE) ? env.GOOGLE_OAUTH_PACE : undefined),
  );
  return {
    headless: overrides.headless ?? bool(env.GOOGLE_OAUTH_HEADLESS, false),
    pace,
    consentTimeoutMs: overrides.consentTimeoutMs ?? int(env.GOOGLE_OAUTH_CONSENT_MS, 90_000),
    passwordTimeoutMs: overrides.passwordTimeoutMs ?? int(env.GOOGLE_OAUTH_PASSWORD_MS, 60_000),
    signinTimeoutMs: overrides.signinTimeoutMs ?? int(env.GOOGLE_OAUTH_SIGNIN_MS, 30_000),
    captchaTimeoutMs: overrides.captchaTimeoutMs ?? int(env.GOOGLE_OAUTH_CAPTCHA_MS, 3 * 60_000),
    failOnCaptcha: overrides.failOnCaptcha ?? bool(env.GOOGLE_OAUTH_FAIL_ON_CAPTCHA, true),
    genericAuthTextClick:
      overrides.genericAuthTextClick ?? bool(env.GOOGLE_OAUTH_GENERIC_AUTH_CLICK, true),
    typeDelayMin: overrides.typeDelayMin ?? int(env.GOOGLE_OAUTH_TYPE_MIN, pace.typeMin),
    typeDelayMax: overrides.typeDelayMax ?? int(env.GOOGLE_OAUTH_TYPE_MAX, pace.typeMax),
    screenShotDir: overrides.screenShotDir ?? path.resolve(process.cwd(), "screenshots"),
    log:
      overrides.log ??
      ((level, msg, meta) => {
        if (level === "error") console.error(`[google-oauth] ${msg}`, meta ?? "");
        else console.log(`[google-oauth] ${msg}`, meta ?? "");
      }),
  };
}