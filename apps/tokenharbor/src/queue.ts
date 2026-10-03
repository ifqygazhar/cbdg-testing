// ── Queue processor for TokenHarbor ──────────────────────────────────
import path from "node:path";
import type { TokenHarborConfig } from "./config.js";
import { loadAccounts, loadProxies, type Account } from "./loaders.js";
import { createLog } from "./log.js";
import { FlowState, JsonlStore, ResultWriter } from "./store.js";
import { runTokenHarborAccount } from "./runner.js";

export async function processQueue(cfg: TokenHarborConfig, store: JsonlStore): Promise<void> {
  const log = createLog({ queue: "main" });
  const results = new ResultWriter(cfg.resultSuccessFile, cfg.resultFailedFile, cfg.apiKeyFile);

  const rawAccounts = cfg.seedAccounts ? loadAccounts(cfg.seedAccounts) : [];
  const proxies = cfg.useProxy ? loadProxies(cfg.seedProxy) : [];

  if (cfg.useProxy && proxies.length === 0 && loadProxies(path.join(process.cwd(), "proxy.txt")).length > 0) {
    log("warn", "proxy-live.txt kosong padahal proxy.txt terisi — jalankan `bun run proxy-check` dulu, atau pakai --no-proxy.");
  }

  log("info", "seeds loaded", { accounts: rawAccounts.length, proxies: proxies.length });

  // Resolve items to process
  let itemsToProcess: Array<{ account: Account | null; proxy: string | null }> = [];

  if (rawAccounts.length > 0) {
    const succeeded = results.getSuccessfulEmails();
    const previouslyFailed = results.getFailedEmails();

    const todoAccounts = rawAccounts.filter((acc) => {
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

    itemsToProcess = todoAccounts.map((acc, i) => ({
      account: acc,
      proxy: proxies.length > 0 ? (cfg.proxyReuse ? proxies[i % proxies.length] : proxies[i] || null) : null,
    }));
  } else {
    // Dynamic TempMail mode: create on-the-fly accounts
    const count = cfg.limit > 0 ? cfg.limit : proxies.length > 0 ? proxies.length : 1;
    log("info", "dynamic TempMail mode: generating accounts on-the-fly", { count, defaultDomain: cfg.tempMailDomain });

    for (let i = 0; i < count; i++) {
      const proxy = proxies.length > 0 ? (cfg.proxyReuse ? proxies[i % proxies.length] : proxies[i] || null) : null;
      itemsToProcess.push({ account: null, proxy });
    }
  }

  if (cfg.limit > 0 && itemsToProcess.length > cfg.limit) {
    itemsToProcess = itemsToProcess.slice(0, cfg.limit);
  }

  let index = 0;
  let successCount = 0;

  async function worker(workerId: number): Promise<void> {
    while (true) {
      const currentIdx = index++;
      if (currentIdx >= itemsToProcess.length) break;

      const item = itemsToProcess[currentIdx];
      const res = await runTokenHarborAccount(item.account, item.proxy, store, results, cfg);
      if (res.success) {
        successCount++;
      }

      if (currentIdx < itemsToProcess.length - 1 && cfg.interAccountDelaySec > 0) {
        log("info", `worker #${workerId} waiting ${cfg.interAccountDelaySec}s before next account...`);
        await new Promise((r) => setTimeout(r, cfg.interAccountDelaySec * 1000));
      }
    }
  }

  const workerCount = Math.min(cfg.workers, itemsToProcess.length || 1);
  log("info", "starting worker pool", { workers: workerCount, items: itemsToProcess.length });
  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i + 1)));

  log("info", "queue finished", { succeeded: successCount, total: itemsToProcess.length });
}
