import fs from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * Finds the Python interpreter that has camoufox installed.
 * Checks environment overrides, typical virtualenvs, and system python.
 */
export function findCamoufoxPython(): string {
  if (process.env.CAMOUFOX_PYTHON && fs.existsSync(process.env.CAMOUFOX_PYTHON)) {
    return process.env.CAMOUFOX_PYTHON;
  }
  const knownPaths = [
    "/home/azhar/.venvs/camoufox/bin/python",
    process.env.VIRTUAL_ENV ? `${process.env.VIRTUAL_ENV}/bin/python` : "",
    "/usr/bin/python3",
    "python3",
  ].filter(Boolean);

  for (const p of knownPaths) {
    if (fs.existsSync(p)) return p;
  }
  return "python3";
}

export function shouldUsePythonEngine(explicitEngine?: string): boolean {
  if (explicitEngine) {
    const e = explicitEngine.toLowerCase();
    return e === "python" || e === "camoufox";
  }
  const envEngine = (process.env.BROWSER_ENGINE ?? process.env.ENGINE ?? "").toLowerCase();
  return envEngine === "python" || envEngine === "camoufox";
}

export interface PythonRunnerOptions {
  headed?: boolean;
  useProxy?: boolean;
  proxyFile?: string;
  delaySec?: number;
  retryFailed?: boolean;
  stateFile?: string;
  accountsFile?: string;
  outputFile?: string;
  limit?: number;
  dryRun?: boolean;
}

/**
 * Spawns the corresponding Python Camoufox runner script with stdio forwarded.
 */
export function spawnPythonRunner(runnerPath: string, opts: PythonRunnerOptions): never {
  const pythonBin = findCamoufoxPython();
  const args = [runnerPath];

  if (opts.dryRun) args.push("--dry-run");
  if (opts.headed) args.push("--headed");
  if (opts.useProxy === false) args.push("--no-proxy");
  if (opts.proxyFile) args.push("--proxy-file", opts.proxyFile);
  if (opts.delaySec !== undefined) args.push("--delay", String(opts.delaySec));
  if (opts.retryFailed) args.push("--retry-failed");
  if (opts.stateFile) args.push("--state-file", opts.stateFile);
  if (opts.accountsFile) args.push("--accounts-file", opts.accountsFile);
  if (opts.outputFile) args.push("--output-file", opts.outputFile);
  if (opts.limit !== undefined) args.push("--limit", String(opts.limit));


  console.log(`[engine] Delegating to Python Camoufox (${pythonBin})...`);
  console.log(`[engine] Command: ${pythonBin} ${args.join(" ")}\n`);

  const result = spawnSync(pythonBin, args, {
    stdio: "inherit",
    env: { ...process.env, PYTHONPATH: "." },
  });

  if (result.error) {
    console.error(`[engine] Failed to launch Python Camoufox runner: ${result.error.message}`);
    process.exit(1);
  }

  process.exit(result.status ?? 0);
}
