// ── Launcher plan tests: the flags it composes must be the real flags ──
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextToken } from "./prompt.js";
import {
  APP_ENTRY,
  PROXY_CAPABLE,
  buildArgs,
  commandLine,
  readSeeds,
  warningsFor,
  type RunPlan,
} from "./plan.js";
import { parseArgs as parseCbdg, applyArgsToEnv as envCbdg } from "../apps/cbdg/src/cli.js";
import { parseArgs as parseCrusoe, applyArgsToEnv as envCrusoe } from "../apps/crusoe/src/cli.js";
import { parseArgs as parseWebshare, applyArgsToEnv as envWebshare } from "../apps/webshare/src/cli.js";

const base: RunPlan = {
  app: "cbdg",
  pace: "human",
  mode: "full",
  useProxy: true,
  headless: false,
  retryFailed: false,
  dryRun: false,
  delaySec: 60,
  workers: 1,
};

describe("buildArgs", () => {
  it("cbdg full run with proxy", () => {
    expect(buildArgs(base)).toEqual(["--headed", "--pace", "human", "--full", "--with-proxy", "--delay", "60"]);
  });
  it("cbdg signup-only without proxy", () => {
    expect(buildArgs({ ...base, mode: "signup", useProxy: false })).toContain("--signup-only");
    expect(buildArgs({ ...base, mode: "signup", useProxy: false })).toContain("--no-proxy");
  });
  it("crusoe gets the proxy switch, webshare does not", () => {
    const crusoe = buildArgs({ ...base, app: "crusoe", mode: undefined });
    expect(crusoe).toContain("--with-proxy");
    expect(crusoe).not.toContain("--full");
    const webshare = buildArgs({ ...base, app: "webshare", mode: undefined, useProxy: undefined });
    expect(webshare.some((a) => a.includes("proxy"))).toBe(false);
  });
  it("optional flags only appear when they change something", () => {
    const quiet = buildArgs({ ...base, delaySec: 0, workers: 1 });
    expect(quiet).not.toContain("--delay");
    expect(quiet).not.toContain("-w");
    const loud = buildArgs({ ...base, workers: 3, retryFailed: true, dryRun: true, headless: true });
    expect(loud).toContain("--headless");
    expect(loud).toEqual(expect.arrayContaining(["-w", "3", "--retry-failed", "--dry-run"]));
  });
  it("commandLine is copy-pasteable", () => {
    expect(commandLine(base)).toBe("bun run cbdg -- --headed --pace human --full --with-proxy --delay 60");
  });
});

// The launcher is only useful if every flag it emits is one the app accepts.
describe("emitted flags are understood by the apps", () => {
  const cases: Array<[RunPlan, (a: string[]) => NodeJS.ProcessEnv]> = [
    [{ ...base }, (a) => envCbdg(parseCbdg(a, () => {}), {})],
    [{ ...base, mode: "signup", useProxy: false }, (a) => envCbdg(parseCbdg(a, () => {}), {})],
    [{ ...base, app: "crusoe", mode: undefined }, (a) => envCrusoe(parseCrusoe(a), {})],
    [{ ...base, app: "crusoe", mode: undefined, useProxy: false }, (a) => envCrusoe(parseCrusoe(a), {})],
    [{ ...base, app: "webshare", mode: undefined, useProxy: undefined }, (a) => envWebshare(parseWebshare(a), {})],
  ];

  it("every plan produces the env the app would need", () => {
    for (const [plan, toEnv] of cases) {
      const env = toEnv(buildArgs(plan));
      expect(env.PACE).toBe(plan.pace);
      expect(env.HEADLESS).toBe(plan.headless ? "1" : "0");
      expect(env.INTER_ACCOUNT_DELAY_SEC).toBe(String(plan.delaySec));
      if (plan.app === "cbdg") expect(env.MODE).toBe(plan.mode);
      if (plan.useProxy !== undefined) expect(env.USE_PROXY).toBe(plan.useProxy ? "1" : "0");
      else expect(env.USE_PROXY).toBeUndefined();
    }
  });

  it("app entry paths exist for every app", async () => {
    for (const entry of Object.values(APP_ENTRY)) {
      expect(await Bun.file(entry).exists()).toBe(true);
    }
  });
});

describe("seeds + warnings", () => {
  function seedDir(gsuite: string, proxy: string, vcc: string): string {
    const dir = mkdtempSync(join(tmpdir(), "launch-"));
    writeFileSync(join(dir, "gsuite.txt"), gsuite);
    writeFileSync(join(dir, "proxy.txt"), proxy);
    writeFileSync(join(dir, "vcc.txt"), vcc);
    return dir;
  }

  it("counts seed lines and ignores comments and blanks", () => {
    const dir = seedDir("# c\na@x.com:p\n\nb@y.com:p\n", "http://1.1.1.1:80\n", "");
    expect(readSeeds(dir)).toEqual({ accounts: 2, proxies: 1, cards: 0 });
    rmSync(dir, { recursive: true, force: true });
  });

  it("warns when full mode has no card", () => {
    const w = warningsFor({ ...base }, { accounts: 3, proxies: 3, cards: 0 });
    expect(w.join(" ")).toContain("vcc.txt kosong");
  });
  it("warns when proxy is requested but the pool is empty", () => {
    const w = warningsFor({ ...base, mode: "signup" }, { accounts: 3, proxies: 0, cards: 0 });
    expect(w.join(" ")).toContain("proxy.txt kosong");
  });
  it("warns when many accounts share one IP", () => {
    const w = warningsFor({ ...base, mode: "signup", useProxy: false }, { accounts: 9, proxies: 0, cards: 0 });
    expect(w.join(" ")).toContain("berbagi satu IP");
  });
  it("warns when spacing is zero", () => {
    const w = warningsFor({ ...base, mode: "signup", delaySec: 0 }, { accounts: 5, proxies: 5, cards: 0 });
    expect(w.join(" ")).toContain("0 detik");
  });
  it("a well-formed plan warns about nothing", () => {
    const w = warningsFor({ ...base, mode: "signup" }, { accounts: 5, proxies: 5, cards: 2 });
    expect(w).toEqual([]);
  });
  it("proxy-capable list is exactly the apps that read proxy.txt", () => {
    expect(PROXY_CAPABLE).toEqual(["cbdg", "crusoe"]);
  });
});

// ── stdin tokenising ───────────────────────────────────────────────
// The launcher used to read stdin with one `once("data")` per prompt, which
// dropped every answer after the first whenever they arrived in one chunk.
describe("nextToken", () => {
  const ESC = String.fromCharCode(27);
  it("takes one line at a time out of a multi-answer chunk", () => {
    let buf = "1\n2\n\n";
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const got = nextToken(buf, "line");
      expect(got).not.toBeNull();
      seen.push(got!.token);
      buf = got!.rest;
    }
    expect(seen).toEqual(["1", "2", ""]);
    expect(buf).toBe("");
  });
  it("waits for the newline instead of guessing", () => {
    expect(nextToken("12", "line")).toBeNull();
    expect(nextToken("", "line")).toBeNull();
  });
  it("strips a trailing CR so windows input matches", () => {
    expect(nextToken("7\r\n", "line")).toEqual({ token: "7", rest: "" });
  });
  it("an arrow key is one token, not three", () => {
    expect(nextToken(`${ESC}[A`, "key")).toEqual({ token: `${ESC}[A`, rest: "" });
    expect(nextToken(`${ESC}[Bx`, "key")).toEqual({ token: `${ESC}[B`, rest: "x" });
  });
  it("a plain key is one character", () => {
    expect(nextToken("jk", "key")).toEqual({ token: "j", rest: "k" });
    expect(nextToken("\x03", "key")).toEqual({ token: "\x03", rest: "" });
  });
});
