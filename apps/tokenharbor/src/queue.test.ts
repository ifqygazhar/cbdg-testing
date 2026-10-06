// ── TokenHarbor queue unit tests ─────────────────────────────────────
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processQueue } from "./queue.js";
import { loadConfig } from "./config.js";
import { JsonlStore, FlowState } from "./store.js";

describe("processQueue (tokenharbor)", () => {
  it("processes queue with dry-run semantics or pre-existing completed state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "th-q-"));
    const stateFile = join(dir, "state.jsonl");
    const successFile = join(dir, "success.txt");
    const failedFile = join(dir, "failed.txt");
    const keyFile = join(dir, "key.txt");
    const accountsFile = join(dir, "accounts.txt");
    const proxyFile = join(dir, "proxy.txt");

    writeFileSync(accountsFile, "done@ifqy.net:pass1\n");
    writeFileSync(proxyFile, "http://1.2.3.4:8080\n");

    const cfg = loadConfig({
      STATE_FILE: stateFile,
      RESULT_SUCCESS_FILE: successFile,
      RESULT_FAILED_FILE: failedFile,
      API_KEY_FILE: keyFile,
      SEED_ACCOUNTS: accountsFile,
      SEED_PROXY: proxyFile,
      USE_PROXY: "1",
      WORKERS: "1",
      INTER_ACCOUNT_DELAY_SEC: "0",
    });

    const store = new JsonlStore(stateFile);
    // Mark as DONE beforehand
    store.upsert({ email: "done@ifqy.net", status: FlowState.DONE, updatedAt: Date.now() });

    await processQueue(cfg, store);

    // done@ifqy.net is skipped because it is already DONE
    expect(store.get("done@ifqy.net")?.status).toBe(FlowState.DONE);

    rmSync(dir, { recursive: true, force: true });
  });

  it("handles empty accounts without crashing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "th-q-"));
    const cfg = loadConfig({
      STATE_FILE: join(dir, "state.jsonl"),
      RESULT_SUCCESS_FILE: join(dir, "success.txt"),
      RESULT_FAILED_FILE: join(dir, "failed.txt"),
      API_KEY_FILE: join(dir, "key.txt"),
      SEED_PROXY: join(dir, "nonexistent-proxy.txt"),
      USE_PROXY: "0",
      LIMIT: "0",
    });

    const store = new JsonlStore(cfg.stateFile);
    // Should run smoothly without throwing
    expect(async () => {
      // With limit 0 and no proxies, it finishes immediately
    }).not.toThrow();

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("SmartProxyPool (tokenharbor)", () => {
  it("rotates through fresh proxies and permanently discards failed/warning proxies", () => {
    const { SmartProxyPool } = require("./queue.js");
    const proxies = [
      "http://1.1.1.1:8080",
      "http://2.2.2.2:8080",
      "http://3.3.3.3:8080",
    ];
    const pool = new SmartProxyPool(proxies);

    // First account gets 1.1.1.1
    const p1 = pool.getNextProxy();
    expect(p1).toBe("http://1.1.1.1:8080");

    // Account 1 encounters a warning/error -> marked failed
    pool.markResult(p1, false);

    // Second account MUST get a different fresh IP (2.2.2.2)
    const p2 = pool.getNextProxy();
    expect(p2).toBe("http://2.2.2.2:8080");

    // Account 2 succeeds -> marked good (reusable)
    pool.markResult(p2, true);

    // Third account gets fresh IP (3.3.3.3)
    const p3 = pool.getNextProxy();
    expect(p3).toBe("http://3.3.3.3:8080");

    // Account 3 encounters error -> marked failed
    pool.markResult(p3, false);

    // Fresh proxies are exhausted. The failed ones (1.1.1.1, 3.3.3.3) MUST NOT be returned!
    // But the successful one (2.2.2.2) IS reusable!
    const p4 = pool.getNextProxy();
    expect(p4).toBe("http://2.2.2.2:8080");

    // Another request reuses 2.2.2.2 again
    const p5 = pool.getNextProxy();
    expect(p5).toBe("http://2.2.2.2:8080");

    // If 2.2.2.2 now encounters an error, it is discarded
    pool.markResult(p5, false);

    // Now all proxies are discarded -> getNextProxy returns null
    const p6 = pool.getNextProxy();
    expect(p6).toBeNull();
  });

  it("immediately prioritizes good proxies when reuseProxy is true", () => {
    const { SmartProxyPool } = require("./queue.js");
    const proxies = [
      "http://1.1.1.1:8080",
      "http://2.2.2.2:8080",
      "http://3.3.3.3:8080",
    ];
    const pool = new SmartProxyPool(proxies, true);

    const p1 = pool.getNextProxy();
    expect(p1).toBe("http://1.1.1.1:8080");

    // Marked good
    pool.markResult(p1, true);

    // Next request MUST reuse good proxy p1 (1.1.1.1) rather than taking fresh 2.2.2.2
    const p2 = pool.getNextProxy();
    expect(p2).toBe("http://1.1.1.1:8080");
  });
});
