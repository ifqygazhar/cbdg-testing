#!/usr/bin/env bun
// ── CLI entrypoint (Bun) for Inference Dahl Global ─────────────────
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
  domain?: string;
  auth?: string;
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
    else if (a === "--no-retry-failed") args.retryFailed = false;
    else if (a === "--delay") args.delaySec = Number(next());
    else if (a === "--no-proxy") args.useProxy = false;
    else if (a === "--proxy") {
      args.useProxy = true;
      args.proxyFile = next();
    } else if (a === "--with-proxy") args.useProxy = true;
    else if (a === "--fast") args.pace = "fast";
    else if (a === "--careful") args.pace = "careful";
    else if (a === "--pace") args.pace = next();
    else if (a === "--reuse-proxy") args.reuseProxy = true;
    else if (a === "--unique-proxy" || a === "--no-reuse-proxy") args.reuseProxy = false;
    else if (a === "--limit" || a === "--count" || a === "-n") args.limit = Number(next());
    else if (a === "--domain") args.domain = next();
    else if (a === "--auth") args.auth = next();
    else if (a === "--engine") args.engine = next();
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: bun run inferencedahl [options]
  --engine <bun|python>  Browser engine: bun (Puppeteer) or python (Camoufox, default)
  --headless / --headed
  --workers, -w <n>      Concurrent workers (default 1)
  --pace <name>          fast | human | careful (default fast)
  --limit, -n <count>    Number of accounts to create (default 1)
  --with-proxy           Enable proxy usage (default: proxy-live.txt / proxy.txt)
  --proxy <file>         Specify custom proxy file
  --no-proxy             Run directly without proxy
  --reuse-proxy          Allow recycling proxies when accounts > proxies
  --unique-proxy         Enforce 1 account per 1 unique IP
  --delay <sec>          Delay between accounts (default 2)
  --retry-failed         Re-run accounts marked FAILED
  --state <file>         State JSONL path (default state-inferencedahl.jsonl)
  --dry-run              Validate config and exit without launching browser`);
      process.exit(0);
    }
  }
  return args;
}

export async function main(argv: string[] = Bun.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const env = applyArgsToEnv(args, process.env);
  const cfg = loadConfig(env);
  ensureDirs(cfg);

  // Default to python engine for Camoufox anti-detect unless explicitly specified as 'bun'
  const isPython = args.engine === "python" || shouldUsePythonEngine(args.engine ?? env.BROWSER_ENGINE) || args.engine === undefined;
  if (isPython && args.engine !== "bun") {
    const runnerPath = path.resolve(import.meta.dir, "../camoufox_runner.py");
    await spawnPythonRunner(runnerPath, {
      headed: args.headless === false,
      useProxy: args.useProxy,
      proxyFile: args.proxyFile,
      delaySec: args.delaySec,
      retryFailed: args.retryFailed,
      stateFile: args.state ?? cfg.stateFile,
      limit: args.limit !== undefined ? args.limit : (cfg.limit > 0 ? cfg.limit : undefined),
      pace: args.pace ?? (typeof cfg.pace === "object" ? (cfg.pace as any).name : cfg.pace),
      dryRun: args.dryRun,
      workers: args.workers ?? cfg.workers,
      extraArgs: args.reuseProxy ? ["--reuse-proxy"] : [],
    });
    return;
  }

  const log = createLog({ cli: "main" });

  log("info", "start", {
    app: "inferencedahl",
    workers: cfg.workers,
    headless: cfg.headless,
    pace: cfg.pace,
    retryFailed: cfg.retryFailed,
    state: cfg.stateFile,
    limit: cfg.limit,
    results: { success: cfg.resultSuccessFile, failed: cfg.resultFailedFile, apiKey: cfg.apiKeyFile },
    seeds: { proxy: cfg.seedProxy },
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
