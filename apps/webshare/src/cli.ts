#!/usr/bin/env bun
// ── CLI entrypoint (Bun) ────────────────────────────────────────────
import path from "node:path";
import { shouldUsePythonEngine, spawnPythonRunner } from "@ifqy/google-oauth";
import { loadConfig, ensureDirs } from "./config.js";
import { createLog } from "./log.js";
import { JsonlStore } from "./store.js";
import { processQueue } from "./queue.js";

interface Args {
  engine?: string;
  headless?: boolean;
  pace?: string;
  googleDirect?: boolean;
  reuseProxy?: boolean;
  workers?: number;
  state?: string;
  dryRun?: boolean;
  retryFailed?: boolean;
  delaySec?: number;
  accountsFile?: string;
  proxyFile?: string;
  useProxy?: boolean;
  limit?: number;
  proxyFormat?: string;
}

/** Pure: merge parsed CLI flags into an env object (CLI wins over env file). */
export function applyArgsToEnv(args: Args, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  if (args.engine !== undefined) env.BROWSER_ENGINE = args.engine;
  if (args.workers !== undefined) env.WORKERS = String(args.workers);
  if (args.headless !== undefined) env.HEADLESS = args.headless ? "1" : "0";
  if (args.retryFailed !== undefined) env.RETRY_FAILED = args.retryFailed ? "1" : "0";
  if (args.delaySec !== undefined) env.INTER_ACCOUNT_DELAY_SEC = String(args.delaySec);
  if (args.pace !== undefined) env.PACE = args.pace;
  if (args.googleDirect !== undefined) env.GOOGLE_DIRECT = args.googleDirect ? "1" : "0";
  if (args.reuseProxy !== undefined) env.PROXY_REUSE = args.reuseProxy ? "1" : "0";
  if (args.accountsFile !== undefined) env.SEED_GSUITE = args.accountsFile;
  if (args.proxyFile !== undefined) env.WEBSHARE_SEED_PROXY = args.proxyFile;
  if (args.limit !== undefined) env.LIMIT = String(args.limit);
  if (args.proxyFormat !== undefined) env.WEBSHARE_PROXY_FORMAT = args.proxyFormat;
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
    else if (a === "--fast") args.pace = "fast";
    else if (a === "--careful") args.pace = "careful";
    else if (a === "--pace") args.pace = next();
    else if (a === "--google-direct") args.googleDirect = true;
    else if (a === "--no-google-direct") args.googleDirect = false;
    else if (a === "--reuse-proxy" || a === "--rotate-proxy" || a === "--loop-proxy") args.reuseProxy = true;
    else if (a === "--unique-proxy") args.reuseProxy = false;
    else if (a === "--engine" || a === "-e") args.engine = next();
    else if (a === "--camoufox") args.engine = "python";
    else if (a === "--bun") args.engine = "bun";
    else if (a === "--accounts-file") args.accountsFile = next();
    else if (a === "--proxy-file" || a === "--proxy") {
      args.useProxy = true;
      args.proxyFile = next();
    } else if (a === "--no-proxy") args.useProxy = false;
    else if (a === "--with-proxy") args.useProxy = true;
    else if (a === "--limit" || a === "-l" || a === "-n") args.limit = Number(next());
    else if (a === "--proxy-format") args.proxyFormat = next();
    else if (a === "--help" || a === "-h") {
      console.log(
        `Usage: bun run webshare -- [--engine bun|python] [--headless] [--headed] [-w N] [--dry-run] [--retry-failed]\n` +
        `                        [--delay SEC] [--fast | --careful | --pace fast|human|careful]\n` +
        `                        [--accounts-file F] [--proxy-file F] [--no-proxy] [--limit N]\n\n` +
        `  --engine E     pilih engine browser: 'python' (Camoufox/Firefox) atau 'bun' (Chromium/Puppeteer)\n` +
        `  --camoufox     alias untuk --engine python (bypass Cloudflare Turnstile & anti-bot otomatis)\n` +
        `  --fast         human-shaped but no dead waiting (~1 min/account instead of ~2)\n` +
        `  --careful      slower than a real user; for hostile risk engines\n` +
        `  --reuse-proxy  rotasi/loop proxy: putar kembali dari awal jika habis\n` +
        `  --rotate-proxy alias untuk --reuse-proxy\n` +
        `  --delay SEC    seconds between accounts — this is the risk-control knob, not --fast\n` +
        `  --no-proxy     run directly without signup proxies\n` +
        `  --proxy F      file proxy untuk proses signup (default: signup-proxy.txt)`,
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
      accountsFile: args.accountsFile ?? cfg.seedGsuite,
      outputFile: cfg.proxyFile,
      limit: args.limit !== undefined ? args.limit : undefined,
      pace: args.pace ?? (typeof cfg.pace === "object" ? (cfg.pace as any).name : cfg.pace),
      dryRun: args.dryRun,
      workers: args.workers ?? cfg.workers,
      extraArgs: [
        ...(args.proxyFormat ? ["--proxy-format", args.proxyFormat] : []),
        ...(args.reuseProxy ? ["--reuse-proxy"] : []),
        ...(cfg.resultSuccessFile ? ["--result-success-file", cfg.resultSuccessFile] : []),
        ...(cfg.resultFailedFile ? ["--result-failed-file", cfg.resultFailedFile] : []),
      ],
    });
    return;
  }

  const log = createLog({ cli: "main" });
  log("info", "start", {
    workers: cfg.workers,
    headless: cfg.headless,
    pace: cfg.pace,
    retryFailed: cfg.retryFailed,
    state: cfg.stateFile,
    results: { success: cfg.resultSuccessFile, failed: cfg.resultFailedFile, proxies: cfg.proxyFile },
    seeds: { gsuite: cfg.seedGsuite, signupProxy: cfg.seedProxyForSignup },
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