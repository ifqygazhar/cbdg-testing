// ── FastRouter app unit tests (config, loaders, selectors, store) ──
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseBool } from "./config.js";
import { applyArgsToEnv, parseArgs } from "./cli.js";
import { PACES } from "@ifqy/google-oauth";
import { loadAccounts, loadProxies } from "./loaders.js";
import { ResultWriter } from "./store.js";
import { Selectors, API_KEY_RE, OTP_CODE_RE } from "./flow/selectors.js";

describe("fastrouter app config", () => {
  it("defaults", () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c.workers).toBe(1);
    expect(c.headless).toBe(false);
    expect(c.retryFailed).toBe(false);
    expect(c.interAccountDelaySec).toBe(0);
    expect(c.signupFormTimeoutSec).toBe(45);
    expect(c.welcomeTimeoutSec).toBe(60);
    expect(c.apiKeyFile).toContain("apikey-fastrouter.txt");
    expect(c.resultSuccessFile).toContain("akun-result-fastrouter.txt");
  });
  it("env overrides", () => {
    const c = loadConfig({
      WORKERS: "2",
      HEADLESS: "1",
      RETRY_FAILED: "true",
      INTER_ACCOUNT_DELAY_SEC: "45",
      FASTROUTER_APIKEY_FILE: "./somewhere/apikey-fastrouter.txt",
    } as NodeJS.ProcessEnv);
    expect(c.workers).toBe(2);
    expect(c.headless).toBe(true);
    expect(c.retryFailed).toBe(true);
    expect(c.interAccountDelaySec).toBe(45);
    expect(c.apiKeyFile.endsWith("apikey-fastrouter.txt")).toBe(true);
  });
  it("parseBool", () => {
    expect(parseBool("1", false)).toBe(true);
    expect(parseBool("no", true)).toBe(false);
    expect(parseBool(undefined, true)).toBe(true);
  });
});

describe("fastrouter loaders", () => {
  it("loadAccounts handles CRLF, comments and skips bad lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-u-"));
    const f = join(dir, "g.txt");
    writeFileSync(f, "a@x.com:pass1\r\n# comment\r\n\r\nb@y.com:pass:with:colons\r\nbadline\r\n");
    const accs = loadAccounts(f);
    expect(accs.map((a) => a.email)).toEqual(["a@x.com", "b@y.com"]);
    expect(accs[1]!.password).toBe("pass:with:colons");
    rmSync(dir, { recursive: true, force: true });
  });
  it("loadProxies parses plain and authenticated", () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-u-"));
    const f = join(dir, "p.txt");
    writeFileSync(f, "1.2.3.4:8080\nhttp://user:pass@5.6.7.8:3128\njunk\n");
    const ps = loadProxies(f);
    expect(ps.map((p) => p.server)).toEqual(["http://1.2.3.4:8080", "http://5.6.7.8:3128"]);
    rmSync(dir, { recursive: true, force: true });
  });
  it("empty/missing files are tolerated", () => {
    expect(loadAccounts("nope.txt")).toEqual([]);
    expect(loadProxies("nope.txt")).toEqual([]);
  });
});

describe("fastrouter selectors against dataset", () => {
  const datasetDir = join(import.meta.dir, "..", "..", "..", "fastrouter_ai_dataset");

  it("signUpGoogleButton matches signup.html", async () => {
    const html = readFileSync(join(datasetDir, "signup.html"), "utf8");
    const found: string[] = [];
    await new HTMLRewriter()
      .on(Selectors.signUpGoogleButton[0], {
        element(el) {
          found.push(el.getAttribute("aria-label") ?? "");
        },
      })
      .transform(new Response(html))
      .text();
    expect(found).toContain("Sign up with Google");
  });

  it("legal checkbox and submit match complete-signup.html", async () => {
    const html = readFileSync(join(datasetDir, "complete-signup.html"), "utf8");
    let legalCheckbox = 0;
    let submitBtn = 0;
    await new HTMLRewriter()
      .on(Selectors.completeSignupCheckbox, {
        element() {
          legalCheckbox++;
        },
      })
      .on(Selectors.completeSignupSubmitSelector, {
        element() {
          submitBtn++;
        },
      })
      .transform(new Response(html))
      .text();
    expect(legalCheckbox).toBe(1);
    expect(submitBtn).toBe(1);
    expect(html).toContain("Complete Sign Up");
  });

  it("welcome form inputs match welcome-after-signup.html", async () => {
    const html = readFileSync(join(datasetDir, "welcome-after-signup.html"), "utf8");
    let orgName = 0;
    let monthlySpend = 0;
    let submitBtn = 0;
    await new HTMLRewriter()
      .on(Selectors.welcomeOrgName, {
        element() {
          orgName++;
        },
      })
      .on(Selectors.welcomeMonthlySpend, {
        element() {
          monthlySpend++;
        },
      })
      .on(Selectors.welcomeSubmitSelector, {
        element() {
          submitBtn++;
        },
      })
      .transform(new Response(html))
      .text();
    expect(orgName).toBe(1);
    expect(monthlySpend).toBe(1);
    expect(submitBtn).toBe(1);
    expect(html).toContain("Continue to Dashboard");
  });

  it("dashboard key inputs, credit display, and key modal match dashboard-create-apikey-and-save.html", async () => {
    const html = readFileSync(join(datasetDir, "dashboard-create-apikey-and-save.html"), "utf8");
    let apiKeyName = 0;
    let creditEl = 0;
    await new HTMLRewriter()
      .on(Selectors.apiKeyName, {
        element() {
          apiKeyName++;
        },
      })
      .on(Selectors.creditsLink, {
        element() {
          creditEl++;
        },
      })
      .transform(new Response(html))
      .text();
    expect(apiKeyName).toBe(1);
    expect(creditEl).toBeGreaterThanOrEqual(1);

    // Credit bonus regex verification
    expect(Selectors.creditsBonus.test("Low credits, Available credits: 1.00")).toBe(true);
    expect(Selectors.creditsBonus.test("Available credits: 1.00")).toBe(true);
    expect(Selectors.creditsBonus.test("$1.00")).toBe(true);
    expect(Selectors.creditsBonus.test("Your credit balance is low.")).toBe(false);

    // Create User Key and Save button existence
    expect(html).toContain("Create User Key");
    expect(html).toContain("Save");
  });

  it("API_KEY_RE matches the real captured FastRouter key and rejects masked/truncated keys", () => {
    const realKey = "sk-v1-98b290acbaa48b1acc74546ff691f3265ffd5b2ab2592c6bbc150b4b56e9867c";
    expect(API_KEY_RE.test(realKey)).toBe(true);

    // Must reject masked keys from the table
    const masked1 = "sk-v1-98...67c";
    const masked2 = "sk-v1-1f...edf";
    expect(API_KEY_RE.test(masked1)).toBe(false);
    expect(API_KEY_RE.test(masked2)).toBe(false);

    // Must reject placeholders or too short tokens
    expect(API_KEY_RE.test("sk-v1-short")).toBe(false);
    expect(API_KEY_RE.test("<FASTROUTER_API_KEY>")).toBe(false);
  });

  it("email signup inputs and terms checkbox match signup.html", async () => {
    const html = readFileSync(join(datasetDir, "signup.html"), "utf8");
    let firstName = 0;
    let lastName = 0;
    let email = 0;
    let password = 0;
    let terms = 0;
    let submit = 0;

    await new HTMLRewriter()
      .on(Selectors.emailFirstName[0], { element() { firstName++; } })
      .on(Selectors.emailLastName[0], { element() { lastName++; } })
      .on(Selectors.emailAddressInput[0], { element() { email++; } })
      .on(Selectors.emailPasswordInput[0], { element() { password++; } })
      .on(Selectors.emailTermsCheckbox[0], { element() { terms++; } })
      .on(Selectors.emailSignupSubmit[0], { element() { submit++; } })
      .transform(new Response(html))
      .text();

    expect(firstName).toBe(1);
    expect(lastName).toBe(1);
    expect(email).toBe(1);
    expect(password).toBe(1);
    expect(terms).toBe(1);
    expect(submit).toBe(1);
  });

  it("email verification OTP input and submit match verif-email-tempmail.html", async () => {
    const html = readFileSync(join(datasetDir, "verif-email-tempmail.html"), "utf8");
    let otpInput = 0;
    let submitBtn = 0;

    await new HTMLRewriter()
      .on(Selectors.verifyOtpInput[0], { element() { otpInput++; } })
      .on('button[type="submit"]', { element() { submitBtn++; } })
      .transform(new Response(html))
      .text();

    expect(otpInput).toBe(1);
    expect(submitBtn).toBe(1);
    expect(html).toContain("Check your email");
    expect(html).toContain("Verify &amp; Continue");
  });

  it("OTP_CODE_RE matches 6-digit code and rejects non-6-digit strings", () => {
    expect(OTP_CODE_RE.test("797875")).toBe(true);
    expect(OTP_CODE_RE.test("000000")).toBe(true);
    expect(OTP_CODE_RE.test("12345")).toBe(false);
    expect(OTP_CODE_RE.test("1234567")).toBe(false);
    expect(OTP_CODE_RE.test("abcdef")).toBe(false);
  });
});

describe("fastrouter ResultWriter", () => {
  it("markSuccess appends to apikey-fastrouter.txt, apikey-fastrouter, and akun-result-fastrouter.txt", () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-res-"));
    const w = new ResultWriter(
      join(dir, "akun-result-fastrouter.txt"),
      join(dir, "akun-failed-fastrouter.txt"),
      join(dir, "apikey-fastrouter.txt"),
    );
    w.markSuccess("a@x.com", "sk-v1-98b290acbaa48b1acc74546ff691f3265ffd5b2ab2592c6bbc150b4b56e9867c");
    w.markSuccess("b@y.com", "sk-v1-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef");

    const keys = readFileSync(join(dir, "apikey-fastrouter.txt"), "utf8").split(/\r?\n/).filter(Boolean);
    expect(keys.length).toBe(2);
    expect(keys[0]).toBe("sk-v1-98b290acbaa48b1acc74546ff691f3265ffd5b2ab2592c6bbc150b4b56e9867c");

    // Also verified that extensionless apikey-fastrouter was written
    const keysAlt = readFileSync(join(dir, "apikey-fastrouter"), "utf8").split(/\r?\n/).filter(Boolean);
    expect(keysAlt).toEqual(keys);

    expect(w.getSuccessfulEmails()).toEqual(new Set(["a@x.com", "b@y.com"]));
    rmSync(dir, { recursive: true, force: true });
  });

  it("getPermanentlyFailedEmails filters by reason needle", () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-res-"));
    const w = new ResultWriter(join(dir, "r.txt"), join(dir, "f.txt"), join(dir, "k.txt"));
    w.markFailed("a@x.com", "ACCOUNT_RESTRICTED: banned");
    w.markFailed("b@y.com", "TIMEOUT: slow");
    expect(w.getPermanentlyFailedEmails("ACCOUNT_RESTRICTED")).toEqual(new Set(["a@x.com"]));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("fastrouter pace profiles & CLI", () => {
  it("config defaults to human and reads PACE", () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).pace).toBe("human");
    expect(loadConfig({ PACE: "fast" } as NodeJS.ProcessEnv).pace).toBe("fast");
    expect(loadConfig({ PACE: "turbo" } as NodeJS.ProcessEnv).pace).toBe("human");
  });
  it("--fast / --careful / --pace map onto the env", () => {
    expect(applyArgsToEnv(parseArgs(["--fast"]), {}).PACE).toBe("fast");
    expect(applyArgsToEnv(parseArgs(["--careful"]), {}).PACE).toBe("careful");
    expect(applyArgsToEnv(parseArgs(["--pace", "human"]), {}).PACE).toBe("human");
  });
  it("fast is quicker than human but still types like a person", () => {
    expect(PACES.fast.settleTimeoutMs).toBeLessThan(PACES.human.settleTimeoutMs);
    expect(PACES.fast.pauseMax).toBeLessThan(PACES.human.pauseMax);
    expect(PACES.fast.typeMin).toBeGreaterThanOrEqual(15);
    expect(PACES.fast.mouseMoves).toBeGreaterThan(0);
    expect(PACES.careful.pauseMin).toBeGreaterThan(PACES.human.pauseMin);
  });
  it("--auth / --tempmail / --domain / --limit map onto the env", () => {
    const env1 = applyArgsToEnv(parseArgs(["--tempmail", "--domain", "meongtopup.my.id", "--limit", "10"]), {});
    expect(env1.FASTROUTER_AUTH).toBe("tempmail");
    expect(env1.FASTROUTER_TEMPMAIL).toBe("1");
    expect(env1.TEMPMAIL_DOMAIN).toBe("meongtopup.my.id");
    expect(env1.LIMIT).toBe("10");

    const env2 = applyArgsToEnv(parseArgs(["--auth", "google"]), {});
    expect(env2.FASTROUTER_AUTH).toBe("google");
  });
});

