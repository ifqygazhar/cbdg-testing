// ── Resumable state machine for Inference Dahl Global automation ──
import type { Page } from "puppeteer-core";
import { FlowState, type JsonlStore, type ResultWriter } from "../store.js";
import type { InferenceDahlConfig } from "../config.js";
import type { ULog } from "../log.js";
import {
  installCredentialHooks,
  isValidDahlApiKey,
  stepOpenSignupModal,
  stepFocusUsernameAndSubmitSignup,
  stepExtractFingerprintAndApiKeyAfterSignup,
  stepEnsureAccountDashboardAndAllocate,
} from "./steps.js";

export interface InferenceDahlSession {
  id: string;
  username?: string;
  fingerprint?: string;
  apiKey?: string;
}

export async function runInferenceDahlFlow(
  page: Page,
  session: InferenceDahlSession,
  _cfg: InferenceDahlConfig,
  store: JsonlStore,
  results: ResultWriter,
  log: ULog,
): Promise<{ success: boolean; fingerprint?: string; apiKey?: string; error?: string }> {
  let savedToResults = false;

  try {
    const { getCaptured } = await installCredentialHooks(page);

    // ── 1. OPEN SIGNUP MODAL ────────────────────────────────────────
    store.setStatus(session.id, FlowState.SIGNUP);
    await stepOpenSignupModal(page, log);

    // ── 2. CLICK USERNAME INPUT & SUBMIT CREATE ACCOUNT ─────────────
    const username = await stepFocusUsernameAndSubmitSignup(page, log);
    session.username = username;

    // ── 3. EXTRACT FINGERPRINT & API KEY FROM SAVE MODAL ────────────
    const { fingerprint, apiKey: initialKey } = await stepExtractFingerprintAndApiKeyAfterSignup(
      page,
      getCaptured,
      log,
    );

    if (!fingerprint) {
      throw new Error("Failed to extract 32-character account fingerprint after signup");
    }
    session.fingerprint = fingerprint;
    if (isValidDahlApiKey(initialKey)) {
      session.apiKey = initialKey;
      // Safeguard: Save immediately after signup as requested in link.txt
      results.markSuccess(fingerprint, initialKey);
      savedToResults = true;
      store.upsert({
        id: fingerprint,
        username,
        fingerprint,
        apiKey: initialKey,
        status: FlowState.FINGERPRINT_SAVED,
        updatedAt: Date.now(),
      });
      log("info", "saved fingerprint:apikey after signup", {
        fingerprint: `${fingerprint.slice(0, 8)}...`,
        apiKey: `${initialKey.slice(0, 10)}...`,
      });
    }

    // ── 4. NAVIGATE TO /account & ALLOCATE 100M TOKENS ──────────────
    store.setStatus(session.id, FlowState.ALLOCATE);
    const finalApiKey = await stepEnsureAccountDashboardAndAllocate(
      page,
      session.apiKey || "",
      getCaptured,
      log,
    );

    if (!isValidDahlApiKey(finalApiKey)) {
      throw new Error("Failed to extract valid dahl_ API key");
    }
    session.apiKey = finalApiKey;

    if (!savedToResults) {
      results.markSuccess(fingerprint, finalApiKey);
      savedToResults = true;
    }

    store.upsert({
      id: fingerprint,
      username,
      fingerprint,
      apiKey: finalApiKey,
      allocated: true,
      status: FlowState.DONE,
      updatedAt: Date.now(),
    });

    log("info", "Inference Dahl account created and 100M tokens allocated!", {
      username,
      fingerprint: `${fingerprint.slice(0, 8)}...`,
      apiKey: `${finalApiKey.slice(0, 10)}...`,
    });

    return { success: true, fingerprint, apiKey: finalApiKey };
  } catch (err) {
    const errorMsg = (err as Error).message || String(err);
    log("error", "Inference Dahl flow failed", { id: session.id, error: errorMsg });

    store.setStatus(session.id, FlowState.FAILED, errorMsg);
    if (!savedToResults) {
      results.markFailed(session.id, errorMsg);
    }

    return { success: false, fingerprint: session.fingerprint, apiKey: session.apiKey, error: errorMsg };
  }
}
