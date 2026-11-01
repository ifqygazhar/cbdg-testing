// ── Resumable state machine for Zro MoonMath automation ─────────────
import type { Page } from "puppeteer-core";
import { FlowState, type JsonlStore, type ResultWriter } from "../store.js";
import type { ZroMoonmathConfig } from "../config.js";
import type { ULog } from "../log.js";
import { TempMailClient } from "@ifqy/google-oauth";
import {
  type AccountSession,
  stepSignUp,
  stepSubmitOtp,
  stepLegalConsent,
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

export async function runZroMoonmathFlow(
  page: Page,
  session: AccountSession,
  cfg: ZroMoonmathConfig,
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

    // ── 2. EMAIL OTP VERIFICATION (for TempMail) ────────────────────
    if (cfg.authMethod === "tempmail") {
      store.setStatus(email, FlowState.OTP_SENT);
      const otpCode = await stepSubmitOtp(page, session, tempMail, log);
      session.otpCode = otpCode;
      store.upsert({
        email,
        password: session.password,
        status: FlowState.EMAIL_VERIFIED,
        otpCode,
        updatedAt: Date.now(),
      });
    }

    // ── 3. LEGAL CONSENT & OVERVIEW ─────────────────────────────────
    store.setStatus(email, FlowState.LEGAL_ACCEPTED);
    await stepLegalConsent(page, log);
    store.setStatus(email, FlowState.OVERVIEW);

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
      otpCode: session.otpCode,
      updatedAt: Date.now(),
    });
    results.markSuccess(email, session.password, apiKey);

    log("info", "Zro MoonMath account completed successfully", {
      email,
      apiKey: `${apiKey.slice(0, 10)}...`,
    });
    return { success: true, apiKey };
  } catch (err) {
    const errorMsg = (err as Error).message || String(err);
    log("error", "Zro MoonMath flow failed", { email, error: errorMsg });

    store.setStatus(email, FlowState.FAILED, errorMsg);
    results.markFailed(email, errorMsg);

    return { success: false, error: errorMsg };
  }
}
