// ── DOM selectors for Zro MoonMath (zro.moonmath.ai) automation ─────
// Validated directly against zromoonshotai-dataset/*.html

export const SELECTORS = {
  // ── Signup Trigger & Clerk Card ──
  clerkCard: "div.cl-card, div.cl-rootBox, form",

  // ── Mode A: Google OAuth ──
  googleOAuthButton:
    'button:has-text("Continue with Google"), button.cl-socialButtonsBlockButton__google, button[data-provider="google"]',

  // ── Mode B: TempMail direct signup form ──
  emailInput:
    'input#identifier-field, input[name="identifier"], input[placeholder*="email" i], input[type="text"]',
  continueSignUpButton:
    'button.cl-formButtonPrimary, button:has-text("Continue with email"), button:has-text("Continue")',

  // ── Step 2: Email OTP Verification (/sign-up/create/verify-email-address) ──
  otpInput:
    'input[data-input-otp="true"], input[aria-label="Enter verification code"], input[autocomplete="one-time-code"]',
  resendCodeButton: 'button.cl-formResendCodeLink, button:has-text("Resend")',
  verifyOtpSubmitButton:
    'button.cl-formButtonPrimary, button:has-text("Continue with email"), button:has-text("Continue")',

  // ── Step 3: Legal Consent (/sign-up/create/continue) ──
  legalAcceptedCheckbox:
    'input#legalAccepted-field, input[name="legalAccepted"], input[type="checkbox"]',
  legalAcceptedLabel: 'label[for="legalAccepted-field"], .cl-formFieldCheckboxLabel',
  legalContinueButton:
    'button.cl-formButtonPrimary, button:has-text("Continue with email"), button:has-text("Continue")',

  // ── Step 4: API Keys page (/api-keys) ──
  createApiKeyButton:
    'button.bg-ink:has-text("Create key"), button:has-text("Create key")',

  // ── Step 5: Popup Modal (popup-apikey.html) ──
  apiKeyAliasInput: 'input#api-key-alias, input[placeholder="agent-prod"]',
  apiKeySpendQuotaInput: 'input#api-key-spend-quota',
  modalSubmitCreateButton: 'button[type="submit"]:has-text("Create"), button:has-text("Create")',

  // ── Step 6: Extracted Key Success (apikey-success.html) ──
  apiKeyCodeDisplay: 'code.text-ink, code:has-text("sk-"), code',
  copyKeyButton: 'button:has-text("Copy key"), button:has-text("Copy")',
  doneButton: 'button:has-text("Done")',
} as const;

/** Regex matching Zro MoonMath API key format (e.g. sk-TxXV7OKx4EiIZ__EwOc_yQ) */
export const API_KEY_RE = /\bsk-[A-Za-z0-9_-]{20,}\b/;

/** 6-digit verification OTP code */
export const OTP_CODE_RE = /\b\d{6}\b/;
