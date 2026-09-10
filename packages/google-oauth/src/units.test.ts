// ── Unit tests: @ifqy/google-oauth (pure logic, no browser) ────────
import { describe, it, expect } from "bun:test";
import { classifyNetworkError } from "./browser.js";
import { PACES, resolvePace } from "./pace.js";
import type { Page } from "puppeteer-core";
import {
  sleep, randomInt, humanPause, humanTypeDelay,
  sanitizeFileName, oneLine, normalizeText,
} from "./utils.js";
import { resolveGoogleOAuthOptions } from "./config.js";
import { getRandomViewport } from "./antiDetect.js";
import { screenshotPath, takeScreenshot } from "./screenshot.js";
import { isGoogleUrl, findGooglePageIn, isAccountRestricted } from "./googleAuth.js";

// ── utils ─────────────────────────────────────────────────────────
describe("utils", () => {
  it("sleep waits at least the requested ms", async () => {
    const t0 = Date.now();
    await sleep(50);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45); // timer jitter tolerance
  });

  it("randomInt stays in bounds across many samples (incl. inverted-safe)", () => {
    for (let i = 0; i < 500; i++) {
      const v = randomInt(-5, 5);
      expect(v).toBeGreaterThanOrEqual(-5);
      expect(v).toBeLessThanOrEqual(5);
    }
  });

  it("randomInt returns the value itself when min === max", () => {
    for (let i = 0; i < 50; i++) expect(randomInt(7, 7)).toBe(7);
  });

  it("humanPause uses custom bounds", async () => {
    const t0 = Date.now();
    await humanPause(10, 20);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("humanTypeDelay is within the default 30..90 range", () => {
    for (let i = 0; i < 100; i++) {
      const d = humanTypeDelay();
      expect(d).toBeGreaterThanOrEqual(30);
      expect(d).toBeLessThanOrEqual(90);
    }
  });

  it("sanitizeFileName keeps only [a-z0-9._-] and truncates to 120", () => {
    expect(sanitizeFileName("a/b\\c*d?e")).toBe("a_b_c_d_e");
    expect(sanitizeFileName("x".repeat(300)).length).toBe(120);
    expect(sanitizeFileName("ok-file.name_1")).toBe("ok-file.name_1");
  });

  it("oneLine collapses whitespace and trims", () => {
    expect(oneLine("  a\n\n  b \t c  ")).toBe("a b c");
    expect(oneLine(null as never)).toBe("");
    expect(oneLine(undefined as never)).toBe("");
  });

  it("normalizeText lowercases", () => {
    expect(normalizeText("HeLLo  World")).toBe("hello world");
  });
});

// ── config ────────────────────────────────────────────────────────
describe("resolveGoogleOAuthOptions", () => {
  it("falls back to documented defaults", () => {
    const c = resolveGoogleOAuthOptions();
    expect(c.headless).toBe(false);
    expect(c.consentTimeoutMs).toBe(90_000);
    expect(c.passwordTimeoutMs).toBe(60_000);
    expect(c.signinTimeoutMs).toBe(30_000);
    expect(c.captchaTimeoutMs).toBe(180_000);
    expect(c.failOnCaptcha).toBe(true);
    expect(c.typeDelayMin).toBe(30);
    expect(c.typeDelayMax).toBe(90);
    expect(typeof c.log).toBe("function");
  });

  it("honours explicit overrides over defaults", () => {
    const c = resolveGoogleOAuthOptions({ headless: true, consentTimeoutMs: 1, typeDelayMin: 5 });
    expect(c.headless).toBe(true);
    expect(c.consentTimeoutMs).toBe(1);
    expect(c.typeDelayMin).toBe(5);
  });

  it("default logger routes levels to console without throwing", () => {
    const c = resolveGoogleOAuthOptions();
    expect(() => {
      c.log?.("info", "hello", { a: 1 });
      c.log?.("warn", "careful");
      c.log?.("error", "boom");
    }).not.toThrow();
  });
});

// ── antiDetect ─────────────────────────────────────────────────────
describe("getRandomViewport", () => {
  it("jitters around the 1280x800 base within ±50", () => {
    for (let i = 0; i < 200; i++) {
      const v = getRandomViewport();
      expect(v.width).toBeGreaterThanOrEqual(1230);
      expect(v.width).toBeLessThanOrEqual(1330);
      expect(v.height).toBeGreaterThanOrEqual(750);
      expect(v.height).toBeLessThanOrEqual(850);
      expect(Number.isInteger(v.width)).toBe(true);
      expect(Number.isInteger(v.height)).toBe(true);
    }
  });
});

// ── screenshot ─────────────────────────────────────────────────────
describe("screenshotPath", () => {
  it("embeds a sanitized email, stage and timestamp", () => {
    const p = screenshotPath("C:/shots", "weird@x.com", "captcha");
    const name = p.split(/[\\/]/).pop() ?? "";
    expect(name.startsWith("weird_x.com_captcha_")).toBe(true);
    expect(name.endsWith(".png")).toBe(true);
    expect(p.startsWith("C:")).toBe(true);
  });
});

describe("takeScreenshot", () => {
  it("never throws even when the page is broken", async () => {
    const brokenPage = {
      screenshot: async () => { throw new Error("browser gone"); },
    } as unknown as Page;
    const opts = resolveGoogleOAuthOptions();
    await expect(
      takeScreenshot(brokenPage, "./tmp-definitely-missing-dir/x.png", opts),
    ).resolves.toBeUndefined();
  });
});

// ── google URL / page detection ────────────────────────────────────
describe("google page detection", () => {
  it("recognizes all Google sign-in URL shapes", () => {
    expect(isGoogleUrl("https://accounts.google.com/signin/v2/identifier")).toBe(true);
    expect(isGoogleUrl("https://accounts.google.com/o/oauth2/auth")).toBe(true);
    expect(isGoogleUrl("https://accounts.google.com/ServiceLogin")).toBe(true);
    expect(isGoogleUrl("https://google.co.id/signin")).toBe(true);
  });

  it("rejects non-Google URLs", () => {
    expect(isGoogleUrl("https://www.codebuddy.ai/pricing")).toBe(false);
    expect(isGoogleUrl("https://card.harvestsharp.com/apps/creditcard/views/sign?token=x")).toBe(false);
    expect(isGoogleUrl("https://fakegoogle.example.com")).toBe(false);
  });

  it("findGooglePageIn returns the first google page or null", () => {
    const mk = (u: string) => ({ url: () => u }) as unknown as Page;
    expect(findGooglePageIn([])).toBeNull();
    expect(findGooglePageIn([mk("https://a.com"), mk("https://b.com")])).toBeNull();
    const g = mk("https://accounts.google.com/x");
    const pages = [mk("https://a.com"), g, mk("https://accounts.google.com/y")];
    expect(findGooglePageIn(pages)).toBe(g);
  });
});
// ── isAccountRestricted (risk-control banner detection) ────────────
describe("isAccountRestricted", () => {
  const fakePage = (texts: string[]) =>
    ({
      frames: () => texts.map((t) => ({
        evaluate: () => Promise.resolve(
          /account access restricted|security policy restriction/i.test(t),
        ),
      })),
    }) as unknown as Page;

  it("detects the captured restricted banner text", async () => {
    const banner =
      "Account Access Restricted — Your account is temporarily unavailable due to security policy restrictions.";
    expect(await isAccountRestricted(fakePage([banner]))).toBe(true);
  });

  it("matches on any frame (banner can live in the login iframe)", async () => {
    expect(await isAccountRestricted(fakePage(["Sign in to copilot", "Account Access Restricted"]))).toBe(true);
  });

  it("returns false for normal login pages", async () => {
    expect(
      await isAccountRestricted(fakePage(["Sign up with Google", "Service Agreement and Privacy Terms"])),
    ).toBe(false);
  });
});

describe("pace", () => {
  it("resolves names, objects and falls back to human", () => {
    expect(resolvePace("fast").name).toBe("fast");
    expect(resolvePace(PACES.careful).name).toBe("careful");
    expect(resolvePace(undefined).name).toBe("human");
    expect(resolvePace("nope" as never).name).toBe("human");
  });
  it("fast keeps human-shaped input", () => {
    // 0 ms typing and no mouse movement is the obvious bot signature
    expect(PACES.fast.typeMin).toBeGreaterThan(0);
    expect(PACES.fast.pauseMin).toBeGreaterThan(0);
    expect(PACES.fast.mouseMoves).toBeGreaterThan(0);
  });
  it("profiles are ordered fast < human < careful", () => {
    const order: Array<keyof typeof PACES> = ["fast", "human", "careful"];
    for (let i = 1; i < order.length; i++) {
      expect(PACES[order[i]].pauseMax).toBeGreaterThan(PACES[order[i - 1]].pauseMax);
      expect(PACES[order[i]].typeMax).toBeGreaterThan(PACES[order[i - 1]].typeMax);
      expect(PACES[order[i]].settleTimeoutMs).toBeGreaterThan(PACES[order[i - 1]].settleTimeoutMs);
    }
  });
});

describe("classifyNetworkError", () => {
  it("names a proxy that rejects our credentials", () => {
    // The real failure: loadProxies used to drop user:pass, so Chrome got a 407
    // on the very first navigation and the batch reported only "UNKNOWN".
    const r = classifyNetworkError(
      "net::ERR_INVALID_AUTH_CREDENTIALS at https://www.codebuddy.ai/pricing",
      "http://1.2.3.4:6754",
    );
    expect(r?.code).toBe("PROXY_AUTH_FAILED");
    expect(r?.message).toContain("1.2.3.4:6754");
  });
  it("names a proxy that cannot be reached", () => {
    expect(classifyNetworkError("net::ERR_TUNNEL_CONNECTION_FAILED", "http://1.2.3.4:1")?.code).toBe(
      "PROXY_UNREACHABLE",
    );
    expect(classifyNetworkError("net::ERR_PROXY_CONNECTION_FAILED")?.code).toBe("PROXY_UNREACHABLE");
  });
  it("separates our own connection being down", () => {
    expect(classifyNetworkError("net::ERR_INTERNET_DISCONNECTED")?.code).toBe("NETWORK_DOWN");
  });
  it("leaves anything it does not recognise alone", () => {
    expect(classifyNetworkError("complete-signup form not found after OAuth")).toBeNull();
    expect(classifyNetworkError("net::ERR_ABORTED")).toBeNull();
  });
});
