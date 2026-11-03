// ── DOM selectors for ChatGPT / OpenAI (chatgpt.com / auth.openai.com) ──
// Validated directly against gpt-dataset/*.html

export const SELECTORS = {
  // ── Step 1: Landing & Auth Modal Triggers (home.html & signup-modal.html) ──
  signUpButton:
    'button[data-mobile-auth-entry-action="signup"], button:has-text("Sign up for free"), button:has-text("Sign up"), button:has-text("Log in or create account")',
  authDialog:
    'dialog#mobile-auth-dialog, dialog[role="dialog"], dialog#mobile-new-chat-dialog',
  emailInput:
    'input#mobile-auth-email, input[name="login_hint"][type="email"], input[type="email"], input[placeholder*="Email" i]',
  emailSubmitButton:
    'button[data-w-component="button"][type="submit"], button[type="submit"]:has-text("Continue"), button:has-text("Continue")',

  // ── Step 2: Password Choice & Entry (create-password.html) ──
  continueWithPasswordButton:
    'button:has-text("Continue with password"), button:has-text("Sign up with password"), button[name="intent"][value*="password"], a:has-text("Continue with password"), a:has-text("password")',
  passwordInput:
    'input[name="new-password"], input[type="password"], input[placeholder*="Password" i], input[id*="password" i]',
  passwordSubmitButton:
    'button[data-dd-action-name="Continue"], button[type="submit"]:has-text("Continue"), button:has-text("Continue")',

  // ── Step 3: Check Inbox & OTP Verification (otp-setelah-continue-password.html) ──
  otpInput:
    'input[name="code"], input[autocomplete="one-time-code"], input[placeholder="Code"], input[inputmode="numeric"]',
  otpSubmitButton:
    'button:has-text("Submit code"), button[type="submit"]:has-text("Submit code"), button:has-text("Submit"), button[type="submit"]:has-text("Submit"), button[name="intent"][value="validate"], button[data-dd-action-name="Continue"], button[type="submit"]:has-text("Continue"), button:has-text("Continue")',
  resendEmailButton:
    'button[value="resend"], button:has-text("Resend email"), button:has-text("Resend")',

  // ── Step 4: About You Profile (about-you.html) ──
  nameInput:
    'input[name="name"], input[placeholder*="Full name" i], input[autocomplete="name"]',
  ageInput:
    'input[name="age"], input[placeholder*="Age" i], input[type="number"][name="age"]',
  aboutYouSubmitButton:
    'button[data-dd-action-name="Continue"], button[type="submit"]:has-text("Continue"), button:has-text("Continue")',

  // ── Step 5: Post-Success Onboarding Modal (success.html) ──
  onboardingContainer:
    'div:has-text("You\'re all set"), div:has-text("ChatGPT can make mistakes")',
  onboardingContinueButton:
    'button:has-text("Continue")',

  // ── Step 6: Chat Composer & Prompt (after-success.html) ──
  chatComposer:
    'div.ProseMirror[contenteditable="true"], #prompt-textarea, div[contenteditable="true"], textarea[placeholder*="Ask" i]',
  sendButton:
    'button[data-testid="send-button"], button[aria-label*="Send" i], button.bg-composer-primary, button:has(svg.icon-primary-action)',
  chatTurnResponse:
    'div[data-message-author-role="assistant"], div.agent-turn, div.markdown',
} as const;

/** 6-digit verification OTP code */
export const OTP_CODE_RE = /\b\d{6}\b/;

/** Robust extractor for ChatGPT email verification OTP that avoids CSS hex colors */
export function extractGptOtp(rawHtml: string): string | null {
  const unescaped = rawHtml
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

  const clean = unescaped.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  const mContext = clean.match(
    /(?:verification code|temporary verification code|code to continue|enter this temporary|enter the following|code:)[\s\S]{0,400}?(\d{6})/i,
  );
  if (mContext && mContext[1]) {
    return mContext[1];
  }

  const mBold = rawHtml.match(/<(?:b|strong|span|div)[^>]*>\s*(\d{6})\s*<\/(?:b|strong|span|div)>/i);
  if (mBold && mBold[1]) {
    return mBold[1];
  }

  const mLine = unescaped.match(/^\s*(\d{6})\s*$/m);
  if (mLine && mLine[1]) {
    return mLine[1];
  }

  return null;
}
