// ── Queue: iterate seed accounts, skip terminal, bounded parallelism ──
import path from "node:path";
import type { AppConfig } from "./config.js";
import { loadAccounts, loadProxies } from "./loaders.js";
import { createLog } from "./log.js";
import { FlowState, JsonlStore, ResultWriter } from "./store.js";
import { assignUniqueProxies } from "@ifqy/google-oauth";
import { runAccount } from "./runner.js";

export async function processQueue(cfg: AppConfig, store: JsonlStore): Promise<void> {
  const log = createLog({ queue: "main" });
  const results = new ResultWriter(cfg.resultSuccessFile, cfg.resultFailedFile, cfg.apiKeyFile);

  const accounts = loadAccounts(cfg.seedGsuite);
  const proxies = cfg.useProxy ? loadProxies(cfg.seedProxy) : [];
  if (cfg.useProxy && proxies.length === 0 && loadProxies(path.join(process.cwd(), "proxy.txt")).length > 0) {
    log("warn", "proxy-live.txt kosong padahal proxy.txt terisi — jalankan `bun run proxy-check` dulu, atau pakai --no-proxy.");
  }
  log("info", `seeds loaded`, { accounts: accounts.length, proxies: proxies.length });

  if (accounts.length === 0) {
    log("warn", "no accounts in gsuite.txt — nothing to do");
    return;
  }

  const succeeded = results.getSuccessfulEmails();
  const previouslyFailed = results.getFailedEmails();
  const restricted = results.getPermanentlyFailedEmails("ACCOUNT_RESTRICTED");

  const shouldSkip = (email: string): boolean | string => {
    if (restricted.has(email)) return "restricted";
    if (succeeded.has(email)) return true;
    const rec = store.get(email);
    if (rec?.status === FlowState.DONE) return true;
    if (!cfg.retryFailed) {
      if (previouslyFailed.has(email)) return true;
      if (rec?.status === FlowState.FAILED) return true;
    }
    return false;
  };

  const todo: typeof accounts = [];
  for (const acc of accounts) {
    const skip = shouldSkip(acc.email);
    if (skip !== false) {
      log(
        "info",
        skip === "restricted"
          ? `skip (risk-control ban — permanent, never retried): ${acc.email}`
          : `skip (already processed): ${acc.email}`,
      );
      continue;
    }
    todo.push(acc);
  }
  log("info", `accounts to process`, {
    total: accounts.length,
    todo: todo.length,
    skipped: accounts.length - todo.length,
    retryFailed: cfg.retryFailed,
  });

  if (todo.length === 0) {
    log("info", "nothing to do — all accounts already processed");
    return;
  }

  if (todo.length > 1 && proxies.length === 0) {
    log(
      "warn",
      `no proxies in ${cfg.seedProxy} — all ${todo.length} accounts share this IP; risk-control restriction is likely. Add proxies and/or set INTER_ACCOUNT_DELAY_SEC.`,
    );
  }

  const addressOf = (server: string): string => {
    try {
      return new URL(server).hostname;
    } catch {
      return server;
    }
  };
  const previous = new Map<string, string>();
  for (const rec of store.all()) {
    if (rec.proxy) previous.set(rec.email, cfg.reuseProxy ? rec.proxy : addressOf(rec.proxy));
  }
  const { paired, heldBack, remaining, distinct } = assignUniqueProxies({
    accounts: todo,
    proxies,
    idOf: (a) => a.email,
    keyOf: (p) => (cfg.reuseProxy ? p.server : addressOf(p.server)),
    previous,
    reuse: cfg.reuseProxy,
  });
  if (proxies.length > 0) {
    log("info", "proxy pairing", {
      mode: cfg.reuseProxy ? "reuse" : "unique",
      lines: proxies.length,
      addresses: distinct,
      assigned: paired.filter((x) => x.proxy).length,
      unused: remaining,
    });
  }
  for (const acc of heldBack) {
    log("warn", `skip (kehabisan proxy yang belum terpakai): ${acc.email}`);
  }
  const queue = paired.filter((x) => x.proxy !== null || proxies.length === 0);
  if (queue.length === 0) {
    log("warn", "tidak ada akun yang bisa dijalankan — tambah proxy, atau pakai --reuse-proxy / --no-proxy");
    return;
  }

  const workers = Math.max(1, cfg.workers);
  const delayMs = cfg.interAccountDelaySec * 1000;
  let next = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const idx = next++;
      if (idx >= queue.length) return;
      const { account: acc, proxy } = queue[idx];
      try {
        await runAccount(acc, proxy, store, results, cfg);
      } catch (e) {
        log("error", `unexpected runner failure for ${acc.email}: ${(e as Error).message}`);
        results.markFailed(acc.email, `RUNNER_CRASH: ${(e as Error).message}`);
      }
      if (delayMs > 0 && next < queue.length) {
        const wait = delayMs + Math.floor(Math.random() * (delayMs / 2));
        log("info", `spacing: waiting ${(wait / 1000).toFixed(1)}s before the next account`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(workers, queue.length) }, worker));
  log("info", "queue finished");
}
