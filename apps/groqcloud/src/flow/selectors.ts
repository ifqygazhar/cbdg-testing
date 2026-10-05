// ── DOM selectors for GroqCloud onboarding & API key generation ───────
// Validated directly against groqcloud-dataset/*.html

export const SELECTORS = {
  // ── Signup / Login (/home or /login) ──
  emailInput: 'input#email-input, input[name="email"], input[type="email"]',
  submitEmailButton: 'button:has-text("Continue with email"), button[type="submit"]',
  checkEmailIndicator: ':has-text("Check your email"), :has-text("An email was sent")',

  // ── Keys Page (/keys) ──
  createKeyButton: 'button[data-testid="keys-page-create-button"], button:has-text("Create API Key")',
  keyNameInput: 'input[data-testid="key-name-input"], input[name="keyName"]',
  keyExpirationSelect: 'button[data-testid="key-expiration-select"]',
  turnstileContainer: '#cf-turnstile',
  createKeySubmitButton: 'button[data-testid="key-form-submit-button"], button[type="submit"]:has-text("Submit")',
  showKeyInput: 'input[data-testid="show-key-input"]',

  // ── Optional Cookie / Consent ──
  cookieConsent: 'button:has-text("Accept all"), button:has-text("Accept"), button.accept_all',
} as const;

/** Regex matching GroqCloud API key format (e.g. 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) */
export const API_KEY_RE = /gsk_[A-Za-z0-9_-]{20,}/;

/** Regex matching Stytch magic links delivered via email for GroqCloud */
export const MAGIC_LINK_RE = /https:\/\/(?:[a-zA-Z0-9_\-\.]+\.)?stytch\.com\/v1\/magic_links\/redirect\?[^\s"'<>]+/;
