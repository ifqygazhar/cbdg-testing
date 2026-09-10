// ── Queue: iterate seed accounts, skip terminal, bounded parallelism ──
import path from "node:path";
import type { AppConfig } from "./config.js";
import { loadAccounts, loadCards, loadProxies, type VccCard } from "./loaders.js";
import { createLog } from "./log.js";
import { FlowState, JsonlStore, ResultWriter } from "./store.js";
import { runAccount } from "./runner.js";

export async function processQueue(cfg: AppConfig, store: JsonlStore): Promise<void> {
  const log = createLog({ queue: "main" });
  const results = new ResultWriter(cfg.resultSuccessFile, cfg.resultFailedFile);

  const accounts = loadAccounts(cfg.seedGsuite);
  const cards = loadCards(cfg.seedVcc);
  const proxies = cfg.useProxy ? loadProxies(cfg.seedProxy) : [];
  if (cfg.useProxy && proxies.length === 0 && loadProxies(path.join(process.cwd(), "proxy.txt")).length > 0) {
    log("warn", "proxy-live.txt kosong padahal proxy.txt terisi — jalankan `bun run proxy-check` dulu, atau pakai --no-proxy.");
  }
  log("info", `seeds loaded`, { accounts: accounts.length, cards: cards.length, proxies: proxies.length });

  if (accounts.length === 0) {
    log("warn", "no accounts in gsuite.txt — nothing to do");
    return;
  }
  // signup-only never submits a card, so an empty vcc.txt is normal there.
  if (cards.length === 0 && cfg.mode !== "signup") {
    log("warn", "no cards in vcc.txt — nothing can be linked; aborting queue (use --signup-only to run without cards)");
    return;
  }

  // Skip sources: akun-result.txt (always), akun-failed.txt (unless retryFailed),
  // and state.jsonl terminal records (crash-safe fast path).
  const succeeded = results.getSuccessfulEmails();
  const previouslyFailed = results.getFailedEmails();
  // Permanent failures — risk-control bans never clear, so they are skipped
  // even under --retry-failed (retrying only burns time and re-flags the
  // device/IP in front of Tencent's risk engine).
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
      log("info", skip === "restricted"
        ? `skip (risk-control ban — permanent, never retried): ${acc.email}`
        : `skip (already processed): ${acc.email}`);
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

  // Risk-control mitigation: multiple accounts from one IP is the strongest
  // velocity signal we can avoid — warn loudly when running unproxied.
  if (todo.length > 1 && proxies.length === 0) {
    log("warn", `no proxies in ${cfg.seedProxy} — all ${todo.length} accounts share this IP; risk-control restriction is likely. Add proxies (one per line, host:port or scheme://user:pass@host:port) and/or set INTER_ACCOUNT_DELAY_SEC.`);
  }

  const workers = Math.max(1, cfg.workers);
  const delayMs = cfg.interAccountDelaySec * 1000;
  let next = 0;

  // Worker-pool: N workers each pull the next account — deterministic max concurrency.
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = next++;
      if (idx >= todo.length) return;
      const acc = todo[idx];
      const card: VccCard | null = cards.length ? cards[idx % cards.length] : null;
      const proxy = proxies.length ? (proxies[idx % proxies.length] ?? null) : null;
      try {
        await runAccount(acc, card, proxy, store, results, cfg);
      } catch (e) {
        // runAccount catches its own errors; this is a last-resort guard so one
        // broken account can never kill the whole queue.
        log("error", `unexpected runner failure for ${acc.email}: ${(e as Error).message}`);
        results.markFailed(acc.email, `RUNNER_CRASH: ${(e as Error).message}`);
      }
      // Risk-control spacing: cool down before the next account (with jitter)
      // so signups do not arrive as a burst from one device.
      if (delayMs > 0 && next < todo.length) {
        const wait = delayMs + Math.floor(Math.random() * (delayMs / 2));
        log("info", `spacing: waiting ${(wait / 1000).toFixed(1)}s before the next account`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(workers, todo.length) }, worker));
  log("info", "queue finished");
}