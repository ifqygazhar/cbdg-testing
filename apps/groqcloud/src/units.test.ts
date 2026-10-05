// ── GroqCloud unit tests (config, loaders, selectors, store) ─────────
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseBool } from "./config.js";
import { applyArgsToEnv, parseArgs } from "./cli.js";
import { loadAccounts, loadProxies } from "./loaders.js";
import { ResultWriter, JsonlStore, FlowState } from "./store.js";
import { SELECTORS, API_KEY_RE, MAGIC_LINK_RE } from "./flow/selectors.js";

const datasetDir = join(process.cwd(), "groqcloud-dataset");

describe("groqcloud config", () => {
  it("defaults", () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c.workers).toBe(1);
    expect(c.headless).toBe(true);
    expect(c.retryFailed).toBe(false);
    expect(c.interAccountDelaySec).toBe(2);
    expect(c.defaultPassword).toBe("torabikA1###########");
    expect(c.tempMailApiKey).toBe("anjingmemekkontol");
    expect(c.tempMailDomain).toBe("ifqy.net");
    expect(c.apiKeyFile).toContain("apikey-groqcloud.txt");
    expect(c.resultSuccessFile).toContain("akun-result-groqcloud.txt");
    expect(c.resultFailedFile).toContain("akun-failed-groqcloud.txt");
  });

  it("env overrides", () => {
    const c = loadConfig({
      WORKERS: "4",
      HEADLESS: "0",
      RETRY_FAILED: "true",
      INTER_ACCOUNT_DELAY_SEC: "15",
      GROQCLOUD_PASSWORD: "CustomGroqPassword!",
      TEMPMAIL_DOMAIN: "meongtopup.my.id",
    } as NodeJS.ProcessEnv);
    expect(c.workers).toBe(4);
    expect(c.headless).toBe(false);
    expect(c.retryFailed).toBe(true);
    expect(c.interAccountDelaySec).toBe(15);
    expect(c.defaultPassword).toBe("CustomGroqPassword!");
    expect(c.tempMailDomain).toBe("meongtopup.my.id");
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

describe("groqcloud loaders", () => {
  it("loadAccounts handles comments, bad lines and separators", () => {
    const dir = mkdtempSync(join(tmpdir(), "gq-u-"));
    const f = join(dir, "accounts.txt");
    writeFileSync(f, "a@ifqy.net:pass1\r\n# comment\r\nb@ifqy.net,pass2,recovery@gmail.com\r\ninvalid\n");
    const accs = loadAccounts(f);
    expect(accs.length).toBe(2);
    expect(accs[0].email).toBe("a@ifqy.net");
    expect(accs[1].email).toBe("b@ifqy.net");
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadProxies filters comments and whitespace", () => {
    const dir = mkdtempSync(join(tmpdir(), "gq-u-"));
    const f = join(dir, "proxy.txt");
    writeFileSync(f, "# header\nhttp://1.2.3.4:8080\n\nsocks5://user:pass@5.6.7.8:1080\n");
    const proxies = loadProxies(f);
    expect(proxies.length).toBe(2);
    expect(proxies[0]).toBe("http://1.2.3.4:8080");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("groqcloud dataset selectors and markup verification", () => {
  it("signup inputs and buttons match signup.html", async () => {
    if (!existsSync(join(datasetDir, "signup.html"))) return;
    const html = readFileSync(join(datasetDir, "signup.html"), "utf8");

    let emailFound = false;
    let submitFound = false;

    await new HTMLRewriter()
      .on("input#email-input", {
        element() {
          emailFound = true;
        },
      })
      .on("button", {
        element(e) {
          // Check for submit button
          submitFound = true;
        },
      })
      .transform(new Response(html))
      .text();

    expect(emailFound).toBe(true);
    expect(submitFound).toBe(true);
    expect(html).toContain("Continue with email");
  });

  it("check-email.html contains confirmation texts", () => {
    if (!existsSync(join(datasetDir, "check-email.html"))) return;
    const html = readFileSync(join(datasetDir, "check-email.html"), "utf8");
    expect(html).toContain("Check your email");
    expect(html).toContain("An email was sent");
  });

  it("apikey.html contains Create API Key button", async () => {
    if (!existsSync(join(datasetDir, "apikey.html"))) return;
    const html = readFileSync(join(datasetDir, "apikey.html"), "utf8");

    let createBtn = false;
    await new HTMLRewriter()
      .on('button[data-testid="keys-page-create-button"]', {
        element() {
          createBtn = true;
        },
      })
      .transform(new Response(html))
      .text();

    expect(createBtn).toBe(true);
    expect(html).toContain("Create API Key");
  });

  it("create-apikey-cf.html contains keyName input and cf-turnstile widget", async () => {
    if (!existsSync(join(datasetDir, "create-apikey-cf.html"))) return;
    const html = readFileSync(join(datasetDir, "create-apikey-cf.html"), "utf8");

    let keyNameInput = false;
    let expirationSelect = false;
    let turnstile = false;

    await new HTMLRewriter()
      .on('input[data-testid="key-name-input"]', {
        element() {
          keyNameInput = true;
        },
      })
      .on('button[data-testid="key-expiration-select"]', {
        element() {
          expirationSelect = true;
        },
      })
      .on("#cf-turnstile", {
        element() {
          turnstile = true;
        },
      })
      .transform(new Response(html))
      .text();

    expect(keyNameInput).toBe(true);
    expect(expirationSelect).toBe(true);
    expect(turnstile).toBe(true);
  });

  it("submit-apikey.html contains key-form-submit-button", async () => {
    if (!existsSync(join(datasetDir, "submit-apikey.html"))) return;
    const html = readFileSync(join(datasetDir, "submit-apikey.html"), "utf8");

    let submitBtn = false;
    await new HTMLRewriter()
      .on('button[data-testid="key-form-submit-button"]', {
        element() {
          submitBtn = true;
        },
      })
      .transform(new Response(html))
      .text();

    expect(submitBtn).toBe(true);
    expect(html).toContain("Submit");
  });

  it("copy-apikey.html contains show-key-input with valid GroqCloud API key", async () => {
    if (!existsSync(join(datasetDir, "copy-apikey.html"))) return;
    const html = readFileSync(join(datasetDir, "copy-apikey.html"), "utf8");

    let showKeyInput = false;
    let keyValue = "";

    await new HTMLRewriter()
      .on('input[data-testid="show-key-input"]', {
        element(e) {
          showKeyInput = true;
          keyValue = e.getAttribute("value") || "";
        },
      })
      .transform(new Response(html))
      .text();

    expect(showKeyInput).toBe(true);
    expect(keyValue).toBe("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");
    expect(API_KEY_RE.test(keyValue)).toBe(true);
  });

  it("MAGIC_LINK_RE matches sample link from link.txt", () => {
    const sampleLink =
      "https://stytch.com/v1/magic_links/redirect?public_token=public-token-live-58df57a9-a1f5-4066-bc0c-2ff942db684f&stytch_token_type=discovery&token=wVk91WspsLP9eQyI49hghH5IxUpG9xmqZPV9DuKr34mH";
    const match = sampleLink.match(MAGIC_LINK_RE);
    expect(match).not.toBeNull();
    expect(match![0]).toBe(sampleLink);
  });
});

describe("groqcloud ResultWriter and JsonlStore", () => {
  it("ResultWriter records successes and failures correctly", () => {
    const dir = mkdtempSync(join(tmpdir(), "gq-store-"));
    const successFile = join(dir, "success.txt");
    const failedFile = join(dir, "failed.txt");
    const keyFile = join(dir, "keys.txt");

    const rw = new ResultWriter(successFile, failedFile, keyFile);
    rw.markSuccess("groquser@ifqy.net", "pass123", "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");
    rw.markFailed("baduser@ifqy.net", "Turnstile timeout");

    expect(rw.getSuccessfulEmails().has("groquser@ifqy.net")).toBe(true);
    expect(rw.getFailedEmails().has("baduser@ifqy.net")).toBe(true);

    const keyContent = readFileSync(keyFile, "utf8");
    expect(keyContent.trim()).toBe("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");

    rmSync(dir, { recursive: true, force: true });
  });

  it("JsonlStore persists state transitions and replays on reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "gq-store-"));
    const stateFile = join(dir, "state.jsonl");

    const store1 = new JsonlStore(stateFile);
    store1.upsert({ email: "user@ifqy.net", status: FlowState.PENDING, updatedAt: Date.now() });
    store1.setStatus("user@ifqy.net", FlowState.CREATE_KEY);

    const store2 = new JsonlStore(stateFile);
    expect(store2.get("user@ifqy.net")?.status).toBe(FlowState.CREATE_KEY);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("groqcloud CLI flags", () => {
  it("parses CLI flags and applies to env", () => {
    const argv = [
      "--engine", "python",
      "--headed",
      "--limit", "3",
      "--delay", "5",
      "--password", "GroqPassword!",
      "--domain", "meongtopup.my.id",
    ];
    const parsed = parseArgs(argv);
    expect(parsed.engine).toBe("python");
    expect(parsed.headless).toBe(false);
    expect(parsed.limit).toBe(3);
    expect(parsed.delaySec).toBe(5);
    expect(parsed.password).toBe("GroqPassword!");
    expect(parsed.domain).toBe("meongtopup.my.id");

    const env = applyArgsToEnv(parsed, {});
    expect(env.BROWSER_ENGINE).toBe("python");
    expect(env.HEADLESS).toBe("0");
    expect(env.LIMIT).toBe("3");
    expect(env.INTER_ACCOUNT_DELAY_SEC).toBe("5");
    expect(env.GROQCLOUD_PASSWORD).toBe("GroqPassword!");
    expect(env.TEMPMAIL_DOMAIN).toBe("meongtopup.my.id");
  });
});
