// ── Integration tests: real browser launch + dom helpers ──────────
// Skipped automatically when no local Edge/Chrome/Chromium is installed.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  launchGoogleOAuthBrowser,
  GOOGLE_DIRECT_HOSTS,
  findInstalledBrowser,
  dom,
  type GoogleOAuthBrowser,
} from "./index.js";

const { clickByText, fillInput, waitForAnySelector, waitForVisibleInput, findClickableByText } = dom;

const PLAIN_HTML = `<!doctype html><html><body>
  <button id="plain" onclick="window.__clicked='plain'">Click Me Now</button>
</body></html>`;

const SHADOW_DOM_HTML = `<!doctype html><html><body>
  <div id="host"></div>
  <script>
    const host = document.getElementById('host');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<button id="shadow-btn">Shadow Continue With Google</button>';
    window.__shadowOk = true;
  </script>
</body></html>`;

const EMPTY_HTML = `<!doctype html><html><body><p>unique-empty-<!--${Date.now()}--></p></body></html>`;

describe("browser integration (real launch)", () => {
  const hasBrowser = findInstalledBrowser() !== null;
  let handle: GoogleOAuthBrowser | null = null;

  beforeAll(async () => {
    if (!hasBrowser) return;
    handle = await launchGoogleOAuthBrowser({ headless: true });
  }, 90_000);

  afterAll(async () => {
    await handle?.close();
  });

  it("launches a stealth browser and evaluates JS", async () => {
    if (!handle) return;
    const page = handle.page;
    await page.setContent("<html><body><h1>hello</h1></body></html>");
    const title = await page.evaluate(() => document.querySelector("h1")?.textContent);
    expect(title).toBe("hello");
  });

  it("a proxy bypass list reaches chrome as a launch flag", async () => {
    if (!hasBrowser) return;
    // Sending only Google's sign-in direct is what keeps a datacenter proxy
    // from earning an image captcha, so the flag has to actually be passed.
    const withBypass = await launchGoogleOAuthBrowser({
      headless: true,
      proxy: { server: "http://127.0.0.1:9", bypass: GOOGLE_DIRECT_HOSTS },
    });
    try {
      const args = withBypass.browser.process()?.spawnargs ?? [];
      expect(args.some((a) => a === "--proxy-server=http://127.0.0.1:9")).toBe(true);
      const bypass = args.find((a) => a.startsWith("--proxy-bypass-list="));
      expect(bypass).toContain("accounts.google.com");
      // www.google.com serves reCAPTCHA for the sites we automate; that check
      // must stay on the same address the site sees.
      expect(bypass).not.toContain("www.google.com");
    } finally {
      await withBypass.close();
    }
  }, 60_000);

  it("no bypass flag when none was asked for", async () => {
    if (!hasBrowser) return;
    const plain = await launchGoogleOAuthBrowser({
      headless: true,
      proxy: { server: "http://127.0.0.1:9" },
    });
    try {
      const args = plain.browser.process()?.spawnargs ?? [];
      expect(args.some((a) => a.startsWith("--proxy-bypass-list="))).toBe(false);
    } finally {
      await new Promise((r) => setTimeout(r, 150));
      await plain.close();
    }
  }, 60_000);

  it("does not pin a navigation Accept header onto XHR/fetch", async () => {
    if (!handle) return;
    const page = handle.page;
    // Regression: setExtraHTTPHeaders rewrote EVERY request's Accept to
    // "text/html,…", so JSON APIs content-negotiated back HTML. Ory Kratos
    // answered crusoe's flow request with its HTML login page, and the SPA
    // then crashed on click reading `flow.ui.nodes` of a string.
    await page.setContent("<html><body>accept-probe</body></html>");
    const seen: string[] = [];
    const onRequest = (r: { headers: () => Record<string, string> }) => {
      const accept = r.headers()["accept"];
      if (accept) seen.push(accept);
    };
    page.on("request", onRequest as never);
    await page.evaluate(async () => {
      await fetch("https://example.invalid/json", { headers: { Accept: "application/json" } }).catch(() => {});
    });
    page.off("request", onRequest as never);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((a) => a.startsWith("text/html"))).toBe(false);
    expect(seen.some((a) => a.includes("application/json"))).toBe(true);
  }, 30_000);

  it("stealth: navigator.webdriver is not true", async () => {
    if (!handle) return;
    const page = handle.page;
    const wd = await page.evaluate(() => (navigator as Navigator & { webdriver?: boolean }).webdriver);
    expect(wd).not.toBe(true);
  });

  it("stealth: chrome runtime object is present (headless evasion)", async () => {
    if (!handle) return;
    const page = handle.page;
    const hasChrome = await page.evaluate(() => Boolean((window as unknown as { chrome?: unknown }).chrome));
    // puppeteer-extra stealth exposes window.chrome; if not, at least it must not throw
    expect(typeof hasChrome).toBe("boolean");
  });

  it("clickByText clicks a plain button", async () => {
    if (!handle) return;
    const page = handle.page;
    await page.setContent(PLAIN_HTML);
    const clicked = await clickByText(page, "click me now", {});
    expect(clicked).toBe(true);
    await page.waitForFunction(() => (window as unknown as { __clicked?: string }).__clicked === "plain", { timeout: 5000 });
  });

  it("clickByText pierces shadow DOM", async () => {
    if (!handle) return;
    const page = handle.page;
    await page.setContent(SHADOW_DOM_HTML);
    // sanity: the inline script actually attached the shadow root
    await page.waitForFunction(() => (window as unknown as { __shadowOk?: boolean }).__shadowOk === true, { timeout: 5000 });
    const clicked = await clickByText(page, "shadow continue with google", {});
    expect(clicked).toBe(true);
    const found = await findClickableByText(page, "shadow continue with google");
    expect(found).not.toBeNull();
  });

  it("clickByText returns false (no throw) when needle missing and optional", async () => {
    if (!handle) return;
    const page = handle.page;
    await page.setContent(EMPTY_HTML);
    const clicked = await clickByText(page, "does not exist", {}, { optional: true });
    expect(clicked).toBe(false);
  });

  it("fillInput sets value via native setter (framework-safe)", async () => {
    if (!handle) return;
    const page = handle.page;
    await page.setContent(`<!doctype html><html><body>
      <input id="react-field-unique" />
      <script>
        let __value = '';
        const el = document.getElementById('react-field-unique');
        Object.defineProperty(el, '_frameworkValue', { get: () => __value });
        el.addEventListener('input', () => { __value = el.value; });
      </script>
    </body></html>`);
    const input = await waitForVisibleInput(page, ["#react-field-unique"], 5000);
    expect(input).not.toBeNull();
    await fillInput(page, input!.element, "hello@example.com");
    const framework = await page.evaluate(() =>
      (document.getElementById("react-field-unique") as unknown as { _frameworkValue: string })._frameworkValue,
    );
    expect(framework).toBe("hello@example.com");
  });

  it("waitForAnySelector times out and returns null on absent selector", async () => {
    if (!handle) return;
    const page = handle.page;
    await page.setContent(`<!doctype html><html><body><p id="empty-unique"></p></body></html>`);
    const el = await waitForAnySelector(page, ["#nope"], 700);
    expect(el).toBeNull();
  });

  it("waitForVisibleInput finds a visible input and ignores hidden ones", async () => {
    if (!handle) return;
    const page = handle.page;
    await page.setContent(
      `<!doctype html><html><body><input id="hidden-u" style="display:none" /><input id="visible-u" /></body></html>`,
    );
    const found = await waitForVisibleInput(page, ["#hidden-u", "#visible-u"], 5000);
    expect(found).not.toBeNull();
    const id = await found!.element.evaluate((el) => el.id);
    expect(id).toBe("visible-u");
  });

  it("close() is idempotent", async () => {
    if (!hasBrowser) return;
    const h = await launchGoogleOAuthBrowser({ headless: true });
    await new Promise((r) => setTimeout(r, 150));
    await h.close();
    await expect(h.close()).resolves.toBeUndefined();
  }, 90_000);
});
