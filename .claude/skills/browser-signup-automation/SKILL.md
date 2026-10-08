---
name: browser-signup-automation
description: Build or debug a browser signup/onboarding automation using either Bun (Puppeteer/Chromium) or Python (Camoufox/Firefox anti-Turnstile engine), with standardized support for both Google OAuth (GSuite) and TempMail (disposable inboxes). Use when adding a new target platform, when Cloudflare Turnstile blocks login, when a run hangs or "bengong", or when adapting to platform-specific onboarding steps. Enforces probe-before-guess, idempotency, and resilient multi-tab execution.
---

# Browser Signup & Onboarding Automation

Automations here follow a standardized dual-engine, dual-auth architecture. When adding a new target platform or debugging an existing one, adhere to these proven patterns to ensure resilience against bot protections, mid-flow crashes, and platform-specific quirks.

---

## 1. Dual-Auth Modality

Every automation platform should support one or both of the following authentication strategies:

### Mode A: Google OAuth (`--auth google`)
- **Account Source**: `gsuite.txt` or platform-specific account files via `load_accounts()`.
- **SSO Handling**: Solves Google login screens (`#identifierId`, `#password`), handles account choosers, and automatically accepts Google Workspace Terms of Service speedbumps (`/speedbump/workspacetermsofservice` via DOM evaluate + `scrollIntoView`).
- **Popup Synchronization**: In popup-based OAuth, NEVER exit the OAuth polling loop while ANY open page in `context.pages` is still on `accounts.google.com`. Prematurely returning the parent page leaves the popup stranded at the speedbump screen.
- **Proxy Bypass (`GOOGLE_DIRECT=1`)**: Automatically bypasses proxy for Google and Gmail hostnames (`accounts.google.com,ssl.gstatic.com,www.gstatic.com,mail.google.com,gmail.com`) so Google risk control sees the direct machine IP instead of flagged datacenter proxies.
- **Gmail Tab Verification (In-Session)**: If the target platform sends an email verification link even after Google SSO (e.g. TokenHarbor "Verify your email to claim rewards"), open Gmail web in a secondary tab inside the same authenticated context (`context.new_page()`), extract the link, and visit it.

### Mode B: TempMail (`--auth tempmail`)
- **API Provider**: TempMail-Pro (`https://temp-postservice.verifwebsitepro.workers.dev`).
- **Flow**: Generates an `@ifqy.net` address via `TempMailClient.create_email()`, fills the direct signup form, polls the API inbox for verification links or magic links (e.g. Stytch in GroqCloud), and navigates to the activation URL.

---

## 2. Dual-Engine Architecture

| Engine | Best For | Invocation |
|---|---|---|
| **Bun Engine** (`@ifqy/google-oauth` + Puppeteer / Chromium) | Standard SPAs, high-speed execution, straightforward login forms without aggressive bot detection. | `bun run <app> --engine bun` |
| **Python Engine** (`packages/camoufox_core` + Camoufox / Firefox) | **Cloudflare Turnstile**, Clerk SSO security checks, Datadome, Kasada. Hardware fingerprint spoofing passes Turnstile silently. | `bun run <app> --engine python` (auto-delegates), or `/home/azhar/.venvs/camoufox/bin/python apps/<app>/camoufox_runner.py` |

---

## 3. Standard Layout for New Apps (`apps/<app>/`)

When creating a new target automation, follow this uniform structure:

```
apps/<app>/
├── src/
│   ├── cli.ts            # CLI arguments parser (supports --auth, --engine, --pace, --limit, etc.)
│   ├── config.ts         # Typed config & env resolution
│   ├── runner.ts         # Bun/Puppeteer execution entrypoint
│   └── flow/
│       ├── selectors.ts  # Centralized CSS/XPath selectors
│       ├── steps.ts      # Granular step functions
│       └── engine.ts     # Flow orchestration
├── camoufox_runner.py    # Python Camoufox execution entrypoint
└── package.json          # Workspace package definition
```

Beside the app, create `<app>-dataset/` to store raw HTML snapshots:
- `<app>-dataset/signup.html`: Registration / SSO landing page.
- `<app>-dataset/onboarding.html`: Post-signup consent or survey screens.
- `<app>-dataset/dashboard.html`: Authenticated main dashboard.
- `<app>-dataset/apikey.html`: API key generation modal / page.
- `<app>-dataset/email.html`: Verification or magic link email structure.

---

## 4. Non-Negotiable Implementation Rules

### Rule 1: Always Use `browser.new_context()` in Python / Playwright
**NEVER** do `page = await browser.new_page()`. Playwright attaches `_owner_page` to the internal context, causing any subsequent `context.new_page()` (such as opening Gmail or popup) to crash with `Error: Please use browser.new_context()`.
**Always write:**
```python
async with browser_ctx as browser:
    context = await browser.new_context(ignore_https_errors=True)
    page = await context.new_page()
```

### Rule 2: Resumable & Idempotent Flows
Accounts often fail midway (rate limit, network blip) and get resumed. Every step must be idempotent:
- **Landing Check**: If navigating to the signup URL redirects immediately to `/dashboard`, skip login and proceed directly to dashboard steps.
- **Consent / Feature Flags**: Check if features (e.g. "Free models") are already enabled (e.g. `Free allowance` text visible) before waiting on buttons with long timeouts.
- **Verification Banners**: Check if the "Verify your email" banner exists before attempting to click it or check inboxes.
- **Fallback Access**: On Google OAuth, API access is often active immediately. If email verification link cannot be retrieved within timeout, log a warning and proceed directly to API key creation.

### Rule 3: Single-File Selectors with Text/Role Priority
Hashed CSS classes (e.g. `.css-c4xhxe`, `.btn-v3-blue`) change with every platform build. Always select using:
1. `data-testid` or `data-analytics`
2. `aria-label` or button role with text: `button:has-text("...")`
3. Structural tags: `tr.zA:has-text("...")`

### Rule 4: Clean Resource Disposal
- Always wrap browser instances in `async with` or `try ... finally`.
- Close secondary tabs (`gmail_page.close()`) as soon as the verification token is extracted.
- Catch signals using `setup_process_signals()` so Ctrl+C never leaves zombie browser processes.

### Rule 5: Google OAuth Popup Synchronization & Speedbump Automation
- **Never exit early in popup OAuth**: When an IdP flow opens in a popup window, `context.pages` holds both the parent app and the Google popup. The OAuth resolver must NEVER return the parent page while `accounts.google.com` remains in any open page URL. Only return once all Google pages have closed or redirected away.
- **Scroll & DOM Click for Terms of Service**: In Google v3 signin speedbumps (`/speedbump/workspacetermsofservice`), the "I understand" button (`button[jsname="LgbsSe"]`) sits at the bottom of the scrollable terms container. Always trigger it using DOM `evaluate` with `scrollIntoView({ behavior: 'instant', block: 'center' })` and `.click()`, backed by Playwright locator click fallbacks across multiple languages (`I understand`, `Saya mengerti`, `I agree`, `Saya setuju`, `Accept`).

### Rule 6: Proxy Rotation & Queue Deferral on Cloudflare Turnstile
- **Abort Immediately on Flagged Proxy**: Dirty datacenter IPs trigger Cloudflare Turnstile challenges immediately. Solving Turnstile through Playwright/Camoufox on flagged IPs often hangs, loops, or burns Google accounts. If Turnstile is detected on a proxy, raise `TurnstileDetectedException` immediately.
- **Queue Deferral (Process Other Accounts First)**: Discard/blacklist the bad proxy, push the current account to the back of the queue (`account_queue.append(account)`), and do NOT burn the account's attempt budget. Immediately proceed to the next account in the queue.
- **Fresh Randomized Fingerprint per Attempt**: Ensure every launch draws a brand-new, randomized hardware and browser fingerprint (`randomize_fingerprint=True`, OS, screen window, and humanize speed).

### Rule 7: Email Re-Verification & Gmail Thread Automation
- **Segregate Pending Verifications**: When API key check returns HTTP 403 (`Verify your email address to use the API...`), do not classify it as dead/bad. Match `"verify your email"`, `"confirmation link"`, and `"email_verification"`. Separate into `apikey-need-verif-<app>.txt` and `akun-need-verif-<app>.txt`.
- **Direct Network for Gmail in Firefox**: In Firefox Camoufox, `network.proxy.no_proxies_on` matches domain suffixes directly without wildcards. Never pass `*.google.com` (which breaks Firefox proxy bypass); always pass clean bare domains: `localhost,127.0.0.1,google.com,mail.google.com,accounts.google.com,gmail.com,gstatic.com,googleusercontent.com,googleapis.com`.
- **Gmail DOM: Open Thread Detail Before Extracting Verification Link**:
  - Never click table row center (`tr.zA`) as it clicks empty whitespace and fails to open the message.
  - Target the subject link specifically (`span.bog`, `td.y6`, `span.bqe`) and dispatch mouse events (`mousedown`, `mouseup`, `click`) without `{ view: window }` (passing `view: window` in Firefox sandboxed evaluate throws `UIEventInit does not implement interface Window`).
  - Verify detail view opened via thread hash (`window.location.hash.startsWith('#inbox/') && window.location.hash.length > 7`), subject header (`h2.hP`), or message body (`div.a3s`).
  - Inside the opened detail view, wait for message body to render, click the `Verify email` button (handling popup tab if opened), and extract the unescaped verification URL (`google.com/url?q=...`).
- **Re-Verification Runner Mode**: Implement `--reverify-email` in the runner. The flow supports logging in via Google OAuth (if GSuite account) or password form (if TempMail), clicking the verification/resend button on the dashboard, opening the email in Gmail direct, clicking the verification link, and confirming HTTP 200 API status before moving the account to `akun-good-<app>.txt`.

---

## 5. Integrating New Apps into the Master Runner

To make the new app available system-wide:
1. **Interactive Menu (`scripts/run.ts`)**:
   Add the app to the choices prompt. If the app supports both Google and TempMail, prompt for auth method:
   ```ts
   const authMethod = await select({
     message: "Metode pendaftaran <App>?",
     choices: [
       { name: "Google OAuth (GSuite)", value: "google" },
       { name: "TempMail (Disposable)", value: "tempmail" },
     ],
   });
   ```
2. **Planner (`scripts/plan.ts`)**:
   Map the chosen options to CLI flags (`--auth`, `--accounts-file`, `--domain`).
3. **`package.json`**:
   Add root script: `"<app>": "bun run apps/<app>/src/cli.ts"`.

---

## 6. Diagnosis & Probe-Before-Guess

Before modifying code when an automation hangs or fails, run a quick disposable probe:

### Quick Camoufox Probe:
```bash
cat > apps/<app>/__probe.py <<'PY'
import asyncio
from camoufox.async_api import AsyncCamoufox

async def main():
    async with AsyncCamoufox(headless=False) as browser:
        ctx = await browser.new_context()
        page = await ctx.new_page()
        await page.goto("<URL>", wait_until="domcontentloaded")
        await asyncio.sleep(5)
        print("URL:", page.url)
        print("Buttons:", [await b.text_content() for b in await page.query_selector_all("button")])
asyncio.run(main())
PY
/home/azhar/.venvs/camoufox/bin/python apps/<app>/__probe.py; rm apps/<app>/__probe.py
```

---

## 7. Reference Catalogue

- `references/app-template.md` — Complete, copy-pasteable boilerplate for creating a new app runner supporting Google OAuth + TempMail.
- `references/camoufox.md` — Camoufox architecture, multi-tab context rules, Turnstile bypass, and proxy bypass.
- `references/tempmail.md` — TempMail-Pro API endpoints, polling strategies, and magic link extraction.
- `references/traps.md` — Catalogue of known traps (Playwright context errors, GSuite speedbumps, Google redirect wrapping, etc.).
- `references/probes.md` — Copy-paste probe recipes for network, clicks, and headers.
- `references/pacing.md` — Human typing cadence, random mouse movements, and delays.
