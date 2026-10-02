// ── FastRouter flow selectors (validated against fastrouter_ai_dataset/*.html) ──
// Text matchers are lowercase (dom clickByText lowercases page text).
// Attribute selectors target stable aria-labels, testids or IDs.

export const Selectors = {
  // signup.html — https://fastrouter.ai/sign-up
  signupUrl: "https://fastrouter.ai/sign-up",
  signUpGoogle: ["sign up with google"] as const,
  signUpGoogleButton: [
    'button[data-testid="oauth-signup-google"]',
    'button[aria-label="Sign up with Google"]',
    'button[aria-label*="Google" i]',
  ] as string[],

  // complete-signup.html — https://fastrouter.ai/sign-up/continue
  completeSignupUrl: "https://fastrouter.ai/sign-up/continue",
  completeSignupCheckbox: "input#legal_accepted",
  completeSignupSubmit: ["complete sign up"] as const,
  completeSignupSubmitSelector: 'button[type="submit"]',

  // welcome-after-signup.html — https://dashboard.fastrouter.ai/welcome
  welcomeUrl: "https://dashboard.fastrouter.ai/welcome",
  welcomeOrgName: "input#orgName",
  welcomeMonthlySpend: "input#monthlySpend",
  welcomeChecklistLabels: "form label.cursor-pointer",
  welcomeChecklistOptions: [
    "Get a unified view of costs and usage",
    "Route to the optimal LLM",
    "Manage LLM access, budgets and limits across my organization",
    "Set up fallbacks and load balancing",
    "Test and measure model effectiveness",
  ] as const,
  welcomeSubmit: ["continue to dashboard"] as const,
  welcomeSubmitSelector: 'button[type="submit"]',

  // dashboard-create-apikey-and-save.html — https://dashboard.fastrouter.ai/.../keys
  dashboardKeysUrl: /dashboard\.fastrouter\.ai\/.*\/keys/,
  dashboardUrl: /dashboard\.fastrouter\.ai/,
  keysTabLink: 'a[href*="/keys"]',
  creditsLink: 'a[aria-label*="credits" i]',
  /** Bonus verification: credit $1.00 */
  creditsBonus: /(available\s+credits:?\s*\$?1(\.00)?)|(\$1\.00)|(1\.00\s*credits?)/i,

  createKeyButton: ["create user key", "create key"] as const,
  createKeyButtonSelector: 'button[data-slot="button"]',
  apiKeyName: "input#api_key_name",
  apiKeySave: ["save"] as const,
  apiKeyCopy: ["copy api key", "copy key"] as const,
  apiKeyValueSelector: "code",
} as const;

/**
 * FastRouter API key pattern: `sk-v1-<hash>`.
 * Verified against real key: `sk-v1-98b290acbaa48b1acc74546ff691f3265ffd5b2ab2592c6bbc150b4b56e9867c` (70 chars).
 * Reject ellipsis (`...`) so masked table keys like `sk-v1-98...67c` are never mistakenly saved.
 */
export const API_KEY_RE = /^sk-v1-[A-Za-z0-9_-]{20,}$/;

/** Minimum length before a <code> blob is treated as a valid FastRouter key. */
export const API_KEY_MIN_LEN = 25;
