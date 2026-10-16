// ── Resumable state machine for Inferbase automation ──────────────
import type { Page } from "puppeteer-core";
import { FlowState, type JsonlStore, type ResultWriter } from "../store.js";
import type { InferbaseConfig } from "../config.js";
import type { ULog } from "../log.js";
import { TempMailClient } from "@ifqy/google-oauth";
import {
  type AccountSession,
  stepSignUp,
  stepVerifyEmail,
  stepOnboarding,
  stepCreateApiKey,
} from "./steps.js";

export class FlowError extends Error {
  constructor(
    message: string,
    public readonly code: string = "FLOW_ERROR",
  ) {
    super(message);
    this.name = "FlowError";
  }
}

export async function runInferbaseFlow(
  page: Page,
  session: AccountSession,
  cfg: InferbaseConfig,
  store: JsonlStore,
  results: ResultWriter,
  tempMail: TempMailClient,
  log: ULog,
): Promise<{ success: boolean; apiKey?: string; error?: string }> {
  const email = session.email;

  try {
    // ── 1. SIGNUP ───────────────────────────────────────────────────
    store.setStatus(email, FlowState.SIGNUP);
    await stepSignUp(page, session, cfg, log);

    // ── 2. EMAIL VERIFICATION (for TempMail) ─────────────────────────
    if (cfg.authMethod === "tempmail") {
      const verifyLink = await stepVerifyEmail(page, email, tempMail, log);
      session.verificationLink = verifyLink;
      store.upsert({
        email,
        password: session.password,
        status: FlowState.EMAIL_VERIFIED,
        verificationLink: verifyLink,
        updatedAt: Date.now(),
      });
    }

    // ── 3. ONBOARDING SURVEY & DASHBOARD ───────────────────────────
    store.setStatus(email, FlowState.ONBOARDING);
    await stepOnboarding(page, log);
    store.setStatus(email, FlowState.DASHBOARD);

    // ── 4. CREATE API KEY ──────────────────────────────────────────
    store.setStatus(email, FlowState.API_KEY);
    const apiKey = await stepCreateApiKey(page, session, cfg, log);
    session.apiKey = apiKey;

    // ── 5. DONE ────────────────────────────────────────────────────
    store.upsert({
      email,
      password: session.password,
      status: FlowState.DONE,
      apiKey,
      verificationLink: session.verificationLink,
      updatedAt: Date.now(),
    });
    results.markSuccess(email, session.password, apiKey);

    log("info", "account completed successfully", { email, apiKey: `${apiKey.slice(0, 10)}...` });
    return { success: true, apiKey };
  } catch (err) {
    const errorMsg = (err as Error).message || String(err);
    log("error", "flow failed", { email, error: errorMsg });

    store.setStatus(email, FlowState.FAILED, errorMsg);
    results.markFailed(email, errorMsg);

    return { success: false, error: errorMsg };
  }
}
