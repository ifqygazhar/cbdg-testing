// ── Resumable state machine for Composite Lucidity automation ─────
import type { Page } from "puppeteer-core";
import { FlowState, type JsonlStore, type ResultWriter } from "../store.js";
import type { CompositeConfig } from "../config.js";
import type { ULog } from "../log.js";
import {
  stepNavigateSignup,
  stepFillRegistration,
  stepWaitForTurnstile,
  stepSubmitRegistration,
  stepNavigateApiKeys,
  stepCreateApiKey,
} from "./steps.js";

export interface CompositeSession {
  email: string;
  password?: string;
  username?: string;
  apiKey?: string;
}

export async function runCompositeFlow(
  page: Page,
  session: CompositeSession,
  cfg: CompositeConfig,
  store: JsonlStore,
  results: ResultWriter,
  log: ULog,
): Promise<{ success: boolean; apiKey?: string; error?: string }> {
  const email = session.email;

  try {
    // ── 1. SIGNUP FORM ──────────────────────────────────────────────
    store.setStatus(email, FlowState.SIGNUP);
    await stepNavigateSignup(page, log);
    const { username, password } = await stepFillRegistration(page, email, cfg, log);
    session.username = username;
    session.password = password;

    // ── 2. SOLVE / WAIT FOR TURNSTILE ───────────────────────────────
    await stepWaitForTurnstile(page, log, 25000);

    // ── 3. SUBMIT REGISTRATION ──────────────────────────────────────
    await stepSubmitRegistration(page, log);
    store.setStatus(email, FlowState.DASHBOARD);

    // ── 4. NAVIGATE TO API KEYS ─────────────────────────────────────
    store.setStatus(email, FlowState.API_KEY);
    await stepNavigateApiKeys(page, log);

    // ── 5. CREATE & EXTRACT API KEY ─────────────────────────────────
    const apiKey = await stepCreateApiKey(page, log);
    session.apiKey = apiKey;

    // ── 6. DONE ────────────────────────────────────────────────────
    store.upsert({
      email,
      password: session.password,
      username: session.username,
      status: FlowState.DONE,
      apiKey,
      updatedAt: Date.now(),
    });
    results.markSuccess(email, session.password, apiKey);

    log("info", "Composite account completed successfully", {
      email,
      username: session.username,
      apiKey: `${apiKey.slice(0, 10)}...`,
    });
    return { success: true, apiKey };
  } catch (err) {
    const errorMsg = (err as Error).message || String(err);
    log("error", "Composite flow failed", { email, error: errorMsg });

    store.setStatus(email, FlowState.FAILED, errorMsg);
    results.markFailed(email, errorMsg);

    return { success: false, error: errorMsg };
  }
}
