// ── Per-account runner for ChatGPT (Bun / Puppeteer engine) ─────────
import { launchGoogleOAuthBrowser, TempMailClient } from "@ifqy/google-oauth";
import { randomBytes } from "node:crypto";
import type { GptConfig } from "./config.js";
import { createLog } from "./log.js";
import { FlowState, type AccountRecord, type JsonlStore, type ResultWriter } from "./store.js";
import { runGptFlow } from "./flow/engine.js";

const POPULAR_RESOLUTIONS = [
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1280, height: 800 },
  { width: 1600, height: 900 },
];

export function getUniqueAccountFingerprint(): { width: number; height: number; userAgent: string } {
  const res = POPULAR_RESOLUTIONS[Math.floor(Math.random() * POPULAR_RESOLUTIONS.length)];
  const jitterW = Math.max(1024, res.width - Math.floor(Math.random() * 100));
  const jitterH = Math.max(700, res.height - Math.floor(Math.random() * 80));
  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  ];
  const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
  return { width: jitterW, height: jitterH, userAgent };
}

function parseProxyString(proxyStr: string | null | undefined) {
  if (!proxyStr) return null;
  try {
    let norm = proxyStr.trim();
    if (!norm.includes("://")) {
      const parts = norm.split(":");
      if (parts.length === 4) {
        norm = `http://${encodeURIComponent(parts[2])}:${encodeURIComponent(parts[3])}@${parts[0]}:${parts[1]}`;
      } else {
        norm = `http://${norm}`;
      }
    }
    const u = new URL(norm);
    let port = u.port;
    if (!port) {
      const authority = norm.split("://")[1]?.split("/")[0] || "";
      const hostPart = authority.includes("@") ? authority.split("@")[1] : authority;
      const m = hostPart.match(/:(\d+)$/);
      if (m) port = m[1];
    }
    let protocol = u.protocol.toLowerCase();
    if (protocol === "socks5h:" || protocol === "socks5:") {
      protocol = "socks5:";
    } else if (protocol === "socks4a:" || protocol === "socks4:" || protocol === "socks:") {
      protocol = "socks4:";
    }
    return {
      server: port ? `${protocol}//${u.hostname}:${port}` : `${protocol}//${u.host}`,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } catch {
    return { server: proxyStr };
  }
}

export async function runGptAccount(
  givenAccount: { email?: string; password?: string } | null,
  proxyStr: string | null,
  store: JsonlStore,
  results: ResultWriter,
  cfg: GptConfig,
): Promise<{ success: boolean; email: string; error?: string }> {
  const tempMail = new TempMailClient({
    apiKey: cfg.tempMailApiKey,
    baseUrl: cfg.tempMailBaseUrl,
    defaultDomain: cfg.tempMailDomain,
  });

  // 1. Resolve email & password
  if (givenAccount?.email) {
    const norm = givenAccount.email.trim().toLowerCase();
    if (results.getSuccessfulEmails().has(norm) || store.get(norm)?.status === FlowState.DONE) {
      createLog({ email: givenAccount.email })(
        "info",
        `safeguard: email ${givenAccount.email} sudah terdaftar di result file / state. Melewati akun tanpa proses ulang.`,
      );
      return { success: true, email: givenAccount.email };
    }
  }

  let email = givenAccount?.email;
  const password = givenAccount?.password || cfg.defaultPassword;

  if (!email) {
    const created = await tempMail.createEmail(cfg.tempMailDomain);
    email = created.email;
  }

  const log = createLog({ email });
  const fp = getUniqueAccountFingerprint();
  const fingerprint = randomBytes(6).toString("hex");

  store.upsert({
    email,
    password,
    status: FlowState.PENDING,
    fingerprint,
    proxy: proxyStr ?? undefined,
    updatedAt: Date.now(),
  } as AccountRecord);

  const proxySpec = parseProxyString(proxyStr);
  log("info", "launching browser for ChatGPT account", {
    email,
    proxy: proxySpec ? proxySpec.server : "direct",
    viewport: `${fp.width}x${fp.height}`,
    headless: cfg.headless,
  });

  let handle: Awaited<ReturnType<typeof launchGoogleOAuthBrowser>> | null = null;
  try {
    handle = await launchGoogleOAuthBrowser({
      headless: cfg.headless,
      proxy: proxySpec ? { server: proxySpec.server } : undefined,
      viewport: { width: fp.width, height: fp.height },
      userAgent: fp.userAgent,
    });

    const page = handle.page;
    if (proxySpec?.username && proxySpec?.password) {
      await page.authenticate({
        username: proxySpec.username,
        password: proxySpec.password,
      });
    }

    const res = await runGptFlow(page, email, password, tempMail, store, cfg, log);

    if (res.success) {
      results.recordSuccess(email, password);
      log("info", `ChatGPT account successfully created & prompt executed: ${email}:${password}`);
      return { success: true, email };
    } else {
      results.recordFailed(email, res.error, password);
      log("error", `ChatGPT account creation failed for ${email}: ${res.error}`);
      return { success: false, email, error: res.error };
    }
  } catch (e: any) {
    const errorMsg = e?.message || String(e);
    results.recordFailed(email, errorMsg, password);
    log("error", `Fatal error during ChatGPT account creation for ${email}: ${errorMsg}`);
    return { success: false, email, error: errorMsg };
  } finally {
    if (handle) {
      try {
        await handle.browser.close();
      } catch {}
    }
  }
}
