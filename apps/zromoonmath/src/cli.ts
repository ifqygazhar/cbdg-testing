#!/usr/bin/env bun
// ── CLI entrypoint (Bun) for Zro MoonMath ───────────────────────────
import { loadConfig, ensureDirs } from "./config.js";
import { createLog } from "./log.js";
import { JsonlStore } from "./store.js";
import { processQueue } from "./queue.js";

import path from "node:path";
import { shouldUsePythonEngine, spawnPythonRunner } from "@ifqy/google-oauth";

interface Args {
  engine?: string;
  headless?: boolean;
  pace?: string;
  workers?: number;
  state?: string;
  dryRun?: boolean;
  retryFailed?: boolean;
  delaySec?: number;
  useProxy?: boolean;
  proxyFile?: string;
  reuseProxy?: boolean;
  limit?: number;
  password?: string;
  domain?: string;
  auth?: string;
  accountsFile?: string;
}

/** Pure: merge parsed CLI flags into an env object (CLI wins over env file). */
export function applyArgsToEnv(args: Args, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  if (args.engine !== undefined) env.BROWSER_ENGINE = args.engine;
  if (args.workers !== undefined) env.WORKERS = String(args.workers);
  if (args.headless !== undefined) env.HEADLESS = args.headless ? "1" : "0";
  if (args.retryFailed !== undefined) env.RETRY_FAILED = args.retryFailed ? "1" : "0";
  if (args.delaySec !== undefined) env.INTER_ACCOUNT_DELAY_SEC = String(args.delaySec);
  if (args.useProxy !== undefined) env.USE_PROXY = args.useProxy ? "1" : "0";
  if (args.proxyFile !== undefined) env.SEED_PROXY = args.proxyFile;
  if (args.pace !== undefined) env.PACE = args.pace;
  if (args.reuseProxy !== undefined) env.PROXY_REUSE = args.reuseProxy ? "1" : "0";
  if (args.limit !== undefined) env.LIMIT = String(args.limit);
  if (args.password !== undefined) env.ZRO_PASSWORD = args.password;
  if (args.domain !== undefined) env.TEMPMAIL_DOMAIN = args.domain;
  if (args.auth !== undefined) env.ZRO_AUTH = args.auth;
  if (args.accountsFile !== undefined) env.SEED_ACCOUNTS = args.accountsFile;
  return env;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--headless") args.headless = true;
    else if (a === "--headed" || a === "--no-headless") args.headless = false;
    else if (a === "--workers" || a === "-w") args.workers = Number(next());
    else if (a === "--state") args.state = next();
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--retry-failed") args.retryFailed = true;
    else if (a === "--delay" || a === "--delay-sec") args.delaySec = Number(next());
    else if (a === "--use-proxy") args.useProxy = true;
    else if (a === "--no-proxy" || a === "--direct") args.useProxy = false;
    else if (a === "--proxy-file") args.proxyFile = next();
    else if (a === "--pace") args.pace = next();
    else if (a === "--reuse-proxy") args.reuseProxy = true;
    else if (a === "--engine") args.engine = next();
    else if (a === "--limit" || a === "-l" || a === "-n") args.limit = Number(next());
    else if (a === "--password" || a === "-p") args.password = next();
    else if (a === "--domain" || a === "-d") args.domain = next();
    else if (a === "--auth" || a === "-a") args.auth = next();
    else if (a === "--accounts-file" || a === "-f") args.accountsFile = next();
    else if (a === "--help" || a === "-h") {
      console.log(
        `Usage: bun run zromoonmath -- [--engine bun|python] [--auth tempmail|google] [--accounts-file F] [--headless] [--headed] [-w N] [--dry-run]\n` +
          `Flags:\n` +
          `  --engine <bun|python>  Browser engine (bun=Puppeteer, python=Camoufox)\n` +
          `  --auth <tempmail|google> Registration method (default: tempmail)\n` +
          `  --accounts-file <path> Path to accounts file (for Google OAuth)\n` +
          `  --domain <domain>      TempMail domain (default: ifqy.net)\n` +
          `  --limit, -l, -n <N>    Maximum successful accounts to create\n` +
          `  --workers, -w <N>      Concurrency / number of workers (default: 1)\n` +
          `  --headless / --headed  Browser visibility\n` +
          `  --use-proxy / --direct Proxy toggle\n` +
          `  --proxy-file <path>    Path to proxy list (default: proxy-live.txt / proxy.txt)\n` +
          `  --pace <fast|human|careful> Interaction cadence\n`,
      );
      process.exit(0);
    }
  }
  return args;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const env = applyArgsToEnv(args, process.env);
  const cfg = loadConfig(env);
  ensureDirs(cfg);

  // If google auth, or python engine requested, delegate to Python Camoufox runner
  if (
    args.auth === "google" ||
    cfg.authMethod === "google" ||
    shouldUsePythonEngine(args.engine ?? env.BROWSER_ENGINE)
  ) {
    const runnerPath = path.resolve(import.meta.dir, "../camoufox_runner.py");
    await spawnPythonRunner(runnerPath, {
      headed: args.headless === false,
      useProxy: args.useProxy,
      proxyFile: args.proxyFile,
      delaySec: args.delaySec,
      retryFailed: args.retryFailed,
      stateFile: args.state ?? cfg.stateFile,
      limit: args.limit !== undefined ? args.limit : (cfg.limit > 0 ? cfg.limit : undefined),
      domain: args.domain ?? cfg.tempMailDomain,
      pace: args.pace ?? (typeof cfg.pace === "object" ? (cfg.pace as any).name : cfg.pace),
      auth: args.auth ?? cfg.authMethod,
      accountsFile: (args.auth ?? cfg.authMethod) === "google" ? (args.accountsFile ?? cfg.seedAccounts) : undefined,
      dryRun: args.dryRun,
      workers: args.workers ?? cfg.workers,
    });
    return;
  }

  const log = createLog({ cli: "main" });

  log("info", "start", {
    app: "zromoonmath",
    workers: cfg.workers,
    headless: cfg.headless,
    pace: cfg.pace,
    retryFailed: cfg.retryFailed,
    state: cfg.stateFile,
    limit: cfg.limit,
    results: { success: cfg.resultSuccessFile, failed: cfg.resultFailedFile, apiKey: cfg.apiKeyFile },
    seeds: { proxy: cfg.seedProxy, domain: cfg.tempMailDomain },
  });

  if (args.dryRun) {
    log("info", "dry-run: config validated (no browser launched)");
    return;
  }

  const store = new JsonlStore(args.state ?? cfg.stateFile);
  await processQueue(cfg, store);
  log("info", "done");
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("[cli] fatal:", (e as Error).message);
    process.exit(1);
  });
}
