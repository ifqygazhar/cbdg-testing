// ── Browser launcher: Puppeteer Extra + Stealth (Bun) ──────────────
// Ported from cline-regist/cline/browser.js, but returns a handle so the
// caller controls lifecycle (critical for the "close browser per account
// → new fingerprint next account" requirement).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Browser, Page } from "puppeteer-core";
import { getRandomViewport } from "./antiDetect.js";
import type { GoogleOAuthOptions } from "./config.js";

export interface ProxySpec {
  server: string; // e.g. http://host:port  (or socks5://...)
  username?: string;
  password?: string;
}

/**
 * Chrome reports proxy trouble as a bare `net::ERR_*` on the first navigation,
 * which reaches a caller as an unhelpful "UNKNOWN" failure. Translate the ones
 * that have an obvious fix so a batch says what to do instead of what broke.
 */
export function classifyNetworkError(
  message: string,
  proxyServer?: string | null,
): { code: string; message: string } | null {
  const where = proxyServer ? ` (${proxyServer})` : "";
  if (/ERR_INVALID_AUTH_CREDENTIALS|ERR_PROXY_AUTH_REQUESTED|407/.test(message)) {
    return {
      code: "PROXY_AUTH_FAILED",
      message: `proxy menolak kredensial${where} — cek user/pass di file proxy`,
    };
  }
  if (
    /ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ERR_SOCKS_CONNECTION_FAILED/.test(
      message,
    )
  ) {
    return {
      code: "PROXY_UNREACHABLE",
      message: `proxy tidak bisa dipakai${where} — jalankan \`bun run proxy-check\` lalu ulangi`,
    };
  }
  if (/ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED/.test(message)) {
    return { code: "NETWORK_DOWN", message: `koneksi tidak tersedia${where}` };
  }
  return null;
}

export interface GoogleOAuthBrowser {
  browser: Browser;
  context: Awaited<ReturnType<Browser["createBrowserContext"]>>;
  /** convenience primary page of the fresh context */
  page: Page;
  screenshot(page: Page, filePath: string): Promise<void>;
  close(): Promise<void>;
}

export function findInstalledBrowser(): { path: string; name: string } | null {
  const platform = os.platform();
  let candidates: string[] = [];

  if (platform === "win32") {
    candidates = [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ];
  } else if (platform === "linux") {
    candidates = [
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
      "/snap/bin/chromium",
    ];
  } else if (platform === "darwin") {
    candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return { path: p, name: path.basename(p).replace(/\.exe$/i, "") };
  }
  return null;
}

async function getPuppeteer(): Promise<typeof import("puppeteer-extra").default> {
  const mod = await import("puppeteer-extra");
  const { default: StealthPlugin } = await import("puppeteer-extra-plugin-stealth");
  (mod.default as any).use(StealthPlugin());
  return mod.default;
}

export interface LaunchGoogleOAuthBrowserOptions {
  proxy?: ProxySpec | null;
  headless?: boolean;
  opts?: GoogleOAuthOptions;
  screenshotOnError?: boolean;
  /**
   * Launch with --disable-web-security. Off by default: it changes CORS and
   * cookie behaviour (so an app can misbehave here while working in a normal
   * browser) and Chrome flags the session as unsupported. Only turn it on for
   * a site that provably needs it.
   */
  disableWebSecurity?: boolean;
  /** extra Chrome flags appended verbatim */
  extraArgs?: string[];
}

export async function launchGoogleOAuthBrowser(
  options: LaunchGoogleOAuthBrowserOptions = {},
): Promise<GoogleOAuthBrowser> {
  const headless = options.headless ?? options.opts?.headless ?? false;
  const screenshotOnError = options.screenshotOnError ?? true;
  const puppeteer = await getPuppeteer();
  const viewport = getRandomViewport();
  const found = findInstalledBrowser();

  const launchOpts: Record<string, unknown> = {
    headless: headless ? "new" : false,
    viewport,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-ipc-flooding-protection",
      "--disable-hang-monitor",
      "--disable-prompt-on-repost",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--safebrowsing-disable-auto-update",
      "--password-store=basic",
      "--use-mock-keychain",
      "--hide-crash-restore-bubble",
      "--disable-notifications",
      "--disable-popup-blocking",
      "--disable-webrtc-hw-decoding",
      "--disable-webrtc-hw-encoding",
      "--disable-webrtc-multiple-routes",
      "--disable-webrtc-hw-vp8-encoding",
      `--window-size=${viewport.width},${viewport.height}`,
      "--lang=en-US",
    ] as string[],
    defaultViewport: viewport,
  };

  if (found) {
    launchOpts.executablePath = found.path;
    console.log(`[browser] Using: ${found.name} (${found.path})`);
  }

  if (options.disableWebSecurity) {
    (launchOpts.args as string[]).push("--disable-web-security");
  }
  if (options.extraArgs?.length) {
    (launchOpts.args as string[]).push(...options.extraArgs);
  }
  if (options.proxy) {
    (launchOpts.args as string[]).push(`--proxy-server=${options.proxy.server}`);
  }

  const browser = (await puppeteer.launch(launchOpts)) as Browser;
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.setDefaultNavigationTimeout(60_000);

  // Proxy authentication. Chrome's --proxy-server flag carries no credentials,
  // so the password goes through page.authenticate — and it is PER PAGE. A
  // proxy challenges every page it sees, and OAuth opens popups, so
  // authenticating only this first page leaves those popups dying with
  // ERR_INVALID_AUTH_CREDENTIALS.
  const proxyCreds = options.proxy?.username
    ? { username: options.proxy.username, password: options.proxy.password ?? "" }
    : null;
  if (proxyCreds) {
    await page.authenticate(proxyCreds);
    browser.on("targetcreated" as never, (async (target: {
      type: () => string;
      page: () => Promise<Page | null>;
      browserContext?: () => unknown;
    }) => {
      if (target.type() !== "page") return;
      if (typeof target.browserContext === "function" && target.browserContext() !== context) return;
      const opened = await target.page().catch(() => null);
      await opened?.authenticate(proxyCreds).catch(() => {});
    }) as never);
  }

  page.setViewport(viewport).catch(() => {});
  // Only headers that are genuinely constant per browser belong here.
  // setExtraHTTPHeaders applies to EVERY request, so pinning navigation-only
  // headers (Accept: text/html…, Upgrade-Insecure-Requests) also rewrites XHR
  // and fetch. That breaks content negotiation on real sites: Ory Kratos, for
  // one, answers `GET /self-service/login/browser` with a 303 to its HTML UI
  // instead of the flow JSON, so the SPA stores markup where a flow object
  // belongs and dies on the next click. Chrome already sends a correct,
  // realistic Accept per request type — leave it alone.
  page
    .setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      DNT: "1",
    })
    .catch(() => {});

  const supDir = path.resolve(options.opts?.screenShotDir ?? process.cwd() + "/screenshots");

  const h: GoogleOAuthBrowser = {
    browser,
    context,
    page,
    async screenshot(p: Page, filePath: string) {
      if (!screenshotOnError) return;
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        await p.screenshot({ path: filePath, fullPage: false });
        console.log(`[screenshot] Saved: ${filePath}`);
      } catch (e) {
        console.warn(`[screenshot] Failed: ${(e as Error).message}`);
      }
    },
    async close() {
      try {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
      } catch {
        /* ignore */
      }
    },
  };
  void supDir;
  return h;
}

// ── Screenshot path helper ──────────────────────────────────────────

export function screenshotPath(dir: string, email: string, stage: string): string {
  const safe = email.replace(/[^a-zA-Z0-9@._-]/g, "_");
  const ts = Date.now();
  return path.join(dir, `${safe}_${stage}_${ts}.png`);
}