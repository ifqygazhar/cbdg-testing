// ── Queue processor for Composite ──────────────────────────────────
import path from "node:path";
import type { CompositeConfig } from "./config.js";
import { loadAccounts, loadProxies, type Account } from "./loaders.js";
import { createLog, type ULog } from "./log.js";
import { FlowState, JsonlStore, ResultWriter } from "./store.js";
import { runCompositeAccount } from "./runner.js";

export class SmartProxyPool {
  private freshProxies: string[];
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
    targetUrl = "https://composite.lucidity.sh/login.html",
    timeoutMs = 6000,
    batchSize = 15,
    log?: ULog,
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

      if (log) {
        log(
          "info",
          `🔍 Pre-checking batch of ${candidates.length} candidate proxies against Composite (HTTP 200, timeout=${timeoutMs / 1000}s)... (Fresh remaining: ${this.freshCount}, Good pool: ${this.goodCount})`,
        );
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
      let badCount = 0;
      for (const r of probeResults) {
        if (r.ok) {
          good.push(r.proxy);
          if (log) {
            log("info", `✅ Proxy pre-check PASSED: ${r.proxy} (${this.addressOf(r.proxy)}) -> HTTP 200 in ${r.dt}s`);
          }
        } else {
          this.badAddresses.add(this.addressOf(r.proxy));
          badCount++;
        }
      }

      if (badCount > 0 && log) {
        log("info", `⏭️ Discarded ${badCount} dead/non-200 proxies from batch.`);
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

export async function processQueue(cfg: CompositeConfig, store: JsonlStore): Promise<void> {
  const log = createLog({ queue: "main" });
  const results = new ResultWriter(cfg.resultSuccessFile, cfg.resultFailedFile, cfg.apiKeyFile);

  const rawAccounts: Account[] = [];
  const proxies = cfg.useProxy ? loadProxies(cfg.seedProxy) : [];

  if (cfg.useProxy && proxies.length === 0 && loadProxies(path.join(process.cwd(), "proxy.txt")).length > 0) {
    log("warn", "proxy-live.txt kosong padahal proxy.txt terisi — jalankan `bun run proxy-check` dulu, atau pakai --no-proxy.");
  }

  log("info", "seeds loaded", { accounts: rawAccounts.length, proxies: proxies.length });

  const proxyPool = cfg.useProxy && proxies.length > 0 ? new SmartProxyPool(proxies, cfg.reuseProxy) : null;

  const targetCount = cfg.limit > 0 ? cfg.limit : (proxies.length > 0 ? proxies.length : 1);

  log("info", "processing plan", { targetSuccess: targetCount, useProxy: cfg.useProxy, proxyCount: proxies.length });

  let successCount = 0;
  let processedAttempts = 0;
  const maxAttempts = proxyPool ? Math.max(targetCount * 4, proxies.length * 2, 10) : targetCount;

  async function worker(workerId: number): Promise<void> {
    while (true) {
      if (successCount >= targetCount) break;
      if (processedAttempts >= maxAttempts) break;

      processedAttempts++;

      let proxy: string | null = null;
      if (proxyPool) {
        proxy = await proxyPool.getNextLiveProxy("https://composite.lucidity.sh/login.html", 6000, 15, log);
        if (proxy === null) {
          log("warn", `worker #${workerId}: all proxies have been exhausted or blacklisted. No usable proxies left.`);
          break;
        }
        const reuseTag = proxyPool.goodProxies.includes(proxy) ? " [reused good IP]" : "";
        log("info", `worker #${workerId} selected verified proxy: ${proxy}${reuseTag} (fresh: ${proxyPool.freshCount}, good: ${proxyPool.goodCount})`);
      }

      const res = await runCompositeAccount(null, proxy, store, results, cfg);
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
