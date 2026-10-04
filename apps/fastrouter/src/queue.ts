// ── Queue: iterate seed accounts, skip terminal, bounded parallelism ──
import path from "node:path";
import type { AppConfig } from "./config.js";
import { loadAccounts, loadProxies, type GsuiteAccount, type ProxySeed } from "./loaders.js";
import { createLog } from "./log.js";
import { FlowState, JsonlStore, ResultWriter } from "./store.js";
import { assignUniqueProxies, TempMailClient } from "@ifqy/google-oauth";
import { runAccount } from "./runner.js";

export class SmartProxyPool {
  private freshProxies: ProxySeed[];
  public goodProxies: ProxySeed[] = [];
  public badAddresses = new Set<string>();

  constructor(proxies: ProxySeed[]) {
    this.freshProxies = [...proxies];
  }

  public addressOf(proxy: ProxySeed): string {
    try {
      return new URL(proxy.server).hostname;
    } catch {
      return proxy.server;
    }
  }

  public getNextProxy(): ProxySeed | null {
    while (this.freshProxies.length > 0) {
      const p = this.freshProxies.shift()!;
      const addr = this.addressOf(p);
      if (!this.badAddresses.has(addr)) {
        return p;
      }
    }
    if (this.goodProxies.length > 0) {
      const p = this.goodProxies.shift()!;
      this.goodProxies.push(p);
      return p;
    }
    return null;
  }

  public markResult(proxy: ProxySeed | null, success: boolean) {
    if (!proxy) return;
    const addr = this.addressOf(proxy);
    if (success) {
      if (!this.goodProxies.includes(proxy)) {
        this.goodProxies.push(proxy);
      }
    } else {
      this.badAddresses.add(addr);
      this.goodProxies = this.goodProxies.filter((p) => this.addressOf(p) !== addr);
      this.freshProxies = this.freshProxies.filter((p) => this.addressOf(p) !== addr);
    }
  }

  public get hasProxies(): boolean {
    return this.freshProxies.length > 0 || this.goodProxies.length > 0;
  }
}

async function processTempMailQueue(
  cfg: AppConfig,
  store: JsonlStore,
  results: ResultWriter,
  proxies: ProxySeed[],
  log: ReturnType<typeof createLog>,
): Promise<void> {
  const tempMail = new TempMailClient({ defaultDomain: cfg.tempMailDomain });
  const proxyPool = cfg.useProxy && proxies.length > 0 ? new SmartProxyPool(proxies) : null;
  const targetCount = cfg.limit > 0 ? cfg.limit : 5;

  log("info", "tempmail queue plan", {
    targetSuccess: targetCount,
    domain: cfg.tempMailDomain,
    useProxy: cfg.useProxy,
    proxyCount: proxies.length,
  });

  let successCount = 0;
  let processedAttempts = 0;
  const maxAttempts = proxyPool ? Math.max(targetCount * 4, proxies.length * 2, 10) : targetCount;
  const delayMs = cfg.interAccountDelaySec * 1000;

  async function worker(workerId: number): Promise<void> {
    while (true) {
      if (successCount >= targetCount) break;
      if (processedAttempts >= maxAttempts) break;

      processedAttempts++;

      let proxy: ProxySeed | null = null;
      if (proxyPool) {
        proxy = proxyPool.getNextProxy();
        if (proxy === null) {
          log("warn", `worker #${workerId}: all proxies have been exhausted or blacklisted. No usable proxies left.`);
          break;
        }
      }

      let createdEmail: string;
      try {
        const created = await tempMail.createEmail(cfg.tempMailDomain);
        createdEmail = created.email;
      } catch (err: any) {
        log("error", `worker #${workerId}: failed to create TempMail address: ${err.message}`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      const acc: GsuiteAccount = {
        email: createdEmail,
        password: cfg.tempMailPassword || "FastRouter@2026!",
        raw: `${createdEmail}:${cfg.tempMailPassword || "FastRouter@2026!"}`,
      };

      let state = FlowState.FAILED;
      try {
        state = await runAccount(acc, proxy, store, results, cfg);
      } catch (e: any) {
        log("error", `unexpected runner failure for ${acc.email}: ${e.message}`);
        results.markFailed(acc.email, `RUNNER_CRASH: ${e.message}`);
      }

      const ok = state === FlowState.DONE;
      if (proxyPool && proxy) {
        proxyPool.markResult(proxy, ok);
        if (ok) {
          log("info", `proxy ${proxy.server} verified GOOD! Added to reusable proxy pool.`);
        } else {
          log("warn", `proxy ${proxy.server} failed/rejected. Discarded.`);
        }
      }

      if (ok) {
        successCount++;
        log("info", `progress: ${successCount}/${targetCount} accounts succeeded.`);
      }

      if (successCount < targetCount) {
        const wait = ok ? delayMs : Math.min(1500, delayMs);
        if (wait > 0) {
          log("info", `worker #${workerId} waiting ${(wait / 1000).toFixed(1)}s before next account...`);
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    }
  }

  const workerCount = Math.min(cfg.workers, targetCount || 1);
  log("info", "starting worker pool", { workers: workerCount, target: targetCount });
  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i + 1)));

  log("info", "queue finished", { succeeded: successCount, target: targetCount, totalAttempts: processedAttempts });
}

export async function processQueue(cfg: AppConfig, store: JsonlStore): Promise<void> {
  const log = createLog({ queue: "main" });
  const results = new ResultWriter(cfg.resultSuccessFile, cfg.resultFailedFile, cfg.apiKeyFile);

  const proxies = cfg.useProxy ? loadProxies(cfg.seedProxy) : [];
  if (cfg.useProxy && proxies.length === 0 && loadProxies(path.join(process.cwd(), "proxy.txt")).length > 0) {
    log("warn", "proxy-live.txt kosong padahal proxy.txt terisi — jalankan `bun run proxy-check` dulu, atau pakai --no-proxy.");
  }

  // If TempMail mode, delegate to TempMail queue processor
  if (cfg.authMethod === "tempmail") {
    await processTempMailQueue(cfg, store, results, proxies, log);
    return;
  }

  const accounts = loadAccounts(cfg.seedGsuite);
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
