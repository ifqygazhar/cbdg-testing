// ── Unit tests: app logic (no browser) ─────────────────────────────
import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ensureDirs, parseBool } from "./config.js";
import { loadAccounts, loadCards, loadProxies } from "./loaders.js";
import { JsonlStore, FlowState, ResultWriter } from "./store.js";
import { isTerminalState, transition, ORDER } from "./flow/engine.js";
import { STEPS } from "./flow/steps.js";
import { Selectors } from "./flow/selectors.js";
import { parseArgs, applyArgsToEnv, USAGE } from "./cli.js";
import { createLog } from "./log.js";

const tmp = () => mkdtempSync(join(tmpdir(), "cbdg-"));
const writeFile = (name: string, content: string): string => {
  const f = join(tmp(), name);
  writeFileSync(f, content);
  return f;
};

// ── config ────────────────────────────────────────────────────────
describe("app config", () => {
  it("defaults: region SG, workers 1, headed, timeouts per spec, result files at root", () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c.region).toBe("SG");
    expect(c.workers).toBe(1);
    expect(c.headless).toBe(false);
    expect(c.wait3dsTimeoutSec).toBe(180);
    expect(c.openPaymentTimeoutSec).toBe(120);
    expect(c.linkCardTimeoutSec).toBe(180);
    expect(c.creditVerifyTimeoutSec).toBe(60);
    expect(c.retryFailed).toBe(false);
    expect(c.resultSuccessFile).toContain("akun-result.txt");
    expect(c.resultFailedFile).toContain("akun-failed.txt");
  });

  it("env overrides: region, workers, headless, 3ds timeout, retry-failed", () => {
    const c = loadConfig({
      REGION: "us", WORKERS: "4", HEADLESS: "1", WAIT_3DS_TIMEOUT_SEC: "300", RETRY_FAILED: "true",
    } as NodeJS.ProcessEnv);
    expect(c.region).toBe("US");
    expect(c.workers).toBe(4);
    expect(c.headless).toBe(true);
    expect(c.wait3dsTimeoutSec).toBe(300);
    expect(c.retryFailed).toBe(true);
  });

  it("invalid env values fall back to defaults instead of crashing", () => {
    const c = loadConfig({ WORKERS: "abc", WAIT_3DS_TIMEOUT_SEC: "-5" } as NodeJS.ProcessEnv);
    expect(c.workers).toBe(1);
    expect(c.wait3dsTimeoutSec).toBe(180);
  });

  it("parseBool accepts common truthy/falsy spellings", () => {
    expect(parseBool("1", false)).toBe(true);
    expect(parseBool("YES", false)).toBe(true);
    expect(parseBool("on", false)).toBe(true);
    expect(parseBool("0", true)).toBe(false);
    expect(parseBool(undefined, true)).toBe(true);
    expect(parseBool("", true)).toBe(true);
  });

  it("ensureDirs creates parent dirs for result files + screenshots", () => {
    const dir = tmp();
    const cfg = loadConfig({
      RESULT_SUCCESS_FILE: join(dir, "nested", "ok", "akun-result.txt"),
      RESULT_FAILED_FILE: join(dir, "nested2", "akun-failed.txt"),
      SCREENSHOT_DIR: join(dir, "s"),
    } as NodeJS.ProcessEnv);
    ensureDirs(cfg);
    expect(fs.existsSync(join(dir, "nested", "ok"))).toBe(true);
    expect(fs.existsSync(join(dir, "nested2"))).toBe(true);
    expect(fs.existsSync(join(dir, "s"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── loaders: edge cases ────────────────────────────────────────────
describe("loaders", () => {
  it("missing file → empty array, no throw", () => {
    expect(loadAccounts(join(tmp(), "nope.txt"))).toEqual([]);
    expect(loadCards(join(tmp(), "nope.txt"))).toEqual([]);
    expect(loadProxies(join(tmp(), "nope.txt"))).toEqual([]);
  });

  it("handles CRLF, comments, blank lines, stray whitespace", () => {
    const f = writeFile("gsuite.txt", "# c\r\n\r\n  a@x.com : pw1  \r\n\tb@y.com:pw2\t\r\n");
    const r = loadAccounts(f);
    expect(r).toEqual([
      { email: "a@x.com", password: "pw1", raw: expect.any(String) },
      { email: "b@y.com", password: "pw2", raw: expect.any(String) },
    ]);
  });

  it("passwords containing colons are preserved", () => {
    const f = writeFile("gsuite.txt", "a@x.com:pa:ss:word\n");
    expect(loadAccounts(f)[0].password).toBe("pa:ss:word");
  });

  it("vcc: accepts MM/YY and MM/YYYY, rejects bad expiry/cvv/card count", () => {
    const f = writeFile("vcc.txt",
      "4111111111111111|12/28|123\n" +
      "4222222222222222 | 10/2027 | 4567\n" +   // 4-digit cvv OK
      "4333333333333333|2028/12|123\n" +        // inverted expiry → reject
      "4444444444444444|13/28|123\n" +          // month 13 (regex passes shape; kept raw)
      "55|12/28|123\n",                          // short card number (shape passes, kept raw)
    );
    const r = loadCards(f);
    expect(r.length).toBe(4);
    expect(r[1].expiry).toBe("10/2027");
    expect(r[1].cvv).toBe("4567");
  });

  it("vcc: pipes with extra segments are still parsed from first three", () => {
    const f = writeFile("vcc.txt", "4111111111111111|12/28|123|extra|note\n");
    expect(loadCards(f)[0].cardNumber).toBe("4111111111111111");
  });

  it("proxies: bare host:port, http with auth, socks5", () => {
    const f = writeFile("proxy.txt", "1.2.3.4:8080\nhttp://u:p@5.6.7.8:3128\nsocks5://9.9.9.9:1080\n://broken\n");
    const r = loadProxies(f);
    expect(r.length).toBe(3);
    expect(r[0].server).toBe("http://1.2.3.4:8080");
    expect(r[1].server).toBe("http://5.6.7.8:3128");
    expect(r[2].server).toBe("socks5://9.9.9.9:1080");
  });
});

// ── store ──────────────────────────────────────────────────────────
describe("JsonlStore", () => {
  it("corrupt lines are ignored, valid records survive", () => {
    const f = join(tmp(), "s.jsonl");
    fs.appendFileSync(f, "{not json}\n");
    fs.appendFileSync(f, JSON.stringify({ email: "a@x.com", password: "p", status: "PENDING", updatedAt: 1 }) + "\n");
    fs.appendFileSync(f, "\n");
    const s = new JsonlStore(f);
    expect(s.all().length).toBe(1);
    expect(s.get("a@x.com")?.password).toBe("p");
  });

  it("setStatus on unknown email is a safe no-op", () => {
    const s = new JsonlStore(join(tmp(), "s.jsonl"));
    expect(() => s.setStatus("ghost@x.com", FlowState.DONE)).not.toThrow();
    expect(s.all()).toEqual([]);
  });

  it("terminal detection works after replay across instances", () => {
    const f = join(tmp(), "s.jsonl");
    const s = new JsonlStore(f);
    s.upsert({ email: "a@x.com", password: "p", status: FlowState.PENDING, updatedAt: 1 });
    s.setStatus("a@x.com", FlowState.DONE, "ok");
    const s2 = new JsonlStore(f);
    expect(s2.isTerminal("a@x.com")).toBe(true);
    expect(s2.get("a@x.com")?.notes).toBe("ok");
  });

  it("upsert merges by email (map semantics)", () => {
    const f = join(tmp(), "s.jsonl");
    const s = new JsonlStore(f);
    s.upsert({ email: "a@x.com", password: "p1", status: FlowState.PENDING, updatedAt: 1 });
    s.upsert({ email: "b@y.com", password: "p2", status: FlowState.PENDING, updatedAt: 2 });
    s.upsert({ email: "a@x.com", password: "p1", status: FlowState.GOOGLE_OAUTH, fingerprint: "fp", updatedAt: 3 });
    const s2 = new JsonlStore(f);
    expect(s2.all().length).toBe(2);
    expect(s2.get("a@x.com")?.status).toBe(FlowState.GOOGLE_OAUTH);
    expect(s2.get("a@x.com")?.fingerprint).toBe("fp");
  });
});

describe("ResultWriter", () => {
  it("writes success and failed lines with sanitized pipes", () => {
    const dir = tmp();
    const w = new ResultWriter(join(dir, "akun-result.txt"), join(dir, "akun-failed.txt"));
    w.markSuccess("a@x.com", "SG");
    w.markFailed("b@y.com", "boom|with|pipes");
    const ok = readFileSync(join(dir, "akun-result.txt"), "utf8").trim().split("\n")[0];
    const bad = readFileSync(join(dir, "akun-failed.txt"), "utf8").trim().split("\n")[0];
    expect(ok.startsWith("a@x.com|")).toBe(true);
    expect(ok.endsWith("|SG")).toBe(true);
    expect(bad.startsWith("b@y.com|")).toBe(true);
    expect(bad.includes("boom/with/pipes")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses its own output back into skip-sets (email = first field)", () => {
    const dir = tmp();
    const w = new ResultWriter(join(dir, "akun-result.txt"), join(dir, "akun-failed.txt"));
    w.markSuccess("ok@x.com", "SG");
    w.markSuccess("ok2@x.com", "SG");
    w.markFailed("bad@x.com", "3DS timeout");
    const ok = w.getSuccessfulEmails();
    const bad = w.getFailedEmails();
    expect(ok.has("ok@x.com")).toBe(true);
    expect(ok.has("ok2@x.com")).toBe(true);
    expect(ok.size).toBe(2);
    expect(bad.has("bad@x.com")).toBe(true);
    expect(bad.size).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips blank/comment lines when parsing", () => {
    const dir = tmp();
    const f = join(dir, "akun-result.txt");
    fs.mkdirSync(dir, { recursive: true });
    writeFileSync(f, "# manual note\n\na@x.com|2026-01-01T00:00:00Z|SG\n");
    const w = new ResultWriter(f, join(dir, "akun-failed.txt"));
    expect(w.getSuccessfulEmails().size).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("missing files parse to empty sets (no throw)", () => {
    const dir = tmp();
    const w = new ResultWriter(join(dir, "missing-ok.txt"), join(dir, "missing-bad.txt"));
    expect(w.getSuccessfulEmails().size).toBe(0);
    expect(w.getFailedEmails().size).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── engine integrity ───────────────────────────────────────────────
describe("flow engine", () => {
  it("every ORDER state has a registered step", () => {
    for (const s of ORDER) {
      expect(typeof STEPS[s as string]).toBe("function");
    }
  });

  it("no extra/unknown steps are registered", () => {
    const known = new Set([...ORDER, FlowState.VERIFY_CREDIT].map(String));
    for (const k of Object.keys(STEPS)) expect(known.has(k)).toBe(true);
  });

  it("VERIFY_CREDIT is the signup-only terminal and now has a real step", () => {
    // It used to fall through to DONE with no step. Signup-only mode ends
    // there, so it must actually check that the welcome credits landed.
    expect(typeof STEPS[FlowState.VERIFY_CREDIT as string]).toBe("function");
  });

  it("unknown state throws FlowError with code NO_STEP", async () => {
    try {
      await transition("NOT_A_STATE" as FlowState, {} as never);
      expect.unreachable();
    } catch (e) {
      expect((e as { code: string }).code).toBe("NO_STEP");
    }
  });

  it("isTerminalState covers both terminals", () => {
    expect(isTerminalState(FlowState.DONE)).toBe(true);
    expect(isTerminalState(FlowState.FAILED)).toBe(true);
    for (const s of ORDER) expect(isTerminalState(s)).toBe(false);
  });
});

// ── selectors integrity + dataset validation ────────────────────────
const DS = join(process.cwd(), "dataset_target");

describe("flow selectors", () => {
  it("all required selector keys exist", () => {
    const keys = Object.keys(Selectors) as string[];
    for (const k of [
      "pricingBonusSignup", "registerRegionToggle", "registerRegion", "registerSubmit",
      "accountMenu", "paymentProfile", "midasTokenField", "harvestSignUrl",
      "firstName", "lastName", "cardNumber", "expiry", "cvc",
      "billingCity", "billingPostal", "billingState", "billingPhone",
      "billingCountry", "phoneCountry", "linkCard",
      "mida3ds", "midaSuccess", "trial7d", "plansUsage", "creditBanner",
    ]) {
      expect(keys).toContain(k);
    }
  });

  it("string needles are lowercase (dom matcher lowercases page text)", () => {
    const strs: string[] = [
      ...Selectors.pricingBonusSignup,
      Selectors.paymentProfile,
      Selectors.registerSubmit, Selectors.linkCard, Selectors.accountMenu,
      ...Selectors.trial7d, ...Selectors.registerRegionToggle,
    ];
    for (const s of strs) expect(s).toBe(s.toLowerCase());
  });

  it("registerRegion(code) returns lowercase needles incl. country name", () => {
    expect(Selectors.registerRegion("SG")).toEqual(["sg", "singapore"]);
    expect(Selectors.registerRegion("singapore")).toEqual(["singapore"]);
    expect(Selectors.registerRegion("XX")).toEqual(["xx"]);
  });

  it("harvestSignUrl matches the real captured redirect URL", () => {
    const real =
      "https://card.harvestsharp.com/apps/creditcard/views/sign?token=AAAA" +
      "L_Jt0Z-fkH0RInH8Kuu7kk2&language_code=en&region_code=SG&allow_bind=&" +
      "allow_unbind=false&source=CONSOLE&mcid=76317551398467314";
    expect(Selectors.harvestSignUrl.test(real)).toBe(true);
  });
});

describe("dataset validation (skipped when dataset absent)", () => {
  const hasDataset = fs.existsSync(DS);
  const read = (f: string) => (hasDataset ? fs.readFileSync(join(DS, f), "utf8") : "");

  it("pricing bonus block matches captured before_signup_for_take_bonus_200credit.html", () => {
    if (!hasDataset) return;
    const html = read("before_signup_for_take_bonus_200credit.html");
    for (const needle of Selectors.pricingBonusSignup) {
      // needles are lowercase; the captured HTML carries the original casing
      expect(html.toLowerCase()).toContain(needle);
    }
  });

  it("midas form field names match captured midaspayment.html", () => {
    if (!hasDataset) return;
    const html = read("midaspayment.html");
    for (const name of [
      "cardHolderFirstName", "cardHolderLastName", "cardInputNum",
      "cardExpiryDate", "cardCVC", "billingAddressCity",
      "billingAddressPostalCode", "billingAddressStateOrProvince",
      "billingAddressPhoneNumber", "billingAddressCountry_select",
      "phoneNumberCountryCode_select", "xMidasToken",
    ]) {
      expect(html).toContain(name);
    }
    // our CSS selectors derive directly from those names
    expect(html).toContain('name="cardHolderFirstName"');
    expect(html).toContain('name="cardExpiryDate"');
  });

  it("region selector labels match captured complete_register.html", () => {
    if (!hasDataset) return;
    const html = read("complete_register.html");
    expect(html).toContain("Select Registration Region");
    expect(html).toContain("Singapore");
    expect(html.toLowerCase()).toContain("submit");
  });

  it("trial popup wording matches captured popup-start-trial-7d.html", () => {
    if (!hasDataset) return;
    const html = read("popup-start-trial-7d.html").toLowerCase();
    expect(html).toContain("7-day free trial");
    expect(html).toContain("500 credits for 7 days");
  });

  it("credit amounts 500/250 present in captured success_claim_credit.html", () => {
    if (!hasDataset) return;
    const html = read("success_claim_credit.html");
    expect(html).toContain("500");
    expect(html).toContain("250");
  });
});

// ── cli args ───────────────────────────────────────────────────────
describe("run mode + pace", () => {
  it("defaults to the full card flow", () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c.mode).toBe("full");
    expect(c.pace).toBe("human");
  });
  it("MODE=signup stops before the card; junk values fall back to full", () => {
    expect(loadConfig({ MODE: "signup" } as NodeJS.ProcessEnv).mode).toBe("signup");
    expect(loadConfig({ MODE: "halfway" } as NodeJS.ProcessEnv).mode).toBe("full");
  });
  it("PACE is validated the same way", () => {
    expect(loadConfig({ PACE: "fast" } as NodeJS.ProcessEnv).pace).toBe("fast");
    expect(loadConfig({ PACE: "turbo" } as NodeJS.ProcessEnv).pace).toBe("human");
  });
  it("flags map onto the env", () => {
    expect(applyArgsToEnv(parseArgs(["--signup-only"]), {}).MODE).toBe("signup");
    expect(applyArgsToEnv(parseArgs(["--no-vcc"]), {}).MODE).toBe("signup");
    expect(applyArgsToEnv(parseArgs(["--full"]), {}).MODE).toBe("full");
    expect(applyArgsToEnv(parseArgs(["--mode", "signup"]), {}).MODE).toBe("signup");
    expect(applyArgsToEnv(parseArgs(["--fast"]), {}).PACE).toBe("fast");
    expect(applyArgsToEnv(parseArgs(["--careful"]), {}).PACE).toBe("careful");
  });
  it("signup mode routes registration to the credit check, not the card", async () => {
    const { afterRegister } = await import("./flow/steps.js");
    expect(afterRegister("signup")).toBe(FlowState.VERIFY_CREDIT);
    expect(afterRegister("full")).toBe(FlowState.ADD_PAYMENT);
    // and both destinations really have a step behind them
    expect(typeof STEPS[afterRegister("signup") as string]).toBe("function");
    expect(typeof STEPS[afterRegister("full") as string]).toBe("function");
  });
});

describe("parseArgs", () => {
  it("defaults to undefined (env decides headless/workers)", () => {
    const a = parseArgs([]);
    expect(a.headless).toBeUndefined();
    expect(a.workers).toBeUndefined();
    expect(a.dryRun).toBeUndefined();
  });

  it("--headless / --headed / -w N / --region / --state / --dry-run", () => {
    const a = parseArgs(["--headless", "-w", "3", "--region", "US", "--state", "x.jsonl", "--dry-run"]);
    expect(a).toEqual({ headless: true, workers: 3, region: "US", state: "x.jsonl", dryRun: true });
    const b = parseArgs(["--headed"]);
    expect(b.headless).toBe(false);
  });

  it("--help hands off to the help action and stops parsing", () => {
    // This used to call process.exit inside the parser. Under the test runner
    // that really exits: the suite died here and every test after it silently
    // never ran. The action is injectable now.
    let called = 0;
    const args = parseArgs(["--help", "--region", "US"], () => { called++; });
    expect(called).toBe(1);
    expect(args.region).toBeUndefined();
    expect(USAGE).toContain("Usage");
    expect(USAGE).toContain("--signup-only");
  });

  it("applyArgsToEnv: CLI flags override env, absent flags leave env untouched", () => {
    const base = { REGION: "US", HEADLESS: "1" } as NodeJS.ProcessEnv;
    // no flags → base preserved
    const none = applyArgsToEnv({}, base);
    expect(none.REGION).toBe("US");
    expect(none.HEADLESS).toBe("1");
    // flags win
    const over = applyArgsToEnv({ region: "SG", headless: false, workers: 3 }, base);
    expect(over.REGION).toBe("SG");
    expect(over.HEADLESS).toBe("0");
    expect(over.WORKERS).toBe("3");
    // --headed flips an env-set headless
    const headed = applyArgsToEnv({ headless: false }, { HEADLESS: "1" } as NodeJS.ProcessEnv);
    expect(headed.HEADLESS).toBe("0");
    // original base object not mutated
    expect(base.REGION).toBe("US");
  });
});

// ── log ────────────────────────────────────────────────────────────
describe("createLog", () => {
  it("emits valid JSON with level/msg and child merges meta", () => {
    const lines: string[] = [];
    const orig = { log: console.log, error: console.error };
    console.log = (l: string) => lines.push(l);
    console.error = (l: string) => lines.push(l);
    try {
      const base = createLog({ email: "a@x.com" });
      base("info", "hello", { state: "PRICING" });
      const child = base.child({ email: "b@y.com", extra: 1 });
      child("warn", "careful");
    } finally {
      console.log = orig.log;
      console.error = orig.error;
    }
    const a = JSON.parse(lines[0]);
    const b = JSON.parse(lines[1]);
    expect(a.email).toBe("a@x.com");
    expect(a.msg).toBe("hello");
    expect(a.level).toBe("info");
    expect(b.email).toBe("b@y.com"); // child overrode
    expect(b.extra).toBe(1);
  });
});

describe("proxy credentials", () => {
  it("proxy credentials survive the loader", () => {
    // Regression: `server` was built from protocol+host only, so user:pass was
    // dropped and every navigation died with ERR_INVALID_AUTH_CREDENTIALS.
    const dir = mkdtempSync(join(tmpdir(), "px-"));
    const f = join(dir, "proxy.txt");
    writeFileSync(f, "http://zwasosog:s3cret@31.59.20.176:6754\nhttp://1.2.3.4:8080\n", "utf8");
    const [withAuth, plain] = loadProxies(f);
    expect(withAuth.server).toBe("http://31.59.20.176:6754");
    expect(withAuth.username).toBe("zwasosog");
    expect(withAuth.password).toBe("s3cret");
    expect(plain.username).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
  it("percent-encoded credentials are decoded", () => {
    const dir = mkdtempSync(join(tmpdir(), "px-"));
    const f = join(dir, "proxy.txt");
    writeFileSync(f, "http://user:p%40ss%3Aword@1.2.3.4:8080\n", "utf8");
    expect(loadProxies(f)[0].password).toBe("p@ss:word");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("google direct (proxy bypass)", () => {
  it("defaults to sending google sign-in direct", () => {
    // Google scores the sign-in by the address it comes from, and a shared
    // datacenter proxy earns an image captcha at the email step.
    expect(loadConfig({} as NodeJS.ProcessEnv).googleDirect).toBe(true);
  });
  it("can be turned off entirely", () => {
    expect(loadConfig({ GOOGLE_DIRECT: "0" } as NodeJS.ProcessEnv).googleDirect).toBe(false);
    expect(applyArgsToEnv(parseArgs(["--no-google-direct"], () => {}), {}).GOOGLE_DIRECT).toBe("0");
    expect(applyArgsToEnv(parseArgs(["--google-direct"], () => {}), {}).GOOGLE_DIRECT).toBe("1");
  });
  it("the host list is overridable and tolerant of separators", () => {
    const c = loadConfig({ GOOGLE_DIRECT_HOSTS: "a.com; b.com , c.com" } as NodeJS.ProcessEnv);
    expect(c.googleDirectHosts).toEqual(["a.com", "b.com", "c.com"]);
    expect(loadConfig({} as NodeJS.ProcessEnv).googleDirectHosts).toEqual([]);
  });
});
