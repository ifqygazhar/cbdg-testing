// ── Composite unit tests (config, loaders, selectors, store) ──
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseBool } from "./config.js";
import { applyArgsToEnv, parseArgs } from "./cli.js";
import { loadAccounts, loadProxies } from "./loaders.js";
import { ResultWriter, JsonlStore, FlowState } from "./store.js";
import { SELECTORS, COMPOSITE_KEY_REGEX, COMPOSITE_KEY_FALLBACK_REGEX } from "./flow/selectors.js";

const datasetDir = join(process.cwd(), "composite_dataset");

describe("composite config", () => {
  it("defaults", () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c.workers).toBe(1);
    expect(c.headless).toBe(true);
    expect(c.retryFailed).toBe(false);
    expect(c.interAccountDelaySec).toBe(2);
    expect(c.defaultPassword).toBe("torabikA1###########");
    expect(c.tempMailApiKey).toBe("anjingmemekkontol");
    expect(c.tempMailDomain).toBe("ifqy.net");
    expect(c.apiKeyFile).toContain("apikey-composite.txt");
    expect(c.resultSuccessFile).toContain("akun-result-composite.txt");
  });

  it("env overrides", () => {
    const c = loadConfig({
      WORKERS: "3",
      HEADLESS: "0",
      RETRY_FAILED: "true",
      INTER_ACCOUNT_DELAY_SEC: "5",
      COMPOSITE_PASSWORD: "CustomPass123456!",
      TEMPMAIL_DOMAIN: "meongtopup.my.id",
    } as NodeJS.ProcessEnv);
    expect(c.workers).toBe(3);
    expect(c.headless).toBe(false);
    expect(c.retryFailed).toBe(true);
    expect(c.interAccountDelaySec).toBe(5);
    expect(c.defaultPassword).toBe("CustomPass123456!");
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

describe("composite loaders", () => {
  it("loadAccounts handles comments, bad lines and separators", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmp-u-"));
    const f = join(dir, "accounts.txt");
    writeFileSync(f, "a@ifqy.net:pass1\r\n# comment\r\nb@ifqy.net,pass2,custom_username\r\ninvalid\n");
    const accs = loadAccounts(f);
    expect(accs.length).toBe(2);
    expect(accs[0]!.email).toBe("a@ifqy.net");
    expect(accs[0]!.password).toBe("pass1");
    expect(accs[1]!.email).toBe("b@ifqy.net");
    expect(accs[1]!.username).toBe("custom_username");
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadProxies filters comments and blank lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmp-u-"));
    const f = join(dir, "proxies.txt");
    writeFileSync(f, "http://1.2.3.4:8080\n\n# local proxy\nhttp://5.6.7.8:3128\n");
    const p = loadProxies(f);
    expect(p).toEqual(["http://1.2.3.4:8080", "http://5.6.7.8:3128"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("composite selectors against composite_dataset", () => {
  it("signup form elements match signup.html", async () => {
    if (!existsSync(join(datasetDir, "signup.html"))) return;
    const html = readFileSync(join(datasetDir, "signup.html"), "utf8");

    let usernameFound = false;
    let emailFound = false;
    let passFound = false;
    let confirmFound = false;
    let turnstileFound = false;
    let submitFound = false;

    await new HTMLRewriter()
      .on("input#reg-username", {
        element() {
          usernameFound = true;
        },
      })
      .on("input#reg-email", {
        element() {
          emailFound = true;
        },
      })
      .on("input#reg-password", {
        element() {
          passFound = true;
        },
      })
      .on("input#reg-confirm", {
        element() {
          confirmFound = true;
        },
      })
      .on(".turnstile-wrap", {
        element() {
          turnstileFound = true;
        },
      })
      .on('button[type="submit"]', {
        element() {
          submitFound = true;
        },
      })
      .transform(new Response(html))
      .text();

    expect(usernameFound).toBe(true);
    expect(emailFound).toBe(true);
    expect(passFound).toBe(true);
    expect(confirmFound).toBe(true);
    expect(turnstileFound).toBe(true);
    expect(submitFound).toBe(true);
  });

  it("apikeys page contains 'New key' button", () => {
    if (existsSync(join(datasetDir, "apikeys.html"))) {
      const html = readFileSync(join(datasetDir, "apikeys.html"), "utf8");
      expect(html).toContain("New key");
      expect(html).toContain("API keys");
    }
  });

  it("apikey-popup1 modal matches create key form", () => {
    if (existsSync(join(datasetDir, "apikey-popup1.html"))) {
      const html = readFileSync(join(datasetDir, "apikey-popup1.html"), "utf8");
      expect(html).toContain('id="create-key-title"');
      expect(html).toContain('id="key-name-input"');
      expect(html).toContain("Create key");
    }
  });

  it("apikey-popup2 modal matches created key and regex extracts key correctly", () => {
    if (existsSync(join(datasetDir, "apikey-popup2.html"))) {
      const html = readFileSync(join(datasetDir, "apikey-popup2.html"), "utf8");
      expect(html).toContain('id="new-key-title"');
      expect(html).toContain("new-key-display");
      expect(html).toContain("Copy key");

      const m = html.match(COMPOSITE_KEY_REGEX);
      expect(m).not.toBeNull();
      expect(m![0]).toBe("cmp-fa4056e6d30833436497934b71c449e2");
    }
  });
});

describe("composite ResultWriter and JsonlStore", () => {
  it("ResultWriter records successes and failures correctly", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmp-store-"));
    const successFile = join(dir, "success.txt");
    const failedFile = join(dir, "failed.txt");
    const keyFile = join(dir, "keys.txt");

    const rw = new ResultWriter(successFile, failedFile, keyFile);
    rw.markSuccess("test@ifqy.net", "pass123", "cmp-fa4056e6d30833436497934b71c449e2");
    rw.markFailed("bad@ifqy.net", "TURNSTILE_TIMEOUT");

    const succ = readFileSync(successFile, "utf8");
    expect(succ).toContain("test@ifqy.net:pass123:cmp-fa4056e6d30833436497934b71c449e2");

    const keys = readFileSync(keyFile, "utf8");
    expect(keys).toContain("cmp-fa4056e6d30833436497934b71c449e2");

    const fail = readFileSync(failedFile, "utf8");
    expect(fail).toContain("bad@ifqy.net");
    expect(fail).toContain("TURNSTILE_TIMEOUT");

    expect(rw.getSuccessfulEmails().has("test@ifqy.net")).toBe(true);
    expect(rw.getFailedEmails().has("bad@ifqy.net")).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("JsonlStore persists state transitions and replays on reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmp-jsonl-"));
    const stateFile = join(dir, "state.jsonl");

    const store = new JsonlStore(stateFile);
    store.upsert({
      email: "user@ifqy.net",
      status: FlowState.PENDING,
      updatedAt: 1000,
    });
    store.setStatus("user@ifqy.net", FlowState.API_KEY);

    const store2 = new JsonlStore(stateFile);
    const rec = store2.get("user@ifqy.net");
    expect(rec).toBeDefined();
    expect(rec!.status).toBe(FlowState.API_KEY);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("composite CLI flags", () => {
  it("parses CLI flags and applies to env", () => {
    const args = parseArgs([
      "--limit",
      "5",
      "--domain",
      "meongtopup.my.id",
      "--headed",
      "--workers",
      "2",
      "--pace",
      "fast",
      "--password",
      "CustomP@ss123",
      "--no-proxy",
    ]);

    expect(args.limit).toBe(5);
    expect(args.domain).toBe("meongtopup.my.id");
    expect(args.headless).toBe(false);
    expect(args.workers).toBe(2);
    expect(args.pace).toBe("fast");
    expect(args.password).toBe("CustomP@ss123");
    expect(args.useProxy).toBe(false);

    const env = applyArgsToEnv(args, {});
    expect(env.LIMIT).toBe("5");
    expect(env.TEMPMAIL_DOMAIN).toBe("meongtopup.my.id");
    expect(env.HEADLESS).toBe("0");
    expect(env.WORKERS).toBe("2");
    expect(env.PACE).toBe("fast");
    expect(env.COMPOSITE_PASSWORD).toBe("CustomP@ss123");
    expect(env.USE_PROXY).toBe("0");
  });
});
