// ── Per-account runner for Zro MoonMath ─────────────────────────────
import { launchGoogleOAuthBrowser, TempMailClient } from "@ifqy/google-oauth";
import { randomBytes } from "node:crypto";
import type { ZroMoonmathConfig } from "./config.js";
import { createLog } from "./log.js";
import { FlowState, type AccountRecord, type JsonlStore, type ResultWriter } from "./store.js";
import { runZroMoonmathFlow } from "./flow/engine.js";
import type { AccountSession } from "./flow/steps.js";

const FINGERPRINT_PROFILES = [
  {
    os: "Windows",
    platform: "Win32",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    languages: ["en-US", "en"],
    cores: 8,
    memory: 8,
  },
  {
    os: "macOS",
    platform: "MacIntel",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    languages: ["en-US", "en"],
    cores: 8,
    memory: 16,
  },
  {
    os: "Linux",
    platform: "Linux x86_64",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    languages: ["en-US", "en"],
    cores: 12,
    memory: 16,
  },
  {
    os: "Windows",
    platform: "Win32",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    languages: ["en-US", "en"],
    cores: 16,
    memory: 32,
  },
  {
    os: "macOS",
    platform: "MacIntel",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    languages: ["en-US", "en"],
    cores: 10,
    memory: 16,
  },
];

const RESOLUTIONS = [
  { w: 1920, h: 1080 },
  { w: 1536, h: 864 },
  { w: 1440, h: 900 },
  { w: 1366, h: 768 },
  { w: 1280, h: 800 },
];

let accountFpIndex = 0;
export function getUniqueAccountFingerprint() {
  const profile = FINGERPRINT_PROFILES[accountFpIndex % FINGERPRINT_PROFILES.length]!;
  accountFpIndex++;
  const baseRes = RESOLUTIONS[Math.floor(Math.random() * RESOLUTIONS.length)]!;
  const jitterW = Math.max(1024, baseRes.w - Math.floor(Math.random() * 80));
  const jitterH = Math.max(700, baseRes.h - Math.floor(Math.random() * 80));
  return {
    ...profile,
    viewport: { width: jitterW, height: jitterH },
    hash: `${profile.os}_${jitterW}x${jitterH}_${profile.cores}c_${randomBytes(4).toString("hex")}`,
  };
}

function parseProxyString(proxyStr: string | null | undefined) {
  if (!proxyStr) return null;
  try {
    let norm = proxyStr.trim();
    if (!norm.includes("://")) {
      const parts = norm.split(":");
      if (parts.length === 4) {
        norm = `http://${encodeURIComponent(parts[2]!)}:${encodeURIComponent(parts[3]!)}@${parts[0]}:${parts[1]}`;
      } else {
        norm = `http://${norm}`;
      }
    }
    const u = new URL(norm);
    let port = u.port;
    if (!port) {
      const authority = norm.split("://")[1]?.split("/")[0] || "";
      const hostPart = authority.includes("@") ? authority.split("@")[1]! : authority;
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

export async function runZroMoonmathAccount(
  givenAccount: { email?: string; password?: string } | null,
  proxyStr: string | null,
  store: JsonlStore,
  results: ResultWriter,
  cfg: ZroMoonmathConfig,
): Promise<{ success: boolean; email: string; apiKey?: string; error?: string }> {
  const tempMail = new TempMailClient({
    apiKey: cfg.tempMailApiKey,
    baseUrl: cfg.tempMailBaseUrl,
    defaultDomain: cfg.tempMailDomain,
  });

  // 1. Resolve email & password (generate via TempMail if none provided)
  if (givenAccount?.email) {
    const norm = givenAccount.email.trim().toLowerCase();
    if (results.getSuccessfulEmails().has(norm) || store.get(norm)?.status === FlowState.DONE) {
      createLog({ email: givenAccount.email })(
        "info",
        `safeguard: email ${givenAccount.email} already exists in results/state. Skipping.`,
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

  store.upsert({
    email,
    password,
    status: FlowState.PENDING,
    fingerprint: fp.hash,
    proxy: proxyStr ?? undefined,
    updatedAt: Date.now(),
  } as AccountRecord);

  const proxySpec = parseProxyString(proxyStr);
  log("info", "launching browser with randomized fingerprint for Zro MoonMath account", {
    email,
    proxy: proxySpec ? proxySpec.server : "direct",
    os: fp.os,
    viewport: `${fp.viewport.width}x${fp.viewport.height}`,
    cores: fp.cores,
    memory: `${fp.memory}GB`,
    headless: cfg.headless,
  });

  let handle: Awaited<ReturnType<typeof launchGoogleOAuthBrowser>> | null = null;
  try {
    handle = await launchGoogleOAuthBrowser({
      proxy: proxySpec,
      headless: cfg.headless,
      opts: {
        screenShotDir: cfg.screenshotDir,
      },
    });

    // Apply unique per-account fingerprint overrides to the page
    await handle.page.setUserAgent(fp.userAgent);
    await handle.page.setViewport(fp.viewport);
    await handle.page.evaluateOnNewDocument((f) => {
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => f.cores });
      Object.defineProperty(navigator, "deviceMemory", { get: () => f.memory });
      Object.defineProperty(navigator, "platform", { get: () => f.platform });
      Object.defineProperty(navigator, "languages", { get: () => f.languages });
    }, fp);

    log("info", `🛡️ Active Account Fingerprint applied: OS=${fp.os} | Viewport=${fp.viewport.width}x${fp.viewport.height} | Cores=${fp.cores} | Memory=${fp.memory}GB | UA=${fp.userAgent.slice(0, 45)}...`);

    const session: AccountSession = { email, password };
    const res = await runZroMoonmathFlow(handle.page, session, cfg, store, results, tempMail, log);
    return { success: res.success, email, apiKey: res.apiKey, error: res.error };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    log("error", "fatal runner error", { email, error: msg });
    store.setStatus(email, FlowState.FAILED, msg);
    results.markFailed(email, msg);
    return { success: false, email, error: msg };
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}
