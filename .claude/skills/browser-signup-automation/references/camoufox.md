# Camoufox Anti-Detect Engine Reference

## Overview

**Camoufox** is a customized Firefox (Gecko) build with C++ patches designed specifically to defeat advanced bot-detection systems (Cloudflare Turnstile, Datadome, Kasada, Akamai, Clerk Security Checks).

In this repository, it serves as the alternative engine alongside the primary Bun/Puppeteer engine.

## Why Camoufox for Turnstile?

Cloudflare Turnstile analyzes:
1. Browser execution environment (CDP leaks, `navigator.webdriver`, runtime globals).
2. Canvas, WebGL, and Audio hardware fingerprint consistency.
3. Behavior and event dispatch cadence.

Brave Browser and Chromium-based stealth extensions often trigger Turnstile "troubleshoot" or interactive failure because Brave Shields farbles canvas hashes and introduces inconsistencies.
Camoufox produces mathematically authentic hardware fingerprints directly at the C++ browser level, allowing it to pass Turnstile **silently and automatically (zero challenge modal)**.

---

## Architecture in this Repository

```
cbdg/
├── packages/
│   ├── camoufox_core/            # Shared Python automation library
│   │   ├── browser.py            # launch_camoufox + proxy bypass + geoip + signals
│   │   ├── google_oauth.py       # Playwright Google SSO solver + speedbump handler
│   │   ├── loaders.py            # Account & proxy parsers
│   │   ├── store.py              # JsonlStore & ResultWriter
│   │   └── log.py                # JSON-structured logging
│   └── google-oauth/             # TS library (includes pythonBridge)
├── apps/
│   ├── <app>/
│   │   ├── src/cli.ts            # Dispatches to camoufox_runner.py when --engine python
│   │   └── camoufox_runner.py    # Python Camoufox automation entrypoint
```

---

## Running Automations with Camoufox

### Option 1: Via Bun CLI (Auto-delegation)
```bash
bun run <app> --engine python --headed
bun run <app> --camoufox --no-proxy
```

### Option 2: Via Interactive Menu (`bun run start`)
When selecting any supported app, the prompt asks:
`Browser engine? [1] Python (Camoufox / Firefox) [2] Bun (Puppeteer / Chromium)`

### Option 3: Direct Python Execution
```bash
/home/azhar/.venvs/camoufox/bin/python apps/<app>/camoufox_runner.py --headed --no-proxy
```

---

## Essential Playwright Patterns & Quirks

### 1. Multi-Tab Support: ALWAYS Use `browser.new_context()`
In Playwright, calling `page = await browser.new_page()` binds an internal single-page context (`_owner_page`). Attempting to open subsequent tabs via `page.context.new_page()` will immediately raise:
```
playwright._impl._errors.Error: Please use browser.new_context()
```
**The Rule:** Always instantiate an explicit `BrowserContext`:
```python
async with browser_ctx as browser:
    context = await browser.new_context(ignore_https_errors=True)
    page = await context.new_page()
    page.set_default_timeout(35000)
    
    # Secondary tabs (like Gmail or verification popups) will now succeed:
    gmail_page = await context.new_page()
    # ...
    await gmail_page.close()
```

### 2. Google Direct Routing & Proxy Bypass
Google risk control frequently serves captchas or blocks logins originating from datacenter proxy IPs.
We configure selective routing via `GOOGLE_DIRECT=1`:
```python
# In packages/camoufox_core/browser.py:
proxy_dict = {"server": proxy.server}
if google_direct:
    default_bypass = ["accounts.google.com", "ssl.gstatic.com", "www.gstatic.com", "mail.google.com", "gmail.com"]
    proxy_dict["bypass"] = ",".join(default_bypass)
```
The target application communicates through the assigned proxy, while Google/Gmail traffic routes directly via the host's clean residential IP.

### 3. Google Workspace Terms Speedbump Handling
Newly provisioned GSuite accounts often encounter a mandatory Terms of Service interstitial (`/speedbump/workspacetermsofservice`):
```python
# In packages/camoufox_core/google_oauth.py:
if "speedbump/workspacetermsofservice" in page.url:
    accept_btn = await page.query_selector(
        'button:has-text("I understand"), button:has-text("Saya mengerti"), button:has-text("Accept"), button:has-text("Setuju")'
    )
    if accept_btn:
        await accept_btn.click()
        await human_delay(2000, 3500)
```

### 4. Gmail In-Session Verification Tab
When an app requires clicking an email link post-Google-SSO (e.g. TokenHarbor):
1. Keep the main application `page` alive on `/dashboard`.
2. Open Gmail in a secondary tab using `gmail_page = await context.new_page()`.
3. Navigate to `https://mail.google.com/mail/u/0/#inbox`. (Session is shared, no re-login needed).
4. Handle any Gmail speedbumps or promo modals.
5. Locate the message row (`tr.zA:has-text("<AppName>")`) and open it.
6. Extract the verification URL, unescape any Google URL redirect (`google.com/url?q=...`), close `gmail_page`, and navigate to the link in the main `page`.

### 5. Google Login `#identifierId` Element Type
On Firefox/Camoufox, Google's `#identifierId` element has `type="text"`, whereas on Chromium it is often `type="email"`. Always select by `#identifierId` or `input[name="identifier"]`, not `input[type="email"]`.

### 6. Proxy with GeoIP Matching
Always pass `geoip=True` when running with a proxy. Camoufox automatically matches the browser's timezone, locale, and geolocation coordinates to the proxy's IP address.

### 7. Custom Styled Checkboxes
If `await checkbox.check()` fails due to Tailwind or custom CSS overlays, use:
```python
await page.evaluate("el => el.checked = true", checkbox)
```
Followed by clicking the parent label.

### 8. `human_delay` Pacing Support
`human_delay` supports optional `pace`:
```python
await human_delay(1500, 2500, pace=args.pace)
```
Behind the scenes in `packages.camoufox_core.browser`, `pace="fast"` scales the duration by 0.6x, while `pace="careful"` scales by 1.5x.

### 9. Clean Lifecycle Teardown in `finally`
Always cleanly close `page` and `context` in a `try ... finally` block before exiting the `async with browser_ctx as browser:` block:
```python
finally:
    try:
        if page and not page.is_closed():
            await page.close()
    except Exception:
        pass
    try:
        if context:
            await context.close()
    except Exception:
        pass
```
This guarantees no unawaited coroutines or orphan child processes remain lingering on the system.
