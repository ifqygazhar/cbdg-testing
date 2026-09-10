// ── Webshare app unit tests (config, selectors, proxy formatting, store) ──
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseBool } from "./config.js";
import { applyArgsToEnv, parseArgs } from "./cli.js";
import { loadAccounts, loadProxies } from "./loaders.js";
import { ResultWriter, formatProxy, type ProxyRecord } from "./store.js";
import { Selectors, isUsableProxyRow } from "./flow/selectors.js";

const PROXY: ProxyRecord = { address: "198.23.239.134", port: 6540, username: "abcuser", password: "s3cr3t" };

describe("app config", () => {
  it("defaults", () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c.workers).toBe(1);
    expect(c.retryFailed).toBe(false);
    expect(c.pace).toBe("human");
    expect(c.proxyFormat).toBe("url");
    expect(c.proxyFile).toContain("proxy.txt");
    expect(c.resultFailedFile).toContain("akun-failed-webshare.txt");
  });
  it("the signup proxy seed is never the file we append to", () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c.seedProxyForSignup).not.toBe(c.proxyFile);
  });
  it("env overrides", () => {
    const c = loadConfig({
      WORKERS: "2", PACE: "fast", WEBSHARE_PROXY_FORMAT: "webshare",
      WEBSHARE_PROXY_FILE: "./out/proxy.txt",
    } as NodeJS.ProcessEnv);
    expect(c.workers).toBe(2);
    expect(c.pace).toBe("fast");
    expect(c.proxyFormat).toBe("webshare");
    expect(c.proxyFile.endsWith("proxy.txt")).toBe(true);
  });
  it("parseBool", () => {
    expect(parseBool("yes", false)).toBe(true);
    expect(parseBool(undefined, true)).toBe(true);
  });
  it("cli flags map onto the env", () => {
    expect(applyArgsToEnv(parseArgs(["--fast"]), {}).PACE).toBe("fast");
    expect(applyArgsToEnv(parseArgs(["--delay", "45"]), {}).INTER_ACCOUNT_DELAY_SEC).toBe("45");
    expect(applyArgsToEnv(parseArgs(["--retry-failed"]), {}).RETRY_FAILED).toBe("1");
  });
});

describe("selectors", () => {
  it("signup url keeps the empty-value query that switches GSI to redirect mode", () => {
    // `?start_google_login_flow` without "=" parses to a non-empty value and
    // the app silently stays in popup mode, which never opens in automation.
    expect(Selectors.signupUrl.endsWith("start_google_login_flow=")).toBe(true);
    const parsed = new URL(Selectors.signupUrl);
    expect(parsed.searchParams.get("start_google_login_flow")).toBe("");
  });
  it("google button selector matches the captured register page", async () => {
    const html = readFileSync(
      join(import.meta.dir, "..", "..", "..", "webshare_dataset", "signup.html"),
      "utf8",
    );
    const labels: string[] = [];
    await new HTMLRewriter()
      .on(Selectors.signUpGoogleButton[0], {
        element(el) {
          labels.push(el.getAttribute("data-testid") ?? "");
        },
      })
      .transform(new Response(html))
      .text();
    expect(labels).toEqual(["google-button"]);
  });
  it("plan id is read out of the sidebar href, not the table", () => {
    const href = "/14267610/proxy/list?authenticationMethod=%22username_password%22";
    expect(href.match(Selectors.planIdFromHrefRe)?.[1]).toBe("14267610");
    expect("/proxy/list".match(Selectors.planIdFromHrefRe)).toBeNull();
  });
  it("the sidebar link is present on a real logged-in dashboard page", async () => {
    // proxy-data.html was captured while signed in, so it proves the discovery
    // step: read the plan id from the href instead of the proxy table.
    const html = readFileSync(
      join(import.meta.dir, "..", "..", "..", "webshare_dataset", "proxy-data.html"),
      "utf8",
    );
    const hrefs: string[] = [];
    await new HTMLRewriter()
      .on(Selectors.proxyListLink, {
        element(el) {
          hrefs.push(el.getAttribute("href") ?? "");
        },
      })
      .transform(new Response(html))
      .text();
    expect(hrefs).toContain("/14267610/proxy/list");
    expect(hrefs[0].match(Selectors.planIdFromHrefRe)?.[1]).toBe("14267610");
  });
  it("the token is taken from any api call, not just the list call", () => {
    expect(Selectors.proxyApiRe.test("https://proxy.webshare.io/api/v2/subscription/")).toBe(true);
    expect(Selectors.proxyApiRe.test("https://dashboard.webshare.io/assets/x.js")).toBe(false);
  });
  it("api matcher accepts the versioned list endpoint only", () => {
    expect(Selectors.proxyListApiRe.test("https://proxy.webshare.io/api/v2/proxy/list/?mode=direct")).toBe(true);
    expect(Selectors.proxyListApiRe.test("https://proxy.webshare.io/api/v3/proxy/list/")).toBe(true);
    expect(Selectors.proxyListApiRe.test("https://proxy.webshare.io/api/v2/subscription/")).toBe(false);
  });
  it("rejects rows that are not usable proxies", () => {
    expect(isUsableProxyRow({ proxy_address: "1.2.3.4", port: 8080 })).toBe(true);
    expect(isUsableProxyRow({ proxy_address: "1.2.3.4" })).toBe(false);
    expect(isUsableProxyRow({ proxy_address: "", port: 80 })).toBe(false);
    expect(isUsableProxyRow({ proxy_address: "1.2.3.4", port: 99999 })).toBe(false);
  });
});

describe("proxy formatting", () => {
  it("url form is what the other apps' loadProxies parses", () => {
    expect(formatProxy(PROXY)).toBe("http://abcuser:s3cr3t@198.23.239.134:6540");
    const u = new URL(formatProxy(PROXY));
    expect(`${u.protocol}//${u.host}`).toBe("http://198.23.239.134:6540");
    expect(u.username).toBe("abcuser");
  });
  it("webshare form is host:port:user:pass", () => {
    expect(formatProxy(PROXY, "webshare")).toBe("198.23.239.134:6540:abcuser:s3cr3t");
  });
  it("escapes credentials that would break the url", () => {
    const odd = { ...PROXY, password: "p@ss:word" };
    const u = new URL(formatProxy(odd));
    expect(decodeURIComponent(u.password)).toBe("p@ss:word");
    expect(u.hostname).toBe("198.23.239.134");
  });
});

describe("ResultWriter", () => {
  it("appends proxies to proxy.txt and never duplicates a line", () => {
    const dir = mkdtempSync(join(tmpdir(), "ws-u-"));
    const proxyFile = join(dir, "proxy.txt");
    const w = new ResultWriter(join(dir, "ok.txt"), join(dir, "fail.txt"), proxyFile);
    w.markSuccess("a@x.com", [PROXY, { ...PROXY, port: 6541 }]);
    const written = w.markSuccess("b@y.com", [PROXY, { ...PROXY, port: 6542 }]);
    expect(written).toBe(1); // PROXY already present
    const lines = readFileSync(proxyFile, "utf8").split(/\r?\n/).filter(Boolean);
    expect(lines).toEqual([
      "http://abcuser:s3cr3t@198.23.239.134:6540",
      "http://abcuser:s3cr3t@198.23.239.134:6541",
      "http://abcuser:s3cr3t@198.23.239.134:6542",
    ]);
    expect(w.getSuccessfulEmails()).toEqual(new Set(["a@x.com", "b@y.com"]));
    rmSync(dir, { recursive: true, force: true });
  });
  it("keeps existing proxy.txt content from other tools", () => {
    const dir = mkdtempSync(join(tmpdir(), "ws-u-"));
    const proxyFile = join(dir, "proxy.txt");
    writeFileSync(proxyFile, "# manual\nhttp://1.1.1.1:8080\n", "utf8");
    const w = new ResultWriter(join(dir, "ok.txt"), join(dir, "fail.txt"), proxyFile);
    w.markSuccess("a@x.com", [PROXY]);
    const raw = readFileSync(proxyFile, "utf8");
    expect(raw).toContain("# manual");
    expect(raw).toContain("http://1.1.1.1:8080");
    expect(raw.trim().endsWith("http://abcuser:s3cr3t@198.23.239.134:6540")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
  it("permanent failures are filtered by reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "ws-u-"));
    const w = new ResultWriter(join(dir, "ok.txt"), join(dir, "f.txt"), join(dir, "p.txt"));
    w.markFailed("a@x.com", "ACCOUNT_RESTRICTED: banned");
    w.markFailed("b@y.com", "NO_PROXIES: empty list");
    expect(w.getPermanentlyFailedEmails("ACCOUNT_RESTRICTED")).toEqual(new Set(["a@x.com"]));
    expect(w.getFailedEmails()).toEqual(new Set(["a@x.com", "b@y.com"]));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("loaders", () => {
  it("reads gsuite accounts", () => {
    const dir = mkdtempSync(join(tmpdir(), "ws-u-"));
    const f = join(dir, "gsuite.txt");
    writeFileSync(f, "# c\na@x.com:pw1\nb@y.com:pw2\nbadline\n", "utf8");
    expect(loadAccounts(f).map((a) => a.email)).toEqual(["a@x.com", "b@y.com"]);
    rmSync(dir, { recursive: true, force: true });
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

describe("google direct (proxy bypass)", () => {
  it("defaults to sending google sign-in direct", () => {
    // Google scores the sign-in by the address it comes from, and a shared
    // datacenter proxy earns an image captcha at the email step.
    expect(loadConfig({} as NodeJS.ProcessEnv).googleDirect).toBe(true);
  });
  it("can be turned off entirely", () => {
    expect(loadConfig({ GOOGLE_DIRECT: "0" } as NodeJS.ProcessEnv).googleDirect).toBe(false);
    expect(applyArgsToEnv(parseArgs(["--no-google-direct"]), {}).GOOGLE_DIRECT).toBe("0");
    expect(applyArgsToEnv(parseArgs(["--google-direct"]), {}).GOOGLE_DIRECT).toBe("1");
  });
  it("the host list is overridable and tolerant of separators", () => {
    const c = loadConfig({ GOOGLE_DIRECT_HOSTS: "a.com; b.com , c.com" } as NodeJS.ProcessEnv);
    expect(c.googleDirectHosts).toEqual(["a.com", "b.com", "c.com"]);
    expect(loadConfig({} as NodeJS.ProcessEnv).googleDirectHosts).toEqual([]);
  });
});
