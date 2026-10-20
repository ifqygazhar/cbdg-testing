// ── OpenRouter unit tests (config, loaders, selectors, store) ──
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseBool } from "./config.js";
import { applyArgsToEnv, parseArgs } from "./cli.js";
import { loadAccounts, loadProxies } from "./loaders.js";
import { ResultWriter, JsonlStore, FlowState } from "./store.js";
import { SELECTORS, API_KEY_RE, VERIFY_LINK_RE } from "./flow/selectors.js";

const datasetDir = join(process.cwd(), "openrouter-dataset");

describe("openrouter config", () => {
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
    expect(c.apiKeyFile).toContain("apikey-openrouter.txt");
    expect(c.resultSuccessFile).toContain("akun-result-openrouter.txt");
  });

  it("env overrides", () => {
    const c = loadConfig({
      WORKERS: "3",
      HEADLESS: "0",
      RETRY_FAILED: "true",
      INTER_ACCOUNT_DELAY_SEC: "10",
      OPENROUTER_PASSWORD: "CustomPassword123!",
      TEMPMAIL_DOMAIN: "meongtopup.my.id",
      OPENROUTER_AUTH: "google",
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

describe("openrouter loaders", () => {
  it("loadAccounts handles comments, bad lines and separators", () => {
    const dir = mkdtempSync(join(tmpdir(), "or-u-"));
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
    const dir = mkdtempSync(join(tmpdir(), "or-u-"));
    const f = join(dir, "proxies.txt");
    writeFileSync(f, "http://1.2.3.4:8080\n\n# local proxy\nhttp://5.6.7.8:3128\n");
    const p = loadProxies(f);
    expect(p).toEqual(["http://1.2.3.4:8080", "http://5.6.7.8:3128"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("openrouter selectors against dataset", () => {
  it("signup Clerk form elements match signup.html", async () => {
    if (!existsSync(join(datasetDir, "signup.html"))) return;
    const html = readFileSync(join(datasetDir, "signup.html"), "utf8");

    let emailFound = false;
    let passFound = false;
    let submitFound = false;
    let googleFound = false;

    await new HTMLRewriter()
      .on('input[name="emailAddress"]', {
        element() {
          emailFound = true;
        },
      })
      .on('input[name="password"]', {
        element() {
          passFound = true;
        },
      })
      .on('button.cl-formButtonPrimary', {
        element() {
          submitFound = true;
        },
      })
      .on('button.cl-socialButtonsIconButton__google', {
        element() {
          googleFound = true;
        },
      })
      .transform(new Response(html))
      .text();

    expect(emailFound).toBe(true);
    expect(passFound).toBe(true);
    expect(submitFound).toBe(true);
    expect(googleFound).toBe(true);
  });

  it("onboarding steps match onboarding.html, selection.html, payment-method.html, youareallset.html", () => {
    if (existsSync(join(datasetDir, "onboarding.html"))) {
      const obHtml = readFileSync(join(datasetDir, "onboarding.html"), "utf8");
      expect(obHtml).toContain("Next");
    }

    if (existsSync(join(datasetDir, "selection.html"))) {
      const selHtml = readFileSync(join(datasetDir, "selection.html"), "utf8");
      expect(selHtml).toContain("Continue");
      expect(selHtml).toContain("Where did you first hear about OpenRouter?");
    }

    if (existsSync(join(datasetDir, "payment-method.html"))) {
      const payHtml = readFileSync(join(datasetDir, "payment-method.html"), "utf8");
      expect(payHtml).toContain("I'll do this later");
    }

    if (existsSync(join(datasetDir, "youareallset.html"))) {
      const setHtml = readFileSync(join(datasetDir, "youareallset.html"), "utf8");
      expect(setHtml).toContain("Get API Key");
    }
  });

  it("api key inputs, dropdowns and buttons match apikey files", async () => {
    if (existsSync(join(datasetDir, "apikey", "apikey.html"))) {
      const html = readFileSync(join(datasetDir, "apikey", "apikey.html"), "utf8");
      expect(html).toContain("Create API Key");
    }

    if (existsSync(join(datasetDir, "apikey", "apikey-popup-input.html"))) {
      const modalHtml = readFileSync(join(datasetDir, "apikey", "apikey-popup-input.html"), "utf8");
      expect(modalHtml).toContain('id="name"');
      expect(modalHtml).toContain("Create");
      expect(modalHtml).toContain("Select expiration");
      expect(modalHtml).toContain("Choose a credit limit");
    }

    if (existsSync(join(datasetDir, "apikey", "verification-apikey.html"))) {
      const verifHtml = readFileSync(join(datasetDir, "apikey", "verification-apikey.html"), "utf8");
      expect(verifHtml).toContain('data-input-otp="true"');
      expect(verifHtml).toContain("Verification required");
      expect(verifHtml).toContain("Continue");
    }

    if (existsSync(join(datasetDir, "apikey", "apikey-appear.html"))) {
      const appearHtml = readFileSync(join(datasetDir, "apikey", "apikey-appear.html"), "utf8");
      expect(appearHtml).toContain("Copy key to clipboard");
      expect(appearHtml).toContain("onepassword-save-button");
      expect(appearHtml).toContain("Close");

      // Check onepassword-save-button base64 decoding
      const m = appearHtml.match(/<onepassword-save-button[^>]*value="([^"]+)"/);
      expect(m).not.toBeNull();
      const decoded = Buffer.from(m![1]!, "base64").toString("utf8");
      const keyMatch = decoded.match(API_KEY_RE);
      expect(keyMatch).not.toBeNull();
      expect(keyMatch![0]).toBe("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");
    }
  });

  it("VERIFY_LINK_RE matches sample verification link from signup-link-openrouter.html", () => {
    if (existsSync(join(datasetDir, "signup-link-openrouter.html"))) {
      const html = readFileSync(join(datasetDir, "signup-link-openrouter.html"), "utf8");
      const match = html.match(VERIFY_LINK_RE);
      expect(match).not.toBeNull();
      expect(match![0]).toContain("https://clerk.openrouter.ai/v1/verify?__clerk_api_version=");
    }
  });
});

describe("openrouter ResultWriter and JsonlStore", () => {
  it("ResultWriter records successes and failures correctly", () => {
    const dir = mkdtempSync(join(tmpdir(), "or-store-"));
    const successFile = join(dir, "success.txt");
    const failedFile = join(dir, "failed.txt");
    const keyFile = join(dir, "keys.txt");

    const rw = new ResultWriter(successFile, failedFile, keyFile);
    rw.markSuccess("a@ifqy.net", "pass123", "sk-or-v1-12345678901234567890123456789012");
    rw.markFailed("b@ifqy.net", "Network error");

    expect(rw.getSuccessfulEmails().has("a@ifqy.net")).toBe(true);
    expect(rw.getFailedEmails().has("b@ifqy.net")).toBe(true);

    const keyContent = readFileSync(keyFile, "utf8");
    expect(keyContent.trim()).toBe("sk-or-v1-12345678901234567890123456789012");

    rmSync(dir, { recursive: true, force: true });
  });

  it("JsonlStore persists state transitions and replays on reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "or-store-"));
    const stateFile = join(dir, "state.jsonl");

    const store1 = new JsonlStore(stateFile);
    store1.upsert({ email: "user@ifqy.net", status: FlowState.PENDING, updatedAt: Date.now() });
    store1.setStatus("user@ifqy.net", FlowState.EMAIL_VERIFIED);

    const store2 = new JsonlStore(stateFile);
    expect(store2.get("user@ifqy.net")?.status).toBe(FlowState.EMAIL_VERIFIED);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("openrouter CLI flags", () => {
  it("parses CLI flags and applies to env", () => {
    const argv = [
      "--engine",
      "python",
      "--headed",
      "--limit",
      "5",
      "--delay",
      "3",
      "--password",
      "Secret123!",
      "--domain",
      "meongtopup.my.id",
      "--auth",
      "google",
    ];
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
    expect(env.OPENROUTER_PASSWORD).toBe("Secret123!");
    expect(env.TEMPMAIL_DOMAIN).toBe("meongtopup.my.id");
    expect(env.OPENROUTER_AUTH).toBe("google");
  });
});
