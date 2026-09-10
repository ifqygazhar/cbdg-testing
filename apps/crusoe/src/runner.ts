// ── Per-account runner: fingerprint → browser → flow → save key → close ──
import {
  launchGoogleOAuthBrowser,
  classifyNetworkError,
  GOOGLE_DIRECT_HOSTS,
  type GoogleOAuthOptions,
} from "@ifqy/google-oauth";
import { randomBytes } from "node:crypto";
import type { AppConfig } from "./config.js";
import type { GsuiteAccount, ProxySeed } from "./loaders.js";
import { createLog, type ULog } from "./log.js";
import { FlowState, type AccountRecord, type JsonlStore, type ResultWriter } from "./store.js";
import { FlowError, isTerminalState, transition } from "./flow/engine.js";

export async function runAccount(
  account: GsuiteAccount,
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
    pace: cfg.pace,
    // in headed mode allow manual captcha solving; in headless, fail fast
    failOnCaptcha: cfg.headless,
    screenShotDir: cfg.screenshotDir,
    log: log as ULog,
  };

  if (proxy && cfg.googleDirect) {
    log("info", `proxy ${proxy.server} dipakai untuk situsnya; google sign-in lewat koneksi langsung`);
  }

  const handle = await launchGoogleOAuthBrowser({
    proxy: proxy
      ? {
          server: proxy.server,
          username: proxy.username,
          password: proxy.password,
          // Google's sign-in is scored by the address it comes from, and a
          // shared datacenter proxy earns an image captcha at the email step.
          // Send just that surface direct; the site still sees the proxy.
          bypass: cfg.googleDirect
            ? cfg.googleDirectHosts.length
              ? cfg.googleDirectHosts
              : GOOGLE_DIRECT_HOSTS
            : undefined,
        }
      : null,
    headless: cfg.headless,
    opts: googleOAuth,
  });

  const apiKeyRef = { current: "" };
  const appPageRef: { current: import("puppeteer-core").Page | null } = { current: null };

  let state: FlowState = FlowState.SIGNUP;
  try {
    while (!isTerminalState(state)) {
      store.setStatus(account.email, state);
      state = await transition(state, {
        account,
        proxy,
        browser: handle,
        cfg,
        googleOAuth,
        log,
        appPageRef,
        apiKeyRef,
      });
    }
    store.setStatus(account.email, state);

    if (state === FlowState.DONE) {
      if (!apiKeyRef.current) throw new FlowError("NO_API_KEY_SAVED", "done but api key empty");
      results.markSuccess(account.email, apiKeyRef.current);
      log("info", `account DONE — api key saved to ${cfg.apiKeyFile}`);
    } else {
      // a step returned FAILED instead of throwing — record it gracefully
      log("warn", `account ended in ${state}`);
      results.markFailed(account.email, `STEP_RETURNED_${state}`);
    }
  } catch (e) {
    const err = e as Error;
    // A raw net::ERR_* says nothing actionable; name the proxy problem instead.
    const network = (e as FlowError)?.code ? null : classifyNetworkError(err.message, proxy?.server);
    const code = network?.code ?? (e as FlowError)?.code ?? "UNKNOWN";
    const message = network ? `${network.message} [${err.message.split(" at ")[0]}]` : err.message;
    log("error", `flow failed [${code}]: ${message}`, { code });
    store.setStatus(account.email, FlowState.FAILED, `${code}: ${message}`);
    results.markFailed(account.email, `${code}: ${message}`);
    state = FlowState.FAILED;
  } finally {
    // constraint: ALWAYS close the browser so the next account gets a fresh fingerprint
    await handle.close().catch(() => {});
    log("info", "browser closed");
  }

  return state;
}