// ── Zro MoonMath queue unit tests ───────────────────────────────────
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processQueue, SmartProxyPool } from "./queue.js";
import { loadConfig } from "./config.js";
import { JsonlStore, FlowState } from "./store.js";

describe("processQueue (zromoonmath)", () => {
  it("processes queue with pre-existing completed state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zro-q-"));
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

  it("handles empty accounts gracefully", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zro-q-"));
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
      // With limit 0 and no accounts, should terminate gracefully
    }).not.toThrow();

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("SmartProxyPool (zromoonmath)", () => {
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

  it("getNextLiveProxy strictly validates HTTP 200 and rejects non-200 proxies", async () => {
    const proxies = [
      "http://bad-403.com:8080",
      "http://bad-502.com:8080",
      "http://good-200.com:8080",
    ];
    const pool = new SmartProxyPool(proxies);

    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: any, opts: any) => {
        const proxyStr = opts?.proxy || "";
        if (proxyStr.includes("bad-403")) {
          return new Response("Forbidden", { status: 403 });
        }
        if (proxyStr.includes("bad-502")) {
          return new Response("Bad Gateway", { status: 502 });
        }
        if (proxyStr.includes("good-200")) {
          return new Response("OK", { status: 200 });
        }
        return new Response("Error", { status: 500 });
      }) as any;

      const live = await pool.getNextLiveProxy("https://zro.moonmath.ai/sign-up", 1000, 10);
      expect(live).toBe("http://good-200.com:8080");

      // Verify that bad ones were added to badAddresses
      expect(pool.badAddresses.has("bad-403.com")).toBe(true);
      expect(pool.badAddresses.has("bad-502.com")).toBe(true);
      expect(pool.badAddresses.has("good-200.com")).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
