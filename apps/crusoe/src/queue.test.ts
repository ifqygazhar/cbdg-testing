// ── Crusoe queue tests: scheduling semantics with a mocked runner ──
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runnerCtl = {
  calls: [] as Array<{ email: string; proxy: string | null }>,
  active: 0,
  maxActive: 0,
};

mock.module("./runner.js", () => ({
  runAccount: async (
    account: { email: string },
    proxy: { server: string } | null,
  ) => {
    runnerCtl.active++;
    runnerCtl.maxActive = Math.max(runnerCtl.maxActive, runnerCtl.active);
    runnerCtl.calls.push({ email: account.email, proxy: proxy ? proxy.server : null });
    runnerCtl.active--;
    return "DONE";
  },
}));

const { processQueue } = await import("./queue.js");
const { JsonlStore, FlowState } = await import("./store.js");
const { loadConfig } = await import("./config.js");

function seedEnv(gsuite: string, proxy: string): { dir: string; cfg: ReturnType<typeof loadConfig> } {
  const dir = mkdtempSync(join(tmpdir(), "crusoe-q-"));
  const g = join(dir, "gsuite.txt");
  const p = join(dir, "proxy.txt");
  writeFileSync(g, gsuite);
  writeFileSync(p, proxy);
  const cfg = loadConfig({
    SEED_GSUITE: g, SEED_PROXY: p,
    CRUSOE_STATE_FILE: join(dir, "state.jsonl"),
    CRUSOE_RESULT_SUCCESS_FILE: join(dir, "akun-result.txt"),
    CRUSOE_RESULT_FAILED_FILE: join(dir, "akun-failed.txt"),
    CRUSOE_APIKEY_FILE: join(dir, "apikey.txt"),
    CRUSOE_SCREENSHOT_DIR: join(dir, "shots"),
  } as NodeJS.ProcessEnv);
  return { dir, cfg };
}

beforeEach(() => {
  runnerCtl.calls = [];
  runnerCtl.active = 0;
  runnerCtl.maxActive = 0;
});

describe("processQueue (crusoe)", () => {
  it("processing order is deterministic (round-robin proxy optional)", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\nb@y.com:p\nc@z.com:p\n", "1.2.3.4:8080\n5.6.7.8:3128\n");
    await processQueue(cfg, new JsonlStore(cfg.stateFile));
    expect(runnerCtl.calls.map((c) => c.email)).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
    expect(runnerCtl.calls.map((c) => c.proxy)).toEqual([
      "http://1.2.3.4:8080", "http://5.6.7.8:3128", "http://1.2.3.4:8080",
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("respects workers concurrency (worker pool, not a stampede)", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\nb@y.com:p\nc@z.com:p\nd@w.com:p\n", "");
    const c2 = loadConfig({
      ...process.env,
      SEED_GSUITE: cfg.seedGsuite, SEED_PROXY: cfg.seedProxy,
      CRUSOE_STATE_FILE: cfg.stateFile, CRUSOE_RESULT_SUCCESS_FILE: cfg.resultSuccessFile,
      CRUSOE_RESULT_FAILED_FILE: cfg.resultFailedFile, CRUSOE_APIKEY_FILE: cfg.apiKeyFile,
      WORKERS: "2",
    } as NodeJS.ProcessEnv);
    await processQueue(c2, new JsonlStore(c2.stateFile));
    expect(runnerCtl.maxActive).toBeLessThanOrEqual(2);
    expect(runnerCtl.calls.length).toBe(4);
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips accounts already DONE in the store (resume semantics)", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\nb@y.com:p\n", "");
    const store = new JsonlStore(cfg.stateFile);
    store.upsert({ email: "a@x.com", password: "p", status: FlowState.DONE, updatedAt: 1 });
    await processQueue(cfg, store);
    expect(runnerCtl.calls.map((c) => c.email)).toEqual(["b@y.com"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("ACCOUNT_RESTRICTED failures are never retried, even with --retry-failed", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\nb@y.com:p\n", "");
    writeFileSync(
      join(dir, "akun-failed.txt"),
      "a@x.com|2026-01-01T00:00:00.000Z|ACCOUNT_RESTRICTED: account restricted by risk control\n",
    );
    const retryCfg = loadConfig({
      ...process.env,
      SEED_GSUITE: cfg.seedGsuite, SEED_PROXY: cfg.seedProxy,
      CRUSOE_STATE_FILE: cfg.stateFile, CRUSOE_RESULT_SUCCESS_FILE: cfg.resultSuccessFile,
      CRUSOE_RESULT_FAILED_FILE: cfg.resultFailedFile, CRUSOE_APIKEY_FILE: cfg.apiKeyFile,
      RETRY_FAILED: "1",
    } as NodeJS.ProcessEnv);
    await processQueue(retryCfg, new JsonlStore(retryCfg.stateFile));
    expect(runnerCtl.calls.map((c) => c.email)).toEqual(["b@y.com"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("INTER_ACCOUNT_DELAY_SEC spaces consecutive accounts apart", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\nb@y.com:p\n", "");
    const slowCfg = loadConfig({
      ...process.env,
      SEED_GSUITE: cfg.seedGsuite, SEED_PROXY: cfg.seedProxy,
      CRUSOE_STATE_FILE: cfg.stateFile, CRUSOE_RESULT_SUCCESS_FILE: cfg.resultSuccessFile,
      CRUSOE_RESULT_FAILED_FILE: cfg.resultFailedFile, CRUSOE_APIKEY_FILE: cfg.apiKeyFile,
      INTER_ACCOUNT_DELAY_SEC: "2",
    } as NodeJS.ProcessEnv);
    const t0 = Date.now();
    await processQueue(slowCfg, new JsonlStore(slowCfg.stateFile));
    expect(runnerCtl.calls.map((c) => c.email)).toEqual(["a@x.com", "b@y.com"]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2000);
    rmSync(dir, { recursive: true, force: true });
  });

  it("no accounts → no-op without crashing", async () => {
    const { dir, cfg } = seedEnv("", "");
    await processQueue(cfg, new JsonlStore(cfg.stateFile));
    expect(runnerCtl.calls).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});