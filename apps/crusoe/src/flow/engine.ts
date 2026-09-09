// ── Flow engine (state machine) ────────────────────────────────────
import type { Page } from "puppeteer-core";
import type { GoogleOAuthBrowser, GoogleOAuthOptions } from "@ifqy/google-oauth";
import type { AppConfig } from "../config.js";
import type { ULog } from "../log.js";
import type { GsuiteAccount, ProxySeed } from "../loaders.js";
import { FlowState } from "../store.js";
import { STEPS } from "./steps.js";

export interface FlowCtx {
  account: GsuiteAccount;
  proxy: ProxySeed | null;
  browser: GoogleOAuthBrowser;
  cfg: AppConfig;
  googleOAuth: GoogleOAuthOptions;
  log: ULog;
  /**
   * The page that is actually running the crusoe flow. Equal to
   * browser.page for same-tab OAuth; after popup-based OAuth the app
   * continues inside the (formerly Google) popup page.
   */
  appPageRef: { current: Page | null };
  /** extracted API key — runner persists it to apikey.txt on DONE */
  apiKeyRef: { current: string };
}

export class FlowError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "FlowError";
  }
}

// Fixed intended order (informational / scheduling); each step returns its real next state.
const ORDER: FlowState[] = [
  FlowState.SIGNUP,
  FlowState.COMPLETE_SIGNUP,
  FlowState.API_KEY,
];

export function isTerminalState(s: FlowState): boolean {
  return s === FlowState.DONE || s === FlowState.FAILED;
}

export async function transition(
  state: FlowState,
  ctx: FlowCtx,
): Promise<FlowState> {
  const fn = STEPS[state];
  if (fn) return fn(ctx);
  throw new FlowError("NO_STEP", `no step registered for ${state}`);
}

export { ORDER };