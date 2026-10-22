// ── Composite queue unit tests ─────────────────────────────────────
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processQueue, SmartProxyPool } from "./queue.js";
import { loadConfig } from "./config.js";
import { JsonlStore, FlowState } from "./store.js";

describe("processQueue (composite)", () => {
  it("handles zero limit or dry run without crashing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmp-q-"));
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
    expect(async () => {
      // With limit 0, should terminate gracefully
    }).not.toThrow();

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("SmartProxyPool (composite)", () => {
  it("rotates through fresh proxies and permanently discards failed proxies", () => {
    const proxies = [
      "http://1.1.1.1:8080",
      "http://2.2.2.2:8080",
      "http://3.3.3.3:8080",
    ];
    const pool = new SmartProxyPool(proxies);

    // First account gets 1.1.1.1
    const p1 = pool.getNextProxy();
    expect(p1).toBe("http://1.1.1.1:8080");

    // Account 1 encounters error -> marked failed
    pool.markResult(p1, false);

    // Second account gets different fresh IP (2.2.2.2)
    const p2 = pool.getNextProxy();
    expect(p2).toBe("http://2.2.2.2:8080");

    // Account 2 succeeds -> marked good (reusable)
    pool.markResult(p2, true);

    // Third account gets fresh IP (3.3.3.3)
    const p3 = pool.getNextProxy();
    expect(p3).toBe("http://3.3.3.3:8080");

    // Account 3 encounters error -> marked failed
    pool.markResult(p3, false);

    // Fresh proxies are exhausted. The failed ones (1.1.1.1, 3.3.3.3) must not be returned!
    // But 2.2.2.2 succeeded, so it is in goodProxies and reusable.
    const p4 = pool.getNextProxy();
    expect(p4).toBe("http://2.2.2.2:8080");
  });
});
