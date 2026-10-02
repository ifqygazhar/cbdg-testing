#!/usr/bin/env bun
// ── CLI entrypoint (Bun) ────────────────────────────────────────────
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
  googleDirect?: boolean;
  reuseProxy?: boolean;
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
  if (args.googleDirect !== undefined) env.GOOGLE_DIRECT = args.googleDirect ? "1" : "0";
  if (args.reuseProxy !== undefined) env.PROXY_REUSE = args.reuseProxy ? "1" : "0";
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
    else if (a === "--google-direct") args.googleDirect = true;
    else if (a === "--no-google-direct") args.googleDirect = false;
    else if (a === "--engine" || a === "-e") args.engine = next();
    else if (a === "--camoufox") args.engine = "python";
    else if (a === "--bun") args.engine = "bun";
    else if (a === "--reuse-proxy" || a === "--rotate-proxy" || a === "--loop-proxy") args.reuseProxy = true;
    else if (a === "--unique-proxy") args.reuseProxy = false;
    else if (a === "--help" || a === "-h") {
      console.log(
        `Usage: bun run fastrouter -- [--engine bun|python] [--headless] [--headed] [-w N] [--dry-run]\n` +
          `                          [--delay SEC] [--fast | --careful | --pace fast|human|careful]\n\n` +
          `  --engine E  pilih engine browser: 'bun' (Chromium/Puppeteer) atau 'python' (Camoufox/Firefox)\n` +
          `  --camoufox  alias untuk --engine python (bypass Cloudflare Turnstile otomatis)\n` +
          `  --fast      human-shaped but no dead waiting (~1 min/account instead of ~2)\n` +
          `  --careful   slower than a real user; for hostile risk engines\n` +
          `  --delay     seconds between accounts — risk control spacing\n` +
          `  --no-proxy  ignore proxy.txt and run every account from this IP\n` +
          `  --proxy F   use a specific proxy file (default proxy-live.txt / proxy.txt)\n` +
          `  --reuse-proxy       rotasi/loop proxy: putar kembali dari awal jika habis\n` +
          `  --rotate-proxy      alias untuk --reuse-proxy\n` +
          `  --unique-proxy      default: 1 akun 1 alamat unik\n` +
          `  --no-google-direct  kirim google sign-in lewat proxy juga (default: langsung)`,
      );
      process.exit(0);
    }
  }
  return args;
}

/**
 * `argv` is a parameter so one bundled binary can host every app: the
 * dispatcher hands each command its own slice of the real argv.
 */
export async function main(argv: string[] = Bun.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const env = applyArgsToEnv(args, process.env);
  const cfg = loadConfig(env);
  ensureDirs(cfg);

  // If python engine requested, delegate to Python Camoufox runner
  if (shouldUsePythonEngine(args.engine ?? env.BROWSER_ENGINE)) {
    const runnerPath = path.resolve(import.meta.dir, "../camoufox_runner.py");
    await spawnPythonRunner(runnerPath, {
      headed: args.headless === false,
      useProxy: args.useProxy,
      proxyFile: args.proxyFile,
      delaySec: args.delaySec,
      retryFailed: args.retryFailed,
      stateFile: args.state ?? cfg.stateFile,
      dryRun: args.dryRun,
    });
    return;
  }

  const log = createLog({ cli: "main" });

  log("info", "start", {
    app: "fastrouter",
    workers: cfg.workers,
    headless: cfg.headless,
    pace: cfg.pace,
    retryFailed: cfg.retryFailed,
    state: cfg.stateFile,
    results: { success: cfg.resultSuccessFile, failed: cfg.resultFailedFile, apiKey: cfg.apiKeyFile },
    seeds: { gsuite: cfg.seedGsuite, proxy: cfg.seedProxy },
  });

  if (args.dryRun) {
    log("info", "dry-run: seeds parsed + config validated (no browser launched)");
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
