// ── Resumable state machine for TokenHarbor automation ──────────────
import type { Page } from "puppeteer-core";
import { FlowState, type JsonlStore, type ResultWriter } from "../store.js";
import type { TokenHarborConfig } from "../config.js";
import type { ULog } from "../log.js";
import { TempMailClient } from "@ifqy/google-oauth";
import {
  type AccountSession,
  stepSignUp,
  stepEnableFreeModels,
  stepTriggerVerification,
  stepVerifyEmail,
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

export async function runTokenHarborFlow(
  page: Page,
  session: AccountSession,
  cfg: TokenHarborConfig,
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

    // ── 2. DASHBOARD & FREE MODELS ─────────────────────────────────
    store.setStatus(email, FlowState.DASHBOARD);
    await stepEnableFreeModels(page, log);
    store.setStatus(email, FlowState.FREE_MODELS);

    // ── 3. TRIGGER EMAIL VERIFICATION ──────────────────────────────
    store.setStatus(email, FlowState.TRIGGER_VERIFY);
    await stepTriggerVerification(page, log);

    // ── 4. EMAIL VERIFIED VIA TEMPMAIL ─────────────────────────────
    const verifyLink = await stepVerifyEmail(page, email, tempMail, log);
    session.verificationLink = verifyLink;
    store.upsert({
      email,
      password: session.password,
      status: FlowState.EMAIL_VERIFIED,
      verificationLink: verifyLink,
      updatedAt: Date.now(),
    });

    // ── 5. CREATE API KEY ──────────────────────────────────────────
    store.setStatus(email, FlowState.API_KEY);
    const apiKey = await stepCreateApiKey(page, session, cfg, log);

    // ── 6. DONE ────────────────────────────────────────────────────
    store.upsert({
      email,
      password: session.password,
      status: FlowState.DONE,
      apiKey,
      verificationLink: verifyLink,
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
