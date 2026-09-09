# @ifqy/google-oauth

Reusable **Google OAuth automation** library for **Bun + Puppeteer (puppeteer-extra stealth)**.
Ported from the battle-tested `cline-regist/cline/google-auth.js` flow, which was validated
against real GSuite accounts (email fill, password fill, consent screens, CAPTCHA detect,
block detect, popup handling, shadow-DOM-piercing selectors).

Use this library in **any** future project that needs "sign in with Google" automation —
no need to re-write the OAuth handling again.

## Install

```bash
bun add @ifqy/google-oauth   # from a workspace, or copy the package into your repo
```

The package has no build step — Bun resolves the `.ts` source directly via the `exports` map.

## Quick start

```ts
import {
  launchGoogleOAuthBrowser,
  performGoogleOAuth,
  isGoogleUrl,
} from "@ifqy/google-oauth";

const browser = await launchGoogleOAuthBrowser({ headless: false });

// 1. (optional) drive to your app's "sign up / continue with google" page first,
//    then either navigate onto Google or click the provider button:
//    const googlePage = await maybeClickGoogleProvider(browser.page, email);

// 2. Full OAuth — fills email + password, advances consent, handles CAPTCHA.
const { code, page } = await performGoogleOAuth(browser.page, browser.context, {
  email,
  password,
});
if (code !== "OK") throw new Error("oauth failed: " + code);

// 3. You are back off the Google domain, logged in.

// ALWAYS close the browser when you are done (fresh fingerprint next launch).
await browser.close();
```

## Browser launch

`launchGoogleOAuthBrowser` returns a **handle** (`GoogleOAuthBrowser = { browser, context, page, close }`)
so your app controls the lifecycle. This is essential when you need **a fresh fingerprint / proxy per
account** — close the handle and launch a new one for the next account.

- Picks an **installed** Edge/Chrome/Chromium on Windows/Linux/macOS (no bundled download needed).
- Applies `puppeteer-extra-plugin-stealth` + `--disable-blink-features=AutomationControlled`.
- Human-like viewport jitter and micro-mouse-move helper (`antiDetect`).
- Optional proxy via `launchGoogleOAuthBrowser({ proxy: { server, username, password } })`.

## Options

`performGoogleOAuth(page, context, creds, options)` / env overrides (all optional):

| option | env | default | meaning |
|---|---|---|---|
| `headless` | `GOOGLE_OAUTH_HEADLESS` | `false` | run browsers headed |
| `pace` | `GOOGLE_OAUTH_PACE` | `human` | `fast` / `human` / `careful` cadence (see below) |
| `genericAuthTextClick` | `GOOGLE_OAUTH_GENERIC_AUTH_CLICK` | `true` | allow the "login / sign in" fallback click |
| `consentTimeoutMs` | `GOOGLE_OAUTH_CONSENT_MS` | `90000` | max time leaving Google after password |
| `passwordTimeoutMs` | `GOOGLE_OAUTH_PASSWORD_MS` | `60000` | max time waiting for password field |
| `signinTimeoutMs` | `GOOGLE_OAUTH_SIGNIN_MS` | `30000` | max time waiting for Google sign-in page |
| `captchaTimeoutMs` | `GOOGLE_OAUTH_CAPTCHA_MS` | `180000` | manual captcha solve wait (headed) |
| `failOnCaptcha` | `GOOGLE_OAUTH_FAIL_ON_CAPTCHA` | `true` | throw instead of waiting on captcha |
| `screenShotDir` | — | `./screenshots` | where error/captcha screenshots land |
| `log` | — | console | `(level, msg, meta?) => void` |

## Pace

`pace` scales the deliberate human pauses and caps the blind waits:

| profile | typing per char | pause between actions | page-ready cap |
|---|---|---|---|
| `fast` | 18-55 ms | 120-380 ms | 6 s |
| `human` (default) | 30-90 ms | 300-800 ms | 15 s |
| `careful` | 60-150 ms | 700-1800 ms | 30 s |

`fast` is still human-shaped: keystrokes, mouse moves and pauses stay randomised
and never drop to zero. What it removes is waiting for something that already
finished. The flow waits for the sign-in field to exist rather than for the
network to fall idle, because an OAuth page never really falls idle.

```ts
await performGoogleOAuth(page, context, creds, { pace: "fast" });
```

## Using this on a platform we have not tested

The library is deliberately conservative about touching a page it does not
understand. Behaviour worth knowing before you point it at a new site:

- **No headers are forced onto XHR.** `setExtraHTTPHeaders` applies to *every*
  request, so pinning a navigation `Accept: text/html…` there makes JSON APIs
  content-negotiate back HTML. That silently broke an Ory Kratos login flow: the
  SPA stored an HTML page where a flow object belonged and crashed on click.
  Only `Accept-Language` and `DNT` are set globally.
- **`--disable-web-security` is off** unless you pass `disableWebSecurity: true`.
  It changes CORS and cookie behaviour, so an app can misbehave under automation
  while working in a normal browser. Extra flags go through `extraArgs`.
- **`dismissCookieBanners` only fires on a page that mentions cookies or consent**,
  and no longer clicks generic words like "continue" or "ok". On an untested
  site those words submit a wizard step or a half-filled form.
- **`maybeClickGoogleProvider` will not wander.** When the page text already says
  "… with Google" but the element is not grabbable yet, it waits instead of
  clicking a generic "Login" link that would navigate away from the very page
  holding the button. Pass `genericAuthTextClick: false` to disable that
  fallback entirely for sites whose provider button is on the landing page.
- **A frame navigating mid-scan is retried, not treated as "not found".** A
  destroyed execution context fails instantly and is indistinguishable from an
  absent element; `dom.safeEvaluate` and the provider scan both retry once.
- **Popups are matched to your own browser context**, so parallel workers cannot
  steal each other's OAuth windows.
- **`clickByText` scrolls into view and falls back to a DOM click**, so elements
  below the fold or under a sticky header still work.

## Error codes

`performGoogleOAuth` throws an `Error` with a `.code`:
`GOOGLE_BLOCKED`, `GOOGLE_BLOCKED_AFTER_EMAIL`, `GOOGLE_BLOCKED_PASSWORD`,
`GOOGLE_BLOCKED_AFTER_PASSWORD`, `GOOGLE_MISSING_PASSWORD`,
`GOOGLE_PASSWORD_FIELD_NOT_FOUND`, `GOOGLE_CONSENT_STUCK`, plus captcha errors.

## Lower-level pieces you can import

- `dom` — `clickByText`, `safeClick`, `waitForAnySelector`, `waitForVisibleInput`,
  `fillInput`, `focusInput`, `humanType`, `withPopup`, `findClickableByText`,
  `safeEvaluate`, `isTransientEvalError`.
- `findGoogleTrigger(page, log?)` — locate the provider button without clicking it
  (frame- and shadow-DOM-aware); useful when debugging a new site.
- `PACES`, `resolvePace`, `isPaceName` — the pace profiles.
- `antiDetect` — `simulateHumanBehavior`, `simulateHumanScroll`, `getRandomViewport`.
- `utils` — `sleep`, `randomInt`, `humanPause`, `sanitizeFileName`, `normalizeText`.