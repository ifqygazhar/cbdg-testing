// ── Google OAuth flow (Bun + Puppeteer) ────────────────────────────
// Ported from cline-regist/cline/google-auth.js (which itself ports
// kiro/google-auth.js). Battle-tested against real GSuite accounts:
// email fill, password fill, consent, CAPTCHA detect, block detect.
// Uses frame-aware, shadow-DOM-piercing element search.

import type { Page, BrowserContext, ElementHandle } from "puppeteer-core";
import {
  resolveGoogleOAuthOptions,
  type GoogleOAuthOptions,
} from "./config.js";
import { resolvePace, type Pace } from "./pace.js";
import { sleep, randomInt, humanPause } from "./utils.js";
import {
  clickByText,
  findClickableByText,
  waitForAnySelector,
  waitForVisibleInput,
  focusInput,
  fillInput,
  safeClick,
  waitForSettledPage,
  withPopup,
  safeEvaluate,
  isTransientEvalError,
} from "./dom.js";
import { simulateHumanBehavior } from "./antiDetect.js";
import type { GoogleOAuthBrowser } from "./browser.js";
import { takeScreenshot, screenshotPath } from "./screenshot.js";

/** Pause with this call's pace (falls back to the "human" profile). */
function pause(opts: GoogleOAuthOptions = {}): Promise<void> {
  const pace = resolvePace(opts.pace);
  return humanPause(pace.pauseMin, pace.pauseMax);
}

/** Selectors that prove Google's sign-in surface is actually interactive. */
const GOOGLE_SIGNIN_READY = [
  'input[type="email"]',
  'input[name="identifier"]',
  "#identifierId",
  'input[type="password"]',
  'input[name="Passwd"]',
  "[data-identifier]",
];

/**
 * Wait until the page is usable, not until the network happens to go quiet.
 * waitForNetworkIdle alone burned its whole timeout on Google (long-poll and
 * telemetry keep the connection warm), costing ~30s per account for a page
 * that was ready in one.
 */
async function settlePage(
  page: Page,
  pace: Pace,
  selectors: string[] = GOOGLE_SIGNIN_READY,
): Promise<void> {
  await Promise.race([
    page
      .waitForNetworkIdle({ idleTime: pace.settleIdleMs, timeout: pace.settleTimeoutMs })
      .catch(() => {}),
    waitForAnySelector(page, selectors, pace.settleTimeoutMs).then(() => undefined),
  ]);
}

// ── Google URL detection ────────────────────────────────────────────

export function isGoogleUrl(url: string): boolean {
  return /accounts\.google\.com|google\.[^/]+\/signin/i.test(url);
}

export function isOnGoogleSignIn(page: Page): boolean {
  return isGoogleUrl(page.url());
}

export function findGooglePageIn(pages: Page[]): Page | null {
  return pages.find((p) => isGoogleUrl(p.url())) ?? null;
}

// ── Cookie/consent banners ──────────────────────────────────────────

const COOKIE_BANNER_RE =
  /cookie|consent|privasi|privacy preferences|gdpr|we use .{0,20}cookies/i;

/**
 * Dismiss a cookie/consent banner, and ONLY that.
 *
 * The old version clicked "continue" / "ok" / "accept" on any page. On sites
 * we had not tested that happily submits a wizard step or a half-filled form.
 * Now the page must actually mention cookies or consent first, and the generic
 * "continue"-style words are gone.
 */
export async function dismissCookieBanners(
  page: Page,
  opts: GoogleOAuthOptions = {},
): Promise<boolean> {
  const looksLikeBanner = await page
    .evaluate(
      (src) => new RegExp(src, "i").test(document.body?.innerText || ""),
      COOKIE_BANNER_RE.source,
    )
    .catch(() => false);
  if (!looksLikeBanner) return false;

  return clickByText(
    page,
    [
      "accept all cookies", "accept cookies", "allow all cookies",
      "accept all", "allow all", "agree to all", "got it",
      "terima semua", "setuju semua",
    ],
    opts,
    { optional: true },
  );
}

// ── Find Google provider trigger (frame + shadow-DOM aware) ────────

const EMBEDDED_AUTH_URL_RE = /\/auth\/realms\/[^/]+\/protocol\/openid-connect\/auth/;

export interface GoogleTrigger {
  element: ElementHandle<Element>;
  /**
   * Non-null when the button lives inside a sub-frame (embedded login
   * iframe, e.g. codebuddy's Keycloak `login-iframe`). Clicking it in-frame
   * dead-ends because the IdP redirect (accounts.google.com) refuses to be
   * framed — the caller should promote `subFrameUrl` to a top-level
   * navigation instead.
   */
  subFrameUrl: string | null;
}

export async function findGoogleTrigger(
  page: Page,
  log?: GoogleOAuthOptions["log"],
  retryOnNavigation = true,
): Promise<GoogleTrigger | null> {
  const main = page.mainFrame();
  let sawNavigatingFrame = false;
  for (const frame of page.frames()) {
    let handle;
    try {
      handle = await frame.evaluateHandle(() => {
        const needles = [
          "continue with google",
          "sign in with google",
          "sign up with google",
          "log in with google",
          "lanjutkan dengan google",
          "masuk dengan google",
          "daftar dengan google",
          "with google",
          "google",
        ];
        const norm = (v: unknown) => String(v || "").replace(/\s+/g, " ").trim().toLowerCase();
        const visible = (el: Element) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0" &&
            el.getAttribute("aria-disabled") !== "true" &&
            !el.hasAttribute("disabled")
          );
        };
        function deepCollect(selector: string): Element[] {
          const out: Element[] = [];
          const seen = new Set<Element>();
          const walk = (root: Document | ShadowRoot) => {
            let matches: Element[] = [];
            try { matches = Array.from(root.querySelectorAll(selector)); } catch { matches = []; }
            for (const el of matches) if (!seen.has(el)) { seen.add(el); out.push(el); }
            let all: Element[] = [];
            try { all = Array.from(root.querySelectorAll("*")); } catch { all = []; }
            for (const el of all) if (el.shadowRoot) walk(el.shadowRoot);
          };
          walk(document);
          return out;
        }
        const selector = [
          "button", "a", '[role="button"]',
          "input[type=button]", "input[type=submit]",
          "[data-provider]", "[jsname]",
        ].join(",");
        const els = deepCollect(selector);
        // 1. text / aria-label / img alt
        for (const el of els) {
          if (!visible(el)) continue;
          const img = el.querySelector("img");
          const text = norm(
            [
              el.textContent,
              el.getAttribute("aria-label"),
              el.getAttribute("title"),
              el.getAttribute("value"),
              el.getAttribute("data-provider"),
              el.getAttribute("data-method"),
              img && img.getAttribute("alt"),
            ].filter(Boolean).join(" "),
          );
          if (needles.some((n) => text.includes(n))) return el;
        }
        // 2. href / onclick target (OAuth links)
        for (const el of els) {
          if (!visible(el)) continue;
          const target = norm(
            [
              el.getAttribute("href"),
              el.getAttribute("data-href"),
              el.getAttribute("onclick"),
              (el.querySelector("img")?.getAttribute("src")) ?? "",
            ].filter(Boolean).join(" "),
          );
          if (
            /accounts\.google\.com|identity_provider=google|idp_?identifier|idp_?id=google|oauth2?.*google|google.*oauth|googleoauth/i.test(
              target,
            )
          ) {
            return el;
          }
        }
        return null;
      });
    } catch (e) {
      const transient = isTransientEvalError(e);
      sawNavigatingFrame = sawNavigatingFrame || transient;
      if (frame === main) {
        log?.(
          "info",
          `google trigger scan ${transient ? "hit a navigating frame" : "failed"} (main frame): ${(e as Error).message.slice(0, 100)}`,
        );
      }
      continue;
    }

    const element = handle.asElement() as ElementHandle<Element> | null;
    if (element) {
      return { element, subFrameUrl: frame === main ? null : frame.url() };
    }
    await handle.dispose().catch(() => {});
  }

  // A frame that navigated mid-scan destroys its execution context, so the
  // scan fails instantly and an existing button looks missing. Re-scan once
  // before reporting "no Google button here", which callers treat as a cue to
  // go looking somewhere else.
  if (sawNavigatingFrame && retryOnNavigation) {
    await sleep(300);
    return findGoogleTrigger(page, log, false);
  }
  return null;
}

/**
 * True when the page *text* already advertises a Google provider button even
 * though `findGoogleTrigger` could not grab the element (still mounting, or
 * the frame's execution context was swapped mid-scan). In that case the page
 * we want is already the right one — clicking generic "login / sign in" text
 * would navigate away from it and is never the correct move.
 */
async function pageMentionsGoogleProvider(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const res = await safeEvaluate<boolean>(frame, () =>
      /(with|dengan)\s+google/i.test(document.body?.innerText || ""),
    );
    if (res.ok && res.value) return true;
  }
  return false;
}

// ── Diagnostics: dump frames + body snippet when waiting ───────────

async function logFrameDiagnostics(
  page: Page,
  log: GoogleOAuthOptions["log"],
  reason: string,
): Promise<void> {
  try {
    const frames = page.frames();
    log?.("info", `${reason} — ${frames.length} frame(s):`);
    for (const f of frames) {
      const snippet = await f
        .evaluate(() =>
          (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120),
        )
        .catch(() => "<inaccessible>");
      log?.("info", `  · ${f.url().slice(0, 110)} :: ${snippet}`);
    }
  } catch {
    /* best-effort diagnostics */
  }
}

// ── Policy-confirm dialog (Keycloak social login) ─────────────────

/**
 * codebuddy's Keycloak login wraps social buttons with `handleSocialLogin`,
 * which preventDefaults the click and — until the policy is agreed — opens a
 * native `<dialog open>` ("Service Agreement and Privacy Terms", Confirm /
 * Cancel). Only the Confirm button (data-type="success") proceeds to the
 * IdP redirect that withPopup is waiting for. Single pass, no waiting:
 * returns true when a Confirm button was clicked.
 */
async function dismissOpenConfirmDialogs(
  page: Page,
  opts: GoogleOAuthOptions = {},
): Promise<boolean> {
  for (const frame of page.frames()) {
    try {
      const handle = await frame.evaluateHandle(() => {
        for (const dialog of Array.from(document.querySelectorAll("dialog[open]"))) {
          const buttons = Array.from(dialog.querySelectorAll("button"));
          const confirm = buttons.find((b) => {
            if (b.getAttribute("data-type") === "success") return true;
            const t = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
            return /^(confirm|agree|accept|setuju|lanjutkan)$/.test(t);
          });
          if (confirm) return confirm;
        }
        return null;
      });
      const el = handle.asElement() as ElementHandle<Element> | null;
      if (el) {
        await el.click().catch(() => {});
        await handle.dispose().catch(() => {});
        opts.log?.("info", "policy confirm dialog → clicked Confirm");
        return true;
      }
      await handle.dispose().catch(() => {});
    } catch {
      /* frame may be mid-navigation */
    }
  }
  return false;
}

// ── Risk-control restriction detection ──────────────────────────────

/**
 * Tencent risk-control blocks flagged accounts at the Keycloak layer: the
 * auth page renders an "Account Access Restricted / security policy
 * restrictions" banner instead of the login form. Detect it (frame-aware)
 * so callers can fail fast with a clear reason instead of timing out on a
 * Google button that will never appear.
 */
export async function isAccountRestricted(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const res = await safeEvaluate<boolean>(frame, () =>
      /account access restricted|security policy restriction/i.test(
        document.body?.innerText || "",
      ),
    );
    if (res.ok && res.value) return true;
  }
  return false;
}

// ── Click Google provider button ────────────────────────────────────

export async function maybeClickGoogleProvider(
  page: Page,
  email: string | null,
  opts: GoogleOAuthOptions = {},
): Promise<Page | null> {
  const log = opts.log;
  const deadline = Date.now() + 45_000;
  let announcedWait = false;
  let announcedGoogleText = false;
  /** rounds (~1.5s each) to wait out a Google button that is present but not yet clickable */
  let graceRounds = 6;

  while (Date.now() < deadline) {
    // A policy-confirm <dialog> (Keycloak social login) may be blocking the
    // IdP redirect — dismiss it first, then re-check for a Google surface.
    await dismissOpenConfirmDialogs(page, opts);

    // Risk-control restriction banner — the Google button will never appear.
    // Fail fast with a clear reason instead of waiting out the deadline.
    if (await isAccountRestricted(page)) {
      await takeScreenshot(
        page,
        screenshotPath(opts.screenShotDir ?? ".", email ?? "manual", "account-restricted"),
        opts,
      );
      throw err("ACCOUNT_RESTRICTED", "account restricted by risk control (codebuddy keycloak)");
    }

    const pages = await page.browser().pages();
    const existing = findGooglePageIn(pages);
    if (existing) {
      await existing.bringToFront().catch(() => {});
      return existing;
    }

    const googleButton = await findGoogleTrigger(page, log);
    if (googleButton) {
      if (googleButton.subFrameUrl && /^https?:/i.test(googleButton.subFrameUrl)) {
        // Button lives inside an embedded login iframe (Keycloak-style).
        // Promote that auth URL to a top-level navigation so the whole OAuth
        // (IdP redirect, popups, consent) runs page-level — clicking in-frame
        // would dead-end (accounts.google.com refuses framing).
        await googleButton.element.dispose().catch(() => {});
        log?.("info", `google button in embedded iframe — promoting auth URL to top-level: ${googleButton.subFrameUrl.slice(0, 120)}`);
        await page.goto(googleButton.subFrameUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
        await sleep(1000);
        continue; // re-find and click the button at top level
      }
      await pause(opts);
      const popup = await withPopup(
        page,
        async () => {
          await safeClick(page, googleButton.element);
          // Keycloak (codebuddy) opens a policy-confirm <dialog> on the first
          // social click — confirm it so the IdP redirect actually fires.
          for (let i = 0; i < 10; i++) {
            if (isGoogleUrl(page.url())) return; // already redirected
            if (await dismissOpenConfirmDialogs(page, opts)) return;
            await sleep(300);
          }
        },
        { sameTabDone: (p) => isGoogleUrl(p.url()) },
      );
      await googleButton.element.dispose().catch(() => {});
      if (popup) {
        await popup.bringToFront().catch(() => {});
        return popup;
      }
      if (!isGoogleUrl(page.url())) await waitForSettledPage(page);
      continue;
    }

    if (!announcedWait) {
      log?.("info", `waiting_for_google_button (${email ?? "manual"})`);
      await logFrameDiagnostics(page, log, "google button not found yet");
      announcedWait = true;
    }
    // On embedded-login surfaces (Keycloak auth iframe attached), a generic
    // "login / sign up" text click can wander the SPA — skip it there.
    const hasAuthIframe = page
      .frames()
      .some((f) => f !== page.mainFrame() && EMBEDDED_AUTH_URL_RE.test(f.url()));
    // Same when the provider button is already on this page but not grabbable
    // yet: clicking "Login" would leave the very page we are waiting on. Hold
    // off for a few rounds only — a page whose Google button stays disabled
    // (codebuddy's stuck Keycloak screen) still needs the escape hatch.
    const mentionsGoogle = await pageMentionsGoogleProvider(page);
    if (mentionsGoogle && graceRounds > 0) {
      graceRounds--;
      if (!announcedGoogleText) {
        announcedGoogleText = true;
        log?.("info", "google provider text is on this page — waiting for it to become clickable instead of clicking generic login");
      }
    }
    const holdForGoogleText = mentionsGoogle && graceRounds > 0;
    if (opts.genericAuthTextClick !== false && !hasAuthIframe && !holdForGoogleText) {
      await clickByText(
        page,
        ["sign in", "signin", "log in", "login", "get started", "sign up", "register", "masuk", "daftar"],
        opts,
        { optional: true },
      );
    }
    await sleep(1500);
  }

  log?.("warn", `google provider button never appeared (${email ?? "manual"})`);
  return null;
}

// ── Wait for Google sign-in page ────────────────────────────────────

export async function waitForGoogleSignInPage(
  context: BrowserContext | GoogleOAuthBrowser,
  email: string | null,
  opts: GoogleOAuthOptions = {},
): Promise<Page | null> {
  const timeoutMs = opts.signinTimeoutMs ?? 30_000;
  const start = Date.now();
  let announced = false;
  while (Date.now() - start < timeoutMs) {
    const pages = await getPages(context);
    const googlePage = findGooglePageIn(pages);
    if (googlePage) return googlePage;
    if (!announced) {
      opts.log?.("info", `waiting_for_google_sign_in (${email ?? "manual"})`);
      announced = true;
    }
    await sleep(500);
  }
  return null;
}

async function getPages(ctx: BrowserContext | GoogleOAuthBrowser): Promise<Page[]> {
  if ("browser" in ctx && "context" in ctx) return ctx.context.pages();
  return (ctx as BrowserContext).pages();
}

// ── Email fill ──────────────────────────────────────────────────────

const IDENTIFIER_NEXT_SELECTORS = [
  "#identifierNext",
  "#identifierNext button",
  'div#identifierNext[role="button"]',
  'button[jsname="LgbsSe"]',
  'button[type="submit"]',
];

/**
 * Advance past the Google identifier (email) step, verified.
 *
 * The old code fired a single click with every error swallowed and never
 * checked the step actually advanced - one failed click parked the flow on
 * the email page forever ("email filled but Next never clicked"). This
 * version retries through selector clicks (safeClick), text clicks and the
 * Enter key until the password field, an account chooser or the identifier
 * input disappearing proves we moved on.
 */
async function advanceGoogleIdentifier(
  page: Page,
  emailInput: ElementHandle<Element> | null,
  opts: GoogleOAuthOptions,
  timeoutMs = 25_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";

  while (Date.now() < deadline) {
    const state = await page
      .evaluate(() => {
        const visible = (sel: string) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return (
            rect.width > 0 && rect.height > 0 &&
            style.display !== "none" && style.visibility !== "hidden"
          );
        };
        return {
          identifierVisible:
            visible("#identifierId") ||
            visible('input[name="identifier"]') ||
            visible('input[type="email"]'),
          passwordVisible:
            visible('input[type="password"]') || visible('input[name="Passwd"]'),
          chooserVisible: visible("[data-identifier]"),
          errorText:
            (document.querySelector('[role="alert"]')?.textContent || "")
              .replace(/\s+/g, " ")
              .trim(),
        };
      })
      .catch(() => null);

    // Page mid-navigation (evaluate failed) - treat as advanced; the
    // password/consent handlers poll for their own surfaces next.
    if (!state) return true;
    if (!state.identifierVisible || state.passwordVisible || state.chooserVisible) return true;

    if (state.errorText && state.errorText !== lastError) {
      opts.log?.("warn", `identifier step: ${state.errorText.slice(0, 120)}`);
      lastError = state.errorText;
    }

    let clicked = false;
    for (const sel of IDENTIFIER_NEXT_SELECTORS) {
      const btn = await page.$(sel).catch(() => null);
      if (!btn) continue;
      if (await safeClick(page, btn)) {
        clicked = true;
        break;
      }
      await btn.dispose().catch(() => {});
    }
    if (!clicked) {
      clicked = await clickByText(
        page,
        ["next", "berikutnya", "selanjutnya", "lanjut"],
        opts,
        { optional: true },
      );
    }
    if (!clicked) {
      // Enter from inside the (still focused) email input submits the form.
      if (emailInput) await focusInput(page, emailInput);
      await page.keyboard.press("Enter");
    }

    await sleep(2000);
  }
  return false;
}

export async function maybeFillGoogleEmail(
  page: Page,
  email: string | null,
  opts: GoogleOAuthOptions = {},
): Promise<boolean> {
  if (!email) return false;
  const pages = await page.browser().pages();
  for (const candidate of pages) {
    if (!isGoogleUrl(candidate.url())) continue;
    await candidate.bringToFront();
    await simulateHumanBehavior(candidate, opts.pace);

    // Saved-account chooser: click our account when it is listed
    // (skips the email step entirely).
    const chooserBtn = await waitForAnySelector(
      candidate,
      [`[data-identifier="${email}"]`],
      2000,
    ).catch(() => null);
    if (chooserBtn) {
      await pause(opts);
      if (await safeClick(candidate, chooserBtn)) {
        await waitForSettledPage(candidate);
        opts.log?.("info", `selected saved account: ${email}`);
        return true;
      }
    }

    const emailInput = await waitForAnySelector(
      candidate,
      ['input[type="email"]', 'input[name="identifier"]', "#identifierId"],
      15_000,
    );
    if (!emailInput) continue;

    await focusInput(candidate, emailInput);
    await fillInput(candidate, emailInput, email);

    const typedValue = await emailInput.evaluate((node) => (node as HTMLInputElement).value).catch(() => "");
    if (typedValue.trim() !== email.trim()) {
      await emailInput.click({ clickCount: 3 }).catch(() => {});
      await emailInput.type(email, {
        delay: randomInt(opts.typeDelayMin ?? 30, opts.typeDelayMax ?? 90),
      });
    }

    await pause(opts);

    const advanced = await advanceGoogleIdentifier(candidate, emailInput, opts);
    if (!advanced) {
      await takeScreenshot(
        candidate,
        screenshotPath(opts.screenShotDir ?? ".", email, "identifier-stuck"),
        opts,
      );
      opts.log?.("warn", `identifier step did not advance for ${email}`);
      return false;
    }
    opts.log?.("info", `filled google email: ${email}`);
    return true;
  }
  return false;
}

// ── Password handling ───────────────────────────────────────────────

export type PasswordResult =
  | "submitted"
  | "browser_not_secure"
  | "missing_password"
  | "password_field_not_found";

export async function maybeHandleGooglePassword(
  context: BrowserContext | GoogleOAuthBrowser,
  account: { email: string; password?: string },
  opts: GoogleOAuthOptions = {},
): Promise<PasswordResult> {
  const timeoutMs = opts.passwordTimeoutMs ?? 60_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const pages = await getPages(context);
    for (const candidate of pages) {
      if (!isGoogleUrl(candidate.url())) continue;
      await candidate.bringToFront();

      if (await isGoogleBlockedPage(candidate)) {
        await takeScreenshot(candidate, screenshotPath(opts.screenShotDir ?? ".", account.email, "blocked"), opts);
        return "browser_not_secure";
      }
      if (await isGoogleCaptchaPage(candidate)) {
        await handleGoogleCaptcha(candidate, account.email, opts);
      }

      const passwordInput = await waitForVisibleInput(candidate, ['input[type="password"]', 'input[name="Passwd"]'], 1500);
      if (!passwordInput) continue;

      opts.log?.("info", `google password field detected for ${account.email}`);
      await simulateHumanBehavior(candidate, opts.pace);
      await focusInput(candidate, passwordInput.element);

      if (!account.password) {
        opts.log?.("warn", `no password for ${account.email}`);
        return "missing_password";
      }
      await fillInput(candidate, passwordInput.element, account.password);
      await pause(opts);
      await submitGooglePassword(candidate, opts);
      opts.log?.("info", `google password submitted for ${account.email}`);
      return "submitted";
    }
    await sleep(500);
  }
  return "password_field_not_found";
}

const PASSWORD_NEXT_SELECTORS = [
  "#passwordNext",
  "#passwordNext button",
  'div#passwordNext[role="button"]',
  'button[jsname="LgbsSe"]',
  'button[type="submit"]',
  'button[type="button"]',
];

/**
 * Submit the Google password step, verified. Mirrors the identifier-step
 * fix: retries selector clicks (safeClick, no swallowed failures), text
 * clicks and Enter until the visible password field disappears (consent /
 * welcome / redirect page reached).
 */
async function submitGooglePassword(page: Page, opts: GoogleOAuthOptions): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const stillPassword = await page
      .evaluate(() => {
        const el = document.querySelector('input[type="password"], input[name="Passwd"]');
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .catch(() => false);
    if (!stillPassword) return; // advanced past the password step

    let clicked = false;
    for (const sel of PASSWORD_NEXT_SELECTORS) {
      const btn = await page.$(sel).catch(() => null);
      if (!btn) continue;
      if (await safeClick(page, btn)) {
        clicked = true;
        break;
      }
      await btn.dispose().catch(() => {});
    }
    if (!clicked) {
      clicked = await clickByText(
        page,
        ["next", "berikutnya", "selanjutnya", "lanjut"],
        opts,
        { optional: true },
      );
    }
    if (!clicked) await page.keyboard.press("Enter");
    await sleep(2000);
  }
}


// ── CAPTCHA detection ───────────────────────────────────────────────

export async function isGoogleCaptchaPage(page: Page): Promise<boolean> {
  if (!isGoogleUrl(page.url())) return false;
  return page
    .evaluate(() => {
      const isVisible = (el: Element) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 40 && rect.height > 40 &&
          style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
      };
      const text = (document.body?.innerText || "").toLowerCase();
      const hasVisibleCaptchaFrame = Array.from(document.querySelectorAll("iframe")).some(
        (iframe) => /recaptcha|captcha/i.test(iframe.src || iframe.title || "") && isVisible(iframe),
      );
      const hasCaptchaImage = Boolean(document.querySelector('img[src*="captcha" i]'));
      const hasExplicitChallengeText =
        text.includes("type the characters") ||
        text.includes("type the text you hear or see") ||
        text.includes("enter the characters") ||
        text.includes("unusual traffic") ||
        text.includes("i'm not a robot") ||
        text.includes("confirm you're not a robot") ||
        text.includes("confirm you\u2019re not a robot");
      return hasVisibleCaptchaFrame || hasCaptchaImage || hasExplicitChallengeText;
    })
    .catch(() => false);
}

async function handleGoogleCaptcha(page: Page, email: string | null, opts: GoogleOAuthOptions) {
  const label = email ?? "<manual>";
  await takeScreenshot(page, screenshotPath(opts.screenShotDir ?? ".", label, "captcha"), opts);

  if (opts.headless || opts.failOnCaptcha) {
    throw new Error(`Google CAPTCHA for ${label}. Run headed or solve manually.`);
  }
  opts.log?.("warn", `google captcha for ${label}. solve manually...`);
  const start = Date.now();
  const waitMs = opts.captchaTimeoutMs ?? 3 * 60_000;
  while (Date.now() - start < waitMs) {
    if (!(await isGoogleCaptchaPage(page))) return;
    await sleep(1000);
  }
  throw new Error(`CAPTCHA not solved within ${waitMs}ms for ${label}`);
}

// ── Block detection ─────────────────────────────────────────────────

export async function isGoogleBlockedPage(page: Page): Promise<boolean> {
  if (!isGoogleUrl(page.url())) return false;
  return page
    .evaluate(() => {
      const text = (document.body?.innerText || "").toLowerCase();
      return (
        text.includes("couldn't sign you in") ||
        text.includes("couldn\u2019t sign you in") ||
        text.includes("this browser or app may not be secure") ||
        text.includes("try using a different browser") ||
        text.includes("unusual traffic") ||
        text.includes("too many failed attempts")
      );
    })
    .catch(() => false);
}

export async function isGooglePhoneVerificationChallenge(page: Page): Promise<boolean> {
  if (!isGoogleUrl(page.url())) return false;
  return page
    .evaluate(() => {
      const url = window.location.href.toLowerCase();
      if (url.includes("challenge/ipp") || url.includes("challenge/kpp")) return true;

      const phoneInput = document.querySelector(
        'input[type="tel"], input#phoneNumberId, input[name="phoneNumber"], input[autocomplete="tel"], [data-challengetype="13"], [data-challengetype="9"]'
      );
      if (phoneInput) return true;

      const text = (document.body?.innerText || "").toLowerCase();
      return (
        text.includes("enter a phone number to get a text message") ||
        text.includes("enter a phone number") ||
        text.includes("masukkan nomor telepon") ||
        text.includes("standard message and data rates may apply") ||
        text.includes("tarif pesan dan data standar") ||
        text.includes("phone number cannot be used for verification") ||
        text.includes("nomor telepon ini tidak dapat digunakan untuk verifikasi") ||
        ((text.includes("verify it's you") || text.includes("verifikasi diri anda")) &&
          (text.includes("phone number") || text.includes("nomor telepon")))
      );
    })
    .catch(() => false);
}

// ── Consent advancement ─────────────────────────────────────────────

async function isAtGoogleCredentialStep(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const field = document.querySelector(
        'input[type="password"], input[type="email"], #identifierId, input[name="identifier"], input[name="Passwd"]',
      );
      if (!field) return false;
      const rect = field.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })
    .catch(() => false);
}

async function findGoogleConsentButton(page: Page, email: string | null): Promise<ElementHandle<Element> | null> {
  const url = page.url();
  if (email && /oauth|consent|accountchooser|signin\/oauth/i.test(url)) {
    const account = await page.$(`[data-identifier="${email}"]`).catch(() => null);
    if (account) return account as ElementHandle<Element>;
  }
  if (/unknownerror/i.test(url)) {
    return findClickableByText(page, ["try again", "next", "continue"]);
  }
  if (/speedbump|termsofservice|tos|welcome/i.test(url)) {
    const primary = await page.evaluateHandle(() => {
      const norm = (v: unknown) => String(v || "").replace(/\s+/g, " ").trim().toLowerCase();
      const buttons = Array.from(document.querySelectorAll('button[jsname="LgbsSe"]')).filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !(el as HTMLButtonElement).disabled;
      });
      if (buttons.length === 1) return buttons[0];
      const needles = [
        "i understand", "i agree", "accept", "agree", "continue", "confirm",
        "saya mengerti", "setuju", "lanjutkan", "terima",
      ];
      return (
        buttons.find((el) => needles.some((n) => norm(el.textContent).includes(n))) || null
      );
    });
    const primaryEl = primary.asElement() as ElementHandle<Element> | null;
    if (primaryEl) return primaryEl;
    await primary.dispose().catch(() => {});
    return findClickableByText(page, [
      "i understand", "i agree", "accept all", "accept", "agree", "continue", "confirm",
      "saya mengerti", "setuju", "lanjutkan", "terima",
    ]);
  }
  if (/oauth|consent|approval/i.test(url)) {
    return findClickableByText(page, ["continue", "allow", "accept", "confirm", "next", "izinkan", "lanjutkan", "berikutnya"]);
  }
  return findClickableByText(page, [
    "i understand", "continue", "confirm", "accept", "agree", "allow", "next", "got it",
    "lanjutkan", "berikutnya",
  ]);
}

export async function advanceGoogleConsent(
  page: Page,
  email: string | null,
  opts: GoogleOAuthOptions = {},
): Promise<boolean> {
  if (await isAtGoogleCredentialStep(page)) return false;
  if (await isGooglePhoneVerificationChallenge(page)) return false;
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 2000 }).catch(() => {});
  const button = await findGoogleConsentButton(page, email);
  if (!button) return false;
  await pause(opts);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {}),
    safeClick(page, button),
  ]);
  if (button.dispose) await button.dispose().catch(() => {});
  return true;
}

// ── Full Google OAuth flow ──────────────────────────────────────────

export interface GoogleCredentials {
  email: string;
  password?: string;
}

/**
 * Perform a complete Google OAuth sign-in starting from a page that is
 * (or is about to become) a Google sign-in page. Returns the Page that
 * landed back off the Google domain (the popup or the same tab).
 *
 * Throws an Error with a machine-readable `code` if blocked, captcha'd,
 * or stuck on consent.
 */
export async function performGoogleOAuth(
  page: Page,
  context: BrowserContext | GoogleOAuthBrowser,
  creds: GoogleCredentials,
  overrides: GoogleOAuthOptions = {},
): Promise<{ code: string; page: Page }> {
  const opts = resolveGoogleOAuthOptions(overrides);
  const log = opts.log;
  const { email, password } = creds;

  const pace = resolvePace(opts.pace);
  log?.("info", `starting google oauth for ${email} (pace: ${pace.name})...`);
  await settlePage(page, pace);

  if (await isGoogleBlockedPage(page)) throw err("GOOGLE_BLOCKED", "browser not secure");
  if (await isGooglePhoneVerificationChallenge(page)) throw err("GOOGLE_PHONE_VERIFICATION_REQUIRED", "phone verification required");
  await dismissCookieBanners(page, opts);
  await pause(opts);

  const emailFilled = await maybeFillGoogleEmail(page, email, opts);
  if (!emailFilled) throw err("EMAIL_FILL_FAILED", "failed to fill google email");

  if (await isGoogleCaptchaPage(page)) await handleGoogleCaptcha(page, email, opts);
  if (await isGoogleBlockedPage(page)) throw err("GOOGLE_BLOCKED_AFTER_EMAIL", "blocked after email");
  if (await isGooglePhoneVerificationChallenge(page)) throw err("GOOGLE_PHONE_VERIFICATION_REQUIRED", "phone verification required after email");

  const passResult = await maybeHandleGooglePassword(context, { email, password }, opts);
  if (passResult === "browser_not_secure") throw err("GOOGLE_BLOCKED_PASSWORD", "browser_not_secure");
  if (passResult === "missing_password") throw err("GOOGLE_MISSING_PASSWORD", "no password provided");
  if (passResult === "password_field_not_found") throw err("GOOGLE_PASSWORD_FIELD_NOT_FOUND", "password field not found");

  // Consent screens appear a few seconds after password — poll until we leave Google.
  log?.("info", "waiting for consent screens / redirect...");
  const consentDeadline = Date.now() + (opts.consentTimeoutMs ?? 90_000);
  let lastGoogleUrl = "";

  while (Date.now() < consentDeadline) {
    const pages = await getPages(context);
    const googlePage = findGooglePageIn(pages);
    if (!googlePage) break;

    if (await isGooglePhoneVerificationChallenge(googlePage)) {
      throw err("GOOGLE_PHONE_VERIFICATION_REQUIRED", "phone verification required after password");
    }
    if (await isGoogleCaptchaPage(googlePage)) await handleGoogleCaptcha(googlePage, email, opts);
    if (await isGoogleBlockedPage(googlePage)) throw err("GOOGLE_BLOCKED_AFTER_PASSWORD", "blocked after password");

    const currentUrl = googlePage.url();
    if (currentUrl !== lastGoogleUrl) {
      log?.("info", `consent step: ${currentUrl.slice(0, 100)}`);
      lastGoogleUrl = currentUrl;
    }
    const advanced = await advanceGoogleConsent(googlePage, email, opts);
    if (advanced) { log?.("info", "consent screen advanced"); await sleep(pace.pollMs * 3); }
    else await sleep(pace.pollMs * 2);
  }

  const remaining = findGooglePageIn(await getPages(context));
  if (remaining && isGoogleUrl(remaining.url())) {
    await takeScreenshot(remaining, screenshotPath(opts.screenShotDir ?? ".", email, "consent-stuck"), opts);
    throw err("GOOGLE_CONSENT_STUCK", `stuck on google consent: ${remaining.url().slice(0, 120)}`);
  }

  // Landed back on the relying-party side — a risk-control restriction
  // banner there means the account is blocked even though OAuth succeeded.
  if (!page.isClosed() && (await isAccountRestricted(page))) {
    await takeScreenshot(
      page,
      screenshotPath(opts.screenShotDir ?? ".", email, "account-restricted"),
      opts,
    );
    throw err("ACCOUNT_RESTRICTED", "account restricted by risk control (post-oauth)");
  }

  const landed = page.isClosed() ? (findGooglePageIn(await getPages(context)) ?? page) : page;
  log?.("info", `google oauth complete for ${email}`);
  return { code: "OK", page: landed };
}

// ── helpers ─────────────────────────────────────────────────────────

function err(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}