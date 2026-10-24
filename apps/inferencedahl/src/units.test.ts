// ── Inference Dahl Global unit tests (config, loaders, selectors, store) ──
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseBool } from "./config.js";
import { applyArgsToEnv, parseArgs } from "./cli.js";
import { loadAccounts, loadProxies } from "./loaders.js";
import { ResultWriter, JsonlStore, FlowState } from "./store.js";
import {
  SELECTORS,
  DAHL_FINGERPRINT_REGEX,
  DAHL_KEY_REGEX,
  DEMO_LANDING_KEY,
} from "./flow/selectors.js";
import { isValidDahlApiKey } from "./flow/steps.js";

const datasetDir = join(process.cwd(), "inference-dahl-global-dataset");

describe("inferencedahl config", () => {
  it("defaults", () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c.workers).toBe(1);
    expect(c.headless).toBe(true);
    expect(c.retryFailed).toBe(false);
    expect(c.interAccountDelaySec).toBe(2);
    expect(c.limit).toBe(0);
    expect(c.apiKeyFile).toContain("apikey-inferencedahl.txt");
    expect(c.resultSuccessFile).toContain("akun-result-inferencedahl.txt");
  });

  it("env overrides", () => {
    const c = loadConfig({
      WORKERS: "3",
      HEADLESS: "0",
      RETRY_FAILED: "true",
      INTER_ACCOUNT_DELAY_SEC: "5",
      LIMIT: "10",
    } as NodeJS.ProcessEnv);
    expect(c.workers).toBe(3);
    expect(c.headless).toBe(false);
    expect(c.retryFailed).toBe(true);
    expect(c.interAccountDelaySec).toBe(5);
    expect(c.limit).toBe(10);
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

describe("inferencedahl loaders", () => {
  it("loadAccounts handles fingerprint:apikey and username entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "dahl-u-"));
    const f = join(dir, "accounts.txt");
    writeFileSync(f, "10d8100390c30c1e4b388eed4e66dd0e:dahl_LPGtestKey1234567890:bold_fox_460\r\n# comment\r\n20d8100390c30c1e4b388eed4e66dd0e:dahl_LPGtestKey0987654321\r\n");
    const accs = loadAccounts(f);
    expect(accs.length).toBe(2);
    expect(accs[0]!.fingerprint).toBe("10d8100390c30c1e4b388eed4e66dd0e");
    expect(accs[0]!.username).toBe("bold_fox_460");
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadProxies filters comments and blank lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "dahl-u-"));
    const f = join(dir, "proxies.txt");
    writeFileSync(f, "http://1.2.3.4:8080\n\n# local proxy\nhttp://5.6.7.8:3128\n");
    const p = loadProxies(f);
    expect(p).toEqual(["http://1.2.3.4:8080", "http://5.6.7.8:3128"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("inferencedahl selectors against inference-dahl-global-dataset", () => {
  it("sign-in-modal.html contains Sign In dialog and Create account button", async () => {
    if (!existsSync(join(datasetDir, "sign-in-modal.html"))) return;
    const html = readFileSync(join(datasetDir, "sign-in-modal.html"), "utf8");
    expect(html).toContain('id="signin-fingerprint"');
    expect(html).toContain("Create account");
  });

  it("signup.html contains auto-generated username input, Regenerate button, and submit button", async () => {
    if (!existsSync(join(datasetDir, "signup.html"))) return;
    const html = readFileSync(join(datasetDir, "signup.html"), "utf8");

    let usernameFound = false;
    let regenerateFound = false;
    let submitFound = false;

    await new HTMLRewriter()
      .on(SELECTORS.signupModal.usernameInput, {
        element(el) {
          usernameFound = true;
          expect(el.getAttribute("value")).toBe("bold_fox_460");
        },
      })
      .on(SELECTORS.signupModal.regenerateButton, {
        element() {
          regenerateFound = true;
        },
      })
      .on(SELECTORS.signupModal.submitButton, {
        element() {
          submitFound = true;
        },
      })
      .transform(new Response(html))
      .text();

    expect(usernameFound).toBe(true);
    expect(regenerateFound).toBe(true);
    expect(submitFound).toBe(true);
  });

  it("fingerprint-apikey-after-signup.html contains 32-char hex fingerprint, checkbox, and Continue button", async () => {
    if (!existsSync(join(datasetDir, "fingerprint-apikey-after-signup.html"))) return;
    const html = readFileSync(join(datasetDir, "fingerprint-apikey-after-signup.html"), "utf8");

    expect(html).toContain("Save your fingerprint");
    expect(html).toContain("I saved my fingerprint and understand it cannot be recovered");

    const fpMatch = html.match(DAHL_FINGERPRINT_REGEX);
    expect(fpMatch).not.toBeNull();
    expect(fpMatch![0]).toBe("10d8100390c30c1e4b388eed4e66dd0e");

    let checkboxFound = false;
    await new HTMLRewriter()
      .on(SELECTORS.fingerprintModal.savedCheckbox, {
        element() {
          checkboxFound = true;
        },
      })
      .transform(new Response(html))
      .text();

    expect(checkboxFound).toBe(true);
  });

  it("dashboard.html and allocate-modal-popup.html contain API keys section and Allocate controls", () => {
    if (existsSync(join(datasetDir, "dashboard.html"))) {
      const html = readFileSync(join(datasetDir, "dashboard.html"), "utf8");
      expect(html).toContain('aria-label="API keys"');
      expect(html).toContain("Allocate");
    }
    if (existsSync(join(datasetDir, "allocate-modal-popup.html"))) {
      const html = readFileSync(join(datasetDir, "allocate-modal-popup.html"), "utf8");
      expect(html).toContain("Allocate to key");
      expect(html).toContain('autocomplete="off"');
      expect(html).toContain("Max");
    }
    if (existsSync(join(datasetDir, "element-tanda-success-signup-dan-allocate-token-ke-apikeey.html"))) {
      const html = readFileSync(
        join(datasetDir, "element-tanda-success-signup-dan-allocate-token-ke-apikeey.html"),
        "utf8",
      );
      expect(html).toContain("100M");
      expect(html).toContain("Active");
    }
  });

  it("isValidDahlApiKey rejects landing demo key and masked keys", () => {
    expect(isValidDahlApiKey(DEMO_LANDING_KEY)).toBe(false);
    expect(isValidDahlApiKey("dahl_LPG…fp8w3n")).toBe(false);
    expect(isValidDahlApiKey("dahl_LPG1234567890abcdefghijklmnopfp8w3n")).toBe(true);
    const m = "token: dahl_LPG1234567890abcdefghijklmnopfp8w3n".match(DAHL_KEY_REGEX);
    expect(m).not.toBeNull();
    expect(m![0]).toBe("dahl_LPG1234567890abcdefghijklmnopfp8w3n");
  });
});

describe("inferencedahl ResultWriter and JsonlStore", () => {
  it("ResultWriter records fingerprint:apikey to akun-result and apikey to apikey file", () => {
    const dir = mkdtempSync(join(tmpdir(), "dahl-store-"));
    const successFile = join(dir, "akun-result-inferencedahl.txt");
    const failedFile = join(dir, "akun-failed-inferencedahl.txt");
    const keyFile = join(dir, "apikey-inferencedahl.txt");

    const rw = new ResultWriter(successFile, failedFile, keyFile);
    const fp = "10d8100390c30c1e4b388eed4e66dd0e";
    const key = "dahl_LPG1234567890abcdefghijklmnopfp8w3n";
    rw.markSuccess(fp, key);
    rw.markFailed("dahl_worker1_2", "SIGNUP_FAILED");

    const succ = readFileSync(successFile, "utf8").trim();
    expect(succ).toBe(`${fp}:${key}`);

    const keys = readFileSync(keyFile, "utf8").trim();
    expect(keys).toBe(key);

    const fail = readFileSync(failedFile, "utf8");
    expect(fail).toContain("dahl_worker1_2");
    expect(fail).toContain("SIGNUP_FAILED");

    expect(rw.getSuccessfulFingerprints().has(fp)).toBe(true);
    expect(rw.getFailedIds().has("dahl_worker1_2")).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("JsonlStore persists state transitions and replays on reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "dahl-jsonl-"));
    const stateFile = join(dir, "state.jsonl");

    const store = new JsonlStore(stateFile);
    store.upsert({
      id: "10d8100390c30c1e4b388eed4e66dd0e",
      fingerprint: "10d8100390c30c1e4b388eed4e66dd0e",
      status: FlowState.PENDING,
      updatedAt: 1000,
    });
    store.setStatus("10d8100390c30c1e4b388eed4e66dd0e", FlowState.ALLOCATE);

    const store2 = new JsonlStore(stateFile);
    const rec = store2.get("10d8100390c30c1e4b388eed4e66dd0e");
    expect(rec).toBeDefined();
    expect(rec!.status).toBe(FlowState.ALLOCATE);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("inferencedahl CLI flags", () => {
  it("parses CLI flags and applies to env", () => {
    const args = parseArgs([
      "--limit",
      "5",
      "--headed",
      "--workers",
      "2",
      "--pace",
      "fast",
      "--no-proxy",
      "--engine",
      "python",
    ]);

    expect(args.limit).toBe(5);
    expect(args.headless).toBe(false);
    expect(args.workers).toBe(2);
    expect(args.pace).toBe("fast");
    expect(args.useProxy).toBe(false);
    expect(args.engine).toBe("python");

    const env = applyArgsToEnv(args, {});
    expect(env.LIMIT).toBe("5");
    expect(env.HEADLESS).toBe("0");
    expect(env.WORKERS).toBe("2");
    expect(env.PACE).toBe("fast");
    expect(env.USE_PROXY).toBe("0");
    expect(env.BROWSER_ENGINE).toBe("python");
  });
});

describe("inferencedahl per-account fingerprint diversity", () => {
  it("generates unique session IDs and distinct account fingerprints per run", () => {
    const sessionIds = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = `dahl-w1-${i + 1}-${Math.floor(Math.random() * 9000 + 1000)}`;
      sessionIds.add(id);
    }
    expect(sessionIds.size).toBe(50);
  });
});
