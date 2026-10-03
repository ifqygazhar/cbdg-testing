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

/** Checks if Next.js 'Something snapped.' full-screen error is present. */
export async function checkSomethingSnapped(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const h2 = document.querySelector("h2");
      if (h2 && /something snapped/i.test(h2.textContent || "")) return true;
      const p = document.querySelector("p");
      if (p && /hit an error we didn['’]t expect/i.test(p.textContent || "")) return true;
      return false;
    });
  } catch {
    return false;
  }
}

/** If 'Something snapped.' error screen is displayed, clicks 'Try again' or reloads targetUrl. */
export async function recoverIfSomethingSnapped(
  page: Page,
  targetUrl?: string,
  log?: ULog,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const isSnapped = await checkSomethingSnapped(page);
    if (!isSnapped) return true;

    if (log) {
      log("warn", `'Something snapped.' error screen detected! (recovery attempt ${attempt}/3)`);
    }

    // 1. Try clicking 'Try again' button
    try {
      const clicked = await dom.clickByText(page, ["Try again"], {}, { optional: true });
      if (clicked) {
        if (log) log("info", "clicked 'Try again' button to recover");
        await utils.sleep(2500);
        if (!(await checkSomethingSnapped(page))) {
          if (log) log("info", "Successfully recovered from 'Something snapped' via 'Try again' button!");
          return true;
        }
      }
    } catch {
      // ignore
    }

    // 2. If still snapped, reload or navigate back to targetUrl
    if (await checkSomethingSnapped(page)) {
      if (log) log("info", `reloading page / navigating to ${targetUrl ?? "current URL"} to recover...`);
      try {
        if (targetUrl) {
          await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        } else {
          await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
        }
        await utils.sleep(3000);
        if (!(await checkSomethingSnapped(page))) {
          if (log) log("info", "Successfully recovered from 'Something snapped' after reload!");
          return true;
        }
      } catch (e) {
        if (log) log("warn", `Reload failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return !(await checkSomethingSnapped(page));
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
  const pace = cfg.pace ?? "human";
  const mult = pace === "careful" ? 1.4 : pace === "fast" ? 0.85 : 1.0;

  await page.goto(DEFAULT_SIGNUP_URL, { waitUntil: "domcontentloaded", timeout: 35000 });
  await utils.sleep(Math.round(2500 * mult));
  await recoverIfSomethingSnapped(page, DEFAULT_SIGNUP_URL, log);

  await dismissCookieBanners(page, log);
  await utils.sleep(Math.round(1000 * mult));

  log("info", "filling signup form with human cadence", { email: session.email, pace });
  const emailInput = await dom.waitForAnySelector(page, [SELECTORS.emailInput], 10000);
  if (!emailInput) {
    throw new Error("Could not find or fill email input on signup page");
  }
  await emailInput.click();
  await utils.sleep(Math.round(400 * mult));
  for (const char of session.email) {
    if ("@._-".includes(char) || Math.random() < 0.08) {
      await utils.sleep(utils.randomInt(100, 250));
    }
    await emailInput.type(char, { delay: utils.randomInt(50, 115) });
  }
  await emailInput.dispose().catch(() => {});

  // Natural pause between email and password
  await utils.sleep(Math.round(utils.randomInt(1500, 2600) * mult));

  const passInput = await dom.waitForAnySelector(page, [SELECTORS.passwordInput], 10000);
  if (!passInput) {
    throw new Error("Could not find or fill password input on signup page");
  }
  await passInput.click();
  await utils.sleep(Math.round(400 * mult));
  for (const char of session.password) {
    if ("1234567890!#_".includes(char) || Math.random() < 0.08) {
      await utils.sleep(utils.randomInt(100, 250));
    }
    await passInput.type(char, { delay: utils.randomInt(55, 120) });
  }
  await passInput.dispose().catch(() => {});

  // Natural human pause before submit: 4.0 - 6.0 seconds (prevents speed warning)
  log("info", "pausing naturally before submit (human verification)");
  await utils.sleep(Math.round(utils.randomInt(4000, 6000) * mult));

  // Click submit (Create account)
  log("info", "submitting signup form");
  const submitBtn = await dom.waitForAnySelector(page, [SELECTORS.submitSignUpButton], 10000);
  if (!submitBtn) {
    if (!page.url().includes("/dashboard")) {
      throw new Error("Create account button not found");
    }
  } else {
    await submitBtn.click();
    await submitBtn.dispose().catch(() => {});
  }

  // Poll for dashboard redirect or immediate error / warning
  let signupError: string | null = null;
  for (let i = 0; i < 30; i++) {
    if (page.url().includes("/dashboard")) break;

    // Check if Next.js 'Something snapped.' error screen appeared
    if (await checkSomethingSnapped(page)) {
      log("warn", "'Something snapped.' full-screen error detected! Recovering and repeating submit step...");
      const recovered = await recoverIfSomethingSnapped(page, DEFAULT_SIGNUP_URL, log);
      if (recovered) {
        if (page.url().includes("/dashboard")) break;
        const retryBtn = await dom.waitForAnySelector(page, [SELECTORS.submitSignUpButton], 5000);
        if (retryBtn) {
          log("info", "re-submitting signup form after recovering from 'Something snapped'...");
          await retryBtn.click();
          await retryBtn.dispose().catch(() => {});
          continue;
        }
      }
    }

    const foundError = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el && el.textContent) {
        const t = el.textContent.trim();
        if (t && !/sending|checking|one moment/i.test(t)) return t;
      }
      const allEls = document.querySelectorAll('form p, form div, [role="alert"], p');
      const warningPattern = /couldn['’]t create your account|team has been alerted|not supported|take a breath|doing that a bit fast|too many attempts|slow down|support@tokenharbor\.ai|try again in a minute|invalid email|already registered/i;
      for (const node of allEls) {
        const t = node.textContent?.trim() || "";
        if (t && warningPattern.test(t)) return t;
      }
      return null;
    }, SELECTORS.errorMessage);

    if (foundError) {
      signupError = foundError;
      break;
    }
    await utils.sleep(500);
  }

  if (signupError) {
    log("warn", `TokenHarbor warning/error detected: "${signupError}". Skipping account immediately to switch to different IP...`);
    throw new Error(`Signup rejected: ${signupError}`);
  }

  // Wait for redirect to dashboard or navigation
  const reachedDashboard = await Promise.race([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).then(() => true).catch(() => false),
    (async () => {
      for (let i = 0; i < 20; i++) {
        if (page.url().includes("/dashboard")) return true;
        await utils.sleep(500);
      }
      return false;
    })(),
  ]);

  if (!reachedDashboard && !page.url().includes("/dashboard")) {
    if (await checkSomethingSnapped(page)) {
      log("warn", "'Something snapped.' detected waiting for dashboard! Attempting recovery...");
      await recoverIfSomethingSnapped(page, DEFAULT_SIGNUP_URL, log);
    }
    const errorText = await page.evaluate((sel) => {
      const errEl = document.querySelector(sel);
      return errEl ? errEl.textContent?.trim() : null;
    }, SELECTORS.errorMessage);
    if (errorText) {
      throw new Error(`Signup rejected: ${errorText}`);
    }
    throw new Error(`Signup timed out without reaching /dashboard (URL: ${page.url()})`);
  }

  log("info", "dashboard reached after signup", { url: page.url() });
  await utils.sleep(1500);
}

/** Step 2: Enables free models consent on dashboard if prompted */
export async function stepEnableFreeModels(page: Page, log: ULog): Promise<void> {
  log("info", "checking free models consent banner");
  await recoverIfSomethingSnapped(page, DASHBOARD_URL, log);
  try {
    const btn = await dom.waitForAnySelector(page, [SELECTORS.enableFreeModelsConsent], 4000);
    if (btn) {
      log("info", "clicking Enable free models button");
      await btn.click();
      await utils.sleep(1000);
      await recoverIfSomethingSnapped(page, DASHBOARD_URL, log);
    }
  } catch {
    // If modal/banner not present, continue
  }
}

/** Step 3: Clicks 'Verify email' banner on dashboard to trigger verification link */
export async function stepTriggerVerification(page: Page, log: ULog): Promise<void> {
  log("info", "checking verify email banner");
  await recoverIfSomethingSnapped(page, DASHBOARD_URL, log);
  const verifyBtn = await dom.waitForAnySelector(page, [SELECTORS.verifyEmailBannerButton], 8000);
  if (verifyBtn) {
    log("info", "clicking Verify email button to send verification link");
    await verifyBtn.click();
    await utils.sleep(2000);
    await recoverIfSomethingSnapped(page, DASHBOARD_URL, log);
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
  await recoverIfSomethingSnapped(page, verifyUrl, log);

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

  let apiKey: string | null = null;
  for (let keyAttempt = 1; keyAttempt <= 3; keyAttempt++) {
    await recoverIfSomethingSnapped(page, API_KEYS_URL, log);

    // Look for "+ New key" button
    log("info", `clicking + New key button (attempt ${keyAttempt}/3)`);
    const newKeyBtn = await dom.waitForAnySelector(page, [SELECTORS.newKeyButton], 15000);
    if (!newKeyBtn) {
      if (await checkSomethingSnapped(page)) {
        log("warn", "'Something snapped.' detected on API keys page! Retrying...");
        await recoverIfSomethingSnapped(page, API_KEYS_URL, log);
        continue;
      }
      throw new Error("+ New key button not found on API keys page");
    }
    await newKeyBtn.click();
    await utils.sleep(1000);

    // Label input dialog
    const label = `App-${session.email.split("@")[0].slice(0, 8)}-${utils.randomInt(10, 99)}`;
    log("info", "typing key label", { label });
    const keyLabelInput = await dom.waitForAnySelector(page, [SELECTORS.keyLabelInput], 10000);
    if (!keyLabelInput) {
      if (await checkSomethingSnapped(page)) {
        log("warn", "'Something snapped.' detected while opening key modal! Retrying...");
        await recoverIfSomethingSnapped(page, API_KEYS_URL, log);
        continue;
      }
      throw new Error("Could not find key label input in create dialog");
    }
    await dom.fillInput(page, keyLabelInput, label);
    await keyLabelInput.dispose().catch(() => {});
    await utils.sleep(500);

    // Click "Create key" submit button
    log("info", "submitting key creation");
    const createSubmitBtn = await dom.waitForAnySelector(page, [SELECTORS.createKeySubmitButton], 10000);
    if (!createSubmitBtn) {
      if (await checkSomethingSnapped(page)) {
        log("warn", "'Something snapped.' detected before create submit! Retrying...");
        await recoverIfSomethingSnapped(page, API_KEYS_URL, log);
        continue;
      }
      throw new Error("Create key submit button not found");
    }
    await createSubmitBtn.click();
    await utils.sleep(2000);

    // Extract created API key from modal
    log("info", "extracting generated API key");
    for (let i = 0; i < 20; i++) {
      if (await checkSomethingSnapped(page)) break;
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

    if (apiKey) break;

    if (await checkSomethingSnapped(page)) {
      log("warn", "'Something snapped.' detected after creating key! Retrying key creation step...");
      await recoverIfSomethingSnapped(page, API_KEYS_URL, log);
      continue;
    }

    break;
  }

  if (!apiKey) {
    throw new Error("Failed to extract TokenHarbor API key from confirmation dialog");
  }

  log("info", "API key extracted successfully", { apiKey: `${apiKey.slice(0, 12)}...` });
  session.apiKey = apiKey;
  return apiKey;
}
