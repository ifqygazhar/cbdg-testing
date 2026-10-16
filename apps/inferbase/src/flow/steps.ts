// ── Flow steps for Inferbase automation ───────────────────────────
import type { Page } from "puppeteer-core";
import { dom, utils, TempMailClient } from "@ifqy/google-oauth";
import { SELECTORS, API_KEY_RE, VERIFY_LINK_RE } from "./selectors.js";
import type { InferbaseConfig } from "../config.js";
import type { ULog } from "../log.js";

export const DEFAULT_SIGNUP_URL = "https://inferbase.ai/register";
export const ONBOARDING_URL = "https://inferbase.ai/onboarding";
export const DASHBOARD_URL = "https://inferbase.ai/dashboard";
export const API_KEYS_URL = "https://inferbase.ai/api-keys";

export interface AccountSession {
  email: string;
  password: string;
  fullName?: string;
  company?: string;
  apiKey?: string;
  verificationLink?: string;
}

const FIRST_NAMES = ["Alex", "Jordan", "Taylor", "Morgan", "Sam", "Chris", "Pat", "Riley", "Casey", "Avery", "Jamie", "Logan"];
const LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Miller", "Davis", "Wilson", "Taylor", "Anderson"];
const COMPANIES = ["Acme AI", "TechVentures", "DataFlow Inc", "CloudScale", "Nexus Labs", "Cognitive Systems", "AlphaByte"];

export function generateRandomName(): string {
  const f = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const l = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  return `${f} ${l}`;
}

export function generateRandomCompany(): string {
  return COMPANIES[Math.floor(Math.random() * COMPANIES.length)];
}

export async function dismissTurnstileModal(page: Page): Promise<void> {
  try {
    await page.keyboard.press("Escape");
  } catch {}
  try {
    for (const f of page.frames()) {
      try {
        await f.evaluate(() => {
          const closeBtns = document.querySelectorAll<HTMLElement>(
            'button[aria-label*="close" i], button[aria-label*="關閉" i], [role="dialog"] button, button.close, svg[aria-label*="close" i]'
          );
          for (const b of closeBtns) {
            b.click();
            return;
          }
        });
      } catch {}
    }
    await page.evaluate(() => {
      const closeBtns = document.querySelectorAll<HTMLElement>(
        'button[aria-label*="close" i], button[aria-label*="關閉" i], [role="dialog"] button, button.close'
      );
      for (const b of closeBtns) {
        b.click();
        return;
      }
    });
  } catch {}
}

/** Step 1: Register on Inferbase (/register) */
export async function stepSignUp(
  page: Page,
  session: AccountSession,
  cfg: InferbaseConfig,
  log: ULog,
): Promise<void> {
  log("info", "navigating to Inferbase registration page...", { url: DEFAULT_SIGNUP_URL });
  await page.goto(DEFAULT_SIGNUP_URL, { waitUntil: "domcontentloaded", timeout: 35000 });
  await utils.sleep(2000);

  if (cfg.authMethod === "google") {
    log("info", "clicking 'Continue with Google'...");
    const googleBtn = await page.$(SELECTORS.googleOAuthLink);
    if (!googleBtn) {
      throw new Error("Continue with Google button not found on /register");
    }
    await googleBtn.click();
    await utils.sleep(3000);
    // Google OAuth flow should follow
    return;
  }

  // TempMail registration flow
  session.fullName ||= generateRandomName();
  session.company ||= generateRandomCompany();

  log("info", "filling signup form...", {
    email: session.email,
    name: session.fullName,
    company: session.company,
  });

  await page.waitForSelector(SELECTORS.emailInput, { timeout: 15000 });

  await page.type(SELECTORS.emailInput, session.email, { delay: 30 });
  await utils.sleep(300);

  await page.type(SELECTORS.fullNameInput, session.fullName, { delay: 30 });
  await utils.sleep(300);

  await page.type(SELECTORS.companyInput, session.company, { delay: 30 });
  await utils.sleep(300);

  await page.type(SELECTORS.passwordInput, session.password, { delay: 30 });
  await utils.sleep(300);

  await page.type(SELECTORS.confirmPasswordInput, session.password, { delay: 30 });
  await utils.sleep(1000);

  // Ensure Turnstile container is scrolled into center view
  try {
    await page.evaluate(() => {
      const cf = document.querySelector('input[name="cf-turnstile-response"], .cf-turnstile, iframe[src*="challenges.cloudflare.com"]');
      if (cf) cf.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    await utils.sleep(500);
  } catch {}

  log("info", "checking and resolving Cloudflare Turnstile token...");
  const maxWaitSec = !cfg.headless ? 45 : 25;

  let lastNotice = Date.now();
  let turnstileReady = false;
  for (let i = 0; i < maxWaitSec; i++) {
    // Dismiss any troubleshooting popup modal if opened
    await dismissTurnstileModal(page);

    const token = await page.evaluate(() => {
      const el = document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement;
      return el ? el.value : "";
    });
    if (token && token.length > 10) {
      log("info", "✅ Cloudflare Turnstile token detected and ready");
      turnstileReady = true;
      break;
    }

    // Auto-click Turnstile checkbox in both headed and headless modes
    const frames = page.frames();
    for (const f of frames) {
      if (f.url().includes("challenges.cloudflare.com") || f.url().includes("turnstile")) {
        try {
          const checkbox = await f.$("input[type='checkbox'], span.mark, .ctp-checkbox-label");
          if (checkbox) {
            await checkbox.click({ delay: 60 });
            log("info", "clicked Turnstile challenge checkbox in frame");
          }
        } catch {}
      }
    }

    if (!cfg.headless && i > 15) {
      if (Date.now() - lastNotice >= 10000) {
        log("info", `⏳ Menunggu verifikasi Turnstile (${maxWaitSec - i}s tersisa)...`);
        lastNotice = Date.now();
      }
    }
    await utils.sleep(1000);
  }

  // Wait for submit button to be enabled
  for (let j = 0; j < 16; j++) {
    const disabled = await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"]') as HTMLButtonElement;
      return btn ? (btn.disabled || btn.getAttribute('disabled') !== null) : false;
    });
    if (!disabled) break;
    await utils.sleep(500);
  }

  log("info", "submitting signup form...");
  const submitBtn = await page.$(SELECTORS.submitSignUpButton);
  if (!submitBtn) {
    throw new Error("Create account button not found");
  }
  await submitBtn.click();

  // Wait for submission response / navigation
  await utils.sleep(4000);
}

/** Step 2: Retrieve email verification link & confirm */
export async function stepVerifyEmail(
  page: Page,
  email: string,
  tempMail: TempMailClient,
  log: ULog,
): Promise<string> {
  log("info", "waiting for verification email from TempMail...", { email });

  const message = await tempMail.waitForEmail(email, {
    timeoutSec: 120,
    intervalSec: 4,
    predicate: (m) =>
      /inferbase/i.test(m.subject || "") ||
      /verify/i.test(m.subject || "") ||
      /inferbase\.ai\/verify-email/i.test(m.body || "") ||
      /inferbase\.ai\/verify-email/i.test(m.html || ""),
  });

  if (!message) {
    throw new Error(`Timeout waiting for Inferbase verification email for ${email}`);
  }

  const content = `${message.body || ""} ${message.html || ""}`;
  const match = content.match(VERIFY_LINK_RE);
  if (!match) {
    throw new Error(`Verification link matching pattern not found in email for ${email}`);
  }

  const verifyUrl = match[0].replace(/&amp;/g, "&");
  log("info", "found verification link, visiting...", { verifyUrl });

  await page.goto(verifyUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
  await utils.sleep(2000);

  // Direct navigation to onboarding URL as requested
  log("info", `email verified! Navigating directly to onboarding: ${ONBOARDING_URL}`);
  await page.goto(ONBOARDING_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await utils.sleep(2000);

  return verifyUrl;
}

/** Helper to check whether Inferbase dashboard is legitimately rendered */
export async function isDashboardRendered(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    if (url.includes("/onboarding")) return false;
    if (url.includes("/dashboard") || url.includes("/api-keys")) {
      const isRendered = await page.evaluate(() => {
        const navLinks = document.querySelectorAll('a[href*="/api-keys"], a[href*="/dashboard"], a[href*="/usage"], a[href*="/routing-policies"]');
        const btns = Array.from(document.querySelectorAll("button"));
        const hasGoDash = btns.some((b) => b.textContent && b.textContent.includes("Go to Dashboard"));
        const hasYourAccountReady = document.body ? document.body.innerText.includes("Your account is ready") : false;
        return navLinks.length > 0 && !hasGoDash && !hasYourAccountReady;
      });
      return Boolean(isRendered);
    }
  } catch {}
  return false;
}

/** Step 3: Handle onboarding survey steps and skip to dashboard */
export async function stepOnboarding(page: Page, log: ULog): Promise<void> {
  const currentUrl = page.url();
  log("info", "checking onboarding status...", { currentUrl });

  // If already on rendered dashboard, we are done
  if (await isDashboardRendered(page)) {
    log("info", "✅ Inferbase dashboard already active and rendered!");
    return;
  }

  if (!currentUrl.includes("/onboarding") && !currentUrl.includes("/dashboard")) {
    log("info", `navigating to onboarding: ${ONBOARDING_URL}`);
    await page.goto(ONBOARDING_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await utils.sleep(2500);
  }

  // Click 'Get started' if present
  try {
    const getStartedBtn = await page.$(SELECTORS.onboardingGetStartedButton);
    if (getStartedBtn) {
      log("info", "clicking 'Get started' button...");
      await getStartedBtn.click();
      await utils.sleep(2000);
    }
  } catch {}

  // Loop clicking 'Skip' until 'Go to Dashboard' appears or dashboard reached
  for (let step = 1; step <= 10; step++) {
    if (await isDashboardRendered(page)) {
      log("info", "already reached dashboard!");
      return;
    }

    // Check if 'Go to Dashboard' is visible
    const goToDashBtn = await page.$(SELECTORS.onboardingGoToDashboardButton);
    if (goToDashBtn) {
      log("info", "found 'Go to Dashboard' button, resolving transition to dashboard...");
      break;
    }

    // Check if 'Skip' button is visible
    const skipBtn = await page.$(SELECTORS.onboardingSkipButton);
    if (skipBtn) {
      log("info", `clicking 'Skip' button (step ${step})...`);
      await skipBtn.click();
      await utils.sleep(1500);
      continue;
    }

    // Check if 'Continue' is visible
    const continueBtn = await page.$(SELECTORS.onboardingContinueButton);
    if (continueBtn) {
      log("info", `clicking 'Continue' button (step ${step})...`);
      await continueBtn.click();
      await utils.sleep(1500);
      continue;
    }

    // Neither found, wait a moment
    await utils.sleep(1000);
  }

  // Ensure 'Go to Dashboard' succeeds and Dashboard is rendered
  log("info", "ensuring dashboard page is rendered (handling error toasts if any)...");
  for (let attempt = 1; attempt <= 6; attempt++) {
    if (await isDashboardRendered(page)) {
      log("info", "✅ Inferbase dashboard successfully rendered!");
      return;
    }

    const goToDashBtn = await page.$(SELECTORS.onboardingGoToDashboardButton);
    if (goToDashBtn) {
      log("info", `clicking 'Go to Dashboard' button (attempt ${attempt}/6)...`);
      try {
        await goToDashBtn.click();
      } catch {
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll("button")).find((b) =>
            b.textContent?.includes("Go to Dashboard"),
          );
          btn?.click();
        });
      }
      await utils.sleep(2500);
    }

    // Check if toast 'Something went wrong' appeared
    const toastMsg = await page.evaluate(() => {
      const toast = document.querySelector('[data-sonner-toast], [role="status"], [role="alert"]');
      if (toast && /something went wrong|failed|error/i.test(toast.textContent || "")) {
        return toast.textContent;
      }
      return null;
    });
    if (toastMsg) {
      log("warn", `⚠️ Toast error detected: '${toastMsg.trim()}'. Re-clicking 'Go to Dashboard'...`);
      await utils.sleep(2000);
      continue;
    }

    for (let w = 0; w < 5; w++) {
      if (await isDashboardRendered(page)) {
        log("info", "✅ Inferbase dashboard successfully rendered!");
        return;
      }
      await utils.sleep(1000);
    }

    if (attempt >= 3 && !page.url().includes("/dashboard")) {
      log("info", "attempting direct navigation to dashboard...", { url: DASHBOARD_URL });
      await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
      await utils.sleep(2500);
    }
  }

  // Ensure dashboard navigation
  if (!page.url().includes("/dashboard")) {
    log("info", "navigating directly to dashboard...", { url: DASHBOARD_URL });
    await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await utils.sleep(2500);
  }
}

/** Step 4: Create & extract API key from /api-keys */
export async function stepCreateApiKey(
  page: Page,
  session: AccountSession,
  cfg: InferbaseConfig,
  log: ULog,
): Promise<string> {
  // Ensure dashboard was rendered before opening /api-keys
  if (page.url().includes("/onboarding")) {
    log("info", "still on /onboarding, resolving onboarding before /api-keys...");
    await stepOnboarding(page, log);
  }

  log("info", "navigating to API keys page...", { url: API_KEYS_URL });
  await page.goto(API_KEYS_URL, { waitUntil: "domcontentloaded", timeout: 35000 });
  await utils.sleep(2500);

  // If redirected back to /onboarding, resolve it
  if (page.url().includes("/onboarding")) {
    log("info", "redirected back to /onboarding, re-running onboarding...");
    await stepOnboarding(page, log);
    await page.goto(API_KEYS_URL, { waitUntil: "domcontentloaded", timeout: 35000 });
    await utils.sleep(2500);
  }

  // Click 'Create key' button
  log("info", "waiting for 'Create key' button...");
  await page.waitForSelector(SELECTORS.createKeyButton, { timeout: 15000 });
  const createKeyBtn = await page.$(SELECTORS.createKeyButton);
  if (!createKeyBtn) {
    throw new Error("Create key button not found on /api-keys");
  }
  await createKeyBtn.click();
  await utils.sleep(2000);

  // Type key name in modal dialog
  log("info", "filling key name in modal dialog...");
  await page.waitForSelector(SELECTORS.keyNameInput, { timeout: 15000 });
  const keyName = `Key-${Math.random().toString(36).substring(2, 8)}`;
  await page.type(SELECTORS.keyNameInput, keyName, { delay: 25 });
  await utils.sleep(500);

  // Click 'Create key' in modal
  log("info", "submitting 'Create key' modal...");
  let modalCreateBtn = await page.$(SELECTORS.modalCreateKeyButton);
  if (!modalCreateBtn) {
    modalCreateBtn = (await page.evaluateHandle(() => {
      const dialog = document.querySelector('div[role="dialog"]');
      if (dialog) {
        const btns = Array.from(dialog.querySelectorAll("button"));
        return btns.find((b) => b.textContent?.trim() === "Create key") || null;
      }
      return null;
    })) as any;
  }
  if (!modalCreateBtn) {
    throw new Error("Modal 'Create key' button not found");
  }
  try {
    await modalCreateBtn.click();
  } catch {
    await page.evaluate(() => {
      const dialog = document.querySelector('div[role="dialog"]');
      if (dialog) {
        const btns = Array.from(dialog.querySelectorAll("button"));
        const btn = btns.find((b) => b.textContent?.trim() === "Create key");
        btn?.click();
      }
    });
  }
  await utils.sleep(3000);

  // Wait for API key code element or text
  log("info", "extracting generated API key...");
  let apiKey: string | null = null;

  for (let attempt = 0; attempt < 10; attempt++) {
    // 1. Try reading code elements
    const codeTexts = await page.evaluate(() => {
      const codes = Array.from(document.querySelectorAll("code"));
      return codes.map((c) => c.textContent || "");
    });

    for (const text of codeTexts) {
      const match = text.match(API_KEY_RE);
      if (match) {
        apiKey = match[0];
        break;
      }
    }

    if (apiKey) break;

    // 2. Try page content regex
    const content = await page.content();
    const match = content.match(API_KEY_RE);
    if (match) {
      apiKey = match[0];
      break;
    }

    await utils.sleep(1000);
  }

  if (!apiKey) {
    throw new Error("Failed to extract API key matching inf_[A-Za-z0-9_-]{20,}");
  }

  log("info", "API key successfully obtained!", { keyPrefix: apiKey.substring(0, 10) + "..." });

  // Click 'Done' button to close modal
  try {
    const doneBtn = await page.$(SELECTORS.doneButton);
    if (doneBtn) {
      await doneBtn.click();
      await utils.sleep(1000);
    }
  } catch {}

  return apiKey;
}
