// ── ChatGPT unit tests (config, loaders, selectors, store, helpers) ──
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseBool } from "./config.js";
import { applyArgsToEnv, parseArgs } from "./cli.js";
import { loadAccounts, loadProxies } from "./loaders.js";
import { ResultWriter, JsonlStore, FlowState } from "./store.js";
import { SELECTORS, OTP_CODE_RE, extractGptOtp } from "./flow/selectors.js";
import { getUniqueAccountFingerprint } from "./runner.js";
import { generateRandomName, generateRandomAge, getRandomPrompt } from "./flow/steps.js";

const datasetDir = join(process.cwd(), "gpt-dataset");

describe("gpt config", () => {
  it("defaults", () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c.workers).toBe(1);
    expect(c.headless).toBe(true);
    expect(c.retryFailed).toBe(false);
    expect(c.interAccountDelaySec).toBe(2);
    expect(c.defaultPassword).toBe("torabikA1###########");
    expect(c.tempMailApiKey).toBe("anjingmemekkontol");
    expect(c.tempMailDomain).toBe("ifqy.net");
    expect(c.authMethod).toBe("tempmail");
    expect(c.resultSuccessFile).toContain("akun-gpt.txt");
    expect(c.resultFailedFile).toContain("akun-gpt-failed.txt");
  });

  it("env overrides", () => {
    const c = loadConfig({
      WORKERS: "4",
      HEADLESS: "0",
      RETRY_FAILED: "true",
      INTER_ACCOUNT_DELAY_SEC: "5",
      GPT_PASSWORD: "CustomPasswordGpt!",
      TEMPMAIL_DOMAIN: "meongtopup.my.id",
      GPT_AUTH: "google",
    } as NodeJS.ProcessEnv);
    expect(c.workers).toBe(4);
    expect(c.headless).toBe(false);
    expect(c.retryFailed).toBe(true);
    expect(c.interAccountDelaySec).toBe(5);
    expect(c.defaultPassword).toBe("CustomPasswordGpt!");
    expect(c.tempMailDomain).toBe("meongtopup.my.id");
    expect(c.authMethod).toBe("google");
  });

  it("parseBool handles representations accurately", () => {
    expect(parseBool("1", false)).toBe(true);
    expect(parseBool("true", false)).toBe(true);
    expect(parseBool("yes", false)).toBe(true);
    expect(parseBool("0", true)).toBe(false);
    expect(parseBool("false", true)).toBe(false);
    expect(parseBool(undefined, true)).toBe(true);
  });
});

describe("gpt loaders", () => {
  it("loadAccounts handles comments, blanks and delimiters", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpt-test-"));
    const p = join(dir, "acc.txt");
    writeFileSync(p, "# comment\n\nuser1@ifqy.net:pass1\nuser2@ifqy.net,pass2,recovery@ifqy.net\n// other comment\n");
    const res = loadAccounts(p);
    expect(res.length).toBe(2);
    expect(res[0].email).toBe("user1@ifqy.net");
    expect(res[0].password).toBe("pass1");
    expect(res[1].email).toBe("user2@ifqy.net");
    expect(res[1].recoveryEmail).toBe("recovery@ifqy.net");
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadProxies filters blanks and comments", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpt-test-"));
    const p = join(dir, "proxy.txt");
    writeFileSync(p, "# comment\nhttp://user:pass@1.2.3.4:8000\n\nsocks5://5.6.7.8:1080\n");
    const res = loadProxies(p);
    expect(res.length).toBe(2);
    expect(res[0]).toBe("http://user:pass@1.2.3.4:8000");
    expect(res[1]).toBe("socks5://5.6.7.8:1080");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("gpt store & result writer", () => {
  it("records success and prevents duplicate registrations", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpt-test-"));
    const sFile = join(dir, "akun-gpt.txt");
    const fFile = join(dir, "akun-gpt-failed.txt");

    const w = new ResultWriter(sFile, fFile);
    w.recordSuccess("user1@ifqy.net", "torabikA1###########");

    expect(w.getSuccessfulEmails().has("user1@ifqy.net")).toBe(true);
    const content = readFileSync(sFile, "utf-8");
    expect(content.trim()).toBe("user1@ifqy.net:torabikA1###########");

    // Re-instantiate to test idempotency load
    const w2 = new ResultWriter(sFile, fFile);
    expect(w2.getSuccessfulEmails().has("user1@ifqy.net")).toBe(true);

    w.recordFailed("failed@ifqy.net", "Turnstile timeout", "torabikA1###########");
    const fContent = readFileSync(fFile, "utf-8");
    expect(fContent).toContain("failed@ifqy.net:torabikA1########### | Turnstile timeout");

    rmSync(dir, { recursive: true, force: true });
  });

  it("jsonl store handles upsert and get", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpt-test-"));
    const stFile = join(dir, "state-gpt.jsonl");

    const store = new JsonlStore(stFile);
    store.upsert({
      email: "test@ifqy.net",
      status: FlowState.PENDING,
      updatedAt: Date.now(),
    });

    expect(store.get("test@ifqy.net")?.status).toBe(FlowState.PENDING);

    store.upsert({
      email: "test@ifqy.net",
      status: FlowState.DONE,
      updatedAt: Date.now(),
    });

    expect(store.get("test@ifqy.net")?.status).toBe(FlowState.DONE);

    const store2 = new JsonlStore(stFile);
    expect(store2.get("test@ifqy.net")?.status).toBe(FlowState.DONE);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("gpt flow helpers & dataset validation", () => {
  it("generateRandomAge returns age strictly > 20", () => {
    for (let i = 0; i < 50; i++) {
      const age = generateRandomAge();
      expect(age).toBeGreaterThan(20);
      expect(age).toBeLessThanOrEqual(40);
    }
  });

  it("generateRandomName returns non-empty full name", () => {
    const name = generateRandomName();
    expect(name.split(" ").length).toBeGreaterThanOrEqual(2);
  });

  it("getRandomPrompt returns valid prompt string", () => {
    const prompt = getRandomPrompt();
    expect(prompt.length).toBeGreaterThan(5);
  });

  it("matches OTP code from sample email dataset using extractGptOtp", () => {
    const sampleEmailPath = join(datasetDir, "sample-otp-email-gpt.html");
    if (existsSync(sampleEmailPath)) {
      const html = readFileSync(sampleEmailPath, "utf-8");
      const otp = extractGptOtp(html);
      expect(otp).toBe("287769");
    }

    // Also test real email content with large whitespace gaps
    const rawRealEmail = `
      Enter this temporary verification code to continue:
      \n\n\n\n\n
      590469
      \n\n\n
      Please ignore this email if this wasn't you.
    `;
    expect(extractGptOtp(rawRealEmail)).toBe("590469");
  });

  it("getUniqueAccountFingerprint produces valid randomized profiles", () => {
    const fp1 = getUniqueAccountFingerprint();
    const fp2 = getUniqueAccountFingerprint();
    expect(fp1.width).toBeGreaterThanOrEqual(1024);
    expect(fp1.height).toBeGreaterThanOrEqual(700);
    expect(fp1.userAgent).toContain("Mozilla/5.0");
  });
});

describe("gpt CLI parser", () => {
  it("parses CLI flags", () => {
    const args = parseArgs(["--headed", "-w", "3", "--limit", "10", "--password", "Pass123!", "--domain", "@meongtopup.my.id"]);
    expect(args.headless).toBe(false);
    expect(args.workers).toBe(3);
    expect(args.limit).toBe(10);
    expect(args.password).toBe("Pass123!");
    expect(args.domain).toBe("meongtopup.my.id");

    const args2 = parseArgs(["--domain=meongtopup.my.id"]);
    expect(args2.domain).toBe("meongtopup.my.id");
  });

  it("merges CLI args into env", () => {
    const args = { workers: 5, headless: true, password: "SecretPassword" };
    const env = applyArgsToEnv(args, {});
    expect(env.WORKERS).toBe("5");
    expect(env.HEADLESS).toBe("1");
    expect(env.GPT_PASSWORD).toBe("SecretPassword");
  });
});
