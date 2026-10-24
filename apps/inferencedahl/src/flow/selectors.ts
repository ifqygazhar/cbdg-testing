// ── Centralized DOM Selectors for Inference Dahl Global ───────────
export const SELECTORS = {
  landing: {
    url: "https://inference.dahl.global/",
    signInLink: 'a[data-auth="guest"]',
    accountLink: 'a[data-auth="user"][href="/account"]',
  },
  signinModal: {
    dialog: '[role="dialog"][aria-modal="true"]',
    fingerprintInput: "input#signin-fingerprint",
    showButton: 'button[aria-label="Show"]',
    submitButton: 'form button[type="submit"]',
  },
  signupModal: {
    dialog: '[role="dialog"][aria-modal="true"]',
    usernameInput: "input#signup-username",
    regenerateButton: 'button[aria-label="Regenerate"]',
    submitButton: 'form button[type="submit"]',
  },
  fingerprintModal: {
    dialog: '[role="dialog"][aria-modal="true"]',
    codeElements: '[role="dialog"] code',
    copyButtons: '[role="dialog"] button[aria-label="Copy"]',
    downloadTxtButton: '[role="dialog"] button',
    savedCheckbox: 'input.auth-checkbox[type="checkbox"]',
    continueButton: '[role="dialog"] button[type="button"]',
  },
  dashboard: {
    url: "https://inference.dahl.global/account",
    apiKeysSection: 'section[aria-label="API keys"]',
    createNewKeyButton: 'section[aria-label="API keys"] button[type="button"]',
    keyCode: 'section[aria-label="API keys"] code',
    revealKeyButton: 'section[aria-label="API keys"] button[aria-label="Reveal"]',
    copyKeyButton: 'section[aria-label="API keys"] button[aria-label="Copy"]',
    allocateButton: 'section[aria-label="API keys"] button[type="button"]',
  },
  allocateModal: {
    dialog: '[role="dialog"][aria-modal="true"]',
    amountInput: '[role="dialog"] input[autocomplete="off"]',
    maxButton: '[role="dialog"] button[type="button"]',
    confirmAllocateButton: '[role="dialog"] button[type="button"]',
    closeButton: '[role="dialog"] button[aria-label="Close"]',
  },
} as const;

export const DAHL_FINGERPRINT_REGEX = /\b[a-f0-9]{32}\b/i;
export const DAHL_KEY_REGEX = /\bdahl_[A-Za-z0-9_-]{16,}\b/;
export const DAHL_MASKED_KEY_REGEX = /\bdahl_[A-Za-z0-9_-]{3,}(?:…|\.\.\.)[A-Za-z0-9_-]{3,}\b/;
export const DEMO_LANDING_KEY = "dahl_9iiiaUahAszFP1odpw1bvmuda8qpBGFkH";
