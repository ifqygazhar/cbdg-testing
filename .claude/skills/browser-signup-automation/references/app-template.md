# Standard App Runner Template (Boilerplate)

This document provides the canonical template for creating a new platform automation (`apps/<new-app>/camoufox_runner.py`) that supports both **Google OAuth (GSuite)** and **TempMail (Disposable)** while adapting to the target platform's specific environment.

---

## Canonical `camoufox_runner.py` Boilerplate

```python
#!/usr/bin/env python3
"""
<AppName> Automation Runner (Python + Camoufox / Firefox engine)
Supports both Google OAuth (GSuite) and TempMail-Pro registration,
onboarding completion, and API key generation.
"""

import argparse
import asyncio
from collections import deque
import html
import os
import random
import re
import sys
import time
from typing import Optional, List, Set, Dict, Any
from urllib.parse import urlparse, parse_qs, unquote

# Ensure repo root is on sys.path
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from packages.camoufox_core import (
    launch_camoufox,
    get_browser_fingerprint_info,
    human_delay,
    human_type,
    load_accounts,
    load_proxies,
    Account,
    Proxy,
    JsonlStore,
    ResultWriter,
    FlowState,
    create_logger,
    setup_process_signals,
    TempMailClient,
    resolve_turnstile_if_present,
    perform_google_oauth,
)

# ── Platform-Specific URLs & Selectors ──────────────────────────────────────
DEFAULT_SIGNUP_URL = "https://<app-domain>/signup"
DASHBOARD_URL = "https://<app-domain>/dashboard"
API_KEYS_URL = "https://<app-domain>/dashboard/api-keys"

API_KEY_RE = re.compile(r"<key_prefix>_[A-Za-z0-9_\-]{20,}")
VERIFY_LINK_RE = re.compile(r"https?://(?:www\.)?<app-domain>/verify[^\s\"'<>]+", re.IGNORECASE)

# ── Smart Proxy Pool ────────────────────────────────────────────────────────
class SmartProxyPool:
    """Manages clean proxy rotation, tracks bad IPs, and reuses successful ones."""
    def __init__(self, proxies: List[Proxy]):
        self.fresh_proxies: deque[Proxy] = deque(proxies)
        self.good_proxies: List[Proxy] = []
        self.bad_addresses: Set[str] = set()

    @staticmethod
    def address_of(proxy: Proxy) -> str:
        try:
            return urlparse(proxy.server).hostname or proxy.server
        except Exception:
            return proxy.server

    def get_next_proxy(self) -> Optional[Proxy]:
        while self.fresh_proxies:
            p = self.fresh_proxies.popleft()
            if self.address_of(p) not in self.bad_addresses:
                return p
        if self.good_proxies:
            return random.choice(self.good_proxies)
        return None

    def mark_result(self, proxy: Proxy, success: bool):
        addr = self.address_of(proxy)
        if success:
            if not any(self.address_of(p) == addr for p in self.good_proxies):
                self.good_proxies.append(proxy)
        else:
            self.bad_addresses.add(addr)

# ── Platform-Specific In-Session Verification (Gmail) ──────────────────────
async def retrieve_verification_link_from_gmail(context, email: str, logger, timeout_sec: int = 65) -> Optional[str]:
    """Opens Gmail in a secondary tab to fetch platform verification link if required."""
    logger.info(f"opening Gmail tab to check verification email for {email}...")
    gmail_page = None
    verify_url = None
    try:
        gmail_page = await context.new_page()
        gmail_page.set_default_timeout(35000)
        await gmail_page.goto("https://mail.google.com/mail/u/0/#inbox", wait_until="domcontentloaded")
        await human_delay(2000, 3500)

        start_time = time.time()
        while time.time() - start_time < timeout_sec:
            # Handle speedbump / Workspace Terms
            if "speedbump" in gmail_page.url:
                accept_btn = await gmail_page.query_selector('button:has-text("I understand"), button:has-text("Saya mengerti")')
                if accept_btn:
                    await accept_btn.click()
                    await human_delay(2000, 3000)

            # Check page content for link directly
            content = await gmail_page.content()
            m = VERIFY_LINK_RE.search(content)
            if m:
                raw_url = html.unescape(m.group(0))
                if "google.com/url" in raw_url:
                    parsed = urlparse(raw_url)
                    verify_url = parse_qs(parsed.query).get("q", [raw_url])[0]
                else:
                    verify_url = raw_url
                break

            # Click email row
            row = await gmail_page.query_selector('tr.zA:has-text("<AppName>")')
            if row:
                await row.click()
                await human_delay(2000, 3000)
                continue

            # Refresh inbox
            try:
                refresh = await gmail_page.query_selector('div[aria-label*="Refresh" i], div[act="20"]')
                if refresh:
                    await refresh.click()
                else:
                    await gmail_page.reload(wait_until="domcontentloaded")
            except Exception:
                pass
            await asyncio.sleep(4)

    except Exception as e:
        logger.warn(f"error checking Gmail: {e}")
    finally:
        if gmail_page:
            try:
                await gmail_page.close()
            except Exception:
                pass
    return verify_url

# ── Platform-Specific API Key Creation ──────────────────────────────────────
async def create_and_extract_api_key(page, email: str, logger) -> str:
    """Navigates to API Keys page and creates a new token."""
    logger.info(f"navigating to {API_KEYS_URL}...")
    await page.goto(API_KEYS_URL, wait_until="domcontentloaded")
    await human_delay(1500, 2500)

    # Click "+ New key" / "Create key"
    new_btn = await page.wait_for_selector('button:has-text("+ New key"), button:has-text("Create key")', timeout=15000)
    await new_btn.click()
    await human_delay(800, 1500)

    # Fill label
    label_input = await page.wait_for_selector('input[type="text"]', timeout=8000)
    await human_type(page, 'input[type="text"]', f"App-{random.randint(100, 999)}")
    await human_delay(500, 1000)

    # Submit
    submit_btn = await page.wait_for_selector('button:has-text("Create"), button[type="submit"]', timeout=10000)
    await submit_btn.click()
    await human_delay(2000, 3500)

    # Extract token
    token = None
    for _ in range(20):
        text = await page.evaluate("() => document.body.innerText")
        match = API_KEY_RE.search(text)
        if match:
            token = match.group(0)
            break
        await asyncio.sleep(0.5)

    if not token:
        raise RuntimeError("API key token not found on page after submission")
    return token

# ── Google OAuth Flow ───────────────────────────────────────────────────────
async def run_single_google_account(
    account: Account,
    proxy: Optional[Proxy],
    store: JsonlStore,
    results: ResultWriter,
    headed: bool,
    logger,
    pace: str = "human",
) -> bool:
    email = account.email
    password = account.password
    store.upsert({"email": email, "status": FlowState.PENDING, "proxy": proxy.server if proxy else None})

    browser_ctx = None
    try:
        browser_ctx = await launch_camoufox(headless=not headed, proxy=proxy, geoip=True)
        async with browser_ctx as browser:
            # CRUCIAL: Always create an explicit context
            context = await browser.new_context(ignore_https_errors=True)
            page = await context.new_page()
            page.set_default_timeout(35000)

            # 1. Check if already authenticated
            await page.goto(DEFAULT_SIGNUP_URL, wait_until="domcontentloaded")
            await human_delay(1500, 2500)

            if "/dashboard" not in page.url:
                # 2. Click SSO button
                store.upsert({"email": email, "status": FlowState.SIGNUP})
                sso_btn = await page.wait_for_selector('button:has-text("Continue with Google")', timeout=20000)
                await sso_btn.click()
                await human_delay(1500, 2500)

                # Solve Turnstile if present
                await resolve_turnstile_if_present(page, timeout_sec=20, logger=logger)

                # 3. Google OAuth Flow
                page = await perform_google_oauth(page, email, password, account.recovery_email, timeout_sec=60, logger=logger)
                await human_delay(2000, 3500)

            # 4. Ensure Dashboard Reached
            if "/dashboard" not in page.url:
                await page.goto(DASHBOARD_URL, wait_until="domcontentloaded")
                await human_delay(2000, 3000)
            store.upsert({"email": email, "status": FlowState.DASHBOARD})

            # 5. Handle Platform-Specific Post-Signup Modals / Consent (Idempotent)
            # e.g. Free model consent, onboarding survey, etc.

            # 6. Optional Email Verification Check
            has_verify_banner = await page.evaluate("() => document.body.innerText.includes('Verify your email')")
            if has_verify_banner:
                verify_btn = await page.query_selector('button:has-text("Verify email")')
                if verify_btn:
                    await verify_btn.click()
                    await human_delay(2000, 3500)
                link = await retrieve_verification_link_from_gmail(context, email, logger, timeout_sec=65)
                if link:
                    await page.goto(link, wait_until="domcontentloaded")
                    await human_delay(2000, 3000)

            # 7. Create API Key
            store.upsert({"email": email, "status": FlowState.API_KEY})
            api_key = await create_and_extract_api_key(page, email, logger)

            logger.info(f"SUCCESS: API key extracted -> {api_key[:12]}...")
            store.upsert({"email": email, "status": FlowState.DONE, "apiKey": api_key})
            results.mark_success(email, password, api_key)
            return True

    except Exception as e:
        logger.error(f"failed: {e}")
        store.upsert({"email": email, "status": FlowState.FAILED, "error": str(e)})
        results.mark_failed(email, password, str(e))
        return False

# ── TempMail Flow ───────────────────────────────────────────────────────────
async def run_single_tempmail_account(
    proxy: Optional[Proxy],
    temp_mail: TempMailClient,
    store: JsonlStore,
    results: ResultWriter,
    headed: bool,
    logger,
    pace: str = "human",
) -> bool:
    account = temp_mail.create_email()
    email = account["email"]
    password = "DefaultPassword123!"
    store.upsert({"email": email, "password": password, "status": FlowState.PENDING, "proxy": proxy.server if proxy else None})

    browser_ctx = None
    try:
        browser_ctx = await launch_camoufox(headless=not headed, proxy=proxy, geoip=True)
        async with browser_ctx as browser:
            context = await browser.new_context(ignore_https_errors=True)
            page = await context.new_page()
            page.set_default_timeout(35000)

            # 1. Fill registration form
            await page.goto(DEFAULT_SIGNUP_URL, wait_until="domcontentloaded")
            await human_delay(1500, 2500)
            await human_type(page, 'input[name="email"], input[type="email"]', email)
            # Submit form...

            # 2. Wait for verification link
            verify_url = await temp_mail.wait_for_verification_link(
                email=email,
                filter_sender="<AppName>",
                link_regex=VERIFY_LINK_RE.pattern,
                timeout_sec=70,
            )
            await page.goto(verify_url, wait_until="domcontentloaded")
            await human_delay(2000, 3000)

            # 3. Create API Key
            store.upsert({"email": email, "status": FlowState.API_KEY})
            api_key = await create_and_extract_api_key(page, email, logger)

            logger.info(f"SUCCESS: API key extracted -> {api_key[:12]}...")
            store.upsert({"email": email, "status": FlowState.DONE, "apiKey": api_key})
            results.mark_success(email, password, api_key)
            return True

    except Exception as e:
        logger.error(f"failed: {e}")
        store.upsert({"email": email, "status": FlowState.FAILED, "error": str(e)})
        results.mark_failed(email, password, str(e))
        return False
```
