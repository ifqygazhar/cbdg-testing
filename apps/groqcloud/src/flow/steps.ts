// ── Flow steps for GroqCloud automation ─────────────────────────────
import type { Page } from "puppeteer-core";
import { dom, utils, TempMailClient } from "@ifqy/google-oauth";
import { SELECTORS, API_KEY_RE, MAGIC_LINK_RE } from "./selectors.js";
import type { GroqCloudConfig } from "../config.js";
import type { ULog } from "../log.js";

const DEFAULT_SIGNUP_URL = "https://console.groq.com/home";
const HOME_URL = "https://console.groq.com/home";
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

  let signupErrorInfo: string | null = null;
  const onResponse = async (resp: any) => {
    try {
      const u = resp.url();
      if (u.includes("signupb2b") || u.includes("/user/profile/signupb2b")) {
        const status = resp.status();
        let body = "";
        try {
          body = await resp.text();
        } catch {}
        if (status >= 400) {
          signupErrorInfo = `HTTP ${status}: ${body}`;
          log("warn", "GroqCloud signupb2b backend rejected request", { status, body });
        } else {
          log("info", "GroqCloud signupb2b backend accepted request", { status });
        }
      }
    } catch {}
  };
  page.on("response", onResponse);

  try {
    await page.route("**/eml.stytch.com/**", (route) => route.abort()).catch(() => {});
  } catch {}

  await page.goto(magicLink, { waitUntil: "domcontentloaded", timeout: 35000 });
  await utils.sleep(3000);

  // Wait for redirect to console.groq.com
  let authenticated = false;
  for (let i = 0; i < 35; i++) {
    const url = page.url();
    if (url.includes("console.groq.com") && !url.includes("stytch.com") && !url.includes("redirect-error")) {
      authenticated = true;
      break;
    }
    if (url.includes("redirect-error")) {
      break;
    }
    await utils.sleep(500);
  }

  if (!authenticated || page.url().includes("redirect-error")) {
    try {
      const urlObj = new URL(magicLink);
      const token = urlObj.searchParams.get("token");
      const tokenType = urlObj.searchParams.get("stytch_token_type") || "discovery";
      if (token) {
        const directUrl = `https://console.groq.com/authenticate?stytch_redirect_type=login&stytch_token_type=${tokenType}&token=${token}`;
        log("info", "Stytch DFP redirected or pending, attempting direct Groq authentication", { directUrl });
        await page.goto(directUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
        await utils.sleep(3000);
        for (let i = 0; i < 30; i++) {
          const u = page.url();
          if (u.includes("console.groq.com") && !u.includes("stytch.com") && !u.includes("redirect-error")) {
            authenticated = true;
            break;
          }
          await utils.sleep(500);
        }
      }
    } catch {}
  }

  if (page.url().includes("redirect-error") || !authenticated) {
    throw new Error(`Stytch magic link redirect error: ${page.url()}`);
  }

  log("info", "waiting for GroqCloud automatic organization creation to complete and land on home dashboard...");
  let homeReady = false;
  for (let i = 0; i < 60; i++) {
    const currUrl = page.url();
    if (currUrl.includes("/home") && currUrl.includes("console.groq.com") && !currUrl.includes("stytch.com")) {
      homeReady = true;
      log("info", "GroqCloud successfully landed on dashboard home", { currUrl });
      break;
    }

    try {
      const el = await page.$(
        '[data-testid="organization-selector"], [data-testid="project-selector"], a[href="/keys"]'
      );
      if (el) {
        await el.dispose().catch(() => {});
        homeReady = true;
        log("info", "GroqCloud organization and dashboard elements active on page", { currUrl });
        break;
      }
    } catch {}

    // Detect rejection / page reverting back to email input (matches stuck.html)
    try {
      const emailInput = await page.$('input#email-input, button:has-text("Continue with email")');
      const bodyText = await page.evaluate(() => document.body.innerText || "");
      if (emailInput && !bodyText.toLowerCase().includes("creating your organization")) {
        await emailInput.dispose().catch(() => {});
        const errDetail = signupErrorInfo || "Backend GroqCloud menolak pembuatan organisasi baru (form kembali ke input email)";
        log("error", "GroqCloud organization creation failed, reverted to email input", { error: errDetail });
        throw new Error(
          `GroqCloud organization creation failed and reverted to login screen: ${errDetail}. ` +
          `Penyebab: IP terkena Anti-Abuse / Risk Control / Rate Limit GroqCloud. Gunakan proxy dari proxy-live.txt.`
        );
      }
      if (emailInput) {
        await emailInput.dispose().catch(() => {});
      }
    } catch (e: any) {
      if (e?.message?.includes("GroqCloud organization creation failed")) throw e;
    }

    await utils.sleep(1000);
  }

  if (!homeReady) {
    if (signupErrorInfo) {
      throw new Error(
        `GroqCloud organization creation failed: ${signupErrorInfo}. ` +
        `Penyebab: IP terkena Anti-Abuse / Risk Control / Rate Limit GroqCloud. Gunakan proxy dari proxy-live.txt.`
      );
    }
    log("info", "navigating directly to dashboard home to confirm organization session", { url: HOME_URL });
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 35000 });
    await utils.sleep(2000);
    const postAuthInput = await page.$('input#email-input');
    if (page.url().includes("authenticate") || postAuthInput) {
      if (postAuthInput) await postAuthInput.dispose().catch(() => {});
      throw new Error(
        "GroqCloud sesi belum terautentikasi (dashboard home mengalihkan kembali ke login). " +
        "Pembuatan organisasi gagal diproses backend."
      );
    }
  } else {
    await utils.sleep(2000);
  }

  log("info", "GroqCloud dashboard home confirmed with active organization", { currentUrl: page.url() });
  return magicLink;
}

/** Step 3: Navigates to /keys, handles Cloudflare Turnstile, submits, and extracts API key */
export async function stepCreateApiKey(
  page: Page,
  session: AccountSession,
  cfg: GroqCloudConfig,
  log: ULog,
): Promise<string> {
  const keysLink = await page.$('a[href="/keys"]');
  if (keysLink) {
    log("info", "navigating to API keys page via nav link");
    await keysLink.click();
    await keysLink.dispose().catch(() => {});
    await utils.sleep(1500);
  }

  if (!page.url().includes("/keys")) {
    log("info", "navigating to API keys page", { url: API_KEYS_URL });
    await page.goto(API_KEYS_URL, { waitUntil: "domcontentloaded", timeout: 35000 });
    await utils.sleep(1500);
  }

  await dismissCookieBanners(page, log);

  log("info", "clicking Create API Key button...");
  const createKeyBtn = await dom.waitForAnySelector(page, [SELECTORS.createKeyButton], 30000);
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
