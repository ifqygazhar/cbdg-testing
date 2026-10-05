// ── Resumable state machine for GroqCloud automation ────────────────
import type { Page } from "puppeteer-core";
import { FlowState, type JsonlStore, type ResultWriter } from "../store.js";
import type { GroqCloudConfig } from "../config.js";
import type { ULog } from "../log.js";
import { TempMailClient } from "@ifqy/google-oauth";
import {
  type AccountSession,
  stepSignUp,
  stepPollMagicLinkAndLogin,
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

export async function runGroqCloudFlow(
  page: Page,
  session: AccountSession,
  cfg: GroqCloudConfig,
  store: JsonlStore,
  results: ResultWriter,
  tempMail: TempMailClient,
  log: ULog,
): Promise<{ success: boolean; apiKey?: string; error?: string }> {
  const email = session.email;

  try {
    // ── 1. SIGNUP WITH EMAIL ────────────────────────────────────────
    store.setStatus(email, FlowState.SIGNUP);
    await stepSignUp(page, session, cfg, log);

    // ── 2. POLL MAGIC LINK & AUTHENTICATE ───────────────────────────
    store.setStatus(email, FlowState.CHECK_EMAIL);
    const magicLink = await stepPollMagicLinkAndLogin(page, email, tempMail, log);
    session.magicLink = magicLink;
    store.upsert({
      email,
      password: session.password,
      status: FlowState.MAGIC_LINK,
      magicLink,
      updatedAt: Date.now(),
    });

    // ── 3. NAVIGATE TO KEYS & CREATE API KEY ───────────────────────
    store.setStatus(email, FlowState.KEYS_PAGE);
    store.setStatus(email, FlowState.CREATE_KEY);
    const apiKey = await stepCreateApiKey(page, session, cfg, log);

    // ── 4. DONE ────────────────────────────────────────────────────
    store.upsert({
      email,
      password: session.password,
      status: FlowState.DONE,
      apiKey,
      magicLink,
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
