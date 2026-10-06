# Failure catalogue

Every entry here cost a debugging session. Symptom first, because that is what
you have when you arrive.

---

## Cloudflare Turnstile "troubleshoot" error / Clerk SSO blocked

**Symptom.** Clicking "Sign up with Google" causes Clerk or Cloudflare to display
a modal: *"Security check: Complete this verification to continue with SSO"*,
or the Cloudflare Turnstile widget spins and ends in an error stating:
*"Unable to verify / troubleshooting required"*. Even manual clicking fails.

**Cause.** Chromium or Brave Browser's built-in shields randomize ("farble")
canvas, audio, and WebGL outputs. Cloudflare Turnstile flags these mathematically
inconsistent hashes as bot/tampering signals, instantly rejecting the token exchange.

**Fix.**
1. **Switch to Python Camoufox engine (`--engine python` or `--camoufox`).**
   Camoufox is built on C++ patched Firefox with mathematically authentic hardware
   fingerprints. In tests, it completely bypasses Turnstile challenges silently.
2. In Bun/Chromium: Ensure `--disable-features=BraveShields,BraveShieldsV1` and
   `--disable-brave-extension` flags are passed, or use standard Google Chrome stable.

---


## Forced headers break the site's own API

**Symptom.** The page renders. A button is visible and enabled. Clicking it
throws `TypeError: Cannot read properties of undefined (reading 'nodes')` (or
similar) from inside the site's bundle, and nothing happens.

**Cause.** `page.setExtraHTTPHeaders` applies to **every** request, not just
navigations. Pinning a browser-navigation `Accept: text/html,…` there makes the
app's own `fetch` send it too. Ory Kratos content-negotiates on `Accept`: with
`text/html` it answers `GET /self-service/login/browser` with a 303 to its HTML
login page instead of the flow JSON. The SPA stored that HTML string as its
`flow` object, so `flow.ui.nodes` exploded on click. The button stayed enabled
because a non-empty string is truthy.

**Fix.** Only set headers that are genuinely constant per browser
(`Accept-Language`, `DNT`). Chrome already sends a correct `Accept` per request
type.

**How to confirm in one run.** Log `r.request().headers()["accept"]` for
responses whose URL contains the auth path, and compare against
`application/json, text/plain, */*` (axios) or `*/*` (fetch).

---

## The button that does not exist yet

**Symptom.** Flow waits for a selector that "is obviously on the page" and
times out. A screenshot shows the page looking right.

**Cause.** The control lives behind another control. Crusoe's post-signup page
is a dashboard whose only relevant button is `Get API Key`; the `Create` button
and the name field only mount inside the flyout that button opens.

**Fix.** Wait for the *opener*, click it, then wait for the inner control. Keep
both in the selector file. Accept either surface when a platform may land on an
old and a new page.

**Tell.** Dump `aria-label` for every button. If the expected label is missing
but a plausible opener is present, this is it.

---

## Element exists but the scan says no

**Symptom.** `page.$(sel)` finds it, but an in-page `evaluate` scan returns
null, sub-millisecond, and the flow takes a fallback branch.

**Cause.** The frame navigated mid-scan. A destroyed execution context rejects
instantly, and a `catch (…) { return null }` makes that identical to "absent".

**Fix.** Retry once on a transient error (`execution context was destroyed`,
`target closed`, `detached frame`) before believing the negative. Log it.

---

## The fallback that leaves the page

**Symptom.** First scan misses; the automation then navigates somewhere else
and never recovers.

**Cause.** A generic "click login / sign in / get started" fallback. On a
landing page that already has the provider button, the only match was
`Already have an account? Login`, which navigated away and crashed the SPA.

**Fix.** If the page text already advertises the thing you want, wait for it.
Keep the fallback for pages that genuinely hide auth behind a route, and bound
how long it is suppressed.

---

## Regex declared outside, used inside

**Symptom.** A detector never fires. No error anywhere.

**Cause.** `page.evaluate(() => MY_RE.test(...))` — `MY_RE` is a Node binding
and does not exist in the browser. It throws `ReferenceError`, and the usual
`.catch(() => false)` turns every check into "no".

**Fix.** Pass `re.source` in as an argument and rebuild it inside the page.
Same for every constant.

---

## Key charset too narrow

**Symptom.** A one-time secret is displayed, the run reports it did not appear,
and the value is lost for good.

**Cause.** Validator was `^[A-Za-z0-9_-]{20,}$`. Real key:
`ZFvmGVC-QSO1vn7Ge23xYQ_2a_10_djXjYH64Ba97Ra/fHKiBA.h.8jg.0zKwMk9iEEYAuY5OKh0tvxXkm`
— it carries `/` and `.`. The first sample happened to have neither.

**Fix.** Treat the element that is *by construction* the value as authoritative:
accept it when it is long and whitespace-free, warn if the pattern disagrees,
and never throw the value away. Dump the page HTML on extraction failure so a
lost secret is still recoverable by hand.

---

## SPA error boundary

**Symptom.** "Unexpected Application Error!" replaces the whole UI.

**Cause.** A race in the target's own bundle, often after we navigated
somewhere unexpected.

**Fix.** Detect the error text and re-open the intended URL (not just reload —
the crash may have left a different route), bounded to a few attempts. Detect
via body text with the pattern passed into the page.

---

## Proxy credentials dropped on the floor

**Symptom.** Every account fails on the very first navigation with
`net::ERR_INVALID_AUTH_CREDENTIALS`, and the headed browser looks like it closes
by itself. Only happens with proxies; without them the same run is fine. The
proxies themselves test fine with `curl`/`fetch`.

**Cause.** The seed loader built `server` from protocol and host only, so
`http://user:pass@host:port` became `http://host:port`. Chrome then met the
proxy's 407 with nothing to answer it. The credentials were parsed and thrown
away in the same expression.

**Fix.** Carry username and password beside `server` — Chrome's
`--proxy-server` flag takes no credentials, they go through `page.authenticate`.
Do it for every page in the context, not just the first: `authenticate` is
per-page and OAuth opens popups.

**Tell.** Launch twice through the same proxy, once with credentials and once
without, and navigate anywhere. The difference is the whole diagnosis.

---

## Captcha that only appears through the proxy

**Symptom.** With a proxy, Google serves an image captcha at the email step and
the flow parks there ("identifier-stuck"). Without a proxy the same accounts
sail through.

**Cause.** Shared datacenter addresses score badly with Google's sign-in risk
engine. The proxy is doing its job for the site being automated and ruining the
part that runs on Google.

**Fix.** Do not toggle the proxy off and on — that means relaunching the browser
and losing the OAuth session. Chrome can split the routing inside one session:
`--proxy-server=... --proxy-bypass-list=accounts.google.com;...`. The site keeps
the proxy address, Google sees the machine's own.

Keep `www.google.com` OUT of the bypass list: it serves reCAPTCHA for the sites
being automated, and that check should come from the same address the site sees.

**Tell.** One browser, two navigations: a bypassed IP-echo host answers with your
own address, a non-bypassed one answers with the proxy's. If both agree, the
flag never reached Chrome.

**Cost to state out loud.** Every Google login now comes from one address. Better
than a flagged datacenter range, but keep the inter-account delay.

---

## Popup stolen by a sibling worker

**Symptom.** With parallel workers, one account's OAuth window ends up driven
by another account's flow.

**Fix.** Filter `targetcreated` to your own browser context and ignore the
page that opened it.

---

## Waiting for a network that never goes idle

**Symptom.** A fixed ~30 s pause per account before anything happens.

**Cause.** `waitForNetworkIdle({ timeout: 30_000 })` on a page with telemetry
or long-poll. It burns the full timeout and then proceeds anyway.

**Fix.** Race it against "the element I need is visible". See
`pacing.md`.

---

## Playwright `Please use browser.new_context()` on secondary tabs

**Symptom.** The automation runs through signup, but when opening a secondary tab (e.g. Gmail inbox to fetch verification link), it immediately crashes with:
`playwright._impl._errors.Error: Please use browser.new_context()`.

**Cause.** The browser session was started using `page = await browser.new_page()`. In Playwright, `browser.new_page()` creates an implicit internal context with `_owner_page` pinned to that single page. Calling `page.context.new_page()` is explicitly forbidden by Playwright.

**Fix.** Always create an explicit `BrowserContext` first:
```python
async with browser_ctx as browser:
    context = await browser.new_context(ignore_https_errors=True)
    page = await context.new_page()
    # Now context.new_page() works anywhere in this session!
```

---

## GSuite / Workspace Terms of Service Speedbump

**Symptom.** During Google OAuth, the page stops on `https://accounts.google.com/speedbump/workspacetermsofservice` with title "Selamat datang di akun baru Anda" / "Welcome to your new account", and never redirects back to the application.

**Cause.** Freshly provisioned Google Workspace / GSuite enterprise accounts mandate accepting the organization's domain policy on first login.

**Fix.** In `packages/camoufox_core/google_oauth.py`, check for `speedbump/workspacetermsofservice` and automatically click `button:has-text("I understand")` / `button:has-text("Saya mengerti")`.

---

## Resume hang on already-enabled features (Idempotency failure)

**Symptom.** When re-running or resuming an account that previously completed partially (e.g. Google OAuth finished, but API key creation failed), the runner hangs on the dashboard waiting for a first-time button (e.g. "Enable free models" or "Finish and start chatting") until timeout.

**Cause.** On accounts that already completed those steps, the platform hides the onboarding banner permanently. Waiting on that selector with a long timeout causes unnecessary hangs or failures.

**Fix.** Make every step idempotent:
1. If the landing page already redirects to `/dashboard`, skip login/OAuth entirely.
2. Check if the feature is already active (e.g. `Free allowance` text visible) before waiting for the consent button.
3. Check if the email verification banner exists before clicking or opening Gmail.

---

## Verification URL wrapped in Google tracking redirect

**Symptom.** Link extracted from Gmail is a Google redirect URL (`https://www.google.com/url?q=...`) containing encoded entities (`&amp;`, `%3D`), and navigating to it fails or triggers security warnings.

**Cause.** Gmail desktop web wraps external links in `google.com/url` redirection.

**Fix.** Unescape HTML entities with `html.unescape()` and parse the `q` query parameter:
```python
from urllib.parse import urlparse, parse_qs
import html

raw_url = html.unescape(extracted_text)
if "google.com/url" in raw_url:
    parsed = urlparse(raw_url)
    qs = parse_qs(parsed.query)
    clean_url = qs.get("q", [raw_url])[0]
```

