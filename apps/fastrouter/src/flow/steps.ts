// ── FastRouter flow steps ──────────────────────────────────────────
// 1. /sign-up  →  "Sign up with Google"  →  Google OAuth (library)
// 2. /sign-up/continue  →  accept legal terms  →  submit
// 3. /welcome  →  fill orgName + random spend $1k-$10k + checklist  →  Continue to Dashboard
// 4. /keys  →  verify $1 credit  →  Create User Key  →  extract sk-v1-...  →  save
// (selectors validated against fastrouter_ai_dataset/*.html)

import fs from "node:fs";
import type { Page, ElementHandle } from "puppeteer-core";
import {
  performGoogleOAuth,
  maybeClickGoogleProvider,
  dismissCookieBanners,
  isGoogleUrl,
  isAccountRestricted,
  dom,
  utils,
  resolvePace,
  TempMailClient,
} from "@ifqy/google-oauth";
import { FlowState } from "../store.js";
import { FlowError, type FlowCtx } from "./engine.js";
import { Selectors, API_KEY_RE, API_KEY_MIN_LEN } from "./selectors.js";

const {
  clickByText,
  waitForAnySelector,
  fillInput,
  safeClick,
} = dom;
const { sleep, randomInt } = utils;

// ── one-shot body text match ───────────────────────────────────────
async function bodyMatches(page: Page, re: RegExp): Promise<boolean> {
  return page
    .evaluate(
      (src) => new RegExp(src, "i").test((document.body?.innerText || "").toLowerCase()),
      re.source,
    )
    .catch(() => false);
}

async function waitForBodyRegex(
  page: Page,
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

// ── React / Next.js error-boundary recovery ────────────────────────
const REACT_ERROR_RE = /unexpected application error|application error|cannot read properties of undefined|something went wrong/i;

async function isReactErrorPage(page: Page): Promise<boolean> {
  return bodyMatches(page, REACT_ERROR_RE);
}

async function firstVisible(
  page: Page,
  selectors: string[],
): Promise<ElementHandle<Element> | null> {
  for (const sel of selectors) {
    const el = await page.$(sel).catch(() => null);
    if (!el) continue;
    const visible = await el
      .evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      })
      .catch(() => false);
    if (visible) return el;
    await el.dispose().catch(() => {});
  }
  return null;
}

async function waitForSelectorRecover(
  page: Page,
  selectors: string[],
  timeoutMs: number,
  opts: { reloadLimit?: number; log?: FlowCtx["log"]; label?: string; pollMs?: number } = {},
): Promise<ElementHandle<Element> | null> {
  const deadline = Date.now() + timeoutMs;
  const reloadLimit = opts.reloadLimit ?? 2;
  const pollMs = opts.pollMs ?? 1000;
  let reloads = 0;

  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const el = await page.$(sel).catch(() => null);
      if (el) {
        const visible = await el
          .evaluate((node) => {
            const rect = node.getBoundingClientRect();
            const style = window.getComputedStyle(node);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== "none" &&
              style.visibility !== "hidden"
            );
          })
          .catch(() => false);
        if (visible) return el;
        await el.dispose().catch(() => {});
      }
    }
    if (reloads < reloadLimit && (await isReactErrorPage(page))) {
      reloads++;
      opts.log?.(
        "warn",
        `app error page detected → reloading (${reloads}/${reloadLimit})${opts.label ? ` [${opts.label}]` : ""}`,
      );
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await sleep(pollMs * 1.5);
    }
    await sleep(pollMs);
  }
  return null;
}

/** The page actually running the fastrouter app (same tab or OAuth popup). */
async function resolveAppPage(ctx: FlowCtx): Promise<Page> {
  const ref = ctx.appPageRef;
  if (ref.current && !ref.current.isClosed()) return ref.current;
  const pages = await ctx.browser.context.pages();
  for (const p of pages) {
    const u = p.url();
    if (/fastrouter\.ai/.test(u) && !isGoogleUrl(u)) {
      ref.current = p;
      return p;
    }
  }
  ref.current = ctx.browser.page;
  return ref.current;
}

function pick<T>(arr: readonly T[]): T {
  return arr[randomInt(0, arr.length - 1)];
}

const COMPANY_NOUNS = [
  "Aether", "Apex", "Atlas", "Aurora", "Axon", "Chronos", "Cobalt", "Cortex",
  "Cyber", "Echo", "Flux", "Forge", "Helix", "Infini", "Kepler", "Krypton",
  "Lumen", "Matrix", "Meridian", "Nebula", "Nexus", "Nimbus", "Nova", "Omni",
  "Optima", "Orion", "Pharos", "Polaris", "Pulse", "Quantum", "Radix", "Shift",
  "Solaris", "Solstice", "Spectra", "Stratum", "Summit", "Synapse", "Tensor",
  "Titan", "Vanguard", "Vector", "Vertex", "Vortex", "Zenith", "Zephyr",
];
const COMPANY_SUFFIXES = [
  "AI", "Labs", "Tech", "Cloud", "Systems", "Data", "Works", "Soft", "Digital",
  "Studio", "Solutions", "Dynamics", "Intelligence", "Compute", "Networks",
];

function randomOrgName(email?: string): string {
  if (email && Math.random() < 0.35) {
    const user = email.split("@")[0].replace(/[^a-zA-Z0-9]/g, "");
    if (user.length >= 3) {
      return `${user.slice(0, 10)} ${pick(COMPANY_SUFFIXES)}`;
    }
  }
  return `${pick(COMPANY_NOUNS)} ${pick(COMPANY_SUFFIXES)}`;
}

// ── Cloudflare Turnstile / Clerk CAPTCHA resolver ───────────────────
/**
 * Mendeteksi dan mencoba menyelesaikan Cloudflare Turnstile challenge jika muncul.
 * Turnstile dimuat oleh Clerk di dalam iframe challenges.cloudflare.com.
 * Jika berstatus interaktif, checkbox diklik menggunakan koordinat riil mouse CDP.
 */
async function resolveTurnstileIfPresent(
  page: Page,
  log?: FlowCtx["log"],
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let solved = false;

  while (Date.now() < deadline) {
    if (page.isClosed()) return false;

    const turnstileFrames = page.frames().filter((f) =>
      f.url().includes("challenges.cloudflare.com") || f.url().includes("turnstile"),
    );

    if (turnstileFrames.length === 0) {
      return solved;
    }

    log?.("info", `[turnstile] Cloudflare Turnstile frame terdeteksi (${turnstileFrames.length} frame)...`);

    for (const frame of turnstileFrames) {
      try {
        const frameElement = await frame.frameElement().catch(() => null);
        if (!frameElement) continue;

        const frameBox = await frameElement.boundingBox().catch(() => null);
        if (!frameBox || frameBox.width <= 0 || frameBox.height <= 0) continue;

        const targetPos = await frame
          .evaluate(() => {
            function findInteractiveTarget(root: Document | ShadowRoot): HTMLElement | null {
              const selectors = [
                'input[type="checkbox"]',
                "#challenge-stage",
                ".ctp-checkbox-label",
                ".cb-lb",
                "#cf-stage",
                'label[class*="checkbox" i]',
                'div[id="content"]',
                "span.mark",
              ];
              for (const sel of selectors) {
                const el = root.querySelector(sel) as HTMLElement | null;
                if (el) {
                  const r = el.getBoundingClientRect();
                  if (r.width > 0 && r.height > 0) return el;
                }
              }
              for (const el of Array.from(root.querySelectorAll("*"))) {
                if (el.shadowRoot) {
                  const nested = findInteractiveTarget(el.shadowRoot);
                  if (nested) return nested;
                }
              }
              return null;
            }

            const target = findInteractiveTarget(document);
            if (target) {
              const rect = target.getBoundingClientRect();
              return {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
              };
            }
            // Fallback: checkbox Turnstile selalu terletak di sisi kiri widget (~28px, tengah tinggi)
            return { x: 28, y: 32 };
          })
          .catch(() => ({ x: 28, y: 32 }));

        const absX = frameBox.x + targetPos.x;
        const absY = frameBox.y + targetPos.y;
        log?.("info", `[turnstile] Mengklik kotak 'Verify you are human' di (${Math.round(absX)}, ${Math.round(absY)})...`);
        await page.mouse.move(absX, absY, { steps: 5 });
        await sleep(100);
        await page.mouse.click(absX, absY, { delay: randomInt(60, 120) });
        await sleep(2500);
        solved = true;
        return true;
      } catch (err: any) {
        log?.("warn", `[turnstile] Interaksi frame Turnstile error: ${err.message}`);
      }
    }

    await sleep(2000);
  }

  return solved;
}

const FIRST_NAMES = [
  "James", "Sarah", "Alex", "David", "Emily", "Michael", "Emma", "Daniel",
  "Sophia", "Matthew", "Olivia", "Andrew", "Grace", "Ethan", "Chloe", "Ryan",
  "Liam", "Lucas", "Noah", "Ava", "Mia", "Oliver", "Benjamin", "Charlotte",
] as const;
const LAST_NAMES = [
  "Miller", "Smith", "Johnson", "Davis", "Wilson", "Taylor", "Anderson", "Thomas",
  "Jackson", "White", "Harris", "Martin", "Thompson", "Garcia", "Martinez", "Robinson",
  "Clark", "Rodriguez", "Lewis", "Lee", "Walker", "Hall", "Allen", "Young",
] as const;

// ── s01-tempmail: Sign up via TempMail (Clerk email/password form) ─
export async function s01SignupTempMail(ctx: FlowCtx): Promise<FlowState> {
  const { browser, account, googleOAuth, cfg, log } = ctx;
  const pace = resolvePace(cfg.pace);

  log("info", `opening ${Selectors.signupUrl} for TempMail signup`);
  await browser.page.goto(Selectors.signupUrl, { waitUntil: "domcontentloaded" });
  await dismissCookieBanners(browser.page, googleOAuth);
  await sleep(randomInt(pace.stepPauseMin, pace.stepPauseMax));

  // 1. Resolve Cloudflare Turnstile if present on landing
  await resolveTurnstileIfPresent(browser.page, log);

  // 2. Wait for first name input
  const firstNameInput = await waitForSelectorRecover(
    browser.page,
    Selectors.emailFirstName,
    Math.min(cfg.signupFormTimeoutSec * 1000, 25_000),
    { log, label: "first name input", pollMs: pace.pollMs },
  );

  if (!firstNameInput) {
    const hasTurnstile = browser.page.frames().some((f) => f.url().includes("challenges.cloudflare.com"));
    if (hasTurnstile) {
      await resolveTurnstileIfPresent(browser.page, log, 15_000);
    }
  }

  const fnEl = await firstVisible(browser.page, Selectors.emailFirstName);
  if (!fnEl) {
    throw new FlowError("SIGNUP_INPUT_MISSING", "FastRouter first name input not found");
  }

  const firstName = pick(FIRST_NAMES);
  const lastName = pick(LAST_NAMES);
  log("info", `filling signup details: ${firstName} ${lastName} <${account.email}>`);

  await fillInput(browser.page, fnEl, firstName);
  await fnEl.dispose().catch(() => {});
  await sleep(randomInt(pace.pauseMin, pace.pauseMax));

  const lnEl = await firstVisible(browser.page, Selectors.emailLastName);
  if (lnEl) {
    await fillInput(browser.page, lnEl, lastName);
    await lnEl.dispose().catch(() => {});
    await sleep(randomInt(pace.pauseMin, pace.pauseMax));
  }

  const emailEl = await firstVisible(browser.page, Selectors.emailAddressInput);
  if (!emailEl) throw new FlowError("EMAIL_INPUT_MISSING", "email input not found");
  await fillInput(browser.page, emailEl, account.email);
  await emailEl.dispose().catch(() => {});
  await sleep(randomInt(pace.pauseMin, pace.pauseMax));

  const pwEl = await firstVisible(browser.page, Selectors.emailPasswordInput);
  if (!pwEl) throw new FlowError("PASSWORD_INPUT_MISSING", "password input not found");
  await fillInput(browser.page, pwEl, account.password);
  await pwEl.dispose().catch(() => {});
  await sleep(randomInt(pace.pauseMin, pace.pauseMax));

  // Terms checkbox: button#acceptTerms[role="checkbox"]
  const termsBtn = await firstVisible(browser.page, Selectors.emailTermsCheckbox);
  if (termsBtn) {
    const isChecked = await termsBtn
      .evaluate((el) => {
        const state = el.getAttribute("data-state") || el.getAttribute("aria-checked");
        return state === "checked" || state === "true" || (el as HTMLInputElement).checked === true;
      })
      .catch(() => false);
    if (!isChecked) {
      await safeClick(browser.page, termsBtn);
      await sleep(randomInt(pace.pauseMin, pace.pauseMax));
    }
    await termsBtn.dispose().catch(() => {});
  }

  // Hesitate naturally before submit
  await sleep(randomInt(pace.pauseMin * 1.5, pace.pauseMax * 1.5));

  // Click submit button: "Sign up"
  const submitBtn = await firstVisible(browser.page, Selectors.emailSignupSubmit);
  if (!submitBtn) throw new FlowError("SUBMIT_BUTTON_MISSING", "Sign up submit button not found");
  log("info", "submitting signup form...");
  await safeClick(browser.page, submitBtn);
  await submitBtn.dispose().catch(() => {});
  await sleep(randomInt(2000, 3500));

  // Resolve Cloudflare Turnstile if Clerk presents a challenge on submit (div#clerk-captcha)
  await resolveTurnstileIfPresent(browser.page, log, 25_000);

  return FlowState.VERIFY_OTP;
}

// ── s01b: Verify 6-digit OTP code received from TempMail ──────────
export async function s01bVerifyOtp(ctx: FlowCtx): Promise<FlowState> {
  const { account, cfg, log } = ctx;
  const pace = resolvePace(cfg.pace);
  const app = await resolveAppPage(ctx);
  await app.bringToFront().catch(() => {});

  // Check if already redirected past verification (welcome or keys)
  if (app.url().includes("/welcome") || (await app.$(Selectors.welcomeOrgName))) {
    log("info", "already on welcome page — skipping OTP verification");
    return FlowState.WELCOME;
  }
  if (app.url().includes("/keys") || (await app.$(Selectors.apiKeyName))) {
    log("info", "already on keys dashboard — skipping OTP verification");
    return FlowState.API_KEY;
  }

  log("info", `waiting for OTP verification screen on ${app.url()}...`);
  const otpInput = await waitForSelectorRecover(
    app,
    Selectors.verifyOtpInput,
    Math.min(cfg.signupFormTimeoutSec * 1000, 30_000),
    { log, label: "OTP code input", pollMs: pace.pollMs },
  );

  if (!otpInput) {
    const hasTurnstile = app.frames().some((f) => f.url().includes("challenges.cloudflare.com"));
    if (hasTurnstile) {
      await resolveTurnstileIfPresent(app, log, 15_000);
    }
    if (app.url().includes("/welcome") || (await app.$(Selectors.welcomeOrgName))) return FlowState.WELCOME;
    if (app.url().includes("/keys") || (await app.$(Selectors.apiKeyName))) return FlowState.API_KEY;

    await app.screenshot({ path: `${cfg.screenshotDir}/no-otp-${account.email.replace(/[^a-z0-9]/gi, "_")}.png` }).catch(() => {});
    throw new FlowError("OTP_SCREEN_TIMEOUT", "verification code screen did not appear");
  }

  // Poll TempMail inbox for 6-digit OTP code
  log("info", `polling TempMail inbox for verification code (${account.email})...`);
  const tempMail = new TempMailClient({ defaultDomain: cfg.tempMailDomain });
  const otpCode = await tempMail.waitForVerificationOtp(account.email, {
    timeoutMs: 75_000,
    intervalMs: 2500,
  });
  log("info", `received verification code from email: ${otpCode}`);

  await fillInput(app, otpInput, otpCode);
  await otpInput.dispose().catch(() => {});
  await sleep(randomInt(pace.pauseMin, pace.pauseMax));

  // Click "Verify & Continue"
  const verifySubmit = await firstVisible(app, Selectors.verifyOtpSubmit);
  if (verifySubmit) {
    log("info", "clicking 'Verify & Continue' button...");
    await safeClick(app, verifySubmit);
    await verifySubmit.dispose().catch(() => {});
    await sleep(2500);
  }

  // Resolve Turnstile if Clerk presents post-verification challenge
  await resolveTurnstileIfPresent(app, log, 15_000);

  // Wait for landing surface (welcome or keys)
  const landingSurface = await waitForSelectorRecover(
    app,
    [Selectors.welcomeOrgName, Selectors.apiKeyName, 'a[href*="/keys"]'],
    cfg.welcomeTimeoutSec * 1000,
    { log, label: "post-otp landing surface", pollMs: pace.pollMs },
  );

  if (landingSurface) await landingSurface.dispose().catch(() => {});

  if (app.url().includes("/welcome") || (await app.$(Selectors.welcomeOrgName))) {
    return FlowState.WELCOME;
  }
  return FlowState.API_KEY;
}

// ── s01: sign-up → Sign up with Google → Google OAuth ───────────────
export async function s01Signup(ctx: FlowCtx): Promise<FlowState> {
  const { browser, account, googleOAuth, cfg, log } = ctx;
  const pace = resolvePace(cfg.pace);

  if (cfg.authMethod === "tempmail") {
    return s01SignupTempMail(ctx);
  }

  log("info", `opening ${Selectors.signupUrl}`);
  await browser.page.goto(Selectors.signupUrl, { waitUntil: "domcontentloaded" });
  await dismissCookieBanners(browser.page, googleOAuth);
  await sleep(randomInt(pace.stepPauseMin, pace.stepPauseMax));

  // 1. Cek & tangani Cloudflare Turnstile jika aktif sebelum klik
  await resolveTurnstileIfPresent(browser.page, log);

  // 2. Tunggu tombol Google sign-up pada https://fastrouter.ai/sign-up
  let googleBtn = await waitForSelectorRecover(
    browser.page,
    Selectors.signUpGoogleButton,
    Math.min(cfg.signupFormTimeoutSec * 1000, 20_000),
    { log, label: "signup with google button", pollMs: pace.pollMs },
  );

  // Jika belum muncul, periksa apakah tertahan Cloudflare Turnstile
  if (!googleBtn) {
    const turnstileDetected = await resolveTurnstileIfPresent(browser.page, log);
    if (turnstileDetected) {
      log("info", "menunggu tombol Google setelah interaksi Turnstile...");
      await sleep(3000);
      googleBtn = await waitForSelectorRecover(
        browser.page,
        Selectors.signUpGoogleButton,
        cfg.signupFormTimeoutSec * 1000,
        { log, label: "signup with google button (post-turnstile)", pollMs: pace.pollMs },
      );
    }
  }

  if (!googleBtn) {
    const hasTurnstile = browser.page.frames().some((f) => f.url().includes("challenges.cloudflare.com"));
    await browser.page
      .screenshot({ path: `${cfg.screenshotDir}/no-signup-google-${account.email.replace(/[^a-z0-9]/gi, "_")}.png` })
      .catch(() => {});
    if (hasTurnstile) {
      throw new FlowError(
        "CLOUDFLARE_TURNSTILE_BLOCKED",
        "Halaman registrasi terhalang oleh Cloudflare Turnstile CAPTCHA. Gunakan mode headed (--headed) atau selesaikan verifikasi.",
      );
    }
    throw new FlowError("NO_GOOGLE_PROVIDER", "sign-up page never rendered the Google OAuth button");
  }

  log("info", "mengklik tombol Sign up with Google...");
  // Klik tombol Google
  await safeClick(browser.page, googleBtn);
  await googleBtn.dispose().catch(() => {});

  // 3. Tangani respon pasca-klik:
  // Clerk menampilkan "Security check: Complete this verification to continue with SSO"
  // yang memuat widget Cloudflare Turnstile.
  const ssoTimeoutMs = 60_000;
  const ssoDeadline = Date.now() + ssoTimeoutMs;
  let googlePage: Page | null = null;
  let announcedSecurityCheck = false;

  while (Date.now() < ssoDeadline) {
    // Cek apakah halaman Google sudah terbuka (di tab aktif atau di popup baru)
    const pages = await browser.context.pages();
    for (const p of pages) {
      if (!p.isClosed() && isGoogleUrl(p.url())) {
        googlePage = p;
        break;
      }
    }
    if (googlePage) break;

    // Cek apakah Clerk memunculkan "Security check" (Turnstile frame)
    const turnstileFrames = browser.page.frames().filter((f) =>
      f.url().includes("challenges.cloudflare.com") || f.url().includes("turnstile"),
    );

    if (turnstileFrames.length > 0) {
      if (!announcedSecurityCheck) {
        log(
          "warn",
          "Security check SSO terdeteksi ('Complete this verification to continue with SSO'). Mencoba auto-click Turnstile...",
        );
        announcedSecurityCheck = true;
      }
      await resolveTurnstileIfPresent(browser.page, log, 4000);
    }

    await sleep(1500);
  }

  if (!googlePage) {
    // Fallback: coba maybeClickGoogleProvider jika tombol sudah aktif kembali
    googlePage = await maybeClickGoogleProvider(browser.page, account.email, {
      ...googleOAuth,
      genericAuthTextClick: false,
    });
  }

  if (!googlePage) {
    await browser.page
      .screenshot({ path: `${cfg.screenshotDir}/no-google-${account.email.replace(/[^a-z0-9]/gi, "_")}.png` })
      .catch(() => {});
    throw new FlowError("NO_GOOGLE_PROVIDER", "google sign-in page never opened (terhalang Security check Turnstile)");
  }

  if (!isGoogleUrl(googlePage.url())) {
    const ok = await waitForBodyRegex(googlePage, /sign in with google|choose an account/i, 30_000);
    if (!ok) throw new FlowError("GOOGLE_PAGE_TIMEOUT", "google sign-in surface not detected");
  }

  const { code } = await performGoogleOAuth(
    googlePage,
    browser.context,
    {
      email: account.email,
      password: account.password,
    },
    { ...googleOAuth, screenShotDir: cfg.screenshotDir },
  );

  if (code !== "OK") throw new FlowError("GOOGLE_OAUTH_FAILED", `oauth code: ${code}`);

  // Flow continues on post-OAuth page (same tab or popup)
  if (!googlePage.isClosed()) ctx.appPageRef.current = googlePage;
  const app = await resolveAppPage(ctx);
  await app.bringToFront().catch(() => {});

  // Determine landing surface:
  // 1) /sign-up/continue (complete signup: legal checkbox)
  // 2) /welcome (organization setup)
  // 3) /keys or dashboard (already completed account)
  log("info", `waiting for post-oauth landing surface on ${app.url()}`);

  const landingSurface = await waitForSelectorRecover(
    app,
    [
      Selectors.completeSignupCheckbox,
      Selectors.welcomeOrgName,
      Selectors.apiKeyName,
      'a[href*="/keys"]',
    ],
    cfg.signupFormTimeoutSec * 1000,
    { log, label: "post-oauth landing surface", pollMs: pace.pollMs },
  );

  if (!landingSurface) {
    if (await isAccountRestricted(app)) {
      throw new FlowError("ACCOUNT_RESTRICTED", "account restricted by risk control (post-oauth)");
    }
    // Check if URL tells us where we are
    const u = app.url();
    if (u.includes("/welcome")) return FlowState.WELCOME;
    if (u.includes("/keys")) return FlowState.API_KEY;
    if (u.includes("/sign-up/continue")) return FlowState.COMPLETE_SIGNUP;

    await app
      .screenshot({ path: `${cfg.screenshotDir}/unknown-landing-${account.email.replace(/[^a-z0-9]/gi, "_")}.png` })
      .catch(() => {});
    throw new FlowError("NO_LANDING_SURFACE", `unknown surface after OAuth: ${u}`);
  }
  await landingSurface.dispose().catch(() => {});

  // Inspect current state
  const curUrl = app.url();
  if (curUrl.includes("/welcome") || (await app.$(Selectors.welcomeOrgName))) {
    log("info", "landed directly on welcome page");
    return FlowState.WELCOME;
  }
  if (curUrl.includes("/keys") || (await app.$(Selectors.apiKeyName))) {
    log("info", "already registered — skipping to api key");
    return FlowState.API_KEY;
  }
  if (await app.$(Selectors.completeSignupCheckbox)) {
    log("info", "complete-signup required (legal terms)");
    return FlowState.COMPLETE_SIGNUP;
  }

  return FlowState.COMPLETE_SIGNUP;
}

// ── s02: complete signup (accept legal checkbox → submit) ──────────
export async function s02CompleteSignup(ctx: FlowCtx): Promise<FlowState> {
  const { account, googleOAuth, cfg, log } = ctx;
  const pace = resolvePace(cfg.pace);
  const page = await resolveAppPage(ctx);
  await page.bringToFront().catch(() => {});

  // Check if we are already past complete-signup (e.g. welcome or dashboard)
  if (page.url().includes("/welcome") || (await page.$(Selectors.welcomeOrgName))) {
    log("info", "already on welcome page — skipping complete-signup");
    return FlowState.WELCOME;
  }
  if (page.url().includes("/keys") || (await page.$(Selectors.apiKeyName))) {
    log("info", "already registered — skipping to api key");
    return FlowState.API_KEY;
  }

  // Find legal terms checkbox (#legal_accepted)
  const legalCheckbox = await waitForAnySelector(page, [Selectors.completeSignupCheckbox], 15_000);
  if (!legalCheckbox) {
    // If not found, double-check if redirected
    if (page.url().includes("/welcome")) return FlowState.WELCOME;
    if (page.url().includes("/keys")) return FlowState.API_KEY;
    throw new FlowError("LEGAL_CHECKBOX_MISSING", "legal_accepted checkbox not found on complete-signup page");
  }

  const isChecked = await legalCheckbox
    .evaluate((el) => (el as HTMLInputElement).checked)
    .catch(() => false);
  if (!isChecked) {
    await safeClick(page, legalCheckbox);
    await sleep(randomInt(pace.pauseMin, pace.pauseMax));
  }
  await legalCheckbox.dispose().catch(() => {});

  // Cek Turnstile sebelum submit jika Clerk memunculkan challenge
  await resolveTurnstileIfPresent(page, log, 5000);

  // Click submit button: "Complete Sign Up"
  const submitted =
    (await clickByText(page, Selectors.completeSignupSubmit, googleOAuth)) ||
    (await safeClick(
      page,
      (await page.$(Selectors.completeSignupSubmitSelector)) as ElementHandle<Element>,
    ));

  if (!submitted) {
    throw new FlowError("COMPLETE_SIGNUP_SUBMIT_FAILED", "Complete Sign Up submit button click failed");
  }

  log("info", `complete-signup submitted for ${account.email}`);

  // Wait for next surface: welcome form or keys dashboard
  const nextSurface = await waitForSelectorRecover(
    page,
    [Selectors.welcomeOrgName, Selectors.apiKeyName, 'a[href*="/keys"]'],
    cfg.welcomeTimeoutSec * 1000,
    { log, label: "welcome / dashboard after complete signup", pollMs: pace.pollMs },
  );

  if (!nextSurface) {
    if (page.url().includes("/welcome")) return FlowState.WELCOME;
    if (page.url().includes("/keys")) return FlowState.API_KEY;
    await page
      .screenshot({ path: `${cfg.screenshotDir}/post-complete-${account.email.replace(/[^a-z0-9]/gi, "_")}.png` })
      .catch(() => {});
    throw new FlowError("WELCOME_TIMEOUT", "welcome or dashboard not reached after complete signup");
  }
  await nextSurface.dispose().catch(() => {});

  if (page.url().includes("/welcome") || (await page.$(Selectors.welcomeOrgName))) {
    return FlowState.WELCOME;
  }
  return FlowState.API_KEY;
}

// ── s03: welcome page (organization setup + spend $1k-$10k + checklist) ─
export async function s03Welcome(ctx: FlowCtx): Promise<FlowState> {
  const { account, googleOAuth, cfg, log } = ctx;
  const pace = resolvePace(cfg.pace);
  const page = await resolveAppPage(ctx);
  await page.bringToFront().catch(() => {});

  // If already on dashboard or /keys, skip welcome
  if (page.url().includes("/keys") || (!page.url().includes("/welcome") && (await page.$(Selectors.apiKeyName)))) {
    log("info", "already on keys dashboard — skipping welcome");
    return FlowState.API_KEY;
  }

  // Wait for #orgName
  const orgInput = await waitForAnySelector(page, [Selectors.welcomeOrgName], 20_000);
  if (!orgInput) {
    if (page.url().includes("/keys") || (await page.$('a[href*="/keys"]'))) {
      log("info", "welcome skipped automatically by platform");
      return FlowState.API_KEY;
    }
    throw new FlowError("ORG_INPUT_MISSING", "organization name input not found on welcome page");
  }

  // 1. Fill Organization Name
  const orgName = randomOrgName(account.email);
  await fillInput(page, orgInput, orgName);
  await sleep(randomInt(pace.pauseMin, pace.pauseMax));
  await orgInput.dispose().catch(() => {});

  // 2. Fill Monthly Spend ($1k - $10k random)
  const spendInput = await waitForAnySelector(page, [Selectors.welcomeMonthlySpend], 10_000);
  if (!spendInput) throw new FlowError("SPEND_INPUT_MISSING", "monthly spend input not found on welcome page");
  // random between 1000 and 10000, e.g. 2500, 5000, 7500
  const monthlySpend = String(randomInt(1000, 10000));
  await fillInput(page, spendInput, monthlySpend);
  await sleep(randomInt(pace.pauseMin, pace.pauseMax));
  await spendInput.dispose().catch(() => {});

  // 3. Fill checklist bebas
  // The dataset contains 5 options (first 2 are checked by default).
  // Randomly click an unchecked option to add human variation.
  try {
    const labels = await page.$$(Selectors.welcomeChecklistLabels).catch(() => []);
    if (labels.length > 2) {
      const idx = randomInt(2, labels.length - 1);
      await safeClick(page, labels[idx]).catch(() => {});
      await sleep(randomInt(pace.pauseMin, pace.pauseMax));
    }
    for (const l of labels) await l.dispose().catch(() => {});
  } catch {
    /* checklist interaction optional */
  }

  // 4. Click Submit: "Continue to Dashboard"
  // Wait briefly for submit button to be enabled (Next.js form validation)
  await sleep(500);
  const submitBtn = await waitForAnySelector(page, [Selectors.welcomeSubmitSelector], 10_000);
  if (!submitBtn) throw new FlowError("WELCOME_SUBMIT_MISSING", "Continue to Dashboard button not found");

  const clicked =
    (await safeClick(page, submitBtn)) ||
    (await clickByText(page, Selectors.welcomeSubmit, googleOAuth));
  await submitBtn.dispose().catch(() => {});

  if (!clicked) throw new FlowError("WELCOME_SUBMIT_FAILED", "failed clicking Continue to Dashboard button");

  log("info", `welcome submitted (org=${orgName}, spend=$${monthlySpend}) for ${account.email}`);

  // Wait for dashboard navigation
  const reachedDashboard = await waitForSelectorRecover(
    page,
    ['a[href*="/keys"]', 'button[data-slot="button"]', Selectors.apiKeyName],
    cfg.apiKeyTimeoutSec * 1000,
    { log, label: "dashboard landing", pollMs: pace.pollMs },
  );

  if (!reachedDashboard && !page.url().includes("dashboard.fastrouter.ai")) {
    await page
      .screenshot({ path: `${cfg.screenshotDir}/post-welcome-${account.email.replace(/[^a-z0-9]/gi, "_")}.png` })
      .catch(() => {});
    throw new FlowError("DASHBOARD_TIMEOUT", "dashboard not reached after welcome submission");
  }
  if (reachedDashboard) await reachedDashboard.dispose().catch(() => {});

  return FlowState.API_KEY;
}

// ── s04: dashboard → verify $1 credit → create API key → extract → save ─
export async function s04CreateApiKey(ctx: FlowCtx): Promise<FlowState> {
  const { account, googleOAuth, cfg, log, apiKeyRef } = ctx;
  const pace = resolvePace(cfg.pace);
  const page = await resolveAppPage(ctx);
  await page.bringToFront().catch(() => {});

  // Ensure we are on the /keys page
  if (!page.url().includes("/keys")) {
    const keysNav = await waitForAnySelector(page, [Selectors.keysTabLink], 10_000).catch(() => null);
    if (keysNav) {
      log("info", "navigating to Keys page via sidebar link");
      await safeClick(page, keysNav);
      await keysNav.dispose().catch(() => {});
      await sleep(1500);
    }
  }

  // 1. Verify Credit: "pastikan credit $1 nya ada di halaman nya artinya sudah selesai"
  const creditConfirmed = await (async () => {
    const deadline = Date.now() + cfg.creditsTimeoutSec * 1000;
    while (Date.now() < deadline) {
      // Check aria-label="Low credits, Available credits: 1.00" or span text "$1.00"
      const el = await page.$(Selectors.creditsLink).catch(() => null);
      if (el) {
        const ariaLabel = (await el.evaluate((n) => n.getAttribute("aria-label") ?? "").catch(() => "")) ?? "";
        const text = (await el.evaluate((n) => n.textContent ?? "").catch(() => "")) ?? "";
        await el.dispose().catch(() => {});
        if (Selectors.creditsBonus.test(ariaLabel) || Selectors.creditsBonus.test(text)) {
          return true;
        }
      }
      if (await bodyMatches(page, Selectors.creditsBonus)) {
        return true;
      }
      await sleep(pace.pollMs);
    }
    return false;
  })();

  if (creditConfirmed) {
    log("info", `bonus credit $1.00 verified on dashboard for ${account.email}`);
  } else {
    log("warn", `credit $1.00 not verified within timeout for ${account.email} (proceeding with key creation)`);
  }

  // 2. Click "Create User Key" button (if modal is not already open)
  const isModalOpen = await page.evaluate(() => {
    const codes = Array.from(document.querySelectorAll("code")).map((c) => (c.textContent || "").trim());
    const hasKey = codes.some((k) => k.startsWith("sk-v1-") && !k.includes("...") && k.length >= 30);
    const hasModal = !!document.querySelector('input#api_key_name, button[data-slot="button"]:has-text("Copy API Key"), div[class*="backdrop-blur"]');
    return hasKey || hasModal;
  }).catch(() => false);

  if (!isModalOpen) {
    let createBtn = await firstVisible(page, [
      'button:has-text("Create User Key")',
      'button:has-text("Create Key")',
    ]);
    if (!createBtn) {
      // Fall back to dom.clickByText
      const clicked = await clickByText(page, Selectors.createKeyButton, googleOAuth);
      if (!clicked) {
        // Try searching any button containing "Create"
        const btnHandle = await page.evaluateHandle(() => {
          return Array.from(document.querySelectorAll("button")).find((b) =>
            /create (user )?key/i.test((b.textContent || "").trim()),
          );
        });
        const el = btnHandle.asElement();
        if (el) {
          createBtn = el as ElementHandle<Element>;
        }
      }
    }

    if (createBtn) {
      await safeClick(page, createBtn);
      await createBtn.dispose().catch(() => {});
      log("info", `clicked Create User Key for ${account.email}`);
    }
  } else {
    log("info", `API key modal is already open for ${account.email}`);
  }

  // 3. Modal opens with Key Information and pre-generated key
  // Wait for modal dialog and extract sk-v1-... key
  const keyText = await (async () => {
    const deadline = Date.now() + 45_000;
    let reloads = 0;
    while (Date.now() < deadline) {
      if (reloads < 2 && (await isReactErrorPage(page))) {
        reloads++;
        log("warn", `error page while waiting for api key modal → reloading (${reloads}/2)`);
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
        await sleep(1500);
      }

      // Check all <code> elements in the page
      const candidateKeys = await page
        .evaluate(() => {
          return Array.from(document.querySelectorAll("code")).map((c) => (c.textContent || "").trim());
        })
        .catch(() => [] as string[]);

      for (const k of candidateKeys) {
        // Must start with sk-v1-, no ellipsis, no whitespace, valid length
        if (
          k.startsWith("sk-v1-") &&
          !k.includes("...") &&
          !/\s/.test(k) &&
          k.length >= API_KEY_MIN_LEN
        ) {
          return k;
        }
      }

      // Also check if any input or textarea holds the key
      const inputKeys = await page
        .evaluate(() => {
          return Array.from(document.querySelectorAll("input, textarea"))
            .map((el) => (el as HTMLInputElement).value || "")
            .filter((v) => v.startsWith("sk-v1-") && !v.includes("...") && v.length >= 25);
        })
        .catch(() => [] as string[]);

      if (inputKeys.length > 0) return inputKeys[0];

      await sleep(Math.min(pace.pollMs, 500));
    }
    return null;
  })();

  if (!keyText) {
    const stem = `${cfg.screenshotDir}/no-apikey-${account.email.replace(/[^a-z0-9]/gi, "_")}`;
    await page.screenshot({ path: `${stem}.png` }).catch(() => {});
    await page
      .content()
      .then((html) => fs.writeFileSync(`${stem}.html`, html, "utf8"))
      .catch(() => {});
    log("error", `could not read the FastRouter API key — dumped to ${stem}.html`);
    throw new FlowError("BAD_API_KEY", "FastRouter API key did not appear in modal");
  }

  // 4. Fill Key Name (optional / good practice) and Save modal
  try {
    const nameInput = await page.$(Selectors.apiKeyName).catch(() => null);
    if (nameInput) {
      const cur = await nameInput.evaluate((el) => (el as HTMLInputElement).value).catch(() => "");
      if (!cur) {
        await fillInput(page, nameInput, `Key - ${Date.now()}`);
        await sleep(300);
      }
      await nameInput.dispose().catch(() => {});
    }

    // Click "Copy API Key" button
    await clickByText(page, Selectors.apiKeyCopy, googleOAuth, { optional: true });
    await sleep(200);

    // Click "Save" button in the modal
    await clickByText(page, Selectors.apiKeySave, googleOAuth, { optional: true });
    await sleep(500);
  } catch {
    /* key already captured safely */
  }

  apiKeyRef.current = keyText.trim();
  log("info", `FastRouter API key obtained for ${account.email}: ${keyText.slice(0, 15)}...`);
  return FlowState.DONE;
}

export const STEPS: Record<string, (ctx: FlowCtx) => Promise<FlowState>> = {
  [FlowState.SIGNUP]: s01Signup,
  [FlowState.VERIFY_OTP]: s01bVerifyOtp,
  [FlowState.COMPLETE_SIGNUP]: s02CompleteSignup,
  [FlowState.WELCOME]: s03Welcome,
  [FlowState.API_KEY]: s04CreateApiKey,
};
