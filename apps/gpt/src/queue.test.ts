// ── ChatGPT queue & proxy pool unit tests ───────────────────────────
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processQueue, SmartProxyPool } from "./queue.js";
import { loadConfig } from "./config.js";
import { JsonlStore, FlowState } from "./store.js";

describe("SmartProxyPool (gpt)", () => {
  it("rotates fresh proxies and blacklists bad addresses", () => {
    const proxies = [
      "http://user:pass@1.1.1.1:8080",
      "http://user:pass@2.2.2.2:8080",
      "http://user:pass@3.3.3.3:8080",
    ];
    const pool = new SmartProxyPool(proxies, false);
    expect(pool.freshCount).toBe(3);

    const p1 = pool.getNextProxy();
    expect(p1).toBe("http://user:pass@1.1.1.1:8080");
    pool.markResult(p1, false); // Mark bad
    expect(pool.badAddresses.has("1.1.1.1")).toBe(true);

    const p2 = pool.getNextProxy();
    expect(p2).toBe("http://user:pass@2.2.2.2:8080");
    pool.markResult(p2, true); // Mark good
    expect(pool.goodCount).toBe(1);

    const p3 = pool.getNextProxy();
    expect(p3).toBe("http://user:pass@3.3.3.3:8080");
  });

  it("recycles good proxies when reuseProxy is true", () => {
    const proxies = ["http://10.0.0.1:8080"];
    const pool = new SmartProxyPool(proxies, true);
    const p1 = pool.getNextProxy();
    expect(p1).toBe("http://10.0.0.1:8080");
    pool.markResult(p1, true);

    // Fresh is now empty, but good proxy can be reused
    const pReused = pool.getNextProxy();
    expect(pReused).toBe("http://10.0.0.1:8080");
  });
});

describe("processQueue (gpt)", () => {
  it("processes queue with pre-existing completed state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gpt-q-"));
    const stateFile = join(dir, "state.jsonl");
    const successFile = join(dir, "success.txt");
    const failedFile = join(dir, "failed.txt");
    const accountsFile = join(dir, "accounts.txt");
    const proxyFile = join(dir, "proxy.txt");

    writeFileSync(accountsFile, "done@ifqy.net:pass1\n");
    writeFileSync(proxyFile, "http://1.2.3.4:8080\n");

    const cfg = loadConfig({
      STATE_FILE: stateFile,
      RESULT_SUCCESS_FILE: successFile,
      RESULT_FAILED_FILE: failedFile,
      SEED_ACCOUNTS: accountsFile,
      SEED_PROXY: proxyFile,
      USE_PROXY: "1",
      WORKERS: "1",
      INTER_ACCOUNT_DELAY_SEC: "0",
      GPT_AUTH: "google",
    });

    const store = new JsonlStore(stateFile);
    // Mark as DONE beforehand
    store.upsert({ email: "done@ifqy.net", status: FlowState.DONE, updatedAt: Date.now() });

    await processQueue(cfg, store);

    // done@ifqy.net is skipped because it is already DONE
    expect(store.get("done@ifqy.net")?.status).toBe(FlowState.DONE);

    rmSync(dir, { recursive: true, force: true });
  });
});
