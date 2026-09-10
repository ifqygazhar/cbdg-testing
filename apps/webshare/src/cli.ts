#!/usr/bin/env bun
// ── CLI entrypoint (Bun) ────────────────────────────────────────────
import { loadConfig, ensureDirs } from "./config.js";
import { createLog } from "./log.js";
import { JsonlStore } from "./store.js";
import { processQueue } from "./queue.js";

interface Args {
  headless?: boolean;
  pace?: string;
  googleDirect?: boolean;
  reuseProxy?: boolean;
  workers?: number;
  state?: string;
  dryRun?: boolean;
  retryFailed?: boolean;
  delaySec?: number;
}

/** Pure: merge parsed CLI flags into an env object (CLI wins over env file). */
export function applyArgsToEnv(args: Args, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  if (args.workers !== undefined) env.WORKERS = String(args.workers);
  if (args.headless !== undefined) env.HEADLESS = args.headless ? "1" : "0";
  if (args.retryFailed !== undefined) env.RETRY_FAILED = args.retryFailed ? "1" : "0";
  if (args.delaySec !== undefined) env.INTER_ACCOUNT_DELAY_SEC = String(args.delaySec);
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
    else if (a === "--headed") args.headless = false;
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
    else if (a === "--reuse-proxy") args.reuseProxy = true;
    else if (a === "--unique-proxy") args.reuseProxy = false;
    else if (a === "--help" || a === "-h") {
      console.log(
        `Usage: bun run webshare -- [--headless] [--headed] [-w N] [--dry-run] [--retry-failed]
` +
        `                        [--delay SEC] [--fast | --careful | --pace fast|human|careful]

` +
        `  --fast     human-shaped but no dead waiting (~1 min/account instead of ~2)
` +
        `  --careful  slower than a real user; for hostile risk engines
` +
        `  --delay    seconds between accounts — this is the risk-control knob, not --fast`,
      );
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  const env = applyArgsToEnv(args, process.env);
  const cfg = loadConfig(env);
  ensureDirs(cfg);

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