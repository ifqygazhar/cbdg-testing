#!/usr/bin/env python3
"""
FastRouter Camoufox Runner (Python + Camoufox / Firefox engine)
Supports both TempMail automated registration (with OTP code verification)
and Google OAuth signup. Bypasses Cloudflare Turnstile automatically.
"""

import argparse
import asyncio
from collections import deque
import os
import random
import re
import sys
import time
from typing import Optional, List, Set, Tuple
from urllib.parse import urlparse

# Ensure repo root is on sys.path so packages.camoufox_core can be imported
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from packages.camoufox_core import (
    launch_camoufox,
    get_browser_fingerprint_info,
    human_delay,
    human_type,
    perform_google_oauth,
    resolve_turnstile_if_present,
    load_accounts,
    load_proxies,
    Account,
    Proxy,
    JsonlStore,
    ResultWriter,
    FlowState,
    create_logger,
    setup_process_signals,
    kill_descendant_processes,
    TempMailClient,
)

API_KEY_RE = re.compile(r"sk-v1-[A-Za-z0-9_-]{20,}")
CREDITS_RE = re.compile(r"(available\s+credits:?\s*\$?1(\.00)?)|(\$1\.00)|(1\.00\s*credits?)", re.I)

SIGNUP_URL = "https://fastrouter.ai/sign-up"
KEYS_URL = "https://dashboard.fastrouter.ai/keys"

FIRST_NAMES = [
    "James", "Sarah", "Alex", "David", "Emily", "Michael", "Emma", "Daniel",
    "Sophia", "Matthew", "Olivia", "Andrew", "Grace", "Ethan", "Chloe", "Ryan",
    "Liam", "Lucas", "Noah", "Ava", "Mia", "Oliver", "Benjamin", "Charlotte",
    "Logan", "Mason", "Harper", "Evelyn", "Abigail", "Leo", "Henry", "Jack",
]
LAST_NAMES = [
    "Miller", "Smith", "Johnson", "Davis", "Wilson", "Taylor", "Anderson", "Thomas",
    "Jackson", "White", "Harris", "Martin", "Thompson", "Garcia", "Martinez", "Robinson",
    "Clark", "Rodriguez", "Lewis", "Lee", "Walker", "Hall", "Allen", "Young", "King",
    "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores", "Green", "Adams",
]

COMPANY_NOUNS = [
    "Aether", "Apex", "Atlas", "Aurora", "Axon", "Chronos", "Cobalt", "Cortex",
    "Cyber", "Echo", "Flux", "Forge", "Helix", "Infini", "Kepler", "Krypton",
    "Lumen", "Matrix", "Meridian", "Nebula", "Nexus", "Nimbus", "Nova", "Omni",
    "Optima", "Orion", "Pharos", "Polaris", "Pulse", "Quantum", "Radix", "Shift",
    "Solaris", "Solstice", "Spectra", "Stratum", "Summit", "Synapse", "Tensor",
    "Titan", "Vanguard", "Vector", "Vertex", "Vortex", "Zenith", "Zephyr",
]
COMPANY_SUFFIXES = [
    "AI", "Labs", "Tech", "Cloud", "Systems", "Data", "Works", "Soft", "Digital",
    "Studio", "Solutions", "Dynamics", "Intelligence", "Compute", "Networks",
]

def generate_org_name(email: str) -> str:
    user = email.split("@")[0]
    clean_user = re.sub(r"[^a-zA-Z0-9]", "", user)
    if clean_user and random.random() < 0.4:
        return f"{clean_user.capitalize()} {random.choice(COMPANY_SUFFIXES)}"
    return f"{random.choice(COMPANY_NOUNS)} {random.choice(COMPANY_SUFFIXES)}"

def generate_full_name() -> Tuple[str, str]:
    return random.choice(FIRST_NAMES), random.choice(LAST_NAMES)

class SmartProxyPool:
    """Manages proxy allocation with intelligent failure handling and success reuse.
    - Bad/rejected proxies are permanently discarded.
    - Successful proxies are preserved in a reusable pool and recycled when fresh proxies run out.
    - Every new attempt receives a distinct IP from the pool.
    """
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
        # 1. Prefer fresh proxy with clean IP
        while self.fresh_proxies:
            p = self.fresh_proxies.popleft()
            addr = self.address_of(p)
            if addr not in self.bad_addresses:
                return p

        # 2. If fresh proxies exhausted, reuse from verified good proxies
        if self.good_proxies:
            p = self.good_proxies.pop(0)
            self.good_proxies.append(p)
            return p

        return None

    def mark_result(self, proxy: Optional[Proxy], success: bool, reason: str = ""):
        if not proxy:
            return
        addr = self.address_of(proxy)
        if success:
            if proxy not in self.good_proxies:
                self.good_proxies.append(proxy)
        else:
            self.bad_addresses.add(addr)
            self.good_proxies = [p for p in self.good_proxies if self.address_of(p) != addr]
            self.fresh_proxies = deque([p for p in self.fresh_proxies if self.address_of(p) != addr])

    @property
    def has_proxies(self) -> bool:
        return bool(self.fresh_proxies or self.good_proxies)


async def handle_welcome_onboarding(page, email: str, logger) -> bool:
    """Handles the /welcome onboarding form if displayed."""
    # Wait up to 15s to see if welcome page appears
    start_check = time.time()
    on_welcome = False
    while time.time() - start_check < 15:
        curr_url = page.url
        if "/welcome" in curr_url or await page.query_selector("input#orgName"):
            on_welcome = True
            break
        if "/keys" in curr_url or "dashboard.fastrouter.ai" in curr_url:
            break
        await asyncio.sleep(1)

    if on_welcome or "/welcome" in page.url or await page.query_selector("input#orgName"):
        logger.info("handling welcome onboarding form...")
        org_input = await page.wait_for_selector("input#orgName", timeout=15000)
        if org_input:
            org_name = generate_org_name(email)
            logger.info(f"filling organization name: {org_name}")
            await human_type(page, "input#orgName", org_name)
            await human_delay(400, 800)

        spend_input = await page.query_selector("input#monthlySpend")
        if spend_input:
            spend_val = str(random.randint(1000, 10000))
            logger.info(f"filling monthly spend: ${spend_val}")
            await human_type(page, "input#monthlySpend", spend_val)
            await human_delay(400, 800)

        # Optional checklist item
        labels = await page.query_selector_all("label.cursor-pointer")
        if len(labels) > 2:
            try:
                await labels[random.randint(2, len(labels) - 1)].click()
                await human_delay(300, 600)
            except Exception:
                pass

        # Submit welcome form
        welcome_btn = await page.wait_for_selector('button[type="submit"]', timeout=10000)
        if welcome_btn:
            logger.info("submitting welcome onboarding...")
            await welcome_btn.click()
            logger.info("waiting for welcome onboarding to complete...")
            redirect_start = time.time()
            while time.time() - redirect_start < 25:
                curr = page.url
                if "/welcome" not in curr and ("fastrouter.ai" in curr or "localhost" in curr):
                    break
                if await page.query_selector('a[href*="/keys"], input#api_key_name, button:has-text("Copy API Key"), button:has-text("Create User Key")'):
                    break
                await asyncio.sleep(0.5)
            await human_delay(1500, 2500)
        return True
    return False


async def is_key_modal_open(page) -> bool:
    """Checks whether the FastRouter 'Create User Key' or 'Edit User Key' modal dialog is open."""
    try:
        modal_el = await page.query_selector(
            'input#api_key_name, button:has-text("Copy API Key"), button:has-text("Copy Key"), div[class*="backdrop-blur"], div[class*="max-w-[900px]"]'
        )
        if modal_el:
            return True
        content = await page.content()
        valid_matches = [m for m in API_KEY_RE.findall(content) if "..." not in m and len(m) >= 30]
        return len(valid_matches) > 0
    except Exception:
        return False


async def handle_create_api_key(
    page,
    email: str,
    password: str,
    results: ResultWriter,
    store: JsonlStore,
    proxy: Optional[Proxy],
    screenshot_dir: str,
    logger,
) -> bool:
    """Navigates to /keys, checks bonus credits, generates API key, copies it, submits modal, and persists it."""
    sanitized_email = re.sub(r"[^a-zA-Z0-9]", "_", email)
    logger.info("navigating to FastRouter keys page...")

    # 1. Wait for page transition to /keys or dashboard
    for _ in range(15):
        if "/keys" in page.url or await is_key_modal_open(page) or await page.query_selector('a[href*="/keys"]'):
            break
        await asyncio.sleep(1)

    # If not on /keys and modal is not already open, try to navigate via sidebar or org slug
    if "/keys" not in page.url and not await is_key_modal_open(page):
        keys_link = await page.query_selector('a[href*="/keys"]')
        if keys_link:
            logger.info("clicking sidebar 'Keys' link...")
            try:
                await keys_link.click(timeout=5000)
            except Exception:
                await page.evaluate("(el) => el.click()", keys_link)
            await human_delay(2000, 3500)
        else:
            m = re.search(r"fastrouter\.ai/([a-zA-Z0-9_\-]+)", page.url)
            if m and m.group(1) not in ("welcome", "sign-up", "login", "dashboard", "api"):
                tenant_keys_url = f"https://fastrouter.ai/{m.group(1)}/keys"
                logger.info(f"navigating to tenant keys page: {tenant_keys_url}")
                try:
                    await page.goto(tenant_keys_url, wait_until="domcontentloaded", timeout=20000)
                    await human_delay(2000, 3500)
                except Exception as e:
                    logger.warn(f"direct navigation to tenant keys url failed: {e}")

    # 2. Check for $1.00 credit
    content = await page.content()
    if CREDITS_RE.search(content):
        logger.info("bonus credit $1.00 verified on dashboard!")
    else:
        logger.warn("credit $1.00 banner not explicitly found, proceeding to create key...")

    # 3. Check if modal is already open; if not, click 'Create User Key'
    modal_open = await is_key_modal_open(page)
    if not modal_open:
        create_key_btn = await page.wait_for_selector(
            'button:has-text("Create User Key"), button:has-text("Create Key"), button[data-slot="button"]:has-text("Create")',
            timeout=10000,
        )
        if not create_key_btn:
            buttons = await page.query_selector_all("button")
            for b in buttons:
                txt = (await b.text_content() or "").strip()
                if "create" in txt.lower() and "key" in txt.lower():
                    create_key_btn = b
                    break

        if not create_key_btn:
            if not await is_key_modal_open(page):
                raise RuntimeError("Button 'Create User Key' not found on /keys")
        else:
            logger.info("clicking 'Create User Key' button...")
            try:
                await create_key_btn.click(timeout=5000)
            except Exception:
                await page.evaluate("(btn) => btn.click()", create_key_btn)
            await human_delay(1500, 2500)

    # 4. Extract API Key (sk-v1-...) FIRST before closing or submitting modal
    logger.info("extracting generated FastRouter API Key...")
    api_key: Optional[str] = None
    deadline = time.time() + 30

    FULL_KEY_RE = re.compile(r"sk-v1-[A-Za-z0-9_-]{30,}")

    while time.time() < deadline:
        code_elements = await page.query_selector_all("code, input[readonly], span[class*='mono'], div[class*='truncate']")
        for el in code_elements:
            val = (await el.text_content() or "") + " " + (await el.get_attribute("value") or "")
            m = FULL_KEY_RE.search(val)
            if m and "..." not in m.group(0):
                api_key = m.group(0)
                break
        if api_key:
            break

        modal_content = await page.content()
        matches = FULL_KEY_RE.findall(modal_content)
        valid_matches = [m for m in matches if "..." not in m and len(m) >= 30]
        if valid_matches:
            api_key = valid_matches[0]
            break

        await asyncio.sleep(1)

    # 5. Click "Copy API Key" button
    copy_btn = await page.query_selector('button:has-text("Copy API Key"), button:has-text("Copy Key")')
    if copy_btn:
        logger.info("clicking 'Copy API Key' button...")
        try:
            await copy_btn.click(timeout=5000)
        except Exception:
            await page.evaluate("(btn) => btn.click()", copy_btn)
        await human_delay(400, 800)

        # Check clipboard if key wasn't captured from DOM
        if not api_key:
            try:
                clip_text = await page.evaluate("navigator.clipboard ? navigator.clipboard.readText() : ''")
                if clip_text:
                    m = FULL_KEY_RE.search(clip_text.strip())
                    if m:
                        api_key = m.group(0)
            except Exception:
                pass

    # 6. Fill Key Name input (if empty)
    name_input = await page.query_selector('input#api_key_name, input[name="api_key_name"], input[placeholder*="Key Name" i], input[placeholder*="Name" i]')
    if name_input:
        cur_val = (await name_input.input_value()) or ""
        if not cur_val.strip():
            logger.info("filling API key name...")
            await name_input.fill("Default Key")
            await human_delay(300, 600)

    # 7. Click "Save" button to submit the modal
    save_btn = await page.query_selector('button:has-text("Save"), button[type="submit"]:has-text("Save")')
    if save_btn:
        logger.info("clicking modal 'Save' button...")
        try:
            await save_btn.click(timeout=5000)
        except Exception:
            await page.evaluate("(btn) => btn.click()", save_btn)
        await human_delay(1500, 2500)

    # 8. Verify API Key was captured
    if not api_key:
        ss_path = os.path.join(screenshot_dir, f"no_key_{sanitized_email}.png")
        await page.screenshot(path=ss_path)
        raise RuntimeError(f"API key not found on page (saved screenshot {ss_path})")

    logger.info(f"SUCCESS: FastRouter API Key obtained: {api_key[:12]}...{api_key[-6:]}")
    results.mark_success(email, password, api_key, extra="credits=$1.00")
    store.upsert({"email": email, "status": FlowState.DONE, "apiKey": api_key, "proxy": proxy.server if proxy else None})
    return True


async def run_single_tempmail_account(
    email: str,
    password: str,
    proxy: Optional[Proxy],
    store: JsonlStore,
    results: ResultWriter,
    temp_mail: TempMailClient,
    headed: bool,
    screenshot_dir: str,
    logger,
    pace: str = "human",
) -> bool:
    """Executes FastRouter signup via TempMail with Clerk 6-digit OTP verification."""
    logger.info(f"starting FastRouter TempMail signup for {email} (proxy={proxy.server if proxy else 'direct'}, pace={pace})")
    store.upsert({"email": email, "password": password, "status": FlowState.PENDING, "proxy": proxy.server if proxy else None})

    os.makedirs(screenshot_dir, exist_ok=True)
    sanitized_email = re.sub(r"[^a-zA-Z0-9]", "_", email)
    delay_mult = 1.3 if pace == "careful" else (0.85 if pace == "fast" else 1.0)

    browser_ctx = None
    try:
        browser_ctx = await launch_camoufox(
            headless=not headed,
            proxy=proxy,
            geoip=True,
        )

        async with browser_ctx as browser:
            page = await browser.new_page(ignore_https_errors=True)
            page.set_default_timeout(35000)

            # Log active anonymous fingerprint for this process/worker
            fp = await get_browser_fingerprint_info(page)
            if fp:
                logger.info(f"🛡️ Camoufox Fingerprint: OS={fp.get('platform')} | Screen={fp.get('screen')} | Viewport={fp.get('viewport')} | Cores={fp.get('cores')} | UA={fp.get('ua')}")

            # ── 1. Navigate to Sign Up ──────────────────────────────────────
            logger.info(f"navigating to {SIGNUP_URL}")
            await page.goto(SIGNUP_URL, wait_until="domcontentloaded")
            await human_delay(int(1800 * delay_mult), int(3000 * delay_mult))

            # Resolve Turnstile if present on landing
            await resolve_turnstile_if_present(page, timeout_sec=20, logger=logger)

            # ── 2. Fill Signup Form ─────────────────────────────────────────
            store.upsert({"email": email, "password": password, "status": FlowState.SIGNUP})
            first_name, last_name = generate_full_name()
            logger.info(f"filling signup credentials: {first_name} {last_name} <{email}>")

            # First name
            first_input = await page.wait_for_selector(
                'input[placeholder="John"], input[name="firstName"], input[placeholder*="first name" i]',
                timeout=20000,
            )
            if not first_input:
                raise RuntimeError("First name input not found")
            await human_type(page, 'input[placeholder="John"], input[name="firstName"]', first_name, min_delay_ms=45, max_delay_ms=110)
            await human_delay(int(400 * delay_mult), int(800 * delay_mult))

            # Last name
            await human_type(page, 'input[placeholder="Doe"], input[name="lastName"]', last_name, min_delay_ms=45, max_delay_ms=110)
            await human_delay(int(400 * delay_mult), int(800 * delay_mult))

            # Email
            await human_type(page, 'input[type="email"], input[placeholder="Enter your email address"]', email, min_delay_ms=40, max_delay_ms=100)
            await human_delay(int(500 * delay_mult), int(1000 * delay_mult))

            # Password
            await human_type(page, 'input[type="password"], input[placeholder="At least 8 characters"]', password, min_delay_ms=45, max_delay_ms=110)
            await human_delay(int(500 * delay_mult), int(900 * delay_mult))

            # Accept terms checkbox
            terms_btn = await page.wait_for_selector(
                'button#acceptTerms[role="checkbox"], #acceptTerms, button[role="checkbox"]',
                timeout=10000,
            )
            if terms_btn:
                state = await terms_btn.get_attribute("data-state")
                if state != "checked":
                    logger.info("checking terms & conditions checkbox...")
                    await terms_btn.click()
                    await human_delay(400, 800)

            # Hesitate naturally before submit
            await human_delay(int(1500 * delay_mult), int(2500 * delay_mult))

            # Submit signup form
            submit_btn = await page.wait_for_selector(
                'button[type="submit"]:has-text("Sign up"), form button[type="submit"]',
                timeout=12000,
            )
            if not submit_btn:
                raise RuntimeError("Sign up submit button not found")

            logger.info("clicking 'Sign up' button...")
            await submit_btn.click()
            await human_delay(2000, 3500)

            # ── 3. Resolve Cloudflare Turnstile if prompted by Clerk ────────
            # Clerk frequently renders Turnstile challenge (div#clerk-captcha) on form submit
            solved_turnstile = await resolve_turnstile_if_present(page, timeout_sec=25, logger=logger)
            if solved_turnstile:
                logger.info("Turnstile solved on signup submit")
                await human_delay(2000, 3500)

            # ── 4. Wait for 'Check your email' verification screen ──────────
            logger.info("waiting for 'Check your email' verification screen...")
            otp_input = None
            otp_deadline = time.time() + 35
            while time.time() < otp_deadline:
                # Check for OTP input field (placeholder="000000")
                otp_input = await page.query_selector('input[placeholder="000000"], input[maxlength="6"], input[class*="tracking-widest"]')
                if otp_input:
                    break

                # Also handle Turnstile if it reappears
                if page.frames():
                    await resolve_turnstile_if_present(page, timeout_sec=5, logger=logger)

                await asyncio.sleep(1)

            if not otp_input:
                # Check if already redirected to welcome or keys
                if "/welcome" in page.url or "/keys" in page.url:
                    logger.info("auto-redirected past verification")
                else:
                    ss_path = os.path.join(screenshot_dir, f"no_otp_screen_{sanitized_email}.png")
                    await page.screenshot(path=ss_path)
                    raise RuntimeError(f"OTP verification input not reached (screenshot: {ss_path})")

            # ── 5. Poll TempMail for 6-digit OTP code ────────────────────────
            if otp_input:
                logger.info(f"polling TempMail inbox for verification code on {email}...")
                otp_code = await temp_mail.wait_for_verification_otp(email, timeout_sec=75, interval_sec=2.5)
                logger.info(f"verification code received from email: {otp_code}")

                # Type OTP code into input[placeholder="000000"]
                await human_type(page, 'input[placeholder="000000"], input[maxlength="6"]', otp_code, min_delay_ms=70, max_delay_ms=160)
                await human_delay(int(600 * delay_mult), int(1200 * delay_mult))

                # Click "Verify & Continue"
                verify_submit = await page.wait_for_selector(
                    'button[type="submit"]:has-text("Verify & Continue"), button[type="submit"]',
                    timeout=10000,
                )
                if verify_submit:
                    logger.info("submitting OTP code ('Verify & Continue')...")
                    await verify_submit.click()
                    await human_delay(2500, 4500)

                # Solve Turnstile if Clerk presents post-verification challenge
                await resolve_turnstile_if_present(page, timeout_sec=15, logger=logger)

            # ── 6. Complete Welcome Onboarding ─────────────────────────────
            await handle_welcome_onboarding(page, email, logger)

            # ── 7. Keys Dashboard: Verify $1 Credit & Create API Key ───────
            return await handle_create_api_key(
                page=page,
                email=email,
                password=password,
                results=results,
                store=store,
                proxy=proxy,
                screenshot_dir=screenshot_dir,
                logger=logger,
            )

    except Exception as e:
        err_msg = str(e)
        first_line = err_msg.strip().splitlines()[0] if err_msg else "Unknown error"
        is_conn_error = any(code in err_msg for code in (
            "NS_ERROR_UNKNOWN_HOST",
            "NS_ERROR_CONNECTION_REFUSED",
            "NS_ERROR_NET_TIMEOUT",
            "NS_ERROR_NET_RESET",
            "NS_ERROR_PROXY_CONNECTION_REFUSED",
            "ERR_PROXY_CONNECTION_FAILED",
            "ERR_CONNECTION_REFUSED",
            "ERR_NAME_NOT_RESOLVED",
            "TimeoutError",
        ))
        if is_conn_error and "domcontentloaded" in err_msg:
            logger.warn(f"Proxy connection failed ({proxy.server if proxy else 'direct'}): {first_line}")
        else:
            logger.error(f"FAILED for {email}: {first_line}")
        results.mark_failed(email, password, first_line)
        store.upsert({"email": email, "status": FlowState.FAILED, "error": first_line, "proxy": proxy.server if proxy else None})
        return False


async def run_single_google_account(
    account: Account,
    proxy: Optional[Proxy],
    store: JsonlStore,
    results: ResultWriter,
    headed: bool,
    screenshot_dir: str,
    logger,
) -> bool:
    """Executes FastRouter signup via Google OAuth."""
    email = account.email
    logger.info(f"starting FastRouter Google OAuth signup for {email} (proxy={proxy.server if proxy else 'direct'})")
    store.upsert({"email": email, "status": FlowState.PENDING, "proxy": proxy.server if proxy else None})

    os.makedirs(screenshot_dir, exist_ok=True)
    sanitized_email = re.sub(r"[^a-zA-Z0-9]", "_", email)

    browser_ctx = None
    try:
        browser_ctx = await launch_camoufox(
            headless=not headed,
            proxy=proxy,
            geoip=True,
        )

        async with browser_ctx as browser:
            page = await browser.new_page(ignore_https_errors=True)
            page.set_default_timeout(30000)

            # Log active anonymous fingerprint for this process/worker
            fp = await get_browser_fingerprint_info(page)
            if fp:
                logger.info(f"🛡️ Camoufox Fingerprint: OS={fp.get('platform')} | Screen={fp.get('screen')} | Viewport={fp.get('viewport')} | Cores={fp.get('cores')} | UA={fp.get('ua')}")

            # ── 1. Navigate to Sign Up ──────────────────────────────────────
            logger.info(f"navigating to {SIGNUP_URL}")
            await page.goto(SIGNUP_URL, wait_until="domcontentloaded")
            await human_delay(1500, 2500)

            # ── 2. Click Google Sign Up ────────────────────────────────────
            google_btn = await page.wait_for_selector(
                'button[data-testid="oauth-signup-google"], button:has-text("Sign up with Google"), button[aria-label*="Google" i]',
                timeout=20000,
            )
            if not google_btn:
                raise RuntimeError("Google signup button not found")

            logger.info("clicking Sign up with Google...")
            await google_btn.click()
            await human_delay(1500, 2500)

            # ── 2.5 Resolve Cloudflare Turnstile if presented ───────────────
            solved = await resolve_turnstile_if_present(page, timeout_sec=25, logger=logger)
            if solved:
                await human_delay(1500, 2500)
                try:
                    if "accounts.google.com" not in page.url and await page.locator('button[data-testid="oauth-signup-google"], button:has-text("Sign up with Google")').count() > 0:
                        logger.info("Turnstile terverifikasi, memastikan tombol SSO terpicu...")
                        await page.locator('button[data-testid="oauth-signup-google"], button:has-text("Sign up with Google")').first.click(timeout=3000)
                except Exception:
                    pass

            # ── 3. Google OAuth Flow ────────────────────────────────────────
            post_auth_page = await perform_google_oauth(
                page=page,
                email=account.email,
                password=account.password,
                recovery_email=account.recovery_email,
                timeout_sec=60,
                logger=logger,
            )
            page = post_auth_page
            await human_delay(2000, 4000)

            # ── 4. Complete Legal Terms if prompted (/sign-up/continue) ────
            if "/sign-up/continue" in page.url or await page.query_selector("input#legal_accepted"):
                logger.info("handling legal terms checkbox...")
                checkbox = await page.wait_for_selector("input#legal_accepted", timeout=15000)
                if checkbox:
                    try:
                        await checkbox.check()
                    except Exception:
                        await page.evaluate("el => el.checked = true", checkbox)
                    await human_delay(500, 1000)

                submit_btn = await page.wait_for_selector('button[type="submit"]', timeout=10000)
                if submit_btn:
                    logger.info("submitting legal terms...")
                    await submit_btn.click()
                    await human_delay(2000, 4000)

            # ── 5. Welcome Onboarding (/welcome) ───────────────────────────
            await handle_welcome_onboarding(page, email, logger)

            # ── 6. Keys Dashboard & API Key Extraction ─────────────────────
            return await handle_create_api_key(
                page=page,
                email=email,
                password=account.password,
                results=results,
                store=store,
                proxy=proxy,
                screenshot_dir=screenshot_dir,
                logger=logger,
            )

    except Exception as e:
        err_msg = str(e)
        logger.error(f"FAILED for {email}: {err_msg}")
        results.mark_failed(email, account.password, err_msg)
        store.upsert({"email": email, "status": FlowState.FAILED, "error": err_msg, "proxy": proxy.server if proxy else None})
        return False


async def main_async():
    parser = argparse.ArgumentParser(description="FastRouter Camoufox Signup Automation")
    parser.add_argument("--auth", choices=["tempmail", "google"], default="", help="Authentication mode: tempmail or google")
    parser.add_argument("--tempmail", action="store_true", help="Use TempMail-Pro automated signup (default if no gsuite file)")
    parser.add_argument("--domain", default="ifqy.net", help="TempMail domain (default: ifqy.net)")
    parser.add_argument("--password", default="FastRouter@2026!", help="Default password for created TempMail accounts")
    parser.add_argument("--headed", action="store_true", help="Run with visible browser window")
    parser.add_argument("--no-proxy", action="store_true", help="Run directly without proxy")
    parser.add_argument("--accounts-file", default="", help="Path to gsuite accounts file")
    parser.add_argument("--proxy-file", default="", help="Path to proxies file")
    parser.add_argument("--output-file", default="", help="Path to save API keys")
    parser.add_argument("--state-file", default="state-fastrouter.jsonl", help="State jsonl path")
    parser.add_argument("--workers", "-w", type=int, default=1, help="Number of parallel workers (default: 1)")
    parser.add_argument("--limit", type=int, default=0, help="Maximum number of accounts to process")
    parser.add_argument("--delay", type=float, default=5.0, help="Delay in seconds between accounts")
    parser.add_argument("--pace", default="human", choices=["human", "fast", "careful"], help="Execution speed")
    parser.add_argument("--retry-failed", action="store_true", help="Retry previously failed accounts")
    parser.add_argument("--dry-run", action="store_true", help="Validate accounts and proxies without launching browser")
    parser.add_argument("--screenshot-dir", default="screenshots-fastrouter", help="Directory for screenshots")

    args = parser.parse_args()

    # Determine auth mode: TempMail or Google
    auth_mode = args.auth
    if not auth_mode:
        if args.tempmail:
            auth_mode = "tempmail"
        else:
            # Check if gsuite.txt exists and has accounts
            gsuite_exists = os.path.exists("fastrouter_ai_dataset/gsuite.txt") or os.path.exists("gsuite.txt")
            auth_mode = "google" if (gsuite_exists and not args.tempmail) else "tempmail"

    # Resolve proxies file
    proxy_file = args.proxy_file
    if not proxy_file and not args.no_proxy:
        if os.path.exists("proxy-live.txt"):
            proxy_file = "proxy-live.txt"
        elif os.path.exists("proxy.txt"):
            proxy_file = "proxy.txt"

    # Resolve output files
    key_files = ["apikey-fastrouter.txt", "apikey-fastrouter"]
    if os.path.exists("fastrouter_ai_dataset"):
        key_files.append("fastrouter_ai_dataset/apikey-fastrouter.txt")
        key_files.append("fastrouter_ai_dataset/apikey-fastrouter")
    if args.output_file and args.output_file not in key_files:
        key_files.append(args.output_file)

    proxies = load_proxies(proxy_file) if (proxy_file and not args.no_proxy) else []
    proxy_pool = SmartProxyPool(proxies) if proxies else None

    store = JsonlStore(args.state_file)
    results = ResultWriter(
        key_files=key_files,
        account_result_file="akun-result-fastrouter.txt",
        account_failed_file="akun-failed-fastrouter.txt",
    )

    logger = create_logger()
    logger.info(
        f"FastRouter Camoufox runner started. Auth={auth_mode}, workers={args.workers}, Proxies loaded: {len(proxies)} (mode={'no-proxy' if args.no_proxy or not proxies else 'active'})"
    )

    if args.dry_run:
        logger.info(f"dry-run: auth={auth_mode}, proxies={len(proxies)} validated (no browser launched)")
        return

    # ── TEMPMAIL FLOW ───────────────────────────────────────────────
    if auth_mode == "tempmail":
        temp_mail = TempMailClient(default_domain=args.domain)
        target_count = args.limit if args.limit > 0 else 5
        worker_count = max(1, min(args.workers, target_count))
        logger.info(
            f"Planning to process target {target_count} account(s) using domain @{args.domain} with {worker_count} parallel worker(s)"
        )

        processed = 0
        success_count = 0
        max_total_attempts = max(target_count * 5, len(proxies) * 2, 20) if proxies else target_count
        lock = asyncio.Lock()

        async def worker(worker_id: int):
            nonlocal processed, success_count
            while True:
                proxy = None
                async with lock:
                    if success_count >= target_count or processed >= max_total_attempts:
                        break

                    if not args.no_proxy and proxies:
                        proxy = proxy_pool.get_next_proxy()
                        if proxy is None:
                            logger.warn(
                                f"Worker #{worker_id}: All proxies ({len(proxies)}) have been exhausted or blacklisted. No usable proxies left."
                            )
                            break
                        proxy_addr = proxy_pool.address_of(proxy)
                        reuse_tag = " [reused good IP]" if proxy in proxy_pool.good_proxies else ""
                        logger.info(
                            f"Worker #{worker_id} selected proxy: {proxy.server} ({proxy_addr}){reuse_tag}. (Fresh: {len(proxy_pool.fresh_proxies)}, Good: {len(proxy_pool.good_proxies)})"
                        )
                    else:
                        proxy = None

                    processed += 1

                # Generate fresh TempMail account outside lock
                try:
                    acc_data = temp_mail.create_email(domain=args.domain)
                    email = acc_data["email"]
                except Exception as e:
                    logger.error(f"Worker #{worker_id} failed to generate TempMail: {e}")
                    await asyncio.sleep(2)
                    continue

                password = args.password
                acc_logger = create_logger(f"w{worker_id}:{email}")

                ok = await run_single_tempmail_account(
                    email=email,
                    password=password,
                    proxy=proxy,
                    store=store,
                    results=results,
                    temp_mail=temp_mail,
                    headed=args.headed,
                    screenshot_dir=args.screenshot_dir,
                    logger=acc_logger,
                    pace=args.pace,
                )

                async with lock:
                    if proxy_pool and proxy:
                        if ok:
                            proxy_pool.mark_result(proxy, success=True)
                            logger.info(f"Worker #{worker_id}: Proxy {proxy.server} verified GOOD! Added to reusable proxy pool.")
                        else:
                            proxy_pool.mark_result(proxy, success=False)
                            logger.warn(f"Worker #{worker_id}: Proxy {proxy.server} failed/rejected. Discarded and will not be reused.")

                    if ok:
                        success_count += 1
                        logger.info(f"Progress: {success_count}/{target_count} accounts completed successfully.")

                if success_count < target_count:
                    if ok and args.delay > 0:
                        logger.info(f"Worker #{worker_id} waiting {args.delay}s before next account...")
                        await asyncio.sleep(args.delay)
                    elif not ok:
                        logger.info(f"Worker #{worker_id} switching immediately to next account with a fresh/different IP...")
                        await asyncio.sleep(1.5)

        if worker_count > 1:
            await asyncio.gather(*(worker(i + 1) for i in range(worker_count)))
        else:
            await worker(1)

        logger.info(
            f"FastRouter Camoufox TempMail batch finished: {success_count}/{target_count} target achieved ({processed} total attempts)."
        )
        return

    # ── GOOGLE OAUTH FLOW ───────────────────────────────────────────
    accounts_file = args.accounts_file
    if not accounts_file:
        if os.path.exists("fastrouter_ai_dataset/gsuite.txt"):
            accounts_file = "fastrouter_ai_dataset/gsuite.txt"
        elif os.path.exists("gsuite.txt"):
            accounts_file = "gsuite.txt"
        else:
            print("Error: No accounts file found for Google OAuth (checked fastrouter_ai_dataset/gsuite.txt and gsuite.txt)", file=sys.stderr)
            sys.exit(1)

    accounts = load_accounts(accounts_file)
    logger.info(f"Loaded {len(accounts)} Google accounts from {accounts_file}")

    target_count = args.limit if args.limit > 0 else len(accounts)
    worker_count = max(1, min(args.workers, target_count, len(accounts)))
    logger.info(f"Planning to process up to {target_count} Google account(s) with {worker_count} parallel worker(s)")

    processed = 0
    success_count = 0
    account_idx = 0
    lock = asyncio.Lock()

    async def google_worker(worker_id: int):
        nonlocal processed, success_count, account_idx
        while True:
            account = None
            proxy = None
            async with lock:
                if (args.limit > 0 and processed >= args.limit) or account_idx >= len(accounts):
                    break

                while account_idx < len(accounts):
                    cand = accounts[account_idx]
                    account_idx += 1
                    if store.is_done(cand.email):
                        logger.info(f"Skipping already DONE account: {cand.email}")
                        continue
                    if store.is_restricted_or_banned(cand.email) and not args.retry_failed:
                        logger.warn(f"Skipping permanently restricted account: {cand.email}")
                        continue
                    if not args.retry_failed and store.get(cand.email) and store.get(cand.email).get("status") == FlowState.FAILED:
                        logger.info(f"Skipping previously failed account: {cand.email}")
                        continue
                    account = cand
                    break

                if not account:
                    break

                if not args.no_proxy and proxies:
                    proxy = proxy_pool.get_next_proxy() if proxy_pool else None
                processed += 1

            acc_logger = create_logger(f"w{worker_id}:{account.email}")
            ok = await run_single_google_account(
                account=account,
                proxy=proxy,
                store=store,
                results=results,
                headed=args.headed,
                screenshot_dir=args.screenshot_dir,
                logger=acc_logger,
            )

            async with lock:
                if proxy_pool and proxy:
                    proxy_pool.mark_result(proxy, ok)
                if ok:
                    success_count += 1

            if ok and args.delay > 0:
                await asyncio.sleep(args.delay)
            elif not ok:
                await asyncio.sleep(min(3.0, float(args.delay)))

    if worker_count > 1:
        await asyncio.gather(*(google_worker(i + 1) for i in range(worker_count)))
    else:
        await google_worker(1)

    logger.info(f"FastRouter Camoufox Google batch finished: {success_count}/{processed} succeeded.")

def main():
    setup_process_signals()
    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        print("\nInterrupted by user.", file=sys.stderr)
        kill_descendant_processes()
        os._exit(130)

if __name__ == "__main__":
    main()
