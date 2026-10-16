// ── DOM selectors for Inferbase AI onboarding & key generation ─────────
// Validated directly against inferbase-ai-dataset/*.html

export const SELECTORS = {
  // ── Signup (/register) ──
  emailInput: 'input#email, input[name="email"], input[type="email"]',
  fullNameInput: 'input#full_name, input[name="full_name"]',
  companyInput: 'input#company, input[name="company"]',
  passwordInput: 'input#password, input[name="password"]',
  confirmPasswordInput: 'input#confirmPassword, input[name="confirmPassword"]',
  submitSignUpButton: 'button[type="submit"]',
  googleOAuthLink: 'a[href*="/auth/google/start"], a:has-text("Continue with Google")',
  turnstileResponse: 'input[name="cf-turnstile-response"]',

  // ── Email verification (/verify-email) ──
  emailVerifiedHeading: 'h2:has-text("Email verified"), h1:has-text("Email verification")',
  goToPlaygroundButton: 'a[href="/playground"], a[href*="playground"], button:has-text("Go to Playground"), a:has-text("Go to Playground")',

  // ── Onboarding (/onboarding) ──
  onboardingGetStartedButton: 'button:has-text("Get started")',
  onboardingSkipButton: 'button:has-text("Skip")',
  onboardingContinueButton: 'button:has-text("Continue")',
  onboardingGoToDashboardButton: 'button:has-text("Go to Dashboard"), button:has-text("Go to dashboard")',

  // ── API Keys (/api-keys) ──
  createKeyButton: 'button:has-text("Create key")',
  keyNameInput: 'input#key-name, input[placeholder*="Production, Development"]',
  modalCreateKeyButton: 'div[role="dialog"] button:has-text("Create key")',
  doneButton: 'div[role="dialog"] button:has-text("Done"), button:has-text("Done")',
  apiKeyDisplay: 'div.select-all code, code.select-all, code',
} as const;

/** Regex matching Inferbase API key format (e.g. inf_LDGfZZsDgy_vpP5275Q4jl2FsWmhO2kPCT5MSdCgAJYxXgGj) */
export const API_KEY_RE = /\binf_[A-Za-z0-9_-]{20,}\b/;

/** Regex matching Inferbase email verification links */
export const VERIFY_LINK_RE = /https?:\/\/(?:www\.)?inferbase\.ai\/verify-email\?token=[A-Za-z0-9_\-\.]+/;
