// ── Flow steps for GroqCloud automation ─────────────────────────────
import type { Page } from "puppeteer-core";
import { dom, utils, TempMailClient } from "@ifqy/google-oauth";
import { SELECTORS, API_KEY_RE, MAGIC_LINK_RE } from "./selectors.js";
import type { GroqCloudConfig } from "../config.js";
import type { ULog } from "../log.js";

const DEFAULT_SIGNUP_URL = "https://console.groq.com/home";
const API_KEYS_URL = "https://console.groq.com/keys";

export interface AccountSession {
  email: string;
  password?: string;
  apiKey?: string;
  magicLink?: string;
}

/** Dismisses cookie/analytics consent banner if present */
export async function dismissCookieBanners(page: Page, log: ULog): Promise<void> {
  try {
    const clicked = await dom.clickByText(page, ["Accept all", "Accept", "Essential only"], {}, { optional: true });
    if (clicked) {
      log("info", "cookie banner dismissed");
      await utils.sleep(500);
    }
  } catch {
    // optional banner, ignore
  }
}

/** Step 1: Navigates to signup page, fills email, and submits */
export async function stepSignUp(
  page: Page,
  session: AccountSession,
  cfg: GroqCloudConfig,
  log: ULog,
): Promise<void> {
  log("info", "navigating to GroqCloud signup page", { url: DEFAULT_SIGNUP_URL });
  await page.goto(DEFAULT_SIGNUP_URL, { waitUntil: "domcontentloaded", timeout: 35000 });
  await utils.sleep(1500);
  await dismissCookieBanners(page, log);

  log("info", "waiting for email input field...");
  const emailInput = await dom.waitForAnySelector(page, [SELECTORS.emailInput], 15000);
  if (!emailInput) {
    throw new Error("Could not find email input on GroqCloud signup page");
  }

  log("info", "typing email address...", { email: session.email });
  await dom.fillInput(page, emailInput, session.email);
  await emailInput.dispose().catch(() => {});
  await utils.sleep(800);

  log("info", "clicking Continue with email button...");
  const submitBtn = await dom.waitForAnySelector(page, [SELECTORS.submitEmailButton], 10000);
  if (!submitBtn) {
    throw new Error("Could not find Continue with email submit button");
  }
  await submitBtn.click();
  await submitBtn.dispose().catch(() => {});
  await utils.sleep(2000);

  // Verify transition to 'Check your email'
  let checkEmailSeen = false;
  for (let i = 0; i < 20; i++) {
    const hasText = await page.evaluate(() => {
      const text = document.body.innerText || "";
      return /check your email|an email was sent/i.test(text);
    });
    if (hasText) {
      checkEmailSeen = true;
      break;
    }
    await utils.sleep(500);
  }

  if (!checkEmailSeen) {
    log("warn", "Did not explicitly observe 'Check your email' text, proceeding to check inbox anyway...");
  } else {
    log("info", "'Check your email' screen confirmed");
  }
}

/** Step 2: Polls TempMail inbox for Stytch magic link, navigates to it, and waits for redirect */
export async function stepPollMagicLinkAndLogin(
  page: Page,
  email: string,
  tempMail: TempMailClient,
  log: ULog,
): Promise<string> {
  log("info", "waiting for magic link email from TempMail", { email });
  const magicLink = await tempMail.waitForVerificationLink(email, {
    timeoutMs: 75000,
    intervalMs: 2500,
    filterSender: "",
    linkRegex: MAGIC_LINK_RE,
  });

  log("info", "magic link received", { magicLink });
  await page.goto(magicLink, { waitUntil: "domcontentloaded", timeout: 35000 });
  await utils.sleep(3000);

  // Wait for redirect to console.groq.com
  let authenticated = false;
  for (let i = 0; i < 25; i++) {
    const url = page.url();
    if (url.includes("console.groq.com") && !url.includes("stytch.com")) {
      authenticated = true;
      break;
    }
    await utils.sleep(500);
  }

  log("info", "magic link authentication completed", { currentUrl: page.url(), authenticated });
  return magicLink;
}

/** Step 3: Navigates to /keys, handles Cloudflare Turnstile, submits, and extracts API key */
export async function stepCreateApiKey(
  page: Page,
  session: AccountSession,
  cfg: GroqCloudConfig,
  log: ULog,
): Promise<string> {
  log("info", "navigating to API keys page", { url: API_KEYS_URL });
  await page.goto(API_KEYS_URL, { waitUntil: "domcontentloaded", timeout: 35000 });
  await utils.sleep(1500);
  await dismissCookieBanners(page, log);

  log("info", "clicking Create API Key button...");
  const createKeyBtn = await dom.waitForAnySelector(page, [SELECTORS.createKeyButton], 15000);
  if (!createKeyBtn) {
    throw new Error("Could not find Create API Key button on /keys");
  }
  await createKeyBtn.click();
  await createKeyBtn.dispose().catch(() => {});
  await utils.sleep(1000);

  // Fill display name
  const keyLabel = `App-${session.email.split("@")[0].slice(0, 8)}-${utils.randomInt(10, 99)}`;
  log("info", "typing key display name", { label: keyLabel });
  const keyNameInput = await dom.waitForAnySelector(page, [SELECTORS.keyNameInput], 10000);
  if (!keyNameInput) {
    throw new Error("Could not find key name input in Create API Key modal");
  }
  await dom.fillInput(page, keyNameInput, keyLabel);
  await keyNameInput.dispose().catch(() => {});
  await utils.sleep(500);

  // Wait for Cloudflare Turnstile verification and Submit button
  log("info", "waiting for Cloudflare verification and Submit button to become available...");
  let submitBtn = null;
  for (let i = 0; i < 30; i++) {
    submitBtn = await page.$(SELECTORS.createKeySubmitButton);
    if (submitBtn) {
      const isVisibleAndEnabled = await page.evaluate((el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && !el.hasAttribute("disabled");
      }, submitBtn);
      if (isVisibleAndEnabled) break;
    }
    await utils.sleep(1000);
  }

  if (!submitBtn) {
    throw new Error("Submit button did not appear (Cloudflare Turnstile verification may have timed out)");
  }

  log("info", "clicking Submit button...");
  await submitBtn.click();
  await submitBtn.dispose().catch(() => {});
  await utils.sleep(2500);

  // Extract generated API key
  log("info", "extracting generated API key...");
  let apiKey: string | null = null;
  for (let i = 0; i < 25; i++) {
    const keyVal = await page.evaluate((sel) => {
      const input = document.querySelector(sel) as HTMLInputElement | null;
      if (input && input.value) return input.value.trim();
      const code = document.querySelector("code");
      if (code && code.textContent) return code.textContent.trim();
      return null;
    }, SELECTORS.showKeyInput);

    if (keyVal && API_KEY_RE.test(keyVal)) {
      const m = keyVal.match(API_KEY_RE);
      if (m) {
        apiKey = m[0];
        break;
      }
    }

    // Fallback: search entire dialog text
    const fullText = await page.evaluate(() => document.body.innerText || "");
    const match = fullText.match(API_KEY_RE);
    if (match) {
      apiKey = match[0];
      break;
    }

    await utils.sleep(500);
  }

  if (!apiKey) {
    throw new Error("Failed to extract GroqCloud API key from modal dialog");
  }

  log("info", "GroqCloud API key extracted successfully", { apiKey: `${apiKey.slice(0, 12)}...` });
  session.apiKey = apiKey;
  return apiKey;
}
