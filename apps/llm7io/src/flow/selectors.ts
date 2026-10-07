// ── Centralized selectors for LLM7.io ──────────────────────────────────
// Verified against dataset HTML snapshots in llm7io-dataset/

export const SELECTORS = {
  auth: {
    googleButton: "#google-signin-button, div.S9gUrf-YoZ4jf, button:has-text('Lanjutkan dengan Google'), button:has-text('Continue with Google')",
    termsCheckbox: "button[role='checkbox'].ios-green-checkbox",
    emailInput: "input#email-address, input.email-auth-input[type='email']",
    continueWithEmailBtn: "button:has-text('Continue with email')",
  },
  otp: {
    otpInput: "input#email-verification-code, input.email-verification-code",
    turnstileWidget: ".turnstile-widget, div.turnstile-widget-wrap",
    verifyEmailBtn: "button:has-text('Verify email')",
    resendCodeBtn: "button:has-text('Resend code')",
  },
  dashboard: {
    sidebar: "aside.dashboard-sidebar",
    navHome: "button:has-text('Home')",
    navApiKeys: "button:has-text('API Keys'), a[href*='api-keys']",
    logoutBtn: "button.dashboard-nav-logout, button:has-text('Logout')",
  },
  apiKeys: {
    addKeyBtn: "button.token-add-button, button:has-text('Add API key')",
    modal: "div[role='dialog']",
    tokenNameInput: "div[role='dialog'] input[placeholder='Token name'], input.token-form-input[type='text']",
    expiresAtInput: "div[role='dialog'] input[type='datetime-local'], input.token-form-input[type='datetime-local']",
    createBtn: "div[role='dialog'] button[type='submit']:has-text('Create'), div[role='dialog'] button:has-text('Create')",
    tokenValue: ".modal-token-value, div[role='dialog'] .modal-token-value",
    doneBtn: "div[role='dialog'] button:has-text('Done')",
    warningDismissBtn: "button.api-key-warning-dismiss",
  },
} as const;

export const OTP_CODE_RE = /Your verification code is:[^\d]*(\d{6})/i;
