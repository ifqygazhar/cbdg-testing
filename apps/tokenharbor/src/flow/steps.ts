// ── Flow steps for TokenHarbor automation ───────────────────────────
import type { Page } from "puppeteer-core";
import { dom, utils, TempMailClient } from "@ifqy/google-oauth";
import { SELECTORS, API_KEY_RE, VERIFY_LINK_RE } from "./selectors.js";
import type { TokenHarborConfig } from "../config.js";
import type { ULog } from "../log.js";

const DEFAULT_SIGNUP_URL = "https://tokenharbor.ai/login?mode=signup";
const DASHBOARD_URL = "https://tokenharbor.ai/dashboard";
const API_KEYS_URL = "https://tokenharbor.ai/dashboard/api-keys";

export interface AccountSession {
  email: string;
  password: string;
  apiKey?: string;
  verificationLink?: string;
}

/** Dismisses cookie/analytics consent banner if present */
export async function dismissCookieBanners(page: Page, log: ULog): Promise<void> {
  try {
    const clicked = await dom.clickByText(page, ["Accept analytics", "Essential only"], {}, { optional: true });
    if (clicked) {
      log("info", "cookie banner dismissed");
      await utils.sleep(500);
    }
  } catch {
    // optional banner, ignore
  }
}

/** Step 1: Navigates to signup page, fills credentials, and submits */
export async function stepSignUp(
  page: Page,
  session: AccountSession,
  cfg: TokenHarborConfig,
  log: ULog,
): Promise<void> {
  log("info", "navigating to signup", { url: DEFAULT_SIGNUP_URL });
  await page.goto(DEFAULT_SIGNUP_URL, { waitUntil: "domcontentloaded", timeout: 35000 });
  await utils.sleep(1500);

  await dismissCookieBanners(page, log);

  log("info", "filling signup form", { email: session.email });
  const emailInput = await dom.waitForAnySelector(page, [SELECTORS.emailInput], 10000);
  if (!emailInput) {
    throw new Error("Could not find or fill email input on signup page");
  }
  await dom.fillInput(page, emailInput, session.email);
  await emailInput.dispose().catch(() => {});
  await utils.sleep(300);

  const passInput = await dom.waitForAnySelector(page, [SELECTORS.passwordInput], 10000);
  if (!passInput) {
    throw new Error("Could not find or fill password input on signup page");
  }
  await dom.fillInput(page, passInput, session.password);
  await passInput.dispose().catch(() => {});
  await utils.sleep(500);

  // Click submit (Create account)
  log("info", "submitting signup form");
  const submitBtn = await dom.waitForAnySelector(page, [SELECTORS.submitSignUpButton], 10000);
  if (!submitBtn) {
    throw new Error("Create account button not found");
  }
  await submitBtn.click();

  // Wait for redirect to dashboard or navigation
  const reachedDashboard = await Promise.race([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).then(() => true).catch(() => false),
    (async () => {
      for (let i = 0; i < 30; i++) {
        if (page.url().includes("/dashboard")) return true;
        await utils.sleep(500);
      }
      return false;
    })(),
  ]);

  if (!reachedDashboard && !page.url().includes("/dashboard")) {
    // If still on login page, check for errors
    const errorText = await page.evaluate(() => {
      const errEl = document.querySelector('[role="alert"], .text-destructive, .text-red-500');
      return errEl ? errEl.textContent?.trim() : null;
    });
    if (errorText) {
      throw new Error(`Signup rejected: ${errorText}`);
    }
  }

  log("info", "dashboard reached after signup", { url: page.url() });
  await utils.sleep(1500);
}

/** Step 2: Enables free models consent on dashboard if prompted */
export async function stepEnableFreeModels(page: Page, log: ULog): Promise<void> {
  log("info", "checking free models consent banner");
  try {
    const btn = await dom.waitForAnySelector(page, [SELECTORS.enableFreeModelsConsent], 4000);
    if (btn) {
      log("info", "clicking Enable free models button");
      await btn.click();
      await utils.sleep(1000);
    }
  } catch {
    // If modal/banner not present, continue
  }
}

/** Step 3: Clicks 'Verify email' banner on dashboard to trigger verification link */
export async function stepTriggerVerification(page: Page, log: ULog): Promise<void> {
  log("info", "checking verify email banner");
  const verifyBtn = await dom.waitForAnySelector(page, [SELECTORS.verifyEmailBannerButton], 8000);
  if (verifyBtn) {
    log("info", "clicking Verify email button to send verification link");
    await verifyBtn.click();
    await utils.sleep(2000);
  } else {
    log("info", "verify email button not visible, may already be sent or verified");
  }
}

/** Step 4: Polls TempMail inbox, extracts verification link, and navigates to verify */
export async function stepVerifyEmail(
  page: Page,
  email: string,
  tempMail: TempMailClient,
  log: ULog,
): Promise<string> {
  log("info", "waiting for verification email from TempMail", { email });
  const verifyUrl = await tempMail.waitForVerificationLink(email, {
    timeoutMs: 75000,
    intervalMs: 2500,
    filterSender: "tokenharbor",
    linkRegex: VERIFY_LINK_RE,
  });

  log("info", "verification link received", { verifyUrl });
  await page.goto(verifyUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await utils.sleep(2500);

  log("info", "email verification completed", { url: page.url() });
  return verifyUrl;
}

/** Step 5: Navigates to /dashboard/api-keys, creates new key, and extracts token */
export async function stepCreateApiKey(
  page: Page,
  session: AccountSession,
  cfg: TokenHarborConfig,
  log: ULog,
): Promise<string> {
  log("info", "navigating to API keys page", { url: API_KEYS_URL });
  await page.goto(API_KEYS_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await utils.sleep(1500);

  // Look for "+ New key" button
  log("info", "clicking + New key button");
  const newKeyBtn = await dom.waitForAnySelector(page, [SELECTORS.newKeyButton], 15000);
  if (!newKeyBtn) {
    throw new Error("+ New key button not found on API keys page");
  }
  await newKeyBtn.click();
  await utils.sleep(1000);

  // Label input dialog
  const label = `App-${session.email.split("@")[0].slice(0, 8)}-${utils.randomInt(10, 99)}`;
  log("info", "typing key label", { label });
  const keyLabelInput = await dom.waitForAnySelector(page, [SELECTORS.keyLabelInput], 10000);
  if (!keyLabelInput) {
    throw new Error("Could not find key label input in create dialog");
  }
  await dom.fillInput(page, keyLabelInput, label);
  await keyLabelInput.dispose().catch(() => {});
  await utils.sleep(500);

  // Click "Create key" submit button
  log("info", "submitting key creation");
  const createSubmitBtn = await dom.waitForAnySelector(page, [SELECTORS.createKeySubmitButton], 10000);
  if (!createSubmitBtn) {
    throw new Error("Create key submit button not found");
  }
  await createSubmitBtn.click();
  await utils.sleep(2000);

  // Extract created API key from modal
  log("info", "extracting generated API key");
  let apiKey: string | null = null;

  for (let i = 0; i < 20; i++) {
    const rawText = await page.evaluate((sel) => {
      const codeEl = document.querySelector(sel);
      if (codeEl && codeEl.textContent) return codeEl.textContent.trim();
      // Fallback search across modal text
      const modal = document.querySelector('[role="dialog"], .card-float, div:has(> code)');
      return modal ? modal.textContent ?? "" : document.body.innerText;
    }, SELECTORS.apiKeyDisplay);

    const match = rawText.match(API_KEY_RE);
    if (match) {
      apiKey = match[0];
      break;
    }
    await utils.sleep(500);
  }

  if (!apiKey) {
    throw new Error("Failed to extract TokenHarbor API key from confirmation dialog");
  }

  log("info", "API key extracted successfully", { apiKey: `${apiKey.slice(0, 12)}...` });
  session.apiKey = apiKey;
  return apiKey;
}
