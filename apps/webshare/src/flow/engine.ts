// ── Flow engine (state machine) ────────────────────────────────────
import type { Page } from "puppeteer-core";
import type { GoogleOAuthBrowser, GoogleOAuthOptions } from "@ifqy/google-oauth";
import type { AppConfig } from "../config.js";
import type { ULog } from "../log.js";
import type { GsuiteAccount, ProxySeed } from "../loaders.js";
import { FlowState, type ProxyRecord } from "../store.js";
import { STEPS } from "./steps.js";

export interface FlowCtx {
  account: GsuiteAccount;
  proxy: ProxySeed | null;
  browser: GoogleOAuthBrowser;
  cfg: AppConfig;
  googleOAuth: GoogleOAuthOptions;
  log: ULog;
  /** the page running the webshare app (same tab here, since OAuth redirects) */
  appPageRef: { current: Page | null };
  /** harvested proxies — the runner persists them on DONE */
  proxiesRef: { current: ProxyRecord[] };
  /**
   * Credentials captured from the app's own API call, so we can re-ask the
   * same endpoint with our own query (mode=direct, a full page_size) instead
   * of accepting whatever the UI happened to request.
   */
  apiRef: { current: { url: string; authorization: string } | null };
}

export class FlowError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "FlowError";
  }
}

const ORDER: FlowState[] = [FlowState.SIGNUP, FlowState.PROXY_LIST];

export function isTerminalState(s: FlowState): boolean {
  return s === FlowState.DONE || s === FlowState.FAILED;
}

export async function transition(state: FlowState, ctx: FlowCtx): Promise<FlowState> {
  const fn = STEPS[state];
  if (fn) return fn(ctx);
  throw new FlowError("NO_STEP", `no step registered for ${state}`);
}

export { ORDER };
