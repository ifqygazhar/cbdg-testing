// ── DOM selectors for TokenHarbor onboarding & key generation ─────────
// Validated directly against tokenharbor-dataset/*.html

export const SELECTORS = {
  // ── Signup (/login?mode=signup) ──
  emailInput: 'input[name="email"], input[autocomplete="email"], input[type="email"]',
  passwordInput: 'input[name="password"], input[autocomplete="new-password"], input[type="password"]',
  inviteCodeInput: 'input[name="invite_code"]',
  submitSignUpButton: 'button[type="submit"][data-analytics="login-signup"], button[data-analytics="login-signup"], button[type="submit"]',
  acceptAnalyticsButton: 'button:has-text("Accept analytics"), button.btn-float-primary:has-text("Accept analytics")',
  essentialOnlyButton: 'button:has-text("Essential only")',

  // ── Dashboard (/dashboard) ──
  enableFreeModelsConsent: 'button[data-analytics="freemodel-consent-enable"], button:has-text("Enable free models")',
  enableFreeModelsSwitch: 'button[role="switch"][aria-label="Enable free models"]',
  verifyEmailBannerButton: 'button:has-text("Verify email"), button.btn-float-primary:has-text("Verify email")',

  // ── API Keys (/dashboard/api-keys) ──
  newKeyButton: 'button:has-text("+ New key"), button.btn-float-primary:has-text("+ New key"), button:has-text("New key")',
  keyLabelInput: 'input[placeholder*="Cursor, Production"], input.input-float[type="text"], input[type="text"]',
  createKeySubmitButton: 'button:has-text("Create key"), button.btn-float-primary:has-text("Create key")',
  apiKeyDisplay: 'code.input-float, code',
  errorMessage: 'form p[data-bordered="true"], form p.border, [role="alert"], .text-destructive, .text-red-500',
  somethingSnappedHeading: 'h2:has-text("Something snapped"), h2',
  googleOAuthButton: 'button[aria-label="Continue with Google"], button:has-text("Continue with Google")',
  finishAndStartChattingButton: 'button:has-text("Finish and start chatting"), button[type="submit"]:has-text("Finish and start chatting")',
  sendVerificationEmailButton: 'button:has-text("Send verification email"), button:has-text("Resend email")',
} as const;

/** Regex matching TokenHarbor API key format (e.g. thk_live_tkotA3u0vklWQT1yg5sAhRJP8za-2lnWx9SrT37EO2b2wd2LQe5iAlf8z-25Jo4j) */
export const API_KEY_RE = /thk_(?:live_)?[A-Za-z0-9_-]{20,}/;

/** Regex matching TokenHarbor email verification links */
export const VERIFY_LINK_RE = /https:\/\/tokenharbor\.ai\/verify-email\?token=[A-Za-z0-9_\-\.]+/;
