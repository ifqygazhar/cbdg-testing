// ── Flow engine (state machine) ────────────────────────────────────
import type { GoogleOAuthBrowser, GoogleOAuthOptions } from "@ifqy/google-oauth";
import type { AppConfig } from "../config.js";
import type { ULog } from "../log.js";
import type { GsuiteAccount, ProxySeed, VccCard } from "../loaders.js";
import { FlowState } from "../store.js";
import { STEPS } from "./steps.js";

export interface FlowCtx {
  account: GsuiteAccount;
  /** null in signup-only mode, where no card is ever submitted */
  card: VccCard | null;
  proxy: ProxySeed | null;
  browser: GoogleOAuthBrowser;
  cfg: AppConfig;
  googleOAuth: GoogleOAuthOptions;
  log: ULog;
  /** set by the signup-only terminal step; the runner notes it in the result */
  creditConfirmedRef: { current: boolean };
}

export class FlowError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "FlowError";
  }
}

// Fixed intended order (informational / scheduling); each step returns its real next state.
const ORDER: FlowState[] = [
  FlowState.PRICING,
  FlowState.GOOGLE_OAUTH,
  FlowState.COMPLETE_REGISTER,
  FlowState.ADD_PAYMENT,
  FlowState.LINK_CARD,
  FlowState.WAIT_3DS,
  FlowState.START_TRIAL,
  FlowState.VERIFY_CREDIT,
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