// ── @ifqy/google-oauth — public API ─────────────────────────────────
// Reusable Google OAuth automation library (Bun + Puppeteer + stealth).
//
// Quick start:
//   import { launchGoogleOAuthBrowser, performGoogleOAuth } from "@ifqy/google-oauth";
//   const b = await launchGoogleOAuthBrowser({ headless: false });
//   const res = await performGoogleOAuth(b.page, b.context, { email, password });
//   await b.close();

export type { GoogleOAuthOptions } from "./config.js";
export { resolveGoogleOAuthOptions } from "./config.js";

export { assignUniqueProxies } from "./proxyPool.js";
export type { AssignOptions, Assignment } from "./proxyPool.js";

export type { Pace, PaceName } from "./pace.js";
export { PACES, resolvePace, isPaceName } from "./pace.js";

export {
  performGoogleOAuth,
  maybeClickGoogleProvider,
  findGoogleTrigger,
  isAccountRestricted,
  waitForGoogleSignInPage,
  maybeFillGoogleEmail,
  maybeHandleGooglePassword,
  advanceGoogleConsent,
  dismissCookieBanners,
  isGoogleUrl,
  isOnGoogleSignIn,
  findGooglePageIn,
  isGoogleCaptchaPage,
  isGoogleBlockedPage,
  type GoogleCredentials,
  type PasswordResult,
} from "./googleAuth.js";

export {
  launchGoogleOAuthBrowser,
  classifyNetworkError,
  GOOGLE_DIRECT_HOSTS,
  findInstalledBrowser,
  screenshotPath as browserScreenshotPath,
  type GoogleOAuthBrowser,
  type ProxySpec,
  type LaunchGoogleOAuthBrowserOptions,
} from "./browser.js";

export * as dom from "./dom.js";
export * as antiDetect from "./antiDetect.js";
export * as utils from "./utils.js";
export {
  findCamoufoxPython,
  shouldUsePythonEngine,
  spawnPythonRunner,
  type PythonRunnerOptions,
} from "./pythonBridge.js";

export type { GoogleOAuthBrowser as GoogleOAuthHandle } from "./browser.js";