// ── Inference Dahl Global queue unit tests ─────────────────────────
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SmartProxyPool } from "./queue.js";
import { loadConfig } from "./config.js";
import { JsonlStore } from "./store.js";

describe("processQueue (inferencedahl)", () => {
  it("initializes config and state store cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dahl-q-"));
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
    expect(store).toBeDefined();

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("SmartProxyPool (inferencedahl)", () => {
  it("rotates through fresh proxies and permanently discards failed proxies", () => {
    const proxies = [
      "http://1.1.1.1:8080",
      "http://2.2.2.2:8080",
      "http://3.3.3.3:8080",
    ];
    const pool = new SmartProxyPool(proxies);

    const p1 = pool.getNextProxy();
    expect(p1).toBe("http://1.1.1.1:8080");
    pool.markResult(p1, false);

    const p2 = pool.getNextProxy();
    expect(p2).toBe("http://2.2.2.2:8080");
    pool.markResult(p2, true);

    const p3 = pool.getNextProxy();
    expect(p3).toBe("http://3.3.3.3:8080");
    pool.markResult(p3, false);

    const p4 = pool.getNextProxy();
    expect(p4).toBe("http://2.2.2.2:8080");
  });
});
