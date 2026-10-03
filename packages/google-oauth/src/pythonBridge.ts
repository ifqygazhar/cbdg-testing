import fs from "node:fs";
import { spawn, execSync } from "node:child_process";

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
  domain?: string;
  dryRun?: boolean;
}

/**
 * Recursively retrieves descendant PIDs of a process.
 */
export function getDescendantPids(pid: number): number[] {
  const pids: number[] = [];
  try {
    const out = execSync(`pgrep -P ${pid} 2>/dev/null || true`, { encoding: "utf8" });
    const lines = out.trim().split(/\s+/).filter(Boolean);
    for (const l of lines) {
      const cid = Number(l);
      if (!isNaN(cid) && cid > 0) {
        pids.push(cid);
        pids.push(...getDescendantPids(cid));
      }
    }
  } catch {
    // ignore
  }
  return pids;
}

/**
 * Force-terminates a process and all its child/grandchild processes.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals | "SIGKILL" = "SIGTERM"): void {
  const descendants = getDescendantPids(pid);
  for (const cid of descendants.reverse()) {
    try {
      process.kill(cid, signal);
    } catch {
      // ignore
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // ignore
  }
}

/**
 * Spawns the corresponding Python Camoufox runner script with stdio forwarded.
 * Handles SIGINT/SIGTERM cleanly so that Ctrl+C kills all Python, Playwright,
 * and Camoufox browser processes immediately.
 */
export function spawnPythonRunner(runnerPath: string, opts: PythonRunnerOptions): Promise<never> {
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
  if (opts.domain) args.push("--domain", opts.domain);

  console.log(`[engine] Delegating to Python Camoufox (${pythonBin})...`);
  console.log(`[engine] Command: ${pythonBin} ${args.join(" ")}\n`);

  return new Promise<never>((_, reject) => {
    const child = spawn(pythonBin, args, {
      stdio: "inherit",
      env: { ...process.env, PYTHONPATH: "." },
    });

    let terminating = false;
    const cleanup = (sig: NodeJS.Signals) => {
      if (terminating) return;
      terminating = true;
      if (child.pid) {
        killProcessTree(child.pid, sig);
        setTimeout(() => {
          if (child.pid) {
            killProcessTree(child.pid, "SIGKILL");
          }
          process.exit(130);
        }, 1000).unref();
      } else {
        process.exit(130);
      }
    };

    process.on("SIGINT", () => cleanup("SIGINT"));
    process.on("SIGTERM", () => cleanup("SIGTERM"));
    process.on("SIGHUP", () => cleanup("SIGHUP"));

    process.on("exit", () => {
      if (child.pid) {
        killProcessTree(child.pid, "SIGKILL");
      }
    });

    child.on("error", (err) => {
      console.error(`[engine] Failed to launch Python Camoufox runner: ${err.message}`);
      process.exit(1);
    });

    child.on("close", (code, signal) => {
      if (child.pid) {
        killProcessTree(child.pid, "SIGKILL");
      }
      if (signal) {
        process.exit(128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1));
      }
      process.exit(code ?? 0);
    });
  });
}
