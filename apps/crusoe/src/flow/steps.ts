// ── Crusoe flow steps ──────────────────────────────────────────────
// 1. /request-foundry  →  "Sign up with Google"  →  Google OAuth (library)
// 2. complete-signup ("Accept Invitation")  →  Name/Company + consent + submit
// 3. onboarding  →  Create API key  →  extract key  →  $5 bonus verified
// (selectors validated against crusoe_ai_dataset/*.html)
import fs from "node:fs";
import type { Page } from "puppeteer-core";
import {
  performGoogleOAuth,
  maybeClickGoogleProvider,
  dismissCookieBanners,
  isGoogleUrl,
  isAccountRestricted,
  dom,
  utils,
  resolvePace,
  type GoogleOAuthOptions,
} from "@ifqy/google-oauth";
import { FlowState } from "../store.js";
import { FlowError, type FlowCtx } from "./engine.js";
import { Selectors, API_KEY_RE, API_KEY_MIN_LEN } from "./selectors.js";

const {
  clickByText,
  waitForAnySelector,
  fillInput,
  safeClick,
} = dom;
const { sleep, randomInt } = utils;

// ── one-shot body text match ───────────────────────────────────────
async function bodyMatches(page: Page, re: RegExp): Promise<boolean> {
  return page
    .evaluate(
      (src) => new RegExp(src, "i").test((document.body?.innerText || "").toLowerCase()),
      re.source,
    )
    .catch(() => false);
}

async function waitForBodyRegex(
  page: Page,
  re: RegExp,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await bodyMatches(page, re)) return true;
    await sleep(500);
  }
  return false;
}

// ── React error-boundary recovery ──────────────────────────────────
// Crusoe's SPA can crash with "Unexpected Application Error!" while data is
// still loading (e.g. a component reads `x.nodes` before x exists). That is a
// frontend race on their side — a reload after the data arrives usually fixes
// it. Detect the error surface and reload (bounded) instead of failing the
// account instantly.

const REACT_ERROR_RE = /unexpected application error|application error|cannot read properties of undefined/i;

// NOTE: the matcher source is passed INTO the page — a regex declared out here
// is not defined inside the browser context (that threw ReferenceError, and
// the catch silently turned every check into "no error page").
async function isReactErrorPage(page: Page): Promise<boolean> {
  return bodyMatches(page, REACT_ERROR_RE);
}

/** Wait for a visible selector; auto-reload when the SPA error page shows. */
async function waitForSelectorRecover(
  page: Page,
  selectors: string[],
  timeoutMs: number,
  opts: { reloadLimit?: number; log?: FlowCtx["log"]; label?: string; pollMs?: number } = {},
): Promise<import("puppeteer-core").ElementHandle<Element> | null> {
  const deadline = Date.now() + timeoutMs;
  const reloadLimit = opts.reloadLimit ?? 2;
  const pollMs = opts.pollMs ?? 1000;
  let reloads = 0;

  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const el = await page.$(sel).catch(() => null);
      if (el) {
        const visible = await el
          .evaluate((node) => {
            const rect = node.getBoundingClientRect();
            const style = window.getComputedStyle(node);
            return rect.width > 0 && rect.height > 0 &&
              style.display !== "none" && style.visibility !== "hidden";
          })
          .catch(() => false);
        if (visible) return el;
        await el.dispose().catch(() => {});
      }
    }
    if (reloads < reloadLimit && (await isReactErrorPage(page))) {
      reloads++;
      opts.log?.("warn", `crusoe app error page detected → reloading (${reloads}/${reloadLimit})${opts.label ? ` [${opts.label}]` : ""}`);
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await sleep(pollMs * 1.5);
    }
    await sleep(pollMs);
  }
  return null;
}

/** First visible match among `selectors`, or null. Tolerates a torn-down frame. */
async function firstVisible(
  page: Page,
  selectors: string[],
): Promise<import("puppeteer-core").ElementHandle<Element> | null> {
  for (const sel of selectors) {
    const el = await page.$(sel).catch(() => null);
    if (!el) continue;
    const visible = await el
      .evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 &&
          style.display !== "none" && style.visibility !== "hidden";
      })
      .catch(() => false);
    if (visible) return el;
    await el.dispose().catch(() => {});
  }
  return null;
}

/**
 * Wait until /request-foundry actually shows its "Sign up with Google" button.
 * The SPA crashes into its error boundary often enough ("Unexpected
 * Application Error!" — a race in their own bundle) that we re-navigate to the
 * signup URL instead of giving up; a reload alone is not enough because the
 * crash can leave us on a different route.
 */
async function waitForSignupSurface(
  page: Page,
  timeoutMs: number,
  log: FlowCtx["log"],
  pollMs = 750,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let recoveries = 0;
  const recoveryLimit = 3;

  while (Date.now() < deadline) {
    const btn = await firstVisible(page, Selectors.signUpGoogleButton);
    if (btn) {
      await btn.dispose().catch(() => {});
      return true;
    }
    if (await isAccountRestricted(page)) {
      throw new FlowError("ACCOUNT_RESTRICTED", "account restricted by risk control (crusoe landing)");
    }
    const onSignupUrl = /request-foundry/.test(page.url());
    if ((await isReactErrorPage(page)) || !onSignupUrl) {
      if (recoveries >= recoveryLimit) break;
      recoveries++;
      log(
        "warn",
        `signup surface lost (${onSignupUrl ? "app error boundary" : `navigated to ${page.url()}`}) — re-opening ${Selectors.signupUrl} (${recoveries}/${recoveryLimit})`,
      );
      await page.goto(Selectors.signupUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await sleep(pollMs * 3);
      continue;
    }
    await sleep(pollMs);
  }
  return false;
}

/** The page actually running the crusoe app (same tab or OAuth popup). */
async function resolveAppPage(ctx: FlowCtx): Promise<Page> {
  const ref = ctx.appPageRef;
  if (ref.current && !ref.current.isClosed()) return ref.current;
  const pages = await ctx.browser.context.pages();
  for (const p of pages) {
    if (/console\.crusoecloud\.com/.test(p.url())) {
      ref.current = p;
      return p;
    }
  }
  ref.current = ctx.browser.page;
  return ref.current;
}

function pick<T>(arr: readonly T[]): T {
  return arr[randomInt(0, arr.length - 1)];
}

const FIRST = ["Alex", "Jordan", "Sam", "Taylor", "Casey", "Riley", "Morgan", "Avery", "Quinn", "Drew", "Reese", "Cameron", "Jamie", "Robin", "Noah", "Liam", "Emma", "Olivia", "Sophia", "Mia", "Ethan", "Lucas", "Mason"];
const LAST = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Lopez", "Wilson", "Anderson", "Thomas", "Moore", "Jackson", "Martin", "Lee"];
const COMPANY_NOUNS = ["Nimbus", "Kepler", "Aurora", "Vertex", "Quantum", "Northstar", "Atlas", "Cobalt", "Harbor", "Meridian", "Orion", "Polaris", "Ridge", "Summit", "Titan", "Cedar", "Juniper", "Lumen", "Nova", "Solstice"];
const COMPANY_SUFFIXES = ["Labs", "Works", "Systems", "Technologies", "Cloud", "Studio", "Soft", "Digital", "Data", "Intel", "Research", "Solutions"];

/** Prefer real human names from a public API; fall back to local lists. */
async function humanNames(): Promise<{ first: string; last: string }> {
  try {
    const res = await fetch("https://randomuser.me/api/?results=1", { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const u = (await res.json()).results[0];
      if (u?.name?.first && u?.name?.last) {
        return { first: u.name.first, last: u.name.last };
      }
    }
  } catch {
    /* offline — fall back */
  }
  return { first: pick(FIRST), last: pick(LAST) };
}

function randomCompany(name?: { first: string; last: string }): string {
  if (name && Math.random() < 0.5) {
    return `${name.first} ${pick(COMPANY_SUFFIXES)}`;
  }
  return `${pick(COMPANY_NOUNS)} ${pick(COMPANY_SUFFIXES)}`;
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);

// ── s01: request-foundry → Sign up with Google → full OAuth ────────
export async function s01Signup(ctx: FlowCtx): Promise<FlowState> {
  const { browser, account, googleOAuth, cfg, log } = ctx;

  const pace = resolvePace(cfg.pace);
  await browser.page.goto(Selectors.signupUrl, { waitUntil: "domcontentloaded" });
  await dismissCookieBanners(browser.page, googleOAuth);

  // The SPA regularly crashes on first paint (a race in their own bundle:
  // "Unexpected Application Error! Cannot read properties of undefined") and
  // the error boundary wipes every element including the Google button. Hold
  // here until the real button is on screen, re-opening the signup URL as
  // needed, so the library never scans a broken page.
  await sleep(randomInt(pace.stepPauseMin, pace.stepPauseMax));
  const surfaceReady = await waitForSignupSurface(
    browser.page,
    cfg.signupFormTimeoutSec * 1000,
    log,
    pace.pollMs,
  );
  if (!surfaceReady) {
    await browser.page
      .screenshot({ path: `${cfg.screenshotDir}/landing-${account.email.replace(/[^a-z0-9]/gi, "_")}.png` })
      .catch(() => {});
    throw new FlowError("NO_GOOGLE_PROVIDER", "request-foundry never rendered the Sign up with Google button");
  }

  const googlePage = await maybeClickGoogleProvider(browser.page, account.email, {
    ...googleOAuth,
    // The Google button is on this very page; the library's generic
    // "login / sign in" fallback would click the "Already have an account?
    // Login" link and navigate away from it.
    genericAuthTextClick: false,
  });
  if (!googlePage) {
    await browser.page
      .screenshot({ path: `${cfg.screenshotDir}/no-google-${account.email.replace(/[^a-z0-9]/gi, "_")}.png` })
      .catch(() => {});
    throw new FlowError("NO_GOOGLE_PROVIDER", "google provider button never appeared");
  }

  if (!isGoogleUrl(googlePage.url())) {
    const ok = await waitForBodyRegex(googlePage, /sign in with google|choose an account/i, 30_000);
    if (!ok) throw new FlowError("GOOGLE_PAGE_TIMEOUT", "google sign-in surface not detected");
  }

  const { code } = await performGoogleOAuth(googlePage, browser.context, {
    email: account.email,
    password: account.password,
  }, { ...googleOAuth, screenShotDir: cfg.screenshotDir });
  if (code !== "OK") throw new FlowError("GOOGLE_OAUTH_FAILED", `oauth code: ${code}`);

  // The crusoe app continues on the post-OAuth page (same tab or popup).
  if (!googlePage.isClosed()) ctx.appPageRef.current = googlePage;
  const app = await resolveAppPage(ctx);
  await app.bringToFront().catch(() => {});

  // complete-signup form (Accept Invitation). SPA/loading can lag and the
  // app occasionally shows its React error boundary — the recover-waiter
  // reloads (bounded) instead of failing the account instantly.
  // Either the complete-signup form (new account) or, when this email is
  // already registered, the Foundry dashboard straight away.
  const form = await waitForSelectorRecover(
    app,
    [Selectors.completeSignupCompany, Selectors.getApiKey],
    cfg.signupFormTimeoutSec * 1000,
    { log, label: "complete-signup form", pollMs: pace.pollMs },
  );
  if (!form) {
    const restricted = await isAccountRestricted(app);
    throw new FlowError(
      restricted ? "ACCOUNT_RESTRICTED" : "NO_SIGNUP_FORM",
      restricted
        ? "account restricted by risk control (post-oauth)"
        : "complete-signup form not found after OAuth",
    );
  }
  await form.dispose().catch(() => {});

  // Already-registered account (e.g. a re-run after the key step failed):
  // there is no signup form to fill, go straight to the API key.
  const alreadyOnDashboard = await firstVisible(app, [Selectors.getApiKey]);
  if (alreadyOnDashboard) {
    await alreadyOnDashboard.dispose().catch(() => {});
    log("info", `${account.email} is already registered — skipping complete-signup`);
    return FlowState.API_KEY;
  }

  log("info", `google oauth ok for ${account.email} — complete-signup form visible`);
  return FlowState.COMPLETE_SIGNUP;
}

// ── s02: fill Name/Company, accept consent, create account ─────────
export async function s02CompleteSignup(ctx: FlowCtx): Promise<FlowState> {
  const { account, googleOAuth, cfg, log } = ctx;
  const pace = resolvePace(cfg.pace);
  const page = await resolveAppPage(ctx);
  await page.bringToFront().catch(() => {});

  // Name — prefilled by Google; fill only when empty (e.g. account without name).
  const nameInput = await waitForAnySelector(page, [Selectors.completeSignupName], 15_000);
  if (nameInput) {
    const current = await nameInput.evaluate((el) => (el as HTMLInputElement).value).catch(() => "");
    if (!current?.trim()) {
      const n = await humanNames();
      await fillInput(page, nameInput, `${cap(n.first)} ${cap(n.last)}`);
    }
  }

  // Company Name — always random (human-ish).
  const companyInput = await waitForAnySelector(page, [Selectors.completeSignupCompany], 15_000);
  if (!companyInput) throw new FlowError("COMPANY_FIELD_MISSING", "company name input not found");
  const company = randomCompany();
  await fillInput(page, companyInput, company);
  await sleep(randomInt(pace.pauseMin, pace.pauseMax));

  // Consent checkbox (PrivacyShield ps-contract-target).
  const consent = await waitForAnySelector(page, [Selectors.consentCheckbox], 10_000);
  if (!consent) throw new FlowError("CONSENT_CHECKBOX_MISSING", "consent checkbox not found");
  const checked = await consent.evaluate((el) => (el as HTMLInputElement).checked).catch(() => false);
  if (!checked) {
    await safeClick(page, consent);
    await sleep(pace.pauseMin);
  }

  const submitted = await clickByText(page, Selectors.completeSignupSubmit, googleOAuth);
  if (!submitted) throw new FlowError("SIGNUP_SUBMIT_FAILED", "create account and login button not found");
  log("info", `complete-signup submitted (company=${company}) for ${account.email}`);

  // Submit → loading → Foundry welcome dashboard. That page only offers a
  // "Get API Key" button; the create-key form (alias + Create) lives in the
  // flyout it opens, so waiting for "Create" here would never resolve.
  // Accept either surface: the dashboard button, or a create form if the
  // account happens to land straight on the older onboarding page.
  const created = await waitForSelectorRecover(
    page,
    [Selectors.getApiKey, Selectors.apiKeyCreate],
    cfg.apiKeyTimeoutSec * 1000,
    { log, label: "foundry welcome / create-key", pollMs: pace.pollMs },
  );
  if (!created) {
    await page.screenshot({ path: `${cfg.screenshotDir}/onboarding-${account.email.replace(/[^a-z0-9]/gi, "_")}.png` }).catch(() => {});
    throw new FlowError("ONBOARDING_TIMEOUT", "foundry welcome / create-API-key page not reached after submit");
  }
  await created.dispose().catch(() => {});
  return FlowState.API_KEY;
}

// ── s03: create API key → extract → save (runner writes apikey.txt) ─
export async function s03CreateApiKey(ctx: FlowCtx): Promise<FlowState> {
  const { account, cfg, log, apiKeyRef } = ctx;
  const pace = resolvePace(cfg.pace);
  const page = await resolveAppPage(ctx);
  await page.bringToFront().catch(() => {});

  // The welcome dashboard hides the form behind "Get API Key" — open the
  // flyout before hunting for Create.
  let createBtn = await firstVisible(page, [Selectors.apiKeyCreate]);
  if (!createBtn) {
    const opener = await waitForSelectorRecover(
      page,
      [Selectors.getApiKey],
      cfg.apiKeyTimeoutSec * 1000,
      { log, label: "get api key", pollMs: pace.pollMs },
    );
    if (!opener) {
      await page.screenshot({ path: `${cfg.screenshotDir}/no-getkey-${account.email.replace(/[^a-z0-9]/gi, "_")}.png` }).catch(() => {});
      throw new FlowError("GET_API_KEY_BTN_MISSING", "Get API Key button not found on the foundry welcome page");
    }
    await safeClick(page, opener);
    await opener.dispose().catch(() => {});
    log("info", `api key flyout opened for ${account.email}`);
    // The flyout animates in (500ms transition) before the form mounts.
    createBtn = await waitForSelectorRecover(
      page,
      [Selectors.apiKeyCreate],
      45_000,
      { log, label: "create api key", reloadLimit: 0, pollMs: Math.min(pace.pollMs, 500) },
    );
  }
  if (!createBtn) {
    await page.screenshot({ path: `${cfg.screenshotDir}/no-create-${account.email.replace(/[^a-z0-9]/gi, "_")}.png` }).catch(() => {});
    throw new FlowError("CREATE_KEY_BTN_MISSING", "Create button not found inside the API key flyout");
  }

  // Also fill the optional alias for a tidy key name.
  const alias = await waitForAnySelector(page, [Selectors.apiKeyAlias], 5000).catch(() => null);
  if (alias) await fillInput(page, alias, "default");
  await sleep(randomInt(pace.pauseMin, pace.pauseMax));

  await safeClick(page, createBtn);
  await createBtn.dispose().catch(() => {});

  // The key renders as <code data-sentry-element="ApiKeyValue">.
  const keyText = await (async () => {
    const deadline = Date.now() + 45_000;
    let reloads = 0;
    while (Date.now() < deadline) {
      if (reloads < 2 && (await isReactErrorPage(page))) {
        reloads++;
        log("warn", `crusoe app error page while waiting for the key → reloading (${reloads}/2)`);
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
        await sleep(1500);
      }
      const codeEl = await page.$(Selectors.apiKeyValueSelector).catch(() => null);
      if (codeEl) {
        const text = (await codeEl.evaluate((el) => el.textContent?.trim() ?? "").catch(() => "")) ?? "";
        // This element IS the key by construction, so trust its content once
        // it looks like a token. Never let a pattern mismatch throw away a key
        // that the site will not show again.
        if (text.length >= API_KEY_MIN_LEN && !/\s/.test(text)) {
          if (!API_KEY_RE.test(text)) {
            log("warn", `api key has unexpected characters, saving it anyway (${text.length} chars)`);
          }
          return text;
        }
      }
      // fallback: any <code> with a long token (hashed-class tolerant)
      const anyKey = await page
        .evaluate(
          (src, min) => {
            const re = new RegExp(src);
            const el = Array.from(document.querySelectorAll("code"))
              .find((c) => {
                const t = (c.textContent || "").trim();
                return t.length >= min && re.test(t);
              });
            return el?.textContent?.trim() ?? "";
          },
          API_KEY_RE.source,
          API_KEY_MIN_LEN,
        )
        .catch(() => "");
      if (API_KEY_RE.test(anyKey)) return anyKey;
      await sleep(Math.min(pace.pollMs, 500));
    }
    return null;
  })();

  if (!keyText) {
    // A created key is shown exactly once. If we could not read it, dump the
    // page too so it can still be recovered by hand from the HTML.
    const stem = `${cfg.screenshotDir}/no-apikey-${account.email.replace(/[^a-z0-9]/gi, "_")}`;
    await page.screenshot({ path: `${stem}.png` }).catch(() => {});
    await page
      .content()
      .then((html) => fs.writeFileSync(`${stem}.html`, html, "utf8"))
      .catch(() => {});
    log("error", `could not read the API key — page dumped to ${stem}.html`);
    throw new FlowError("BAD_API_KEY", "API key did not appear (create button click may be stuck)");
  }

  // Bonus verify ($5 credits) — best effort, warn-only (key is the deliverable).
  const credits = await waitForBodyRegex(page, Selectors.creditsBonus, cfg.creditsTimeoutSec * 1000);
  if (!credits) log("warn", `$5 bonus banner not confirmed for ${account.email} (check manually)`);

  apiKeyRef.current = keyText.trim();
  log("info", `api key obtained for ${account.email}: ${keyText.slice(0, 12)}...`);
  return FlowState.DONE;
}

export const STEPS: Record<string, (ctx: FlowCtx) => Promise<FlowState>> = {
  [FlowState.SIGNUP]: s01Signup,
  [FlowState.COMPLETE_SIGNUP]: s02CompleteSignup,
  [FlowState.API_KEY]: s03CreateApiKey,
};