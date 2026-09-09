// ── Crusoe flow selectors (validated against crusoe_ai_dataset/*.html) ──
// Text matchers are lowercase (dom clickByText lowercases page text).
// Attribute selectors target stable aria-labels (the CSS classes are
// css-* hashed and change between builds).

export const Selectors = {
  // before-signup-google-with$5.html — /request-foundry landing
  signupUrl: "https://console.crusoecloud.com/request-foundry",
  signUpGoogle: ["sign up with google"] as const,
  /** the real element: <button role="button" aria-label="Sign up with Google"> */
  signUpGoogleButton: [
    'button[aria-label*="with Google" i]',
    'button[aria-label*="Google" i]',
  ] as string[],

  // complete-signup.html — "Accept Invitation" (post-OAuth)
  completeSignupEmail: 'input[aria-label="Email"]',
  completeSignupName: 'input[aria-label="Name"]',
  completeSignupCompany: 'input[aria-label="Company Name"]',
  consentCheckbox: "input.ps-contract-target",
  completeSignupSubmit: ["create account and login"] as const,
  onboardingUrl: /console\.crusoecloud\.com\/(onboarding|.*foundry.*)$/,

  // create-apikey.html — Credits: $5.00 + alias + Create
  creditsBonus: /credits?:?\s*\$5|\$5\.00|5\.00/,
  /**
   * Post-signup landing is the Foundry welcome dashboard (title "Welcome"),
   * not a create-key form. The key form lives in a flyout that this button
   * opens; "Create" does not exist in the DOM until then.
   */
  getApiKey: 'button[aria-label="Get API Key"]',
  /** the flyout itself (role=dialog, data-state="entered") */
  apiKeyFlyout: '[role="dialog"][aria-modal="true"]',
  apiKeyAlias: "input#alias",
  apiKeyCreate: 'button[aria-label="Create"]',

  // after-apikey-appear.html — the raw key in <code data-sentry-element="ApiKeyValue">
  apiKeyValueSelector: 'code[data-sentry-element="ApiKeyValue"]',
  apiKeyCopy: ["copy"] as const,
} as const;

/**
 * A plausible API key: one long run of token characters, no whitespace.
 * Real keys are ~82 chars and are NOT plain base64url — they carry `/` and
 * `.` separators, e.g.
 * `ZFvmGVC-QSO1vn7Ge23xYQ_2a_10_djXjYH64Ba97Ra/fHKiBA.h.8jg.0zKwMk9iEEYAuY5OKh0tvxXkm`.
 * A stricter pattern silently discarded a key that was already on screen and
 * can never be shown again.
 */
export const API_KEY_RE = /^[A-Za-z0-9_\-./+=]{20,}$/;

/** Minimum length before a `<code>` blob is treated as a key at all. */
export const API_KEY_MIN_LEN = 20;