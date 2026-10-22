// ── Granular step functions for Composite Signup (Puppeteer/Bun) ──
import type { Page } from "puppeteer-core";
import { SELECTORS, COMPOSITE_KEY_REGEX, COMPOSITE_KEY_FALLBACK_REGEX } from "./selectors.js";
import type { CompositeConfig } from "../config.js";
import type { ULog } from "../log.js";

function sanitizeUsername(email: string): string {
  const localPart = email.split("@")[0] || "user";
  let user = localPart.replace(/[^a-zA-Z0-9_.-]/g, "");
  if (user.length < 3) {
    user = `${user}${Math.floor(100 + Math.random() * 900)}`;
  }
  if (user.length > 30) {
    user = user.substring(0, 30);
  }
  return user;
}

export async function stepNavigateSignup(page: Page, logger: ULog): Promise<void> {
  logger("info", "navigating to signup page", { url: SELECTORS.signup.url });
  await page.goto(SELECTORS.signup.url, { waitUntil: "domcontentloaded", timeout: 35000 });
}

export async function stepEnsureRegisterTab(page: Page, logger: ULog): Promise<void> {
  const isAlreadyActive = await page.evaluate(() => {
    const active = document.querySelector('.tabs button.tab.active, button[role="tab"][aria-selected="true"]');
    return active ? (active.textContent || "").includes("Register") : false;
  });

  if (!isAlreadyActive) {
    logger("info", "switching to Register tab...");
    const regTab = await page.$(SELECTORS.signup.registerTab);
    if (regTab) {
      await regTab.click();
      await new Promise((r) => setTimeout(r, 600));
    }
  }
}

export async function stepFillRegistration(
  page: Page,
  email: string,
  cfg: CompositeConfig,
  logger: ULog,
): Promise<{ username: string; password: string }> {
  await stepEnsureRegisterTab(page, logger);

  const username = sanitizeUsername(email);
  const password = cfg.defaultPassword;

  logger("info", "filling registration form", { username, email });

  // Type username
  await page.waitForSelector(SELECTORS.signup.usernameInput, { timeout: 15000 });
  await page.click(SELECTORS.signup.usernameInput);
  await page.type(SELECTORS.signup.usernameInput, username, { delay: 40 });

  // Type email
  await page.click(SELECTORS.signup.emailInput);
  await page.type(SELECTORS.signup.emailInput, email, { delay: 35 });

  // Type password
  await page.click(SELECTORS.signup.passwordInput);
  await page.type(SELECTORS.signup.passwordInput, password, { delay: 30 });

  // Type confirm password
  await page.click(SELECTORS.signup.confirmPasswordInput);
  await page.type(SELECTORS.signup.confirmPasswordInput, password, { delay: 30 });

  return { username, password };
}

export async function stepWaitForTurnstile(page: Page, logger: ULog, timeoutMs = 30000): Promise<boolean> {
  logger("info", "waiting for Cloudflare Turnstile token...");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hasToken = await page.evaluate(() => {
      const inp = document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null;
      return inp && inp.value && inp.value.length > 20;
    });

    if (hasToken) {
      logger("info", "Cloudflare Turnstile token detected!");
      return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  logger("warn", "Turnstile token not detected within timeout (may need Camoufox engine for auto-solve)");
  return false;
}

export async function stepSubmitRegistration(page: Page, logger: ULog): Promise<void> {
  logger("info", "submitting registration form...");

  const submitBtn = await page.$(SELECTORS.signup.submitButton);
  if (!submitBtn) {
    throw new Error("Could not find submit button on registration form");
  }

  await submitBtn.click();

  // Wait for either navigation to dashboard/account or error alert
  const startTime = Date.now();
  while (Date.now() - startTime < 20000) {
    const url = page.url();
    if (url.includes("/dashboard.html") || url.includes("/account.html") || url.includes("/apikeys.html")) {
      logger("info", "successfully reached dashboard/account page", { url });
      return;
    }

    const err = await page.evaluate(() => {
      const alert = document.querySelector(".alert.alert-error") as HTMLElement | null;
      return alert && alert.offsetParent !== null ? alert.textContent?.trim() : null;
    });

    if (err) {
      throw new Error(`Registration failed with error alert: ${err}`);
    }

    await new Promise((r) => setTimeout(r, 600));
  }
}

export async function stepNavigateApiKeys(page: Page, logger: ULog): Promise<void> {
  logger("info", "navigating to API Keys page...", { url: SELECTORS.apikeys.url });
  await page.goto(SELECTORS.apikeys.url, { waitUntil: "domcontentloaded", timeout: 30000 });
}

export async function stepCreateApiKey(page: Page, logger: ULog): Promise<string> {
  logger("info", "opening New API key modal...");
  await page.waitForSelector(SELECTORS.apikeys.newKeyButton, { timeout: 15000 });
  await page.click(SELECTORS.apikeys.newKeyButton);

  await page.waitForSelector(SELECTORS.apikeys.keyNameInput, { timeout: 10000 });
  const keyName = `Key-${Math.floor(1000 + Math.random() * 9000)}`;
  await page.type(SELECTORS.apikeys.keyNameInput, keyName, { delay: 30 });

  logger("info", "submitting key creation form...", { keyName });
  const submitBtn = await page.$(SELECTORS.apikeys.submitCreateButton);
  if (submitBtn) {
    await submitBtn.click();
  } else {
    await page.keyboard.press("Enter");
  }

  // Wait for key display modal
  logger("info", "waiting for created API key display...");
  await page.waitForSelector(SELECTORS.apikeys.keyDisplay, { timeout: 15000 });

  const rawKey = await page.$eval(SELECTORS.apikeys.keyDisplay, (el) => el.textContent?.trim() || "");

  const match = rawKey.match(COMPOSITE_KEY_REGEX) || rawKey.match(COMPOSITE_KEY_FALLBACK_REGEX);
  if (!match) {
    throw new Error(`Extracted text does not match Composite API key format: "${rawKey}"`);
  }

  const apiKey = match[0];
  logger("info", "API key successfully created and extracted!", { apiKey: `${apiKey.substring(0, 8)}...` });
  return apiKey;
}
