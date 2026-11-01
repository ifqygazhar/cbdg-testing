// ── Flow steps for Zro MoonMath (zro.moonmath.ai) automation ────────
import type { Page } from "puppeteer-core";
import { utils, TempMailClient } from "@ifqy/google-oauth";
import { SELECTORS, API_KEY_RE } from "./selectors.js";
import {
  DEFAULT_SIGNUP_URL,
  VERIFY_EMAIL_URL,
  LEGAL_CONSENT_URL,
  DASHBOARD_URL,
  API_KEYS_URL,
  type ZroMoonmathConfig,
} from "../config.js";
import type { ULog } from "../log.js";

export interface AccountSession {
  email: string;
  password: string;
  apiKey?: string;
  otpCode?: string;
}

/** Step 1: Zro MoonMath Registration */
export async function stepSignUp(
  page: Page,
  session: AccountSession,
  cfg: ZroMoonmathConfig,
  log: ULog,
): Promise<void> {
  log("info", "navigating to Zro MoonMath sign-up...", { url: DEFAULT_SIGNUP_URL });
  await page.goto(DEFAULT_SIGNUP_URL, { waitUntil: "domcontentloaded", timeout: 35000 });
  await utils.sleep(2000);

  // If already logged in
  const currentUrl = page.url();
  if (currentUrl.includes("/overview") || currentUrl.includes("/api-keys")) {
    log("info", "already logged in to Zro MoonMath, skipping signup step");
    return;
  }

  // Mode A: Google OAuth
  if (cfg.authMethod === "google") {
    log("info", "waiting for 'Continue with Google' button in Clerk card...");
    await page.waitForSelector(SELECTORS.googleOAuthButton, { timeout: 30000 });
    const googleBtn = await page.$(SELECTORS.googleOAuthButton);
    if (!googleBtn) {
      throw new Error("Continue with Google button not found in Clerk dialog");
    }
    await googleBtn.click();
    await utils.sleep(3000);
    return;
  }

  // Mode B: TempMail direct email registration
  log("info", "filling email identifier in Clerk form...", { email: session.email });
  await page.waitForSelector(SELECTORS.emailInput, { timeout: 30000 });
  const emailInput = (await page.$(SELECTORS.emailInput))!;
  await emailInput.click({ clickCount: 3 });
  await emailInput.type(session.email, { delay: 35 });
  await utils.sleep(400);

  log("info", "submitting Clerk email form...");
  await page.waitForSelector(SELECTORS.continueSignUpButton, { timeout: 15000 });
  const continueBtn = (await page.$(SELECTORS.continueSignUpButton))!;
  await continueBtn.click();
  await utils.sleep(3000);
}

/** Step 2: Email OTP Verification (/sign-up/create/verify-email-address) */
export async function stepSubmitOtp(
  page: Page,
  session: AccountSession,
  tempMail: TempMailClient,
  log: ULog,
): Promise<string> {
  log("info", "waiting for Clerk OTP verification page to mount...", { email: session.email });

  // Ensure OTP input is mounted
  await page.waitForSelector(SELECTORS.otpInput, { timeout: 35000 });

  // Poll TempMail inbox for 6-digit OTP code
  log("info", "polling TempMail inbox for Zro verification OTP code...", { email: session.email });
  const otpCode = await tempMail.waitForVerificationOtp(session.email, {
    timeoutMs: 120000,
    intervalMs: 3000,
    filterSender: "zro",
  });

  log("info", "received verification OTP code!", { code: otpCode });
  session.otpCode = otpCode;

  // Type OTP into input[data-input-otp="true"]
  const otpInput = (await page.$(SELECTORS.otpInput))!;
  await otpInput.click();
  await utils.sleep(200);
  await otpInput.type(otpCode, { delay: 60 });
  await utils.sleep(1000);

  // Clerk auto-submits upon typing 6 digits. Wait for transition to legal consent (/continue) or overview
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const cur = page.url();
    const legalCheckbox = await page.$(SELECTORS.legalAcceptedCheckbox);
    if (cur.includes("/continue") || legalCheckbox || cur.includes("/overview") || cur.includes("/api-keys") || cur.includes("/get-started")) {
      break;
    }
    await utils.sleep(500);
  }

  return otpCode;
}

/** Step 3: Legal Consent (/sign-up/create/continue) */
export async function stepLegalConsent(page: Page, log: ULog): Promise<void> {
  const curUrl = page.url();
  if (curUrl.includes("/overview") || curUrl.includes("/api-keys")) {
    log("info", "already reached overview, skipping legal consent");
    return;
  }

  try {
    const checkbox = await page.waitForSelector(SELECTORS.legalAcceptedCheckbox, { timeout: 10000 });
    if (checkbox) {
      log("info", "found legal consent screen. Checking Terms of Service checkbox...");

      // 1. Click label first if visible (most reliable for Clerk React controlled component)
      const label = await page.$(SELECTORS.legalAcceptedLabel);
      if (label) {
        await label.click();
        await utils.sleep(300);
      }

      // 2. Ensure checkbox.checked is true via DOM descriptor if React didn't sync
      const isChecked = await page.evaluate(() => {
        const cb = document.querySelector('input#legalAccepted-field, input[name="legalAccepted"]') as HTMLInputElement | null;
        if (cb && !cb.checked) {
          cb.click();
          if (!cb.checked) {
            const proto = window.HTMLInputElement.prototype;
            const nativeSet = Object.getOwnPropertyDescriptor(proto, "checked")?.set;
            if (nativeSet) nativeSet.call(cb, true);
            else cb.checked = true;
            cb.dispatchEvent(new Event("input", { bubbles: true }));
            cb.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
        return cb ? Boolean(cb.checked) : false;
      });

      log("info", `legal consent checkbox status: checked=${isChecked}`);
      await utils.sleep(400);

      // 3. Click "Continue with email" button
      const continueBtn = await page.$(SELECTORS.legalContinueButton);
      if (continueBtn) {
        log("info", "clicking 'Continue with email' after legal consent...");
        await continueBtn.click();
        await utils.sleep(2500);
      }

      // 4. Wait for redirect away from /continue
      const redirectDeadline = Date.now() + 15000;
      while (Date.now() < redirectDeadline) {
        const cur = page.url();
        if (!cur.includes("/continue")) {
          log("info", "redirected away from /continue", { currentUrl: cur });
          break;
        }
        await utils.sleep(1000);
      }
    }
  } catch {
    log("info", "no legal consent screen detected, continuing...");
  }
}

/** Step 4: Create and extract API Key from https://zro.moonmath.ai/api-keys */
export async function stepCreateApiKey(
  page: Page,
  session: AccountSession,
  cfg: ZroMoonmathConfig,
  log: ULog,
): Promise<string> {
  // First go to dashboard (overview) to avoid getting stuck on /get-started
  log("info", "navigating to Dashboard (overview) to verify session...", { url: DASHBOARD_URL });
  try {
    await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 35000 });
    await utils.sleep(2000);
  } catch {
    /* ignore timeout, continue */
  }

  // If redirected to /continue, re-handle legal consent
  if (page.url().includes("/continue")) {
    await stepLegalConsent(page, log);
    await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 35000 });
    await utils.sleep(2000);
  }

  // If stuck on /get-started, try clicking sidebar or Account to break out
  if (page.url().includes("/get-started")) {
    log("info", "on /get-started, trying navigation to break out...");
    const navBtn = await page.$('button.account-side-button:has-text("Overview"), button.account-side-button:has-text("API Keys"), a[href*="/overview"], a[href*="/api-keys"]');
    if (navBtn) {
      await navBtn.click();
      await utils.sleep(2000);
    }
  }

  log("info", "navigating to Zro MoonMath API keys page...", { url: API_KEYS_URL });
  await page.goto(API_KEYS_URL, { waitUntil: "domcontentloaded", timeout: 35000 });
  await utils.sleep(2000);

  // If still on /get-started, click sidebar 'API Keys'
  if (!page.url().includes("/api-keys")) {
    const sideApiKey = await page.$('button.account-side-button:has-text("API Keys"), a[href*="/api-keys"]');
    if (sideApiKey) {
      await sideApiKey.click();
      await utils.sleep(2000);
    } else {
      await page.goto(API_KEYS_URL, { waitUntil: "domcontentloaded", timeout: 35000 });
      await utils.sleep(2000);
    }
  }

  // Click "Create key" button
  log("info", "waiting for 'Create key' button...");
  await page.waitForSelector(SELECTORS.createApiKeyButton, { timeout: 25000 });
  const createBtn = (await page.$(SELECTORS.createApiKeyButton))!;
  await createBtn.click();
  await utils.sleep(1500);

  // Fill API key alias name
  const randomAlias = `agent-prod-${Math.floor(1000 + Math.random() * 9000)}`;
  log("info", "filling API key alias in modal...", { alias: randomAlias });
  await page.waitForSelector(SELECTORS.apiKeyAliasInput, { timeout: 15000 });
  const aliasInput = (await page.$(SELECTORS.apiKeyAliasInput))!;
  await aliasInput.click({ clickCount: 3 });
  await aliasInput.type(randomAlias, { delay: 40 });
  await utils.sleep(600);

  // Submit modal (Create button)
  log("info", "submitting API key creation modal...");
  await page.waitForSelector(SELECTORS.modalSubmitCreateButton, { timeout: 10000 });
  const submitBtn = (await page.$(SELECTORS.modalSubmitCreateButton))!;
  await submitBtn.click();
  await utils.sleep(2000);

  // Extract created API key from apikey-success.html view
  log("info", "waiting for API key to appear in success view...");
  await page.waitForSelector(SELECTORS.apiKeyCodeDisplay, { timeout: 20000 });

  const extractedKey = await page.evaluate(() => {
    // 1. Look for code elements with sk-
    const codes = Array.from(document.querySelectorAll("code"));
    for (const c of codes) {
      const txt = (c.textContent || "").trim();
      if (txt.startsWith("sk-") && txt.length >= 20) {
        return txt;
      }
    }
    // 2. Search entire modal text with regex
    const bodyText = document.body.innerText || "";
    const m = bodyText.match(/\bsk-[A-Za-z0-9_-]{20,}\b/);
    if (m) return m[0];
    return null;
  });

  if (!extractedKey || !API_KEY_RE.test(extractedKey)) {
    throw new Error(`Failed to extract valid Zro MoonMath API key (got: ${extractedKey})`);
  }

  log("info", "successfully extracted API key!", { keyPrefix: extractedKey.slice(0, 8) });

  // Optional: click Done button to dismiss dialog cleanly
  try {
    const doneBtn = await page.$(SELECTORS.doneButton);
    if (doneBtn) {
      await doneBtn.click();
      await utils.sleep(800);
    }
  } catch {
    /* non-critical */
  }

  return extractedKey;
}
