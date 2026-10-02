# Camoufox Anti-Detect Engine Reference

## Overview

**Camoufox** is a customized Firefox (Gecko) build with C++ patches designed specifically to defeat advanced bot-detection systems (Cloudflare Turnstile, Datadome, Kasada, Akamai, Clerk Security Checks).

In this repository, it serves as the alternative engine alongside the primary Bun/Puppeteer engine.

## Why Camoufox for Turnstile?

Cloudflare Turnstile analyzes:
1. Browser execution environment (CDP leaks, navigator.webdriver, runtime globals).
2. Canvas, WebGL, and Audio hardware fingerprint consistency.
3. Behavior and event dispatch cadence.

Brave Browser and Chromium-based stealth extensions often trigger Turnstile "troubleshoot" or interactive failure because Brave Shields farbles canvas hashes and introduces inconsistencies.
Camoufox produces mathematically authentic hardware fingerprints directly at the C++ browser level, allowing it to pass Turnstile **silently and automatically (zero challenge modal)**.

## Architecture in this Repository

```
cbdg/
├── packages/
│   ├── camoufox_core/            # Shared Python automation library
│   │   ├── browser.py            # launch_camoufox + geoip
│   │   ├── google_oauth.py       # Playwright Google SSO solver
│   │   ├── loaders.py            # Account & proxy parsers
│   │   ├── store.py              # JsonlStore & ResultWriter
│   │   └── log.py                # JSON-structured logging
│   └── google-oauth/             # TS library (includes pythonBridge)
├── apps/
│   ├── fastrouter/
│   │   ├── src/cli.ts            # Dispatches to camoufox_runner.py when --engine python
│   │   └── camoufox_runner.py    # Python FastRouter automation
│   └── crusoe/
│       ├── src/cli.ts            # Dispatches to camoufox_runner.py when --engine python
│       └── camoufox_runner.py    # Python Crusoe automation
```

## Running Automations with Camoufox

### Option 1: Via Bun CLI (Auto-delegation)
```bash
# FastRouter
bun run fastrouter --engine python --headed
bun run fastrouter --camoufox --no-proxy

# Crusoe
bun run crusoe --engine python --headed
```

### Option 2: Via Interactive Menu (`bun run start`)
When selecting `fastrouter` or `crusoe`, the prompt asks:
`Browser engine? [1] Python (Camoufox / Firefox) [2] Bun (Puppeteer / Chromium)`

### Option 3: Direct Python Execution
```bash
/home/azhar/.venvs/camoufox/bin/python apps/fastrouter/camoufox_runner.py --headed --no-proxy
/home/azhar/.venvs/camoufox/bin/python apps/crusoe/camoufox_runner.py --headed --no-proxy
```

## Key Playwright & Firefox Quirks

1. **Google Login `#identifierId` Type**:
   On Firefox/Camoufox, Google's `#identifierId` element has `type="text"`, whereas on Chromium it is often `type="email"`. Always select by `#identifierId` or `input[name="identifier"]`, not `input[type="email"]`.

2. **Proxy with GeoIP Matching**:
   Always pass `geoip=True` when running with a proxy. Camoufox automatically matches the browser's timezone, locale, and geolocation coordinates to the proxy's IP address.

3. **Checkboxes on Custom UI**:
   If `await checkbox.check()` fails due to Tailwind/custom overlay CSS, use `await page.evaluate("el => el.checked = true", checkbox)` followed by clicking the parent label.
