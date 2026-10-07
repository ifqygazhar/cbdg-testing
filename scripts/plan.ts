// ── Turning launcher answers into a command line ───────────────────
// Pure on purpose: the interactive part is untestable, this is not.

import fs from "node:fs";
import path from "node:path";

export type AppName = "cbdg" | "crusoe" | "webshare" | "fastrouter" | "tokenharbor" | "groqcloud" | "llm7io" | "proxy-check" | "key-checker";

/** Maintenance actions have no accounts, pace or proxy of their own. */
export const IS_TOOL: Record<AppName, boolean> = {
  cbdg: false,
  crusoe: false,
  webshare: false,
  fastrouter: false,
  tokenharbor: false,
  groqcloud: false,
  llm7io: false,
  "proxy-check": true,
  "key-checker": true,
};
export type Pace = "fast" | "human" | "careful";
export type CbdgMode = "signup" | "full";
export type BrowserEngine = "bun" | "python";

export const ENGINE_CAPABLE: AppName[] = ["fastrouter", "crusoe", "tokenharbor", "groqcloud", "llm7io"];

export interface RunPlan {
  app: AppName;
  pace: Pace;
  /** Browser engine: 'bun' (Chromium/Puppeteer) or 'python' (Camoufox/Firefox) */
  engine?: BrowserEngine;
  /** cbdg only: stop after signup, or go through the card */
  mode?: CbdgMode;
  /** cbdg + crusoe + fastrouter: read proxies from the seed file, or run from this IP */
  useProxy?: boolean;
  /** cbdg + crusoe + fastrouter: allow accounts to reuse/cycle through proxies */
  reuseProxy?: boolean;
  /**
   * cbdg + crusoe + fastrouter: send Google's sign-in direct while the site keeps the
   * proxy. Carried on the plan rather than read from the environment at print
   * time, so the command shown is the command that runs.
   */
  googleDirect?: boolean;
  headless: boolean;
  retryFailed: boolean;
  dryRun: boolean;
  delaySec: number;
  workers: number;
  authMethod?: "google" | "tempmail";
  limit?: number;
  domain?: string;
  proxyTarget?: string;
  proxyAppend?: boolean;
  reEnableFree?: boolean;
  accountsFile?: string;
}


export const APP_ENTRY: Record<AppName, string> = {
  cbdg: "apps/cbdg/src/cli.ts",
  crusoe: "apps/crusoe/src/cli.ts",
  webshare: "apps/webshare/src/cli.ts",
  fastrouter: "apps/fastrouter/src/cli.ts",
  tokenharbor: "apps/tokenharbor/src/cli.ts",
  groqcloud: "apps/groqcloud/src/cli.ts",
  llm7io: "apps/llm7io/src/cli.ts",
  "proxy-check": "scripts/proxy-check.ts",
  "key-checker": "entrim_crusoe_key_checker_cli.ts",
};

/** Apps whose accounts can be spread over the harvested proxies. */
export const PROXY_CAPABLE: AppName[] = ["cbdg", "crusoe", "fastrouter", "tokenharbor", "groqcloud", "llm7io"];

/**
 * Whether Google's sign-in will bypass the proxy on this run. Defaults on; the
 * apps read GOOGLE_DIRECT, so the menu has to read the same knob to stay
 * truthful about what it is about to do.
 */
export function googleDirectEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.GOOGLE_DIRECT ?? "").toLowerCase();
  if (v === "") return true;
  return ["1", "true", "yes", "y", "on"].includes(v);
}

/**
 * Whether proxy reuse/rotation is enabled by default from environment.
 * Off by default; the apps read PROXY_REUSE.
 */
export function proxyReuseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.PROXY_REUSE ?? "").toLowerCase();
  if (v === "") return false;
  return ["1", "true", "yes", "y", "on"].includes(v);
}

export function buildArgs(plan: RunPlan): string[] {
  const args: string[] = [];
  // The checker takes no run-shaping flags: it reads proxy.txt and writes
  // proxy-live.txt with its own defaults. Optional target & append flags can be passed.
  if (IS_TOOL[plan.app]) {
    if (plan.app === "key-checker") return [];
    const toolArgs: string[] = [];
    if (plan.proxyTarget) toolArgs.push("--target", plan.proxyTarget);
    if (plan.proxyAppend) toolArgs.push("--append");
    return toolArgs;
  }
  args.push(plan.headless ? "--headless" : "--headed");
  args.push(`--pace`, plan.pace);
  if (plan.app === "cbdg") args.push(plan.mode === "signup" ? "--signup-only" : "--full");
  if (PROXY_CAPABLE.includes(plan.app)) {
    args.push(plan.useProxy ? "--with-proxy" : "--no-proxy");
    // Only worth spelling out when it differs from the default, and only when
    // there is a proxy for it to differ from.
    if (plan.useProxy) {
      if (plan.googleDirect === false) args.push("--no-google-direct");
      if (plan.reuseProxy) args.push("--reuse-proxy");
      else if (plan.reuseProxy === false && proxyReuseEnabled()) args.push("--unique-proxy");
    }
  }
  if (plan.workers > 1) args.push("-w", String(plan.workers));
  if (plan.delaySec > 0) args.push("--delay", String(plan.delaySec));
  if (plan.reEnableFree) {
    args.push("--re-enable-free");
    if (plan.accountsFile) args.push("--accounts-file", plan.accountsFile);
  } else {
    if (plan.authMethod) args.push("--auth", plan.authMethod);
    if (plan.domain) args.push("--domain", plan.domain);
    if (plan.accountsFile) args.push("--accounts-file", plan.accountsFile);
  }
  if (plan.limit !== undefined && plan.limit > 0) {
    if (plan.authMethod === "google") {
      const rem = getRemainingAccountsForApp(plan.app);
      const effectiveLimit = rem.remaining > 0 ? Math.min(plan.limit, rem.remaining) : plan.limit;
      args.push("--limit", String(effectiveLimit));
    } else {
      args.push("--limit", String(plan.limit));
    }
  }
  if (plan.retryFailed) args.push("--retry-failed");
  if (plan.dryRun) args.push("--dry-run");
  if (ENGINE_CAPABLE.includes(plan.app) && plan.engine === "python") {
    args.push("--engine", "python");
  }
  return args;
}


/** The exact line a person could paste to repeat this run. */
export function commandLine(plan: RunPlan): string {
  const args = buildArgs(plan);
  return args.length ? `bun run ${plan.app} -- ${args.join(" ")}` : `bun run ${plan.app}`;
}

// ── Seed-file facts, so the menu can tell the truth about the inputs ──

export interface SeedInfo {
  accounts: number;
  /** raw harvest from webshare, in lines */
  proxies: number;
  /** proxies that passed `bun run proxy-check`, in lines */
  live: number;
  /** distinct exit addresses in the live pool — the real one-per-account cap */
  liveAddresses: number;
  cards: number;
}

function readEntries(file: string): string[] {
  try {
    // Split on LF and let trim() eat a trailing CR: no regex, no escaping to
    // get wrong, same answer on both line endings.
    return fs
      .readFileSync(file, "utf8")
      .split(String.fromCharCode(10))
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

function countLines(file: string): number {
  return readEntries(file).length;
}

/**
 * Distinct exit addresses, not lines. Webshare hands every account the same
 * endpoints under a different username, so a file of 130 lines can be ten
 * addresses — and ten is how many accounts can run one-per-address.
 */
function countAddresses(file: string): number {
  const hosts = new Set<string>();
  for (const line of readEntries(file)) {
    try {
      hosts.add(new URL(line.includes("://") ? line : "http://" + line).hostname);
    } catch {
      /* unparseable lines are the loader's problem, not the count's */
    }
  }
  return hosts.size;
}

export interface AppAccountStats {
  total: number;
  completed: number;
  remaining: number;
}

export function getCompletedEmailsForApp(app: AppName, cwd = process.cwd()): Set<string> {
  const completed = new Set<string>();

  const resultFiles: Record<AppName, string[]> = {
    tokenharbor: ["akun-result-tokenharbor.txt"],
    fastrouter: ["akun-result-fastrouter.txt"],
    crusoe: ["akun-result-crusoe.txt"],
    cbdg: ["akun-result.txt"],
    webshare: ["akun-result-webshare.txt"],
    groqcloud: ["akun-result-groqcloud.txt"],
    llm7io: ["akun-result-llm7io.txt", "apikey-llm7io.txt"],
    "proxy-check": [],
    "key-checker": [],
  };

  const stateFiles: Record<AppName, string[]> = {
    tokenharbor: ["state.jsonl", "state-tokenharbor.jsonl"],
    fastrouter: ["state-fastrouter.jsonl", "state.jsonl"],
    crusoe: ["state-crusoe.jsonl", "state.jsonl"],
    cbdg: ["state.jsonl"],
    webshare: ["state-webshare.jsonl"],
    groqcloud: ["state-groqcloud.jsonl", "state.jsonl"],
    llm7io: ["state-llm7io.jsonl", "state.jsonl"],
    "proxy-check": [],
    "key-checker": [],
  };

  for (const rf of resultFiles[app] ?? []) {
    const fullPath = path.join(cwd, rf);
    if (fs.existsSync(fullPath)) {
      for (const line of fs.readFileSync(fullPath, "utf8").split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const email = t.split("#")[0].split(/[:|]/)[0].trim().toLowerCase();
        if (email.includes("@")) completed.add(email);
      }
    }
  }

  for (const sf of stateFiles[app] ?? []) {
    const fullPath = path.join(cwd, sf);
    if (fs.existsSync(fullPath)) {
      for (const line of fs.readFileSync(fullPath, "utf8").split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        try {
          const rec = JSON.parse(t);
          if (rec.email && rec.status === "DONE") {
            completed.add(rec.email.toLowerCase());
          }
        } catch {}
      }
    }
  }

  return completed;
}

export function getRemainingAccountsForApp(app: AppName, cwd = process.cwd()): AppAccountStats {
  const candidateFiles = [
    path.join(cwd, "gsuite.txt"),
    path.join(cwd, `${app}-dataset/gsuite.txt`),
  ];
  let accountsFile = "";
  for (const cf of candidateFiles) {
    if (fs.existsSync(cf)) {
      accountsFile = cf;
      break;
    }
  }
  if (!accountsFile) return { total: 0, completed: 0, remaining: 0 };

  const allAccounts = readEntries(accountsFile)
    .map((l) => l.split(/[:|]/)[0].trim().toLowerCase())
    .filter((l) => l.includes("@"));

  const completed = getCompletedEmailsForApp(app, cwd);
  const remainingAccounts = allAccounts.filter((acc) => !completed.has(acc));

  return {
    total: allAccounts.length,
    completed: allAccounts.length - remainingAccounts.length,
    remaining: remainingAccounts.length,
  };
}

export function readSeeds(cwd = process.cwd()): SeedInfo {
  return {
    accounts: countLines(path.join(cwd, "gsuite.txt")),
    proxies: countLines(path.join(cwd, "proxy.txt")),
    live: countLines(path.join(cwd, "proxy-live.txt")),
    liveAddresses: countAddresses(path.join(cwd, "proxy-live.txt")),
    cards: countLines(path.join(cwd, "vcc.txt")),
  };
}

/**
 * Things worth saying out loud before a run starts. Each one has cost a real
 * batch at some point, so they are warnings, not chatter.
 */
export function warningsFor(plan: RunPlan, seeds: SeedInfo): string[] {
  const out: string[] = [];
  if (IS_TOOL[plan.app]) {
    if (plan.app === "proxy-check" && seeds.proxies === 0) {
      out.push("proxy.txt kosong — jalankan webshare dulu.");
    }
    return out;
  }
  const isTempMail =
    plan.app === "groqcloud" ||
    ((plan.app === "tokenharbor" || plan.app === "fastrouter" || plan.app === "llm7io") && plan.authMethod !== "google");
  if (!isTempMail && seeds.accounts === 0) {
    out.push("gsuite.txt kosong — tidak ada akun untuk diproses.");
  }
  if (plan.authMethod === "google") {
    const rem = getRemainingAccountsForApp(plan.app);
    if (rem.total > 0) {
      if (rem.remaining === 0) {
        out.push(
          `Semua ${rem.total} akun di gsuite.txt sudah berhasil dibuat untuk ${plan.app}. Akun yang sudah selesai tidak akan diulang.`,
        );
      } else if (plan.limit !== undefined && plan.limit > rem.remaining) {
        out.push(
          `Target input (${plan.limit} akun) melebihi sisa akun (${rem.remaining} akun tersisa). Antrean akan berhenti setelah sisa akun diproses agar akun sukses tidak diulang.`,
        );
      }
    }
  }
  if (plan.app === "cbdg" && plan.mode === "full" && seeds.cards === 0) {
    out.push("vcc.txt kosong padahal mode full — antrean akan berhenti. Pakai signup-only.");
  }
  if (PROXY_CAPABLE.includes(plan.app) && plan.useProxy) {
    if (seeds.live === 0 && seeds.proxies === 0) {
      out.push("belum ada proxy sama sekali — jalankan webshare dulu, atau pilih tanpa proxy.");
    } else if (seeds.live === 0) {
      out.push(`proxy.txt terisi (${seeds.proxies}) tapi belum dicek — jalankan proxy-check dulu.`);
    } else if (seeds.liveAddresses > 0 && seeds.accounts > seeds.liveAddresses) {
      if (plan.reuseProxy) {
        out.push(
          `reuse-proxy aktif: ${seeds.accounts} akun akan merotasi ${seeds.liveAddresses} alamat unik (beberapa akun berbagi IP).`,
        );
      } else {
        out.push(
          `${seeds.accounts} akun tapi cuma ${seeds.liveAddresses} alamat unik — ` +
            `${seeds.accounts - seeds.liveAddresses} akun ditahan sampai ada proxy baru (atau pakai --reuse-proxy).`,
        );
      }
    }
  }
  if (PROXY_CAPABLE.includes(plan.app) && plan.useProxy && plan.googleDirect === false) {
    out.push("google sign-in ikut lewat proxy — siap-siap captcha gambar di langkah email.");
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
