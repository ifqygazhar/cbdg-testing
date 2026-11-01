// ── Zro MoonMath unit tests (config, loaders, selectors, store) ─────
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseBool } from "./config.js";
import { applyArgsToEnv, parseArgs } from "./cli.js";
import { loadAccounts, loadProxies } from "./loaders.js";
import { ResultWriter, JsonlStore, FlowState } from "./store.js";
import { SELECTORS, API_KEY_RE, OTP_CODE_RE } from "./flow/selectors.js";
import { getUniqueAccountFingerprint } from "./runner.js";

const datasetDir = join(process.cwd(), "zromoonshotai-dataset");

describe("zromoonmath config", () => {
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
    expect(c.apiKeyFile).toContain("apikey-zro.txt");
    expect(c.resultSuccessFile).toContain("akun-result-zro.txt");
  });

  it("env overrides", () => {
    const c = loadConfig({
      WORKERS: "4",
      HEADLESS: "0",
      RETRY_FAILED: "true",
      INTER_ACCOUNT_DELAY_SEC: "5",
      ZRO_PASSWORD: "CustomPasswordZro!",
      TEMPMAIL_DOMAIN: "meongtopup.my.id",
      ZRO_AUTH: "google",
    } as NodeJS.ProcessEnv);
    expect(c.workers).toBe(4);
    expect(c.headless).toBe(false);
    expect(c.retryFailed).toBe(true);
    expect(c.interAccountDelaySec).toBe(5);
    expect(c.defaultPassword).toBe("CustomPasswordZro!");
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

describe("zromoonmath loaders", () => {
  it("loadAccounts handles comments, blanks and delimiters", () => {
    const dir = mkdtempSync(join(tmpdir(), "zro-u-"));
    const f = join(dir, "accounts.txt");
    writeFileSync(f, "user1@ifqy.net:pass1\r\n# comment\r\nuser2@ifqy.net,pass2,recovery@gmail.com\r\ninvalid\n");
    const accs = loadAccounts(f);
    expect(accs.length).toBe(2);
    expect(accs[0]!.email).toBe("user1@ifqy.net");
    expect(accs[0]!.password).toBe("pass1");
    expect(accs[1]!.email).toBe("user2@ifqy.net");
    expect(accs[1]!.recoveryEmail).toBe("recovery@gmail.com");
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadProxies filters comments and blank lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "zro-u-"));
    const f = join(dir, "proxies.txt");
    writeFileSync(f, "http://1.2.3.4:8080\n\n# local proxy\nhttp://5.6.7.8:3128\n");
    const p = loadProxies(f);
    expect(p).toEqual(["http://1.2.3.4:8080", "http://5.6.7.8:3128"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("zromoonmath selectors against dataset", () => {
  it("signup elements match zromoonshotai-dataset/signup.html", async () => {
    if (!existsSync(join(datasetDir, "signup.html"))) return;
    const html = readFileSync(join(datasetDir, "signup.html"), "utf8");

    let emailFound = false;
    let submitFound = false;
    let googleFound = false;

    await new HTMLRewriter()
      .on('input[name="identifier"]', {
        element() {
          emailFound = true;
        },
      })
      .on("button.cl-formButtonPrimary", {
        element() {
          submitFound = true;
        },
      })
      .on("button.cl-socialButtonsBlockButton", {
        element() {
          googleFound = true;
        },
      })
      .transform(new Response(html))
      .text();

    expect(emailFound).toBe(true);
    expect(submitFound).toBe(true);
    expect(googleFound).toBe(true);
  });

  it("otp verification elements match zromoonshotai-dataset/verifyemail.html", async () => {
    if (!existsSync(join(datasetDir, "verifyemail.html"))) return;
    const html = readFileSync(join(datasetDir, "verifyemail.html"), "utf8");

    let otpInputFound = false;
    let submitFound = false;

    await new HTMLRewriter()
      .on('input[data-input-otp="true"]', {
        element() {
          otpInputFound = true;
        },
      })
      .on("button.cl-formButtonPrimary", {
        element() {
          submitFound = true;
        },
      })
      .transform(new Response(html))
      .text();

    expect(otpInputFound).toBe(true);
    expect(submitFound).toBe(true);
    expect(html).toContain("Verify your email");
  });

  it("legal consent elements match zromoonshotai-dataset/legal-consent.html", async () => {
    if (!existsSync(join(datasetDir, "legal-consent.html"))) return;
    const html = readFileSync(join(datasetDir, "legal-consent.html"), "utf8");

    let legalCbFound = false;
    let submitFound = false;

    await new HTMLRewriter()
      .on('input[name="legalAccepted"]', {
        element() {
          legalCbFound = true;
        },
      })
      .on("button.cl-formButtonPrimary", {
        element() {
          submitFound = true;
        },
      })
      .transform(new Response(html))
      .text();

    expect(legalCbFound).toBe(true);
    expect(submitFound).toBe(true);
  });

  it("sample email contains valid 6-digit verification code", () => {
    if (!existsSync(join(datasetDir, "sample-email-receive.html"))) return;
    const html = readFileSync(join(datasetDir, "sample-email-receive.html"), "utf8");
    const m = html.match(OTP_CODE_RE);
    expect(m).not.toBeNull();
    expect(m![0]).toBe("315401");
  });

  it("api keys and popup elements match apikey.html and popup-apikey.html", () => {
    if (existsSync(join(datasetDir, "apikey.html"))) {
      const html = readFileSync(join(datasetDir, "apikey.html"), "utf8");
      expect(html).toContain("Create key");
      expect(html).toContain("API Keys");
    }

    if (existsSync(join(datasetDir, "popup-apikey.html"))) {
      const modalHtml = readFileSync(join(datasetDir, "popup-apikey.html"), "utf8");
      expect(modalHtml).toContain('id="api-key-alias"');
      expect(modalHtml).toContain("Create");
    }
  });

  it("extracted key matches apikey-success.html and API_KEY_RE", () => {
    if (existsSync(join(datasetDir, "apikey-success.html"))) {
      const html = readFileSync(join(datasetDir, "apikey-success.html"), "utf8");
      expect(html).toContain("Copy key");
      expect(html).toContain("Done");

      const match = html.match(API_KEY_RE);
      expect(match).not.toBeNull();
      expect(match![0]).toBe("sk-TxXV7OKx4EiIZ__EwOc_yQ");
    }
  });
});

describe("zromoonmath ResultWriter and JsonlStore", () => {
  it("ResultWriter records successes and failures correctly", () => {
    const dir = mkdtempSync(join(tmpdir(), "zro-store-"));
    const successFile = join(dir, "success.txt");
    const failedFile = join(dir, "failed.txt");
    const keyFile = join(dir, "keys.txt");

    const rw = new ResultWriter(successFile, failedFile, keyFile);
    rw.markSuccess("test@ifqy.net", "pass123", "sk-TxXV7OKx4EiIZ__EwOc_yQ");
    rw.markFailed("bad@ifqy.net", "Timeout error");

    expect(rw.getSuccessfulEmails().has("test@ifqy.net")).toBe(true);
    expect(rw.getFailedEmails().has("bad@ifqy.net")).toBe(true);

    const keyContent = readFileSync(keyFile, "utf8");
    expect(keyContent.trim()).toBe("sk-TxXV7OKx4EiIZ__EwOc_yQ");

    rmSync(dir, { recursive: true, force: true });
  });

  it("JsonlStore persists state transitions and replays on reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "zro-store-"));
    const stateFile = join(dir, "state.jsonl");

    const store1 = new JsonlStore(stateFile);
    store1.upsert({ email: "user@ifqy.net", status: FlowState.PENDING, updatedAt: Date.now() });
    store1.setStatus("user@ifqy.net", FlowState.EMAIL_VERIFIED);

    const store2 = new JsonlStore(stateFile);
    expect(store2.get("user@ifqy.net")?.status).toBe(FlowState.EMAIL_VERIFIED);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("zromoonmath CLI flags", () => {
  it("parses CLI flags and applies to env", () => {
    const argv = [
      "--engine",
      "python",
      "--headed",
      "--limit",
      "7",
      "--delay",
      "4",
      "--password",
      "SecretZro123!",
      "--domain",
      "meongtopup.my.id",
      "--auth",
      "google",
    ];
    const parsed = parseArgs(argv);
    expect(parsed.engine).toBe("python");
    expect(parsed.headless).toBe(false);
    expect(parsed.limit).toBe(7);
    expect(parsed.delaySec).toBe(4);
    expect(parsed.password).toBe("SecretZro123!");
    expect(parsed.domain).toBe("meongtopup.my.id");
    expect(parsed.auth).toBe("google");

    const env = applyArgsToEnv(parsed, {});
    expect(env.BROWSER_ENGINE).toBe("python");
    expect(env.HEADLESS).toBe("0");
    expect(env.LIMIT).toBe("7");
    expect(env.INTER_ACCOUNT_DELAY_SEC).toBe("4");
    expect(env.ZRO_PASSWORD).toBe("SecretZro123!");
    expect(env.TEMPMAIL_DOMAIN).toBe("meongtopup.my.id");
    expect(env.ZRO_AUTH).toBe("google");
  });
});

describe("zromoonmath fingerprinting", () => {
  it("generates distinct fingerprints for consecutive accounts", () => {
    const fp1 = getUniqueAccountFingerprint();
    const fp2 = getUniqueAccountFingerprint();
    const fp3 = getUniqueAccountFingerprint();

    expect(fp1.hash).not.toBe(fp2.hash);
    expect(fp2.hash).not.toBe(fp3.hash);

    // Verify properties
    expect(fp1.viewport.width).toBeGreaterThanOrEqual(1000);
    expect(fp1.viewport.height).toBeGreaterThanOrEqual(600);
    expect(fp1.cores).toBeGreaterThanOrEqual(4);
    expect(fp1.memory).toBeGreaterThanOrEqual(4);
    expect(fp1.userAgent).toContain("Mozilla/5.0");

    // Rotating OS sequences across accounts
    const osSet = new Set([fp1.os, fp2.os, fp3.os]);
    expect(osSet.size).toBeGreaterThanOrEqual(2);
  });
});
