// ── TokenHarbor unit tests (config, loaders, selectors, store) ──
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseBool } from "./config.js";
import { applyArgsToEnv, parseArgs } from "./cli.js";
import { loadAccounts, loadProxies } from "./loaders.js";
import { ResultWriter, JsonlStore, FlowState } from "./store.js";
import { SELECTORS, API_KEY_RE, VERIFY_LINK_RE } from "./flow/selectors.js";

const datasetDir = join(process.cwd(), "tokenharbor-dataset");

describe("tokenharbor config", () => {
  it("defaults", () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c.workers).toBe(1);
    expect(c.headless).toBe(true);
    expect(c.retryFailed).toBe(false);
    expect(c.interAccountDelaySec).toBe(2);
    expect(c.defaultPassword).toBe("torabikA1###########");
    expect(c.tempMailApiKey).toBe("anjingmemekkontol");
    expect(c.tempMailDomain).toBe("ifqy.net");
    expect(c.apiKeyFile).toContain("apikey-tokenharbor.txt");
    expect(c.resultSuccessFile).toContain("akun-result-tokenharbor.txt");
  });

  it("env overrides", () => {
    const c = loadConfig({
      WORKERS: "3",
      HEADLESS: "0",
      RETRY_FAILED: "true",
      INTER_ACCOUNT_DELAY_SEC: "10",
      TOKENHARBOR_PASSWORD: "CustomPassword123!",
      TEMPMAIL_DOMAIN: "meongtopup.my.id",
    } as NodeJS.ProcessEnv);
    expect(c.workers).toBe(3);
    expect(c.headless).toBe(false);
    expect(c.retryFailed).toBe(true);
    expect(c.interAccountDelaySec).toBe(10);
    expect(c.defaultPassword).toBe("CustomPassword123!");
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

describe("tokenharbor loaders", () => {
  it("loadAccounts handles comments, bad lines and separators", () => {
    const dir = mkdtempSync(join(tmpdir(), "th-u-"));
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
    const dir = mkdtempSync(join(tmpdir(), "th-u-"));
    const f = join(dir, "proxies.txt");
    writeFileSync(f, "http://1.2.3.4:8080\n\n# local proxy\nhttp://5.6.7.8:3128\n");
    const p = loadProxies(f);
    expect(p).toEqual(["http://1.2.3.4:8080", "http://5.6.7.8:3128"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("tokenharbor selectors against dataset", () => {
  it("signup form elements match signup.html", async () => {
    if (!existsSync(join(datasetDir, "signup.html"))) return;
    const html = readFileSync(join(datasetDir, "signup.html"), "utf8");

    let emailFound = false;
    let passFound = false;
    let submitFound = false;

    await new HTMLRewriter()
      .on('input[name="email"]', {
        element() {
          emailFound = true;
        },
      })
      .on('input[name="password"]', {
        element() {
          passFound = true;
        },
      })
      .on('button[type="submit"]', {
        element() {
          submitFound = true;
        },
      })
      .transform(new Response(html))
      .text();

    expect(emailFound).toBe(true);
    expect(passFound).toBe(true);
    expect(submitFound).toBe(true);
  });

  it("dashboard elements match dashboard.html", async () => {
    if (!existsSync(join(datasetDir, "dashboard.html"))) return;
    const html = readFileSync(join(datasetDir, "dashboard.html"), "utf8");

    let freeModelBtn = false;
    let verifyBtn = false;

    await new HTMLRewriter()
      .on('button[data-analytics="freemodel-consent-enable"]', {
        element() {
          freeModelBtn = true;
        },
      })
      .on("button", {
        element(e) {
          // Verify email button exists
        },
      })
      .transform(new Response(html))
      .text();

    expect(freeModelBtn).toBe(true);
    expect(html).toContain("Verify email");
    expect(html).toContain("Enable free models");
  });

  it("api key inputs and buttons match apikey.html", async () => {
    if (!existsSync(join(datasetDir, "apikey.html"))) return;
    const html = readFileSync(join(datasetDir, "apikey.html"), "utf8");

    let newKeyBtn = false;
    let inputFloat = false;

    await new HTMLRewriter()
      .on("button", {
        element() {
          newKeyBtn = true;
        },
      })
      .on("input", {
        element() {
          inputFloat = true;
        },
      })
      .transform(new Response(html))
      .text();

    expect(newKeyBtn).toBe(true);
    expect(inputFloat).toBe(true);
    expect(html).toContain("+ New key");
    expect(html).toContain("Create key");
  });

  it("API_KEY_RE extracts key from apikeysuccess.html", () => {
    if (!existsSync(join(datasetDir, "apikeysuccess.html"))) return;
    const html = readFileSync(join(datasetDir, "apikeysuccess.html"), "utf8");

    const match = html.match(API_KEY_RE);
    expect(match).not.toBeNull();
    expect(match![0]).toBe("thk_live_tkotA3u0vklWQT1yg5sAhRJP8za-2lnWx9SrT37EO2b2wd2LQe5iAlf8z-25Jo4j");
  });

  it("VERIFY_LINK_RE matches sample verification link from link.txt", () => {
    const sampleLink = "https://tokenharbor.ai/verify-email?token=NmRiNzMyNzYtMGZhOC00YWYwLThmNjktN2I4ODNlNTA1Mjk5LjE3OTExMTQ3NjExOTAueDBscmUtV2ZXel9GUHhUQ0lnRlRZMHk4R0pxZXpFanluLThCb1pfUmM2OA";
    const match = sampleLink.match(VERIFY_LINK_RE);
    expect(match).not.toBeNull();
    expect(match![0]).toBe(sampleLink);
  });
});

describe("tokenharbor ResultWriter and JsonlStore", () => {
  it("ResultWriter records successes and failures correctly", () => {
    const dir = mkdtempSync(join(tmpdir(), "th-store-"));
    const successFile = join(dir, "success.txt");
    const failedFile = join(dir, "failed.txt");
    const keyFile = join(dir, "keys.txt");

    const rw = new ResultWriter(successFile, failedFile, keyFile);
    rw.markSuccess("a@ifqy.net", "pass123", "thk_live_12345678901234567890");
    rw.markFailed("b@ifqy.net", "Network error");

    expect(rw.getSuccessfulEmails().has("a@ifqy.net")).toBe(true);
    expect(rw.getFailedEmails().has("b@ifqy.net")).toBe(true);

    const keyContent = readFileSync(keyFile, "utf8");
    expect(keyContent.trim()).toBe("thk_live_12345678901234567890");

    rmSync(dir, { recursive: true, force: true });
  });

  it("JsonlStore persists state transitions and replays on reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "th-store-"));
    const stateFile = join(dir, "state.jsonl");

    const store1 = new JsonlStore(stateFile);
    store1.upsert({ email: "user@ifqy.net", status: FlowState.PENDING, updatedAt: Date.now() });
    store1.setStatus("user@ifqy.net", FlowState.EMAIL_VERIFIED);

    const store2 = new JsonlStore(stateFile);
    expect(store2.get("user@ifqy.net")?.status).toBe(FlowState.EMAIL_VERIFIED);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("tokenharbor CLI flags", () => {
  it("parses CLI flags and applies to env", () => {
    const argv = ["--engine", "python", "--headed", "--limit", "5", "--delay", "3", "--password", "Secret123!", "--domain", "meongtopup.my.id"];
    const parsed = parseArgs(argv);
    expect(parsed.engine).toBe("python");
    expect(parsed.headless).toBe(false);
    expect(parsed.limit).toBe(5);
    expect(parsed.delaySec).toBe(3);
    expect(parsed.password).toBe("Secret123!");
    expect(parsed.domain).toBe("meongtopup.my.id");

    const env = applyArgsToEnv(parsed, {});
    expect(env.BROWSER_ENGINE).toBe("python");
    expect(env.HEADLESS).toBe("0");
    expect(env.LIMIT).toBe("5");
    expect(env.INTER_ACCOUNT_DELAY_SEC).toBe("3");
    expect(env.TOKENHARBOR_PASSWORD).toBe("Secret123!");
    expect(env.TEMPMAIL_DOMAIN).toBe("meongtopup.my.id");
  });
});
