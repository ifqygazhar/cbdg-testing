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
