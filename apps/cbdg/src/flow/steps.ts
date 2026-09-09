// ── Flow steps (Bun + Puppeteer, using @ifqy/google-oauth) ────────
import {
  performGoogleOAuth,
  maybeClickGoogleProvider,
  isAccountRestricted,
  isGoogleUrl,
  dom,
  utils,
  type GoogleOAuthBrowser,
} from "@ifqy/google-oauth";
import { FlowState } from "../store.js";
import { FlowError, type FlowCtx } from "./engine.js";
import { Selectors } from "./selectors.js";

const { clickByText, waitForVisibleInput, waitForAnySelector, fillInput } = dom;
const { sleep } = utils;

// ── one-shot body text match ───────────────────────────────────────
async function bodyMatches(
  page: NonNullable<GoogleOAuthBrowser["page"]>,
  re: RegExp,
): Promise<boolean> {
  return page
    .evaluate(
      (src) => new RegExp(src, "i").test((document.body?.innerText || "").toLowerCase()),
      re.source,
    )
    .catch(() => false);
}

// ── wait for a regex to appear in the page body text ───────────────
async function waitForBodyRegex(
  page: NonNullable<GoogleOAuthBrowser["page"]>,
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

// Poll clickByText until an SPA-rendered target shows up (hydration can take seconds).
async function clickByTextWithRetry(
  page: any,
  needles: readonly string[],
  oauthOpts: any,
  { timeoutMs = 20_000, intervalMs = 1_500 } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await clickByText(page, needles, oauthOpts)) return true;
    await sleep(intervalMs);
  } while (Date.now() < deadline);
  return false;
}

// ── s01: pricing → new-user-bonus signup → click "continue with google" ─
export async function s01Pricing(ctx: FlowCtx): Promise<FlowState> {
  const { browser, googleOAuth, account } = ctx;
  await browser.page.goto("https://www.codebuddy.ai/pricing", { waitUntil: "domcontentloaded" });
  const clickedBonus = await clickByTextWithRetry(browser.page, Selectors.pricingBonusSignup, googleOAuth, { timeoutMs: 25_000 });
  if (!clickedBonus) throw new FlowError("NO_BONUS_SIGNUP", "new-user bonus signup not found on pricing page");

  const googlePage = await maybeClickGoogleProvider(browser.page, account.email, googleOAuth);
  if (!googlePage) throw new FlowError("NO_GOOGLE_PROVIDER", "google provider button never appeared");

  const onGoogleSurface =
    isGoogleUrl(googlePage.url()) ||
    (await waitForBodyRegex(googlePage, /sign in with google|choose an account/i, 30_000));
  if (!onGoogleSurface) throw new FlowError("GOOGLE_PAGE_TIMEOUT", "google sign-in surface not detected");
  return FlowState.GOOGLE_OAUTH;
}

// ── s02: full Google OAuth (email + password + consent) ────────────
export async function s02GoogleOAuth(ctx: FlowCtx): Promise<FlowState> {
  const { browser, account, googleOAuth } = ctx;
  let page = browser.page;
  if (!isGoogleUrl(page.url())) {
    const found = await maybeClickGoogleProvider(page, account.email, googleOAuth);
    if (!found) throw new FlowError("NO_GOOGLE_PAGE", "could not reach google sign-in");
    page = found;
  }
  const { code } = await performGoogleOAuth(page, browser.context, {
    email: account.email,
    password: account.password,
  }, { ...googleOAuth, screenShotDir: ctx.cfg.screenshotDir });
  if (code !== "OK") throw new FlowError("GOOGLE_OAUTH_FAILED", `oauth code: ${code}`);
  return FlowState.COMPLETE_REGISTER;
}

// ── s03: complete registration (region + submit) ───────────────────
export async function s03CompleteRegister(ctx: FlowCtx): Promise<FlowState> {
  const { browser, cfg, googleOAuth } = ctx;
  await browser.page.goto("https://www.codebuddy.ai/register/user/complete", { waitUntil: "domcontentloaded" });
  if (await isAccountRestricted(browser.page)) {
    throw new FlowError("ACCOUNT_RESTRICTED", "account restricted by risk control (complete-register)");
  }
  await clickByText(browser.page, Selectors.registerRegionToggle, googleOAuth, { optional: true });
  await sleep(500);
  await clickByText(browser.page, Selectors.registerRegion(cfg.region), googleOAuth);
  await sleep(500);
  const submitted = await clickByText(browser.page, Selectors.registerSubmit, googleOAuth);
  if (!submitted) throw new FlowError("REGISTER_SUBMIT_FAILED", "registration submit button not found");
  await sleep(1500);
  ctx.log("info", `registration submitted for region ${cfg.region} (${ctx.account.email})`);
  return FlowState.ADD_PAYMENT;
}

// ── s04: open payment profile → harvestsharp token page ────────────
export async function s04OpenPayment(ctx: FlowCtx): Promise<FlowState> {
  const { browser, googleOAuth, cfg } = ctx;
  const hit = await clickByText(browser.page, Selectors.paymentProfile, googleOAuth, { optional: true });
  if (!hit) {
    await clickByText(browser.page, Selectors.accountMenu, googleOAuth, { optional: true });
    await sleep(500);
    await clickByText(browser.page, Selectors.paymentProfile, googleOAuth);
  }
  const onSign = await new Promise<boolean>((resolve) => {
    const test = (u: string) => Selectors.harvestSignUrl.test(u);
    const done = () => { resolve(true); return true; };
    if (test(browser.page.url())) return done(); // already there (listener race)
    const timer = setTimeout(() => resolve(test(browser.page.url())), cfg.openPaymentTimeoutSec * 1000);
    browser.page.on("framenavigated", (f) => { if (test(f.url())) { clearTimeout(timer); done(); } });
  });
  if (!onSign) throw new FlowError("PAYMENT_PAGE_TIMEOUT", "harvestsharp sign page not reached");
  return FlowState.LINK_CARD;
}

// ── s05: fill Midas card form + "Link your card" → branch 3ds/success ─
export async function s05LinkCard(ctx: FlowCtx): Promise<FlowState> {
  const { browser, card, googleOAuth, cfg } = ctx;
  const p = browser.page;

  const fill = async (sel: string, value: string) => {
    const input = await waitForVisibleInput(p, [sel], 10_000);
    if (!input) throw new FlowError("CARD_FIELD_MISSING", `field not found: ${sel}`);
    await fillInput(p, input.element, value);
  };

  await fill(Selectors.firstName, "Alex");
  await fill(Selectors.lastName, "Morgan");
  await fill(Selectors.cardNumber, card.cardNumber);
  await fill(Selectors.expiry, card.expiry);
  await fill(Selectors.cvc, card.cvv);
  await fill(Selectors.billingCity, "Singapore");
  await fill(Selectors.billingPostal, "018956");
  await fill(Selectors.billingState, "Singapore");
  await fill(Selectors.billingPhone, "+65 81234567");

  for (const sel of [Selectors.billingCountry, Selectors.phoneCountry]) {
    const el = await waitForAnySelector(p, [sel], 5000);
    if (el) await p.select(sel, "SG").catch(() => {});
  }

  const linked = await clickByText(p, Selectors.linkCard, googleOAuth);
  if (!linked) throw new FlowError("LINK_CARD_BTN_MISSING", "link your card button not found");

  // Poll both outcomes with SUCCESS checked first: the 3DS regex contains
  // /verif/, which also matches "verified" on a success page — checking 3DS
  // first would misroute a completed link into the manual-3DS wait.
  let outcome: "success" | "3ds" | null = null;
  const deadline = Date.now() + cfg.linkCardTimeoutSec * 1000;
  while (Date.now() < deadline && !outcome) {
    if (await bodyMatches(p, Selectors.midaSuccess)) outcome = "success";
    else if (await bodyMatches(p, Selectors.mida3ds)) outcome = "3ds";
    else await sleep(1000);
  }
  if (outcome === "success") return FlowState.START_TRIAL;
  if (outcome === "3ds") return FlowState.WAIT_3DS;
  throw new FlowError("CARD_LINK_RESULT_UNKNOWN", "neither success nor 3ds state detected");
}

// ── s06: hold for manual 3DS verification ───────────────────────────
export async function s06Wait3ds(ctx: FlowCtx): Promise<FlowState> {
  const { browser, cfg } = ctx;
  ctx.log("warn", `WAITING for manual 3DS verification (${cfg.wait3dsTimeoutSec}s) for ${ctx.account.email}`);
  const ok = await waitForBodyRegex(browser.page, Selectors.midaSuccess, cfg.wait3dsTimeoutSec * 1000);
  if (!ok) throw new FlowError("WAIT_3DS_TIMEOUT", "manual 3DS verification timed out");
  return FlowState.START_TRIAL;
}

// ── s07: start trial + verify 500/250 credits ──────────────────────
export async function s07TrialVerify(ctx: FlowCtx): Promise<FlowState> {
  const { browser, googleOAuth, cfg } = ctx;
  await browser.page.goto("https://www.codebuddy.ai/pricing", { waitUntil: "domcontentloaded" });
  await clickByText(browser.page, Selectors.trial7d, googleOAuth, { optional: true });
  await sleep(1000);
  await clickByText(browser.page, Selectors.trial7d, googleOAuth, { optional: true });

  await browser.page.goto(Selectors.plansUsage, { waitUntil: "domcontentloaded" });
  const credited = await waitForBodyRegex(browser.page, Selectors.creditBanner, cfg.creditVerifyTimeoutSec * 1000);
  if (!credited) {
    const body = await browser.page.evaluate(() => document.body?.innerText || "").catch(() => "");
    if (!/(\b500\b|\b250\b)/.test(body)) {
      throw new FlowError("CREDIT_NOT_CONFIRMED", "expected 500/250 credits not found");
    }
  }
  ctx.log("info", `credits confirmed (500/250) for ${ctx.account.email}`);
  return FlowState.DONE;
}

export const STEPS: Record<string, (ctx: FlowCtx) => Promise<FlowState>> = {
  PRICING: s01Pricing,
  GOOGLE_OAUTH: s02GoogleOAuth,
  COMPLETE_REGISTER: s03CompleteRegister,
  ADD_PAYMENT: s04OpenPayment,
  LINK_CARD: s05LinkCard,
  WAIT_3DS: s06Wait3ds,
  START_TRIAL: s07TrialVerify,
};