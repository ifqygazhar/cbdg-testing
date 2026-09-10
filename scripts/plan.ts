// ── Turning launcher answers into a command line ───────────────────
// Pure on purpose: the interactive part is untestable, this is not.

import fs from "node:fs";
import path from "node:path";

export type AppName = "cbdg" | "crusoe" | "webshare";
export type Pace = "fast" | "human" | "careful";
export type CbdgMode = "signup" | "full";

export interface RunPlan {
  app: AppName;
  pace: Pace;
  /** cbdg only: stop after signup, or go through the card */
  mode?: CbdgMode;
  /** cbdg + crusoe: read proxies from the seed file, or run from this IP */
  useProxy?: boolean;
  headless: boolean;
  retryFailed: boolean;
  dryRun: boolean;
  delaySec: number;
  workers: number;
}

export const APP_ENTRY: Record<AppName, string> = {
  cbdg: "apps/cbdg/src/cli.ts",
  crusoe: "apps/crusoe/src/cli.ts",
  webshare: "apps/webshare/src/cli.ts",
};

/** Apps whose accounts can be spread over the harvested proxies. */
export const PROXY_CAPABLE: AppName[] = ["cbdg", "crusoe"];

export function buildArgs(plan: RunPlan): string[] {
  const args: string[] = [];
  args.push(plan.headless ? "--headless" : "--headed");
  args.push(`--pace`, plan.pace);
  if (plan.app === "cbdg") args.push(plan.mode === "signup" ? "--signup-only" : "--full");
  if (PROXY_CAPABLE.includes(plan.app)) args.push(plan.useProxy ? "--with-proxy" : "--no-proxy");
  if (plan.workers > 1) args.push("-w", String(plan.workers));
  if (plan.delaySec > 0) args.push("--delay", String(plan.delaySec));
  if (plan.retryFailed) args.push("--retry-failed");
  if (plan.dryRun) args.push("--dry-run");
  return args;
}

/** The exact line a person could paste to repeat this run. */
export function commandLine(plan: RunPlan): string {
  return `bun run ${plan.app} -- ${buildArgs(plan).join(" ")}`;
}

// ── Seed-file facts, so the menu can tell the truth about the inputs ──

export interface SeedInfo {
  accounts: number;
  proxies: number;
  cards: number;
}

function countLines(file: string): number {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")).length;
  } catch {
    return 0;
  }
}

export function readSeeds(cwd = process.cwd()): SeedInfo {
  return {
    accounts: countLines(path.join(cwd, "gsuite.txt")),
    proxies: countLines(path.join(cwd, "proxy.txt")),
    cards: countLines(path.join(cwd, "vcc.txt")),
  };
}

/**
 * Things worth saying out loud before a run starts. Each one has cost a real
 * batch at some point, so they are warnings, not chatter.
 */
export function warningsFor(plan: RunPlan, seeds: SeedInfo): string[] {
  const out: string[] = [];
  if (seeds.accounts === 0) out.push("gsuite.txt kosong — tidak ada akun untuk diproses.");
  if (plan.app === "cbdg" && plan.mode === "full" && seeds.cards === 0) {
    out.push("vcc.txt kosong padahal mode full — antrean akan berhenti. Pakai signup-only.");
  }
  if (PROXY_CAPABLE.includes(plan.app) && plan.useProxy && seeds.proxies === 0) {
    out.push("proxy.txt kosong — jalankan webshare dulu, atau pilih tanpa proxy.");
  }
  if (PROXY_CAPABLE.includes(plan.app) && !plan.useProxy && seeds.accounts > 1) {
    out.push(`tanpa proxy: ${seeds.accounts} akun berbagi satu IP, risk control gampang melihatnya.`);
  }
  if (plan.app === "webshare" && plan.useProxy) {
    out.push("webshare memakai signup-proxy.txt, bukan proxy.txt yang ia tulis sendiri.");
  }
  if (plan.delaySec === 0 && seeds.accounts > 1) {
    out.push("jeda antar akun 0 detik — ini sinyal paling kuat buat risk control.");
  }
  if (plan.headless) {
    out.push("headless: captcha dan 3DS tidak bisa diselesaikan manual.");
  }
  return out;
}
