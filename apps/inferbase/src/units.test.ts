// ── Inferbase unit tests (config, loaders, selectors, store) ──
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseBool } from "./config.js";
import { applyArgsToEnv, parseArgs } from "./cli.js";
import { loadAccounts, loadProxies } from "./loaders.js";
import { ResultWriter, JsonlStore, FlowState } from "./store.js";
import { SELECTORS, API_KEY_RE, VERIFY_LINK_RE } from "./flow/selectors.js";

const datasetDir = join(process.cwd(), "inferbase-ai-dataset");

describe("inferbase config", () => {
  it("defaults", () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c.workers).toBe(1);
    expect(c.headless).toBe(true);
    expect(c.retryFailed).toBe(false);
    expect(c.interAccountDelaySec).toBe(2);
    expect(c.defaultPassword).toBe("torabikA1#");
    expect(c.tempMailApiKey).toBe("anjingmemekkontol");
    expect(c.tempMailDomain).toBe("ifqy.net");
    expect(c.authMethod).toBe("tempmail");
    expect(c.apiKeyFile).toContain("apikey-inferbase.txt");
    expect(c.resultSuccessFile).toContain("akun-result-inferbase.txt");
  });

  it("env overrides", () => {
    const c = loadConfig({
      WORKERS: "3",
      HEADLESS: "0",
      RETRY_FAILED: "true",
      INTER_ACCOUNT_DELAY_SEC: "10",
      INFERBASE_PASSWORD: "CustomPassword123!",
      TEMPMAIL_DOMAIN: "meongtopup.my.id",
      INFERBASE_AUTH: "google",
    } as NodeJS.ProcessEnv);
    expect(c.workers).toBe(3);
    expect(c.headless).toBe(false);
    expect(c.retryFailed).toBe(true);
    expect(c.interAccountDelaySec).toBe(10);
    expect(c.defaultPassword).toBe("CustomPassword123!");
    expect(c.tempMailDomain).toBe("meongtopup.my.id");
    expect(c.authMethod).toBe("google");
  });

  it("parseBool handles various representations", () => {
    expect(parseBool("1", false)).toBe(true);
    expect(parseBool("true", false)).toBe(true);
    expect(parseBool("yes", false)).toBe(true);
    expect(parseBool("0", true)).toBe(false);
    expect(parseBool("false", true)).toBe(false);
    expect(parseBool(undefined, true)).toBe(true);
  });
});

describe("inferbase loaders", () => {
  it("loadAccounts handles comments, bad lines and separators", () => {
    const dir = mkdtempSync(join(tmpdir(), "ib-u-"));
    const f = join(dir, "accounts.txt");
    writeFileSync(f, "a@ifqy.net:pass1\r\n# comment\r\nb@ifqy.net,pass2,recovery@gmail.com\r\ninvalid\n");
    const accs = loadAccounts(f);
    expect(accs.length).toBe(2);
    expect(accs[0]!.email).toBe("a@ifqy.net");
    expect(accs[0]!.password).toBe("pass1");
    expect(accs[1]!.email).toBe("b@ifqy.net");
    expect(accs[1]!.recoveryEmail).toBe("recovery@gmail.com");
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadProxies filters comments and blank lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "ib-u-"));
    const f = join(dir, "proxies.txt");
    writeFileSync(f, "http://1.2.3.4:8080\n\n# local proxy\nhttp://5.6.7.8:3128\n");
    const p = loadProxies(f);
    expect(p).toEqual(["http://1.2.3.4:8080", "http://5.6.7.8:3128"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("inferbase selectors against dataset", () => {
  it("signup form elements match signup.html", async () => {
    if (!existsSync(join(datasetDir, "signup.html"))) return;
    const html = readFileSync(join(datasetDir, "signup.html"), "utf8");

    let emailFound = false;
    let fullNameFound = false;
    let companyFound = false;
    let passFound = false;
    let confirmPassFound = false;
    let submitFound = false;
    let googleFound = false;

    await new HTMLRewriter()
      .on('input#email, input[name="email"]', {
        element() {
          emailFound = true;
        },
      })
      .on('input#full_name, input[name="full_name"]', {
        element() {
          fullNameFound = true;
        },
      })
      .on('input#company, input[name="company"]', {
        element() {
          companyFound = true;
        },
      })
      .on('input#password, input[name="password"]', {
        element() {
          passFound = true;
        },
      })
      .on('input#confirmPassword, input[name="confirmPassword"]', {
        element() {
          confirmPassFound = true;
        },
      })
      .on('button[type="submit"]', {
        element() {
          submitFound = true;
        },
      })
      .on('a[href*="/auth/google/start"]', {
        element() {
          googleFound = true;
        },
      })
      .transform(new Response(html))
      .text();

    expect(emailFound).toBe(true);
    expect(fullNameFound).toBe(true);
    expect(companyFound).toBe(true);
    expect(passFound).toBe(true);
    expect(confirmPassFound).toBe(true);
    expect(submitFound).toBe(true);
    expect(googleFound).toBe(true);
  });

  it("email verification page elements match email-verification-page.html", async () => {
    if (!existsSync(join(datasetDir, "email-verification-page.html"))) return;
    const html = readFileSync(join(datasetDir, "email-verification-page.html"), "utf8");

    let playgroundLink = false;
    await new HTMLRewriter()
      .on('a[href="/playground"]', {
        element() {
          playgroundLink = true;
        },
      })
      .transform(new Response(html))
      .text();

    expect(playgroundLink).toBe(true);
    expect(html).toContain("Email verified");
    expect(html).toContain("Go to Playground");
  });

  it("onboarding steps match onboarding.html, after-klik-get-started, and after-klik-all-skip", () => {
    if (!existsSync(join(datasetDir, "onboarding.html"))) return;
    const obHtml = readFileSync(join(datasetDir, "onboarding.html"), "utf8");
    expect(obHtml).toContain("Get started");

    if (existsSync(join(datasetDir, "after-klik-get-started-onboarding.html"))) {
      const skipHtml = readFileSync(join(datasetDir, "after-klik-get-started-onboarding.html"), "utf8");
      expect(skipHtml).toContain("Skip");
    }

    if (existsSync(join(datasetDir, "after-klik-all-skip-step-your-account-page-render.html"))) {
      const dashHtml = readFileSync(join(datasetDir, "after-klik-all-skip-step-your-account-page-render.html"), "utf8");
      expect(dashHtml).toContain("Go to Dashboard");
    }
  });

  it("api key inputs and buttons match apikey.html, create-apikey-popup-modal.html, and apikey-appear.html", async () => {
    if (!existsSync(join(datasetDir, "apikey.html"))) return;
    const html = readFileSync(join(datasetDir, "apikey.html"), "utf8");
    expect(html).toContain("Create key");

    if (existsSync(join(datasetDir, "create-apikey-popup-modal.html"))) {
      const modalHtml = readFileSync(join(datasetDir, "create-apikey-popup-modal.html"), "utf8");
      expect(modalHtml).toContain('id="key-name"');
      expect(modalHtml).toContain("Create key");
    }

    if (existsSync(join(datasetDir, "apikey-appear.html"))) {
      const appearHtml = readFileSync(join(datasetDir, "apikey-appear.html"), "utf8");
      expect(appearHtml).toContain("Done");
      const match = appearHtml.match(API_KEY_RE);
      expect(match).not.toBeNull();
      expect(match![0]).toBe("inf_LDGfZZsDgy_vpP5275Q4jl2FsWmhO2kPCT5MSdCgAJYxXgGj");
    }
  });

  it("VERIFY_LINK_RE matches sample verification link from link.txt", () => {
    const sampleLink = "https://inferbase.ai/verify-email?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJiZGRkMGQxMS1iMDhlLTRkNDEtYWMzMS0yY2Q2N2IyNTA5NGEiLCJ0eXBlIjoiZW1haWxfdmVyaWZ5IiwiZW1haWwiOiJhbGFAaHV6dC5teS5pZCIsImV4cCI6MTc5MjIyMzgxMX0.bRiPQ4e_bHt5vGt8cSt4lt5Su-megWRad3apnVD1gik";
    const match = sampleLink.match(VERIFY_LINK_RE);
    expect(match).not.toBeNull();
    expect(match![0]).toBe(sampleLink);
  });
});

describe("inferbase ResultWriter and JsonlStore", () => {
  it("ResultWriter records successes and failures correctly", () => {
    const dir = mkdtempSync(join(tmpdir(), "ib-store-"));
    const successFile = join(dir, "success.txt");
    const failedFile = join(dir, "failed.txt");
    const keyFile = join(dir, "keys.txt");

    const rw = new ResultWriter(successFile, failedFile, keyFile);
    rw.markSuccess("a@ifqy.net", "pass123", "inf_1234567890123456789012345");
    rw.markFailed("b@ifqy.net", "Network error");

    expect(rw.getSuccessfulEmails().has("a@ifqy.net")).toBe(true);
    expect(rw.getFailedEmails().has("b@ifqy.net")).toBe(true);

    const keyContent = readFileSync(keyFile, "utf8");
    expect(keyContent.trim()).toBe("inf_1234567890123456789012345");

    rmSync(dir, { recursive: true, force: true });
  });

  it("JsonlStore persists state transitions and replays on reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "ib-store-"));
    const stateFile = join(dir, "state.jsonl");

    const store1 = new JsonlStore(stateFile);
    store1.upsert({ email: "user@ifqy.net", status: FlowState.PENDING, updatedAt: Date.now() });
    store1.setStatus("user@ifqy.net", FlowState.EMAIL_VERIFIED);

    const store2 = new JsonlStore(stateFile);
    expect(store2.get("user@ifqy.net")?.status).toBe(FlowState.EMAIL_VERIFIED);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("inferbase CLI flags", () => {
  it("parses CLI flags and applies to env", () => {
    const argv = ["--engine", "python", "--headed", "--limit", "5", "--delay", "3", "--password", "Secret123!", "--domain", "meongtopup.my.id", "--auth", "google"];
    const parsed = parseArgs(argv);
    expect(parsed.engine).toBe("python");
    expect(parsed.headless).toBe(false);
    expect(parsed.limit).toBe(5);
    expect(parsed.delaySec).toBe(3);
    expect(parsed.password).toBe("Secret123!");
    expect(parsed.domain).toBe("meongtopup.my.id");
    expect(parsed.auth).toBe("google");

    const env = applyArgsToEnv(parsed, {});
    expect(env.BROWSER_ENGINE).toBe("python");
    expect(env.HEADLESS).toBe("0");
    expect(env.LIMIT).toBe("5");
    expect(env.INTER_ACCOUNT_DELAY_SEC).toBe("3");
    expect(env.INFERBASE_PASSWORD).toBe("Secret123!");
    expect(env.TEMPMAIL_DOMAIN).toBe("meongtopup.my.id");
    expect(env.INFERBASE_AUTH).toBe("google");
  });
});
