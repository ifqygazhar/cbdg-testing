// ── LLM7.io unit tests (config, loaders, selectors, store, dataset) ───
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseBool } from "./config.js";
import { applyArgsToEnv, parseArgs } from "./cli.js";
import { loadAccounts, loadProxies } from "./loaders.js";
import { ResultWriter, JsonlStore, FlowState } from "./store.js";
import { SELECTORS, OTP_CODE_RE } from "./flow/selectors.js";

const datasetDir = join(process.cwd(), "llm7io-dataset");

describe("llm7io config", () => {
  it("defaults", () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c.workers).toBe(1);
    expect(c.headless).toBe(true);
    expect(c.retryFailed).toBe(false);
    expect(c.interAccountDelaySec).toBe(2);
    expect(c.authMethod).toBe("tempmail");
    expect(c.tempMailApiKey).toBe("anjingmemekkontol");
    expect(c.tempMailDomain).toBe("ifqy.net");
    expect(c.apiKeyFile).toBe("apikey-llm7io.txt");
    expect(c.resultSuccessFile).toBe("akun-result-llm7io.txt");
    expect(c.resultFailedFile).toBe("akun-failed-llm7io.txt");
  });

  it("env overrides", () => {
    const c = loadConfig({
      WORKERS: "3",
      HEADLESS: "0",
      RETRY_FAILED: "true",
      INTER_ACCOUNT_DELAY_SEC: "10",
      LLM7IO_AUTH: "google",
      TEMPMAIL_DOMAIN: "meongtopup.my.id",
    } as NodeJS.ProcessEnv);
    expect(c.workers).toBe(3);
    expect(c.headless).toBe(false);
    expect(c.retryFailed).toBe(true);
    expect(c.interAccountDelaySec).toBe(10);
    expect(c.authMethod).toBe("google");
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

describe("llm7io cli arguments", () => {
  it("parses CLI flags accurately", () => {
    const args = parseArgs([
      "--auth", "google",
      "--limit", "5",
      "--headed",
      "--no-proxy",
      "--pace", "careful",
      "--delay", "12",
      "--domain", "huzt.my.id",
    ]);
    expect(args.auth).toBe("google");
    expect(args.limit).toBe(5);
    expect(args.headless).toBe(false);
    expect(args.useProxy).toBe(false);
    expect(args.pace).toBe("careful");
    expect(args.delaySec).toBe(12);
    expect(args.domain).toBe("huzt.my.id");
  });

  it("applies parsed args to environment", () => {
    const base = { WORKERS: "1" };
    const env = applyArgsToEnv(
      {
        auth: "google",
        limit: 10,
        headless: true,
        useProxy: true,
        delaySec: 5,
      },
      base,
    );
    expect(env.LLM7IO_AUTH).toBe("google");
    expect(env.LIMIT).toBe("10");
    expect(env.HEADLESS).toBe("1");
    expect(env.USE_PROXY).toBe("1");
    expect(env.INTER_ACCOUNT_DELAY_SEC).toBe("5");
  });
});

describe("llm7io loaders", () => {
  it("loadAccounts handles comments, bad lines and separators", () => {
    const dir = mkdtempSync(join(tmpdir(), "llm7-u-"));
    const f = join(dir, "accounts.txt");
    writeFileSync(f, "a@ifqy.net:pass1\r\n# comment\r\nb@ifqy.net,pass2,recovery@gmail.com\r\ninvalid\n");
    const accs = loadAccounts(f);
    expect(accs.length).toBe(2);
    expect(accs[0].email).toBe("a@ifqy.net");
    expect(accs[1].email).toBe("b@ifqy.net");
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadProxies filters comments and whitespace", () => {
    const dir = mkdtempSync(join(tmpdir(), "llm7-u-"));
    const f = join(dir, "proxy.txt");
    writeFileSync(f, "# header\nhttp://1.2.3.4:8080\n\nsocks5://user:pass@5.6.7.8:1080\n");
    const proxies = loadProxies(f);
    expect(proxies.length).toBe(2);
    expect(proxies[0]).toBe("http://1.2.3.4:8080");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("llm7io store & result writer", () => {
  it("JsonlStore saves and retrieves records", () => {
    const dir = mkdtempSync(join(tmpdir(), "llm7-s-"));
    const sf = join(dir, "state.jsonl");
    const store = new JsonlStore(sf);
    store.upsert({ email: "user@ifqy.net", status: FlowState.DONE, apiKey: "tok_123" });

    expect(store.isDone("user@ifqy.net")).toBe(true);
    expect(store.get("user@ifqy.net")?.apiKey).toBe("tok_123");
    rmSync(dir, { recursive: true, force: true });
  });

  it("ResultWriter writes raw API key and credential line", () => {
    const dir = mkdtempSync(join(tmpdir(), "llm7-s-"));
    const kf = join(dir, "apikey.txt");
    const rf = join(dir, "result.txt");
    const ff = join(dir, "failed.txt");
    const writer = new ResultWriter([kf], rf, ff);

    writer.markSuccess("user@ifqy.net", "pass123", "secret_key_456");

    const keyContent = readFileSync(kf, "utf8");
    expect(keyContent.trim()).toBe("secret_key_456");

    const resContent = readFileSync(rf, "utf8");
    expect(resContent.trim()).toBe("user@ifqy.net:pass123:secret_key_456");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("llm7io dataset HTML selectors and OTP extraction verification", () => {
  it("signup inputs exist in signup.html", () => {
    const htmlPath = join(datasetDir, "signup.html");
    if (!existsSync(htmlPath)) return;
    const html = readFileSync(htmlPath, "utf8");
    expect(html).toContain('id="email-address"');
    expect(html).toContain("Continue with email");
    expect(html).toContain('id="google-signin-button"');
  });

  it("OTP elements exist in otp-after-submit-email.html", () => {
    const htmlPath = join(datasetDir, "otp-after-submit-email.html");
    if (!existsSync(htmlPath)) return;
    const html = readFileSync(htmlPath, "utf8");
    expect(html).toContain('id="email-verification-code"');
    expect(html).toContain("turnstile-widget");
    expect(html).toContain("Verify email");
  });

  it("OTP extraction regex matches otp-from-tempmail-llm7io.html", () => {
    const htmlPath = join(datasetDir, "otp-from-tempmail-llm7io.html");
    if (!existsSync(htmlPath)) return;
    const html = readFileSync(htmlPath, "utf8");
    const match = OTP_CODE_RE.exec(html);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("977561");
  });

  it("API key creation modal and form inputs match apikey-modal-popup.html", () => {
    const htmlPath = join(datasetDir, "apikey-modal-popup.html");
    if (!existsSync(htmlPath)) return;
    const html = readFileSync(htmlPath, "utf8");
    expect(html).toContain('placeholder="Token name"');
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain("Add New API Key");
  });

  it("Success modal token element matches apikey-success-modal-popup.html", () => {
    const htmlPath = join(datasetDir, "apikey-success-modal-popup.html");
    if (!existsSync(htmlPath)) return;
    const html = readFileSync(htmlPath, "utf8");
    expect(html).toContain("Token Created");
    expect(html).toContain("modal-token-value");
  });
});
