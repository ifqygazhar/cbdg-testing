// ── Queue processor for Zro MoonMath ────────────────────────────────
import path from "node:path";
import type { ZroMoonmathConfig } from "./config.js";
import { loadAccounts, loadProxies, type Account } from "./loaders.js";
import { createLog, type ULog } from "./log.js";
import { FlowState, JsonlStore, ResultWriter } from "./store.js";
import { runZroMoonmathAccount } from "./runner.js";

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
    targetUrl = "https://zro.moonmath.ai/sign-up",
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
          `🔍 Pre-checking batch of ${candidates.length} candidate proxies against target (${targetUrl}, strict HTTP 200, timeout=${timeoutMs / 1000}s)... (Fresh remaining: ${this.freshCount}, Good pool: ${this.goodCount})`,
        );
      }

      const probeResults = await Promise.all(
        candidates.map(async (cand) => {
          const t0 = Date.now();
          try {
            let proxyUrl = cand.trim();
            if (!proxyUrl.includes("://")) {
              const parts = proxyUrl.split(":");
              if (parts.length === 4) {
                proxyUrl = `http://${encodeURIComponent(parts[2]!)}:${encodeURIComponent(parts[3]!)}@${parts[0]}:${parts[1]}`;
              } else {
                proxyUrl = `http://${proxyUrl}`;
              }
            }
            const resp = await fetch(targetUrl, {
              proxy: proxyUrl,
              signal: AbortSignal.timeout(timeoutMs),
              headers: {
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              },
              tls: { rejectUnauthorized: false },
            });
            const dt = ((Date.now() - t0) / 1000).toFixed(2);
            const ok = resp.status === 200;
            const statusDesc = ok ? "HTTP 200" : `HTTP ${resp.status} (non-200)`;
            return { proxy: cand, ok, status: statusDesc, dt };
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
          if (log) {
            log("info", `❌ Proxy pre-check REJECTED: ${r.proxy} (${this.addressOf(r.proxy)}) -> ${r.status} in ${r.dt}s`);
          }
        }
      }

      if (badCount > 0 && log) {
        log("info", `⏭️ Discarded ${badCount} non-200 / unresponsive proxies from batch.`);
      }

      if (good.length > 0) {
        const chosen = good[0]!;
        if (good.length > 1) {
          for (let i = 1; i < good.length; i++) {
            if (!this.goodProxies.includes(good[i]!)) {
              this.goodProxies.push(good[i]!);
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

  public get freshCount(): number {
    return this.freshProxies.length;
  }

  public get goodCount(): number {
    return this.goodProxies.length;
  }

  public get hasProxies(): boolean {
    return this.freshProxies.length > 0 || this.goodProxies.length > 0;
  }
}

export async function processQueue(cfg: ZroMoonmathConfig, store: JsonlStore): Promise<void> {
  const log = createLog({ component: "queue" });
  const results = new ResultWriter(cfg.resultSuccessFile, cfg.resultFailedFile, cfg.apiKeyFile);

  const rawAccounts: Account[] = cfg.seedAccounts ? loadAccounts(cfg.seedAccounts) : [];
  const proxies = cfg.useProxy ? loadProxies(cfg.seedProxy) : [];

  let proxyPool: SmartProxyPool | null = null;
  if (cfg.useProxy) {
    if (proxies.length === 0) {
      log("warn", `USE_PROXY=true but no proxies found in ${cfg.seedProxy}. Running with direct connection.`);
    } else {
      proxyPool = new SmartProxyPool(proxies, cfg.proxyReuse);
      log("info", "initialized smart proxy pool", {
        proxies: proxies.length,
        reuseProxy: cfg.proxyReuse,
      });
    }
  }

  let todoAccounts: Account[] = [];
  if (rawAccounts.length > 0) {
    const alreadyDone = results.getSuccessfulEmails();
    const previouslyFailed = results.getFailedEmails();

    todoAccounts = rawAccounts.filter((acc) => {
      const email = acc.email.toLowerCase();
      const rec = store.get(acc.email);
      if (alreadyDone.has(email) || rec?.status === FlowState.DONE) {
        return false;
      }
      if (!cfg.retryFailed && (previouslyFailed.has(email) || rec?.status === FlowState.FAILED)) {
        return false;
      }
      return true;
    });

    if (cfg.retryFailed) {
      todoAccounts.sort((a, b) => {
        const aFailed = previouslyFailed.has(a.email.toLowerCase()) || store.get(a.email)?.status === FlowState.FAILED ? 0 : 1;
        const bFailed = previouslyFailed.has(b.email.toLowerCase()) || store.get(b.email)?.status === FlowState.FAILED ? 0 : 1;
        return aFailed - bFailed;
      });
    }

    log("info", "accounts to process", {
      total: rawAccounts.length,
      todo: todoAccounts.length,
      skipped: rawAccounts.length - todoAccounts.length,
      retryFailed: cfg.retryFailed,
    });
  }

  const availableAccounts = rawAccounts.length > 0 ? todoAccounts.length : 0;
  const targetCount =
    cfg.limit > 0
      ? (availableAccounts > 0 ? Math.min(cfg.limit, availableAccounts) : (rawAccounts.length > 0 ? 0 : cfg.limit))
      : (availableAccounts > 0 ? availableAccounts : (rawAccounts.length > 0 ? 0 : (proxies.length > 0 ? proxies.length : 1)));

  if (rawAccounts.length > 0 && cfg.limit > availableAccounts) {
    log(
      "warn",
      `Limit yang diminta (${cfg.limit} akun) melebihi sisa akun yang tersedia (${availableAccounts} akun). Target disesuaikan menjadi ${targetCount} akun agar akun sukses tidak diulang.`,
    );
  }
  log("info", "processing plan", { targetSuccess: targetCount, useProxy: cfg.useProxy, proxyCount: proxies.length });

  const accountQueue = [...todoAccounts];
  const attemptsPerAccount = new Map<string, number>();
  const MAX_PROXY_ATTEMPTS = proxyPool ? 3 : 1;

  let successCount = 0;
  let processedAttempts = 0;
  const maxAttempts = proxyPool ? Math.max(targetCount * 4, proxies.length * 2, 10) : targetCount;

  async function worker(workerId: number): Promise<void> {
    while (true) {
      if (successCount >= targetCount) break;
      if (processedAttempts >= maxAttempts) break;

      let account: Account | null = null;
      if (rawAccounts.length > 0) {
        if (accountQueue.length === 0) break;
        account = accountQueue.shift()!;
      }

      processedAttempts++;

      let proxy: string | null = null;
      if (proxyPool) {
        // Pre-check proxy strictly against target web https://zro.moonmath.ai/sign-up for HTTP 200
        proxy = await proxyPool.getNextLiveProxy("https://zro.moonmath.ai/sign-up", 6000, 15, log);
        if (proxy === null) {
          log("warn", `worker #${workerId}: all proxies have been exhausted or blacklisted. No proxy with HTTP 200 available.`);
          if (account) accountQueue.unshift(account);
          break;
        }
        const reuseTag = proxyPool.goodProxies.includes(proxy) ? " [reused good IP]" : "";
        log("info", `worker #${workerId} assigned verified HTTP 200 proxy: ${proxy}${reuseTag} (fresh: ${proxyPool.freshCount}, good: ${proxyPool.goodCount})`);
      }

      const res = await runZroMoonmathAccount(account, proxy, store, results, cfg);
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
      } else if (account) {
        const att = (attemptsPerAccount.get(account.email) || 0) + 1;
        attemptsPerAccount.set(account.email, att);
        if (proxyPool && proxyPool.hasProxies && att < MAX_PROXY_ATTEMPTS && successCount < targetCount) {
          log(
            "info",
            `worker #${workerId}: proxy failed for ${account.email}. Skipping bad proxy and re-queuing account with fresh proxy (attempt ${att + 1}/${MAX_PROXY_ATTEMPTS})...`,
          );
          accountQueue.push(account);
        } else {
          if (proxyPool && att >= MAX_PROXY_ATTEMPTS) {
            log("warn", `worker #${workerId}: account ${account.email} exhausted all ${MAX_PROXY_ATTEMPTS} proxy attempts. Marked as failed.`);
          }
        }
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
