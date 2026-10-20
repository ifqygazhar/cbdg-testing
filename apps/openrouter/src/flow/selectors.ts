// ── DOM selectors for OpenRouter AI onboarding & key generation ─────────
// Validated directly against openrouter-dataset/*.html

export const SELECTORS = {
  // ── Signup Trigger & Clerk Modal ──
  signUpButtonNavbar: 'button:has-text("Sign Up"), a:has-text("Sign Up")',
  clerkModalDialog: 'div[role="dialog"].cl-modalContent, div.cl-rootBox, div[role="dialog"]',

  // ── Mode A: Google OAuth ──
  googleOAuthButton: 'button:has-text("Continue with Google"), button.cl-socialButtonsIconButton__google, button[aria-label*="Google" i]',

  // ── Mode B: Direct / TempMail Form ──
  firstNameInput: 'input[name="firstName"], input#firstName-field, input[placeholder*="First name" i]',
  lastNameInput: 'input[name="lastName"], input#lastName-field, input[placeholder*="Last name" i]',
  emailAddressInput: 'input[name="emailAddress"], input#emailAddress-field, input[type="email"]',
  passwordInput: 'input[name="password"], input#password-field, input[type="password"]',
  legalAcceptedCheckbox: 'input[name="legalAccepted"], input#legalAccepted-field, input[type="checkbox"]',
  continueSignUpButton: 'button.cl-formButtonPrimary, button:has-text("Continue")',

  // ── Clerk Verification Status ──
  verifyingRequestText: 'text="Verifying your request", :has-text("Please wait while we verify your request")',
  verifyEmailHeading: 'h1:has-text("Verify your email"), :has-text("Use the verification link sent to your email address")',

  // ── Onboarding Steps ──
  welcomeNextButton: 'button:has-text("Next")',
  acquisitionRadioFriend: 'input#acquisition-friend, input[type="radio"]',
  acquisitionContinueButton: 'button[type="submit"]:has-text("Continue"), button:has-text("Continue")',
  paymentMethodLaterButton: 'button:has-text("I\'ll do this later"), button:has-text("do this later"), button:has-text("Later"), button:has-text("Skip")',
  youAreAllSetDoneButton: 'a:has-text("Get API Key"), button:has-text("Get API Key"), button:has-text("Done"), button:has-text("Go to Dashboard")',

  // ── API Keys (/workspaces/default/keys) ──
  createApiKeyButton: 'button:has-text("Create API Key"), a:has-text("Create API Key"), button:has-text("Create Key"), button:has-text("New Key")',
  keyNameInput: 'input[name="name"], input#name, input[placeholder*="Chatbot Key" i]',
  expirationCombobox: 'button[id*="expiration"], button:has-text("Select expiration"), button:has-text("No expiration")',
  limitCombobox: 'button[id*="limit"], button:has-text("Choose a credit limit"), button:has-text("No limit")',
  dropdownOptionNoExpiration: 'div:has-text("No expiration"), [role="option"]:has-text("No expiration"), span:has-text("No expiration")',
  dropdownOptionNoLimit: 'div:has-text("No limit"), [role="option"]:has-text("No limit"), span:has-text("No limit")',
  modalSubmitCreateButton: 'div[role="dialog"] button[type="submit"]:has-text("Create"), button:has-text("Create")',

  // ── Reverification OTP Modal ──
  reverificationOtpInput: 'input[data-input-otp="true"], input[aria-label*="verification code" i], input[autocomplete="one-time-code"]',
  reverificationContinueButton: 'div.cl-cardBox button:has-text("Continue"), button:has-text("Continue")',

  // ── Extracted API Key Modal ──
  copyKeyButton: 'button[aria-label*="Copy key" i], button:has-text("Copy")',
  apiKeyCodeDisplay: 'code',
  closeKeyModalButton: 'button:has-text("Close")',
} as const;

/** Regex matching OpenRouter API key format (e.g. sk-or-v1-045...3c16) */
export const API_KEY_RE = /\bsk-or-v1-[A-Za-z0-9_-]{30,}\b/;

/** Regex matching OpenRouter Clerk email verification links */
export const VERIFY_LINK_RE = /https?:\/\/(?:clerk\.)?openrouter\.ai\/(?:v1\/verify|sign-up\/verify)[^\s"'<>]+/;
