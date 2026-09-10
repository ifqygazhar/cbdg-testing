#!/usr/bin/env bun
// ── CLI entrypoint (Bun) ────────────────────────────────────────────
import { loadConfig, ensureDirs } from "./config.js";
import { createLog } from "./log.js";
import { JsonlStore } from "./store.js";
import { processQueue } from "./queue.js";

interface Args {
  headless?: boolean;
  workers?: number;
  state?: string;
  region?: string;
  dryRun?: boolean;
  retryFailed?: boolean;
  delaySec?: number;
  useProxy?: boolean;
  proxyFile?: string;
  googleDirect?: boolean;
  reuseProxy?: boolean;
  mode?: string;
  pace?: string;
}

/** Pure: merge parsed CLI flags into an env object (CLI wins over env file). */
export function applyArgsToEnv(args: Args, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  if (args.workers !== undefined) env.WORKERS = String(args.workers);
  if (args.region) env.REGION = args.region;
  if (args.headless !== undefined) env.HEADLESS = args.headless ? "1" : "0";
  if (args.retryFailed !== undefined) env.RETRY_FAILED = args.retryFailed ? "1" : "0";
  if (args.delaySec !== undefined) env.INTER_ACCOUNT_DELAY_SEC = String(args.delaySec);
  if (args.useProxy !== undefined) env.USE_PROXY = args.useProxy ? "1" : "0";
  if (args.proxyFile !== undefined) env.SEED_PROXY = args.proxyFile;
  if (args.mode !== undefined) env.MODE = args.mode;
  if (args.pace !== undefined) env.PACE = args.pace;
  if (args.googleDirect !== undefined) env.GOOGLE_DIRECT = args.googleDirect ? "1" : "0";
  if (args.reuseProxy !== undefined) env.PROXY_REUSE = args.reuseProxy ? "1" : "0";
  return env;
}

export const USAGE = [
  "Usage: bun run cbdg -- [--headless] [--headed] [-w N] [--region SG] [--dry-run]",
  "                     [--retry-failed] [--delay SEC] [--signup-only | --full]",
  "                     [--fast | --careful | --pace fast|human|careful]",
  "",
  "  --signup-only  stop after registration: keep the new-user credits and never",
  "                 submit a card. vcc.txt is not needed in this mode.",
  "  --full         default: also link the card, wait out 3DS and start the trial",
  "  --fast         human-shaped but no dead waiting",
  "  --careful      slower than a real user; for hostile risk engines",
  "  --delay        seconds between accounts — the risk-control knob, not --fast",
  "  --no-proxy     ignore proxy.txt and run every account from this IP",
  "  --proxy FILE   use a specific proxy file (default proxy.txt)",
  "  --no-google-direct  send google sign-in through the proxy too (default: direct,",
  "                 because a datacenter address earns an image captcha)",
].join("\n");

/** Printing usage and exiting is the CLI's job, not the parser's. */
function printUsageAndExit(): void {
  console.log(USAGE);
  process.exit(0);
}

/**
 * `onHelp` is injectable so tests can assert the help path without the parser
 * calling `process.exit` under the test runner, which kills the whole suite
 * silently and takes every test after it with it.
 */
export function parseArgs(argv: string[], onHelp: () => void = printUsageAndExit): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--headless") args.headless = true;
    else if (a === "--headed") args.headless = false;
    else if (a === "--workers" || a === "-w") args.workers = Number(next());
    else if (a === "--state") args.state = next();
    else if (a === "--region") args.region = next();
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--retry-failed") args.retryFailed = true;
    else if (a === "--no-retry-failed") args.retryFailed = false;
    else if (a === "--delay") args.delaySec = Number(next());
    else if (a === "--no-proxy") args.useProxy = false;
    else if (a === "--proxy") { args.useProxy = true; args.proxyFile = next(); }
    else if (a === "--with-proxy") args.useProxy = true;
    else if (a === "--signup-only" || a === "--no-vcc") args.mode = "signup";
    else if (a === "--full") args.mode = "full";
    else if (a === "--mode") args.mode = next();
    else if (a === "--fast") args.pace = "fast";
    else if (a === "--careful") args.pace = "careful";
    else if (a === "--pace") args.pace = next();
    else if (a === "--google-direct") args.googleDirect = true;
    else if (a === "--no-google-direct") args.googleDirect = false;
    else if (a === "--reuse-proxy") args.reuseProxy = true;
    else if (a === "--unique-proxy") args.reuseProxy = false;
    else if (a === "--help" || a === "-h") {
      onHelp();
      return args;
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
    mode: cfg.mode,
    pace: cfg.pace,
    region: cfg.region,
    workers: cfg.workers,
    headless: cfg.headless,
    retryFailed: cfg.retryFailed,
    state: cfg.stateFile,
    results: { success: cfg.resultSuccessFile, failed: cfg.resultFailedFile },
    seeds: { gsuite: cfg.seedGsuite, vcc: cfg.seedVcc, proxy: cfg.seedProxy },
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