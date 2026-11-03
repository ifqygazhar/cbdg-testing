// ── Concurrency queue & SmartProxyPool for ChatGPT ────────────────
import path from "node:path";
import type { GptConfig } from "./config.js";
import { loadAccounts, loadProxies, type Account } from "./loaders.js";
import { createLog } from "./log.js";
import { runGptAccount } from "./runner.js";
import { FlowState, ResultWriter, type JsonlStore } from "./store.js";

export class SmartProxyPool {
  public freshProxies: string[];
  public goodProxies: string[] = [];
  public badAddresses = new Set<string>();
  public reuseProxy: boolean;

  constructor(proxies: string[], reuseProxy = false) {
    this.freshProxies = [...proxies];
    this.reuseProxy = reuseProxy;
  }

  public addressOf(proxyStr: string): string {
    try {
      const u = proxyStr.includes("://") ? proxyStr : `http://${proxyStr}`;
      return new URL(u).hostname;
    } catch {
      return proxyStr;
    }
  }

  public get freshCount(): number {
    return this.freshProxies.length;
  }

  public get goodCount(): number {
    return this.goodProxies.length;
  }

  public get hasProxies(): boolean {
    return this.freshProxies.length > 0 || this.goodProxies.length > 0;
  }

  public getNextProxy(): string | null {
    if (this.reuseProxy && this.goodProxies.length > 0) {
      const p = this.goodProxies.shift()!;
      this.goodProxies.push(p);
      return p;
    }

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

  public async getNextLiveProxy(
    targetUrl = "https://chatgpt.com/",
    timeoutMs = 6000,
    batchSize = 15,
  ): Promise<string | null> {
    if (this.reuseProxy && this.goodProxies.length > 0) {
      const p = this.goodProxies.shift()!;
      this.goodProxies.push(p);
      return p;
    }

    while (true) {
      if (this.goodProxies.length > 0) {
        const p = this.goodProxies.shift()!;
        if (this.reuseProxy) this.goodProxies.push(p);
        return p;
      }

      const candidates: string[] = [];
      while (this.freshProxies.length > 0 && candidates.length < batchSize) {
        const p = this.freshProxies.shift()!;
        const addr = this.addressOf(p);
        if (!this.badAddresses.has(addr)) {
          candidates.push(p);
        }
      }

      if (candidates.length === 0) {
        if (this.goodProxies.length > 0) {
          const p = this.goodProxies.shift()!;
          if (this.reuseProxy) this.goodProxies.push(p);
          return p;
        }
        return null;
      }

      const probeResults = await Promise.all(
        candidates.map(async (cand) => {
          const t0 = Date.now();
          try {
            const resp = await fetch(targetUrl, {
              proxy: cand.includes("://") ? cand : `http://${cand}`,
              signal: AbortSignal.timeout(timeoutMs),
            });
            const dt = ((Date.now() - t0) / 1000).toFixed(2);
            return { proxy: cand, ok: resp.status === 200, status: resp.status, dt };
          } catch (e: any) {
            const dt = ((Date.now() - t0) / 1000).toFixed(2);
            return { proxy: cand, ok: false, status: e.name || "timeout", dt };
          }
        }),
      );

      const good: string[] = [];
      for (const r of probeResults) {
        if (r.ok) {
          good.push(r.proxy);
        } else {
          this.badAddresses.add(this.addressOf(r.proxy));
        }
      }

      if (good.length > 0) {
        const chosen = good[0];
        if (good.length > 1) {
          for (let i = 1; i < good.length; i++) {
            if (!this.goodProxies.includes(good[i])) {
              this.goodProxies.push(good[i]);
            }
          }
        }
        return chosen;
      }
    }
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
    }
  }
}

export async function processQueue(cfg: GptConfig, store: JsonlStore): Promise<void> {
  const log = createLog({ cli: "queue" });
  const results = new ResultWriter(cfg.resultSuccessFile, cfg.resultFailedFile);

  const rawAccounts = cfg.authMethod === "google" && cfg.seedAccounts ? loadAccounts(cfg.seedAccounts) : [];
  let accountsToProcess: Account[] = [];

  if (cfg.authMethod === "google") {
    for (const acc of rawAccounts) {
      const norm = acc.email.toLowerCase();
      if (results.getSuccessfulEmails().has(norm)) continue;
      const rec = store.get(norm);
      if (rec && rec.status === FlowState.DONE) continue;
      if (rec && rec.status === FlowState.FAILED && !cfg.retryFailed) continue;
      accountsToProcess.push(acc);
    }
    if (cfg.limit > 0 && accountsToProcess.length > cfg.limit) {
      accountsToProcess = accountsToProcess.slice(0, cfg.limit);
    }
    log("info", "accounts loaded for Google OAuth", {
      total: rawAccounts.length,
      pending: accountsToProcess.length,
      limit: cfg.limit,
    });
  }

  const proxies = cfg.useProxy ? loadProxies(cfg.seedProxy) : [];
  if (cfg.useProxy && proxies.length === 0 && loadProxies(path.join(process.cwd(), "proxy.txt")).length > 0) {
    log("warn", "proxy-live.txt kosong padahal proxy.txt terisi — jalankan `bun run proxy-check` dulu jika proxy live belum di-filter");
  }

  const proxyPool = cfg.useProxy && proxies.length > 0 ? new SmartProxyPool(proxies, cfg.proxyReuse) : null;
  const targetCount = cfg.limit > 0 ? cfg.limit : (cfg.authMethod === "google" ? accountsToProcess.length : (proxies.length > 0 ? proxies.length : 1));

  log("info", "processing plan", {
    targetSuccess: targetCount,
    useProxy: cfg.useProxy,
    proxyCount: proxies.length,
    workers: cfg.workers,
  });

  let successCount = 0;
  let activeWorkers = 0;
  let hasMore = true;

  const MAX_PROXY_ATTEMPTS = proxyPool ? 3 : 1;
  const maxAttempts = proxyPool ? Math.max(targetCount * 4, proxies.length * 2, 10) : targetCount;
  let totalAttempts = 0;

  async function worker(workerId: number): Promise<void> {
    while (hasMore) {
      if (successCount >= targetCount) {
        hasMore = false;
        break;
      }

      totalAttempts++;
      if (totalAttempts > maxAttempts) {
        log("warn", `worker #${workerId}: reached max total attempt ceiling (${maxAttempts}). Stopping.`);
        hasMore = false;
        break;
      }

      let account: Account | null = null;
      if (cfg.authMethod === "google") {
        if (accountsToProcess.length === 0) {
          hasMore = false;
          break;
        }
        account = accountsToProcess.shift()!;
      }

      let proxy: string | null = null;
      if (proxyPool) {
        proxy = await proxyPool.getNextLiveProxy();
        if (proxy === null) {
          log("warn", `worker #${workerId}: no verified live HTTP 200 proxies left in pool. Halting queue.`);
          hasMore = false;
          if (account) accountsToProcess.unshift(account);
          break;
        }
        const reuseTag = proxyPool.goodProxies.includes(proxy) ? " [reused good IP]" : "";
        log("info", `worker #${workerId} selected verified proxy: ${proxy}${reuseTag} (fresh: ${proxyPool.freshCount}, good: ${proxyPool.goodCount})`);
      }

      const res = await runGptAccount(account, proxy, store, results, cfg);
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
        log("info", `Progress: ${successCount}/${targetCount} ChatGPT accounts succeeded.`);
      } else if (account && proxyPool && proxyPool.hasProxies) {
        if (successCount < targetCount) {
          accountsToProcess.push(account);
        }
      }

      if (cfg.interAccountDelaySec > 0 && hasMore && successCount < targetCount) {
        await new Promise((r) => setTimeout(r, cfg.interAccountDelaySec * 1000));
      }
    }
  }

  const workerCount = Math.min(cfg.workers, targetCount > 0 ? targetCount : 1);
  const workers = Array.from({ length: workerCount }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  log("info", `Queue finished. Succeeded: ${successCount}/${targetCount}`);
}
