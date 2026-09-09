// ── Per-account runner: fingerprint → browser → flow → result → close ──
import {
  launchGoogleOAuthBrowser,
  type GoogleOAuthOptions,
} from "@ifqy/google-oauth";
import { randomBytes } from "node:crypto";
import type { AppConfig } from "./config.js";
import type { GsuiteAccount, ProxySeed, VccCard } from "./loaders.js";
import { createLog, type ULog } from "./log.js";
import { FlowState, type AccountRecord, type JsonlStore, type ResultWriter } from "./store.js";
import { FlowError, isTerminalState, transition } from "./flow/engine.js";

export async function runAccount(
  account: GsuiteAccount,
  card: VccCard,
  proxy: ProxySeed | null,
  store: JsonlStore,
  results: ResultWriter,
  cfg: AppConfig,
): Promise<FlowState> {
  const log = createLog({ email: account.email });
  // 1 fresh launch per account = 1 fresh stealth fingerprint (constraint).
  const fingerprint = randomBytes(8).toString("hex");

  store.upsert({
    email: account.email,
    password: account.password,
    status: FlowState.PENDING,
    fingerprint,
    proxy: proxy?.server ?? undefined,
    updatedAt: Date.now(),
  } as AccountRecord);

  const googleOAuth: GoogleOAuthOptions = {
    headless: cfg.headless,
    // in headed mode allow manual captcha solving; in headless, fail fast
    failOnCaptcha: cfg.headless,
    screenShotDir: cfg.screenshotDir,
    log: log as ULog,
  };

  const handle = await launchGoogleOAuthBrowser({
    proxy: proxy ? { server: proxy.server } : null,
    headless: cfg.headless,
    opts: googleOAuth,
  });

  let state: FlowState = FlowState.PRICING;
  try {
    while (!isTerminalState(state)) {
      store.setStatus(account.email, state);
      state = await transition(state, {
        account,
        card,
        proxy,
        browser: handle,
        cfg,
        googleOAuth,
        log,
      });
    }
    store.setStatus(account.email, state);

    if (state === FlowState.DONE) {
      results.markSuccess(account.email, cfg.region);
      log("info", "account DONE");
    } else {
      // a step returned FAILED instead of throwing — record it gracefully
      log("warn", `account ended in ${state}`);
      results.markFailed(account.email, `STEP_RETURNED_${state}`);
    }
  } catch (e) {
    const err = e as Error;
    const code = (e as FlowError)?.code ?? "UNKNOWN";
    log("error", `flow failed [${code}]: ${err.message}`, { code });
    store.setStatus(account.email, FlowState.FAILED, `${code}: ${err.message}`);
    results.markFailed(account.email, `${code}: ${err.message}`);
    state = FlowState.FAILED;
  } finally {
    // constraint: ALWAYS close the browser so the next account gets a fresh fingerprint
    await handle.close().catch(() => {});
    log("info", "browser closed");
  }

  return state;
}