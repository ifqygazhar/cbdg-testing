// ── Pacing profiles ────────────────────────────────────────────────
// Automation is slow for two very different reasons: deliberate human-like
// pauses, and blind waiting for something that already happened. Only the
// first one buys anything. A pace profile scales the deliberate pauses and
// caps the blind waits, so "fast" stays human-shaped instead of turning into
// an obvious bot.

export type PaceName = "fast" | "human" | "careful";

export interface Pace {
  name: PaceName;
  /** short pause between two discrete UI actions */
  pauseMin: number;
  pauseMax: number;
  /** per-character typing delay */
  typeMin: number;
  typeMax: number;
  /** how long a page may settle before we touch it */
  settleIdleMs: number;
  settleTimeoutMs: number;
  /** interval when polling for a state change */
  pollMs: number;
  /** mouse-move flourishes before interacting (0 disables them) */
  mouseMoves: number;
  /** pause after an action that navigates or mounts a new surface */
  stepPauseMin: number;
  stepPauseMax: number;
}

export const PACES: Record<PaceName, Pace> = {
  // Human-fast: someone who knows the form and does not re-read it. Typing
  // and clicking stay in human range; only dead waiting is cut.
  fast: {
    name: "fast",
    pauseMin: 120,
    pauseMax: 380,
    typeMin: 18,
    typeMax: 55,
    settleIdleMs: 300,
    settleTimeoutMs: 6_000,
    pollMs: 300,
    mouseMoves: 1,
    stepPauseMin: 250,
    stepPauseMax: 800,
  },
  // Default: the original cadence.
  human: {
    name: "human",
    pauseMin: 300,
    pauseMax: 800,
    typeMin: 30,
    typeMax: 90,
    settleIdleMs: 500,
    settleTimeoutMs: 15_000,
    pollMs: 500,
    mouseMoves: 1,
    stepPauseMin: 800,
    stepPauseMax: 1_800,
  },
  // For hostile risk engines: slower than a real user is not suspicious.
  careful: {
    name: "careful",
    pauseMin: 700,
    pauseMax: 1_800,
    typeMin: 60,
    typeMax: 150,
    settleIdleMs: 800,
    settleTimeoutMs: 30_000,
    pollMs: 800,
    mouseMoves: 2,
    stepPauseMin: 1_500,
    stepPauseMax: 3_500,
  },
};

export function isPaceName(v: unknown): v is PaceName {
  return v === "fast" || v === "human" || v === "careful";
}

/**
 * Resolve a name, a full profile, or nothing into a profile. With nothing
 * given it honours `GOOGLE_OAUTH_PACE`, so helpers that receive a raw options
 * object (not one that went through `resolveGoogleOAuthOptions`) still follow
 * the caller's chosen pace instead of silently reverting to "human".
 */
export function resolvePace(pace?: PaceName | Pace | null, fallback: PaceName = "human"): Pace {
  if (pace && typeof pace === "object") return pace;
  if (isPaceName(pace)) return PACES[pace];
  const fromEnv = typeof process !== "undefined" ? process.env?.GOOGLE_OAUTH_PACE : undefined;
  if (isPaceName(fromEnv)) return PACES[fromEnv];
  return PACES[fallback];
}
