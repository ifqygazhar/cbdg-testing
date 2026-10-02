// ── FastRouter queue tests: scheduling semantics with a mocked runner ──
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
  const dir = mkdtempSync(join(tmpdir(), "fr-q-"));
  const g = join(dir, "gsuite.txt");
  const p = join(dir, "proxy.txt");
  writeFileSync(g, gsuite);
  writeFileSync(p, proxy);
  const cfg = loadConfig({
    SEED_GSUITE: g,
    SEED_PROXY: p,
    FASTROUTER_STATE_FILE: join(dir, "state.jsonl"),
    FASTROUTER_RESULT_SUCCESS_FILE: join(dir, "akun-result.txt"),
    FASTROUTER_RESULT_FAILED_FILE: join(dir, "akun-failed.txt"),
    FASTROUTER_APIKEY_FILE: join(dir, "apikey.txt"),
    FASTROUTER_SCREENSHOT_DIR: join(dir, "shots"),
  } as NodeJS.ProcessEnv);
  return { dir, cfg };
}

beforeEach(() => {
  runnerCtl.calls = [];
  runnerCtl.active = 0;
  runnerCtl.maxActive = 0;
});

describe("processQueue (fastrouter)", () => {
  it("processing order is deterministic, one account per proxy", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\nb@y.com:p\n", "1.2.3.4:8080\n5.6.7.8:3128\n");
    await processQueue(cfg, new JsonlStore(cfg.stateFile));
    expect(runnerCtl.calls.map((c) => c.email)).toEqual(["a@x.com", "b@y.com"]);
    expect(runnerCtl.calls.map((c) => c.proxy)).toEqual([
      "http://1.2.3.4:8080",
      "http://5.6.7.8:3128",
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("holds an account back rather than reusing a spent address", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\nb@y.com:p\nc@z.com:p\n", "1.2.3.4:8080\n5.6.7.8:3128\n");
    await processQueue(cfg, new JsonlStore(cfg.stateFile));
    expect(runnerCtl.calls.map((c) => c.email)).toEqual(["a@x.com", "b@y.com"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a re-run skips addresses an earlier batch already spent", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\n", "1.2.3.4:8080\n5.6.7.8:3128\n");
    const store = new JsonlStore(cfg.stateFile);
    store.upsert({
      email: "old@x.com",
      password: "p",
      status: FlowState.DONE,
      proxy: "http://1.2.3.4:8080",
      updatedAt: 1,
    });
    await processQueue(cfg, store);
    expect(runnerCtl.calls.map((c) => c.proxy)).toEqual(["http://5.6.7.8:3128"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("respects workers concurrency (worker pool, not a stampede)", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\nb@y.com:p\nc@z.com:p\nd@w.com:p\n", "");
    const c2 = loadConfig({
      ...process.env,
      SEED_GSUITE: cfg.seedGsuite,
      SEED_PROXY: cfg.seedProxy,
      FASTROUTER_STATE_FILE: cfg.stateFile,
      FASTROUTER_RESULT_SUCCESS_FILE: cfg.resultSuccessFile,
      FASTROUTER_RESULT_FAILED_FILE: cfg.resultFailedFile,
      FASTROUTER_APIKEY_FILE: cfg.apiKeyFile,
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
    store.upsert({
      email: "a@x.com",
      password: "p",
      status: FlowState.DONE,
      updatedAt: 1,
    });
    await processQueue(cfg, store);
    expect(runnerCtl.calls.map((c) => c.email)).toEqual(["b@y.com"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("ACCOUNT_RESTRICTED failures are never retried, even with --retry-failed", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\nb@y.com:p\n", "");
    const results = new (await import("./store.js")).ResultWriter(
      cfg.resultSuccessFile,
      cfg.resultFailedFile,
      cfg.apiKeyFile,
    );
    results.markFailed("a@x.com", "ACCOUNT_RESTRICTED: ban");
    const c2 = loadConfig({
      ...process.env,
      SEED_GSUITE: cfg.seedGsuite,
      SEED_PROXY: cfg.seedProxy,
      FASTROUTER_STATE_FILE: cfg.stateFile,
      FASTROUTER_RESULT_SUCCESS_FILE: cfg.resultSuccessFile,
      FASTROUTER_RESULT_FAILED_FILE: cfg.resultFailedFile,
      FASTROUTER_APIKEY_FILE: cfg.apiKeyFile,
      RETRY_FAILED: "true",
    } as NodeJS.ProcessEnv);
    await processQueue(c2, new JsonlStore(c2.stateFile));
    expect(runnerCtl.calls.map((c) => c.email)).toEqual(["b@y.com"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("no accounts → no-op without crashing", async () => {
    const { dir, cfg } = seedEnv("", "");
    await processQueue(cfg, new JsonlStore(cfg.stateFile));
    expect(runnerCtl.calls.length).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
