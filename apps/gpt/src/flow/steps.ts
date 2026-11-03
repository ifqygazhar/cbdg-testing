// ── Step implementations for ChatGPT onboarding automation ──────────
import type { Page } from "puppeteer-core";
import { SELECTORS, OTP_CODE_RE } from "./selectors.js";
import { FlowState } from "../store.js";
import type { GptConfig } from "../config.js";
import type { TempMailClient } from "@ifqy/google-oauth";

export interface AccountSession {
  page: Page;
  email: string;
  password: string;
  config: GptConfig;
  tempMail: TempMailClient;
  logger: (level: "info" | "warn" | "error" | "debug", msg: string, data?: Record<string, unknown>) => void;
}

const FIRST_NAMES = ["Budi", "Alex", "David", "Sarah", "Michael", "Linda", "Rian", "Dewi", "Kevin", "Maya", "Daniel", "Chloe"];
const LAST_NAMES = ["Pratama", "Santoso", "Miller", "Taylor", "Wijaya", "Kusuma", "Davis", "Tanaka", "Saputra", "Wong"];

export function generateRandomName(): string {
  const f = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const l = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  return `${f} ${l}`;
}

export function generateRandomAge(): number {
  // Age strictly > 20
  return Math.floor(Math.random() * 15) + 22; // 22 to 36
}

const SAMPLE_PROMPTS = [
  "Halo! Sebutkan 1 tips produktivitas singkat hari ini.",
  "What are 3 interesting facts about the ocean?",
  "Give me a short positive thought for today.",
  "Jelaskan secara ringkas bagaimana pelangi terbentuk.",
  "Tell me a short one-liner joke.",
];

export function getRandomPrompt(): string {
  return SAMPLE_PROMPTS[Math.floor(Math.random() * SAMPLE_PROMPTS.length)];
}

export async function stepOpenAndSubmitEmail(session: AccountSession): Promise<boolean> {
  const { page, email, logger } = session;
  logger("info", `Step 1: Navigating to landing page & submitting email ${email}...`);

  const curUrl = page.url() || "";
  if (!curUrl.includes("chatgpt.com") && !curUrl.includes("openai.com")) {
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
  }

  // Check if already authenticated or composer is active
  const composer = await page.$(SELECTORS.chatComposer);
  if (composer) {
    logger("info", "Already authenticated in session.");
    return true;
  }

  // Check if email input is already visible
  let isEmailVisible = false;
  try {
    const el = await page.$(SELECTORS.emailInput);
    if (el) {
      isEmailVisible = await page.evaluate((node) => {
        const elem = node as HTMLElement;
        const rect = elem.getBoundingClientRect();
        const style = window.getComputedStyle(elem);
        const dialog = elem.closest("dialog");
        if (dialog && !dialog.open) return false;
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0
        );
      }, el);
    }
  } catch {
    isEmailVisible = false;
  }

  if (!isEmailVisible) {
    logger("info", "Landing page loaded. Triggering 'Sign up for free' button...");

    // Dismiss Google One-Tap or overlay if present
    try {
      await page.keyboard.press("Escape");
      await new Promise((r) => setTimeout(r, 300));
    } catch {}

    // Click sign up button or showModal
    let clicked = false;
    try {
      clicked = await page.evaluate(() => {
        const btn =
          (document.querySelector('button[data-mobile-auth-entry-action="signup"]') as HTMLElement) ||
          Array.from(document.querySelectorAll("button")).find((b) => {
            const t = (b.textContent || "").trim().toLowerCase();
            return t.includes("sign up for free") || t === "sign up";
          });
        if (btn) {
          btn.click();
          return true;
        }
        const dialog = document.getElementById("mobile-auth-dialog") as HTMLDialogElement | null;
        if (dialog && !dialog.open && typeof dialog.showModal === "function") {
          dialog.showModal();
          return true;
        }
        return false;
      });
    } catch {}

    if (clicked) {
      logger("info", "Triggered sign up modal via button click.");
    }
    await new Promise((r) => setTimeout(r, 1500));

    // Wait for email input to mount and be visible
    try {
      await page.waitForSelector(SELECTORS.emailInput, { visible: true, timeout: 12000 });
      isEmailVisible = true;
    } catch {
      // Direct navigation fallback if modal didn't open
      logger("info", "Auth modal did not open; attempting direct navigation to auth signup...");
      await page.goto("https://chatgpt.com/auth/login?screen_hint=signup", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForSelector(SELECTORS.emailInput, { visible: true, timeout: 15000 }).catch(() => null);
    }
  }

  const emailInput = await page.$(SELECTORS.emailInput);
  if (!emailInput) {
    throw new Error("Email input selector not found on landing page / modal.");
  }

  await emailInput.click({ clickCount: 3 });
  await emailInput.type(email, { delay: 40 });
  await new Promise((r) => setTimeout(r, 600));

  // Submit email
  const submitBtn = await page.$(SELECTORS.emailSubmitButton);
  if (submitBtn) {
    await submitBtn.click();
  } else {
    await page.keyboard.press("Enter");
  }

  logger("info", "Email submitted, waiting for password or verification screen...");
  await new Promise((r) => setTimeout(r, 2500));
  return true;
}

export async function stepHandlePassword(session: AccountSession): Promise<boolean> {
  const { page, password, logger } = session;
  logger("info", "Step 2: Checking password screen & filling credentials...");

  // If page offers "Continue with password", click it first
  const continueWithPassBtn = await page.$(SELECTORS.continueWithPasswordButton);
  if (continueWithPassBtn) {
    logger("info", "Found 'Continue with password' option, clicking...");
    await continueWithPassBtn.click();
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Wait for password input
  let passInput = await page.$(SELECTORS.passwordInput);
  if (!passInput) {
    try {
      await page.waitForSelector(SELECTORS.passwordInput, { timeout: 15000 });
      passInput = await page.$(SELECTORS.passwordInput);
    } catch {}
  }

  if (!passInput) {
    // Could already be at OTP verification or about-you
    const curUrl = page.url() || "";
    if (curUrl.includes("email-verification") || curUrl.includes("about-you")) {
      logger("info", `Skipping password step (already at ${curUrl})`);
      return true;
    }
    throw new Error("Password input not found on password screen.");
  }

  await passInput.click({ clickCount: 3 });
  await passInput.type(password, { delay: 40 });
  await new Promise((r) => setTimeout(r, 600));

  const passSubmit = await page.$(SELECTORS.passwordSubmitButton);
  if (passSubmit) {
    await passSubmit.click();
  } else {
    await page.keyboard.press("Enter");
  }

  logger("info", "Password submitted, waiting for email verification screen...");
  await new Promise((r) => setTimeout(r, 2500));
  return true;
}

export async function stepHandleOtp(session: AccountSession): Promise<boolean> {
  const { page, email, tempMail, logger } = session;
  logger("info", `Step 3: Checking OTP verification screen for ${email}...`);

  // Wait for OTP input to be present
  let otpInput = await page.$(SELECTORS.otpInput);
  if (!otpInput) {
    try {
      await page.waitForSelector(SELECTORS.otpInput, { timeout: 20000 });
      otpInput = await page.$(SELECTORS.otpInput);
    } catch {}
  }

  if (!otpInput) {
    const curUrl = page.url() || "";
    if (curUrl.includes("about-you") || curUrl.includes("chatgpt.com")) {
      logger("info", "Already past OTP verification screen.");
      return true;
    }
    throw new Error("OTP input field not found.");
  }

  logger("info", `Polling TempMail inbox for 6-digit OTP code on ${email}...`);
  const otpCode = await tempMail.waitForVerificationOtp(email, {
    timeoutMs: 120000,
    intervalMs: 3000,
    filterSender: "openai",
  });
  logger("info", `Received OTP code: ${otpCode}`);

  await otpInput.click({ clickCount: 3 });
  await otpInput.type(otpCode, { delay: 50 });
  await new Promise((r) => setTimeout(r, 800));

  const submitOtp = await page.$(SELECTORS.otpSubmitButton);
  if (submitOtp) {
    await submitOtp.click();
  } else {
    await page.keyboard.press("Enter");
  }

  logger("info", "OTP submitted, waiting for About You profile screen...");
  await new Promise((r) => setTimeout(r, 3000));
  return true;
}

export async function stepHandleAboutYou(session: AccountSession): Promise<boolean> {
  const { page, logger } = session;
  logger("info", "Step 4: Handling About You / Profile questionnaire...");

  let nameInput = await page.$(SELECTORS.nameInput);
  if (!nameInput) {
    try {
      await page.waitForSelector(SELECTORS.nameInput, { timeout: 15000 });
      nameInput = await page.$(SELECTORS.nameInput);
    } catch {}
  }

  if (!nameInput) {
    const curUrl = page.url() || "";
    if (curUrl.includes("chatgpt.com")) {
      logger("info", "Already redirected to chatgpt.com (About You screen skipped or completed).");
      return true;
    }
    throw new Error("About You 'Full name' input not found.");
  }

  const fullName = generateRandomName();
  const age = generateRandomAge();
  logger("info", `Entering profile details: Name='${fullName}', Age=${age} (>20)`);

  await nameInput.click({ clickCount: 3 });
  await nameInput.type(fullName, { delay: 40 });
  await new Promise((r) => setTimeout(r, 400));

  const ageInput = await page.$(SELECTORS.ageInput);
  if (ageInput) {
    await ageInput.click({ clickCount: 3 });
    await ageInput.type(String(age), { delay: 40 });
    await new Promise((r) => setTimeout(r, 400));
  }

  const continueBtn = await page.$(SELECTORS.aboutYouSubmitButton);
  if (continueBtn) {
    await continueBtn.click();
  } else {
    await page.keyboard.press("Enter");
  }

  logger("info", "Profile submitted, waiting for ChatGPT dashboard redirect...");
  await new Promise((r) => setTimeout(r, 3500));
  return true;
}

export async function stepHandleOnboardingAndPrompt(session: AccountSession): Promise<boolean> {
  const { page, logger } = session;
  logger("info", "Step 5: Handling post-success onboarding dialog and sending prompt...");

  // 1. Wait for landing back on chatgpt.com
  for (let i = 0; i < 15; i++) {
    const curUrl = page.url() || "";
    if (curUrl.includes("chatgpt.com")) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  // 2. Check for "You're all set" / Onboarding "Continue" button
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const onboardingBtn = await page.$(SELECTORS.onboardingContinueButton);
    if (onboardingBtn) {
      logger("info", "Found post-success onboarding 'Continue' button, clicking...");
      await onboardingBtn.click();
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch {}

  // 3. Find chat composer and send initial test prompt
  let composer = await page.$(SELECTORS.chatComposer);
  if (!composer) {
    try {
      await page.waitForSelector(SELECTORS.chatComposer, { timeout: 20000 });
      composer = await page.$(SELECTORS.chatComposer);
    } catch {}
  }

  if (!composer) {
    logger("warn", "Chat composer not found within timeout, but account registration completed.");
    return true;
  }

  try {
    const promptText = getRandomPrompt();
    logger("info", `Sending test prompt to ChatGPT: "${promptText}"`);

    await composer.click();
    await new Promise((r) => setTimeout(r, 300));
    await page.keyboard.type(promptText, { delay: 35 });
    await new Promise((r) => setTimeout(r, 500));

    const sendBtn = await page.$(SELECTORS.sendButton);
    if (sendBtn) {
      await sendBtn.click();
    } else {
      await page.keyboard.press("Enter");
    }

    logger("info", "Prompt sent successfully! Waiting 4s for initial response...");
    await new Promise((r) => setTimeout(r, 4000));
  } catch (err) {
    logger("warn", `Initial prompt interaction skipped/error (non-fatal): ${(err as Error).message}`);
  }
  return true;
}
