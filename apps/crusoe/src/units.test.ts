// ── Crusoe app unit tests (config, loaders, selectors, store) ──────
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseBool } from "./config.js";
import { applyArgsToEnv, parseArgs } from "./cli.js";
import { PACES } from "@ifqy/google-oauth";
import { loadAccounts, loadProxies } from "./loaders.js";
import { ResultWriter } from "./store.js";
import { Selectors, API_KEY_RE } from "./flow/selectors.js";

describe("app config", () => {
  it("defaults", () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c.workers).toBe(1);
    expect(c.headless).toBe(false);
    expect(c.retryFailed).toBe(false);
    expect(c.interAccountDelaySec).toBe(0);
    expect(c.signupFormTimeoutSec).toBe(45);
    expect(c.apiKeyFile).toContain("apikey.txt");
    expect(c.resultSuccessFile).toContain("akun-result");
  });
  it("env overrides", () => {
    const c = loadConfig({
      WORKERS: "3", HEADLESS: "1", RETRY_FAILED: "true",
      INTER_ACCOUNT_DELAY_SEC: "60", CRUSOE_APIKEY_FILE: "./somewhere/apikey.txt",
    } as NodeJS.ProcessEnv);
    expect(c.workers).toBe(3);
    expect(c.headless).toBe(true);
    expect(c.retryFailed).toBe(true);
    expect(c.interAccountDelaySec).toBe(60);
    expect(c.apiKeyFile.endsWith("apikey.txt")).toBe(true);
  });
  it("parseBool", () => {
    expect(parseBool("1", false)).toBe(true);
    expect(parseBool("no", true)).toBe(false);
    expect(parseBool(undefined, true)).toBe(true);
  });
});

describe("loaders", () => {
  it("loadAccounts handles CRLF, comments and skips bad lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "crusoe-u-"));
    const f = join(dir, "g.txt");
    writeFileSync(f, "a@x.com:pass1\r\n# comment\r\n\r\nb@y.com:pass:with:colons\r\nbadline\r\n");
    const accs = loadAccounts(f);
    expect(accs.map((a) => a.email)).toEqual(["a@x.com", "b@y.com"]);
    expect(accs[1]!.password).toBe("pass:with:colons");
    rmSync(dir, { recursive: true, force: true });
  });
  it("loadProxies parses plain and authenticated", () => {
    const dir = mkdtempSync(join(tmpdir(), "crusoe-u-"));
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

describe("selectors", () => {
  it("needles are lowercase (dom matcher lowercases page text)", () => {
    const needles: string[] = [...Selectors.signUpGoogle, ...Selectors.completeSignupSubmit];
    for (const s of needles) {
      expect(s).toBe(s.toLowerCase());
    }
  });
  it("signUpGoogleButton matches the real /request-foundry markup", async () => {
    // Regression: the flow used to hunt the button by text only. When that
    // scan missed (frame swapped mid-scan), the generic "login" fallback
    // clicked the landing page's own "Already have an account? Login" link
    // and left the signup surface for good.
    const html = readFileSync(
      join(import.meta.dir, "..", "..", "..", "crusoe_ai_dataset", "before-signup-google-with$5.html"),
      "utf8",
    );
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
    // …and the trap the generic fallback used to fall into is really there.
    expect(html).toContain(">Login</a>");
  });
  it("api key flyout selectors match the captured create-apikey page", async () => {
    // Regression: the flow waited for "Create" on the post-signup page, but
    // that button only exists after "Get API Key" opens the flyout.
    const html = readFileSync(
      join(import.meta.dir, "..", "..", "..", "crusoe_ai_dataset", "create-apikey.html"),
      "utf8",
    );
    const hits: Record<string, number> = {};
    const count = (sel: string) => ({
      element() {
        hits[sel] = (hits[sel] ?? 0) + 1;
      },
    });
    await new HTMLRewriter()
      .on(Selectors.getApiKey, count(Selectors.getApiKey))
      .on(Selectors.apiKeyCreate, count(Selectors.apiKeyCreate))
      .on(Selectors.apiKeyAlias, count(Selectors.apiKeyAlias))
      .transform(new Response(html))
      .text();
    expect(hits[Selectors.getApiKey]).toBe(1);
    expect(hits[Selectors.apiKeyCreate]).toBe(1);
    expect(hits[Selectors.apiKeyAlias]).toBe(1);
  });
  it("API_KEY_RE matches both captured real keys", () => {
    const plain =
      "Z2zcdvKLTvSeN0OAjtkSvA_2a_10_0xPogwVpakomXAvFwuCMeO4HoeWjq0MbZAjYSNy7lRcbrriqiuRwW";
    // Regression: this one carries "/" and "." and was rejected by the old
    // base64url-only pattern, so a key already on screen was thrown away.
    const withSeparators =
      "ZFvmGVC-QSO1vn7Ge23xYQ_2a_10_djXjYH64Ba97Ra/fHKiBA.h.8jg.0zKwMk9iEEYAuY5OKh0tvxXkm";
    expect(API_KEY_RE.test(plain)).toBe(true);
    expect(API_KEY_RE.test(withSeparators)).toBe(true);
    expect(API_KEY_RE.test("too-short")).toBe(false);
    // the curl sample on the same page must never pass
    expect(API_KEY_RE.test(`curl -H 'Authorization: Bearer ${withSeparators}'`)).toBe(false);
  });
});

describe("ResultWriter", () => {
  it("markSuccess appends to apikey.txt and akun-result.txt", () => {
    const dir = mkdtempSync(join(tmpdir(), "crusoe-u-"));
    const w = new ResultWriter(join(dir, "akun-result.txt"), join(dir, "akun-failed.txt"), join(dir, "apikey.txt"));
    w.markSuccess("a@x.com", "KEY_ONE_1234567890");
    w.markSuccess("b@y.com", "KEY_TWO_1234567890");
    const keys = readFileSync(join(dir, "apikey.txt"), "utf8").split(/\r?\n/).filter(Boolean);
    expect(keys).toEqual(["KEY_ONE_1234567890", "KEY_TWO_1234567890"]);
    expect(w.getSuccessfulEmails()).toEqual(new Set(["a@x.com", "b@y.com"]));
    rmSync(dir, { recursive: true, force: true });
  });
  it("getPermanentlyFailedEmails filters by reason needle", () => {
    const dir = mkdtempSync(join(tmpdir(), "crusoe-u-"));
    const w = new ResultWriter(join(dir, "r.txt"), join(dir, "f.txt"), join(dir, "k.txt"));
    w.markFailed("a@x.com", "ACCOUNT_RESTRICTED: banned");
    w.markFailed("b@y.com", "WAIT_3DS_TIMEOUT: slow");
    expect(w.getPermanentlyFailedEmails("ACCOUNT_RESTRICTED")).toEqual(new Set(["a@x.com"]));
    rmSync(dir, { recursive: true, force: true });
  });
});
describe("pace profiles", () => {
  it("config defaults to human and reads PACE", () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).pace).toBe("human");
    expect(loadConfig({ PACE: "fast" } as NodeJS.ProcessEnv).pace).toBe("fast");
    // an unknown value must not silently become a broken profile
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
    // a real keystroke is never instant — 0ms typing is the classic bot tell
    expect(PACES.fast.typeMin).toBeGreaterThanOrEqual(15);
    expect(PACES.fast.mouseMoves).toBeGreaterThan(0);
    expect(PACES.careful.pauseMin).toBeGreaterThan(PACES.human.pauseMin);
  });
});

describe("proxy credentials", () => {
  it("proxy credentials survive the loader", () => {
    // Regression: `server` was built from protocol+host only, so user:pass was
    // dropped and every navigation died with ERR_INVALID_AUTH_CREDENTIALS.
    const dir = mkdtempSync(join(tmpdir(), "px-"));
    const f = join(dir, "proxy.txt");
    writeFileSync(f, "http://zwasosog:s3cret@31.59.20.176:6754\nhttp://1.2.3.4:8080\n", "utf8");
    const [withAuth, plain] = loadProxies(f);
    expect(withAuth.server).toBe("http://31.59.20.176:6754");
    expect(withAuth.username).toBe("zwasosog");
    expect(withAuth.password).toBe("s3cret");
    expect(plain.username).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
  it("percent-encoded credentials are decoded", () => {
    const dir = mkdtempSync(join(tmpdir(), "px-"));
    const f = join(dir, "proxy.txt");
    writeFileSync(f, "http://user:p%40ss%3Aword@1.2.3.4:8080\n", "utf8");
    expect(loadProxies(f)[0].password).toBe("p@ss:word");
    rmSync(dir, { recursive: true, force: true });
  });
});
