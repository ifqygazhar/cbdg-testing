// ── Flow orchestration for ChatGPT onboarding ──────────────────────
import type { Page } from "puppeteer-core";
import { FlowState, type JsonlStore } from "../store.js";
import type { GptConfig } from "../config.js";
import type { TempMailClient } from "@ifqy/google-oauth";
import {
  stepOpenAndSubmitEmail,
  stepHandlePassword,
  stepHandleOtp,
  stepHandleAboutYou,
  stepHandleOnboardingAndPrompt,
  type AccountSession,
} from "./steps.js";

export function isTerminalState(state?: FlowState): boolean {
  return state === FlowState.DONE || state === FlowState.FAILED;
}

export async function runGptFlow(
  page: Page,
  email: string,
  password: string,
  tempMail: TempMailClient,
  store: JsonlStore,
  config: GptConfig,
  logger: (level: "info" | "warn" | "error" | "debug", msg: string, data?: Record<string, unknown>) => void,
): Promise<{ success: boolean; error?: string }> {
  const session: AccountSession = {
    page,
    email,
    password,
    config,
    tempMail,
    logger,
  };

  const updateState = (status: FlowState, err?: string) => {
    store.upsert({
      email,
      password,
      status,
      error: err,
      updatedAt: Date.now(),
    });
  };

  try {
    // 1. Email input & submit
    updateState(FlowState.PENDING);
    await stepOpenAndSubmitEmail(session);
    updateState(FlowState.SIGNUP_SUBMITTED);

    // 2. Password handle
    await stepHandlePassword(session);
    updateState(FlowState.PASSWORD_SET);

    // 3. OTP verification
    await stepHandleOtp(session);
    updateState(FlowState.OTP_SUBMITTED);

    // 4. About You profile
    await stepHandleAboutYou(session);
    updateState(FlowState.ABOUT_YOU_SUBMITTED);

    // 5. Onboarding dialog & short prompt
    await stepHandleOnboardingAndPrompt(session);
    updateState(FlowState.DONE);

    return { success: true };
  } catch (e: any) {
    const errorMsg = e?.message || String(e);
    logger("error", `ChatGPT flow error for ${email}: ${errorMsg}`);
    updateState(FlowState.FAILED, errorMsg);
    return { success: false, error: errorMsg };
  }
}
