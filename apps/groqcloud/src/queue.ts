// ── Queue processor for GroqCloud ────────────────────────────────────
import path from "node:path";
import type { GroqCloudConfig } from "./config.js";
import { loadAccounts, loadProxies, type Account } from "./loaders.js";
import { createLog } from "./log.js";
import { FlowState, JsonlStore, ResultWriter } from "./store.js";
import { runGroqCloudAccount } from "./runner.js";

export class SmartProxyPool {
  private freshProxies: string[];
  public goodProxies: string[] = [];
  public badAddresses = new Set<string>();

  constructor(proxies: string[]) {
    this.freshProxies = [...proxies];
  }

  public addressOf(proxyStr: string): string {
    try {
      const u = proxyStr.includes("://") ? proxyStr : `http://${proxyStr}`;
      return new URL(u).hostname;
    } catch {
      return proxyStr;
    }
  }

  public getNextProxy(): string | null {
    // 1. Fresh proxy that hasn't failed
    while (this.freshProxies.length > 0) {
      const p = this.freshProxies.shift()!;
      const addr = this.addressOf(p);
      if (!this.badAddresses.has(addr)) {
        return p;
      }
    }

    // 2. Reuse proven good proxy
    if (this.goodProxies.length > 0) {
      const p = this.goodProxies.shift()!;
      this.goodProxies.push(p);
      return p;
    }

    return null;
  }

  public markResult(proxyStr: string | null, success: boolean) {
    if (!proxyStr) return;
    const addr = this.addressOf(proxyStr);
    if (success) {
      if (!this.goodProxies.includes(proxyStr)) {
        this.goodProxies.push(proxyStr);
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

  public get freshCount(): number {
    return this.freshProxies.length;
  }

  public get goodCount(): number {
    return this.goodProxies.length;
  }
}

export async function processQueue(cfg: GroqCloudConfig, store: JsonlStore): Promise<void> {
  const log = createLog({ queue: "main" });
  const results = new ResultWriter(cfg.resultSuccessFile, cfg.resultFailedFile, cfg.apiKeyFile);

  const rawAccounts = cfg.seedAccounts ? loadAccounts(cfg.seedAccounts) : [];
  const proxies = cfg.useProxy ? loadProxies(cfg.seedProxy) : [];

  if (cfg.useProxy && proxies.length === 0 && loadProxies(path.join(process.cwd(), "proxy.txt")).length > 0) {
    log("warn", "proxy-live.txt kosong padahal proxy.txt terisi — jalankan `bun run proxy-check` dulu, atau pakai --no-proxy.");
  }

  log("info", "seeds loaded", { accounts: rawAccounts.length, proxies: proxies.length });

  const proxyPool = cfg.useProxy && proxies.length > 0 ? new SmartProxyPool(proxies) : null;

  let todoAccounts: Account[] = [];
  if (rawAccounts.length > 0) {
    const succeeded = results.getSuccessfulEmails();
    const previouslyFailed = results.getFailedEmails();

    todoAccounts = rawAccounts.filter((acc) => {
      if (succeeded.has(acc.email)) return false;
      const rec = store.get(acc.email);
      if (rec?.status === FlowState.DONE) return false;
      if (!cfg.retryFailed && (previouslyFailed.has(acc.email) || rec?.status === FlowState.FAILED)) {
        return false;
      }
      return true;
    });

    log("info", "accounts to process", {
      total: rawAccounts.length,
      todo: todoAccounts.length,
      skipped: rawAccounts.length - todoAccounts.length,
      retryFailed: cfg.retryFailed,
    });
  }

  const targetCount = cfg.limit > 0 ? cfg.limit : (rawAccounts.length > 0 ? todoAccounts.length : (proxies.length > 0 ? proxies.length : 1));
  log("info", "processing plan", { targetSuccess: targetCount, useProxy: cfg.useProxy, proxyCount: proxies.length });

  let accountCursor = 0;
  let successCount = 0;
  let processedAttempts = 0;
  const maxAttempts = proxyPool ? Math.max(targetCount * 4, proxies.length * 2, 10) : targetCount;

  async function worker(workerId: number): Promise<void> {
    while (true) {
      if (successCount >= targetCount) break;
      if (processedAttempts >= maxAttempts) break;

      let account: Account | null = null;
      if (rawAccounts.length > 0) {
        if (accountCursor >= todoAccounts.length) break;
        account = todoAccounts[accountCursor++];
      }

      processedAttempts++;

      let proxy: string | null = null;
      if (proxyPool) {
        proxy = proxyPool.getNextProxy();
        if (proxy === null) {
          log("warn", `worker #${workerId}: all proxies have been exhausted or blacklisted. No usable proxies left.`);
          break;
        }
      }

      const res = await runGroqCloudAccount(account, proxy, store, results, cfg);
      if (proxyPool && proxy) {
        proxyPool.markResult(proxy, res.success);
        if (res.success) {
          log("info", `proxy ${proxy} verified GOOD! Added to reusable proxy pool.`);
        } else {
          log("warn", `proxy ${proxy} failed/rejected. Discarded and will not be reused.`);
        }
      }

      if (res.success) {
        successCount++;
        log("info", `progress: ${successCount}/${targetCount} accounts succeeded.`);
      }

      if (successCount < targetCount) {
        const delaySec = res.success ? cfg.interAccountDelaySec : Math.min(1.5, cfg.interAccountDelaySec);
        if (delaySec > 0) {
          log("info", `worker #${workerId} waiting ${delaySec}s before next account...`);
          await new Promise((r) => setTimeout(r, delaySec * 1000));
        }
      }
    }
  }

  const workerCount = Math.min(cfg.workers, targetCount || 1);
  log("info", "starting worker pool", { workers: workerCount, target: targetCount });
  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i + 1)));

  log("info", "queue finished", { succeeded: successCount, target: targetCount, totalAttempts: processedAttempts });
}
