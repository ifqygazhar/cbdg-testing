// ── Queue tests: scheduling semantics with a mocked runner ─────────
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// fake runner state
const runnerCtl = {
  calls: [] as Array<{ email: string; card: string | null; proxy: string | null }>,
  failEmails: new Set<string>(),
  delayMs: 0,
  active: 0,
  maxActive: 0,
};

mock.module("./runner.js", () => ({
  runAccount: async (
    account: { email: string },
    card: { cardNumber: string } | null,
    proxy: { server: string } | null,
    _store: unknown,
    _results: unknown,
    _cfg: unknown,
  ) => {
    runnerCtl.active++;
    runnerCtl.maxActive = Math.max(runnerCtl.maxActive, runnerCtl.active);
    if (runnerCtl.delayMs) await new Promise((r) => setTimeout(r, runnerCtl.delayMs));
    runnerCtl.calls.push({
      email: account.email,
      card: card ? card.cardNumber : null,
      proxy: proxy ? proxy.server : null,
    });
    runnerCtl.active--;
    if (runnerCtl.failEmails.has(account.email)) {
      throw new Error(`runner exploded for ${account.email}`);
    }
    return "DONE";
  },
}));

// import AFTER mocks are registered
const { processQueue } = await import("./queue.js");
const { JsonlStore, FlowState } = await import("./store.js");
const { loadConfig } = await import("./config.js");

function seedEnv(gsuite: string, vcc: string, proxy: string): { dir: string; cfg: ReturnType<typeof loadConfig> } {
  const dir = mkdtempSync(join(tmpdir(), "cbdg-q-"));
  const g = join(dir, "gsuite.txt");
  const v = join(dir, "vcc.txt");
  const p = join(dir, "proxy.txt");
  writeFileSync(g, gsuite);
  writeFileSync(v, vcc);
  writeFileSync(p, proxy);
  const cfg = loadConfig({
    SEED_GSUITE: g, SEED_VCC: v, SEED_PROXY: p,
    STATE_FILE: join(dir, "state.jsonl"),
    RESULT_SUCCESS_FILE: join(dir, "akun-result.txt"),
    RESULT_FAILED_FILE: join(dir, "akun-failed.txt"),
    SCREENSHOT_DIR: join(dir, "shots"),
  } as NodeJS.ProcessEnv);
  return { dir, cfg };
}

beforeEach(() => {
  runnerCtl.calls = [];
  runnerCtl.failEmails = new Set();
  runnerCtl.delayMs = 0;
  runnerCtl.active = 0;
  runnerCtl.maxActive = 0;
});

describe("processQueue", () => {
  it("runs every account with index-matched card, writes results, finishes", async () => {
    const { dir, cfg } = seedEnv(
      "a@x.com:pa\nb@y.com:pb\nc@z.com:pc\n",
      "4111111111111111 | 12/28 | 111\n4222222222222222 | 11/27 | 222\n",
      "",
    );
    await processQueue(cfg, new JsonlStore(cfg.stateFile));

    expect(runnerCtl.calls.length).toBe(3);
    expect(runnerCtl.calls[0]).toEqual({ email: "a@x.com", card: "4111111111111111", proxy: null });
    expect(runnerCtl.calls[1]).toEqual({ email: "b@y.com", card: "4222222222222222", proxy: null });
    rmSync(dir, { recursive: true, force: true });
  });

  it("cycles cards when there are fewer cards than accounts", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\nb@y.com:p\nc@z.com:p\n", "4111111111111111 | 12/28 | 111\n", "");
    await processQueue(cfg, new JsonlStore(cfg.stateFile));
    expect(runnerCtl.calls.map((c) => c.card)).toEqual([
      "4111111111111111", "4111111111111111", "4111111111111111",
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("assigns proxies round-robin when proxies exist", async () => {
    const { dir, cfg } = seedEnv(
      "a@x.com:p\nb@y.com:p\nc@z.com:p\n",
      "4111111111111111 | 12/28 | 111\n",
      "1.2.3.4:8080\n5.6.7.8:3128\n",
    );
    await processQueue(cfg, new JsonlStore(cfg.stateFile));
    expect(runnerCtl.calls.map((c) => c.proxy)).toEqual([
      "http://1.2.3.4:8080", "http://5.6.7.8:3128", "http://1.2.3.4:8080",
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips accounts already DONE in the store (resume semantics)", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\nb@y.com:p\nc@z.com:p\n", "4111111111111111 | 12/28 | 111\n", "");
    const store = new JsonlStore(cfg.stateFile);
    store.upsert({ email: "b@y.com", password: "p", status: FlowState.DONE, updatedAt: 1 });
    await processQueue(cfg, store);
    expect(runnerCtl.calls.map((c) => c.email)).toEqual(["a@x.com", "c@z.com"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips accounts already FAILED in the store (no retry in same dataset)", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\nb@y.com:p\n", "4111111111111111 | 12/28 | 111\n", "");
    const store = new JsonlStore(cfg.stateFile);
    store.upsert({ email: "a@x.com", password: "p", status: FlowState.FAILED, notes: "old fail", updatedAt: 1 });
    await processQueue(cfg, store);
    expect(runnerCtl.calls.map((c) => c.email)).toEqual(["b@y.com"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("aborts cleanly when no cards are seeded", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\n", "", "");
    await processQueue(cfg, new JsonlStore(cfg.stateFile));
    expect(runnerCtl.calls).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("signup-only mode runs with an empty vcc.txt and no card", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\nb@y.com:p\n", "", "");
    const signupCfg = loadConfig({
      ...process.env,
      SEED_GSUITE: cfg.seedGsuite, SEED_VCC: cfg.seedVcc, SEED_PROXY: cfg.seedProxy,
      STATE_FILE: cfg.stateFile, RESULT_SUCCESS_FILE: cfg.resultSuccessFile,
      RESULT_FAILED_FILE: cfg.resultFailedFile,
      MODE: "signup",
    } as NodeJS.ProcessEnv);
    await processQueue(signupCfg, new JsonlStore(signupCfg.stateFile));
    expect(runnerCtl.calls.map((c) => c.email)).toEqual(["a@x.com", "b@y.com"]);
    expect(runnerCtl.calls.map((c) => c.card)).toEqual([null, null]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("full mode still aborts when there is no card to link", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\n", "", "");
    expect(cfg.mode).toBe("full");
    await processQueue(cfg, new JsonlStore(cfg.stateFile));
    expect(runnerCtl.calls).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("no accounts → no-op without crashing", async () => {
    const { dir, cfg } = seedEnv("", "4111111111111111 | 12/28 | 111\n", "");
    await processQueue(cfg, new JsonlStore(cfg.stateFile));
    expect(runnerCtl.calls).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips accounts listed in akun-result.txt even without state.jsonl records", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\nb@y.com:p\n", "4111111111111111 | 12/28 | 111\n", "");
    // pre-seed only the result file (e.g. it was wiped state.jsonl or moved between machines)
    writeFileSync(join(dir, "akun-result.txt"), "a@x.com|2026-01-01T00:00:00.000Z|SG\n");
    await processQueue(cfg, new JsonlStore(cfg.stateFile));
    expect(runnerCtl.calls.map((c) => c.email)).toEqual(["b@y.com"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips accounts listed in akun-failed.txt by default", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\nb@y.com:p\n", "4111111111111111 | 12/28 | 111\n", "");
    writeFileSync(join(dir, "akun-failed.txt"), "a@x.com|2026-01-01T00:00:00.000Z|WAIT_3DS_TIMEOUT: slow\n");
    await processQueue(cfg, new JsonlStore(cfg.stateFile));
    expect(runnerCtl.calls.map((c) => c.email)).toEqual(["b@y.com"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("--retry-failed reprocesses accounts from akun-failed.txt (but never akun-result.txt)", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\nb@y.com:p\nc@z.com:p\n", "4111111111111111 | 12/28 | 111\n", "");
    writeFileSync(join(dir, "akun-failed.txt"), "a@x.com|2026-01-01T00:00:00.000Z|WAIT_3DS_TIMEOUT: slow\n");
    writeFileSync(join(dir, "akun-result.txt"), "b@y.com|2026-01-01T00:00:00.000Z|SG\n");
    const retryCfg = loadConfig({
      ...process.env,
      SEED_GSUITE: cfg.seedGsuite, SEED_VCC: cfg.seedVcc, SEED_PROXY: cfg.seedProxy,
      STATE_FILE: cfg.stateFile, RESULT_SUCCESS_FILE: cfg.resultSuccessFile,
      RESULT_FAILED_FILE: cfg.resultFailedFile, RETRY_FAILED: "1",
    } as NodeJS.ProcessEnv);
    await processQueue(retryCfg, new JsonlStore(retryCfg.stateFile));
    // a@x.com retried (was failed), b@y.com still skipped (was successful), c@z.com processed
    expect(runnerCtl.calls.map((c) => c.email)).toEqual(["a@x.com", "c@z.com"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("ACCOUNT_RESTRICTED failures are never retried, even with --retry-failed", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\nb@y.com:p\n", "4111111111111111 | 12/28 | 111\n", "");
    writeFileSync(
      join(dir, "akun-failed.txt"),
      "a@x.com|2026-01-01T00:00:00.000Z|ACCOUNT_RESTRICTED: account restricted by risk control\n",
    );
    const retryCfg = loadConfig({
      ...process.env,
      SEED_GSUITE: cfg.seedGsuite, SEED_VCC: cfg.seedVcc, SEED_PROXY: cfg.seedProxy,
      STATE_FILE: cfg.stateFile, RESULT_SUCCESS_FILE: cfg.resultSuccessFile,
      RESULT_FAILED_FILE: cfg.resultFailedFile, RETRY_FAILED: "1",
    } as NodeJS.ProcessEnv);
    await processQueue(retryCfg, new JsonlStore(retryCfg.stateFile));
    // a@x.com is a permanent ban → skipped; only b@y.com runs
    expect(runnerCtl.calls.map((c) => c.email)).toEqual(["b@y.com"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("non-restricted failures are still retried alongside restricted ones", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\nb@y.com:p\n", "4111111111111111 | 12/28 | 111\n", "");
    writeFileSync(
      join(dir, "akun-failed.txt"),
      "a@x.com|2026-01-01T00:00:00.000Z|WAIT_3DS_TIMEOUT: slow\n" +
      "b@y.com|2026-01-01T00:00:00.000Z|ACCOUNT_RESTRICTED: banned\n",
    );
    const retryCfg = loadConfig({
      ...process.env,
      SEED_GSUITE: cfg.seedGsuite, SEED_VCC: cfg.seedVcc, SEED_PROXY: cfg.seedProxy,
      STATE_FILE: cfg.stateFile, RESULT_SUCCESS_FILE: cfg.resultSuccessFile,
      RESULT_FAILED_FILE: cfg.resultFailedFile, RETRY_FAILED: "1",
    } as NodeJS.ProcessEnv);
    await processQueue(retryCfg, new JsonlStore(retryCfg.stateFile));
    expect(runnerCtl.calls.map((c) => c.email)).toEqual(["a@x.com"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("INTER_ACCOUNT_DELAY_SEC spaces consecutive accounts apart", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\nb@y.com:p\n", "4111111111111111 | 12/28 | 111\n", "");
    const slowCfg = loadConfig({
      ...process.env,
      SEED_GSUITE: cfg.seedGsuite, SEED_VCC: cfg.seedVcc, SEED_PROXY: cfg.seedProxy,
      STATE_FILE: cfg.stateFile, RESULT_SUCCESS_FILE: cfg.resultSuccessFile,
      RESULT_FAILED_FILE: cfg.resultFailedFile, INTER_ACCOUNT_DELAY_SEC: "2",
    } as NodeJS.ProcessEnv);
    const t0 = Date.now();
    await processQueue(slowCfg, new JsonlStore(slowCfg.stateFile));
    const elapsed = Date.now() - t0;
    expect(runnerCtl.calls.map((c) => c.email)).toEqual(["a@x.com", "b@y.com"]);
    // 2s min delay + up to 1s jitter → at least ~2s between the two accounts
    expect(elapsed).toBeGreaterThanOrEqual(2000);
    rmSync(dir, { recursive: true, force: true });
  });

  it("--retry-failed also reprocesses accounts marked FAILED in state.jsonl", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\n", "4111111111111111 | 12/28 | 111\n", "");
    const store = new JsonlStore(cfg.stateFile);
    store.upsert({ email: "a@x.com", password: "p", status: FlowState.FAILED, notes: "old", updatedAt: 1 });
    const retryCfg = loadConfig({
      ...process.env,
      SEED_GSUITE: cfg.seedGsuite, SEED_VCC: cfg.seedVcc, SEED_PROXY: cfg.seedProxy,
      STATE_FILE: cfg.stateFile, RESULT_SUCCESS_FILE: cfg.resultSuccessFile,
      RESULT_FAILED_FILE: cfg.resultFailedFile, RETRY_FAILED: "1",
    } as NodeJS.ProcessEnv);
    await processQueue(retryCfg, store);
    expect(runnerCtl.calls.map((c) => c.email)).toEqual(["a@x.com"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("everything already processed → no-op with a clear log", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\n", "4111111111111111 | 12/28 | 111\n", "");
    writeFileSync(join(dir, "akun-result.txt"), "a@x.com|2026-01-01T00:00:00.000Z|SG\n");
    await processQueue(cfg, new JsonlStore(cfg.stateFile));
    expect(runnerCtl.calls).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a thrown runner error does not kill the queue (isolation)", async () => {
    const { dir, cfg } = seedEnv("a@x.com:p\nb@y.com:p\nc@z.com:p\n", "4111111111111111 | 12/28 | 111\n", "");
    runnerCtl.failEmails.add("b@y.com");
    await processQueue(cfg, new JsonlStore(cfg.stateFile));
    expect(runnerCtl.calls.map((c) => c.email)).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
    // the failed account was recorded as a crash in results
    const crash = read(join(dir, "akun-failed.txt"));
    expect(crash).toContain("b@y.com");
    expect(crash).toContain("RUNNER_CRASH");
    rmSync(dir, { recursive: true, force: true });
  });

  it("respects max concurrency of 2 (worker pool, not a stampede)", async () => {
    const { dir, cfg } = seedEnv(
      "a@x.com:p\nb@y.com:p\nc@z.com:p\nd@x.com:p\n",
      "4111111111111111 | 12/28 | 111\n",
      "",
    );
    const cfg2 = loadConfig({
      ...process.env, SEED_GSUITE: cfg.seedGsuite, SEED_VCC: cfg.seedVcc, SEED_PROXY: cfg.seedProxy,
      STATE_FILE: cfg.stateFile, RESULT_SUCCESS_FILE: cfg.resultSuccessFile,
      RESULT_FAILED_FILE: cfg.resultFailedFile, WORKERS: "2",
    } as NodeJS.ProcessEnv);
    runnerCtl.delayMs = 60;
    await processQueue(cfg2, new JsonlStore(cfg2.stateFile));
    expect(runnerCtl.calls.length).toBe(4);
    expect(runnerCtl.maxActive).toBeLessThanOrEqual(2);
    expect(runnerCtl.maxActive).toBeGreaterThan(1); // actually parallel
    rmSync(dir, { recursive: true, force: true });
  });

  it("workers=1 runs strictly sequentially (maxActive === 1)", async () => {
    const { dir, cfg } = seedEnv(
      "a@x.com:p\nb@y.com:p\nc@z.com:p\n",
      "4111111111111111 | 12/28 | 111\n",
      "",
    );
    runnerCtl.delayMs = 30;
    await processQueue(cfg, new JsonlStore(cfg.stateFile)); // default workers=1
    expect(runnerCtl.maxActive).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

function read(f: string): string {
  try {
    return require("node:fs").readFileSync(f, "utf8");
  } catch {
    return "";
  }
}