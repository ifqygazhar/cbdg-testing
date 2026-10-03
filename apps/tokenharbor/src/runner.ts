// ── Per-account runner for TokenHarbor ───────────────────────────────
import { launchGoogleOAuthBrowser, TempMailClient } from "@ifqy/google-oauth";
import { randomBytes } from "node:crypto";
import type { TokenHarborConfig } from "./config.js";
import { createLog } from "./log.js";
import { FlowState, type AccountRecord, type JsonlStore, type ResultWriter } from "./store.js";
import { runTokenHarborFlow } from "./flow/engine.js";
import type { AccountSession } from "./flow/steps.js";

function parseProxyString(proxyStr: string | null | undefined) {
  if (!proxyStr) return null;
  try {
    const u = new URL(proxyStr.includes("://") ? proxyStr : `http://${proxyStr}`);
    return {
      server: `${u.protocol}//${u.host}`,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } catch {
    return { server: proxyStr };
  }
}

export async function runTokenHarborAccount(
  givenAccount: { email?: string; password?: string } | null,
  proxyStr: string | null,
  store: JsonlStore,
  results: ResultWriter,
  cfg: TokenHarborConfig,
): Promise<{ success: boolean; email: string; apiKey?: string; error?: string }> {
  const tempMail = new TempMailClient({
    apiKey: cfg.tempMailApiKey,
    baseUrl: cfg.tempMailBaseUrl,
    defaultDomain: cfg.tempMailDomain,
  });

  // 1. Resolve email & password (generate via TempMail if none provided)
  let email = givenAccount?.email;
  const password = givenAccount?.password || cfg.defaultPassword;

  if (!email) {
    const created = await tempMail.createEmail(cfg.tempMailDomain);
    email = created.email;
  }

  const log = createLog({ email });
  const fingerprint = randomBytes(8).toString("hex");

  store.upsert({
    email,
    password,
    status: FlowState.PENDING,
    fingerprint,
    proxy: proxyStr ?? undefined,
    updatedAt: Date.now(),
  } as AccountRecord);

  const proxySpec = parseProxyString(proxyStr);
  log("info", "launching browser for TokenHarbor account", {
    email,
    proxy: proxySpec ? proxySpec.server : "direct",
    headless: cfg.headless,
  });

  let handle: Awaited<ReturnType<typeof launchGoogleOAuthBrowser>> | null = null;
  try {
    handle = await launchGoogleOAuthBrowser({
      proxy: proxySpec,
      headless: cfg.headless,
      opts: {
        screenShotDir: cfg.screenshotDir,
      },
    });

    const session: AccountSession = { email, password };
    const res = await runTokenHarborFlow(handle.page, session, cfg, store, results, tempMail, log);
    return { success: res.success, email, apiKey: res.apiKey, error: res.error };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    log("error", "fatal runner error", { email, error: msg });
    store.setStatus(email, FlowState.FAILED, msg);
    results.markFailed(email, msg);
    return { success: false, email, error: msg };
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}
