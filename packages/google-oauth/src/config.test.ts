import { describe, it, expect } from "bun:test";
import { resolveGoogleOAuthOptions } from "./config.js";
import { isGoogleUrl } from "./googleAuth.js";
import { randomInt, humanPause, normalizeText, sanitizeFileName } from "./utils.js";

describe("config", () => {
  it("applies defaults and overrides", () => {
    const cfg = resolveGoogleOAuthOptions({ consentTimeoutMs: 5000, headless: true });
    expect(cfg.consentTimeoutMs).toBe(5000);
    expect(cfg.headless).toBe(true);
    expect(cfg.failOnCaptcha).toBe(true); // default
  });
});

describe("googleAuth", () => {
  it("detects google urls", () => {
    expect(isGoogleUrl("https://accounts.google.com/signin/oauth")).toBe(true);
    expect(isGoogleUrl("https://accounts.google.com/o/oauth2/v2/auth")).toBe(true);
    expect(isGoogleUrl("https://www.codebuddy.ai/pricing")).toBe(false);
  });
});

describe("utils", () => {
  it("normalizeText lowercases and collapses whitespace", () => {
    expect(normalizeText("  Sign   In With Google ")).toBe("sign in with google");
  });
  it("randomInt respects bounds", () => {
    for (let i = 0; i < 100; i++) {
      const v = randomInt(1, 3);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(3);
    }
  });
  it("sanitizeFileName removes illegal chars", () => {
    expect(sanitizeFileName("alex@x.com:pass")).toBe("alex_x.com_pass");
  });
  it("humanPause resolves within a tight range", async () => {
    const t0 = Date.now();
    await humanPause(5, 10);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});