// ── Webshare flow steps ────────────────────────────────────────────
// 1. /register/?start_google_login_flow=  →  Google OAuth (top-level redirect)
// 2. dashboard  →  proxy list  →  read the free proxies from the app's own API
// (validated against webshare_dataset/*.html and the live app bundle)
import fs from "node:fs";
import type { HTTPRequest, Page } from "puppeteer-core";
import {
  performGoogleOAuth,
  isGoogleUrl,
  isAccountRestricted,
  dom,
  utils,
  resolvePace,
} from "@ifqy/google-oauth";
import { FlowState, type ProxyRecord } from "../store.js";
import { FlowError, type FlowCtx } from "./engine.js";
import { Selectors, isUsableProxyRow, type ApiProxyRow } from "./selectors.js";

const { safeClick, waitForAnySelector } = dom;
const { sleep, randomInt } = utils;

const shot = (email: string) => email.replace(/[^a-z0-9]/gi, "_");

/** Wait for a predicate on the page URL. */
async function waitForUrl(
  page: Page,
  test: (url: string) => boolean,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!page.isClosed() && test(page.url())) return true;
    await sleep(pollMs);
  }
  return false;
}

// ── s01: register via Google (redirect mode, never the popup button) ──
export async function s01Signup(ctx: FlowCtx): Promise<FlowState> {
  const { browser, account, googleOAuth, cfg, log } = ctx;
  const pace = resolvePace(cfg.pace);
  const page = browser.page;
  ctx.appPageRef.current = page;

  await page.goto(Selectors.signupUrl, { waitUntil: "domcontentloaded" });

  // The page redirects itself to accounts.google.com; no click needed. If it
  // has not moved, the auto-start did not fire (query shape changed, or the
  // GSI script was blocked) — fall back to the button before giving up.
  let onGoogle = await waitForUrl(page, isGoogleUrl, 20_000, pace.pollMs);
  if (!onGoogle) {
    log("warn", "auto redirect to google did not fire — falling back to the signup button");
    const btn = await waitForAnySelector(page, Selectors.signUpGoogleButton, 10_000);
    if (btn) {
      await safeClick(page, btn);
      await btn.dispose().catch(() => {});
      onGoogle = await waitForUrl(page, isGoogleUrl, 20_000, pace.pollMs);
    }
  }
  if (!onGoogle) {
    await page.screenshot({ path: `${cfg.screenshotDir}/no-google-${shot(account.email)}.png` }).catch(() => {});
    throw new FlowError("NO_GOOGLE_REDIRECT", "register page never reached google sign-in");
  }

  const { code } = await performGoogleOAuth(page, browser.context, {
    email: account.email,
    password: account.password,
  }, { ...googleOAuth, screenShotDir: cfg.screenshotDir });
  if (code !== "OK") throw new FlowError("GOOGLE_OAUTH_FAILED", `oauth code: ${code}`);

  // Back on webshare: the app exchanges the code, then routes to the
  // dashboard. Until it does we are still on /register or /login.
  const app = ctx.appPageRef.current ?? page;
  const landed = await waitForUrl(
    app,
    (u) => Selectors.dashboardUrlRe.test(u) || /dashboard\.webshare\.io\/auth\/google/.test(u),
    cfg.dashboardTimeoutSec * 1000,
    pace.pollMs,
  );
  if (!landed) {
    if (await isAccountRestricted(app)) {
      throw new FlowError("ACCOUNT_RESTRICTED", "account restricted by risk control (post-oauth)");
    }
    await app.screenshot({ path: `${cfg.screenshotDir}/no-dashboard-${shot(account.email)}.png` }).catch(() => {});
    throw new FlowError("NO_DASHBOARD", `stuck after oauth at ${app.url().slice(0, 120)}`);
  }

  // /auth/google is the code-exchange hop, not a destination.
  await waitForUrl(app, (u) => Selectors.dashboardUrlRe.test(u), 30_000, pace.pollMs);
  log("info", `signed up via google — dashboard reached (${app.url().slice(0, 80)})`);
  return FlowState.PROXY_LIST;
}

// ── s02: harvest the free proxies ──────────────────────────────────
export async function s02ProxyList(ctx: FlowCtx): Promise<FlowState> {
  const { account, cfg, log, proxiesRef, apiRef } = ctx;
  const pace = resolvePace(cfg.pace);
  const page = ctx.appPageRef.current ?? ctx.browser.page;
  await page.bringToFront().catch(() => {});

  const collected = new Map<string, ProxyRecord>();

  // Read the app's own API traffic. This needs no token of ours and no table
  // scraping: whatever the dashboard is authorised to see, we see.
  const onResponse = async (res: {
    url: () => string;
    request: () => HTTPRequest;
    json: () => Promise<unknown>;
  }) => {
    const url = res.url();
    if (!Selectors.proxyApiRe.test(url)) return;
    // Any API call carries the token; the list call may never be the first.
    const auth = res.request().headers()["authorization"];
    if (auth && !apiRef.current) {
      apiRef.current = { url: Selectors.proxyListApiUrl, authorization: auth };
    }
    if (!Selectors.proxyListApiRe.test(url)) return;
    const body = (await res.json().catch(() => null)) as { results?: ApiProxyRow[] } | null;
    for (const row of body?.results ?? []) {
      if (!isUsableProxyRow(row)) continue;
      collected.set(`${row.proxy_address}:${row.port}`, {
        address: row.proxy_address!,
        port: row.port!,
        username: row.username ?? "",
        password: row.password ?? "",
      });
    }
  };
  page.on("response", onResponse as never);

  try {
    // The proxy list lives at /$planId/proxy/list, and the plan id only exists
    // once the account has one. Take it from the sidebar link.
    const link = await waitForAnySelector(page, [Selectors.proxyListLink], cfg.dashboardTimeoutSec * 1000);
    if (!link) {
      await page.screenshot({ path: `${cfg.screenshotDir}/no-proxy-link-${shot(account.email)}.png` }).catch(() => {});
      throw new FlowError("NO_PROXY_LIST_LINK", "proxy list link never appeared on the dashboard");
    }
    const href = (await link.evaluate((el) => el.getAttribute("href") ?? "").catch(() => "")) ?? "";
    await link.dispose().catch(() => {});
    const planId = href.match(Selectors.planIdFromHrefRe)?.[1];
    const listUrl = planId
      ? `https://dashboard.webshare.io/${planId}/proxy/list`
      : new URL(href, "https://dashboard.webshare.io").toString();
    log("info", `opening proxy list${planId ? ` (plan ${planId})` : ""}`);

    await page.goto(listUrl, { waitUntil: "domcontentloaded" });
    await sleep(randomInt(pace.stepPauseMin, pace.stepPauseMax));

    // Wait for the page to have asked its API at least once.
    const deadline = Date.now() + cfg.proxyListTimeoutSec * 1000;
    while (Date.now() < deadline && collected.size === 0 && !apiRef.current) {
      await sleep(pace.pollMs);
    }

    // Re-ask the same endpoint ourselves with explicit query params. The UI
    // may be showing the rotating endpoint or a short page; mode=direct with a
    // full page size is what actually yields the free proxy list. Retry while
    // there is time left: on a brand new account the plan can still be
    // provisioning when the dashboard first paints.
    while (Date.now() < deadline) {
      if (apiRef.current) {
        const direct = await fetchProxyList(apiRef.current, log);
        for (const p of direct) collected.set(`${p.address}:${p.port}`, p);
      }
      if (collected.size > 0) break;
      log("info", "proxy list still empty — waiting for the plan to provision");
      await sleep(Math.max(pace.pollMs, 2000));
    }

    if (collected.size === 0) {
      const stem = `${cfg.screenshotDir}/no-proxies-${shot(account.email)}`;
      await page.screenshot({ path: `${stem}.png` }).catch(() => {});
      await page.content().then((html) => fs.writeFileSync(`${stem}.html`, html, "utf8")).catch(() => {});
      throw new FlowError("NO_PROXIES", `proxy list returned nothing — page dumped to ${stem}.html`);
    }
  } finally {
    page.off("response", onResponse as never);
  }

  proxiesRef.current = [...collected.values()];
  log("info", `harvested ${proxiesRef.current.length} proxies for ${account.email}`);
  return FlowState.DONE;
}

/**
 * Ask the app's own proxy-list endpoint directly, reusing the Authorization
 * header it just used. Runs in Node, so there is no CORS to fight, and it lets
 * us page past whatever the UI decided to render.
 */
async function fetchProxyList(
  api: { url: string; authorization: string },
  log: FlowCtx["log"],
): Promise<ProxyRecord[]> {
  const out: ProxyRecord[] = [];
  const base = (() => {
    try {
      return new URL(api.url);
    } catch {
      return new URL(Selectors.proxyListApiUrl);
    }
  })();

  for (let pageNo = 1; pageNo <= 5; pageNo++) {
    const url = new URL(base.toString());
    url.search = "";
    url.searchParams.set("mode", "direct");
    url.searchParams.set("page", String(pageNo));
    url.searchParams.set("page_size", "100");
    const res = await fetch(url, {
      headers: { Authorization: api.authorization, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    }).catch((e: Error) => {
      log("warn", `proxy list api call failed: ${e.message.slice(0, 80)}`);
      return null;
    });
    if (!res?.ok) {
      if (res) log("warn", `proxy list api returned ${res.status}`);
      break;
    }
    const body = (await res.json().catch(() => null)) as
      | { count?: number; next?: string | null; results?: ApiProxyRow[] }
      | null;
    for (const row of body?.results ?? []) {
      if (!isUsableProxyRow(row)) continue;
      out.push({
        address: row.proxy_address!,
        port: row.port!,
        username: row.username ?? "",
        password: row.password ?? "",
      });
    }
    if (!body?.next) break;
  }
  return out;
}

export const STEPS: Record<string, (ctx: FlowCtx) => Promise<FlowState>> = {
  [FlowState.SIGNUP]: s01Signup,
  [FlowState.PROXY_LIST]: s02ProxyList,
};
