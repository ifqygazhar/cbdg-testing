// ── Flow steps for OpenRouter automation ───────────────────────────
import type { Page } from "puppeteer-core";
import { dom, utils, TempMailClient } from "@ifqy/google-oauth";
import { SELECTORS, API_KEY_RE, VERIFY_LINK_RE } from "./selectors.js";
import type { OpenRouterConfig } from "../config.js";
import type { ULog } from "../log.js";

export const DEFAULT_SIGNUP_URL = "https://openrouter.ai/sign-up";
export const ONBOARDING_URL = "https://openrouter.ai/onboarding";
export const DASHBOARD_URL = "https://openrouter.ai/workspaces/default";
export const API_KEYS_URL = "https://openrouter.ai/workspaces/default/keys";

export interface AccountSession {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  apiKey?: string;
  verificationLink?: string;
}

const FIRST_NAMES = ["Alex", "Jordan", "Taylor", "Morgan", "Sam", "Chris", "Pat", "Riley", "Casey", "Avery", "Jamie", "Logan"];
const LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Miller", "Davis", "Wilson", "Taylor", "Anderson"];

export function generateRandomName(): { firstName: string; lastName: string } {
  const firstName = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)]!;
  const lastName = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)]!;
  return { firstName, lastName };
}

/** Step 1: OpenRouter Registration via Clerk */
export async function stepSignUp(
  page: Page,
  session: AccountSession,
  cfg: OpenRouterConfig,
  log: ULog,
): Promise<void> {
  log("info", "navigating to OpenRouter...", { url: DEFAULT_SIGNUP_URL });
  await page.goto(DEFAULT_SIGNUP_URL, { waitUntil: "domcontentloaded", timeout: 35000 });
  await utils.sleep(2000);

  // If already logged in to workspace / dashboard
  if (page.url().includes("/workspaces") || page.url().includes("/dashboard")) {
    log("info", "already logged in to OpenRouter, skipping registration");
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

  // Mode B: TempMail direct signup
  const names = generateRandomName();
  session.firstName = names.firstName;
  session.lastName = names.lastName;

  log("info", "waiting for Clerk signup form...", {
    email: session.email,
    name: `${session.firstName} ${session.lastName}`,
  });

  // Wait for email address input to mount
  await page.waitForSelector(SELECTORS.emailAddressInput, { timeout: 30000 });
  const emailInput = (await page.$(SELECTORS.emailAddressInput))!;
  await emailInput.click({ clickCount: 3 });
  await emailInput.type(session.email, { delay: 35 });
  await utils.sleep(300);

  // Fill password
  await page.waitForSelector(SELECTORS.passwordInput, { timeout: 15000 });
  const passInput = (await page.$(SELECTORS.passwordInput))!;
  await passInput.click({ clickCount: 3 });
  await passInput.type(session.password, { delay: 35 });
  await utils.sleep(300);

  // Check legal terms checkbox
  try {
    const checkbox = await page.$(SELECTORS.legalAcceptedCheckbox);
    if (checkbox) {
      const isChecked = await page.evaluate((el) => (el as HTMLInputElement).checked, checkbox);
      if (!isChecked) {
        await checkbox.click();
      }
    }
  } catch {
    /* continue */
  }

  await utils.sleep(800);

  // Submit registration form
  log("info", "submitting Clerk registration form...");
  const continueBtn = await page.$(SELECTORS.continueSignUpButton);
  if (!continueBtn) {
    throw new Error("Continue button not found on Clerk signup modal");
  }
  await continueBtn.click();
  await utils.sleep(3000);
}

/** Step 2: Retrieve verification link from TempMail and verify */
export async function stepVerifyEmail(
  page: Page,
  email: string,
  tempMail: TempMailClient,
  log: ULog,
): Promise<string> {
  log("info", "waiting for Clerk verification email from TempMail...", { email });

  const verifyLink = await tempMail.waitForVerificationLink(email, {
    filterSender: "openrouter",
    linkRegex: VERIFY_LINK_RE,
    timeoutMs: 120000,
  });

  log("info", "verification link received", { verifyLink: `${verifyLink.slice(0, 45)}...` });
  await page.goto(verifyLink, { waitUntil: "domcontentloaded", timeout: 35000 });
  await utils.sleep(3000);

  // Wait for redirect away from verify request
  for (let i = 0; i < 15; i++) {
    const u = page.url();
    if (u.includes("/onboarding") || u.includes("/workspaces") || u.includes("/selection")) {
      break;
    }
    await utils.sleep(1000);
  }

  return verifyLink;
}

/** Step 3: Complete Onboarding Survey & Modals */
export async function stepOnboarding(page: Page, log: ULog): Promise<void> {
  log("info", "handling onboarding steps if present...");

  for (let cycle = 0; cycle < 12; cycle++) {
    const curUrl = page.url();
    if (curUrl.includes("/workspaces/default/keys")) {
      break;
    }

    // 1. Welcome Screen ("Welcome to OpenRouter" -> Next)
    const nextBtn = await page.$(SELECTORS.welcomeNextButton);
    if (nextBtn) {
      log("info", "[onboarding] clicking 'Next' on welcome screen...");
      await nextBtn.click();
      await utils.sleep(1500);
      continue;
    }

    // 2. Acquisition question ("Where did you first hear..." -> Radio + Continue)
    const acqRadio = await page.$(SELECTORS.acquisitionRadioFriend);
    if (acqRadio) {
      log("info", "[onboarding] selecting acquisition survey option...");
      await acqRadio.click();
      await utils.sleep(600);
      const acqCont = await page.$(SELECTORS.acquisitionContinueButton);
      if (acqCont) {
        await acqCont.click();
        await utils.sleep(1500);
        continue;
      }
    }

    // 3. Payment Method ("Add a payment method" -> I'll do this later)
    const laterBtn = await page.$(SELECTORS.paymentMethodLaterButton);
    if (laterBtn) {
      log("info", "[onboarding] clicking 'I\\'ll do this later'...");
      await laterBtn.click();
      await utils.sleep(1500);
      continue;
    }

    // 4. You're all set! -> Click "Get API Key"
    const doneBtn = await page.$(SELECTORS.youAreAllSetDoneButton);
    if (doneBtn) {
      log("info", "[onboarding] clicking 'Get API Key'...");
      await doneBtn.click();
      await utils.sleep(2000);
      break;
    }

    // If reached workspaces default or keys
    if (curUrl.includes("/workspaces")) {
      break;
    }

    await utils.sleep(1000);
  }

  log("info", "onboarding handled, navigating directly to keys page...");
  await page.goto(API_KEYS_URL, { waitUntil: "domcontentloaded", timeout: 35000 });
  await utils.sleep(2000);
}

/** Step 4: Create API key with No Expiration and No Limit */
export async function stepCreateApiKey(
  page: Page,
  session: AccountSession,
  cfg: OpenRouterConfig,
  tempMail: TempMailClient,
  log: ULog,
): Promise<string> {
  log("info", "navigating to OpenRouter API keys page...", { url: API_KEYS_URL });
  await page.goto(API_KEYS_URL, { waitUntil: "domcontentloaded", timeout: 35000 });
  await utils.sleep(2000);

  // Click "Create API Key" button
  await page.waitForSelector(SELECTORS.createApiKeyButton, { timeout: 20000 });
  const createBtn = (await page.$(SELECTORS.createApiKeyButton))!;
  await createBtn.click();
  await utils.sleep(1500);

  // 1. Fill Name
  const randomKeyName = `Key-${Math.floor(1000 + Math.random() * 9000)}`;
  log("info", "setting API key name...", { keyName: randomKeyName });
  await page.waitForSelector(SELECTORS.keyNameInput, { timeout: 10000 });
  const nameInput = (await page.$(SELECTORS.keyNameInput))!;
  await nameInput.click({ clickCount: 3 });
  await nameInput.type(randomKeyName, { delay: 40 });
  await utils.sleep(600);

  // 2. Select Expiration: "No expiration"
  try {
    const expBtn = await page.$(SELECTORS.expirationCombobox);
    if (expBtn) {
      await expBtn.click();
      await utils.sleep(600);
      const noExpOpt = await page.$(SELECTORS.dropdownOptionNoExpiration);
      if (noExpOpt) {
        await noExpOpt.click();
        await utils.sleep(500);
      }
    }
  } catch (e) {
    log("warn", "could not select expiration combobox", { error: String(e) });
  }

  // 3. Select Credit Limit: "No limit"
  try {
    const limitBtn = await page.$(SELECTORS.limitCombobox);
    if (limitBtn) {
      await limitBtn.click();
      await utils.sleep(600);
      const noLimitOpt = await page.$(SELECTORS.dropdownOptionNoLimit);
      if (noLimitOpt) {
        await noLimitOpt.click();
        await utils.sleep(500);
      }
    }
  } catch (e) {
    log("warn", "could not select credit limit combobox", { error: String(e) });
  }

  // 4. Submit Create API Key
  log("info", "submitting Create API Key modal...");
  const modalSubmit = await page.$(SELECTORS.modalSubmitCreateButton);
  if (!modalSubmit) {
    throw new Error("Create key submit button not found in modal dialog");
  }
  await modalSubmit.click();
  await utils.sleep(2500);

  // 5. Check if Verification Required OTP popup appears
  const reverifInput = await page.$(SELECTORS.reverificationOtpInput);
  if (reverifInput) {
    log("info", "Verification Required OTP modal appeared, fetching OTP code from TempMail...", { email: session.email });
    const otpCode = await tempMail.waitForVerificationOtp(session.email, { timeoutMs: 90000 });
    log("info", "OTP verification code received", { otpCode });

    await reverifInput.click();
    await reverifInput.type(otpCode, { delay: 50 });
    await utils.sleep(2000);

    // Click continue if needed
    const reverifContinue = await page.$(SELECTORS.reverificationContinueButton);
    if (reverifContinue) {
      await reverifContinue.click();
      await utils.sleep(2500);
    }
  }

  // 6. Extract generated API key
  log("info", "extracting generated API key...");
  let extractedKey: string | null = null;

  // Setup clipboard hook
  try {
    await page.evaluate(() => {
      if (!(window as any).__cbHookInstalled) {
        (window as any).__cbHookInstalled = true;
        (window as any).__copied_key = null;
        if (navigator.clipboard) {
          const orig = navigator.clipboard.writeText?.bind(navigator.clipboard);
          navigator.clipboard.writeText = (text: string) => {
            (window as any).__copied_key = text;
            return orig ? orig(text) : Promise.resolve();
          };
        }
      }
    });
  } catch {}

  for (let attempt = 0; attempt < 25; attempt++) {
    // 6a. Try clicking copy button
    try {
      const copyBtn = await page.$(SELECTORS.copyKeyButton);
      if (copyBtn) {
        await copyBtn.click();
        await utils.sleep(500);
      }
    } catch {}

    // 6b. Check clipboard hook value
    try {
      const copied = await page.evaluate(() => (window as any).__copied_key);
      if (copied && typeof copied === "string") {
        const m = copied.match(API_KEY_RE);
        if (m) {
          extractedKey = m[0];
          break;
        }
      }
    } catch {}

    // 6c. Check onepassword-save-button base64 payload
    try {
      const opVal = await page.evaluate(() => {
        const op = document.querySelector("onepassword-save-button");
        return op ? op.getAttribute("value") : null;
      });
      if (opVal) {
        const decoded = Buffer.from(opVal, "base64").toString("utf8");
        const m = decoded.match(API_KEY_RE);
        if (m) {
          extractedKey = m[0];
          break;
        }
      }
    } catch {}

    // 6d. Check code tags
    const codeElems = await page.$$("code");
    for (const c of codeElems) {
      const txt = (await page.evaluate((el) => el.textContent || "", c)).trim();
      const m = txt.match(API_KEY_RE);
      if (m) {
        extractedKey = m[0];
        break;
      }
    }
    if (extractedKey) break;

    // 6e. Check full page text
    const pageText = await page.evaluate(() => document.body.innerText || "");
    const m = pageText.match(API_KEY_RE);
    if (m) {
      extractedKey = m[0];
      break;
    }

    await utils.sleep(600);
  }

  if (!extractedKey) {
    throw new Error("Failed to extract OpenRouter API key matching sk-or-v1-...");
  }

  log("info", "API key successfully extracted", { apiKey: `${extractedKey.slice(0, 12)}...` });

  // Close modal
  try {
    const closeBtn = await page.$(SELECTORS.closeKeyModalButton);
    if (closeBtn) {
      await closeBtn.click();
      await utils.sleep(500);
    } else {
      await page.keyboard.press("Escape");
    }
  } catch {}

  return extractedKey;
}
