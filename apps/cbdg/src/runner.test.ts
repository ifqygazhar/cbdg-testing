// ── Runner tests: state-machine pump with mocked engine + browser ───
// Validates: full happy path, failure path, and the invariant that the
// browser handle is ALWAYS closed (fresh fingerprint for the next account).
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHAIN = ["PRICING", "GOOGLE_OAUTH", "COMPLETE_REGISTER", "ADD_PAYMENT", "LINK_CARD", "START_TRIAL", "DONE"];

const ctl = {
  failAt: null as string | null,
  failCode: "STEP_BOOM",
  closed: 0,
  transitions: [] as string[],
};

mock.module("./flow/engine.js", () => ({
  FlowError: class FlowError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  isTerminalState: (s: string) => s === "DONE" || s === "FAILED",
  transition: async (state: string) => {
    ctl.transitions.push(state);
    if (ctl.failAt === state) {
      const E = class extends Error {
        code: string;
        constructor(code: string, m: string) { super(m); this.code = code; }
      };
      throw new E(ctl.failCode, `step ${state} exploded`);
    }
    const i = CHAIN.indexOf(state);
    if (i === -1) return "DONE";
    return i === CHAIN.length - 1 ? "DONE" : CHAIN[i + 1];
  },
  ORDER: [],
}));

mock.module("@ifqy/google-oauth", () => ({
  launchGoogleOAuthBrowser: async () => ({
    browser: { _fake: true },
    context: { _fake: true },
    page: { _fake: true },
    close: async () => { ctl.closed++; },
  }),
  // config.ts validates the pace through the library and the runner classifies
  // network errors with it, so the mock has to provide both — a missing export
  // here fails the whole file at import.
  isPaceName: (v: unknown) => v === "fast" || v === "human" || v === "careful",
  classifyNetworkError: () => null,
  GOOGLE_DIRECT_HOSTS: ["accounts.google.com"],
}));

// import AFTER mocks are registered
const { runAccount } = await import("./runner.js");
const { JsonlStore, FlowState, ResultWriter } = await import("./store.js");
const { loadConfig } = await import("./config.js");

const ACCOUNT = { email: "t@x.com", password: "secret", raw: "t@x.com:secret" };
const CARD = { cardNumber: "4111111111111111", expiry: "12/28", cvv: "123", raw: "" };

function freshEnv(): { store: InstanceType<typeof JsonlStore>; results: InstanceType<typeof ResultWriter>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "cbdg-run-"));
  const store = new JsonlStore(join(dir, "state.jsonl"));
  const results = new ResultWriter(join(dir, "akun-result.txt"), join(dir, "akun-failed.txt"));
  return { store, results, dir };
}

beforeEach(() => {
  ctl.failAt = null;
  ctl.failCode = "STEP_BOOM";
  ctl.closed = 0;
  ctl.transitions = [];
});

describe("runAccount", () => {
  it("happy path: walks the full chain to DONE, records success, closes browser exactly once", async () => {
    const { store, results, dir } = freshEnv();
    const cfg = loadConfig({
      RESULT_SUCCESS_FILE: join(dir, "akun-result.txt"),
      RESULT_FAILED_FILE: join(dir, "akun-failed.txt"),
      SCREENSHOT_DIR: join(dir, "shots"),
    } as NodeJS.ProcessEnv);

    const final = await runAccount(ACCOUNT, CARD, null, store, results, cfg);

    expect(final).toBe(FlowState.DONE);
    // transition was invoked for every non-terminal state, in order
    expect(ctl.transitions).toEqual(CHAIN.slice(0, -1));
    // browser lifecycle invariant: exactly one close
    expect(ctl.closed).toBe(1);
    // store: PENDING → DONE with fingerprint recorded
    const rec = new JsonlStore(join(dir, "state.jsonl")).get(ACCOUNT.email);
    expect(rec?.status).toBe(FlowState.DONE);
    expect(rec?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    // result files
    const ok = readFileSync(join(dir, "akun-result.txt"), "utf8");
    expect(ok).toContain(ACCOUNT.email);
    expect(ok).toContain("SG");
    rmSync(dir, { recursive: true, force: true });
  });

  it("failure path: step throws → FAILED with code, failure recorded, browser still closed", async () => {
    const { store, results, dir } = freshEnv();
    const cfg = loadConfig({
      RESULT_SUCCESS_FILE: join(dir, "akun-result.txt"),
      RESULT_FAILED_FILE: join(dir, "akun-failed.txt"),
    } as NodeJS.ProcessEnv);

    ctl.failAt = "LINK_CARD";
    ctl.failCode = "WAIT_3DS_TIMEOUT";

    const final = await runAccount(ACCOUNT, CARD, null, store, results, cfg);

    // runAccount never throws — it reports FAILED
    expect(final).toBe(FlowState.FAILED);
    expect(ctl.closed).toBe(1); // ← the critical invariant
    const rec = new JsonlStore(join(dir, "state.jsonl")).get(ACCOUNT.email);
    expect(rec?.status).toBe(FlowState.FAILED);
    expect(rec?.notes).toContain("WAIT_3DS_TIMEOUT");
    const bad = readFileSync(join(dir, "akun-failed.txt"), "utf8");
    expect(bad).toContain(ACCOUNT.email);
    expect(bad).toContain("WAIT_3DS_TIMEOUT");
    rmSync(dir, { recursive: true, force: true });
  });

  it("failure in the very first step still closes the browser", async () => {
    const { store, results, dir } = freshEnv();
    const cfg = loadConfig({
      RESULT_SUCCESS_FILE: join(dir, "akun-result.txt"),
      RESULT_FAILED_FILE: join(dir, "akun-failed.txt"),
    } as NodeJS.ProcessEnv);
    ctl.failAt = "PRICING";
    const final = await runAccount(ACCOUNT, CARD, null, store, results, cfg);
    expect(final).toBe(FlowState.FAILED);
    expect(ctl.closed).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("proxy info is stored when provided", async () => {
    const { store, results, dir } = freshEnv();
    const cfg = loadConfig({
      RESULT_SUCCESS_FILE: join(dir, "akun-result.txt"),
      RESULT_FAILED_FILE: join(dir, "akun-failed.txt"),
    } as NodeJS.ProcessEnv);
    await runAccount(ACCOUNT, CARD, { server: "http://1.2.3.4:8080", raw: "1.2.3.4:8080" }, store, results, cfg);
    const rec = new JsonlStore(join(dir, "state.jsonl")).get(ACCOUNT.email);
    expect(rec?.proxy).toBe("http://1.2.3.4:8080");
    rmSync(dir, { recursive: true, force: true });
  });

  it("second account gets a different fingerprint id (fresh launch semantics)", async () => {
    const { store, results, dir } = freshEnv();
    const cfg = loadConfig({
      RESULT_SUCCESS_FILE: join(dir, "akun-result.txt"),
      RESULT_FAILED_FILE: join(dir, "akun-failed.txt"),
    } as NodeJS.ProcessEnv);
    const acc2 = { email: "u@y.com", password: "p2", raw: "u@y.com:p2" };

    await runAccount(ACCOUNT, CARD, null, store, results, cfg);
    await runAccount(acc2, CARD, null, store, results, cfg);

    const s = new JsonlStore(join(dir, "state.jsonl"));
    const fp1 = s.get(ACCOUNT.email)?.fingerprint;
    const fp2 = s.get(acc2.email)?.fingerprint;
    expect(fp1).not.toBe(fp2);
    // two launches, two closes — one per account
    expect(ctl.closed).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});