// ── Centralized DOM Selectors for Composite Lucidity ──────────────
export const SELECTORS = {
  signup: {
    url: "https://composite.lucidity.sh/login.html?mode=register",
    registerTab: 'button[role="tab"]:has-text("Register"), .tabs button.tab:nth-child(2)',
    activeRegisterTab: 'button[role="tab"].active:has-text("Register")',
    form: "form:not([hidden])",
    usernameInput: "input#reg-username",
    emailInput: "input#reg-email",
    passwordInput: "input#reg-password",
    confirmPasswordInput: "input#reg-confirm",
    referralInput: "input#reg-referral",
    turnstileWrap: ".turnstile-wrap",
    turnstileResponseInput: 'input[name="cf-turnstile-response"]',
    submitButton: 'form:not([hidden]) button[type="submit"], button[type="submit"]:has-text("Create account")',
    alertError: ".alert.alert-error",
  },
  dashboard: {
    url: "https://composite.lucidity.sh/dashboard.html",
    brand: ".shell-brand",
    avatar: ".shell-avatar",
  },
  apikeys: {
    url: "https://composite.lucidity.sh/apikeys.html",
    newKeyButton: 'button:has-text("New key"), .keys-tabbar button.btn-primary',
    modalOverlay: '.modal-overlay[role="dialog"]',
    modalCreateTitle: "#create-key-title",
    modalCreatedTitle: "#new-key-title",
    keyNameInput: "input#key-name-input",
    submitCreateButton: '.modal-card button[type="submit"], button:has-text("Create key")',
    keyDisplay: "code.new-key-display",
    copyButton: 'button:has-text("Copy key"), .modal-card button.btn-primary',
    closeModalButton: '.modal-header button[aria-label="Close"], .modal-header button.icon-btn',
  },
} as const;

export const COMPOSITE_KEY_REGEX = /cmp-[a-f0-9]{32}/i;
export const COMPOSITE_KEY_FALLBACK_REGEX = /cmp-[A-Za-z0-9_-]{20,}/i;
